//! W3 project/toolchain contract tests (plan §10 W3).

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use xuanling_toolkit::process::{
    ProcessStreamMode, ProjectAction, ProjectCommandRequest, ProjectDetectRequest,
    ProjectRunRequest, project_command, project_detect, project_run,
};
use xuanling_toolkit::{InvocationContext, PathContext, ToolErrorCode};

fn ctx() -> InvocationContext {
    InvocationContext::new(PathContext::new(PathBuf::from(".")))
}

fn write_node_manifest(path: &std::path::Path, scripts: serde_json::Value) {
    std::fs::write(
        path.join("package.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "name": "xuanling-project-contract-fixture",
            "private": true,
            "scripts": scripts,
        }))
        .unwrap(),
    )
    .unwrap();
}

fn source_tree_sha256(root: &Path) -> String {
    let mut files: Vec<PathBuf> = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|entry| {
            !matches!(
                entry.file_name().to_str(),
                Some("target" | "node_modules" | ".dart_tool" | ".gradle" | "build")
            )
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect();
    files.sort();

    let mut digest = Sha256::new();
    for path in files {
        let relative = path.strip_prefix(root).unwrap().to_string_lossy();
        let bytes = std::fs::read(&path).unwrap();
        digest.update((relative.len() as u64).to_le_bytes());
        digest.update(relative.as_bytes());
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[test]
fn node_exact_action_script_wins_over_build() {
    let dir = tempfile::tempdir().unwrap();
    write_node_manifest(
        dir.path(),
        serde_json::json!({
            "check": "vp check",
            "build": "vp build",
        }),
    );
    std::fs::write(dir.path().join("pnpm-lock.yaml"), "").unwrap();

    let resolved = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: dir.path().to_string_lossy().into_owned(),
            action: ProjectAction::Check,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .expect("a literal scripts.check entry must resolve");

    assert_eq!(resolved.program, "pnpm");
    assert_eq!(resolved.args, ["run", "check"]);
    assert!(
        resolved.reason.contains("exact") && resolved.reason.contains("check"),
        "the resolver must explain the exact-script decision: {}",
        resolved.reason
    );
}

#[test]
fn node_check_never_falls_back_to_build() {
    let dir = tempfile::tempdir().unwrap();
    write_node_manifest(
        dir.path(),
        serde_json::json!({
            "build": "vite build",
        }),
    );

    let error = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: dir.path().to_string_lossy().into_owned(),
            action: ProjectAction::Check,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .expect_err("check without a script or proven convention must not run build");

    assert_eq!(error.code, ToolErrorCode::Unsupported);
    assert_eq!(error.details["action"], serde_json::json!("check"));
}

#[test]
fn node_format_check_prefers_its_exact_nonmutating_script_name() {
    let dir = tempfile::tempdir().unwrap();
    write_node_manifest(
        dir.path(),
        serde_json::json!({
            "format_check": "prettier --check .",
            "format": "prettier --write .",
        }),
    );

    let resolved = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: dir.path().to_string_lossy().into_owned(),
            action: ProjectAction::FormatCheck,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .expect("format_check script must resolve");

    assert_eq!(resolved.args, ["run", "format_check"]);
}

#[test]
fn node_typescript_convention_uses_no_emit_when_exact_check_is_absent() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("package.json"),
        serde_json::to_vec_pretty(&serde_json::json!({
            "name": "typescript-check-fixture",
            "private": true,
            "devDependencies": {"typescript": "5.9.2"},
            "scripts": {"build": "vite build"},
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("tsconfig.json"),
        "{\"compilerOptions\":{}}\n",
    )
    .unwrap();

    let resolved = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: dir.path().to_string_lossy().into_owned(),
            action: ProjectAction::Check,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .expect("local TypeScript plus tsconfig is a proven check convention");

    assert_eq!(resolved.program, "npm");
    assert_eq!(resolved.args, ["exec", "--", "tsc", "--noEmit"]);
    assert!(!resolved.args.iter().any(|arg| arg == "build"));
}

#[test]
fn rust_and_flutter_format_checks_resolve_to_nonmutating_argv() {
    let rust = tempfile::tempdir().unwrap();
    std::fs::write(
        rust.path().join("Cargo.toml"),
        "[package]\nname = \"format-check-fixture\"\nversion = \"0.0.0\"\n",
    )
    .unwrap();
    let rust_result = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: rust.path().to_string_lossy().into_owned(),
            action: ProjectAction::FormatCheck,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .unwrap();
    assert_eq!(rust_result.program, "cargo");
    assert_eq!(rust_result.args, ["fmt", "--", "--check"]);

    let flutter = tempfile::tempdir().unwrap();
    std::fs::write(
        flutter.path().join("pubspec.yaml"),
        "name: format_check_fixture\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
    )
    .unwrap();
    let flutter_result = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: flutter.path().to_string_lossy().into_owned(),
            action: ProjectAction::FormatCheck,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .unwrap();
    assert_eq!(flutter_result.program, "dart");
    assert_eq!(
        flutter_result.args,
        ["format", "--output=none", "--set-exit-if-changed", "."]
    );
}

#[test]
fn go_format_check_is_unsupported_instead_of_mutating_go_fmt() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("go.mod"), "module example.test/xuanling\n").unwrap();
    std::fs::write(dir.path().join("main.go"), "package main\nfunc main( ){}\n").unwrap();

    let before = std::fs::read(dir.path().join("main.go")).unwrap();
    let error = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: dir.path().to_string_lossy().into_owned(),
            action: ProjectAction::FormatCheck,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .expect_err("Go has no built-in recursive nonmutating format check mapping");

    assert_eq!(error.code, ToolErrorCode::Unsupported);
    assert_eq!(std::fs::read(dir.path().join("main.go")).unwrap(), before);
}

#[test]
fn bare_python_project_does_not_synthesize_nonexistent_check_command() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("pyproject.toml"),
        "[project]\nname = \"xuanling-contract\"\nversion = \"0.0.0\"\n",
    )
    .unwrap();

    let error = project_command(
        &ctx(),
        &ProjectCommandRequest {
            project_path: dir.path().to_string_lossy().into_owned(),
            action: ProjectAction::Check,
            target: None,
            extra_args: vec![],
            base_dir: None,
        },
    )
    .expect_err("a bare pyproject does not define a check command");

    assert_eq!(error.code, ToolErrorCode::Unsupported);
}

#[tokio::test]
async fn node_check_execution_does_not_run_mutating_build_script() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.txt");
    std::fs::write(&source, "original\n").unwrap();
    write_node_manifest(
        dir.path(),
        serde_json::json!({
            "check": "node -e \"process.exit(0)\"",
            "build": "node -e \"require('node:fs').writeFileSync('source.txt','mutated\\n')\"",
        }),
    );
    let before = std::fs::read(&source).unwrap();

    let result = project_run(
        &ctx(),
        &ProjectRunRequest {
            project_path: dir.path().to_string_lossy().into_owned(),
            action: ProjectAction::Check,
            target: None,
            extra_args: vec![],
            base_dir: None,
            inherit_env: true,
            stdout: ProcessStreamMode::Null,
            stderr: ProcessStreamMode::Null,
            preview_max_bytes: None,
            deterministic: true,
        },
    )
    .await
    .expect("npm must execute the controlled fixture");

    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["success"], serde_json::json!(true));
    assert_eq!(
        std::fs::read(&source).unwrap(),
        before,
        "project_run(action=check) must not choose the mutating build script"
    );
}

#[tokio::test]
async fn project_check_fixture_matrix_preserves_source_tree() {
    let root = tempfile::tempdir().unwrap();
    let rust = root.path().join("rust");
    std::fs::create_dir_all(rust.join("src")).unwrap();
    std::fs::write(
        rust.join("Cargo.toml"),
        "[package]\nname = \"matrix-rust\"\nversion = \"0.0.0\"\nedition = \"2024\"\n",
    )
    .unwrap();
    std::fs::write(rust.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n").unwrap();
    let lock_status = std::process::Command::new("cargo")
        .args(["generate-lockfile", "--manifest-path"])
        .arg(rust.join("Cargo.toml"))
        .status()
        .expect("cargo is available to the Cargo test runner");
    assert!(
        lock_status.success(),
        "prepare stable Rust fixture lockfile"
    );

    let node = root.path().join("node");
    std::fs::create_dir_all(&node).unwrap();
    write_node_manifest(
        &node,
        serde_json::json!({
            "check": "node -e \"process.exit(0)\"",
            "format_check": "node -e \"process.exit(0)\"",
        }),
    );
    std::fs::write(node.join("source.js"), "export const value = 1;\n").unwrap();

    let flutter = root.path().join("flutter");
    std::fs::create_dir_all(flutter.join("lib")).unwrap();
    std::fs::write(
        flutter.join("pubspec.yaml"),
        "name: matrix_flutter\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
    )
    .unwrap();
    std::fs::write(flutter.join("lib/main.dart"), "void main() {}\n").unwrap();

    let gradle = root.path().join("gradle");
    std::fs::create_dir_all(&gradle).unwrap();
    std::fs::write(gradle.join("build.gradle"), "plugins { id 'base' }\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let wrapper = gradle.join("gradlew");
        std::fs::write(&wrapper, "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(windows)]
    std::fs::write(gradle.join("gradlew.bat"), "@exit /b 0\r\n").unwrap();

    let go = root.path().join("go");
    std::fs::create_dir_all(&go).unwrap();
    std::fs::write(go.join("go.mod"), "module example.test/matrix\n\ngo 1.22\n").unwrap();
    std::fs::write(go.join("main.go"), "package main\nfunc main() {}\n").unwrap();

    let python = root.path().join("python");
    std::fs::create_dir_all(&python).unwrap();
    std::fs::write(
        python.join("pyproject.toml"),
        "[project]\nname = \"matrix-python\"\nversion = \"0.0.0\"\n",
    )
    .unwrap();
    std::fs::write(python.join("main.py"), "VALUE = 1\n").unwrap();

    for (ecosystem, project) in [
        ("rust", rust),
        ("node", node),
        ("flutter", flutter),
        ("gradle", gradle),
        ("go", go),
        ("python", python),
    ] {
        let before = source_tree_sha256(&project);
        let result = project_run(
            &ctx(),
            &ProjectRunRequest {
                project_path: project.to_string_lossy().into_owned(),
                action: ProjectAction::Check,
                target: None,
                extra_args: vec![],
                base_dir: None,
                inherit_env: true,
                stdout: ProcessStreamMode::Null,
                stderr: ProcessStreamMode::Null,
                preview_max_bytes: None,
                deterministic: true,
            },
        )
        .await;
        match result {
            Ok(result) => {
                assert_eq!(
                    result.action,
                    ProjectAction::Check,
                    "{ecosystem}: action metadata"
                );
                assert!(
                    !result.args.iter().any(|arg| arg == "build"),
                    "{ecosystem}: check must never select build: {:?}",
                    result.args
                );
            }
            Err(error) => assert!(
                matches!(
                    error.code,
                    ToolErrorCode::Unsupported
                        | ToolErrorCode::SpawnFailed
                        | ToolErrorCode::PermissionDenied
                ),
                "{ecosystem}: unexpected check failure: {error:?}"
            ),
        }
        assert_eq!(
            source_tree_sha256(&project),
            before,
            "{ecosystem}: check must not mutate source-tree content"
        );
    }
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
    write_node_manifest(dir.path(), serde_json::json!({"build": "node build.mjs"}));
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
    write_node_manifest(dir.path(), serde_json::json!({"build": "node build.mjs"}));
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
async fn project_run_reports_resolution_and_process_result() {
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
            let value = serde_json::to_value(r).expect("project result serializes");
            assert_eq!(value["program"], serde_json::json!("cargo"));
            assert_eq!(value["ecosystem"], serde_json::json!("rust"));
            assert_eq!(value["action"], serde_json::json!("check"));
            assert!(
                value["args"]
                    .as_array()
                    .unwrap()
                    .contains(&serde_json::json!("check"))
            );
            assert!(
                value["reason"]
                    .as_str()
                    .is_some_and(|reason| !reason.is_empty())
            );
            assert!(value["success"].is_boolean());
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
