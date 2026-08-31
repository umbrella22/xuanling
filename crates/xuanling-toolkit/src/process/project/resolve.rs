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

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct ProjectRunResult {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub reason: String,
    pub ecosystem: ProjectEcosystem,
    pub action: ProjectAction,
    /// Process terminal facts remain top-level on the wire for compatibility;
    /// resolver facts above and execution facts below come from one decision.
    #[serde(flatten)]
    pub process: super::super::run::ProcessRunResult,
}

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
        program: resolved.program.clone(),
        args: resolved.args.clone(),
        cwd: Some(resolved.cwd.clone()),
        env: BTreeMap::new(),
        remove_env: Vec::new(),
        inherit_env: req.inherit_env,
        stdin: None,
        stdout: req.stdout.clone(),
        stderr: req.stderr.clone(),
        preview_max_bytes: req.preview_max_bytes,
        deterministic: req.deterministic,
    };
    let process = process_run(ctx, &run_req).await?;
    Ok(ProjectRunResult {
        program: resolved.program,
        args: resolved.args,
        cwd: resolved.cwd,
        reason: resolved.reason,
        ecosystem: resolved.ecosystem,
        action: req.action.clone(),
        process,
    })
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
        ProjectAction::FormatCheck => {
            vec!["fmt".to_string(), "--".to_string(), "--check".to_string()]
        }
        ProjectAction::FormatApply => vec!["fmt".to_string()],
        ProjectAction::Lint => vec!["clippy".to_string()],
        ProjectAction::Run => vec!["run".to_string()],
    };
    if let Some(t) = target {
        let target_args = ["-p".to_string(), t.to_string()];
        if matches!(action, ProjectAction::FormatCheck) {
            args.splice(1..1, target_args);
        } else {
            args.extend(target_args);
        }
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
    let manifest_path = project_root.join("package.json");
    let manifest_bytes = std::fs::read(&manifest_path).map_err(|error| {
        ToolError::new(
            match error.kind() {
                std::io::ErrorKind::NotFound => ToolErrorCode::NotFound,
                std::io::ErrorKind::PermissionDenied => ToolErrorCode::PermissionDenied,
                _ => ToolErrorCode::IoError,
            },
            "project.command",
            format!("failed to read package.json: {error}"),
        )
        .with_path(manifest_path.to_string_lossy())
        .with_raw_os_error(error.raw_os_error())
    })?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest_bytes).map_err(|error| {
        ToolError::new(
            ToolErrorCode::InvalidInput,
            "project.command",
            format!("package.json is not valid JSON: {error}"),
        )
        .with_path(manifest_path.to_string_lossy())
        .with_details(serde_json::json!({"reason": "invalid_package_json"}))
    })?;
    let scripts = manifest
        .get("scripts")
        .and_then(serde_json::Value::as_object);

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
    let exact_name = action_name(action);
    let selected_script = if let Some(target) = target {
        require_node_script(scripts, target, action)?;
        Some((target, "explicit target script"))
    } else if has_node_script(scripts, exact_name) {
        Some((exact_name, "exact action script"))
    } else {
        node_conventional_script(scripts, action)
    };

    if let Some((script, source)) = selected_script {
        let mut args = vec!["run".to_string(), script.to_string()];
        args.extend_from_slice(extra_args);
        return Ok((
            node_package_manager_executable(pm),
            args,
            format!("selected {pm} {source} `{script}`"),
        ));
    }

    if matches!(action, ProjectAction::Check)
        && has_typescript_dependency(&manifest)
        && project_root.join("tsconfig.json").is_file()
    {
        let mut args: Vec<String> = match pm {
            "npm" => vec!["exec", "--", "tsc", "--noEmit"],
            "bun" => vec!["x", "tsc", "--noEmit"],
            _ => vec!["exec", "tsc", "--noEmit"],
        }
        .into_iter()
        .map(str::to_string)
        .collect();
        args.extend_from_slice(extra_args);
        return Ok((
            node_package_manager_executable(pm),
            args,
            format!("selected {pm} TypeScript convention `tsc --noEmit`"),
        ));
    }

    Err(unsupported_action(
        ProjectEcosystem::Node,
        action,
        "no exact package script or proven nonmutating convention",
    ))
}

fn node_package_manager_executable(package_manager: &str) -> String {
    if cfg!(target_os = "windows") {
        match package_manager {
            "bun" => "bun.exe".to_string(),
            _ => format!("{package_manager}.cmd"),
        }
    } else {
        package_manager.to_string()
    }
}

fn action_name(action: &ProjectAction) -> &'static str {
    match action {
        ProjectAction::Check => "check",
        ProjectAction::Test => "test",
        ProjectAction::Build => "build",
        ProjectAction::FormatCheck => "format_check",
        ProjectAction::FormatApply => "format_apply",
        ProjectAction::Lint => "lint",
        ProjectAction::Run => "run",
    }
}

fn has_node_script(
    scripts: Option<&serde_json::Map<String, serde_json::Value>>,
    name: &str,
) -> bool {
    scripts
        .and_then(|scripts| scripts.get(name))
        .is_some_and(serde_json::Value::is_string)
}

fn require_node_script(
    scripts: Option<&serde_json::Map<String, serde_json::Value>>,
    target: &str,
    action: &ProjectAction,
) -> Result<(), ToolError> {
    if has_node_script(scripts, target) {
        return Ok(());
    }
    Err(unsupported_action(
        ProjectEcosystem::Node,
        action,
        &format!("explicit target script `{target}` is not defined"),
    ))
}

fn node_conventional_script(
    scripts: Option<&serde_json::Map<String, serde_json::Value>>,
    action: &ProjectAction,
) -> Option<(&'static str, &'static str)> {
    let candidates: &[&str] = match action {
        ProjectAction::FormatCheck => &["format:check", "fmt:check"],
        ProjectAction::FormatApply => &["format", "fmt"],
        ProjectAction::Run => &["start"],
        _ => &[],
    };
    candidates
        .iter()
        .copied()
        .find(|candidate| has_node_script(scripts, candidate))
        .map(|candidate| (candidate, "conventional script"))
}

fn has_typescript_dependency(manifest: &serde_json::Value) -> bool {
    ["devDependencies", "dependencies", "peerDependencies"]
        .iter()
        .filter_map(|section| manifest.get(section).and_then(serde_json::Value::as_object))
        .any(|dependencies| dependencies.contains_key("typescript"))
}

fn unsupported_action(
    ecosystem: ProjectEcosystem,
    action: &ProjectAction,
    reason: &str,
) -> ToolError {
    ToolError::new(
        ToolErrorCode::Unsupported,
        "project.command",
        format!(
            "cannot resolve `{}` for {}: {reason}",
            action_name(action),
            ecosystem_name(&ecosystem)
        ),
    )
    .with_details(serde_json::json!({
        "reason": "unsupported_project_action",
        "ecosystem": ecosystem_name(&ecosystem),
        "action": action_name(action),
    }))
}

fn ecosystem_name(ecosystem: &ProjectEcosystem) -> &'static str {
    match ecosystem {
        ProjectEcosystem::Rust => "rust",
        ProjectEcosystem::Node => "node",
        ProjectEcosystem::Flutter => "flutter",
        ProjectEcosystem::Gradle => "gradle",
        ProjectEcosystem::Go => "go",
        ProjectEcosystem::Python => "python",
        ProjectEcosystem::Unknown => "unknown",
    }
}

fn resolve_flutter(
    action: &ProjectAction,
    target: Option<&str>,
    extra_args: &[String],
) -> Result<(String, Vec<String>, String), ToolError> {
    let (program, mut args): (&str, Vec<String>) = match action {
        ProjectAction::Check | ProjectAction::Lint => (
            "flutter",
            vec!["analyze".to_string(), "--no-pub".to_string()],
        ),
        ProjectAction::Test => ("flutter", vec!["test".to_string(), "--no-pub".to_string()]),
        ProjectAction::Build => ("flutter", vec!["build".to_string()]),
        ProjectAction::FormatCheck => (
            "dart",
            vec![
                "format".to_string(),
                "--output=none".to_string(),
                "--set-exit-if-changed".to_string(),
                ".".to_string(),
            ],
        ),
        ProjectAction::FormatApply => ("dart", vec!["format".to_string(), ".".to_string()]),
        ProjectAction::Run => ("flutter", vec!["run".to_string()]),
    };
    if let Some(t) = target {
        if matches!(
            action,
            ProjectAction::FormatCheck | ProjectAction::FormatApply
        ) {
            args.pop();
            args.push(t.to_string());
        } else {
            args.push("--target".to_string());
            args.push(t.to_string());
        }
    }
    args.extend_from_slice(extra_args);
    Ok((
        program.to_string(),
        args,
        format!("{program} is the Dart/Flutter toolchain"),
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
    if matches!(action, ProjectAction::FormatCheck) {
        return Err(unsupported_action(
            ProjectEcosystem::Go,
            action,
            "the Go toolchain has no recursive nonmutating format-check action",
        ));
    }
    let mut args: Vec<String> = match action {
        ProjectAction::Check => vec!["vet".to_string()],
        ProjectAction::Test => vec!["test".to_string()],
        ProjectAction::Build => vec!["build".to_string()],
        ProjectAction::FormatCheck => unreachable!("handled above"),
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
    let Some(target) = target else {
        return Err(unsupported_action(
            ProjectEcosystem::Python,
            action,
            "pyproject.toml does not define a standard action-script table; provide an explicit target",
        ));
    };
    let mut args: Vec<String> = if pm == "python" {
        vec![target.to_string()]
    } else {
        vec!["run".to_string(), target.to_string()]
    };
    args.extend_from_slice(extra_args);
    Ok((
        pm.to_string(),
        args,
        format!("selected {pm} by lockfile presence"),
    ))
}
