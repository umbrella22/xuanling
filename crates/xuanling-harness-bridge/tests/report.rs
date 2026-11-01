//! W1/W3 report tests: the default run writes no task file, `save_result`
//! publishes exactly one atomic Markdown result, a write failure never rewrites
//! the worker outcome, and an oversized answer is marked and truncated on a
//! UTF-8 boundary.

mod support;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use xuanling_harness_bridge::jobs::{CancelReason, FinalResult, Job, Registry, TerminalStatus};
use xuanling_harness_bridge::supervisor;

use support::{TEST_ADAPTER, TestAdapter, config, final_result, input, run_one};

fn scenario(value: serde_json::Value) -> String {
    value.to_string()
}

fn create_results(temp: &Path) -> PathBuf {
    let results = temp.join("results");
    std::fs::create_dir_all(&results).expect("create results dir");
    std::fs::canonicalize(&results).expect("canonical results dir")
}

fn entries(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir)
        .expect("read results dir")
        .map(|entry| entry.expect("dir entry").path())
        .collect();
    entries.sort();
    entries
}

async fn run_job(registry: Arc<Registry>, job: Arc<Job>) -> FinalResult {
    let adapter = registry.config.adapter(TEST_ADAPTER).expect("test adapter");
    let redactor = registry.config.redactor.clone();
    supervisor::run(registry.clone(), job.clone(), adapter, redactor).await;
    final_result(registry.wait(&job.id, Some(0)).await.expect("job readable"))
}

#[tokio::test]
async fn save_result_false_writes_no_files() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    let instance = registry.instance_id().to_string();

    let result = run_one(
        registry,
        input(
            &instance,
            "req-no-save",
            &scenario(serde_json::json!({"scenario": "success", "text": "no file"})),
            false,
        ),
    )
    .await;

    assert_eq!(result.status, TerminalStatus::Completed);
    assert!(result.report_path.is_none());
    assert!(result.report_error.is_none());
    assert!(
        entries(&results).is_empty(),
        "save_result=false must not write task files: {:?}",
        entries(&results)
    );
}

#[tokio::test]
async fn save_result_true_publishes_one_atomic_markdown() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    let instance = registry.instance_id().to_string();
    let answer = "exact worker final answer";

    let result = run_one(
        registry,
        input(
            &instance,
            "req-save",
            &scenario(serde_json::json!({"scenario": "success", "text": answer})),
            true,
        ),
    )
    .await;

    assert_eq!(result.status, TerminalStatus::Completed);
    assert!(result.report_error.is_none());
    let report_path = result
        .report_path
        .clone()
        .expect("report_path is returned on success");
    let report_path = PathBuf::from(report_path);
    assert_eq!(report_path, results.join(format!("{}.md", result.job_id)));

    let listing = entries(&results);
    assert_eq!(listing.len(), 1, "exactly one report file: {listing:?}");
    assert_eq!(listing[0], report_path);
    assert!(
        listing.iter().all(|path| !path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().ends_with(".tmp"))),
        "no temporary file may remain: {listing:?}"
    );

    let content = std::fs::read_to_string(&report_path).expect("read report");
    assert!(
        content.starts_with("---\nformat_version: 1\n"),
        "header must declare format_version: 1:\n{content}"
    );
    assert!(content.contains(&format!("job_id: {}\n", result.job_id)));
    assert!(content.contains("status: completed\n"));
    assert!(content.contains("output_complete: true\n"));
    assert!(content.contains("redacted: false\n"));
    assert!(content.contains("cleanup_confirmed: true\n"));
    assert!(
        content.ends_with(&format!("## Worker final answer\n\n{answer}\n")),
        "body must carry the exact worker answer:\n{content}"
    );
}

#[tokio::test]
async fn existing_report_is_not_overwritten() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    let instance = registry.instance_id().to_string();

    let accepted = registry
        .submit(input(
            &instance,
            "req-collision",
            &scenario(serde_json::json!({"scenario": "success", "text": "real answer"})),
            true,
        ))
        .expect("submit accepted");
    let job = accepted.job.clone();

    // The job id is known before the worker runs, so a user file can exist at
    // the final path when the report is published.
    let report_path = results.join(format!("{}.md", job.id));
    std::fs::write(&report_path, "sentinel content\n").expect("write sentinel");

    let result = run_job(registry, job).await;

    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(result.worker_final_output.as_deref(), Some("real answer"));
    assert_eq!(result.report_error.as_deref(), Some("REPORT_WRITE_FAILED"));
    assert!(result.report_path.is_none());
    assert_eq!(
        std::fs::read_to_string(&report_path).expect("read sentinel"),
        "sentinel content\n",
        "an existing file must never be overwritten"
    );
    assert_eq!(entries(&results), vec![report_path]);
}

#[tokio::test]
#[cfg(unix)]
async fn missing_or_non_directory_results_is_reported() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    let instance = registry.instance_id().to_string();

    // The results root disappears after configuration load.
    std::fs::remove_dir_all(&results).expect("remove results dir");
    let result = run_one(
        registry.clone(),
        input(
            &instance,
            "req-missing-dir",
            &scenario(serde_json::json!({"scenario": "success", "text": "preserved answer"})),
            true,
        ),
    )
    .await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(
        result.worker_final_output.as_deref(),
        Some("preserved answer")
    );
    assert_eq!(result.report_error.as_deref(), Some("REPORT_WRITE_FAILED"));
    assert!(result.report_path.is_none());

    // The results root is replaced by a regular file.
    std::fs::write(&results, "not a directory").expect("replace results dir with file");
    let result = run_one(
        registry,
        input(
            &instance,
            "req-file-dir",
            &scenario(serde_json::json!({"scenario": "success", "text": "second answer"})),
            true,
        ),
    )
    .await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(result.worker_final_output.as_deref(), Some("second answer"));
    assert_eq!(result.report_error.as_deref(), Some("REPORT_WRITE_FAILED"));
    assert!(result.report_path.is_none());
}

#[cfg(windows)]
#[tokio::test]
async fn held_results_directory_rejects_replacement_and_remains_publishable() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    // Windows capability directory handles deny FILE_SHARE_DELETE. The OS
    // prevents deletion/rename while the bridge owns the validated root.
    assert!(std::fs::remove_dir(&results).is_err());
    assert!(std::fs::rename(&results, temp.path().join("replacement")).is_err());
    assert!(results.is_dir());
    let result = run_one(
        registry.clone(),
        input(registry.instance_id(), "pinned-directory", "success", true),
    )
    .await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert!(result.report_error.is_none());
    assert_eq!(entries(&results).len(), 1);
}

#[tokio::test]
async fn oversized_answer_is_truncated_utf8_safely() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut runtime = config(temp.path(), None, 1);
    runtime.max_final_bytes = 5;
    let registry = Arc::new(Registry::new(Arc::new(runtime)));
    let instance = registry.instance_id().to_string();
    let answer = "ééééé";

    let result = run_one(
        registry,
        input(
            &instance,
            "req-too-large",
            &scenario(serde_json::json!({"scenario": "success", "text": answer})),
            false,
        ),
    )
    .await;

    assert_eq!(result.status, TerminalStatus::Completed);
    assert!(!result.output_complete);
    let delivery = result
        .delivery_error
        .as_ref()
        .expect("oversized output has a delivery_error");
    assert_eq!(delivery.code, "RESULT_TOO_LARGE");
    let output = result
        .worker_final_output
        .as_deref()
        .expect("truncated prefix is preserved");
    assert_eq!(output, "éé");
    assert!(answer.starts_with(output), "output must be a UTF-8 prefix");
    assert!(
        result.error.is_none(),
        "truncation is a delivery fact, not a worker failure"
    );
}

#[tokio::test]
async fn process_events_and_stderr_are_not_exposed() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    let instance = registry.instance_id().to_string();
    let answer = "clean final answer";

    let result = run_one(
        registry,
        input(
            &instance,
            "req-noise",
            &scenario(serde_json::json!({
                "scenario": "noisy-success",
                "text": answer,
                "stderr": "PROCESS-ONLY-MARKER stderr line",
            })),
            true,
        ),
    )
    .await;

    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(result.worker_final_output.as_deref(), Some(answer));

    let serialized = serde_json::to_string(&result).expect("result serializes");
    assert!(
        !serialized.contains("PROCESS-ONLY-MARKER"),
        "process events and stderr must not reach the tool result: {serialized}"
    );

    let report_path = result.report_path.as_deref().expect("report published");
    let content = std::fs::read_to_string(report_path).expect("read report");
    assert!(content.contains(answer));
    assert!(
        !content.contains("PROCESS-ONLY-MARKER"),
        "process events and stderr must not be written to the report: {content}"
    );
}

#[tokio::test]
async fn spawn_failure_still_publishes_the_optional_report() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let mut runtime = config(temp.path(), Some(results.clone()), 1);
    runtime.adapters.insert(
        TEST_ADAPTER,
        Arc::new(TestAdapter::with_missing_program(temp.path())),
    );
    let registry = Arc::new(Registry::new(Arc::new(runtime)));
    let instance = registry.instance_id().to_string();

    let result = run_one(registry, input(&instance, "req-spawn-failure", "OK", true)).await;

    assert_eq!(result.status, TerminalStatus::Failed);
    let error = result
        .error
        .as_ref()
        .expect("spawn failure carries an error");
    assert_eq!(error.code, "SPAWN_FAILED");
    let report_path = result
        .report_path
        .as_deref()
        .expect("a spawn failure still publishes the requested report");
    let content = std::fs::read_to_string(report_path).expect("read report");
    assert!(content.contains("status: failed"));
    assert!(content.contains("SPAWN_FAILED"));
    assert!(content.contains("(no final answer was produced)"));
}

#[tokio::test]
async fn cancel_before_spawn_publishes_the_optional_report() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    let instance = registry.instance_id().to_string();

    let accepted = registry
        .submit(input(
            &instance,
            "req-cancel-before-spawn",
            &scenario(serde_json::json!({"scenario": "success", "text": "never ran"})),
            true,
        ))
        .expect("submit accepted");
    let job = accepted.job.clone();
    job.request_cancel(CancelReason::User);

    let adapter = registry.config.adapter(TEST_ADAPTER).expect("test adapter");
    let redactor = registry.config.redactor.clone();
    supervisor::run(registry.clone(), job.clone(), adapter, redactor).await;

    let result = final_result(registry.wait(&job.id, Some(0)).await.expect("job readable"));
    assert_eq!(result.status, TerminalStatus::Cancelled);
    assert!(result.cleanup.confirmed);
    let report_path = result
        .report_path
        .as_deref()
        .expect("a pre-spawn cancel still publishes the requested report");
    let content = std::fs::read_to_string(report_path).expect("read report");
    assert!(content.contains("status: cancelled"));
    assert!(content.contains("(no final answer was produced)"));
}

#[tokio::test]
async fn redacted_answer_is_marked_incomplete() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    let instance = registry.instance_id().to_string();
    let secret = "sk-abcdefghijklmnopqrstuvwxyz";

    let result = run_one(
        registry,
        input(
            &instance,
            "req-redacted",
            &scenario(serde_json::json!({
                "scenario": "success",
                "text": format!("token {secret} end"),
            })),
            true,
        ),
    )
    .await;

    assert_eq!(result.status, TerminalStatus::Completed);
    assert!(result.redacted, "the token shape must be redacted");
    assert!(
        !result.output_complete,
        "redacted text is not a complete rendering of the original answer"
    );
    let output = result.worker_final_output.as_deref().expect("output");
    assert!(!output.contains(secret));
    assert!(output.contains("[REDACTED]"));

    let report_path = result.report_path.as_deref().expect("report published");
    let content = std::fs::read_to_string(report_path).expect("read report");
    assert!(content.contains("redacted: true"));
    assert!(content.contains("output_complete: false"));
    assert!(!content.contains(secret));
}

#[test]
fn native_diagnostics_redact_before_byte_limits() {
    const SECRET: &str = "SyntheticReviewCredential0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const LIMIT: usize = 128;
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let config_path = temp.path().join("bridge.json");
    std::fs::write(
        &config_path,
        serde_json::json!({
            "max_diagnostic_bytes": LIMIT,
            "results_dir": results,
            "workspaces": {"test": temp.path()},
            "secret_env": ["HB_TEST_SYNTHETIC_SECRET"],
            "adapters": {"codex": {
                "program": support::fake_worker(), "version": "0.165.0"
            }}
        })
        .to_string(),
    )
    .expect("write config");
    let mut server = support::McpProcess::start_command_with_env(
        Path::new(env!("CARGO_BIN_EXE_harness-bridge")),
        &[
            "--config".to_string(),
            config_path.to_str().unwrap().to_string(),
        ],
        &[("HB_TEST_SYNTHETIC_SECRET", SECRET)],
    );
    server.initialize();
    let health = support::call_tool(&mut server, "harness_health", serde_json::json!({}));
    let instance = support::tool_structured(&health)["instance_id"].clone();
    let scenarios = [
        // A native error crosses the diagnostic prefix limit.
        serde_json::json!({"message": format!("{}{SECRET} end", "x".repeat(LIMIT - 24))}),
        // The retained stderr tail starts in the middle of the secret.
        serde_json::json!({"stderr": format!("{SECRET}{}", "x".repeat(LIMIT - 24))}),
        // Only a built-in token shape is known; its marker was discarded.
        serde_json::json!({"stderr": format!("sk-SyntheticUnconfiguredTokenABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789{}", "x".repeat(LIMIT - 24))}),
        // Diagnostic redaction must preserve the native failure taxonomy.
        serde_json::json!({"stderr": format!("{} Failed to authenticate. sk-SyntheticUnconfiguredToken0123456789| detail", "x".repeat(LIMIT))}),
    ];
    for (index, scenario) in scenarios.into_iter().enumerate() {
        let accepted = support::call_tool(
            &mut server,
            "harness_submit",
            serde_json::json!({
                "instance_id": instance, "request_id": format!("redact-{index}"),
                "adapter":"codex", "workspace_id":"test",
                "prompt":scenario.to_string(), "save_result":true
            }),
        );
        let job = support::tool_structured(&accepted)["job_id"].clone();
        let waited = support::call_tool(
            &mut server,
            "harness_wait",
            serde_json::json!({"job_id":job}),
        );
        let result = &support::tool_structured(&waited)["result"];
        assert_eq!(result["status"], "failed");
        let message = result["error"]["message"]
            .as_str()
            .expect("failure diagnostic");
        assert!(message.len() <= LIMIT, "diagnostic remains bounded");
        assert!(
            !message.contains(&SECRET[..24]) && !message.contains(&SECRET[SECRET.len() - 24..]),
            "secret fragments must not escape the diagnostic boundary: {message}"
        );
        assert_eq!(result["redacted"], true);
        assert!(!message.contains("DEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
        if index == 3 {
            assert_eq!(result["error"]["code"], "AUTH_REQUIRED");
        }
        let report = std::fs::read_to_string(result["report_path"].as_str().unwrap()).unwrap();
        assert!(!report.contains(&SECRET[..24]));
        assert!(!report.contains(&SECRET[SECRET.len() - 24..]));
        assert!(report.contains("redacted: true"));
        assert!(!report.contains("DEFGHIJKLMNOPQRSTUVWXYZ0123456789"));
    }
    assert!(server.shutdown().success());
}

#[cfg(unix)]
#[tokio::test]
async fn replaced_report_ancestor_cannot_redirect_publication() {
    let temp = tempfile::tempdir().expect("temp dir");
    let parent = temp.path().join("parent");
    std::fs::create_dir(&parent).unwrap();
    let results = create_results(&parent);
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results),
        1,
    ))));
    let original = temp.path().join("original");
    let replacement = temp.path().join("replacement");
    std::fs::create_dir(&replacement).unwrap();
    create_results(&replacement);
    std::fs::rename(&parent, &original).unwrap();
    std::os::unix::fs::symlink(&replacement, &parent).unwrap();

    let result = run_one(
        registry.clone(),
        input(registry.instance_id(), "replaced-ancestor", "success", true),
    )
    .await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(result.worker_final_output.as_deref(), Some("OK"));
    assert_eq!(result.report_error.as_deref(), Some("REPORT_WRITE_FAILED"));
    assert!(result.report_path.is_none());
    assert!(entries(&replacement.join("results")).is_empty());
    assert!(entries(&original.join("results")).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn replaced_real_results_directory_is_rejected() {
    let temp = tempfile::tempdir().expect("temp dir");
    let results = create_results(temp.path());
    let registry = Arc::new(Registry::new(Arc::new(config(
        temp.path(),
        Some(results.clone()),
        1,
    ))));
    let original = temp.path().join("original");
    std::fs::rename(&results, &original).unwrap();
    std::fs::create_dir(&results).unwrap();
    let result = run_one(
        registry.clone(),
        input(
            registry.instance_id(),
            "replaced-directory",
            "success",
            true,
        ),
    )
    .await;
    assert_eq!(result.status, TerminalStatus::Completed);
    assert_eq!(result.report_error.as_deref(), Some("REPORT_WRITE_FAILED"));
    assert!(entries(&results).is_empty());
    assert!(entries(&original).is_empty());
}
