//! `process_which` — resolve a bare program name against PATH/PATHEXT (plan §7.3).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::error::{ToolError, ToolErrorCode};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProcessWhichRequest {
    pub program: String,
    /// When true, also return the PATHEXT facts even if the program is found
    /// without a suffix (useful for diagnostics). Default false.
    #[serde(default)]
    pub include_patext_facts: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WhichCandidate {
    pub path: String,
    pub source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProcessWhichResult {
    pub candidates: Vec<WhichCandidate>,
    pub selected: Option<String>,
    /// PATHEXT facts (Windows: the suffix list; other: empty).
    pub pathext: Vec<String>,
}

/// Windows env-var keys are case-insensitive. Merge `env` over the inherited
/// environment using case-insensitive key matching on Windows, exact elsewhere.
fn env_path() -> Result<PathBuf, ToolError> {
    // PATH is uppercased on Windows in practice; look it up case-insensitively.
    env_get_case_fold("PATH", cfg!(target_os = "windows"))
        .map(PathBuf::from)
        .ok_or_else(|| {
            ToolError::new(
                ToolErrorCode::NotFound,
                "process.which",
                "PATH environment variable is not set",
            )
        })
}

/// Case-fold env lookup for Windows (keys case-insensitive), exact elsewhere.
fn env_get_case_fold(key: &str, case_fold: bool) -> Option<String> {
    if !case_fold {
        return std::env::var(key).ok();
    }
    let lower = key.to_ascii_lowercase();
    for (k, v) in std::env::vars() {
        if k.to_ascii_lowercase() == lower {
            return Some(v);
        }
    }
    None
}

fn pathext_list() -> Vec<String> {
    if cfg!(target_os = "windows") {
        env_get_case_fold("PATHEXT", true)
            .unwrap_or_else(|| ".COM;.EXE;.BAT;.CMD".to_string())
            .split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    } else {
        Vec::new()
    }
}

/// Is `path` executable by the current user?
fn is_executable(path: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(path) {
            Ok(m) => m.is_file() && (m.permissions().mode() & 0o111 != 0),
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        std::fs::metadata(path)
            .map(|m| m.is_file())
            .unwrap_or(false)
    }
}

pub fn process_which(req: &ProcessWhichRequest) -> Result<ProcessWhichResult, ToolError> {
    let pathext = pathext_list();
    let path_var = env_path()?;
    let mut candidates: Vec<WhichCandidate> = Vec::new();

    // If the program already contains a path separator or (Windows) a drive,
    // treat it as a direct path and do not search PATH.
    let has_sep = req.program.contains('/')
        || req.program.contains('\\')
        || (cfg!(target_os = "windows") && req.program.contains(':'));

    if has_sep {
        let p = PathBuf::from(&req.program);
        let resolved = resolve_with_suffixes(&p, &pathext);
        if let Some(found) = resolved {
            candidates.push(WhichCandidate {
                path: found.to_string_lossy().into_owned(),
                source: "direct".to_string(),
            });
        }
    } else {
        for dir in path_var
            .to_string_lossy()
            .split(if cfg!(target_os = "windows") {
                ';'
            } else {
                ':'
            })
        {
            if dir.is_empty() {
                continue;
            }
            let base = PathBuf::from(dir).join(&req.program);
            let resolved = resolve_with_suffixes(&base, &pathext);
            if let Some(found) = resolved {
                candidates.push(WhichCandidate {
                    path: found.to_string_lossy().into_owned(),
                    source: "PATH".to_string(),
                });
            }
        }
    }

    let selected = candidates.first().map(|c| c.path.clone());

    Ok(ProcessWhichResult {
        candidates,
        selected,
        pathext: if req.include_patext_facts {
            pathext
        } else {
            Vec::new()
        },
    })
}

/// Given a base path (no suffix), try it as-is then each PATHEXT suffix; return
/// the first existing executable. Off-Windows `pathext` is empty so only the
/// exact path is tried.
fn resolve_with_suffixes(base: &std::path::Path, pathext: &[String]) -> Option<PathBuf> {
    if is_executable(base) {
        return Some(base.to_path_buf());
    }
    for ext in pathext {
        // Append the extension (normalized to start with a dot) to the base.
        let mut s = base.to_string_lossy().into_owned();
        if !ext.starts_with('.') {
            s.push('.');
        }
        s.push_str(ext.trim_start_matches('.'));
        let candidate = PathBuf::from(&s);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}
