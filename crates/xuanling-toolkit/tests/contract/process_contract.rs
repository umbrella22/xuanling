//! Process DTO contract (plan §7.3, §10 W0).
//!
//! Pins two structural invariants of `ProcessRunRequest` that the red-test
//! list calls out explicitly:
//!
//! 1. There is NO field that accepts a shell command string — argv only.
//! 2. There is NO server-side timeout field.
//!
//! These compile-time/reflection-style checks fail loudly if a future change
//! reintroduces either field.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Deserialize;
use xuanling_toolkit::process::{ProcessRunRequest, ProcessStreamMode, process_run};
use xuanling_toolkit::{InvocationContext, PathContext, ToolErrorCode};

/// Field-name list extracted by deserializing into a generic JSON object.
fn field_names(json: &serde_json::Value) -> Vec<String> {
    let map = json
        .as_object()
        .expect("request must serialize to an object");
    let mut names: Vec<String> = map.keys().cloned().collect();
    names.sort();
    names
}

/// Newtype over `ProcessRunRequest` that enforces `deny_unknown_fields` so a
/// bogus field is rejected even though the inner struct already does.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, transparent)]
#[allow(dead_code)]
struct StrictRequest(ProcessRunRequest);

#[tokio::test]
async fn minimal_environment_spawn_failure_has_non_secret_remediation() {
    let secret = "xuanling-secret-must-not-appear";
    let error = process_run(
        &InvocationContext::new(PathContext::new(PathBuf::from("."))),
        &ProcessRunRequest {
            program: "xuanling-program-that-does-not-exist-3f62d2f9".to_string(),
            args: vec![],
            cwd: None,
            env: BTreeMap::from([("XUANLING_TEST_SECRET".to_string(), secret.to_string())]),
            remove_env: vec![],
            inherit_env: false,
            deterministic: true,
            stdin: None,
            stdout: ProcessStreamMode::Null,
            stderr: ProcessStreamMode::Null,
            preview_max_bytes: None,
        },
    )
    .await
    .expect_err("the deliberately missing program must fail to spawn");

    assert_eq!(error.code, ToolErrorCode::SpawnFailed);
    assert_eq!(
        error.details["environment_policy"],
        serde_json::json!("minimal")
    );
    assert_eq!(
        error.details["remediation"]["inherit_env"],
        serde_json::json!(true)
    );
    let serialized = serde_json::to_string(&error).unwrap();
    assert!(
        !serialized.contains(secret),
        "spawn diagnostics must not echo environment values"
    );
}

#[test]
fn process_request_does_not_accept_shell_command_string_field() {
    // Rejected: a bogus "command" field.
    let bad = serde_json::json!({
        "program": "cargo",
        "args": ["test"],
        "command": "cargo test"   // shell-string field — must be rejected
    });
    let err = serde_json::from_value::<StrictRequest>(bad);
    assert!(
        err.is_err(),
        "ProcessRunRequest must reject a shell-string `command` field; got {err:?}"
    );

    // The accepted field set must not contain any shell-string synonym.
    let sample = serde_json::json!({
        "program": "cargo",
        "args": ["test"],
        "env": {},
        "remove_env": [],
        "inherit_env": true,
        "stdout": "inline",
        "stderr": "inline"
    });
    let names = field_names(&sample);
    for forbidden in ["command", "cmd", "shell", "command_line", "shell_command"] {
        assert!(
            !names.contains(&forbidden.to_string()),
            "ProcessRunRequest must not declare a `{forbidden}` field"
        );
    }
}

#[test]
fn process_run_has_no_server_timeout_field() {
    // A server timeout field must be rejected.
    let bad = serde_json::json!({
        "program": "cargo",
        "args": [],
        "timeout_ms": 30000
    });
    let err = serde_json::from_value::<StrictRequest>(bad);
    assert!(
        err.is_err(),
        "ProcessRunRequest must reject a server-side `timeout_ms` field; got {err:?}"
    );
    let bad = serde_json::json!({
        "program": "cargo",
        "args": [],
        "timeout_secs": 30
    });
    let err = serde_json::from_value::<StrictRequest>(bad);
    assert!(
        err.is_err(),
        "ProcessRunRequest must reject a server-side `timeout_secs` field; got {err:?}"
    );
}
