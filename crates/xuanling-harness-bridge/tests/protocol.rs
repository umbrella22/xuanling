//! W1/W3 protocol tests: the compiled bridge speaks newline-delimited JSON-RPC
//! over stdio, exposes exactly the four control tools, reports honest health
//! limits/capabilities, and maps domain failures to structured tool errors and
//! protocol failures to JSON-RPC `-32602`.

mod support;

use std::path::{Path, PathBuf};

fn write_config(temp: &Path) -> PathBuf {
    let path = temp.join("bridge-config.json");
    std::fs::write(&path, "{}").expect("write empty adapter config");
    path
}

fn start(temp: &Path) -> support::McpProcess {
    let mut process = support::McpProcess::start(&write_config(temp));
    process.initialize();
    process
}

fn health(process: &mut support::McpProcess) -> serde_json::Value {
    let response = support::call_tool(process, "harness_health", serde_json::json!({}));
    support::tool_structured(&response).clone()
}

#[test]
fn tools_list_has_exactly_the_four_control_tools() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut server = start(temp.path());

    let response = server.request("tools/list", None);
    let tools = response["result"]["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("tools/list returned no tools: {response}"));
    let mut names: Vec<String> = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name").to_string())
        .collect();
    names.sort();
    assert_eq!(
        names,
        vec![
            "harness_cancel".to_string(),
            "harness_health".to_string(),
            "harness_submit".to_string(),
            "harness_wait".to_string(),
        ],
        "the public surface must stay at four tools"
    );

    let submit = tools
        .iter()
        .find(|tool| tool["name"] == "harness_submit")
        .expect("harness_submit exists");
    let required = submit["inputSchema"]["required"]
        .as_array()
        .unwrap_or_else(|| panic!("harness_submit has no required list: {submit}"));
    assert!(
        required
            .iter()
            .any(|field| field.as_str() == Some("instance_id")),
        "harness_submit must require instance_id: {required:?}"
    );
    assert_eq!(submit["inputSchema"]["type"].as_str(), Some("object"));

    let status = server.shutdown();
    assert!(status.success(), "bridge exited uncleanly: {status}");
}

#[test]
fn health_reports_instance_limits_and_capabilities() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut server = start(temp.path());

    let health = health(&mut server);
    let instance = health["instance_id"]
        .as_str()
        .expect("health reports instance_id");
    assert!(
        instance.starts_with("inst-"),
        "unexpected instance: {instance}"
    );

    let adapters = health["adapters"]
        .as_array()
        .unwrap_or_else(|| panic!("health reports no adapters: {health}"));
    let mut ids: Vec<&str> = adapters
        .iter()
        .map(|adapter| adapter["id"].as_str().expect("adapter id"))
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["claude", "codex", "dsh", "zcode"]);
    for adapter in adapters {
        assert_eq!(
            adapter["configured"].as_bool(),
            Some(false),
            "no adapter is configured in this instance: {adapter}"
        );
    }

    let limits = &health["limits"];
    assert!(limits["default_deadline_at"].is_null());
    assert!(limits["consumption_budget"].is_null());

    let capabilities = &health["capabilities"];
    for key in [
        "persistent_state",
        "cross_instance_dedupe",
        "restart_recovery",
        "process_logs_exposed",
    ] {
        assert_eq!(
            capabilities[key].as_bool(),
            Some(false),
            "capability {key} must be false: {capabilities}"
        );
    }

    let status = server.shutdown();
    assert!(status.success(), "bridge exited uncleanly: {status}");
}

#[test]
fn submit_with_unconfigured_adapter_is_a_typed_tool_error() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut server = start(temp.path());

    let instance = health(&mut server)["instance_id"]
        .as_str()
        .expect("instance id")
        .to_string();
    let response = support::call_tool(
        &mut server,
        "harness_submit",
        serde_json::json!({
            "instance_id": instance,
            "request_id": "req-adapter",
            "adapter": "codex",
            "workspace_id": "test",
            "prompt": "hello",
            "save_result": false,
        }),
    );
    assert_eq!(
        response["result"]["isError"].as_bool(),
        Some(true),
        "unconfigured adapter must be a tool-level error: {response}"
    );
    let error = support::tool_structured(&response);
    assert_eq!(error["code"].as_str(), Some("ADAPTER_UNAVAILABLE"));

    let status = server.shutdown();
    assert!(status.success(), "bridge exited uncleanly: {status}");
}

#[test]
fn unknown_jobs_distinguish_context_loss_from_not_found() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut server = start(temp.path());

    let instance = health(&mut server)["instance_id"]
        .as_str()
        .expect("instance id")
        .to_string();

    let foreign = "inst-00000000000000000000000000000000-job-x";
    let response = support::call_tool(
        &mut server,
        "harness_wait",
        serde_json::json!({"job_id": foreign}),
    );
    assert_eq!(response["result"]["isError"].as_bool(), Some(true));
    let error = support::tool_structured(&response);
    assert_eq!(error["code"].as_str(), Some("JOB_CONTEXT_LOST"));

    let unknown = format!("{instance}-job-missing");
    let response = support::call_tool(
        &mut server,
        "harness_wait",
        serde_json::json!({"job_id": unknown}),
    );
    assert_eq!(response["result"]["isError"].as_bool(), Some(true));
    let error = support::tool_structured(&response);
    assert_eq!(error["code"].as_str(), Some("JOB_NOT_FOUND"));

    let response = support::call_tool(
        &mut server,
        "harness_cancel",
        serde_json::json!({"job_id": unknown}),
    );
    assert_eq!(response["result"]["isError"].as_bool(), Some(true));
    let error = support::tool_structured(&response);
    assert_eq!(error["code"].as_str(), Some("JOB_NOT_FOUND"));

    let status = server.shutdown();
    assert!(status.success(), "bridge exited uncleanly: {status}");
}

#[test]
fn unknown_tools_and_malformed_arguments_are_invalid_params() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut server = start(temp.path());

    let response = server.request(
        "tools/call",
        Some(serde_json::json!({
            "name": "harness_events",
            "arguments": {},
        })),
    );
    assert_eq!(
        support::rpc_error_code(&response),
        -32602,
        "unknown tools are protocol errors: {response}"
    );

    // Unknown field on a closed request struct.
    let response = support::call_tool(
        &mut server,
        "harness_wait",
        serde_json::json!({"job_id": "x", "unexpected": 1}),
    );
    assert_eq!(support::rpc_error_code(&response), -32602);

    // Wrong JSON type for a required field.
    let response = support::call_tool(
        &mut server,
        "harness_wait",
        serde_json::json!({"job_id": 42}),
    );
    assert_eq!(support::rpc_error_code(&response), -32602);

    // Missing required fields.
    let response = support::call_tool(
        &mut server,
        "harness_submit",
        serde_json::json!({"request_id": "req-only"}),
    );
    assert_eq!(support::rpc_error_code(&response), -32602);

    // Unknown field on the health request.
    let response = support::call_tool(
        &mut server,
        "harness_health",
        serde_json::json!({"probe_credentials": true}),
    );
    assert_eq!(support::rpc_error_code(&response), -32602);

    let status = server.shutdown();
    assert!(status.success(), "bridge exited uncleanly: {status}");
}
