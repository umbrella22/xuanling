//! `process_run` — argv-only child process execution (plan §7.3).
//!
//! Uses `tokio::process::Command` with explicit argv. No shell, no server-side
//! timeout. MCP cancellation terminates the complete descendant process tree;
//! residual descendants are also cleaned up after direct-child exit.
//! stdout/stderr reader tasks drain concurrently with child wait. A nonzero
//! exit is a *successful* call (`success=false`), not a `ToolError`.

use std::collections::BTreeMap;
use std::time::Instant;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;
use crate::process::ProcessStreamMode;
use crate::process::artifact::{ArtifactRef, ArtifactWriter};
use crate::process::tree::{self, AbortOnDrop, ProcessTree, ProcessTreeGuard};

/// `process_run` request (plan §7.3). NO shell-string field, NO server timeout.
#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProcessRunRequest {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub remove_env: Vec<String>,
    #[serde(default)]
    pub inherit_env: bool,
    /// Cache-friendly mode (ADR 0027 修订 2): when true, `duration_ms` is
    /// omitted from the result so identical invocations return byte-identical
    /// results (stable prefix for host prompt caching). The child's own output
    /// is not made deterministic, and truncated results still embed
    /// per-invocation artifact refs (ADR 0027 §6).
    #[serde(default)]
    pub deterministic: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    #[serde(default)]
    pub stdout: ProcessStreamMode,
    #[serde(default)]
    pub stderr: ProcessStreamMode,
    /// Per-stream preview byte budget (ADR 0027 §7.1 + amendment 1). When set
    /// and the stream is `inline`, a bounded preview is surfaced in the result;
    /// a stream that overflows the budget additionally spills its COMPLETE raw
    /// bytes to an immutable artifact referenced by `stdout_artifact`/
    /// `stderr_artifact` (a stream that fits within budget needs no artifact).
    /// `0` is a legal metadata-only window (empty preview, full artifact).
    /// `None` = current full-inline behavior (no artifact).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_max_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct ProcessRunResult {
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_path: Option<String>,
    /// Wall-clock duration of the invocation. Omitted when `deterministic=true`
    /// (ADR 0027 修订 2) because it varies on every call and breaks exact
    /// prompt-cache prefixes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    // Bounded-preview + artifact fields (ADR 0027 §7.1). Present only when
    // `preview_max_bytes` was set and the stream was inline. The preview sits in
    // `stdout`/`stderr`; these describe the per-stream window + artifact ref.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_artifact: Option<ArtifactRef>,
    /// Exact raw stdout bytes included in the preview. The display string can
    /// be longer if invalid UTF-8 needs replacement characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_preview_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_preview_lossy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_artifact: Option<ArtifactRef>,
    /// Exact raw stderr bytes included in the preview. The display string can
    /// be longer if invalid UTF-8 needs replacement characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_preview_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_preview_lossy: Option<bool>,
}

/// Non-secret environment variables seeded into a child when `inherit_env` is
/// false (ADR 0028 amendment 1). These locate the user's config and temp state
/// so child tools (git, cargo, npm, ssh host programs) behave like the user's
/// shell WITHOUT inheriting arbitrary credentials (tokens, keys, sockets) held
/// by the server process. Credential channels such as `SSH_AUTH_SOCK` and any
/// `*_TOKEN`/`*_KEY` are deliberately excluded; callers opt in explicitly via
/// `env` or `inherit_env=true`.
const MINIMAL_ENV_ALLOWLIST: &[&str] = &[
    // Shared across both families.
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    // Windows-specific (ignored where they do not exist).
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LOCALAPPDATA",
    "APPDATA",
    "COMSPEC",
    "PATHEXT",
    "OS",
    "PROCESSOR_ARCHITECTURE",
];

/// Build a child env: seed the current env (`inherit=true`) or the minimal
/// non-secret allowlist (`inherit=false`), then apply/override with `env`,
/// then remove `remove_env`. On Windows env keys are case-folded so an
/// override replaces the matching inherited key regardless of case.
pub(super) fn build_env(
    inherit: bool,
    env: &BTreeMap<String, String>,
    remove_env: &[String],
) -> Vec<(String, String)> {
    let mut map: BTreeMap<String, String> = BTreeMap::new();
    if inherit {
        for (k, v) in std::env::vars() {
            map.insert(case_key(&k), v);
        }
    } else {
        let allowlist: Vec<String> = MINIMAL_ENV_ALLOWLIST
            .iter()
            .map(|name| case_key(name))
            .collect();
        for (k, v) in std::env::vars() {
            let key = case_key(&k);
            if allowlist.contains(&key) {
                map.insert(key, v);
            }
        }
    }
    for (k, v) in env {
        map.insert(case_key(k), v.clone());
    }
    for k in remove_env {
        map.remove(&case_key(k));
    }
    map.into_iter().collect()
}

/// On Windows, fold env keys to uppercase for case-insensitive merge. Elsewhere
/// keep the key as-is (case-sensitive).
fn case_key(k: &str) -> String {
    if cfg!(target_os = "windows") {
        k.to_ascii_uppercase()
    } else {
        k.to_string()
    }
}

/// Translate a [`ProcessStreamMode`] into the std::process::Stdio piped setting
/// and detect the stdio-MCP-forbidden stdout-inherit case.
fn check_stream_modes(
    stdout: &ProcessStreamMode,
    stderr: &ProcessStreamMode,
) -> Result<(), ToolError> {
    // stdio MCP mode: stdout=inherit would pollute the protocol framing channel.
    if matches!(stdout, ProcessStreamMode::Inherit) {
        return Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "process.run",
            "stdout=inherit is unsupported in stdio MCP mode (would corrupt protocol framing)",
        ));
    }
    let _ = stderr;
    Ok(())
}

pub(super) fn resolve_stream_mode(
    ctx: &InvocationContext,
    mode: &ProcessStreamMode,
    operation: &str,
) -> Result<ProcessStreamMode, ToolError> {
    match mode {
        ProcessStreamMode::File { path } => {
            let resolved = ctx.resolve_path(
                std::path::Path::new(path),
                None,
                PathAccess::Write,
                operation,
            )?;
            Ok(ProcessStreamMode::File {
                path: resolved.to_string_lossy().into_owned(),
            })
        }
        other => Ok(other.clone()),
    }
}

/// Resolve the effective child cwd without turning an unrestricted invocation
/// into an implicit policy boundary. In workspace-contained mode an omitted
/// cwd must not inherit the MCP server's own cwd, which may be outside the
/// capability; use the invocation's path context instead. Unrestricted calls
/// retain the established process-cwd inheritance behavior.
pub(super) fn contained_default_cwd(
    ctx: &InvocationContext,
    operation: &str,
) -> Result<Option<std::path::PathBuf>, ToolError> {
    if !ctx.filesystem_scope().is_contained() {
        return Ok(None);
    }
    ctx.resolve_path(
        std::path::Path::new("."),
        None,
        PathAccess::ProcessCwd,
        operation,
    )
    .map(Some)
}

pub async fn process_run(
    ctx: &InvocationContext,
    req: &ProcessRunRequest,
) -> Result<ProcessRunResult, ToolError> {
    check_stream_modes(&req.stdout, &req.stderr)?;

    let mut cmd = tokio::process::Command::new(&req.program);
    cmd.args(&req.args);

    // A workspace scope validates cwd but does not sandbox the program.
    let cwd = if let Some(cwd) = &req.cwd {
        Some(ctx.resolve_path(
            std::path::Path::new(cwd),
            None,
            PathAccess::ProcessCwd,
            "process.run",
        )?)
    } else {
        contained_default_cwd(ctx, "process.run")?
    };
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    // env handling.
    let env_vec = build_env(req.inherit_env, &req.env, &req.remove_env);
    cmd.env_clear();
    for (k, v) in &env_vec {
        cmd.env(k, v);
    }

    // stdin
    if req.stdin.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    // stdout
    let stdout_mode = resolve_stream_mode(ctx, &req.stdout, "process.run.stdout")?;
    cmd.stdout(match &stdout_mode {
        ProcessStreamMode::Inline | ProcessStreamMode::File { .. } => std::process::Stdio::piped(),
        ProcessStreamMode::Inherit => std::process::Stdio::inherit(),
        ProcessStreamMode::Null => std::process::Stdio::null(),
    });
    // stderr
    let stderr_mode = resolve_stream_mode(ctx, &req.stderr, "process.run.stderr")?;
    cmd.stderr(match &stderr_mode {
        ProcessStreamMode::Inline | ProcessStreamMode::File { .. } => std::process::Stdio::piped(),
        ProcessStreamMode::Inherit => std::process::Stdio::inherit(),
        ProcessStreamMode::Null => std::process::Stdio::null(),
    });

    // Kill the child on drop so a dropped handle (e.g. after cancellation)
    // does not leak a running process.
    cmd.kill_on_drop(true);
    tree::configure(&mut cmd);

    let start = Instant::now();
    let mut child = cmd.spawn().map_err(|e| spawn_error(e, &req.program))?;
    let process_tree = match ProcessTree::attach(&child) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(io_to_tool(error, "process.run.containment"));
        }
    };
    let mut process_tree_guard = ProcessTreeGuard::new(process_tree);

    // Spawn the stdout/stderr drain tasks BEFORE touching stdin, so a child
    // that emits output before consuming stdin cannot fill its pipe buffer and
    // deadlock the parent (review P1).
    let stdout_child = child.stdout.take();
    let stderr_child = child.stderr.take();
    let invocation_owner = uuid::Uuid::now_v7().to_string();

    let stdout_task = AbortOnDrop::spawn(drain_stream(
        stdout_child,
        stdout_mode.clone(),
        "stdout",
        req.preview_max_bytes,
        invocation_owner.clone(),
    ));
    let stderr_task = AbortOnDrop::spawn(drain_stream(
        stderr_child,
        stderr_mode.clone(),
        "stderr",
        req.preview_max_bytes,
        invocation_owner,
    ));

    // Run the stdin write as its OWN task so a child that never reads its
    // stdin (and thus lets the pipe buffer fill) cannot block cancellation:
    // `write_all` runs concurrently with the wait/cancel select, and killing
    // the child on cancel closes the pipe and unblocks the write. We settle
    // this task on every exit path below (review P1 round 2).
    let stdin_task = if let Some(input) = req.stdin.clone()
        && let Some(mut child_stdin) = child.stdin.take()
    {
        Some(AbortOnDrop::spawn(async move {
            // A write/shutdown error here (child closed stdin early, or was
            // killed) is not a process-run failure; the nonzero-exit path
            // reports child status separately.
            let _ = child_stdin.write_all(input.as_bytes()).await;
            let _ = child_stdin.shutdown().await;
        }))
    } else {
        // No stdin: drop the (null) handle so the child sees EOF immediately.
        drop(child.stdin.take());
        None
    };

    // Wait for the child, observing cancellation. On cancellation we kill the
    // direct child AND settle every spawned task (stdin + drains) so no pipe
    // or task is left dangling (kill_on_drop also covers the child on drop).
    let status = tokio::select! {
        biased;
        _ = ctx.cancellation_blocking() => {
            let containment_result = process_tree_guard.terminate();
            let _ = child.start_kill();
            let _ = child.wait().await;
            if let Err(error) = containment_result {
                abort_process_tasks(stdin_task, stdout_task, stderr_task).await;
                return Err(io_to_tool(error, "process.run.cleanup"));
            }
            if let Some(t) = stdin_task { let _ = t.join().await; }
            let _ = stdout_task.join().await;
            let _ = stderr_task.join().await;
            process_tree_guard.disarm();
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "process.run",
                "operation cancelled",
            ));
        }
        s = child.wait() => {
            match s {
                Ok(status) => status,
                Err(wait_error) => {
                    let containment_result = process_tree_guard.terminate();
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    abort_process_tasks(stdin_task, stdout_task, stderr_task).await;
                    if let Err(error) = containment_result {
                        return Err(io_to_tool(error, "process.run.cleanup"));
                    }
                    process_tree_guard.disarm();
                    return Err(io_to_tool(wait_error, "process.run.wait"));
                }
            }
        }
    };

    // A one-shot invocation owns its complete descendant tree. If the direct
    // child exits after launching a background descendant, terminate that
    // remainder before joining drains; otherwise an inherited pipe can keep the
    // call alive forever and make a later cancellation impossible to observe.
    if let Err(error) = process_tree_guard.terminate() {
        abort_process_tasks(stdin_task, stdout_task, stderr_task).await;
        return Err(io_to_tool(error, "process.run.cleanup"));
    }

    // Settle the stdin write task on the normal path too. A join/inner error
    // here only means the child closed stdin early — not a run failure.
    if let Some(t) = stdin_task {
        let _ = t.join().await;
    }

    // Collect reader outputs. drain_stream returns Result so file-capture write
    // failures surface instead of silently reporting success with a missing
    // stdout_path/stderr_path (review P1). The double `?` unwraps the JoinError
    // then the inner drain error.
    let (stdout_out, stderr_out) = tokio::join!(stdout_task.join(), stderr_task.join());
    let stdout_out = stdout_out.map_err(|e| join_error(e, "stdout"))??;
    let stderr_out = stderr_out.map_err(|e| join_error(e, "stderr"))??;
    process_tree_guard.disarm();

    let duration_ms = (!req.deterministic).then(|| start.elapsed().as_millis() as u64);

    let (stdout_str, stdout_path, stdout_b) = match stdout_out {
        StreamCapture::Inline(s) => (Some(s), None, None),
        StreamCapture::File(p) => (None, Some(p), None),
        StreamCapture::Bounded(b) => (Some(b.preview.clone()), None, Some(b)),
        StreamCapture::None => (None, None, None),
    };
    let (stderr_str, stderr_path, stderr_b) = match stderr_out {
        StreamCapture::Inline(s) => (Some(s), None, None),
        StreamCapture::File(p) => (None, Some(p), None),
        StreamCapture::Bounded(b) => (Some(b.preview.clone()), None, Some(b)),
        StreamCapture::None => (None, None, None),
    };

    let success = status.success();
    let exit_code = status.code();
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(|s| signal_name(s).to_string())
    };
    #[cfg(not(unix))]
    let signal = None;

    let stdout_bounded = bounded_fields(stdout_b);
    let stderr_bounded = bounded_fields(stderr_b);

    Ok(ProcessRunResult {
        success,
        exit_code,
        signal,
        stdout: stdout_str,
        stderr: stderr_str,
        stdout_path,
        stderr_path,
        duration_ms,
        stdout_truncated: stdout_bounded.truncated,
        stdout_total_bytes: stdout_bounded.total_bytes,
        stdout_sha256: stdout_bounded.sha256,
        stdout_artifact: stdout_bounded.artifact,
        stdout_preview_bytes: stdout_bounded.preview_bytes,
        stdout_preview_lossy: stdout_bounded.preview_lossy,
        stderr_truncated: stderr_bounded.truncated,
        stderr_total_bytes: stderr_bounded.total_bytes,
        stderr_sha256: stderr_bounded.sha256,
        stderr_artifact: stderr_bounded.artifact,
        stderr_preview_bytes: stderr_bounded.preview_bytes,
        stderr_preview_lossy: stderr_bounded.preview_lossy,
    })
}

async fn abort_process_tasks(
    stdin_task: Option<AbortOnDrop<()>>,
    stdout_task: AbortOnDrop<Result<StreamCapture, ToolError>>,
    stderr_task: AbortOnDrop<Result<StreamCapture, ToolError>>,
) {
    if let Some(task) = stdin_task {
        task.abort();
        let _ = task.join().await;
    }
    stdout_task.abort();
    stderr_task.abort();
    let _ = stdout_task.join().await;
    let _ = stderr_task.join().await;
}

pub(super) enum StreamCapture {
    Inline(String),
    File(String),
    Bounded(Box<BoundedCapture>),
    None,
}

/// Bounded preview + (optional) complete artifact for one stream (ADR 0027
/// §7.1 + amendment 1). The artifact exists only when the stream overflowed
/// the preview budget (`truncated=true`); a stream that fits within budget is
/// fully inline and needs no continuation credential.
pub(super) struct BoundedCapture {
    /// Lossy UTF-8 preview. `preview_raw_bytes` is the byte-budgeted raw
    /// prefix; the display string may be longer due to U+FFFD replacement.
    pub(super) preview: String,
    pub(super) preview_raw_bytes: u64,
    pub(super) preview_lossy: bool,
    pub(super) truncated: bool,
    pub(super) total_bytes: u64,
    /// Whole-stream SHA-256 (== artifact sha256 when an artifact exists).
    pub(super) sha256: String,
    pub(super) artifact: Option<ArtifactRef>,
}

/// Read a child stream to completion, dispatching by capture mode. Returns the
/// captured inline string (Inline), the file path written (File), a bounded
/// preview + artifact (Bounded), or nothing (Null/Inherit). I/O errors are
/// propagated: previously `read_to_end` and the file write used `let _ =`, so a
/// capture to an unwritable path (e.g. a missing parent dir) silently reported
/// `success=true` with a non-existent `stdout_path` (review P1).
///
/// When `budget` is `Some(n)` and the mode is `Inline`, the stream is tee'd: a
/// bounded preview is surfaced and the COMPLETE raw bytes are written to an
/// immutable artifact (ADR 0027 §7.1). Over-budget output stops writing the
/// preview but NEVER stops the drain — the artifact always receives every byte.
pub(super) async fn drain_stream(
    stream: Option<impl tokio::io::AsyncRead + Unpin + Send + 'static>,
    mode: ProcessStreamMode,
    label: &str,
    budget: Option<u64>,
    owner: String,
) -> Result<StreamCapture, ToolError> {
    match mode {
        ProcessStreamMode::Inline => {
            if let Some(n) = budget {
                drain_stream_bounded(stream, n, label, &owner)
                    .await
                    .map(|capture| StreamCapture::Bounded(Box::new(capture)))
            } else {
                use tokio::io::AsyncReadExt;
                if let Some(mut s) = stream {
                    let mut buf = Vec::new();
                    s.read_to_end(&mut buf)
                        .await
                        .map_err(|e| io_to_tool(e, label))?;
                    Ok(StreamCapture::Inline(
                        String::from_utf8_lossy(&buf).into_owned(),
                    ))
                } else {
                    Ok(StreamCapture::Inline(String::new()))
                }
            }
        }
        ProcessStreamMode::File { path } => {
            use tokio::io::AsyncReadExt;
            if let Some(mut s) = stream {
                let mut buf = Vec::new();
                s.read_to_end(&mut buf)
                    .await
                    .map_err(|e| io_to_tool(e, label))?;
                std::fs::write(&path, &buf).map_err(|e| map_io_for_capture(e, label, &path))?;
                Ok(StreamCapture::File(path))
            } else {
                // No stream (Null/inherit produced none); still touch the file
                // so the caller's requested path exists. Propagate the error if
                // the path is not writable.
                std::fs::write(&path, []).map_err(|e| map_io_for_capture(e, label, &path))?;
                Ok(StreamCapture::File(path))
            }
        }
        ProcessStreamMode::Inherit | ProcessStreamMode::Null => {
            // A caller-created null/inherit stream is normally `None`. Pipeline
            // stages deliberately pass a piped stream with `Null`, so consume it
            // to EOF instead of closing the read end and delivering SIGPIPE to
            // a producer with voluminous stderr.
            if let Some(mut s) = stream {
                tokio::io::copy(&mut s, &mut tokio::io::sink())
                    .await
                    .map_err(|e| io_to_tool(e, label))?;
            }
            Ok(StreamCapture::None)
        }
    }
}

/// Tee a stream into a bounded preview (surfaced in the result) AND a complete
/// immutable artifact (the full raw bytes). The drain always runs to EOF so the
/// artifact is complete even when the preview is truncated; artifact write
/// failures surface as a typed error (never silent success — ADR 0027 §7.3).
async fn drain_stream_bounded(
    stream: Option<impl tokio::io::AsyncRead + Unpin + Send + 'static>,
    budget: u64,
    label: &str,
    owner: &str,
) -> Result<BoundedCapture, ToolError> {
    use tokio::io::AsyncReadExt;
    let kind = format!("process_{label}");
    // ADR 0027 amendment 1: the artifact is created ON DEMAND. Bytes are
    // buffered up to the preview budget first; only when the stream overflows
    // does the complete content spill to an immutable artifact (the preview
    // stays a byte-prefix of it). A stream that fits within budget needs no
    // artifact — the caller already holds every byte inline, so there is no
    // hidden truncation and nothing to fetch back.
    let mut preview: Vec<u8> = Vec::new();
    let mut total: u64 = 0;
    let mut writer: Option<ArtifactWriter> = None;
    if let Some(mut s) = stream {
        let mut buf = [0u8; 16384];
        loop {
            let n = s.read(&mut buf).await.map_err(|e| io_to_tool(e, label))?;
            if n == 0 {
                break;
            }
            let chunk = &buf[..n];
            total += n as u64;
            if let Some(w) = &mut writer {
                // Already spilled: the artifact receives every byte.
                w.write_chunk(chunk)?;
                continue;
            }
            let have = preview.len() as u64;
            if have + n as u64 <= budget {
                preview.extend_from_slice(chunk);
                continue;
            }
            // First overflow: spill. The buffered preview and the remainder of
            // this chunk go to the artifact so the preview remains an exact
            // byte-prefix of the complete raw bytes.
            let room = budget.saturating_sub(have) as usize;
            preview.extend_from_slice(&chunk[..room]);
            let mut w = ArtifactWriter::create(&kind, owner)?;
            w.write_chunk(&preview)?;
            w.write_chunk(&chunk[room..])?;
            writer = Some(w);
        }
    }
    let truncated = total > preview.len() as u64;
    let preview_lossy = std::str::from_utf8(&preview).is_err();
    let preview_str = String::from_utf8_lossy(&preview).into_owned();
    let (sha256, artifact) = match writer {
        Some(w) => {
            let artifact = w.finalize()?;
            (artifact.sha256.clone(), Some(artifact))
        }
        None => (crate::fs::sha256_hex(&preview), None),
    };
    Ok(BoundedCapture {
        preview: preview_str,
        preview_raw_bytes: preview.len() as u64,
        preview_lossy,
        truncated,
        total_bytes: total,
        sha256,
        artifact,
    })
}

/// Map an io error from a stream-capture file write into a typed ToolError,
/// annotating the destination path.
fn map_io_for_capture(e: std::io::Error, label: &str, path: &str) -> ToolError {
    io_to_tool(e, label).with_path(path.to_string())
}

fn spawn_error(e: std::io::Error, program: &str) -> ToolError {
    spawn_error_for_operation(e, program, "process.run")
}

fn spawn_error_for_operation(e: std::io::Error, program: &str, operation: &str) -> ToolError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ToolErrorCode::SpawnFailed,
        std::io::ErrorKind::PermissionDenied => ToolErrorCode::PermissionDenied,
        _ => ToolErrorCode::SpawnFailed,
    };
    ToolError::new(code, operation, format!("failed to spawn `{program}`: {e}"))
        .with_program(program)
        .with_raw_os_error(e.raw_os_error())
}

fn io_to_tool(e: std::io::Error, op: &str) -> ToolError {
    ToolError::new(ToolErrorCode::IoError, op, e.to_string()).with_raw_os_error(e.raw_os_error())
}

fn join_error(e: tokio::task::JoinError, stream: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::Internal,
        "process.run",
        format!("{stream} reader task failed: {e}"),
    )
}

#[cfg(unix)]
fn signal_name(s: i32) -> &'static str {
    match s {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        6 => "SIGABRT",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        15 => "SIGTERM",
        _ => "SIGNAL",
    }
}

// ---------------------------------------------------------------------------
// process_pipeline (plan §9.1): explicit argv graph, NO shell.
// ---------------------------------------------------------------------------

/// One stage of a pipeline. Direct argv only — `{program, args, env, cwd}`.
/// There is intentionally NO shell-string field: connection is by stdout→stdin
/// byte pipes, never by reinterpreting a user string through `sh -c`/`cmd /C`.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PipelineStage {
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub remove_env: Vec<String>,
    #[serde(default)]
    pub inherit_env: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProcessPipelineRequest {
    pub stages: Vec<PipelineStage>,
    /// Bytes fed to the first stage's stdin (None = empty/EOF immediately).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    /// Capture mode for the LAST stage's stdout (plan §9.1). Default inline.
    #[serde(default)]
    pub stdout: ProcessStreamMode,
    /// Internal per-stream preview budget. MCP exposes this through its tagged
    /// `output` selector instead of publishing this raw field directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_max_bytes: Option<u64>,
    /// Cache-friendly mode (ADR 0027 修订 2): omit `duration_ms` so identical
    /// pipelines return byte-identical results (see `ProcessRunRequest`).
    #[serde(default)]
    pub deterministic: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct PipelineStageResult {
    pub program: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    /// This stage's stderr, drained independently so one noisy stage cannot
    /// block the pipeline or be silently discarded.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_artifact: Option<ArtifactRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_preview_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr_preview_lossy: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct ProcessPipelineResult {
    /// True iff every stage exited successfully.
    pub success: bool,
    pub stages: Vec<PipelineStageResult>,
    /// Index of the first failing stage, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_stage: Option<u64>,
    /// Last stage's stdout (inline capture).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    /// Destination path when the last stage uses file capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_path: Option<String>,
    /// Last stage's stderr (inline capture).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    /// Wall-clock duration of the pipeline. Omitted when `deterministic=true`
    /// (ADR 0027 修订 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_artifact: Option<ArtifactRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_preview_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdout_preview_lossy: Option<bool>,
}

/// Run an explicit argv pipeline (plan §9.1). Each stage's stdout is piped to
/// the next stage's stdin via `tokio::io::copy`; no shell is ever invoked, so
/// shell metacharacters in argv arrive verbatim. Each stage's exit status is
/// reported; the last stage's stdout/stderr are captured.
pub async fn process_pipeline(
    ctx: &InvocationContext,
    req: &ProcessPipelineRequest,
) -> Result<ProcessPipelineResult, ToolError> {
    if req.stages.is_empty() {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "process.pipeline",
            "a pipeline needs at least one stage",
        ));
    }
    // stdio MCP discipline: the last stage's stdout may not be inherited.
    check_stream_modes(&req.stdout, &ProcessStreamMode::Null)?;
    let stdout_mode = resolve_stream_mode(ctx, &req.stdout, "process.pipeline.stdout")?;
    let start = Instant::now();
    let n = req.stages.len();

    // Spawn each stage with the right stdin/stdout piping.
    let mut children: Vec<tokio::process::Child> = Vec::with_capacity(n);
    let mut process_tree_guards: Vec<ProcessTreeGuard> = Vec::with_capacity(n);
    for (i, stage) in req.stages.iter().enumerate() {
        let mut cmd = tokio::process::Command::new(&stage.program);
        cmd.args(&stage.args);
        let cwd = if let Some(cwd) = &stage.cwd {
            Some(ctx.resolve_path(
                std::path::Path::new(cwd),
                None,
                PathAccess::ProcessCwd,
                "process.pipeline",
            )?)
        } else {
            contained_default_cwd(ctx, "process.pipeline")?
        };
        if let Some(cwd) = cwd {
            cmd.current_dir(cwd);
        }
        let env_vec = build_env(stage.inherit_env, &stage.env, &stage.remove_env);
        cmd.env_clear();
        for (k, v) in &env_vec {
            cmd.env(k, v);
        }
        // stdin: stage 0 gets the pipeline input (or null); others are piped
        // from the previous stage (connected below).
        if i == 0 {
            if req.stdin.is_some() {
                cmd.stdin(std::process::Stdio::piped());
            } else {
                cmd.stdin(std::process::Stdio::null());
            }
        } else {
            cmd.stdin(std::process::Stdio::piped());
        }
        // stdout: last stage uses the caller mode; others are piped to the next.
        if i == n - 1 {
            cmd.stdout(match &stdout_mode {
                ProcessStreamMode::Inline | ProcessStreamMode::File { .. } => {
                    std::process::Stdio::piped()
                }
                ProcessStreamMode::Inherit => std::process::Stdio::inherit(),
                ProcessStreamMode::Null => std::process::Stdio::null(),
            });
        } else {
            cmd.stdout(std::process::Stdio::piped());
        }
        cmd.stderr(std::process::Stdio::piped());
        cmd.kill_on_drop(true);
        tree::configure(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => {
                let cleanup_error =
                    terminate_pipeline_children(&mut children, &process_tree_guards)
                        .await
                        .err();
                let mut details = serde_json::json!({ "stage_index": i });
                if let Some(cleanup_error) = cleanup_error {
                    details["cleanup_error"] = serde_json::json!({
                        "message": cleanup_error.to_string(),
                        "raw_os_error": cleanup_error.raw_os_error(),
                    });
                }
                return Err(
                    spawn_error_for_operation(error, &stage.program, "process.pipeline")
                        .with_details(details),
                );
            }
        };
        let process_tree = match ProcessTree::attach(&child) {
            Ok(process_tree) => process_tree,
            Err(error) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                if let Err(cleanup_error) =
                    terminate_pipeline_children(&mut children, &process_tree_guards).await
                {
                    return Err(io_to_tool(cleanup_error, "process.pipeline.cleanup"));
                }
                return Err(io_to_tool(error, "process.pipeline.containment"));
            }
        };
        children.push(child);
        process_tree_guards.push(ProcessTreeGuard::new(process_tree));
    }

    // Connect stage[i].stdout -> stage[i+1].stdin. Closing the write end (drop)
    // after copy makes the next stage see EOF.
    let mut copy_tasks = Vec::new();
    for i in 0..n.saturating_sub(1) {
        let out = children[i].stdout.take();
        let inp = children[i + 1].stdin.take();
        if let (Some(mut out), Some(mut inp)) = (out, inp) {
            copy_tasks.push(AbortOnDrop::spawn(async move {
                let _ = tokio::io::copy(&mut out, &mut inp).await;
                // Drop `inp` closes the write end -> next stage sees EOF.
                drop(inp);
            }));
        }
    }

    // Stage 0 stdin: write the supplied bytes, then close.
    let stdin_task = if let Some(input) = req.stdin.clone()
        && let Some(mut s) = children[0].stdin.take()
    {
        Some(AbortOnDrop::spawn(async move {
            let _ = s.write_all(input.as_bytes()).await;
            let _ = s.shutdown().await;
        }))
    } else {
        drop(children[0].stdin.take());
        None
    };

    let invocation_owner = uuid::Uuid::now_v7().to_string();
    // Capture the last stage's stdout via the shared drain helper.
    let last_stdout_task = AbortOnDrop::spawn(drain_stream(
        children[n - 1].stdout.take(),
        stdout_mode,
        "pipeline.stdout",
        req.preview_max_bytes,
        invocation_owner.clone(),
    ));
    // Drain and retain every stage's stderr independently. Closing an
    // intermediate reader changes producer behavior (SIGPIPE / broken pipe),
    // so stderr is part of each stage's result rather than discarded.
    let mut stderr_tasks = Vec::with_capacity(n);
    for (i, child) in children.iter_mut().enumerate() {
        stderr_tasks.push(AbortOnDrop::spawn(drain_stream(
            child.stderr.take(),
            ProcessStreamMode::Inline,
            if i == n - 1 {
                "pipeline.stderr"
            } else {
                "pipeline.mid-stderr"
            },
            req.preview_max_bytes,
            invocation_owner.clone(),
        )));
    }

    // Wait for every child, polling cancellation between awaits (the borrow of
    // `children[i]` is per-iteration; the cancel branch kills the whole vec in a
    // separate statement, so the borrows do not overlap).
    let mut statuses: Vec<std::process::ExitStatus> = Vec::with_capacity(n);
    for i in 0..n {
        loop {
            if ctx.cancellation().is_cancelled() {
                let cleanup_result =
                    terminate_pipeline_children(&mut children, &process_tree_guards).await;
                if let Err(error) = cleanup_result {
                    abort_pipeline_tasks(stdin_task, copy_tasks, last_stdout_task, stderr_tasks)
                        .await;
                    return Err(io_to_tool(error, "process.pipeline.cleanup"));
                }
                settle_pipeline_tasks(stdin_task, copy_tasks, last_stdout_task, stderr_tasks).await;
                for guard in &mut process_tree_guards {
                    guard.disarm();
                }
                return Err(ToolError::new(
                    ToolErrorCode::Cancelled,
                    "process.pipeline",
                    "operation cancelled",
                ));
            }
            if let Ok(r) =
                tokio::time::timeout(std::time::Duration::from_millis(100), children[i].wait())
                    .await
            {
                let status = match r {
                    Ok(status) => status,
                    Err(error) => {
                        let cleanup_result =
                            terminate_pipeline_children(&mut children, &process_tree_guards).await;
                        abort_pipeline_tasks(
                            stdin_task,
                            copy_tasks,
                            last_stdout_task,
                            stderr_tasks,
                        )
                        .await;
                        if let Err(cleanup_error) = cleanup_result {
                            return Err(io_to_tool(cleanup_error, "process.pipeline.cleanup"));
                        }
                        return Err(io_to_tool(error, "process.pipeline.wait"));
                    }
                };
                statuses.push(status);
                if let Err(error) = process_tree_guards[i].terminate() {
                    let _ = terminate_pipeline_children(&mut children, &process_tree_guards).await;
                    abort_pipeline_tasks(stdin_task, copy_tasks, last_stdout_task, stderr_tasks)
                        .await;
                    return Err(io_to_tool(error, "process.pipeline.cleanup"));
                }
                break;
            }
        }
    }

    // Settle the stdin writer and pipe-copy tasks.
    if let Some(t) = stdin_task {
        let _ = t.join().await;
    }
    for t in copy_tasks {
        let _ = t.join().await;
    }
    // Await every capture task before propagating any one task's error. An
    // early `?` here would detach the remaining drains and let artifact writes
    // outlive the tool call.
    let stdout_result = last_stdout_task.join().await;
    let mut stderr_results = Vec::with_capacity(n);
    for (i, task) in stderr_tasks.into_iter().enumerate() {
        stderr_results.push((i, task.join().await));
    }
    for guard in &mut process_tree_guards {
        guard.disarm();
    }
    let stdout_out = stdout_result.map_err(|e| join_error(e, "pipeline.stdout"))??;
    let mut stage_stderr = Vec::with_capacity(n);
    for (i, result) in stderr_results {
        let capture =
            result.map_err(|e| join_error(e, &format!("pipeline.stage[{i}].stderr")))??;
        stage_stderr.push(capture);
    }

    let (stdout_str, stdout_path, stdout_bounded) = capture_parts(stdout_out);
    let stderr_str = stage_stderr.last().and_then(capture_text);

    let mut stages: Vec<PipelineStageResult> = Vec::with_capacity(n);
    let mut failed_stage = None;
    let mut all_success = true;
    for (i, st) in statuses.iter().enumerate() {
        let success = st.success();
        if !success && failed_stage.is_none() {
            failed_stage = Some(i as u64);
            all_success = false;
        }
        stages.push(PipelineStageResult {
            program: req.stages[i].program.clone(),
            success,
            exit_code: st.code(),
            stderr: capture_text(&stage_stderr[i]),
            stderr_truncated: capture_truncated(&stage_stderr[i]),
            stderr_total_bytes: capture_total_bytes(&stage_stderr[i]),
            stderr_sha256: capture_sha256(&stage_stderr[i]),
            stderr_artifact: capture_artifact(&stage_stderr[i]),
            stderr_preview_bytes: capture_preview_bytes(&stage_stderr[i]),
            stderr_preview_lossy: capture_preview_lossy(&stage_stderr[i]),
        });
    }

    let stdout_bounded = bounded_fields(stdout_bounded);

    Ok(ProcessPipelineResult {
        success: all_success,
        stages,
        failed_stage,
        stdout: stdout_str,
        stdout_path,
        stderr: stderr_str,
        duration_ms: (!req.deterministic).then(|| start.elapsed().as_millis() as u64),
        stdout_truncated: stdout_bounded.truncated,
        stdout_total_bytes: stdout_bounded.total_bytes,
        stdout_sha256: stdout_bounded.sha256,
        stdout_artifact: stdout_bounded.artifact,
        stdout_preview_bytes: stdout_bounded.preview_bytes,
        stdout_preview_lossy: stdout_bounded.preview_lossy,
    })
}

fn capture_parts(
    capture: StreamCapture,
) -> (Option<String>, Option<String>, Option<Box<BoundedCapture>>) {
    match capture {
        StreamCapture::Inline(value) => (Some(value), None, None),
        StreamCapture::File(path) => (None, Some(path), None),
        StreamCapture::Bounded(bounded) => (Some(bounded.preview.clone()), None, Some(bounded)),
        StreamCapture::None => (None, None, None),
    }
}

fn capture_text(capture: &StreamCapture) -> Option<String> {
    match capture {
        StreamCapture::Inline(value) | StreamCapture::File(value) => Some(value.clone()),
        StreamCapture::Bounded(bounded) => Some(bounded.preview.clone()),
        StreamCapture::None => None,
    }
}

fn capture_truncated(capture: &StreamCapture) -> Option<bool> {
    match capture {
        StreamCapture::Bounded(value) => Some(value.truncated),
        _ => None,
    }
}

fn capture_total_bytes(capture: &StreamCapture) -> Option<u64> {
    match capture {
        StreamCapture::Bounded(value) => Some(value.total_bytes),
        _ => None,
    }
}

fn capture_sha256(capture: &StreamCapture) -> Option<String> {
    match capture {
        StreamCapture::Bounded(value) => Some(value.sha256.clone()),
        _ => None,
    }
}

fn capture_artifact(capture: &StreamCapture) -> Option<ArtifactRef> {
    match capture {
        StreamCapture::Bounded(value) => value.artifact.clone(),
        _ => None,
    }
}

fn capture_preview_bytes(capture: &StreamCapture) -> Option<u64> {
    match capture {
        StreamCapture::Bounded(value) => Some(value.preview_raw_bytes),
        _ => None,
    }
}

fn capture_preview_lossy(capture: &StreamCapture) -> Option<bool> {
    match capture {
        StreamCapture::Bounded(value) => Some(value.preview_lossy),
        _ => None,
    }
}

#[derive(Default)]
struct BoundedFields {
    truncated: Option<bool>,
    total_bytes: Option<u64>,
    sha256: Option<String>,
    artifact: Option<ArtifactRef>,
    preview_bytes: Option<u64>,
    preview_lossy: Option<bool>,
}

fn bounded_fields(bounded: Option<Box<BoundedCapture>>) -> BoundedFields {
    bounded.map_or_else(BoundedFields::default, |value| BoundedFields {
        truncated: Some(value.truncated),
        total_bytes: Some(value.total_bytes),
        sha256: Some(value.sha256),
        artifact: value.artifact,
        preview_bytes: Some(value.preview_raw_bytes),
        preview_lossy: Some(value.preview_lossy),
    })
}

/// Join all pipeline worker tasks on the cancellation path so no pipe/task is
/// left dangling.
async fn settle_pipeline_tasks(
    stdin_task: Option<AbortOnDrop<()>>,
    copy_tasks: Vec<AbortOnDrop<()>>,
    last_stdout_task: AbortOnDrop<Result<StreamCapture, ToolError>>,
    stderr_tasks: Vec<AbortOnDrop<Result<StreamCapture, ToolError>>>,
) {
    if let Some(t) = stdin_task {
        let _ = t.join().await;
    }
    for t in copy_tasks {
        let _ = t.join().await;
    }
    for t in stderr_tasks {
        let _ = t.join().await;
    }
    let _ = last_stdout_task.join().await;
}

async fn abort_pipeline_tasks(
    stdin_task: Option<AbortOnDrop<()>>,
    copy_tasks: Vec<AbortOnDrop<()>>,
    last_stdout_task: AbortOnDrop<Result<StreamCapture, ToolError>>,
    stderr_tasks: Vec<AbortOnDrop<Result<StreamCapture, ToolError>>>,
) {
    if let Some(task) = &stdin_task {
        task.abort();
    }
    for task in &copy_tasks {
        task.abort();
    }
    last_stdout_task.abort();
    for task in &stderr_tasks {
        task.abort();
    }
    settle_pipeline_tasks(stdin_task, copy_tasks, last_stdout_task, stderr_tasks).await;
}

async fn terminate_pipeline_children(
    children: &mut [tokio::process::Child],
    process_tree_guards: &[ProcessTreeGuard],
) -> std::io::Result<()> {
    let mut first_error = None;
    for process_tree_guard in process_tree_guards {
        if let Err(error) = process_tree_guard.terminate()
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    for child in children.iter_mut() {
        let _ = child.start_kill();
    }
    for child in children.iter_mut() {
        if let Err(error) = child.wait().await
            && first_error.is_none()
        {
            first_error = Some(error);
        }
    }
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimal_env_seeds_only_allowlist_and_explicit_overrides() {
        // ADR 0028 amendment 1: inherit_env=false seeds the non-secret
        // allowlist, plus explicit `env` overrides, and nothing else.
        let env = BTreeMap::from([("MARKER_OVERRIDE".to_string(), "1".to_string())]);
        let built = build_env(false, &env, &[]);
        for (k, _) in &built {
            assert!(
                MINIMAL_ENV_ALLOWLIST.iter().any(|a| case_key(a) == *k) || *k == "MARKER_OVERRIDE",
                "minimal env leaked non-allowlist key `{k}`"
            );
        }
        assert!(
            built
                .iter()
                .any(|(k, v)| k == "MARKER_OVERRIDE" && v == "1"),
            "explicit override must reach the child"
        );
        // Allowlist members present in the server env are seeded.
        if std::env::var_os("PATH").is_some() {
            assert!(
                built.iter().any(|(k, _)| k == "PATH"),
                "PATH must be seeded when the server has one"
            );
        }
        // Arbitrary server env vars (tokens, keys, sockets) must not leak.
        for (k, _) in std::env::vars() {
            if !MINIMAL_ENV_ALLOWLIST
                .iter()
                .any(|a| case_key(a) == case_key(&k))
            {
                assert!(
                    !built.iter().any(|(bk, _)| case_key(bk) == case_key(&k)),
                    "minimal env leaked server var `{k}`"
                );
            }
        }
    }

    #[test]
    fn minimal_env_override_and_remove_apply_after_seeding() {
        let env = BTreeMap::from([("HOME".to_string(), "/override".to_string())]);
        let built = build_env(false, &env, &["PATH".to_string()]);
        assert!(
            !built.iter().any(|(k, _)| k == "PATH"),
            "remove_env must drop a seeded allowlist member"
        );
        assert!(
            built.iter().any(|(k, v)| k == "HOME" && v == "/override"),
            "explicit override must replace the seeded HOME"
        );
    }

    #[test]
    fn full_env_inheritance_keeps_every_server_var() {
        let built = build_env(true, &BTreeMap::new(), &[]);
        let server: BTreeMap<String, String> =
            std::env::vars().map(|(k, v)| (case_key(&k), v)).collect();
        for (k, _) in &built {
            assert!(
                server.contains_key(k),
                "inherited key `{k}` is missing from the server env"
            );
        }
    }
}
