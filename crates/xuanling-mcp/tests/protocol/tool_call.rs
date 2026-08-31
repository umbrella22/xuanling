//! `tools/call` end-to-end contract (plan §9.3, §10 W1).
//!
//! Drives the binary over stdio to invoke the W1 tools (`system_info`,
//! `path_resolve`, `path_relative`) and asserts the structured results.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use serde_json::{Value, json};

fn binary() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
}

struct Peer {
    child: Child,
    stdout: BufReader<std::process::ChildStdout>,
    stdin: std::process::ChildStdin,
    next_id: i64,
    // Server-owned temp DB (C-15): the stdio child gets an explicit unique
    // `--memory-db` so tests never open the real default database.
    _db_dir: tempfile::TempDir,
}

impl Peer {
    fn start() -> Self {
        let db_dir = tempfile::tempdir().expect("temp db dir");
        let mut cmd = Command::new(binary());
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .arg("--memory-db")
            .arg(db_dir.path().join("tool-call.db"));
        let mut child = cmd.spawn().expect("spawn");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdout,
            stdin,
            next_id: 1,
            _db_dir: db_dir,
        }
    }

    fn initialize(&mut self) {
        let req = json!({
            "jsonrpc": "2.0", "id": self.next_id, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "t", "version": "0"}
            }
        });
        self.next_id += 1;
        self.send(&req);
        let _ = self.recv();
    }

    fn call(&mut self, tool: &str, args: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": {"name": tool, "arguments": args}});
        self.send(&req);
        self.recv()
    }

    fn send(&mut self, v: &Value) {
        writeln!(self.stdin, "{}", serde_json::to_string(v).unwrap()).unwrap();
        self.stdin.flush().unwrap();
    }

    fn recv(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read");
        serde_json::from_str(&line).expect("json-rpc")
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn system_info_call_returns_structured_facts() {
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call("system_info", json!({}));
    let facts = &resp["result"]["structuredContent"];
    assert!(
        facts.is_object(),
        "structuredContent must be an object: {resp}"
    );
    assert!(facts["os"].is_string(), "os must be a string: {facts}");
    assert!(facts["arch"].is_string());
    assert!(facts["xuanling_version"].is_string());
    assert_eq!(facts["mcp_contract_version"], json!("3"));
    assert_eq!(
        facts["path_separator"],
        json!(std::path::MAIN_SEPARATOR.to_string())
    );
    // No env leak.
    let text = serde_json::to_string(facts).unwrap();
    assert!(
        !text.contains("PATH")
            || facts["cwd"]
                .as_str()
                .map(|c| c.contains("path"))
                .unwrap_or(false),
        "system_info must not leak environment vars: {text}"
    );
    assert_eq!(resp["result"]["isError"], json!(false));
}

#[test]
fn path_resolve_call_returns_resolved_path() {
    let mut peer = Peer::start();
    peer.initialize();
    // Use a platform-native absolute path so the assertion holds on Windows
    // (where /etc/hosts is drive-relative, not absolute).
    let (input, expected_path) = if cfg!(target_os = "windows") {
        ("C:\\Windows\\System32", "C:\\Windows\\System32")
    } else {
        ("/etc/hosts", "/etc/hosts")
    };
    let resp = peer.call(
        "path_resolve",
        json!({"path": input, "canonicalize": false}),
    );
    let facts = &resp["result"]["structuredContent"];
    assert_eq!(
        facts["path"],
        json!(expected_path),
        "absolute path passes through: {facts}"
    );
    assert_eq!(facts["absolute_path"], json!(expected_path));
}

#[test]
fn path_relative_call_uses_forward_slash() {
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call(
        "path_relative",
        json!({"path": "src/main.rs", "base_dir": "."}),
    );
    let facts = &resp["result"]["structuredContent"];
    let rel = facts["relative_path"]
        .as_str()
        .unwrap_or_else(|| panic!("relative_path missing: {facts}"));
    assert!(!rel.contains('\\'), "relative path must use `/`: {rel}");
}

#[test]
fn unknown_tool_call_is_protocol_error() {
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call("no_such_tool", json!({}));
    // Unknown tool -> JSON-RPC error (invalid params).
    assert!(
        resp.get("error").is_some(),
        "unknown tool must be a protocol error: {resp}"
    );
}

#[test]
fn malformed_arguments_is_protocol_error() {
    let mut peer = Peer::start();
    peer.initialize();
    // path_resolve requires `path`; omitting it must be invalid params.
    let resp = peer.call("path_resolve", json!({"canonicalize": false}));
    assert!(
        resp.get("error").is_some(),
        "malformed args must be a protocol error: {resp}"
    );
}
