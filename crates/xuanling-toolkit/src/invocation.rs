//! Invocation context shared by every toolkit operation (plan §4.3).
//!
//! The toolkit has no global state; per-call inputs travel in an
//! [`InvocationContext`]. The most important field is the [`Cancellation`]
//! handle: the MCP server maps client `notifications/cancelled` onto it, and
//! long-running filesystem/process/database operations must observe it at
//! iteration boundaries (plan §4.3, §13).
//!
//! The toolkit deliberately does NOT define a server-side default timeout.
//! Operations run until completion, I/O failure, or cancellation. Mapping an
//! OS/database "busy" into a synthetic timeout is forbidden (plan §4.3, §13).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::capability::{FilesystemScope, PathAccess};
use crate::error::ToolError;
use crate::path::PathContext;

/// Observable cancellation for one toolkit invocation.
///
/// The trait lets the toolkit observe cancellation without depending on a
/// specific runtime token type. The MCP server adapts `rmcp`'s
/// `CancellationToken` (from `RequestContext.ct`) onto this trait; tests use
/// [`NoCancellation`] or a manual [`ManualCancellation`].
///
/// Implementations only need to provide [`is_cancelled`]; the polling future is
/// supplied by [`InvocationContext::cancellation_blocking`] (which owns an
/// `Arc<dyn Cancellation>` and can poll it safely).
///
/// [`is_cancelled`]: Cancellation::is_cancelled
pub trait Cancellation: Send + Sync {
    /// Returns `true` once the operation should stop.
    fn is_cancelled(&self) -> bool;
}

/// Never-cancelling handle, used by default and by tests that don't care.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoCancellation;

impl Cancellation for NoCancellation {
    #[inline]
    fn is_cancelled(&self) -> bool {
        false
    }
}

/// Test/CLI handle that can be flipped manually from another task.
#[derive(Clone, Default)]
pub struct ManualCancellation {
    flag: Arc<AtomicBool>,
}

impl ManualCancellation {
    pub fn new() -> Self {
        Self::default()
    }

    /// Flip the flag so all clones report `is_cancelled == true`.
    pub fn cancel(&self) {
        self.flag.store(true, Ordering::Release);
    }
}

impl Cancellation for ManualCancellation {
    #[inline]
    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }
}

/// Per-invocation inputs: cancellation handle, path resolution context, and
/// the optional convenience default namespace for memory tools.
///
/// `base_dir` is a *resolution context only* (plan §4.1): relative paths
/// resolve against it, but the toolkit never rejects absolute paths or parent
/// traversal "escaping" it. It is NOT a sandbox root, trust root, or policy
/// boundary.
#[derive(Clone)]
pub struct InvocationContext {
    cancellation: Arc<dyn Cancellation>,
    pub path_context: PathContext,
    filesystem_scope: FilesystemScope,
    /// Optional convenience default namespace for memory operations. A request
    /// may always override it; it is never a security boundary.
    pub default_namespace: Option<String>,
}

/// A boxed future returned by [`InvocationContext::cancellation_blocking`].
pub type CancelFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

impl InvocationContext {
    pub fn new(path_context: PathContext) -> Self {
        Self {
            cancellation: Arc::new(NoCancellation),
            path_context,
            filesystem_scope: FilesystemScope::Unrestricted,
            default_namespace: None,
        }
    }

    pub fn with_cancellation(mut self, cancellation: Arc<dyn Cancellation>) -> Self {
        self.cancellation = cancellation;
        self
    }

    pub fn with_default_namespace(mut self, namespace: impl Into<String>) -> Self {
        self.default_namespace = Some(namespace.into());
        self
    }

    pub fn with_filesystem_scope(mut self, scope: FilesystemScope) -> Self {
        self.filesystem_scope = scope;
        self
    }

    pub fn filesystem_scope(&self) -> &FilesystemScope {
        &self.filesystem_scope
    }

    pub fn resolve_path(
        &self,
        path: &std::path::Path,
        request_base: Option<&std::path::Path>,
        access: PathAccess,
        operation: &str,
    ) -> Result<std::path::PathBuf, ToolError> {
        // A request-level base is itself relative to the invocation context.
        // In workspace mode, an existing base alias is then frozen to its
        // physical directory before joining a relative target. This gives a
        // base locator different semantics from the actual target: target
        // symlinks remain lexical and are checked by `FilesystemScope`.
        //
        // The default context base needs the same treatment for CLI
        // `--base-dir` aliases. Do not validate it for an absolute target,
        // however: an absolute target does not use that resolution context.
        let lexical_base = if let Some(base) = request_base {
            Some(self.path_context.resolve(base, None))
        } else if path.is_relative() {
            Some(self.path_context.base_dir.clone())
        } else {
            None
        };
        let effective_base = lexical_base
            .as_deref()
            .map(|base| self.filesystem_scope.resolve_base(base, operation))
            .transpose()?;
        let candidate = self.path_context.resolve(path, effective_base.as_deref());
        self.filesystem_scope
            .validate(&candidate, access, operation)
    }

    /// Reference to the cancellation handle for this invocation.
    pub fn cancellation(&self) -> Arc<dyn Cancellation> {
        Arc::clone(&self.cancellation)
    }

    /// A future that completes when this invocation is cancelled. Used by
    /// long-running tools (`process_run`, recursive traversals) to race against
    /// cancellation in `tokio::select!`.
    ///
    /// Polls `is_cancelled` every 25ms. The MCP server adapter may supply a
    /// tighter integration via `rmcp`'s token, but the polling baseline is
    /// sufficient and runtime-agnostic.
    pub fn cancellation_blocking(&self) -> CancelFuture {
        let token = Arc::clone(&self.cancellation);
        Box::pin(async move {
            while !token.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
    }
}
