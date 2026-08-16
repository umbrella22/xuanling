//! Tool schema snapshot harness (plan §10 W0 task, §6 schema rules).
//!
//! This harness captures the `tools/list` catalog served by the MCP binary and
//! compares it against a frozen snapshot (`tests/snapshots/tools-list.json`).
//! The snapshot is the contract surface external agents (Codex, Claude Code,
//! OpenCode) integrate against; any change must be intentional and update the
//! snapshot. W0 records the empty catalog; W1-W6 add tools and regenerate.
//!
//! Properties asserted for every catalog entry (plan §6):
//! - ASCII lowercase + digits + underscore only, no dots.
//! - Unique names.
//!
//! Regeneration: when the catalog legitimately changes, run with
//! `XUANLING_MCP_UPDATE_SNAPSHOTS=1` to rewrite the snapshot, then review the
//! diff and the §6 tool-name rules before committing.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

fn binary() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
}

fn snapshot_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/snapshots/tools-list.json")
}

/// Query the running server for its tools/list result. Returns the `tools`
/// array. The child gets a unique temp `--memory-db` (C-15) so the snapshot
/// harness never opens the real default database.
fn fetch_tools() -> Vec<Value> {
    let db_dir = tempfile::tempdir().expect("temp db dir");
    let mut cmd = Command::new(binary());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("--memory-db")
        .arg(db_dir.path().join("snapshot.db"));
    let mut child = cmd.spawn().expect("spawn xuanling-mcp");
    std::mem::forget(db_dir);
    let mut stdin = child.stdin.take().expect("stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("stdout"));

    // initialize first (the SDK requires it before tools/list).
    let init = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "snapshot-harness", "version": "0"}
        }
    });
    writeln!(stdin, "{}", serde_json::to_string(&init).unwrap()).unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read init resp");
    assert!(line.contains("serverInfo"), "init failed: {line}");

    // tools/list
    let list = serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}});
    writeln!(stdin, "{}", serde_json::to_string(&list).unwrap()).unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read tools/list resp");

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();

    let resp: Value = serde_json::from_str(&line).expect("json");
    resp["result"]["tools"]
        .as_array()
        .expect("tools array")
        .clone()
}

/// Stable ordering + shape for the snapshot: tool name + description + input
/// schema + output schema + annotations (ADR 0027 §5.3: the snapshot is the
/// full contract surface external agents integrate against). Keeps the diff
/// minimal and human-reviewable.
fn canonicalize(tools: &[Value]) -> Value {
    let mut entries: Vec<Value> = tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t["name"],
                "description": t.get("description").cloned().unwrap_or(Value::Null),
                "input_schema": t.get("inputSchema").cloned().unwrap_or(Value::Null),
                "output_schema": t.get("outputSchema").cloned().unwrap_or(Value::Null),
                "annotations": t.get("annotations").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        a["name"]
            .as_str()
            .unwrap_or("")
            .cmp(b["name"].as_str().unwrap_or(""))
    });
    Value::Array(entries)
}

#[test]
fn tools_list_snapshot_matches() {
    let tools = fetch_tools();
    let actual = canonicalize(&tools);
    let path = snapshot_path();

    if std::env::var_os("XUANLING_MCP_UPDATE_SNAPSHOTS").is_some() {
        let pretty = serde_json::to_string_pretty(&actual).unwrap();
        std::fs::write(&path, format!("{pretty}\n")).expect("write snapshot");
        eprintln!("updated snapshot: {}", path.display());
        return;
    }

    // The snapshot may not exist yet (W0 fresh checkout). If missing, write a
    // baseline so the harness has something to compare against going forward.
    if !path.exists() {
        let pretty = serde_json::to_string_pretty(&actual).unwrap();
        std::fs::write(&path, format!("{pretty}\n")).expect("write baseline snapshot");
        eprintln!("wrote baseline snapshot (first run): {}", path.display());
        return;
    }

    let expected_str = std::fs::read_to_string(&path).expect("read snapshot");
    let expected: Value = serde_json::from_str(&expected_str).expect("parse snapshot");
    assert_eq!(
        actual, expected,
        "tools/list snapshot drift detected. Re-run with \
         XUANLING_MCP_UPDATE_SNAPSHOTS=1 and review the diff against plan §6."
    );
}

#[test]
fn tool_names_are_ascii_snake_case() {
    let tools = fetch_tools();
    let mut seen = std::collections::HashSet::new();
    for t in &tools {
        let name = t["name"].as_str().expect("tool name string");
        // Plan §6: ASCII lowercase, digits, underscore only; no dots.
        let valid = name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            && !name.is_empty();
        assert!(
            valid,
            "tool name `{name}` violates §6 ASCII-snake-case rule"
        );
        assert!(
            seen.insert(name.to_string()),
            "duplicate tool name `{name}`"
        );
    }
}

#[test]
fn default_catalog_has_no_semantic_tool() {
    // Plan W6, C-07: the default build exposes no semantic/embedding tool
    // surface — semantic recall is a non-default experimental feature.
    let tools = fetch_tools();
    let forbidden_fragments = ["semantic", "embed", "hybrid", "vector"];
    for tool in &tools {
        let name = tool["name"].as_str().expect("tool name string");
        for fragment in forbidden_fragments {
            assert!(
                !name.contains(fragment),
                "default catalog must not expose a `{fragment}` tool; found `{name}`"
            );
        }
    }
}

#[test]
fn tools_list_is_stable_and_ascii_named() {
    // Plan §6, §10 W1: the catalog must be stable (same names/order across
    // calls) and ASCII snake_case. Fetch twice and compare the name sequence.
    let first: Vec<String> = fetch_tools()
        .iter()
        .map(|t| t["name"].as_str().expect("name").to_string())
        .collect();
    let second: Vec<String> = fetch_tools()
        .iter()
        .map(|t| t["name"].as_str().expect("name").to_string())
        .collect();
    assert_eq!(first, second, "tools/list name sequence must be stable");

    // W1 expects at least the three registered tools.
    for required in ["system_info", "path_resolve", "path_relative"] {
        assert!(
            first.iter().any(|n| n == required),
            "catalog must include `{required}`"
        );
    }

    // All names ASCII snake_case (no dots) — the §6 rule.
    for name in &first {
        let valid = name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            && !name.is_empty();
        assert!(valid, "tool name `{name}` is not ASCII snake_case");
    }
}
