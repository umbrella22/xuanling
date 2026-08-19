//! Path resolution context and `path_resolve`/`path_relative` tools
//! (plan §4.1, §7.1).
//!
//! [`PathContext`] is a deterministic resolution context, NOT a workspace
//! root, sandbox root, or trust root. Key rules:
//!
//! - Relative paths resolve against `base_dir`.
//! - A request may supply its own `base_dir`/`cwd`, overriding the server
//!   default.
//! - Absolute paths are handed to the OS filesystem unchanged.
//! - `..` components resolve per current OS path semantics; the toolkit does
//!   NOT reject a path merely because it resolves above `base_dir`.
//! - Symlinks do not trigger an "escape" error; traversal follows symlinks
//!   only when an explicit `follow_symlinks` flag is set.
//! - Portable relative paths use `/`; Windows drive/UNC paths pass through.

use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::os::windows::ffi::{OsStrExt, OsStringExt};
#[cfg(windows)]
use std::path::Component;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};

/// Deterministic relative-path resolution context. Not a trust/sandbox root.
#[derive(Clone, Debug)]
pub struct PathContext {
    pub base_dir: PathBuf,
}

impl PathContext {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
        }
    }

    /// Resolution context used when the caller does not override it: the
    /// process current working directory.
    pub fn from_process_cwd() -> std::io::Result<Self> {
        Ok(Self {
            base_dir: std::env::current_dir()?,
        })
    }

    /// Resolve `path` relative to `base_dir` (or an explicit request override),
    /// following standard OS path semantics. Does NOT reject absolute paths or
    /// parent traversal. Returns the resolved [`PathBuf`] without touching the
    /// filesystem.
    ///
    /// `request_base` mirrors the per-request `base_dir`/`cwd` field on tool
    /// requests (plan §4.1): when present it overrides this context's base.
    pub fn resolve(&self, path: &Path, request_base: Option<&Path>) -> PathBuf {
        let base = request_base
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.base_dir.clone());
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            join_relative_preserving_os_semantics(&base, path)
        }
    }
}

/// Join a relative locator without letting `PathBuf::join` normalize away
/// `..` components on Windows verbatim paths. Those components are semantic:
/// the OS must process them after following any preceding symlink rather than
/// before capability validation sees the physical traversal.
pub(crate) fn join_relative_preserving_os_semantics(base: &Path, relative: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let base_is_verbatim = base.components().next().is_some_and(
            |component| {
                matches!(component, Component::Prefix(prefix) if prefix.kind().is_verbatim())
            },
        );
        let relative_has_prefix =
            matches!(relative.components().next(), Some(Component::Prefix(_)));
        if base_is_verbatim
            && !relative.as_os_str().is_empty()
            && !relative.has_root()
            && !relative_has_prefix
        {
            let mut joined = base.as_os_str().to_os_string();
            let base_has_separator = base
                .as_os_str()
                .encode_wide()
                .last()
                .is_some_and(|unit| unit == b'\\' as u16 || unit == b'/' as u16);
            if !base_has_separator {
                joined.push("\\");
            }
            let relative = relative
                .as_os_str()
                .encode_wide()
                .map(|unit| {
                    if unit == b'/' as u16 {
                        b'\\' as u16
                    } else {
                        unit
                    }
                })
                .collect::<Vec<_>>();
            joined.push(OsString::from_wide(&relative));
            return PathBuf::from(joined);
        }
    }

    base.join(relative)
}

impl Default for PathContext {
    fn default() -> Self {
        // Fall back to "." when the cwd is unavailable (e.g. some test runners);
        // tool requests that need a deterministic base should supply one.
        Self {
            base_dir: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    }
}

/// `path_resolve` request (plan §7.1).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PathResolveRequest {
    pub path: String,
    /// Per-request override of the resolution base (plan §4.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    /// When `true`, canonicalize the resolved path via the OS (lexically +
    /// symlinks). When `false` (default), the resolved path is returned even
    /// if the target does not exist.
    #[serde(default)]
    pub canonicalize: bool,
}

/// `path_resolve` result. `path` is the display form; `absolute_path` is the
/// canonicalized form when available.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PathResolveResult {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_path: Option<String>,
    pub exists: bool,
}

/// `path_resolve` operation.
///
/// Semantics (plan §4.1, §7.1):
/// - relative `path` resolves against `base_dir` (request override > context).
/// - absolute `path` passes through unchanged.
/// - `canonicalize=false` allows the target to not exist; `absolute_path` is
///   still populated with a best-effort lexical absolute form.
/// - `canonicalize=true` calls `std::fs::canonicalize`; a missing target
///   yields `not_found`, a permission error yields `permission_denied`.
pub fn resolve(
    ctx: &crate::invocation::InvocationContext,
    req: &PathResolveRequest,
) -> Result<PathResolveResult, ToolError> {
    let raw = Path::new(&req.path);
    let request_base = req.base_dir.as_deref().map(Path::new);
    let resolved = ctx.resolve_path(raw, request_base, PathAccess::Read, "path.resolve")?;

    if req.canonicalize {
        match std::fs::canonicalize(&resolved) {
            Ok(canon) => {
                let exists = true;
                Ok(PathResolveResult {
                    path: display_path(&resolved),
                    absolute_path: Some(display_path(&canon)),
                    exists,
                })
            }
            Err(e) => Err(map_resolve_io_error(&e, &resolved)),
        }
    } else {
        // Best-effort absolute form without requiring the target to exist.
        let absolute_path = lexical_absolute(&resolved, request_base, &ctx.path_context);
        let exists = resolved.exists();
        Ok(PathResolveResult {
            path: display_path(&resolved),
            absolute_path,
            exists,
        })
    }
}

/// `path_relative` request (plan §7.1).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PathRelativeRequest {
    pub path: String,
    pub base_dir: String,
}

/// `path_relative` result. `relative_path` uses `/` as the portable separator.
/// Returns `unsupported` when the two paths cannot be expressed relatively
/// (e.g. cross-drive on Windows).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PathRelativeResult {
    pub relative_path: String,
}

/// `path_relative` operation.
///
/// Expresses `path` relative to `base_dir`. The `base_dir` here is the
/// resolution context supplied by the request, NOT the server startup dir
/// (plan §4.1). Uses `/` as the separator in the result for portability.
pub fn relative(
    _ctx: &crate::invocation::InvocationContext,
    req: &PathRelativeRequest,
) -> Result<PathRelativeResult, ToolError> {
    let path = Path::new(&req.path);
    let base = Path::new(&req.base_dir);

    // Make both absolute (lexically) so `pathdiff`-style logic works on
    // relative inputs without requiring filesystem existence.
    let abs_path = lexical_absolute_standalone(path, base);
    let abs_base = lexical_absolute_standalone(base, base);

    let diff = pathdiff::diff_paths(&abs_path, &abs_base).ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::Unsupported,
            "path.relative",
            format!(
                "cannot express `{}` relative to `{}` (different roots)",
                req.path, req.base_dir
            ),
        )
        .with_path(&req.path)
    })?;

    // Normalize to forward slashes for portability (plan §4.1).
    let relative_path = diff.to_string_lossy().replace(MAIN_SEP_STR, "/");

    Ok(PathRelativeResult { relative_path })
}

/// Main separator as a string literal for the replace call.
const MAIN_SEP_STR: &str = if std::path::MAIN_SEPARATOR == '/' {
    "/"
} else {
    "\\"
};

/// Display form of a path, lossy-converted to a String.
fn display_path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// Map an I/O error from `canonicalize` into a typed `ToolError`.
fn map_resolve_io_error(e: &std::io::Error, path: &Path) -> ToolError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ToolErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ToolErrorCode::PermissionDenied,
        _ => ToolErrorCode::IoError,
    };
    let mut err = ToolError::new(code, "path.resolve", e.to_string()).with_path(display_path(path));
    err = err.with_raw_os_error(e.raw_os_error());
    err
}

/// Lexical absolute form for the non-canonicalizing branch. Joins the resolved
/// path onto the (lexical) absolute base when relative, then lexically
/// normalizes `.`/`..` WITHOUT touching the filesystem (no symlink resolution,
/// no existence check). The result may still contain `..` only if the path
/// escapes above the filesystem root, which is an OS-level oddity, not an
/// error here.
fn lexical_absolute(
    resolved: &Path,
    request_base: Option<&Path>,
    ctx: &PathContext,
) -> Option<String> {
    let joined = if resolved.is_absolute() {
        normalize_lexical(resolved)
    } else {
        // Join onto the lexical-absolute base.
        let base = request_base
            .map(Path::to_path_buf)
            .unwrap_or_else(|| ctx.base_dir.clone());
        let abs_base = lexical_absolute_standalone(&base, &base);
        normalize_lexical(&abs_base.join(resolved))
    };
    Some(display_path(&joined))
}

/// Make `path` lexically absolute relative to `base`, without touching the
/// filesystem (no symlink resolution, no existence check). Used so relative
/// inputs to `path_relative` can be compared on equal footing.
fn lexical_absolute_standalone(path: &Path, base: &Path) -> PathBuf {
    if path.is_absolute() {
        normalize_lexical(path)
    } else {
        // Anchor relative path to base (which itself may be relative; anchor
        // further to the process cwd in that case).
        let anchored_base = if base.is_absolute() {
            base.to_path_buf()
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(base)
        };
        normalize_lexical(&anchored_base.join(path))
    }
}

/// Lexically normalize `.` and `..` components without touching the
/// filesystem. Mirrors what `std::fs::canonicalize` does to component
/// structure, but never resolves symlinks or checks existence.
fn normalize_lexical(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut stack: Vec<Component<'_>> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                // Pop the last normal component if any; keep prefix/root.
                match stack.last() {
                    Some(Component::Normal(_)) => {
                        stack.pop();
                    }
                    _ => stack.push(comp),
                }
            }
            Component::CurDir => {} // drop `.`
            c => stack.push(c),
        }
    }
    let mut out = PathBuf::new();
    for comp in stack {
        out.push(comp.as_os_str());
    }
    if out.as_os_str().is_empty() {
        PathBuf::from(".")
    } else {
        out
    }
}
