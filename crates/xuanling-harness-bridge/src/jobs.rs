//! Instance-local job registry and final result contract.
//!
//! The registry is the only source of truth for a live bridge instance. It is
//! deliberately in-memory: there is no database, no event file and no restart
//! recovery. Deduplication and concurrency limits are scoped to this process.

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use xuanling_toolkit::process::containment::ProcessTree;

use crate::cleanup;
use crate::config::RuntimeConfig;
use crate::error::{BridgeError, ErrorCode};
use crate::task::{FrozenTask, SubmitInput, freeze, payload_fingerprint};

/// Terminal statuses exposed by `harness_wait` / `harness_cancel`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStatus {
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    NeedsInput,
    Interrupted,
}

impl TerminalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
            Self::NeedsInput => "needs_input",
            Self::Interrupted => "interrupted",
        }
    }
}

/// A native or execution failure attached to a result.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct ResultError {
    pub code: String,
    pub message: String,
}

/// Process cleanup evidence captured when the result was formed.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct Cleanup {
    pub confirmed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The complete answer delivered to the controller.
#[derive(Clone, Debug, Serialize, Deserialize, JsonSchema)]
pub struct FinalResult {
    pub job_id: String,
    pub instance_id: String,
    pub request_id: String,
    pub harness: String,
    pub adapter_version: String,
    pub status: TerminalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_final_output: Option<String>,
    pub output_complete: bool,
    pub redacted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ResultError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_error: Option<ResultError>,
    pub cleanup: Cleanup,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report_error: Option<String>,
    pub started_at: String,
    pub finished_at: String,
}

/// Why the bridge stopped the worker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    User,
    Deadline,
    Shutdown,
}

// The terminal variant carries the complete result; there is exactly one such
// value per job, so the variant size does not accumulate.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug)]
enum Phase {
    Accepted,
    Running,
    Finished(FinalResult),
}

impl Phase {
    fn status_label(&self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Running => "running",
            Self::Finished(result) => result.status.as_str(),
        }
    }
}

/// One atomic snapshot of the wait-relevant job phase.
// The final variant carries the full result; one snapshot exists per wait call.
#[allow(clippy::large_enum_variant)]
pub enum WaitState {
    Pending(&'static str),
    Final(FinalResult),
}

pub struct Job {
    pub id: String,
    pub instance_id: String,
    pub request_id: String,
    pub task: FrozenTask,
    pub cancel: CancellationToken,
    pub cancel_reason: Mutex<Option<CancelReason>>,
    tree: Mutex<Option<ProcessTree>>,
    pub accepted_at: OffsetDateTime,
    pub started_at: Mutex<Option<OffsetDateTime>>,
    phase: Mutex<Phase>,
    terminal: watch::Sender<u64>,
    slot_released: AtomicBool,
}

impl Job {
    fn new(instance_id: &str, request_id: String, task: FrozenTask) -> Self {
        let id = format!("{instance_id}-job-{}", Uuid::new_v4().simple());
        let (terminal, _) = watch::channel(0);
        Self {
            id,
            instance_id: instance_id.to_string(),
            request_id,
            task,
            cancel: CancellationToken::new(),
            cancel_reason: Mutex::new(None),
            tree: Mutex::new(None),
            accepted_at: OffsetDateTime::now_utc(),
            started_at: Mutex::new(None),
            phase: Mutex::new(Phase::Accepted),
            terminal,
            slot_released: AtomicBool::new(false),
        }
    }

    pub fn phase_label(&self) -> &'static str {
        self.phase
            .lock()
            .map_or("unknown", |phase| phase.status_label())
    }

    pub fn finished_result(&self) -> Option<FinalResult> {
        match &*self.phase.lock().ok()? {
            Phase::Finished(result) => Some(result.clone()),
            _ => None,
        }
    }

    pub fn is_finished(&self) -> bool {
        self.phase
            .lock()
            .is_ok_and(|phase| matches!(&*phase, Phase::Finished(_)))
    }

    /// Return pending status or the final result from the same lock. This is
    /// what `harness_wait` uses so a settlement cannot produce a "pending"
    /// response whose status is already terminal.
    pub fn wait_state(&self) -> WaitState {
        match self.phase.lock() {
            Ok(phase) => match &*phase {
                Phase::Accepted => WaitState::Pending("accepted"),
                Phase::Running => WaitState::Pending("running"),
                Phase::Finished(result) => WaitState::Final(result.clone()),
            },
            // A poisoned phase lock is a bridge-internal failure; keep the
            // response conservative rather than inventing a final result.
            Err(_) => WaitState::Pending("unknown"),
        }
    }

    /// Claim the one-time active-slot release for this job.
    fn release_slot_once(&self) -> bool {
        self.slot_released
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Move from accepted to running. Returns `false` when cancellation won the
    /// race before the worker started.
    pub fn mark_running(&self) -> bool {
        let mut phase = match self.phase.lock() {
            Ok(phase) => phase,
            Err(_) => return false,
        };
        if !matches!(&*phase, Phase::Accepted) {
            return false;
        }
        *phase = Phase::Running;
        if let Ok(mut started) = self.started_at.lock() {
            *started = Some(OffsetDateTime::now_utc());
        }
        true
    }

    fn settle(&self, result: FinalResult) -> bool {
        let mut phase = match self.phase.lock() {
            Ok(phase) => phase,
            Err(_) => return false,
        };
        if matches!(&*phase, Phase::Finished(_)) {
            return false;
        }
        *phase = Phase::Finished(result);
        drop(phase);
        self.terminal.send_modify(|version| *version += 1);
        true
    }

    /// Record the first cancellation reason and signal the supervisor.
    pub fn request_cancel(&self, reason: CancelReason) -> bool {
        if self.is_finished() {
            return false;
        }
        if let Ok(mut slot) = self.cancel_reason.lock()
            && slot.is_none()
        {
            *slot = Some(reason);
        }
        self.cancel.cancel();
        true
    }

    pub fn reason(&self) -> Option<CancelReason> {
        self.cancel_reason.lock().ok().and_then(|slot| *slot)
    }

    /// Record the containment handle for the spawned worker.
    pub fn attach_tree(&self, tree: ProcessTree) {
        if let Ok(mut slot) = self.tree.lock() {
            *slot = Some(tree);
        }
    }

    /// Clone the containment handle once the worker has been attached.
    pub fn containment(&self) -> Option<ProcessTree> {
        self.tree.lock().ok().and_then(|slot| slot.clone())
    }

    async fn wait_finished(&self) {
        // Subscribe before the first check so a settlement between the check
        // and the wait cannot be lost.
        let mut receiver = self.terminal.subscribe();
        loop {
            if self.is_finished() {
                return;
            }
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

/// What `Registry::submit` produced.
pub struct SubmitOutcome {
    pub job: std::sync::Arc<Job>,
    pub reused: bool,
}

impl std::fmt::Debug for SubmitOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SubmitOutcome")
            .field("job_id", &self.job.id)
            .field("reused", &self.reused)
            .finish()
    }
}

#[derive(Clone)]
struct RequestEntry {
    fingerprint: String,
    job_id: String,
}

struct State {
    jobs: HashMap<String, std::sync::Arc<Job>>,
    requests: HashMap<String, RequestEntry>,
    active: usize,
}

/// Resolve an existing request to its job, rejecting a conflicting payload.
/// `Ok(None)` means the request id is unused.
fn existing_request(
    state: &State,
    request_id: &str,
    fingerprint: &str,
) -> Result<Option<std::sync::Arc<Job>>, BridgeError> {
    let Some(entry) = state.requests.get(request_id) else {
        return Ok(None);
    };
    if entry.fingerprint != fingerprint {
        return Err(BridgeError::new(
            ErrorCode::RequestConflict,
            "request_id was already used with a different payload",
        ));
    }
    let job = state.jobs.get(&entry.job_id).cloned().ok_or_else(|| {
        BridgeError::new(
            ErrorCode::JobContextLost,
            "request job is no longer available",
        )
    })?;
    Ok(Some(job))
}

/// One bridge instance's live job table.
pub struct Registry {
    pub config: std::sync::Arc<RuntimeConfig>,
    state: Mutex<State>,
}

/// Outcome of a single `harness_wait` call.
// The final variant carries the full result; pending waits are cheap and there
// is at most one outcome value per wait call.
#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug)]
pub enum WaitOutcome {
    Pending {
        status: &'static str,
        elapsed_ms: u64,
    },
    Final(FinalResult),
}

impl Registry {
    pub fn new(config: std::sync::Arc<RuntimeConfig>) -> Self {
        Self {
            config,
            state: Mutex::new(State {
                jobs: HashMap::new(),
                requests: HashMap::new(),
                active: 0,
            }),
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.config.instance_id
    }

    /// Admit a task or reuse an identical in-flight/finished request.
    pub fn submit(&self, input: SubmitInput) -> Result<SubmitOutcome, BridgeError> {
        if input.instance_id != self.config.instance_id {
            return Err(BridgeError::new(
                ErrorCode::InstanceChanged,
                "instance_id does not belong to this bridge process",
            ));
        }
        let request_id = input.request_id.clone();
        if request_id.is_empty() || request_id.len() > 128 {
            return Err(BridgeError::invalid_request(
                "request_id must be 1..=128 bytes",
            ));
        }
        let adapter = self.config.adapter(&input.adapter).ok_or_else(|| {
            BridgeError::new(
                ErrorCode::AdapterUnavailable,
                format!("adapter is not configured: {}", input.adapter),
            )
        })?;
        if !adapter.compatible() {
            return Err(BridgeError::new(
                ErrorCode::IncompatibleCli,
                format!(
                    "adapter {} version {} is outside the supported range",
                    adapter.id(),
                    adapter.version()
                ),
            ));
        }

        let fingerprint = payload_fingerprint(&self.config, &input);

        {
            let state = self.lock()?;
            if let Some(job) = existing_request(&state, &request_id, &fingerprint)? {
                return Ok(SubmitOutcome { job, reused: true });
            }
            Self::check_capacity(&self.config, &state)?;
        }

        // Freeze outside the registry lock. A concurrent duplicate may still
        // win; the second check below turns that into a reuse of the frozen job.
        let task = freeze(&self.config, input)?;

        let mut state = self.lock()?;
        if let Some(job) = existing_request(&state, &request_id, &fingerprint)? {
            return Ok(SubmitOutcome { job, reused: true });
        }
        Self::check_capacity(&self.config, &state)?;

        let job = std::sync::Arc::new(Job::new(&self.config.instance_id, request_id.clone(), task));
        state.requests.insert(
            request_id,
            RequestEntry {
                fingerprint,
                job_id: job.id.clone(),
            },
        );
        state.jobs.insert(job.id.clone(), job.clone());
        state.active += 1;
        Ok(SubmitOutcome { job, reused: false })
    }

    fn check_capacity(config: &RuntimeConfig, state: &State) -> Result<(), BridgeError> {
        if state.active >= config.max_active_jobs {
            return Err(BridgeError::new(
                ErrorCode::Busy,
                format!("instance already has {} active job(s)", state.active),
            ));
        }
        if state.jobs.len() >= config.max_retained_jobs {
            return Err(BridgeError::new(
                ErrorCode::MemoryCapacity,
                "instance job table is at capacity",
            ));
        }
        Ok(())
    }

    pub async fn wait(
        &self,
        job_id: &str,
        wait_ms: Option<u64>,
    ) -> Result<WaitOutcome, BridgeError> {
        let job = self.find_job(job_id)?;
        let started = Instant::now();
        let mut receiver = job.terminal.subscribe();

        loop {
            if let Some(result) = job.finished_result() {
                return Ok(WaitOutcome::Final(result));
            }
            let remaining = match wait_ms {
                Some(ms) => {
                    let elapsed = started.elapsed().as_millis() as u64;
                    if elapsed >= ms {
                        return Ok(self.pending(&job, started));
                    }
                    Some(Duration::from_millis(ms - elapsed))
                }
                None => None,
            };
            let changed = match remaining {
                Some(remaining) => tokio::time::timeout(remaining, receiver.changed())
                    .await
                    .is_ok(),
                None => receiver.changed().await.is_ok(),
            };
            if !changed {
                return Ok(self.pending(&job, started));
            }
        }
    }

    fn pending(&self, job: &Job, started: Instant) -> WaitOutcome {
        match job.wait_state() {
            WaitState::Pending(status) => WaitOutcome::Pending {
                status,
                elapsed_ms: started.elapsed().as_millis() as u64,
            },
            WaitState::Final(result) => WaitOutcome::Final(result),
        }
    }

    /// Explicit task cancellation. Repeated calls are idempotent.
    pub async fn cancel(&self, job_id: &str) -> Result<FinalResult, BridgeError> {
        let job = self.find_job(job_id)?;
        if let Some(result) = job.finished_result() {
            if result.cleanup.confirmed {
                return Ok(result);
            }
            return self.retry_cleanup(&job, result).await;
        }
        job.request_cancel(CancelReason::User);
        let waited = tokio::time::timeout(
            cleanup::CLEANUP_TIMEOUT + cleanup::DRAIN_TIMEOUT + Duration::from_secs(3),
            job.wait_finished(),
        )
        .await;
        if waited.is_err() {
            return Err(BridgeError::new(
                ErrorCode::CleanupUnconfirmed,
                "cancellation was requested but the worker has not settled yet",
            ));
        }
        job.finished_result().ok_or_else(|| {
            BridgeError::new(
                ErrorCode::JobContextLost,
                "worker settled without a readable final result",
            )
        })
    }

    async fn retry_cleanup(
        &self,
        job: &Job,
        mut result: FinalResult,
    ) -> Result<FinalResult, BridgeError> {
        // The supervisor already sent the termination signal when it settled.
        // A later cancel only re-confirms; re-signalling a process-group id
        // could hit an unrelated process group after PID reuse.
        let confirmed = match job.containment() {
            Some(tree) => cleanup::confirm(&tree).await,
            // Without a containment handle the bridge cannot prove that no
            // descendant remains, so it must not claim a confirmed cleanup.
            None => false,
        };
        if !confirmed {
            return Err(BridgeError::new(
                ErrorCode::CleanupUnconfirmed,
                "contained processes are still alive",
            ));
        }
        result.cleanup = Cleanup {
            confirmed: true,
            detail: None,
        };
        if let Ok(mut phase) = job.phase.lock()
            && let Phase::Finished(stored) = &mut *phase
        {
            stored.cleanup = result.cleanup.clone();
        }
        self.release_slot_for(job);
        Ok(result)
    }

    /// Settle a job exactly once and release its active slot when cleanup is
    /// confirmed. An unconfirmed cleanup deliberately keeps the slot occupied.
    pub fn settle(&self, job: &Job, result: FinalResult) -> bool {
        let cleanup_confirmed = result.cleanup.confirmed;
        let first = job.settle(result);
        if first && cleanup_confirmed {
            self.release_slot_for(job);
        }
        first
    }

    /// Release a job's active slot at most once, even for concurrent cancels
    /// that both observe an unconfirmed cleanup.
    fn release_slot_for(&self, job: &Job) {
        if job.release_slot_once() {
            self.release_slot();
        }
    }

    fn release_slot(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.active = state.active.saturating_sub(1);
        }
    }

    /// Stop every live job for process shutdown and wait for its settlement.
    pub async fn shutdown(&self) {
        let jobs: Vec<std::sync::Arc<Job>> = match self.state.lock() {
            Ok(state) => state
                .jobs
                .values()
                .filter(|job| !job.is_finished())
                .cloned()
                .collect(),
            Err(_) => return,
        };
        for job in &jobs {
            job.request_cancel(CancelReason::Shutdown);
            if let Some(tree) = job.containment() {
                let _ = tree.terminate();
            }
        }
        let deadline = Instant::now()
            + cleanup::CLEANUP_TIMEOUT
            + cleanup::DRAIN_TIMEOUT
            + Duration::from_secs(3);
        for job in &jobs {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let _ = tokio::time::timeout(remaining, job.wait_finished()).await;
        }
    }

    pub fn active_jobs(&self) -> usize {
        self.state.lock().map_or(0, |state| state.active)
    }

    pub fn retained_jobs(&self) -> usize {
        self.state.lock().map_or(0, |state| state.jobs.len())
    }

    fn find_job(&self, job_id: &str) -> Result<std::sync::Arc<Job>, BridgeError> {
        let state = self.lock()?;
        if let Some(job) = state.jobs.get(job_id) {
            return Ok(job.clone());
        }
        if let Some((instance, _)) = job_id.split_once("-job-")
            && instance != self.config.instance_id
        {
            return Err(BridgeError::new(
                ErrorCode::JobContextLost,
                "job belongs to a different bridge instance",
            ));
        }
        Err(BridgeError::new(
            ErrorCode::JobNotFound,
            format!("unknown job_id: {job_id}"),
        ))
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, State>, BridgeError> {
        self.state
            .lock()
            .map_err(|_| BridgeError::new(ErrorCode::WorkerFailed, "registry lock poisoned"))
    }
}
