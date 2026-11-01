//! W1/W3 lifecycle tests: a wait window and a dropped wait future never stop
//! the worker, explicit cancellation terminates the descendant tree and
//! confirms cleanup, an explicit deadline produces `timed_out`, repeated
//! cancels are idempotent, and normal completion releases the active slot.

mod support;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use xuanling_harness_bridge::jobs::{FinalResult, Job, Registry, TerminalStatus};
use xuanling_harness_bridge::supervisor;
use xuanling_harness_bridge::task::SubmitInput;

use support::{TEST_ADAPTER, config, deadline_in, final_result, input, run_one};

const WAIT_LIMIT: Duration = Duration::from_secs(15);

#[test]
fn explicit_deadline_preserves_fractional_seconds() {
    let temp = tempfile::tempdir().expect("temp dir");
    let runtime = config(temp.path(), None, 1);
    // Windows SystemTime has 100ns resolution. These values retain their
    // entire fractional part on every supported platform.
    for nanoseconds in [100, 123_456_700, 900_000_000, 999_999_900] {
        let deadline = (time::OffsetDateTime::now_utc() + time::Duration::seconds(60))
            .replace_nanosecond(nanoseconds)
            .unwrap();
        let mut request = input(
            &runtime.instance_id,
            "fractional-deadline",
            "success",
            false,
        );
        request.deadline_at = Some(
            deadline
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap(),
        );
        let frozen = xuanling_harness_bridge::task::freeze(&runtime, request).unwrap();
        let actual = frozen
            .deadline_time()
            .unwrap()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap();
        assert_eq!(actual.as_nanos(), deadline.unix_timestamp_nanos() as u128);
    }
}

#[tokio::test]
async fn fractional_deadline_allows_completion_inside_the_final_second() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let deadline = (time::OffsetDateTime::now_utc() + time::Duration::seconds(2))
        .replace_nanosecond(900_000_000)
        .unwrap();
    let finish_at = deadline - time::Duration::milliseconds(600);
    let payload = scenario(serde_json::json!({
        "scenario":"success-at",
        "text": finish_at.format(&time::format_description::well_known::Rfc3339).unwrap(),
    }));
    let mut request = input(
        registry.instance_id(),
        "fractional-success",
        &payload,
        false,
    );
    request.deadline_at = Some(
        deadline
            .format(&time::format_description::well_known::Rfc3339)
            .unwrap(),
    );
    let result = run_one(registry, request).await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(
        result.worker_final_output.as_deref(),
        Some("finished within explicit deadline")
    );
    assert!(result.cleanup.confirmed);
}

fn scenario(value: serde_json::Value) -> String {
    value.to_string()
}

fn silent(sleep_ms: u64, text: &str) -> String {
    scenario(serde_json::json!({
        "scenario": "silent",
        "sleep_ms": sleep_ms,
        "text": text,
    }))
}

async fn spawn_job(
    registry: &Arc<Registry>,
    request: SubmitInput,
) -> (Arc<Job>, tokio::task::JoinHandle<()>) {
    let accepted = registry.submit(request).expect("submit accepted");
    let job = accepted.job.clone();
    let adapter = registry.config.adapter(TEST_ADAPTER).expect("test adapter");
    let redactor = registry.config.redactor.clone();
    let background = registry.clone();
    let supervised = job.clone();
    let handle = tokio::spawn(async move {
        supervisor::run(background, supervised, adapter, redactor).await;
    });
    (job, handle)
}

async fn wait_final(registry: &Registry, job: &Job) -> FinalResult {
    let outcome = tokio::time::timeout(WAIT_LIMIT, registry.wait(&job.id, None))
        .await
        .expect("wait settled in time")
        .expect("job readable");
    final_result(outcome)
}

#[tokio::test]
async fn wait_window_does_not_stop_the_worker() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = registry.instance_id().to_string();

    let (job, handle) = spawn_job(
        &registry,
        input(&instance, "req-wait", &silent(500, "late answer"), false),
    )
    .await;

    let first = registry
        .wait(&job.id, Some(20))
        .await
        .expect("wait window readable");
    match first {
        xuanling_harness_bridge::jobs::WaitOutcome::Pending { status, .. } => {
            assert!(
                matches!(status, "accepted" | "running"),
                "unexpected pending status: {status}"
            );
        }
        xuanling_harness_bridge::jobs::WaitOutcome::Final(_) => {
            panic!("a 20ms wait window must not see the 500ms worker finish")
        }
    }

    let result = wait_final(&registry, &job).await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(result.worker_final_output.as_deref(), Some("late answer"));
    assert!(result.cleanup.confirmed);
    handle.await.expect("supervisor task");
}

#[tokio::test]
async fn dropped_wait_future_does_not_cancel_the_job() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = registry.instance_id().to_string();

    let (job, handle) = spawn_job(
        &registry,
        input(&instance, "req-drop", &silent(400, "still running"), false),
    )
    .await;

    // Dropping the wait future after a short timeout must only end this
    // waiter; the job and its worker keep running.
    let dropped =
        tokio::time::timeout(Duration::from_millis(20), registry.wait(&job.id, None)).await;
    assert!(
        dropped.is_err(),
        "the wait future should time out and be dropped"
    );

    let result = wait_final(&registry, &job).await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(result.worker_final_output.as_deref(), Some("still running"));
    handle.await.expect("supervisor task");
}

#[cfg(unix)]
fn process_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks for the process' existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(unix)]
fn process_gone(pid: i32) -> bool {
    // SAFETY: signal 0 only checks for the process' existence.
    unsafe {
        libc::kill(pid, 0) == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }
}

async fn wait_for_pid(path: &Path) -> i32 {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && let Ok(pid) = text.trim().parse::<i32>()
        {
            return pid;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "worker never wrote the descendant pid file"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(unix)]
async fn wait_for_exit(pid: i32) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if process_gone(pid) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "descendant {pid} is still alive after cleanup was confirmed"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn cancel_terminates_descendants_and_confirms_cleanup() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = registry.instance_id().to_string();
    let pid_file = temp.path().join("descendant.pid");
    let pid_file_text = pid_file.to_str().expect("utf-8 temp path").to_string();

    let (job, handle) = spawn_job(
        &registry,
        input(
            &instance,
            "req-descendants",
            &scenario(serde_json::json!({
                "scenario": "spawn-child-silent",
                "pid_file": pid_file_text,
                "text": "never",
            })),
            false,
        ),
    )
    .await;

    let pid = wait_for_pid(&pid_file).await;
    #[cfg(unix)]
    assert!(
        process_alive(pid),
        "the descendant should be running before the cancel"
    );

    let result = tokio::time::timeout(WAIT_LIMIT, registry.cancel(&job.id))
        .await
        .expect("cancel settled in time")
        .expect("cancel succeeded");
    assert_eq!(result.status, TerminalStatus::Cancelled);
    assert!(
        result.cleanup.confirmed,
        "cleanup must be confirmed after a job cancel: {:?}",
        result.cleanup
    );
    assert!(
        result.error.is_none(),
        "an explicit cancel is not a failure"
    );

    #[cfg(unix)]
    wait_for_exit(pid).await;
    #[cfg(not(unix))]
    let _ = pid;

    handle.await.expect("supervisor task");
}

#[tokio::test]
async fn repeated_cancel_is_idempotent() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = registry.instance_id().to_string();

    let (job, handle) = spawn_job(
        &registry,
        input(
            &instance,
            "req-cancel-twice",
            &silent(5_000, "never"),
            false,
        ),
    )
    .await;
    // Let the supervisor start the worker so the cancel path is exercised.
    tokio::time::sleep(Duration::from_millis(100)).await;

    let first = tokio::time::timeout(WAIT_LIMIT, registry.cancel(&job.id))
        .await
        .expect("first cancel settled")
        .expect("first cancel succeeded");
    assert_eq!(first.status, TerminalStatus::Cancelled);
    assert!(first.cleanup.confirmed);

    let second = tokio::time::timeout(WAIT_LIMIT, registry.cancel(&job.id))
        .await
        .expect("second cancel settled")
        .expect("second cancel succeeded");
    assert_eq!(second.job_id, first.job_id);
    assert_eq!(second.status, first.status);
    assert_eq!(second.finished_at, first.finished_at);
    assert_eq!(second.cleanup.confirmed, first.cleanup.confirmed);

    handle.await.expect("supervisor task");
}

#[tokio::test]
async fn explicit_deadline_times_out() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = registry.instance_id().to_string();

    let mut request = input(&instance, "req-deadline", &silent(60_000, "never"), false);
    request.deadline_at = Some(deadline_in(1));

    let (job, handle) = spawn_job(&registry, request).await;
    let result = wait_final(&registry, &job).await;

    assert_eq!(result.status, TerminalStatus::TimedOut);
    let error = result.error.as_ref().expect("timed_out carries an error");
    assert_eq!(error.code, "DEADLINE_EXCEEDED");
    assert!(
        result.cleanup.confirmed,
        "deadline cleanup must be confirmed"
    );
    assert!(
        result.worker_final_output.is_none(),
        "the worker was stopped before producing a final answer"
    );
    handle.await.expect("supervisor task");
}

#[tokio::test]
async fn normal_completion_releases_the_active_slot() {
    let temp = tempfile::tempdir().expect("temp dir");
    let registry = Arc::new(Registry::new(Arc::new(config(temp.path(), None, 1))));
    let instance = registry.instance_id().to_string();

    let payload = scenario(serde_json::json!({"scenario": "success", "text": "done"}));
    let result = run_one(
        registry.clone(),
        input(&instance, "req-release-1", &payload, false),
    )
    .await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert!(result.cleanup.confirmed);
    assert_eq!(
        registry.active_jobs(),
        0,
        "normal completion releases the slot"
    );
    assert_eq!(registry.retained_jobs(), 1);

    let next = registry
        .submit(input(&instance, "req-release-2", "OK", false))
        .expect("the freed slot accepts a new job");
    assert!(!next.reused);
    assert_eq!(registry.active_jobs(), 1);
}
