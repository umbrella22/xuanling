//! W1 contract tests: frozen task bytes, instance-local deduplication, the
//! active-slot limit, retained-record capacity, instance identity and the
//! absence of a default deadline or consumption budget.
//!
//! Every test drives the real registry/supervisor path with the compiled fake
//! worker; nothing here mocks a production module.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use xuanling_harness_bridge::error::ErrorCode;
use xuanling_harness_bridge::jobs::{Registry, TerminalStatus, WaitOutcome};
use xuanling_harness_bridge::supervisor;

use support::{TEST_ADAPTER, config, final_result, input, run_one};

fn instance_of(registry: &Registry) -> String {
    registry.instance_id().to_string()
}

fn scenario(value: serde_json::Value) -> String {
    value.to_string()
}

fn sha256_hex(text: &str) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write as _;
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

async fn run_accepted(
    registry: Arc<Registry>,
    job: Arc<xuanling_harness_bridge::jobs::Job>,
) -> xuanling_harness_bridge::jobs::FinalResult {
    let adapter = registry.config.adapter(TEST_ADAPTER).expect("test adapter");
    let redactor = registry.config.redactor.clone();
    supervisor::run(registry.clone(), job.clone(), adapter, redactor).await;
    final_result(registry.wait(&job.id, Some(0)).await.expect("job readable"))
}

#[tokio::test]
async fn task_file_is_frozen_at_acceptance() {
    let temp = tempfile::tempdir().expect("temp dir");
    let task_path = temp.path().join("task.json");
    let original = scenario(serde_json::json!({
        "scenario": "success",
        "text": "frozen-answer",
    }));
    std::fs::write(&task_path, &original).expect("write task file");

    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = instance_of(&registry);
    let mut request = input(&instance, "req-freeze", "", false);
    request.prompt = None;
    request.task_file = Some("task.json".to_string());

    let accepted = registry.submit(request).expect("submit accepted");
    assert!(!accepted.reused);
    let job = accepted.job.clone();
    assert_eq!(job.task.prompt, original);
    assert_eq!(job.task.input_sha256, sha256_hex(&original));

    // Rewriting the source file after acceptance must not change the task the
    // accepted job will execute.
    let replacement = scenario(serde_json::json!({
        "scenario": "success",
        "text": "changed-answer",
    }));
    std::fs::write(&task_path, &replacement).expect("rewrite task file");
    assert_eq!(job.task.prompt, original);
    assert_eq!(job.task.input_sha256, sha256_hex(&original));

    let result = run_accepted(registry, job).await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(
        result.worker_final_output.as_deref(),
        Some("frozen-answer"),
        "worker must receive the frozen bytes, not the rewritten file"
    );
}

#[tokio::test]
async fn request_replay_reuses_job_and_conflicts_on_change() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 2))));
    let instance = instance_of(&registry);
    let payload = scenario(serde_json::json!({"scenario": "success", "text": "one"}));

    let request = input(&instance, "req-replay", &payload, false);
    let first = registry.submit(request.clone()).expect("first submit");
    assert!(!first.reused);

    let replay = registry.submit(request).expect("replay accepted");
    assert!(replay.reused, "identical payload must be reused");
    assert_eq!(replay.job.id, first.job.id, "replay must not spawn a job");
    assert_eq!(
        registry.retained_jobs(),
        1,
        "replay must not create records"
    );

    let changed = input(
        &instance,
        "req-replay",
        &scenario(serde_json::json!({"scenario": "success", "text": "changed"})),
        false,
    );
    let conflict = registry
        .submit(changed)
        .expect_err("changed payload conflicts");
    assert_eq!(conflict.code, ErrorCode::RequestConflict);

    let new_request = input(&instance, "req-replay-new-id", &payload, false);
    let fresh = registry.submit(new_request).expect("new request accepted");
    assert!(!fresh.reused);
    assert_ne!(fresh.job.id, first.job.id);
    assert_eq!(registry.retained_jobs(), 2);
}

#[tokio::test]
async fn stale_instance_is_rejected() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let stale = "inst-00000000000000000000000000000000";

    let error = registry
        .submit(input(stale, "req-stale", "OK", false))
        .expect_err("stale instance must be rejected");
    assert_eq!(error.code, ErrorCode::InstanceChanged);
    assert_eq!(registry.retained_jobs(), 0);
}

#[tokio::test]
async fn second_submit_is_busy_until_first_completes() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = instance_of(&registry);

    let first = registry
        .submit(input(
            &instance,
            "req-busy-1",
            &scenario(serde_json::json!({
                "scenario": "silent",
                "sleep_ms": 300,
                "text": "first",
            })),
            false,
        ))
        .expect("first submit");
    let adapter = registry.config.adapter(TEST_ADAPTER).expect("test adapter");
    let redactor = registry.config.redactor.clone();
    let background = registry.clone();
    let job = first.job.clone();
    let handle = tokio::spawn(async move {
        supervisor::run(background, job, adapter, redactor).await;
    });

    let busy = registry
        .submit(input(&instance, "req-busy-2", "OK", false))
        .expect_err("second active job must be BUSY");
    assert_eq!(busy.code, ErrorCode::Busy);
    assert_eq!(
        registry.retained_jobs(),
        1,
        "rejected submit creates no job"
    );

    handle.await.expect("supervisor task");
    let outcome = registry
        .wait(&first.job.id, Some(0))
        .await
        .expect("job readable");
    let result = final_result(outcome);
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(result.worker_final_output.as_deref(), Some("first"));
    assert_eq!(registry.active_jobs(), 0, "completion releases the slot");

    let third = registry
        .submit(input(&instance, "req-busy-3", "OK", false))
        .expect("a new submit is accepted after completion");
    assert!(!third.reused);
}

#[tokio::test]
async fn retained_capacity_is_not_silently_evicted() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut runtime = config(temp.path(), None, 1);
    runtime.max_retained_jobs = 1;
    let registry = Arc::new(Registry::new(Arc::new(runtime)));
    let instance = instance_of(&registry);
    let payload = scenario(serde_json::json!({"scenario": "success", "text": "kept"}));

    let result = run_one(
        registry.clone(),
        input(&instance, "req-kept", &payload, false),
    )
    .await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(registry.retained_jobs(), 1);
    assert_eq!(registry.active_jobs(), 0);

    let overflow = registry
        .submit(input(&instance, "req-overflow", "OK", false))
        .expect_err("retained capacity must reject new jobs");
    assert_eq!(overflow.code, ErrorCode::MemoryCapacity);
    assert_eq!(registry.retained_jobs(), 1, "existing records are kept");

    // The retained record still serves its deduplication duty.
    let replay = registry
        .submit(input(&instance, "req-kept", &payload, false))
        .expect("retained request still replays");
    assert!(replay.reused);
    assert_eq!(replay.job.id, result.job_id);
}

#[tokio::test]
async fn unknown_adapter_is_unavailable() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = instance_of(&registry);

    let mut request = input(&instance, "req-adapter", "OK", false);
    request.adapter = "codex".to_string();
    let error = registry
        .submit(request)
        .expect_err("unconfigured adapter must be rejected");
    assert_eq!(error.code, ErrorCode::AdapterUnavailable);
    assert_eq!(registry.retained_jobs(), 0);
}

#[tokio::test]
async fn no_default_deadline_or_budget() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = instance_of(&registry);

    // The trusted configuration has no field that could inject a default task
    // deadline or a consumption budget.
    let raw = serde_json::to_value(registry.config.raw()).expect("config serializes");
    assert!(raw.get("deadline_at").is_none());
    assert!(raw.get("consumption_budget").is_none());
    assert!(!raw.to_string().to_ascii_lowercase().contains("budget"));

    let accepted = registry
        .submit(input(
            &instance,
            "req-silent",
            &scenario(serde_json::json!({
                "scenario": "silent",
                "sleep_ms": 250,
                "text": "slow-but-alive",
            })),
            false,
        ))
        .expect("silent job accepted");
    assert!(
        accepted.job.task.deadline_at.is_none(),
        "no deadline_at was requested"
    );
    let adapter = registry.config.adapter(TEST_ADAPTER).expect("test adapter");
    let plan = adapter.plan(&accepted.job.task).expect("command plan");
    assert!(
        !plan.args.iter().any(|arg| arg.contains("budget")
            || arg.contains("timeout")
            || arg.contains("max-turns")),
        "worker argv must not carry a budget or default time limit: {:?}",
        plan.args
    );

    let started = Instant::now();
    let job = accepted.job.clone();
    let redactor = registry.config.redactor.clone();
    supervisor::run(registry.clone(), job.clone(), adapter, redactor).await;
    let elapsed = started.elapsed();
    let outcome = registry.wait(&job.id, Some(0)).await.expect("job readable");
    let result = match outcome {
        WaitOutcome::Final(result) => result,
        WaitOutcome::Pending { status, .. } => panic!("silent job unexpectedly pending: {status}"),
    };
    assert_eq!(result.status, TerminalStatus::Completed);
    assert!(result.error.is_none());
    assert_eq!(
        result.worker_final_output.as_deref(),
        Some("slow-but-alive")
    );
    assert!(
        elapsed >= Duration::from_millis(200),
        "a silent job must be allowed to run past a short default window (took {elapsed:?})"
    );

    // The health surface reports the same absence through its limits fields.
    let config_path = temp.path().join("bridge-config.json");
    std::fs::write(&config_path, "{}").expect("write bridge config");
    let mut server = support::McpProcess::start(&config_path);
    server.initialize();
    let response = support::call_tool(&mut server, "harness_health", serde_json::json!({}));
    let health = support::tool_structured(&response);
    assert!(health["limits"]["default_deadline_at"].is_null());
    assert!(health["limits"]["consumption_budget"].is_null());
    let status = server.shutdown();
    assert!(status.success(), "bridge exited uncleanly: {status}");
}

#[tokio::test]
async fn a_new_instance_cannot_see_old_jobs_or_requests() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry_a = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance_a = instance_of(&registry_a);
    let accepted = registry_a
        .submit(input(&instance_a, "req-old", "OK", false))
        .expect("first instance accepts");
    let old_job_id = accepted.job.id.clone();

    // A new RuntimeConfig is a new bridge process identity: nothing from the
    // old instance is readable or replayable.
    let registry_b = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    assert_ne!(registry_b.instance_id(), instance_a);
    assert_eq!(registry_b.retained_jobs(), 0);

    let error = registry_b
        .wait(&old_job_id, Some(0))
        .await
        .expect_err("an old job id is not visible");
    assert_eq!(error.code, ErrorCode::JobContextLost);

    let stale = registry_b
        .submit(input(&instance_a, "req-old", "OK", false))
        .expect_err("a stale instance id is rejected");
    assert_eq!(stale.code, ErrorCode::InstanceChanged);
    assert_eq!(registry_b.retained_jobs(), 0, "no replay was started");
}
