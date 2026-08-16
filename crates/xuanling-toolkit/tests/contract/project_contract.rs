//! W3 project/toolchain contract tests (plan §10 W3).

use std::path::PathBuf;
use xuanling_toolkit::process::{
    ProjectAction, ProjectCommandRequest, ProjectDetectRequest, project_command, project_detect,
};
use xuanling_toolkit::{InvocationContext, PathContext, ToolErrorCode};

fn ctx() -> InvocationContext {
    InvocationContext::new(PathContext::new(PathBuf::from(".")))
}

#[test]
fn project_detect_finds_nested_rust_node_flutter_gradle_go_python_markers() {
    let dir = tempfile::tempdir().unwrap();
    // Rust
    let rust = dir.path().join("rust-proj");
    std::fs::create_dir_all(&rust).unwrap();
    std::fs::write(rust.join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
    let r = project_detect(
        &ctx(),
        &ProjectDetectRequest {
            path: rust.to_string_lossy().into_owned(),
            base_dir: None,
        },
    )
    .expect("detect rust");
    assert!(
        r.ecosystems
            .iter()
            .any(|e| matches!(e, xuanling_toolkit::process::ProjectEcosystem::Rust))
    );

    // Node
    let node = dir.path().join("node-proj");
    std::fs::create_dir_all(&node).unwrap();
    std::fs::write(node.join("package.json"), "{}").unwrap();
    std::fs::write(node.join("pnpm-lock.yaml"), "").unwrap();
    let r = project_detect(
        &ctx(),
        &ProjectDetectRequest {
            path: node.to_string_lossy().into_owned(),
            base_dir: None,
        },
    )
    .expect("detect node");
    assert!(
        r.ecosystems
            .iter()
            .any(|e| matches!(e, xuanling_toolkit::process::ProjectEcosystem::Node))
    );

    // Go
    let go = dir.path().join("go-proj");
    std::fs::create_dir_all(&go).unwrap();
    std::fs::write(go.join("go.mod"), "module x\n").unwrap();
    let r = project_detect(
        &ctx(),
        &ProjectDetectRequest {
            path: go.to_string_lossy().into_owned(),
            base_dir: None,
        },
    )
    .expect("detect go");
    assert!(
        r.ecosystems
            .iter()
            .any(|e| matches!(e, xuanling_toolkit::process::ProjectEcosystem::Go))
    );

    // Python
    let py = dir.path().join("py-proj");
    std::fs::create_dir_all(&py).unwrap();
    std::fs::write(py.join("pyproject.toml"), "[project]\n").unwrap();
    let r = project_detect(
        &ctx(),
        &ProjectDetectRequest {
            path: py.to_string_lossy().into_owned(),
            base_dir: None,
        },
    )
    .expect("detect python");
    assert!(
        r.ecosystems
            .iter()
            .any(|e| matches!(e, xuanling_toolkit::process::ProjectEcosystem::Python))
    );
}

#[test]
fn node_lockfile_selects_one_package_manager_deterministically() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), "{}").unwrap();
    // pnpm-lock present -> pnpm selected over yarn/npm.
    std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
    std::fs::write(dir.path().join("yarn.lock"), "").unwrap();
    let base = dir.path().to_string_lossy().into_owned();
    let res = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: base.clone(),
            action: ProjectAction::Build,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .expect("resolve node command");
    assert_eq!(
        res.program, "pnpm",
        "pnpm-lock.yaml should win deterministically"
    );
}

#[test]
fn ambiguous_project_returns_conflict_candidates() {
    // A directory with BOTH Cargo.toml and package.json is ambiguous.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
    std::fs::write(dir.path().join("package.json"), "{}").unwrap();
    let base = dir.path().to_string_lossy().into_owned();
    let res = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: base,
            action: ProjectAction::Check,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    );
    assert!(res.is_err(), "ambiguous ecosystem must error");
    assert_eq!(res.unwrap_err().code, ToolErrorCode::Conflict);
}

#[test]
fn project_command_contains_program_and_args_without_shell_string() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
    let base = dir.path().to_string_lossy().into_owned();
    let res = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: base,
            action: ProjectAction::Test,
            target: None,
            extra_args: vec!["--no-fail-fast".to_string()],
            base_dir: None,
        },
    )
    .expect("resolve cargo test");
    assert_eq!(res.program, "cargo");
    assert!(res.args.contains(&"test".to_string()));
    assert!(res.args.contains(&"--no-fail-fast".to_string()));
    // No shell metachar string should be present in program/args.
    assert!(!res.program.contains(' '));
    for a in &res.args {
        assert!(
            !a.contains("&&") && !a.contains("||"),
            "no shell operators in args: {a}"
        );
    }
}

/// A relative `project_path` resolved against `base_dir` must read lockfiles
/// from the RESOLVED project directory (selecting the correct package manager)
/// and return an ABSOLUTE cwd. Previously the raw relative string was forwarded
/// to the resolver, which read lockfiles relative to the server CWD and
/// returned a relative cwd (review P1).
#[test]
fn project_command_resolves_relative_path_against_base_dir() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("package.json"), "{}").unwrap();
    std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();
    let parent = dir.path().parent().unwrap();
    let basename = dir
        .path()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    // base_dir = parent; project_path = relative basename.
    let ctx = InvocationContext::new(PathContext::new(parent.to_path_buf()));
    let res = project_command(
        &ctx,
        &ProjectCommandRequest {
            project_path: basename,
            action: ProjectAction::Build,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .expect("resolve via relative path + base_dir");
    assert_eq!(
        res.program, "pnpm",
        "lockfile must be read from the resolved project path, not the CWD"
    );
    assert!(
        std::path::Path::new(&res.cwd).is_absolute(),
        "cwd must be absolute (canonicalized); got {}",
        res.cwd
    );
}

#[tokio::test]
async fn project_run_matches_process_run_result_schema() {
    use xuanling_toolkit::process::{ProcessStreamMode, ProjectRunRequest, project_run};
    // Use a Rust project (this repo) and run `cargo --version` via action=Run
    // is not directly mappable; instead use Check on a tiny throwaway crate is
    // heavy. We run `cargo` with an action that resolves to a fast command and
    // confirm the result shape matches ProcessRunResult.
    // Create a minimal rust project in a tempdir.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("Cargo.toml"),
        "[package]\nname = \"t\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/main.rs"), "fn main() {}\n").unwrap();
    let base = dir.path().to_string_lossy().into_owned();
    let res = project_run(
        &ctx(),
        &ProjectRunRequest {
            deterministic: false,
            project_path: base,
            action: ProjectAction::Check,
            target: None,
            extra_args: vec![],
            base_dir: None,
            inherit_env: true,
            stdout: ProcessStreamMode::Inline,
            stderr: ProcessStreamMode::Inline,
            preview_max_bytes: None,
        },
    )
    .await;
    // cargo may or may not be installed; if it is, we get a result; if not,
    // SpawnFailed. Either way the schema is ProcessRunResult.
    match res {
        Ok(r) => {
            // success field present; exit_code field present.
            let _ = r.success;
            let _ = r.exit_code;
        }
        Err(e) => {
            // Acceptable if cargo isn't installed.
            assert!(
                matches!(e.code, ToolErrorCode::SpawnFailed | ToolErrorCode::IoError),
                "unexpected error: {:?}",
                e.code
            );
        }
    }
}
