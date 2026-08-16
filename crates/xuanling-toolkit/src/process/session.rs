//! `process_session` — one-shot argv session with descendant-aware close
//! (ADR 0027 §9.2, plan §9.2).
//!
//! `session_open` creates a server-side handle bound to a cwd/env. `session_exec`
//! runs a direct-argv command IN that session; each child is placed in an
//! OS-owned containment unit, so cancellation and `session_close` terminate the
//! child AND any descendants rather than only the direct child. Completed execs
//! clean up their containment unit before returning; detached/background work is
//! not a session contract. The session registry is server-owned: a caller
//! cannot pass an arbitrary path/id to escape it. Sessions do not persist across
//! server restart (plan §9.2).

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;
use crate::process::ProcessStreamMode;
use crate::process::run::{
    StreamCapture, build_env, contained_default_cwd, drain_stream, resolve_stream_mode,
};
use crate::process::tree::{self, AbortOnDrop, ProcessTree, ProcessTreeGuard};

/// Open a session bound to a cwd/env (plan §9.2).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionOpenRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub inherit_env: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct SessionOpenResult {
    pub session_id: String,
}

/// Run a direct-argv command inside a session. The session's cwd/env are applied
/// (the request's env overrides). NO shell — argv only.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionExecRequest {
    pub session_id: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stdin: Option<String>,
    #[serde(default)]
    pub stdout: ProcessStreamMode,
    #[serde(default)]
    pub stderr: ProcessStreamMode,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Cache-friendly mode (ADR 0027 修订 2): omit `duration_ms` from the
    /// result so identical executions return byte-identical results.
    #[serde(default)]
    pub deterministic: bool,
    /// Internal preview byte budget. The MCP boundary exposes the tagged
    /// `output` selector and translates it to this raw toolkit field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_max_bytes: Option<u64>,
}

/// Result of a session_exec (same shape as process_run's result).
pub type SessionExecResult = super::run::ProcessRunResult;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionCloseRequest {
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct SessionCloseResult {
    /// Process-tree ids that session_close attempted to terminate.
    pub terminated_process_trees: Vec<i64>,
}

struct Session {
    cwd: Option<String>,
    env: BTreeMap<String, String>,
    inherit_env: bool,
    closing: bool,
    /// Active process trees owned by this session, registered immediately after
    /// spawn and removed only after their complete containment unit is settled.
    process_trees: Vec<ProcessTree>,
    #[allow(dead_code)]
    created_at: Instant,
}

/// Invocation-local ownership for a session process tree. The registry keeps a
/// cloneable handle for `session_close`; this guard owns fallback termination
/// and unregisters that handle if the `session_exec` future is dropped.
struct SessionProcessTreeGuard {
    session_id: String,
    process_tree_key: u64,
    cleanup: ProcessTreeGuard,
    registered: bool,
}

impl SessionProcessTreeGuard {
    fn new(session_id: String, process_tree: ProcessTree) -> Self {
        Self {
            session_id,
            process_tree_key: process_tree.key(),
            cleanup: ProcessTreeGuard::new(process_tree),
            registered: true,
        }
    }

    fn terminate(&self) -> std::io::Result<()> {
        self.cleanup.terminate()
    }

    fn disarm(&mut self) {
        self.unregister();
        self.cleanup.disarm();
    }

    fn unregister(&mut self) {
        if self.registered {
            unregister_process_tree(&self.session_id, self.process_tree_key);
            self.registered = false;
        }
    }
}

impl Drop for SessionProcessTreeGuard {
    fn drop(&mut self) {
        // If termination fails, leave the inner guard armed so its own Drop
        // makes one final best-effort attempt after registry cleanup.
        let termination = self.cleanup.terminate();
        self.unregister();
        if termination.is_ok() {
            self.cleanup.disarm();
        }
    }
}

fn store() -> &'static Mutex<HashMap<String, Session>> {
    static S: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("session-{}-{n}", std::process::id())
}

pub fn session_open(
    ctx: &InvocationContext,
    req: &SessionOpenRequest,
) -> Result<SessionOpenResult, ToolError> {
    let id = next_id();
    let cwd = match req.cwd.as_deref() {
        Some(cwd) => Some(
            ctx.resolve_path(
                std::path::Path::new(cwd),
                None,
                PathAccess::ProcessCwd,
                "process.session.open",
            )
            .map(|path| path.to_string_lossy().into_owned())?,
        ),
        None => contained_default_cwd(ctx, "process.session.open")?
            .map(|path| path.to_string_lossy().into_owned()),
    };
    store().lock().expect("session store not poisoned").insert(
        id.clone(),
        Session {
            cwd,
            env: req.env.clone(),
            inherit_env: req.inherit_env,
            closing: false,
            process_trees: Vec::new(),
            created_at: Instant::now(),
        },
    );
    Ok(SessionOpenResult { session_id: id })
}

pub async fn session_exec(
    ctx: &InvocationContext,
    req: &SessionExecRequest,
) -> Result<SessionExecResult, ToolError> {
    // stdio MCP discipline.
    if matches!(req.stdout, ProcessStreamMode::Inherit) {
        return Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "process.session",
            "stdout=inherit is unsupported in stdio MCP mode",
        ));
    }
    let (stored_cwd, base_env, inherit_env) = {
        let mut s = store().lock().expect("session store not poisoned");
        let sess = s
            .get_mut(&req.session_id)
            .ok_or_else(|| not_found(&req.session_id))?;
        if sess.closing {
            return Err(session_closing(&req.session_id));
        }
        (sess.cwd.clone(), sess.env.clone(), sess.inherit_env)
    };
    // Session ids are global server-side handles, while filesystem capability
    // is invocation-local. Revalidate the stored target on every use so a
    // handle opened by a broader caller cannot become a confused deputy for a
    // narrower caller. The stored cwd is already a resolved target, so validate
    // it directly rather than resolving it against the new caller's base_dir.
    let cwd = match stored_cwd.as_deref() {
        Some(cwd) => Some(ctx.filesystem_scope().validate(
            std::path::Path::new(cwd),
            PathAccess::ProcessCwd,
            "process.session.exec",
        )?),
        None => contained_default_cwd(ctx, "process.session.exec")?,
    };
    // Merge: session env as the base, request env overrides.
    let mut merged = base_env;
    for (k, v) in &req.env {
        merged.insert(k.clone(), v.clone());
    }

    let mut cmd = tokio::process::Command::new(&req.program);
    cmd.args(&req.args);
    if let Some(cwd) = &cwd {
        cmd.current_dir(cwd);
    }
    // Same env policy as `process_run` (ADR 0028 amendment 1): the session's
    // stored env is the explicit override set; a session opened with
    // `inherit_env=false` seeds the minimal non-secret allowlist, while
    // `inherit_env=true` captures the full environment at open time.
    let env_vec = build_env(inherit_env, &merged, &[]);
    cmd.env_clear();
    for (k, v) in &env_vec {
        cmd.env(k, v);
    }
    if req.stdin.is_some() {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    let stdout_mode = resolve_stream_mode(ctx, &req.stdout, "process.session.stdout")?;
    let stderr_mode = resolve_stream_mode(ctx, &req.stderr, "process.session.stderr")?;
    cmd.stdout(match &stdout_mode {
        ProcessStreamMode::Inline | ProcessStreamMode::File { .. } => std::process::Stdio::piped(),
        ProcessStreamMode::Inherit => std::process::Stdio::inherit(),
        ProcessStreamMode::Null => std::process::Stdio::null(),
    });
    cmd.stderr(match &stderr_mode {
        ProcessStreamMode::Inline | ProcessStreamMode::File { .. } => std::process::Stdio::piped(),
        ProcessStreamMode::Inherit => std::process::Stdio::inherit(),
        ProcessStreamMode::Null => std::process::Stdio::null(),
    });
    cmd.kill_on_drop(true);

    tree::configure(&mut cmd);

    let start = Instant::now();
    // Spawn and register under the same registry critical section. This makes
    // session_close linearizable with respect to new execs: close either sees
    // the registered tree or the exec observes `closing` before spawning.
    let spawned = {
        let mut sessions = store().lock().expect("session store not poisoned");
        let Some(session) = sessions
            .get_mut(&req.session_id)
            .filter(|session| !session.closing)
        else {
            return Err(session_closing_or_not_found(&req.session_id, &sessions));
        };
        let child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => return Err(spawn_err(error, &req.program)),
        };
        match ProcessTree::attach(&child) {
            Ok(process_tree) => {
                session.process_trees.push(process_tree.clone());
                Ok((child, process_tree))
            }
            Err(error) => Err((child, error)),
        }
    };
    let (mut child, process_tree) = match spawned {
        Ok(spawned) => spawned,
        Err((mut child, error)) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return Err(io_err(error, "process.session.containment"));
        }
    };
    let mut process_tree_guard = SessionProcessTreeGuard::new(req.session_id.clone(), process_tree);

    // Use the same drain/tee implementation as process_run so session output
    // has identical byte-budget, raw artifact and lossy-preview semantics.
    let stdout_child = child.stdout.take();
    let stderr_child = child.stderr.take();
    let invocation_owner = uuid::Uuid::now_v7().to_string();
    let stdout_task = AbortOnDrop::spawn(drain_stream(
        stdout_child,
        stdout_mode,
        "session.stdout",
        req.preview_max_bytes,
        invocation_owner.clone(),
    ));
    let stderr_task = AbortOnDrop::spawn(drain_stream(
        stderr_child,
        stderr_mode,
        "session.stderr",
        req.preview_max_bytes,
        invocation_owner,
    ));

    let stdin_task = if let Some(input) = req.stdin.clone()
        && let Some(mut child_stdin) = child.stdin.take()
    {
        Some(AbortOnDrop::spawn(async move {
            let _ = child_stdin.write_all(input.as_bytes()).await;
            let _ = child_stdin.shutdown().await;
        }))
    } else {
        drop(child.stdin.take());
        None
    };

    // Wait, observing cancellation (poll is_cancelled between bounded waits).
    let status = loop {
        if ctx.cancellation().is_cancelled() {
            let containment_result = process_tree_guard.terminate();
            let _ = child.start_kill();
            let _ = child.wait().await;
            if let Err(error) = containment_result {
                abort_session_tasks(stdin_task, stdout_task, stderr_task).await;
                return Err(io_err(error, "process.session.cleanup"));
            }
            if let Some(t) = stdin_task {
                let _ = t.join().await;
            }
            let _ = stdout_task.join().await;
            let _ = stderr_task.join().await;
            process_tree_guard.disarm();
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "process.session",
                "operation cancelled",
            ));
        }
        if let Ok(r) =
            tokio::time::timeout(std::time::Duration::from_millis(100), child.wait()).await
        {
            match r {
                Ok(status) => break status,
                Err(wait_error) => {
                    let containment_result = process_tree_guard.terminate();
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    abort_session_tasks(stdin_task, stdout_task, stderr_task).await;
                    if let Err(error) = containment_result {
                        return Err(io_err(error, "process.session.cleanup"));
                    }
                    process_tree_guard.disarm();
                    return Err(io_err(wait_error, "process.session.wait"));
                }
            }
        }
    };
    // A completed direct child may have left descendants holding inherited
    // pipes. Session exec is a foreground operation: terminate that remainder
    // before joining drains and before forgetting the OS containment handle.
    if let Err(error) = process_tree_guard.terminate() {
        abort_session_tasks(stdin_task, stdout_task, stderr_task).await;
        return Err(io_err(error, "process.session.cleanup"));
    }
    if let Some(t) = stdin_task {
        let _ = t.join().await;
    }
    let (stdout_capture, stderr_capture) = tokio::join!(stdout_task.join(), stderr_task.join());
    let stdout_capture = stdout_capture.map_err(|error| join_err(error, "session.stdout"))??;
    let stderr_capture = stderr_capture.map_err(|error| join_err(error, "session.stderr"))??;
    process_tree_guard.disarm();
    let stdout = session_capture_parts(stdout_capture);
    let stderr = session_capture_parts(stderr_capture);

    let success = status.success();
    let exit_code = status.code();
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().map(sig_name)
    };
    #[cfg(not(unix))]
    let signal: Option<&str> = None;

    Ok(SessionExecResult {
        success,
        exit_code,
        signal: signal.map(|s| s.to_string()),
        stdout: stdout.text,
        stderr: stderr.text,
        stdout_path: stdout.path,
        stderr_path: stderr.path,
        duration_ms: (!req.deterministic).then(|| start.elapsed().as_millis() as u64),
        stdout_truncated: stdout.truncated,
        stdout_total_bytes: stdout.total_bytes,
        stdout_sha256: stdout.sha256,
        stdout_artifact: stdout.artifact,
        stdout_preview_bytes: stdout.preview_bytes,
        stdout_preview_lossy: stdout.preview_lossy,
        stderr_truncated: stderr.truncated,
        stderr_total_bytes: stderr.total_bytes,
        stderr_sha256: stderr.sha256,
        stderr_artifact: stderr.artifact,
        stderr_preview_bytes: stderr.preview_bytes,
        stderr_preview_lossy: stderr.preview_lossy,
    })
}

async fn abort_session_tasks(
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

fn unregister_process_tree(session_id: &str, process_tree_key: u64) {
    let mut sessions = store().lock().expect("session store not poisoned");
    if let Some(session) = sessions.get_mut(session_id) {
        session
            .process_trees
            .retain(|process_tree| process_tree.key() != process_tree_key);
    }
}

pub fn session_close(
    _ctx: &InvocationContext,
    req: &SessionCloseRequest,
) -> Result<SessionCloseResult, ToolError> {
    let process_trees = {
        let mut sessions = store().lock().expect("session store not poisoned");
        let session = sessions
            .get_mut(&req.session_id)
            .ok_or_else(|| not_found(&req.session_id))?;
        session.closing = true;
        session.process_trees.clone()
    };
    let mut terminated = Vec::new();
    let mut terminated_keys = Vec::new();
    let mut failure = None;
    for process_tree in &process_trees {
        match process_tree.terminate() {
            Ok(()) => {
                terminated.push(process_tree.id());
                terminated_keys.push(process_tree.key());
            }
            Err(error) if failure.is_none() => failure = Some((process_tree.id(), error)),
            Err(_) => {}
        }
    }
    {
        let mut sessions = store().lock().expect("session store not poisoned");
        if let Some(session) = sessions.get_mut(&req.session_id) {
            session
                .process_trees
                .retain(|tree| !terminated_keys.contains(&tree.key()));
        }
    }
    if let Some((process_tree_id, error)) = failure {
        return Err(
            io_err(error, "process.session.close").with_details(serde_json::json!({
                "reason": "session_cleanup_failed",
                "session_id": req.session_id,
                "process_tree_id": process_tree_id,
            })),
        );
    }
    store()
        .lock()
        .expect("session store not poisoned")
        .remove(&req.session_id);
    Ok(SessionCloseResult {
        terminated_process_trees: terminated,
    })
}

struct SessionCapture {
    text: Option<String>,
    path: Option<String>,
    truncated: Option<bool>,
    total_bytes: Option<u64>,
    sha256: Option<String>,
    artifact: Option<crate::process::ArtifactRef>,
    preview_bytes: Option<u64>,
    preview_lossy: Option<bool>,
}

fn session_capture_parts(capture: StreamCapture) -> SessionCapture {
    match capture {
        StreamCapture::Inline(text) => SessionCapture {
            text: Some(text),
            path: None,
            truncated: None,
            total_bytes: None,
            sha256: None,
            artifact: None,
            preview_bytes: None,
            preview_lossy: None,
        },
        StreamCapture::File(path) => SessionCapture {
            text: None,
            path: Some(path),
            truncated: None,
            total_bytes: None,
            sha256: None,
            artifact: None,
            preview_bytes: None,
            preview_lossy: None,
        },
        StreamCapture::Bounded(value) => SessionCapture {
            text: Some(value.preview),
            path: None,
            truncated: Some(value.truncated),
            total_bytes: Some(value.total_bytes),
            sha256: Some(value.sha256),
            artifact: value.artifact,
            preview_bytes: Some(value.preview_raw_bytes),
            preview_lossy: Some(value.preview_lossy),
        },
        StreamCapture::None => SessionCapture {
            text: None,
            path: None,
            truncated: None,
            total_bytes: None,
            sha256: None,
            artifact: None,
            preview_bytes: None,
            preview_lossy: None,
        },
    }
}

fn join_err(error: tokio::task::JoinError, stream: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::Internal,
        "process.session",
        format!("{stream} capture task failed: {error}"),
    )
}

fn not_found(id: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::NotFound,
        "process.session",
        format!("no session with id `{id}`"),
    )
    .with_details(serde_json::json!({"reason": "session_not_found"}))
}

fn session_closing(id: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::Conflict,
        "process.session",
        format!("session `{id}` is closing"),
    )
    .with_details(serde_json::json!({"reason": "session_closing", "session_id": id}))
}

fn session_closing_or_not_found(id: &str, sessions: &HashMap<String, Session>) -> ToolError {
    if sessions.contains_key(id) {
        session_closing(id)
    } else {
        not_found(id)
    }
}

fn spawn_err(e: std::io::Error, program: &str) -> ToolError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ToolErrorCode::SpawnFailed,
        std::io::ErrorKind::PermissionDenied => ToolErrorCode::PermissionDenied,
        _ => ToolErrorCode::SpawnFailed,
    };
    ToolError::new(
        code,
        "process.session",
        format!("failed to spawn `{program}`: {e}"),
    )
    .with_program(program)
}

fn io_err(e: std::io::Error, op: &str) -> ToolError {
    ToolError::new(ToolErrorCode::IoError, op, e.to_string())
}

#[cfg(unix)]
fn sig_name(s: i32) -> &'static str {
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
