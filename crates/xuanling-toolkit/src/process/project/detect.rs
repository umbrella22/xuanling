//! `project_detect` — ecosystem marker discovery (plan §7.4).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ProjectEcosystem {
    Rust,
    Node,
    Flutter,
    Gradle,
    Go,
    Python,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectDetectRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProjectDetectResult {
    pub path: String,
    pub ecosystems: Vec<ProjectEcosystem>,
    pub toolchains: Vec<String>,
    pub markers: Vec<String>,
}

/// Detect ecosystems by marker files in `path` (non-recursive: only the top
/// level of the project dir, matching common toolchain behavior). Does not
/// execute any build script.
pub fn project_detect(
    ctx: &InvocationContext,
    req: &ProjectDetectRequest,
) -> Result<ProjectDetectResult, ToolError> {
    let path = ctx.resolve_path(
        Path::new(&req.path),
        req.base_dir.as_deref().map(Path::new),
        PathAccess::Read,
        "project.detect",
    )?;
    if !path.is_dir() {
        return Err(ToolError::new(
            ToolErrorCode::NotDirectory,
            "project.detect",
            "project path is not a directory",
        )
        .with_path(path.to_string_lossy()));
    }

    let entries: Vec<String> = std::fs::read_dir(&path)
        .map_err(|e| map_io_err(&e, &path))?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();

    let mut ecosystems = Vec::new();
    let mut toolchains: Vec<String> = Vec::new();
    let mut markers = Vec::new();

    // Rust
    if has_marker(&entries, "Cargo.toml") || any_prefix(&entries, "rust-toolchain") {
        ecosystems.push(ProjectEcosystem::Rust);
        toolchains.extend(["cargo", "rustc"].iter().map(|s| s.to_string()));
        markers.push("Cargo.toml/rust-toolchain".to_string());
    }
    // Node
    if has_marker(&entries, "package.json") {
        ecosystems.push(ProjectEcosystem::Node);
        // Lockfile selects the package manager (resolved deterministically in
        // project_command; here we just record candidates).
        let pm = detect_node_pm(&entries);
        toolchains.extend(pm.iter().map(|s| s.to_string()));
        markers.push("package.json".to_string());
    }
    // Flutter/Dart
    if has_marker(&entries, "pubspec.yaml") {
        ecosystems.push(ProjectEcosystem::Flutter);
        toolchains.extend(["flutter", "dart"].iter().map(|s| s.to_string()));
        markers.push("pubspec.yaml".to_string());
    }
    // Gradle/Android
    if any_prefix(&entries, "gradlew")
        || any_glob(&entries, "settings.gradle*")
        || any_glob(&entries, "build.gradle*")
    {
        ecosystems.push(ProjectEcosystem::Gradle);
        toolchains.push("gradle".to_string());
        markers.push("gradlew/settings.gradle/build.gradle".to_string());
    }
    // Go
    if has_marker(&entries, "go.mod") || has_marker(&entries, "go.work") {
        ecosystems.push(ProjectEcosystem::Go);
        toolchains.push("go".to_string());
        markers.push("go.mod/go.work".to_string());
    }
    // Python
    if has_marker(&entries, "pyproject.toml")
        || has_marker(&entries, "uv.lock")
        || has_marker(&entries, "poetry.lock")
        || any_glob(&entries, "requirements*.txt")
    {
        ecosystems.push(ProjectEcosystem::Python);
        toolchains.extend(["uv", "poetry", "python"].iter().map(|s| s.to_string()));
        markers.push("pyproject.toml/uv.lock/poetry.lock/requirements*.txt".to_string());
    }

    if ecosystems.is_empty() {
        ecosystems.push(ProjectEcosystem::Unknown);
    }

    // Dedupe toolchains preserving order.
    toolchains.dedup();

    Ok(ProjectDetectResult {
        path: path.to_string_lossy().into_owned(),
        ecosystems,
        toolchains,
        markers,
    })
}

fn detect_node_pm(entries: &[String]) -> Vec<&'static str> {
    let mut pms = Vec::new();
    if has_marker(entries, "pnpm-lock.yaml") {
        pms.push("pnpm");
    }
    if has_marker(entries, "yarn.lock") {
        pms.push("yarn");
    }
    if has_marker(entries, "bun.lockb") || has_marker(entries, "bun.lock") {
        pms.push("bun");
    }
    // npm is the default fallback.
    pms.push("npm");
    pms
}

fn has_marker(entries: &[String], name: &str) -> bool {
    entries.iter().any(|e| e == name)
}

fn any_prefix(entries: &[String], prefix: &str) -> bool {
    entries.iter().any(|e| e.starts_with(prefix))
}

fn any_glob(entries: &[String], pattern: &str) -> bool {
    let g = globset::GlobBuilder::new(pattern)
        .build()
        .ok()
        .map(|g| g.compile_matcher());
    match g {
        Some(m) => entries.iter().any(|e| m.is_match(e)),
        None => false,
    }
}

fn map_io_err(e: &std::io::Error, path: &Path) -> ToolError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ToolErrorCode::NotFound,
        std::io::ErrorKind::PermissionDenied => ToolErrorCode::PermissionDenied,
        _ => ToolErrorCode::IoError,
    };
    ToolError::new(code, "project.detect", e.to_string())
        .with_path(path.to_string_lossy())
        .with_raw_os_error(e.raw_os_error())
}
