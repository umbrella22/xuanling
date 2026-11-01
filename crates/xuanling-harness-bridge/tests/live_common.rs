//! Shared helpers for the opt-in live CLI targets.
//!
//! A live target is compiled unconditionally but only executes when its gate
//! variable is set (for example `HARNESS_BRIDGE_LIVE_CODEX=1`). When the gate is
//! absent the test prints one `not_run: <reason>` line to file descriptor 2 and
//! returns; a skipped live gate must never look like a real success.
//!
//! The helpers deliberately read no credential value. `secret_env` carries only
//! environment variable *names*; production reads the values for redaction.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use xuanling_harness_bridge::config::{AdapterConfigs, BridgeConfig, RuntimeConfig};
use xuanling_harness_bridge::jobs::{FinalResult, Registry, TerminalStatus, WaitOutcome};
use xuanling_harness_bridge::supervisor;
use xuanling_harness_bridge::task::SubmitInput;

/// Workspace id used by every live target.
pub const WORKSPACE_ID: &str = "live";

/// The one prompt every live success target submits.
pub const PROMPT: &str = "Reply with exactly: OK";

/// Explicit task deadline for one live call. This is a per-job `deadline_at`,
/// not a bridge default task timeout.
pub const DEADLINE_SECONDS: u64 = 240;

/// Stable failure codes the adapters can produce for a native failure.
pub const TYPED_FAILURE_CODES: &[&str] = &[
    "AUTH_REQUIRED",
    "RATE_LIMIT",
    "WORKER_FAILED",
    "NEEDS_INPUT",
    "STREAM_INCOMPLETE",
    "SPAWN_FAILED",
    "INCOMPATIBLE_CLI",
    "DEADLINE_EXCEEDED",
    "ADAPTER_UNAVAILABLE",
    "CONFIG_INVALID",
];

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Whether a live target was explicitly enabled. `1` (or any non-empty value
/// other than `0`) runs it; unset or `0` skips it.
pub fn live_gate(env_var: &str) -> bool {
    match std::env::var(env_var) {
        Ok(value) => !value.is_empty() && value != "0",
        Err(_) => false,
    }
}

/// Record a skipped live gate on fd 2 so libtest output capture cannot hide it.
pub fn not_run(reason: &str) {
    let _ = writeln!(std::io::stderr().lock(), "not_run: {reason}");
}

/// Resolve a CLI path from an override env var, falling back to the verified
/// default for this machine. Returns `None` when neither is an absolute file.
///
/// The gate variable also carries the path override, so a non-absolute value
/// such as `1` means "enabled, use the default". An absolute path is the only
/// real override; an absolute path that is not a file is reported as missing
/// rather than silently replaced by the default.
pub fn cli_path(env_var: &str, default: &str) -> Option<PathBuf> {
    let default_path = PathBuf::from(default);
    let default_path =
        (default_path.is_absolute() && default_path.is_file()).then_some(default_path);
    match std::env::var_os(env_var) {
        Some(value) => {
            let candidate = PathBuf::from(value);
            if candidate.is_absolute() {
                candidate.is_file().then_some(candidate)
            } else {
                default_path
            }
        }
        None => default_path,
    }
}

/// Configured version override, or the default of the verified installation.
pub fn cli_version(env_var: &str, default: &str) -> String {
    std::env::var(env_var).unwrap_or_else(|_| default.to_string())
}

/// An instance-local config with exactly one adapter, one tempdir workspace,
/// no `results_dir` and a single active-job slot.
pub fn base_config(
    workspace: &Path,
    env_allowlist: &[&str],
    secret_env: &[&str],
    adapters: AdapterConfigs,
) -> BridgeConfig {
    BridgeConfig {
        max_active_jobs: 1,
        max_retained_jobs: 8,
        max_final_bytes: 1 << 20,
        max_diagnostic_bytes: 8 << 10,
        max_protocol_line_bytes: 1 << 20,
        max_protocol_bytes: 8 << 20,
        max_prompt_bytes: 1 << 20,
        results_dir: None,
        workspaces: BTreeMap::from([(WORKSPACE_ID.to_string(), workspace.to_path_buf())]),
        env_allowlist: env_allowlist.iter().map(|name| name.to_string()).collect(),
        secret_env: secret_env.iter().map(|name| name.to_string()).collect(),
        adapters,
    }
}

/// A request id unique to this process, run and test thread.
pub fn unique_request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let count = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("live-{}-{nanos}-{count}", std::process::id())
}

/// Accept, supervise and read back one job exactly as the live contract says:
/// `supervisor::run` directly, then `registry.wait(job_id, Some(0))`.
pub async fn run_job(config: RuntimeConfig, adapter_id: &str) -> FinalResult {
    let config = Arc::new(config);
    let registry = Arc::new(Registry::new(config.clone()));
    let input = SubmitInput {
        instance_id: registry.instance_id().to_string(),
        request_id: unique_request_id(),
        adapter: adapter_id.to_string(),
        workspace_id: WORKSPACE_ID.to_string(),
        prompt: Some(PROMPT.to_string()),
        task_file: None,
        save_result: false,
        deadline_at: Some(rfc3339_in(DEADLINE_SECONDS)),
    };
    let outcome = registry.submit(input).expect("live submit accepted");
    let job = outcome.job.clone();
    let adapter = config
        .adapter(adapter_id)
        .unwrap_or_else(|| panic!("live adapter not configured: {adapter_id}"));
    let redactor = config.redactor.clone();
    supervisor::run(registry.clone(), job.clone(), adapter, redactor).await;
    match registry
        .wait(&job.id, Some(0))
        .await
        .expect("live job readable")
    {
        WaitOutcome::Final(result) => result,
        WaitOutcome::Pending { status, elapsed_ms } => panic!(
            "live job did not settle after supervisor returned: status={status} \
             elapsed_ms={elapsed_ms} adapter={adapter_id}"
        ),
    }
}

/// Enough execution facts to record an environmental blocker honestly.
pub fn describe(result: &FinalResult) -> String {
    let error = result
        .error
        .as_ref()
        .map(|error| format!("{}: {}", error.code, error.message))
        .unwrap_or_else(|| "<none>".to_string());
    let delivery = result
        .delivery_error
        .as_ref()
        .map(|error| format!("{}: {}", error.code, error.message))
        .unwrap_or_else(|| "<none>".to_string());
    format!(
        "job_id={} status={:?} error={error} exit_code={:?} report_error={:?} \
         delivery_error={delivery} output_complete={} cleanup.confirmed={} redacted={}",
        result.job_id,
        result.status,
        result.exit_code,
        result.report_error,
        result.output_complete,
        result.cleanup.confirmed,
        result.redacted,
    )
}

/// Record what the live call actually returned on fd 2, so a passing run also
/// carries the observed status/error evidence.
pub fn record_observed(harness: &str, check: &str, result: &FinalResult) {
    let _ = writeln!(
        std::io::stderr().lock(),
        "live_observed: harness={harness} check={check} {}",
        describe(result)
    );
}

/// Assert the live success contract for one adapter.
pub fn assert_completed_ok(result: &FinalResult, harness: &str) {
    let detail = describe(result);
    assert_eq!(
        result.status,
        TerminalStatus::Completed,
        "live {harness} run did not complete: {detail}"
    );
    assert_eq!(
        result.harness, harness,
        "live {harness} result harness mismatch: {detail}"
    );
    assert!(
        result.output_complete,
        "live {harness} final output is incomplete: {detail}"
    );
    let text = result.worker_final_output.as_deref().unwrap_or("");
    assert_eq!(
        text.trim(),
        "OK",
        "live {harness} final answer mismatch: {detail} worker_final_output={text:?}"
    );
    assert!(
        result.cleanup.confirmed,
        "live {harness} cleanup was not confirmed: {detail}"
    );
    assert!(
        result.delivery_error.is_none(),
        "live {harness} delivery_error is set: {detail}"
    );
}

/// Assert an invalid-model run is classified as a typed failure, never a
/// success and never an unclassified text error.
pub fn assert_failed_typed(result: &FinalResult, harness: &str) {
    let detail = describe(result);
    assert_ne!(
        result.status,
        TerminalStatus::Completed,
        "live {harness} invalid-model run unexpectedly completed: {detail}"
    );
    assert_eq!(
        result.status,
        TerminalStatus::Failed,
        "live {harness} invalid-model run was not a typed failure: {detail}"
    );
    let error = result
        .error
        .as_ref()
        .unwrap_or_else(|| panic!("live {harness} invalid-model run has no typed error: {detail}"));
    assert!(
        TYPED_FAILURE_CODES.contains(&error.code.as_str()),
        "live {harness} invalid-model run returned an unknown error code {:?}: {detail}",
        error.code
    );
}

/// RFC3339 UTC timestamp `seconds` in the future, produced without extra deps.
fn rfc3339_in(seconds: u64) -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0);
    format_epoch(now + seconds)
}

fn format_epoch(secs: u64) -> String {
    let days = secs / 86_400;
    let remainder = secs % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    let hour = remainder / 3_600;
    let minute = (remainder % 3_600) / 60;
    let second = remainder % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Howard Hinnant's `civil_from_days` (days since 1970-01-01).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}
