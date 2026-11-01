//! Worker supervision: fixed-argv spawn, containment, bounded collection,
//! terminal settlement and optional report publication.
//!
//! There is no default task deadline and no consumption budget. Only an
//! explicit `deadline_at`, an explicit cancel, a real native terminal state or
//! bridge shutdown ends a job.

use std::sync::Arc;

use time::OffsetDateTime;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::mpsc;
use xuanling_toolkit::process::containment::{self, ProcessTree};

use crate::adapters::Adapter;
use crate::cleanup;
use crate::collector::{Collected, Limits, RunOutcome, truncate_text};
use crate::config::RuntimeConfig;
use crate::error::ErrorCode;
use crate::jobs::{CancelReason, Cleanup, FinalResult, Job, Registry, ResultError, TerminalStatus};
use crate::redact::Redactor;
use crate::report::{self, ReportInput};
use crate::task::timestamp;

/// Supervise one accepted job to a terminal result.
pub async fn run(
    registry: Arc<Registry>,
    job: Arc<Job>,
    adapter: Arc<dyn Adapter>,
    redactor: Arc<Redactor>,
) {
    let config = registry.config.clone();
    let started_at = OffsetDateTime::now_utc();
    let mut guard = SettleGuard::new(registry, job.clone(), adapter.clone(), redactor, started_at);

    if job.cancel.is_cancelled() {
        let reason = job.reason();
        let settlement = Settlement {
            error: cancel_error(reason),
            ..Settlement::new(cancel_status(reason), confirmed_cleanup())
        };
        guard.settle(settlement);
        return;
    }
    if !job.mark_running() {
        let settlement = Settlement::interrupted(
            "job was not runnable at supervisor start",
            Cleanup {
                confirmed: false,
                detail: Some("job phase changed before spawn".to_string()),
            },
        );
        guard.settle(settlement);
        return;
    }

    let limits = Limits {
        max_final_bytes: config.max_final_bytes,
        max_diagnostic_bytes: config.max_diagnostic_bytes,
        max_protocol_line_bytes: config.max_protocol_line_bytes,
        max_protocol_bytes: config.max_protocol_bytes,
    };

    let plan = match adapter.plan(&job.task) {
        Ok(plan) => plan,
        Err(error) => {
            let settlement = Settlement::failed(error.code, error.message, confirmed_cleanup());
            guard.settle(settlement);
            return;
        }
    };

    let mut command = Command::new(&plan.program);
    command
        .kill_on_drop(true)
        .args(&plan.args)
        .current_dir(&plan.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env_clear();
    for (name, value) in config.child_env() {
        command.env(name, value);
    }
    for (name, value) in plan.env {
        command.env(name, value);
    }
    containment::configure(&mut command);

    // Close the window between the initial check and the spawn: an explicit
    // pre-spawn cancel must not start a worker.
    if job.cancel.is_cancelled() {
        let reason = job.reason();
        let settlement = Settlement {
            error: cancel_error(reason),
            ..Settlement::new(cancel_status(reason), confirmed_cleanup())
        };
        guard.settle(settlement);
        return;
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let settlement = Settlement::failed(
                ErrorCode::SpawnFailed,
                format!("worker spawn failed: {error}"),
                confirmed_cleanup(),
            );
            guard.settle(settlement);
            return;
        }
    };

    let tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            let settlement = Settlement::failed(
                ErrorCode::SpawnFailed,
                format!("process containment failed: {error}"),
                Cleanup {
                    confirmed: false,
                    detail: Some("containment attach failed; descendants unverified".to_string()),
                },
            );
            guard.settle(settlement);
            return;
        }
    };
    job.attach_tree(tree.clone());

    if !plan.stdin.is_empty()
        && let Some(mut stdin) = child.stdin.take()
    {
        let input = plan.stdin;
        tokio::spawn(async move {
            let _ = stdin.write_all(&input).await;
            let _ = stdin.shutdown().await;
        });
    }
    drop(child.stdin.take());

    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(64);
    let (err_tx, mut err_rx) = mpsc::channel::<Vec<u8>>(64);
    let out_task = child
        .stdout
        .take()
        .map(|stdout| tokio::spawn(pump(stdout, out_tx)));
    let err_task = child
        .stderr
        .take()
        .map(|stderr| tokio::spawn(pump(stderr, err_tx)));

    let mut collector = adapter.collector(limits);
    let deadline = tokio_deadline(job.task.deadline_time());
    let wait = child.wait();
    tokio::pin!(wait);

    let mut exit_status: Option<std::process::ExitStatus> = None;
    let mut stdout_open = out_task.is_some();
    let mut stderr_open = err_task.is_some();
    let mut cancel_seen = false;
    let mut deadline_fired = false;
    let mut drain_deadline: Option<tokio::time::Instant> = None;
    let mut drain_timed_out = false;
    let mut wait_failed = false;

    loop {
        if exit_status.is_some() && !stdout_open && !stderr_open {
            break;
        }
        if exit_status.is_some() && drain_deadline.is_none() {
            drain_deadline = Some(tokio::time::Instant::now() + cleanup::DRAIN_TIMEOUT);
        }
        tokio::select! {
            status = &mut wait, if exit_status.is_none() => {
                match status {
                    Ok(status) => {
                        exit_status = Some(status);
                        // A worker may leave a background descendant holding
                        // the pipes open; stop the contained tree before
                        // waiting for stream EOF.
                        let _ = tree.terminate();
                    }
                    Err(_) => {
                        wait_failed = true;
                        break;
                    }
                }
            }
            _ = job.cancel.cancelled(), if !cancel_seen => {
                cancel_seen = true;
                let _ = tree.terminate();
            }
            _ = sleep_until(deadline), if deadline.is_some() && !deadline_fired && exit_status.is_none() => {
                deadline_fired = true;
                job.request_cancel(CancelReason::Deadline);
                let _ = tree.terminate();
            }
            chunk = out_rx.recv(), if stdout_open => {
                match chunk {
                    Some(chunk) => collector.on_stdout(&chunk),
                    None => stdout_open = false,
                }
            }
            chunk = err_rx.recv(), if stderr_open => {
                match chunk {
                    Some(chunk) => collector.on_stderr(&chunk),
                    None => stderr_open = false,
                }
            }
            _ = sleep_until(drain_deadline), if drain_deadline.is_some() && (stdout_open || stderr_open) => {
                drain_timed_out = true;
                stdout_open = false;
                stderr_open = false;
            }
            else => break,
        }
    }

    if drain_timed_out {
        if let Some(task) = out_task {
            task.abort();
        }
        if let Some(task) = err_task {
            task.abort();
        }
    }

    let exit_code = exit_status.and_then(|status| status.code());
    let mut collected = collector.finish_redacted(exit_code, &config.redactor);
    if wait_failed {
        collected = Collected {
            outcome: RunOutcome::Failed {
                code: ErrorCode::WorkerFailed,
                message: "failed to reap the worker process".to_string(),
            },
            ..collected
        };
    }
    let mut delivery_note = None;
    if drain_timed_out {
        if matches!(collected.outcome, RunOutcome::Completed) {
            // The native terminal event and exit status already agreed. A
            // detached descendant holding the pipe makes delivery uncertain,
            // not the worker's success.
            collected.output_complete = false;
            delivery_note = Some("worker output pipe did not close after exit".to_string());
        } else {
            collected.protocol_incomplete = true;
        }
    }

    let cleanup_confirmed = cleanup::terminate_and_confirm(&tree).await;
    let cleanup = Cleanup {
        confirmed: cleanup_confirmed,
        detail: (!cleanup_confirmed)
            .then(|| "contained processes remain after termination".to_string()),
    };

    let reason = job.reason();
    let native_completed = matches!(&collected.outcome, RunOutcome::Completed);
    let (status, error) = if matches!(
        reason,
        Some(CancelReason::User) | Some(CancelReason::Shutdown)
    ) {
        (cancel_status(reason), cancel_error(reason))
    } else if native_completed {
        // A native success with a consistent exit status is authoritative; a
        // deadline that became ready at the same time cannot rewrite it.
        (TerminalStatus::Completed, None)
    } else if reason == Some(CancelReason::Deadline) || deadline_fired {
        (
            TerminalStatus::TimedOut,
            cancel_error(Some(CancelReason::Deadline)),
        )
    } else {
        match &collected.outcome {
            RunOutcome::Completed => (TerminalStatus::Completed, None),
            RunOutcome::Failed { code, message } => (
                TerminalStatus::Failed,
                Some(ResultError {
                    code: code.as_str().to_string(),
                    message: message.clone(),
                }),
            ),
            RunOutcome::NeedsInput { message } => (
                TerminalStatus::NeedsInput,
                Some(ResultError {
                    code: ErrorCode::NeedsInput.as_str().to_string(),
                    message: message.clone(),
                }),
            ),
        }
    };

    guard.settle(Settlement {
        status,
        error,
        final_text: collected.final_text,
        output_complete: collected.output_complete,
        cleanup,
        protocol_incomplete: collected.protocol_incomplete,
        exit_code,
        delivery_note,
        redacted: collected.redacted,
    });
}

/// Publish one terminal Markdown result when the accepted task requested it.
/// Every settlement path uses this helper, including spawn/containment failures
/// and a cancel that wins before the worker starts.
fn publish_report(job: &Job, config: &RuntimeConfig, result: &mut FinalResult) {
    if !job.task.save_result {
        return;
    }
    let Some(directory) = config.results_dir.as_ref() else {
        result.report_error = Some(ErrorCode::ReportWriteFailed.as_str().to_string());
        return;
    };
    let input = ReportInput {
        job_id: &result.job_id,
        harness: &result.harness,
        adapter_version: &result.adapter_version,
        status: result.status,
        started_at: &result.started_at,
        finished_at: &result.finished_at,
        exit_code: result.exit_code,
        output_complete: result.output_complete,
        redacted: result.redacted,
        cleanup: &result.cleanup,
        final_output: result.worker_final_output.as_deref(),
        error: result.error.as_ref(),
        delivery_error: result.delivery_error.as_ref(),
    };
    match report::publish(directory, &input) {
        Ok(path) => result.report_path = Some(path.to_string_lossy().into_owned()),
        Err(error) => {
            tracing::warn!(
                job_id = %result.job_id,
                "final report publication failed: {}",
                error.code.as_str()
            );
            result.report_error = Some(ErrorCode::ReportWriteFailed.as_str().to_string());
        }
    }
}

fn cancel_status(reason: Option<CancelReason>) -> TerminalStatus {
    match reason {
        Some(CancelReason::User) => TerminalStatus::Cancelled,
        Some(CancelReason::Deadline) => TerminalStatus::TimedOut,
        Some(CancelReason::Shutdown) => TerminalStatus::Interrupted,
        None => TerminalStatus::Interrupted,
    }
}

fn cancel_error(reason: Option<CancelReason>) -> Option<ResultError> {
    match reason {
        Some(CancelReason::User) => None,
        Some(CancelReason::Deadline) => Some(ResultError {
            code: ErrorCode::DeadlineExceeded.as_str().to_string(),
            message: "explicit deadline_at reached".to_string(),
        }),
        Some(CancelReason::Shutdown) | None => Some(ResultError {
            code: ErrorCode::Interrupted.as_str().to_string(),
            message: "bridge instance is shutting down".to_string(),
        }),
    }
}

/// Terminal fields that vary between results. Identity, harness and timestamps
/// are derived from the job and adapter by [`settle_result`].
struct Settlement {
    status: TerminalStatus,
    error: Option<ResultError>,
    final_text: Option<String>,
    output_complete: bool,
    cleanup: Cleanup,
    protocol_incomplete: bool,
    exit_code: Option<i32>,
    delivery_note: Option<String>,
    redacted: bool,
}

impl Settlement {
    fn new(status: TerminalStatus, cleanup: Cleanup) -> Self {
        Self {
            status,
            error: None,
            final_text: None,
            output_complete: false,
            cleanup,
            protocol_incomplete: false,
            exit_code: None,
            delivery_note: None,
            redacted: false,
        }
    }

    /// A failed result; the message is redacted by the shared builder.
    fn failed(code: ErrorCode, message: impl Into<String>, cleanup: Cleanup) -> Self {
        Self {
            error: Some(ResultError {
                code: code.as_str().to_string(),
                message: message.into(),
            }),
            ..Self::new(TerminalStatus::Failed, cleanup)
        }
    }

    fn interrupted(message: impl Into<String>, cleanup: Cleanup) -> Self {
        Self {
            error: Some(ResultError {
                code: ErrorCode::Interrupted.as_str().to_string(),
                message: message.into(),
            }),
            ..Self::new(TerminalStatus::Interrupted, cleanup)
        }
    }
}

fn confirmed_cleanup() -> Cleanup {
    Cleanup {
        confirmed: true,
        detail: None,
    }
}

fn settle_result(
    job: &Job,
    config: &RuntimeConfig,
    adapter: &dyn Adapter,
    redactor: &Redactor,
    started_at: OffsetDateTime,
    settlement: Settlement,
) -> FinalResult {
    let (final_text, output_redacted) = match settlement.final_text {
        Some(text) => {
            let (text, redacted) = redactor.redact(&text);
            (Some(text), redacted)
        }
        None => (None, false),
    };
    let (final_text, truncated) = match final_text {
        Some(text) => {
            let (text, truncated) = truncate_text(&text, config.max_final_bytes);
            (Some(text), truncated)
        }
        None => (None, false),
    };
    let (error, error_redacted) = match settlement.error {
        Some(error) => {
            let (message, redacted) = redactor.redact(&error.message);
            let (message, _) = truncate_text(&message, config.max_diagnostic_bytes);
            (
                Some(ResultError {
                    code: error.code,
                    message,
                }),
                redacted,
            )
        }
        None => (None, false),
    };

    let delivery_error = if truncated {
        Some(ResultError {
            code: ErrorCode::ResultTooLarge.as_str().to_string(),
            message: "worker final answer exceeded max_final_bytes".to_string(),
        })
    } else if settlement.protocol_incomplete {
        Some(ResultError {
            code: ErrorCode::StreamIncomplete.as_str().to_string(),
            message: "worker protocol stream was incomplete".to_string(),
        })
    } else {
        settlement.delivery_note.map(|message| ResultError {
            code: ErrorCode::StreamIncomplete.as_str().to_string(),
            message,
        })
    };

    FinalResult {
        job_id: job.id.clone(),
        instance_id: job.instance_id.clone(),
        request_id: job.request_id.clone(),
        harness: adapter.id().to_string(),
        adapter_version: adapter.version().to_string(),
        status: settlement.status,
        worker_final_output: final_text,
        output_complete: settlement.output_complete
            && !truncated
            && !settlement.protocol_incomplete
            && !output_redacted,
        redacted: output_redacted || error_redacted || (settlement.redacted && error.is_some()),
        exit_code: settlement.exit_code,
        error,
        delivery_error,
        cleanup: settlement.cleanup,
        report_path: None,
        report_error: None,
        started_at: timestamp(started_at),
        finished_at: timestamp(OffsetDateTime::now_utc()),
    }
}

async fn pump<R>(mut reader: R, tx: mpsc::Sender<Vec<u8>>)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = vec![0_u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                if tx.send(buffer[..read].to_vec()).await.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Translate a wall-clock deadline into the monotonic timer domain.
fn tokio_deadline(deadline: Option<std::time::SystemTime>) -> Option<tokio::time::Instant> {
    let deadline = deadline?;
    let now = tokio::time::Instant::now();
    match deadline.duration_since(std::time::SystemTime::now()) {
        Ok(remaining) => Some(now + remaining),
        Err(_) => Some(now),
    }
}

/// Settle exactly once, including on an unexpected supervisor exit.
struct SettleGuard {
    registry: Arc<Registry>,
    job: Arc<Job>,
    adapter: Arc<dyn Adapter>,
    redactor: Arc<Redactor>,
    started_at: OffsetDateTime,
    settled: bool,
}

impl SettleGuard {
    fn new(
        registry: Arc<Registry>,
        job: Arc<Job>,
        adapter: Arc<dyn Adapter>,
        redactor: Arc<Redactor>,
        started_at: OffsetDateTime,
    ) -> Self {
        Self {
            registry,
            job,
            adapter,
            redactor,
            started_at,
            settled: false,
        }
    }

    fn settle(&mut self, settlement: Settlement) {
        let mut result = settle_result(
            &self.job,
            &self.registry.config,
            self.adapter.as_ref(),
            &self.redactor,
            self.started_at,
            settlement,
        );
        publish_report(&self.job, &self.registry.config, &mut result);
        self.registry.settle(&self.job, result);
        self.settled = true;
    }
}

impl Drop for SettleGuard {
    fn drop(&mut self) {
        if self.settled {
            return;
        }
        let result = settle_result(
            &self.job,
            &self.registry.config,
            self.adapter.as_ref(),
            &self.redactor,
            self.started_at,
            Settlement::interrupted(
                "supervisor ended without a terminal result",
                Cleanup {
                    confirmed: false,
                    detail: Some("supervisor exited before cleanup confirmation".to_string()),
                },
            ),
        );
        self.registry.settle(&self.job, result);
    }
}
