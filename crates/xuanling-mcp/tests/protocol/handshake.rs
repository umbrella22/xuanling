//! MCP initialize / tools-list handshake contract (plan §9.3, §10 W1).
//!
//! Validates the binary answers initialize with the correct serverInfo and
//! tools/list returns the catalog. This also exercises the SDK integration
//! end-to-end, satisfying the W0 exit "MCP SDK 可以完成最小
//! initialize/tools-list test harness".
//!
//! The two tests at the bottom pin the protocol-negotiation regression from
//! the ZCode host: agreeing to the `2026-07-28` modern era makes ZCode
//! validate `tools/list` against its strict modern wire schema (`resultType`,
//! `ttlMs` and `cacheScope`), which this server does not emit — the
//! connection then fails and zero tools register. The server must only ever
//! negotiate legacy revisions.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::Value;

fn binary() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
}

/// Spawn a stdio server child with a unique temp `--memory-db` (C-15: the real
/// default database must never be opened by tests). The temp dir is leaked
/// into the OS temp cleanup on purpose: it outlives the child, which is
/// killed by the test harness at the end of each test.
fn spawn() -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let db_dir = tempfile::tempdir().expect("temp db dir");
    let mut cmd = Command::new(binary());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("--memory-db")
        .arg(db_dir.path().join("handshake.db"));
    let mut child = cmd.spawn().expect("spawn");
    std::mem::forget(db_dir);
    let stdin = child.stdin.take().expect("stdin");
    let stdout = BufReader::new(child.stdout.take().expect("stdout"));
    (child, stdin, stdout)
}

/// Send one JSON-RPC message and read one response line.
fn request(stdin: &mut ChildStdin, stdout: &mut BufReader<ChildStdout>, msg: Value) -> Value {
    writeln!(stdin, "{}", serde_json::to_string(&msg).unwrap()).unwrap();
    stdin.flush().unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).expect("read");
    serde_json::from_str(&line).expect("json")
}

fn initialize(protocol_version: &str) -> Value {
    serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": protocol_version,
            "capabilities": {},
            "clientInfo": {"name": "t", "version": "0"}
        }
    })
}

#[test]
fn initialize_and_tools_list_handshake() {
    let (mut child, mut stdin, mut stdout) = spawn();

    let resp = request(&mut stdin, &mut stdout, initialize("2024-11-05"));
    assert_eq!(resp["result"]["serverInfo"]["name"], "xuanling-mcp");
    assert_eq!(
        resp["result"]["capabilities"]["tools"],
        Value::Object(serde_json::Map::new())
    );
    let digest = resp["result"]["_meta"]["xuanling.catalog_sha256"]
        .as_str()
        .expect("catalog digest");
    assert_eq!(digest.len(), 64);
    assert!(digest.bytes().all(|byte| byte.is_ascii_hexdigit()));

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
}

/// A modern-era client probing with `2026-07-28` must be negotiated down to a
/// legacy revision (rmcp's default would echo the modern version back, and
/// ZCode then applies its strict modern wire schema and drops the server).
#[test]
fn initialize_negotiates_legacy_when_client_probes_modern() {
    let (mut child, mut stdin, mut stdout) = spawn();

    let resp = request(&mut stdin, &mut stdout, initialize("2026-07-28"));
    assert_eq!(
        resp["result"]["protocolVersion"], "2025-11-25",
        "server agreed to the 2026-07-28 modern era; ZCode would fail tools/list validation"
    );

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
}

/// `tools/list` under the legacy revision must stay in the legacy shape:
/// `{ tools: [...] }` — no `resultType`, `ttlMs` or `cacheScope` wire fields
/// (ZCode requires all three under the 2026-07-28 modern era and rejects the
/// result when they are absent, which is what broke plugin loading).
#[test]
fn tools_list_uses_legacy_shape_without_modern_wire_fields() {
    let (mut child, mut stdin, mut stdout) = spawn();

    let resp = request(&mut stdin, &mut stdout, initialize("2025-11-25"));
    assert_eq!(resp["result"]["protocolVersion"], "2025-11-25");

    let resp = request(
        &mut stdin,
        &mut stdout,
        serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
    );
    assert!(
        resp["result"]["tools"].is_array(),
        "tools/list missing tools array"
    );
    for wire_field in ["resultType", "ttlMs", "cacheScope"] {
        assert!(
            resp["result"].get(wire_field).is_none(),
            "legacy tools/list result must not carry modern wire field {wire_field}"
        );
    }

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn tools_list_paginates_with_catalog_bound_cursors() {
    let (mut child, mut stdin, mut stdout) = spawn();
    let initialized = request(&mut stdin, &mut stdout, initialize("2025-11-25"));
    let advertised = initialized["result"]["_meta"]["xuanling.tool_count"]
        .as_u64()
        .expect("tool count") as usize;

    let first = request(
        &mut stdin,
        &mut stdout,
        serde_json::json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
    );
    let first_tools = first["result"]["tools"].as_array().expect("first page");
    assert_eq!(first_tools.len(), 8);
    assert!(advertised > first_tools.len());
    let cursor = first["result"]["nextCursor"]
        .as_str()
        .expect("continuation cursor");

    let second = request(
        &mut stdin,
        &mut stdout,
        serde_json::json!({
            "jsonrpc": "2.0", "id": 3, "method": "tools/list",
            "params": {"cursor": cursor}
        }),
    );
    let second_tools = second["result"]["tools"].as_array().expect("second page");
    assert!(!second_tools.is_empty());
    assert_ne!(first_tools[0]["name"], second_tools[0]["name"]);

    let invalid = request(
        &mut stdin,
        &mut stdout,
        serde_json::json!({
            "jsonrpc": "2.0", "id": 4, "method": "tools/list",
            "params": {"cursor": "not-a-catalog-cursor"}
        }),
    );
    assert_eq!(invalid["error"]["code"], -32602);
    assert_eq!(invalid["error"]["data"]["reason"], "invalid_cursor");

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
}
