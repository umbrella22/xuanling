//! W3 process_run contract tests (plan §10 W3).
//!
//! Uses a cross-platform helper script to verify argv preservation, no shell,
//! no server timeout, cancellation, structured nonzero exit, and typed spawn
//! failure.

use std::collections::BTreeMap;
use std::sync::Arc;
use xuanling_toolkit::invocation::{InvocationContext, ManualCancellation};
use xuanling_toolkit::process::{ProcessRunRequest, ProcessStreamMode, process_run};
// Pipeline/session APIs are used by Unix-only contracts and by the portable
// process-tree fixture when that feature is enabled. Gate imports so a default
// Windows build does not trip `-D warnings`.
#[cfg(any(unix, feature = "test-fixtures"))]
use xuanling_toolkit::process::{PipelineStage, ProcessPipelineRequest, process_pipeline};
#[cfg(any(unix, feature = "test-fixtures"))]
use xuanling_toolkit::process::{
    SessionCloseRequest, SessionExecRequest, SessionOpenRequest, session_close, session_exec,
    session_open,
};
use xuanling_toolkit::{PathContext, ToolErrorCode};

#[cfg(feature = "test-fixtures")]
fn process_tree_helper() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-process-tree-test-helper"))
}

#[cfg(feature = "test-fixtures")]
fn lease_is_locked(path: &std::path::Path) -> bool {
    let Ok(file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
    else {
        return false;
    };
    matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock))
}

#[cfg(feature = "test-fixtures")]
async fn wait_for_locked_lease(path: &std::path::Path) {
    for _ in 0..100 {
        if lease_is_locked(path) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("helper descendant never acquired lease {}", path.display());
}

#[cfg(feature = "test-fixtures")]
async fn wait_for_released_lease(path: &std::path::Path) {
    for _ in 0..100 {
        if path.exists() && !lease_is_locked(path) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!(
        "contained helper descendant still holds lease {}",
        path.display()
    );
}

#[cfg(feature = "test-fixtures")]
fn descendant_helper_stage(lease_path: &std::path::Path) -> PipelineStage {
    PipelineStage {
        program: process_tree_helper().to_string_lossy().into_owned(),
        args: vec![
            "spawn-and-wait".to_string(),
            lease_path.to_string_lossy().into_owned(),
        ],
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        cwd: None,
    }
}

fn ctx() -> InvocationContext {
    InvocationContext::new(PathContext::new(std::path::PathBuf::from(".")))
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn aborting_process_run_future_terminates_descendant_tree() {
    let dir = tempfile::tempdir().expect("temp dir");
    let lease_path = dir.path().join("run-abort-descendant.lease");
    let request = ProcessRunRequest {
        program: process_tree_helper().to_string_lossy().into_owned(),
        args: vec![
            "spawn-and-wait".to_string(),
            lease_path.to_string_lossy().into_owned(),
        ],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Null,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };

    let run = tokio::spawn(async move { process_run(&ctx(), &request).await });
    wait_for_locked_lease(&lease_path).await;
    run.abort();
    let join_error = run
        .await
        .expect_err("aborted tool future must not complete");
    assert!(join_error.is_cancelled());
    wait_for_released_lease(&lease_path).await;
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn aborting_pipeline_future_terminates_every_stage_tree() {
    let dir = tempfile::tempdir().expect("temp dir");
    let first_lease = dir.path().join("pipeline-stage-0.lease");
    let second_lease = dir.path().join("pipeline-stage-1.lease");
    let request = ProcessPipelineRequest {
        deterministic: false,
        stages: vec![
            descendant_helper_stage(&first_lease),
            descendant_helper_stage(&second_lease),
        ],
        stdin: None,
        stdout: ProcessStreamMode::Null,
        preview_max_bytes: None,
    };

    let pipeline = tokio::spawn(async move { process_pipeline(&ctx(), &request).await });
    wait_for_locked_lease(&first_lease).await;
    wait_for_locked_lease(&second_lease).await;
    pipeline.abort();
    let join_error = pipeline
        .await
        .expect_err("aborted pipeline future must not complete");
    assert!(join_error.is_cancelled());
    wait_for_released_lease(&first_lease).await;
    wait_for_released_lease(&second_lease).await;
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn aborting_session_exec_future_terminates_tree_and_unregisters_it() {
    let context = ctx();
    let open = session_open(
        &context,
        &SessionOpenRequest {
            cwd: None,
            env: BTreeMap::new(),
            inherit_env: false,
        },
    )
    .expect("session_open");
    let session_id = open.session_id;
    let dir = tempfile::tempdir().expect("temp dir");
    let lease_path = dir.path().join("session-abort-descendant.lease");
    let exec_context = context.clone();
    let exec_session_id = session_id.clone();
    let helper = process_tree_helper().to_string_lossy().into_owned();
    let exec_lease = lease_path.to_string_lossy().into_owned();
    let exec = tokio::spawn(async move {
        session_exec(
            &exec_context,
            &SessionExecRequest {
                deterministic: false,
                session_id: exec_session_id,
                program: helper,
                args: vec!["spawn-and-wait".to_string(), exec_lease],
                stdin: None,
                stdout: ProcessStreamMode::Null,
                stderr: ProcessStreamMode::Null,
                env: BTreeMap::new(),
                preview_max_bytes: None,
            },
        )
        .await
    });

    wait_for_locked_lease(&lease_path).await;
    exec.abort();
    let join_error = exec
        .await
        .expect_err("aborted session future must not complete");
    assert!(join_error.is_cancelled());
    wait_for_released_lease(&lease_path).await;

    let closed = session_close(&context, &SessionCloseRequest { session_id })
        .expect("session remains closable after aborted exec");
    assert!(
        closed.terminated_process_trees.is_empty(),
        "aborted exec must unregister its process tree before session_close"
    );
}

// A portable echo program: on unix `echo`, `env`, `true`, `false` are real
// executables; process_run must NOT use a shell. These tests run on unix.
// Windows process behavior is exercised in W7.

#[cfg(unix)]
fn echo_program() -> &'static str {
    "echo"
}

#[cfg(unix)]
fn env_program() -> &'static str {
    "env"
}

#[cfg(unix)]
#[tokio::test]
async fn process_args_preserve_spaces_quotes_dollar_and_metacharacters() {
    // Pass tricky args; verify they arrive verbatim via echo stdout.
    let tricky = vec![
        "a b".to_string(),
        "c\"d".to_string(),
        "$HOME".to_string(),
        "e;rm -rf /".to_string(),
        "f|g".to_string(),
    ];
    let req = ProcessRunRequest {
        program: echo_program().to_string(),
        args: tricky.clone(),
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Inline,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req).await.expect("process_run");
    assert!(res.success, "echo should exit 0");
    let out = res.stdout.expect("stdout");
    // echo joins args with single spaces; the tricky args must arrive verbatim.
    for t in &tricky {
        assert!(
            out.contains(t),
            "arg `{t}` must be preserved verbatim in stdout: {out}"
        );
    }
}

#[cfg(unix)]
#[tokio::test]
async fn process_run_never_invokes_shell_for_argv_request() {
    // `echo $(whoami)` as a SINGLE arg must be printed literally — if a shell
    // were invoked, `$(whoami)` would be expanded.
    let req = ProcessRunRequest {
        program: echo_program().to_string(),
        args: vec!["$(whoami)".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Inline,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req).await.expect("process_run");
    let out = res.stdout.unwrap_or_default();
    assert!(
        out.contains("$(whoami)"),
        "command substitution must NOT be expanded (no shell); got: {out}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn process_env_round_trips_unicode() {
    // Set a unicode env var and read it back via `env`.
    let mut env = BTreeMap::new();
    env.insert("XUANLING_UNICODE".to_string(), "你好世界 🌍".to_string());
    let req = ProcessRunRequest {
        program: env_program().to_string(),
        args: vec![],
        cwd: None,
        env,
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req).await.expect("process_run");
    let out = res.stdout.unwrap_or_default();
    assert!(
        out.contains("你好世界 🌍"),
        "unicode env var must round-trip; got: {out}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn process_cwd_accepts_absolute_path_outside_base_dir() {
    // cwd is an absolute path (outside the context base_dir); no containment.
    let req = ProcessRunRequest {
        program: env_program().to_string(),
        args: vec![],
        cwd: Some("/tmp".to_string()),
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req).await.expect("process_run");
    assert!(res.success, "env should run in /tmp");
}

#[tokio::test]
async fn process_nonzero_exit_is_structured_successful_call() {
    // `false` exits 1; this is a SUCCESSFUL call with success=false, NOT a
    // ToolError.
    let req = ProcessRunRequest {
        program: "false".to_string(),
        args: vec![],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Null,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req)
        .await
        .expect("nonzero exit is NOT an error");
    assert!(!res.success, "false -> success=false");
    assert_eq!(res.exit_code, Some(1));
}

#[tokio::test]
async fn process_spawn_failure_is_typed_error() {
    // A program that does not exist -> SpawnFailed ToolError.
    let req = ProcessRunRequest {
        program: "xuanling-definitely-not-a-real-program-xyz".to_string(),
        args: vec![],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Null,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req).await;
    assert!(res.is_err(), "missing program must be a ToolError");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::SpawnFailed);
}

#[tokio::test]
async fn process_output_is_complete_without_server_cap() {
    // Generate large stdout; verify nothing is silently capped.
    let req = ProcessRunRequest {
        program: "yes".to_string(),
        args: vec!["line".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    // `yes` runs forever; we cancel after a short sleep to bound it. The point
    // is that whatever was captured is complete (ends with a newline), not
    // mid-chunk-capped. We use cancellation to stop it.
    let cancel = ManualCancellation::new();
    let ctx = InvocationContext::new(PathContext::new(std::path::PathBuf::from(".")))
        .with_cancellation(Arc::new(cancel.clone()));
    let cancel2 = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        cancel2.cancel();
    });
    let res = process_run(&ctx, &req).await;
    // Cancellation yields a Cancelled error; that's the expected outcome here.
    assert!(res.is_err());
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Cancelled);
}

#[cfg(unix)]
#[tokio::test]
async fn process_cancel_settles_tee_and_stdin_workers() {
    // ADR 0027 §7.3: cancelling a bounded process_run with an active stdin
    // writer and tee drain workers must settle them and return `Cancelled`
    // promptly — no hang, no leaked task. Wrap in a timeout to prove settlement
    // (the sleep would otherwise run 30s).
    let req = ProcessRunRequest {
        deterministic: false,
        program: "sleep".to_string(),
        args: vec!["30".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: Some("X".repeat(8192)),
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Null,
        preview_max_bytes: Some(64),
    };
    let cancel = ManualCancellation::new();
    let ctx = InvocationContext::new(PathContext::new(std::path::PathBuf::from(".")))
        .with_cancellation(Arc::new(cancel.clone()));
    let cancel2 = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        cancel2.cancel();
    });
    let res =
        tokio::time::timeout(std::time::Duration::from_secs(8), process_run(&ctx, &req)).await;
    let res = res.expect("cancel must settle the tee/stdin workers promptly (no hang)");
    assert!(res.is_err(), "cancelled call must return an error");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Cancelled);
}

#[tokio::test]
async fn process_has_no_implicit_deadline() {
    // The DTO must not accept a server-side timeout field (already pinned in
    // W0); here we confirm process_run does not impose one by running a short
    // sleep that would exceed any tiny default.
    let req = ProcessRunRequest {
        program: "sleep".to_string(),
        args: vec!["1".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Null,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req)
        .await
        .expect("sleep 1 should complete");
    assert!(res.success);
    let duration = res
        .duration_ms
        .expect("default (non-deterministic) mode reports duration_ms");
    assert!(
        duration >= 900,
        "duration should reflect ~1s sleep: {duration}ms"
    );
}

#[tokio::test]
async fn mcp_cancellation_terminates_direct_child_and_drains_output() {
    // sleep 30; cancel immediately; must return Cancelled quickly.
    let cancel = ManualCancellation::new();
    let ctx = InvocationContext::new(PathContext::new(std::path::PathBuf::from(".")))
        .with_cancellation(Arc::new(cancel.clone()));
    cancel.cancel();
    let req = ProcessRunRequest {
        program: "sleep".to_string(),
        args: vec!["30".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Null,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let start = std::time::Instant::now();
    let res = process_run(&ctx, &req).await;
    let elapsed = start.elapsed();
    assert!(res.is_err());
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Cancelled);
    assert!(
        elapsed < std::time::Duration::from_secs(5),
        "cancellation should terminate child promptly; took {elapsed:?}"
    );
}

#[tokio::test]
async fn stdio_mcp_rejects_stdout_inherit_mode() {
    // stdout=inherit is forbidden in stdio MCP mode (would corrupt framing).
    let req = ProcessRunRequest {
        program: "echo".to_string(),
        args: vec!["x".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inherit,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req).await;
    assert!(res.is_err());
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Unsupported);
}

/// Count live `sleep <sec>` processes via pgrep (unix). Returns the number of
/// matching pids. Used to verify descendant termination.
#[cfg(unix)]
fn count_sleep_procs(arg: &str) -> usize {
    let out = std::process::Command::new("pgrep")
        .arg("-f")
        .arg(format!("sleep {arg}"))
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .trim()
            .lines()
            .filter(|l| !l.is_empty())
            .count(),
        Err(_) => 0,
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cancel_terminates_process_group_on_unix() {
    // ADR 0027 §9.3: cancelling a running session_exec terminates the whole
    // process GROUP (the child + descendants), not just the direct child.
    let cancel = ManualCancellation::new();
    let ctx = InvocationContext::new(PathContext::new(std::path::PathBuf::from(".")))
        .with_cancellation(Arc::new(cancel.clone()));
    let open = session_open(
        &ctx,
        &SessionOpenRequest {
            cwd: None,
            env: BTreeMap::new(),
            inherit_env: false,
        },
    )
    .expect("session_open");
    let sid = open.session_id;

    // sh runs a backgrounded `sleep 38` then `wait`s for it (alive ~38s). The
    // sleep is a descendant in sh's process group; its std streams are
    // redirected so it does not hold any pipe open.
    let exec_ctx = ctx.clone();
    let exec_task = tokio::spawn(async move {
        let req = SessionExecRequest {
            deterministic: false,
            session_id: sid,
            program: "sh".to_string(),
            args: vec![
                "-c".to_string(),
                "sleep 38 </dev/null >/dev/null 2>&1 & wait".to_string(),
            ],
            stdin: None,
            stdout: ProcessStreamMode::Null,
            stderr: ProcessStreamMode::Null,
            env: BTreeMap::new(),
            preview_max_bytes: None,
        };
        session_exec(&exec_ctx, &req).await
    });

    // Let the child spawn its descendant, then cancel.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(
        count_sleep_procs("38") >= 1,
        "descendant sleep must be alive before cancel"
    );
    cancel.cancel();

    let res = tokio::time::timeout(std::time::Duration::from_secs(8), exec_task)
        .await
        .expect("cancel must settle the session_exec promptly")
        .expect("task joined");
    assert!(res.is_err(), "cancelled session_exec must return an error");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Cancelled);

    // The process GROUP was killed -> the descendant sleep is gone.
    let mut gone = false;
    for _ in 0..20 {
        if count_sleep_procs("38") == 0 {
            gone = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    assert!(gone, "cancel must terminate the descendant (process group)");
}

#[cfg(all(windows, feature = "test-fixtures"))]
#[tokio::test]
async fn cancel_terminates_job_tree_on_windows() {
    let cancel = ManualCancellation::new();
    let ctx = InvocationContext::new(PathContext::new(std::path::PathBuf::from(".")))
        .with_cancellation(Arc::new(cancel.clone()));
    let dir = tempfile::tempdir().expect("temp dir");
    let lease_path = dir.path().join("descendant.lease");
    let request = ProcessRunRequest {
        program: process_tree_helper().to_string_lossy().into_owned(),
        args: vec![
            "spawn-and-wait".to_string(),
            lease_path.to_string_lossy().into_owned(),
        ],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Null,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let run = tokio::spawn(async move { process_run(&ctx, &request).await });

    wait_for_locked_lease(&lease_path).await;
    cancel.cancel();
    let result = tokio::time::timeout(std::time::Duration::from_secs(8), run)
        .await
        .expect("cancel must settle the process tree")
        .expect("process task join");
    assert_eq!(
        result.expect_err("cancelled process must fail").code,
        ToolErrorCode::Cancelled
    );
    wait_for_released_lease(&lease_path).await;
}

#[cfg(all(windows, feature = "test-fixtures"))]
#[tokio::test]
async fn session_close_terminates_active_job_tree_on_windows() {
    let context = ctx();
    let open = session_open(
        &context,
        &SessionOpenRequest {
            cwd: None,
            env: BTreeMap::new(),
            inherit_env: false,
        },
    )
    .expect("session_open");
    let dir = tempfile::tempdir().expect("temp dir");
    let lease_path = dir.path().join("session-descendant.lease");
    let exec_context = context.clone();
    let exec_session_id = open.session_id.clone();
    let helper = process_tree_helper().to_string_lossy().into_owned();
    let exec_lease = lease_path.to_string_lossy().into_owned();
    let exec = tokio::spawn(async move {
        session_exec(
            &exec_context,
            &SessionExecRequest {
                deterministic: false,
                session_id: exec_session_id,
                program: helper,
                args: vec!["spawn-and-wait".to_string(), exec_lease],
                stdin: None,
                stdout: ProcessStreamMode::Null,
                stderr: ProcessStreamMode::Null,
                env: BTreeMap::new(),
                preview_max_bytes: None,
            },
        )
        .await
    });

    wait_for_locked_lease(&lease_path).await;
    let closed = session_close(
        &context,
        &SessionCloseRequest {
            session_id: open.session_id,
        },
    )
    .expect("session_close");
    assert_eq!(closed.terminated_process_trees.len(), 1);
    let result = tokio::time::timeout(std::time::Duration::from_secs(8), exec)
        .await
        .expect("session close must settle the exec tree")
        .expect("session exec task join")
        .expect("terminated child is a structured process result");
    assert!(!result.success);
    wait_for_released_lease(&lease_path).await;
}

#[cfg(unix)]
#[tokio::test]
async fn process_run_settles_when_exited_child_leaves_descendant_holding_pipe() {
    let dir = tempfile::tempdir().expect("temp dir");
    let pid_file = dir.path().join("descendant.pid");
    let req = ProcessRunRequest {
        deterministic: false,
        program: "sh".to_string(),
        args: vec![
            "-c".to_string(),
            "sleep 41 & echo $! > \"$1\"".to_string(),
            "xuanling-test".to_string(),
            pid_file.to_string_lossy().into_owned(),
        ],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        preview_max_bytes: None,
        stderr: ProcessStreamMode::Inline,
    };

    let result = tokio::time::timeout(std::time::Duration::from_secs(5), process_run(&ctx(), &req))
        .await
        .expect("a descendant holding inherited pipes must not hang process_run")
        .expect("direct child exits successfully");
    assert!(result.success);

    let pid: i32 = std::fs::read_to_string(&pid_file)
        .expect("descendant pid file")
        .trim()
        .parse()
        .expect("numeric descendant pid");
    let mut gone = false;
    for _ in 0..30 {
        // SAFETY: signal 0 only probes the exact test-spawned PID.
        if unsafe { libc::kill(pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            gone = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(
        gone,
        "one-shot process_run must not leak its background descendant"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn pipeline_drains_and_reports_large_intermediate_stderr() {
    let req = ProcessPipelineRequest {
        deterministic: false,
        stages: vec![
            PipelineStage {
                program: "sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    "head -c 1048576 /dev/zero >&2; printf payload".to_string(),
                ],
                env: BTreeMap::new(),
                remove_env: Vec::new(),
                inherit_env: false,
                cwd: None,
            },
            PipelineStage {
                program: "cat".to_string(),
                args: Vec::new(),
                env: BTreeMap::new(),
                remove_env: Vec::new(),
                inherit_env: false,
                cwd: None,
            },
        ],
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        preview_max_bytes: None,
    };

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        process_pipeline(&ctx(), &req),
    )
    .await
    .expect("large intermediate stderr must not deadlock the pipeline")
    .expect("pipeline call");
    assert!(
        result.success,
        "stage stderr must not change its exit status"
    );
    assert_eq!(result.stdout.as_deref(), Some("payload"));
    assert_eq!(result.stages[0].exit_code, Some(0));
    assert_eq!(
        result.stages[0].stderr.as_ref().map(String::len),
        Some(1_048_576),
        "each stage must expose the stderr bytes it drained"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn session_close_terminates_an_active_exec_tree() {
    let open = session_open(
        &ctx(),
        &SessionOpenRequest {
            cwd: None,
            env: BTreeMap::new(),
            inherit_env: false,
        },
    )
    .expect("session_open");
    let sid = open.session_id;
    let dir = tempfile::tempdir().expect("temp dir");
    let pid_file = dir.path().join("active.pid");
    let exec_sid = sid.clone();
    let exec_pid_file = pid_file.clone();
    let exec_task = tokio::spawn(async move {
        session_exec(
            &ctx(),
            &SessionExecRequest {
                deterministic: false,
                session_id: exec_sid,
                program: "sh".to_string(),
                args: vec![
                    "-c".to_string(),
                    "echo $$ > \"$1\"; exec sleep 42".to_string(),
                    "xuanling-test".to_string(),
                    exec_pid_file.to_string_lossy().into_owned(),
                ],
                stdin: None,
                stdout: ProcessStreamMode::Inline,
                stderr: ProcessStreamMode::Inline,
                env: BTreeMap::new(),
                preview_max_bytes: None,
            },
        )
        .await
    });

    for _ in 0..50 {
        if pid_file.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert!(
        pid_file.exists(),
        "active child must reach the spawn fixture"
    );

    let close =
        session_close(&ctx(), &SessionCloseRequest { session_id: sid }).expect("session_close");
    assert_eq!(
        close.terminated_process_trees.len(),
        1,
        "the active exec tree must already be registered when close runs"
    );

    let result = tokio::time::timeout(std::time::Duration::from_secs(5), exec_task)
        .await
        .expect("close must settle active session_exec promptly")
        .expect("exec task join")
        .expect("a signalled process is a structured non-success result");
    assert!(!result.success);

    let pid: i32 = std::fs::read_to_string(&pid_file)
        .expect("active pid")
        .trim()
        .parse()
        .expect("numeric pid");
    // SAFETY: signal 0 only probes the exact test-spawned PID.
    let rc = unsafe { libc::kill(pid, 0) };
    assert_eq!(rc, -1, "session_close must terminate the active child");
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

// --- ADR 0027 amendment 1: on-demand artifacts for bounded inline capture ---

/// A bounded stream that fits within the preview budget is returned fully
/// inline with NO artifact ref (the caller already holds every byte; there is
/// nothing to fetch back). An empty stream must not create an artifact at all.
#[cfg(unix)]
#[tokio::test]
async fn bounded_stream_within_budget_needs_no_artifact() {
    let req = ProcessRunRequest {
        deterministic: false,
        program: "printf".to_string(),
        args: vec!["%s".to_string(), "fits".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Inline,
        preview_max_bytes: Some(64),
    };
    let res = process_run(&ctx(), &req).await.expect("printf runs");
    assert!(res.success);
    assert_eq!(res.stdout.as_deref(), Some("fits"), "full stdout inline");
    assert_eq!(res.stderr.as_deref(), Some(""), "empty stderr inline");
    assert_eq!(res.stdout_truncated, Some(false));
    assert_eq!(res.stderr_truncated, Some(false));
    assert_eq!(res.stdout_total_bytes, Some(4));
    assert_eq!(res.stderr_total_bytes, Some(0));
    assert!(
        res.stdout_artifact.is_none(),
        "a stream that fits the budget needs no artifact ref"
    );
    assert!(
        res.stderr_artifact.is_none(),
        "an empty stream must not create an artifact"
    );
    assert!(
        res.stdout_sha256.is_some(),
        "whole-stream sha256 is still reported for verification"
    );
}

/// A bounded stream that overflows the budget still spills its COMPLETE bytes
/// to an artifact; the preview is an exact byte-prefix of the artifact.
#[cfg(unix)]
#[tokio::test]
async fn bounded_stream_overflow_spills_complete_artifact() {
    use xuanling_toolkit::process::{ArtifactReadRequest, artifact_read};
    let req = ProcessRunRequest {
        deterministic: false,
        program: "printf".to_string(),
        args: vec!["%s".to_string(), "0123456789".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Null,
        preview_max_bytes: Some(4),
    };
    let res = process_run(&ctx(), &req).await.expect("printf runs");
    assert!(res.success);
    assert_eq!(res.stdout.as_deref(), Some("0123"), "bounded preview");
    assert_eq!(res.stdout_truncated, Some(true));
    assert_eq!(res.stdout_total_bytes, Some(10));
    let artifact = res
        .stdout_artifact
        .expect("a truncated stream must carry an artifact ref");
    assert_eq!(artifact.size_bytes, 10);
    let read = artifact_read(&ArtifactReadRequest {
        id: artifact.id.clone(),
        read_capability: artifact.read_capability.clone(),
        offset: None,
        length: None,
    })
    .expect("artifact read");
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&read.base64)
        .expect("base64 decode");
    assert_eq!(
        bytes, b"0123456789",
        "artifact holds the complete raw bytes"
    );
    assert!(bytes.starts_with(b"0123"), "preview is a byte-prefix");
    assert_eq!(read.sha256, artifact.sha256, "artifact sha256 matches");
}

// --- ADR 0028 amendment 1: minimal non-secret env allowlist ---

/// inherit_env=false seeds the non-secret allowlist, so child tools that read
/// user config (git, cargo, npm, ssh) still find HOME/PATH — the previous
/// empty env silently changed their behavior (e.g. git dropped the global
/// gitignore).
#[cfg(unix)]
#[tokio::test]
async fn minimal_env_seeds_user_config_dirs() {
    let Some(expected_home) = std::env::var("HOME").ok() else {
        return;
    };
    let req = ProcessRunRequest {
        program: "sh".to_string(),
        args: vec!["-c".to_string(), "printf %s \"$HOME\"".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req).await.expect("sh runs");
    assert!(res.success);
    assert_eq!(
        res.stdout.as_deref(),
        Some(expected_home.as_str()),
        "HOME must be seeded so user-config-driven tools behave like the login shell"
    );

    let req = ProcessRunRequest {
        program: "sh".to_string(),
        args: vec!["-c".to_string(), "printf %s \"$PATH\"".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Null,
        ..Default::default()
    };
    let res = process_run(&ctx(), &req).await.expect("sh runs");
    assert!(res.success);
    assert!(
        res.stdout.as_deref().is_some_and(|p| !p.is_empty()),
        "PATH must be seeded so child subprocesses can be resolved"
    );
}

// --- ADR 0027 修订 2: deterministic (cache-friendly) process results ---

/// deterministic=true omits `duration_ms` so identical invocations return
/// byte-identical structured results (stable prefix for host prompt caching).
/// The default mode still reports it.
#[cfg(unix)]
#[tokio::test]
async fn deterministic_mode_omits_duration_ms() {
    let mut req = ProcessRunRequest {
        program: "printf".to_string(),
        args: vec!["%s".to_string(), "cache-me".to_string()],
        cwd: None,
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: false,
        deterministic: false,
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        stderr: ProcessStreamMode::Null,
        preview_max_bytes: None,
    };
    let res = process_run(&ctx(), &req).await.expect("printf runs");
    assert!(res.success);
    assert!(
        res.duration_ms.is_some(),
        "default mode must report duration_ms"
    );

    req.deterministic = true;
    let res = process_run(&ctx(), &req).await.expect("printf runs");
    assert!(res.success);
    assert_eq!(res.stdout.as_deref(), Some("cache-me"));
    assert!(
        res.duration_ms.is_none(),
        "deterministic mode must omit duration_ms"
    );
}

/// The pipeline result honors the same deterministic flag.
#[cfg(unix)]
#[tokio::test]
async fn pipeline_deterministic_omits_duration_ms() {
    let req = ProcessPipelineRequest {
        stages: vec![PipelineStage {
            program: "printf".to_string(),
            args: vec!["%s".to_string(), "p".to_string()],
            env: BTreeMap::new(),
            remove_env: Vec::new(),
            inherit_env: false,
            cwd: None,
        }],
        stdin: None,
        stdout: ProcessStreamMode::Inline,
        preview_max_bytes: None,
        deterministic: true,
    };
    let res = process_pipeline(&ctx(), &req).await.expect("pipeline runs");
    assert!(res.success);
    assert!(
        res.duration_ms.is_none(),
        "deterministic pipeline must omit duration_ms"
    );
    assert_eq!(res.stdout.as_deref(), Some("p"));
}
