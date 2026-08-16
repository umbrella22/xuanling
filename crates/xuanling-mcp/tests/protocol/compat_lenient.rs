//! ZCode compatibility shim contract tests (dynamic revision C-16).
//!
//! The ZCode host stringifies parameters whose schema is a `$ref` into
//! `$defs` (confirmed live: `output`/`scope`/`payload` fail, inline-typed
//! `env` passes). `--compat-lenient-object-params` coerces JSON-object
//! strings for exactly those parameters. Strict mode stays the default.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

use serde_json::{Value, json};

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
}

fn default_memory_db_paths() -> [std::path::PathBuf; 2] {
    // C-15: both real default paths are protected — automation never opens
    // either.
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match home {
        Some(home) => {
            let root = std::path::Path::new(&home).join(".xuanling");
            [root.join("toolkit-memory.db"), root.join("memory.db")]
        }
        None => [
            std::path::PathBuf::from("toolkit-memory.db"),
            std::path::PathBuf::from("memory.db"),
        ],
    }
}

struct Peer {
    child: Child,
    stdout: BufReader<std::process::ChildStdout>,
    stdin: std::process::ChildStdin,
    next_id: i64,
    // Holds the temp DB dir for the Peer's life (C-15).
    _db_dir: tempfile::TempDir,
}

impl Peer {
    /// Spawn with the given extra args; a unique temp `--memory-db` is always
    /// appended (C-15), and the argv is checked against both real default
    /// paths before the child starts.
    fn start(extra_args: &[&str]) -> Self {
        let db_dir = tempfile::tempdir().expect("temp db dir");
        let db_path = db_dir.path().join("compat.db");
        for default in default_memory_db_paths() {
            assert_ne!(
                db_path, default,
                "C-15 violation: --memory-db points at the real default memory DB"
            );
        }
        let mut child = Command::new(binary())
            .args(extra_args)
            .arg("--memory-db")
            .arg(&db_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn peer");
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

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let frame = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        writeln!(self.stdin, "{}", frame).expect("write frame");
        self.stdin.flush().expect("flush");
        loop {
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line).expect("read frame");
            assert!(n > 0, "server closed stdout");
            if !line.trim().is_empty() {
                let parsed: Value = serde_json::from_str(line.trim()).expect("JSON frame");
                if parsed["id"] == id {
                    return parsed;
                }
            }
        }
    }

    fn initialize(&mut self) -> Value {
        let init = self.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "compat-harness", "version": "0"}
            }),
        );
        assert!(
            init["result"]["serverInfo"].is_object(),
            "init failed: {init}"
        );
        writeln!(
            self.stdin,
            "{}",
            json!({"jsonrpc":"2.0","method":"notifications/initialized"})
        )
        .expect("initialized notification");
        self.stdin.flush().expect("flush");
        init
    }

    fn call(&mut self, name: &str, arguments: Value) -> Value {
        self.request("tools/call", json!({"name": name, "arguments": arguments}))
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn ok_structured(response: &Value) -> &Value {
    assert!(
        response["error"].is_null(),
        "unexpected protocol error: {response}"
    );
    let result = &response["result"];
    assert_eq!(result["isError"], json!(false), "domain error: {result}");
    &result["structuredContent"]
}

/// With the shim ON, the host-shaped stringified `output` object is coerced
/// and the bounded read succeeds; stringified `scope`/`payload` carry a full
/// create→review→search memory flow.
#[test]
fn lenient_mode_coerces_stringified_object_params() {
    let workspace = tempfile::tempdir().expect("workspace");
    let fixture = workspace.path().join("big.txt");
    std::fs::write(&fixture, "filler line\n".repeat(64)).expect("fixture");

    let mut peer = Peer::start(&[
        "--workspace-root",
        workspace.path().to_str().expect("utf8 path"),
        "--compat-lenient-object-params",
    ]);
    let init = peer.initialize();
    assert_eq!(
        init["result"]["_meta"]["xuanling.compat.lenient_object_params"],
        json!(true),
        "the shim must be visible in _meta"
    );

    // The ZCode-shaped call: `output` as a JSON-encoded STRING.
    let read = peer.call(
        "fs_read_text",
        json!({
            "path": fixture.to_string_lossy(),
            "output": serde_json::to_string(
                &serde_json::json!({"mode": "bounded", "max_bytes": 32})
            ).unwrap(),
        }),
    );
    let structured = ok_structured(&read);
    assert_eq!(
        structured["truncated"],
        json!(true),
        "bounded window applied: {structured}"
    );

    // Full memory flow with stringified scope/payload (exactly what ZCode
    // sends for the v2 memory tools).
    let scope_string = serde_json::to_string(&json!({"type": "global"})).unwrap();
    let payload_string = serde_json::to_string(&json!({
        "kind": "fact",
        "title": "compat",
        "content": "lenient compat fact about zcode host",
        "tags": ["compat"],
        "applicability": {},
        "pinned": false,
    }))
    .unwrap();
    let created = peer.call(
        "memory_candidate_create",
        json!({
            "proposal_id": "compat-1",
            "idempotency_key": "compat-idem-1",
            "proposer_id": "compat-harness",
            "namespace": "compat-ns",
            "scope": scope_string,
            "payload": payload_string,
        }),
    );
    assert_eq!(
        ok_structured(&created)["status"],
        json!("pending"),
        "{created}"
    );
    let reviewed = peer.call(
        "memory_review",
        json!({
            "idempotency_key": "compat-review-1",
            "reviewer_id": "compat-harness",
            "namespace": "compat-ns",
            "scope": scope_string,
            "proposal_id": "compat-1",
            "expected_proposal_revision": 1,
            "decision": "approve",
        }),
    );
    assert_eq!(
        ok_structured(&reviewed)["status"],
        json!("approved"),
        "{reviewed}"
    );
    let found = peer.call(
        "memory_search",
        json!({
            "namespace": "compat-ns",
            "scope": scope_string,
            "scope_mode": "exact",
            "query": "zcode host",
            "candidate_limit": 10,
            "limit": 5,
        }),
    );
    let items = ok_structured(&found)["items"].as_array().expect("items");
    assert_eq!(items.len(), 1, "recall through coerced scope: {found}");
    assert_eq!(items[0]["record"]["id"], json!("compat-1"));
}

/// The shim must stay opt-in: without the flag the strict schema contract
/// rejects the same stringified object (typed -32602, zero dispatch).
#[test]
fn strict_mode_still_rejects_stringified_object_params() {
    let workspace = tempfile::tempdir().expect("workspace");
    let fixture = workspace.path().join("big.txt");
    std::fs::write(&fixture, "filler line\n".repeat(64)).expect("fixture");

    let mut peer = Peer::start(&[
        "--workspace-root",
        workspace.path().to_str().expect("utf8 path"),
    ]);
    let init = peer.initialize();
    assert_eq!(
        init["result"]["_meta"]["xuanling.compat.lenient_object_params"],
        json!(false),
        "strict default must be visible in _meta"
    );

    let read = peer.call(
        "fs_read_text",
        json!({
            "path": fixture.to_string_lossy(),
            "output": serde_json::to_string(
                &serde_json::json!({"mode": "bounded", "max_bytes": 32})
            ).unwrap(),
        }),
    );
    assert_eq!(
        read["error"]["code"],
        json!(-32602),
        "strict mode rejects the stringified object: {read}"
    );
}

/// String-typed parameters are never coerced: a search pattern that happens
/// to look like a JSON object stays a literal pattern under the shim.
#[test]
fn lenient_mode_never_coerces_string_typed_params() {
    let workspace = tempfile::tempdir().expect("workspace");
    let fixture = workspace.path().join("haystack.txt");
    std::fs::write(&fixture, "needle {\"looks\":\"like json\"} end\n").expect("fixture");

    let mut peer = Peer::start(&[
        "--workspace-root",
        workspace.path().to_str().expect("utf8 path"),
        "--compat-lenient-object-params",
    ]);
    peer.initialize();

    let search = peer.call(
        "fs_search",
        json!({
            "path": ".",
            "pattern": "{\"looks\":\"like json\"}",
            "literal": true,
        }),
    );
    let structured = ok_structured(&search);
    let matches = structured["matches"].as_array().expect("matches");
    assert_eq!(
        matches.len(),
        1,
        "pattern stays a literal string, finds the fixture: {structured}"
    );
}
