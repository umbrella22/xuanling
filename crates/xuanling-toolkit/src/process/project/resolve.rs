//! `project_command` and `project_run` — deterministic program resolution
//! (plan §7.4).
//!
//! `project_command` returns `program + args + cwd + reason` WITHOUT executing.
//! `project_run` calls the resolver then enters `process_run`. When multiple
//! projects/package-managers/targets match and a unique result cannot be
//! determined, return `conflict` with candidates (no silent PATH-order guess).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::detect::{ProjectDetectRequest, ProjectEcosystem, project_detect};
use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;
use crate::process::ProcessStreamMode;
use crate::process::run::{ProcessRunRequest, process_run};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ProjectAction {
    Check,
    Test,
    Build,
    FormatCheck,
    FormatApply,
    Lint,
    Run,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectCommandRequest {
    pub project_path: String,
    pub action: ProjectAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectCommandResult {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub reason: String,
    pub ecosystem: ProjectEcosystem,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectRunRequest {
    pub project_path: String,
    pub action: ProjectAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default)]
    pub extra_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default)]
    pub inherit_env: bool,
    #[serde(default)]
    pub stdout: ProcessStreamMode,
    #[serde(default)]
    pub stderr: ProcessStreamMode,
    /// Per-stream preview byte budget forwarded to `process_run` (ADR 0027 §7.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview_max_bytes: Option<u64>,
    /// Cache-friendly mode forwarded to `process_run` (ADR 0027 修订 2):
    /// omit `duration_ms` from the result.
    #[serde(default)]
    pub deterministic: bool,
}

pub type ProjectRunResult = super::super::run::ProcessRunResult;

/// Resolve a project command to `program + args + cwd + reason` without
/// executing. Returns `conflict` when the ecosystem/package-manager cannot be
/// uniquely determined.
pub fn project_command(
    ctx: &InvocationContext,
    req: &ProjectCommandRequest,
) -> Result<ProjectCommandResult, ToolError> {
    // Resolve the project path against base_dir and canonicalize to an absolute
    // path, then use that absolute path for BOTH lockfile detection and the
    // returned cwd. Previously the original (possibly relative) `project_path`
    // string was forwarded to the resolver, which read lockfiles relative to
    // the server CWD and returned a relative cwd — so a pnpm project could be
    // mis-selected as npm and `project_run` would execute in the wrong dir
    // (review P1).
    let resolved = ctx.resolve_path(
        Path::new(&req.project_path),
        req.base_dir.as_deref().map(Path::new),
        PathAccess::Read,
        "project.command",
    )?;
    let abs_path = std::fs::canonicalize(&resolved).unwrap_or(resolved);
    let abs = abs_path.to_string_lossy().into_owned();

    let detected = project_detect(
        ctx,
        &ProjectDetectRequest {
            path: req.project_path.clone(),
            base_dir: req.base_dir.clone(),
        },
    )?;

    // Pick the (single) ecosystem. Multiple ecosystems -> conflict.
    let real_ecosystems: Vec<&ProjectEcosystem> = detected
        .ecosystems
        .iter()
        .filter(|e| **e != ProjectEcosystem::Unknown)
        .collect();
    if real_ecosystems.len() > 1 {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            "project.command",
            "multiple ecosystems detected; cannot pick one deterministically",
        )
        .with_path(req.project_path.clone())
        .with_details(serde_json::json!({
            "ecosystems": detected.ecosystems,
        })));
    }
    let ecosystem = real_ecosystems
        .first()
        .copied()
        .cloned()
        .unwrap_or(ProjectEcosystem::Unknown);
    if ecosystem == ProjectEcosystem::Unknown {
        return Err(ToolError::new(
            ToolErrorCode::NotFound,
            "project.command",
            "no recognized project ecosystem detected",
        )
        .with_path(req.project_path.clone()));
    }

    let cwd = abs.clone();
    let (program, args, reason) = resolve_command(
        ecosystem,
        &abs,
        &req.action,
        req.target.as_deref(),
        &req.extra_args,
    )?;

    Ok(ProjectCommandResult {
        program,
        args,
        cwd,
        reason,
        ecosystem,
    })
}

/// Run the resolved project command via `process_run`. Composes resolver +
/// process lifecycle; does NOT copy process spawning logic.
pub async fn project_run(
    ctx: &InvocationContext,
    req: &ProjectRunRequest,
) -> Result<ProjectRunResult, ToolError> {
    let resolved = project_command(
        ctx,
        &ProjectCommandRequest {
            project_path: req.project_path.clone(),
            action: req.action.clone(),
            target: req.target.clone(),
            extra_args: req.extra_args.clone(),
            base_dir: req.base_dir.clone(),
        },
    )?;

    let run_req = ProcessRunRequest {
        program: resolved.program,
        args: resolved.args,
        cwd: Some(resolved.cwd),
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: req.inherit_env,
        stdin: None,
        stdout: req.stdout.clone(),
        stderr: req.stderr.clone(),
        preview_max_bytes: req.preview_max_bytes,
        deterministic: req.deterministic,
    };
    process_run(ctx, &run_req).await
}

/// Deterministic per-ecosystem resolution. Produces program+args that contain
/// NO shell string (no `cmd /C`, `sh -c`, `FOO=bar npm test`).
fn resolve_command(
    ecosystem: ProjectEcosystem,
    project_path: &str,
    action: &ProjectAction,
    target: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), ToolError> {
    let project_root = PathBuf::from(project_path);
    match ecosystem {
        ProjectEcosystem::Rust => resolve_rust(action, target, extra_args),
        ProjectEcosystem::Node => resolve_node(&project_root, action, target, extra_args),
        ProjectEcosystem::Flutter => resolve_flutter(action, target, extra_args),
        ProjectEcosystem::Gradle => resolve_gradle(&project_root, action, target, extra_args),
        ProjectEcosystem::Go => resolve_go(action, target, extra_args),
        ProjectEcosystem::Python => resolve_python(&project_root, action, target, extra_args),
        ProjectEcosystem::Unknown => Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "project.command",
            "cannot resolve command for unknown ecosystem",
        )),
    }
}

fn resolve_rust(
    action: &ProjectAction,
    target: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), ToolError> {
    let mut args: Vec<String> = match action {
        ProjectAction::Check => vec!["check".to_string()],
        ProjectAction::Test => vec!["test".to_string()],
        ProjectAction::Build => vec!["build".to_string()],
        ProjectAction::FormatCheck => vec!["fmt".to_string(), "--check".to_string()],
        ProjectAction::FormatApply => vec!["fmt".to_string()],
        ProjectAction::Lint => vec!["clippy".to_string()],
        ProjectAction::Run => vec!["run".to_string()],
    };
    if let Some(t) = target {
        args.push("-p".to_string());
        args.push(t.to_string());
    }
    args.extend_from_slice(extra_args);
    Ok((
        "cargo".to_string(),
        args,
        "cargo is the Rust toolchain".to_string(),
    ))
}

fn resolve_node(
    project_root: &Path,
    action: &ProjectAction,
    target: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), ToolError> {
    // Deterministic PM selection by lockfile (pnpm > yarn > bun > npm).
    let entries = std::fs::read_dir(project_root)
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pm = if entries.iter().any(|e| e == "pnpm-lock.yaml") {
        "pnpm"
    } else if entries.iter().any(|e| e == "yarn.lock") {
        "yarn"
    } else if entries.iter().any(|e| e == "bun.lockb" || e == "bun.lock") {
        "bun"
    } else {
        "npm"
    };
    let script = match action {
        ProjectAction::Check => "run".to_string(),
        ProjectAction::Test => "test".to_string(),
        ProjectAction::Build => "run".to_string(),
        ProjectAction::FormatCheck => "run".to_string(),
        ProjectAction::FormatApply => "run".to_string(),
        ProjectAction::Lint => "run".to_string(),
        ProjectAction::Run => "run".to_string(),
    };
    let mut args = vec![script];
    // Map action to a conventional npm-script name as the target.
    let script_target = match action {
        ProjectAction::Check | ProjectAction::Build => "build",
        ProjectAction::FormatCheck | ProjectAction::FormatApply => "format",
        ProjectAction::Lint => "lint",
        ProjectAction::Run => "start",
        ProjectAction::Test => "",
    };
    if !script_target.is_empty() {
        args.push(script_target.to_string());
    }
    // An explicit target overrides the script name.
    if let Some(t) = target {
        if args.len() > 1 {
            args.pop();
        }
        args.push(t.to_string());
    }
    args.extend_from_slice(extra_args);
    Ok((
        pm.to_string(),
        args,
        format!("selected {pm} by lockfile presence"),
    ))
}

fn resolve_flutter(
    action: &ProjectAction,
    target: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), ToolError> {
    let mut args: Vec<String> = match action {
        ProjectAction::Check => vec!["analyze".to_string()],
        ProjectAction::Test => vec!["test".to_string()],
        ProjectAction::Build => vec!["build".to_string()],
        ProjectAction::FormatCheck => vec![
            "format".to_string(),
            "--output=none".to_string(),
            "--set-exit-if-changed".to_string(),
        ],
        ProjectAction::FormatApply => vec!["format".to_string()],
        ProjectAction::Lint => vec!["analyze".to_string()],
        ProjectAction::Run => vec!["run".to_string()],
    };
    if let Some(t) = target {
        args.push("--target".to_string());
        args.push(t.to_string());
    }
    args.extend_from_slice(extra_args);
    Ok((
        "flutter".to_string(),
        args,
        "flutter is the Dart/Flutter toolchain".to_string(),
    ))
}

fn resolve_gradle(
    project_root: &Path,
    action: &ProjectAction,
    target: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), ToolError> {
    // Wrapper first; POSIX uses ./gradlew, Windows gradlew.bat. The toolkit
    // resolves the wrapper path and spawns it directly (no cmd /C). On Windows
    // if a direct spawn of a .bat is not supported by the platform, the caller
    // gets a typed `unsupported` with a suggested program/args — we do not
    // synthesize a shell string.
    let posix_wrapper = project_root.join("gradlew");
    let win_wrapper = project_root.join("gradlew.bat");
    let (program, reason) = if cfg!(target_os = "windows") {
        if win_wrapper.exists() {
            (
                "gradlew.bat".to_string(),
                "Windows gradle wrapper".to_string(),
            )
        } else {
            (
                "gradle".to_string(),
                "system gradle (no wrapper)".to_string(),
            )
        }
    } else if posix_wrapper.exists() {
        // Use the relative wrapper name so it resolves under cwd.
        ("./gradlew".to_string(), "POSIX gradle wrapper".to_string())
    } else {
        (
            "gradle".to_string(),
            "system gradle (no wrapper)".to_string(),
        )
    };

    let task = match action {
        ProjectAction::Check => "check",
        ProjectAction::Test => "test",
        ProjectAction::Build => "build",
        ProjectAction::FormatCheck => "spotlessCheck",
        ProjectAction::FormatApply => "spotlessApply",
        ProjectAction::Lint => "lint",
        ProjectAction::Run => "run",
    };
    let mut args = vec![task.to_string()];
    if let Some(t) = target {
        args.push(format!("--projects={t}"));
    }
    args.extend_from_slice(extra_args);
    Ok((program, args, reason))
}

fn resolve_go(
    action: &ProjectAction,
    target: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), ToolError> {
    let mut args: Vec<String> = match action {
        ProjectAction::Check => vec!["vet".to_string()],
        ProjectAction::Test => vec!["test".to_string()],
        ProjectAction::Build => vec!["build".to_string()],
        ProjectAction::FormatCheck => vec!["fmt".to_string()],
        ProjectAction::FormatApply => vec!["fmt".to_string()],
        ProjectAction::Lint => vec!["vet".to_string()],
        ProjectAction::Run => vec!["run".to_string()],
    };
    if let Some(t) = target {
        args.push(format!("./{t}"));
    }
    args.extend_from_slice(extra_args);
    Ok(("go".to_string(), args, "go is the Go toolchain".to_string()))
}

fn resolve_python(
    project_root: &Path,
    action: &ProjectAction,
    target: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), ToolError> {
    // uv > poetry > python, by lockfile.
    let entries = std::fs::read_dir(project_root)
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pm = if entries.iter().any(|e| e == "uv.lock") {
        "uv"
    } else if entries.iter().any(|e| e == "poetry.lock") {
        "poetry"
    } else {
        "python"
    };
    let mut args: Vec<String> = match action {
        ProjectAction::Check => vec!["check".to_string()],
        ProjectAction::Test => vec!["test".to_string()],
        ProjectAction::Build => vec!["build".to_string()],
        ProjectAction::FormatCheck => vec!["fmt".to_string(), "--check".to_string()],
        ProjectAction::FormatApply => vec!["fmt".to_string()],
        ProjectAction::Lint => vec!["lint".to_string()],
        ProjectAction::Run => vec!["run".to_string()],
    };
    if let Some(t) = target {
        args.push(t.to_string());
    }
    args.extend_from_slice(extra_args);
    Ok((
        pm.to_string(),
        args,
        format!("selected {pm} by lockfile presence"),
    ))
}
