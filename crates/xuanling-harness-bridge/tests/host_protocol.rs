//! W3 host protocol smoke tests: the tool descriptions do not promise process
//! logs, restart recovery or automatic continuation, and a representative
//! host `mcpServers` entry parses, names a loadable bridge configuration, and
//! starts the same binary a host would start.

mod support;

use std::path::{Path, PathBuf};

fn write_config(temp: &Path) -> PathBuf {
    let path = temp.join("bridge-config.json");
    std::fs::write(&path, "{}").expect("write empty adapter config");
    path
}

fn tool_descriptions(server: &mut support::McpProcess) -> Vec<String> {
    let response = server.request("tools/list", None);
    response["result"]["tools"]
        .as_array()
        .unwrap_or_else(|| panic!("tools/list returned no tools: {response}"))
        .iter()
        .map(|tool| {
            tool["description"]
                .as_str()
                .unwrap_or_default()
                .to_ascii_lowercase()
        })
        .collect()
}

#[test]
fn tool_descriptions_do_not_promise_unimplemented_capabilities() {
    let temp = tempfile::tempdir().expect("temp dir");
    let mut server = support::McpProcess::start(&write_config(temp.path()));
    let initialize = server.initialize();

    let banned = [
        "replay",
        "event stream",
        "resume a job",
        "restart",
        "recover",
        "log stream",
        "progress event",
        "automatic continuation",
    ];
    for description in tool_descriptions(&mut server) {
        for claim in banned {
            assert!(
                !description.contains(claim),
                "tool descriptions must not promise {claim:?}: {description}"
            );
        }
    }

    let instructions = initialize["result"]["instructions"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    for claim in [
        "replay",
        "event stream",
        "resume a job",
        "restart",
        "recovery",
    ] {
        assert!(
            !instructions.contains(claim),
            "server instructions must not promise {claim:?}: {instructions}"
        );
    }

    let status = server.shutdown();
    assert!(status.success(), "bridge exited uncleanly: {status}");
}

#[test]
fn host_mcp_servers_config_parses_and_the_referenced_config_loads() {
    let temp = tempfile::tempdir().expect("temp dir");
    let config_path = write_config(temp.path());

    // The exact shape a user pastes into a host's `mcpServers` entry.
    let host_config = serde_json::json!({
        "mcpServers": {
            "harness-bridge": {
                "command": env!("CARGO_BIN_EXE_harness-bridge"),
                "args": ["--config", config_path.to_str().expect("utf-8 config path")],
            }
        }
    });
    let host_path = temp.path().join("host-config.json");
    std::fs::write(
        &host_path,
        serde_json::to_vec_pretty(&host_config).expect("serialize host config"),
    )
    .expect("write host config");

    let parsed: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&host_path).expect("read host config"))
            .expect("host config parses");
    let entry = &parsed["mcpServers"]["harness-bridge"];
    let command = entry["command"]
        .as_str()
        .expect("mcpServers command")
        .to_string();
    let args: Vec<String> = entry["args"]
        .as_array()
        .expect("mcpServers args")
        .iter()
        .map(|value| value.as_str().expect("string arg").to_string())
        .collect();
    assert_eq!(command, env!("CARGO_BIN_EXE_harness-bridge"));
    assert_eq!(args.first().map(String::as_str), Some("--config"));

    let referenced = PathBuf::from(args.get(1).expect("config argument"));
    let runtime = xuanling_harness_bridge::config::RuntimeConfig::load(Some(&referenced))
        .expect("the referenced bridge config loads");
    assert!(runtime.adapters.is_empty());
    assert!(runtime.instance_id.starts_with("inst-"));
    assert_eq!(runtime.max_active_jobs, 1);

    // Start exactly the argv the host entry names and perform the handshake.
    let mut server = support::McpProcess::start_command(Path::new(&command), &args);
    server.initialize();
    let response = support::call_tool(&mut server, "harness_health", serde_json::json!({}));
    assert_eq!(
        response["result"]["isError"].as_bool(),
        Some(false),
        "health failed through the host-configured argv: {response}"
    );
    let health = support::tool_structured(&response);
    assert!(
        health["instance_id"]
            .as_str()
            .is_some_and(|id| id.starts_with("inst-")),
        "host-configured bridge must return an instance id: {health}"
    );

    let status = server.shutdown();
    assert!(status.success(), "bridge exited uncleanly: {status}");
}
