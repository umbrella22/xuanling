//! Stdio framing discipline (plan §9.2, §10 W0).
//!
//! The server MUST write only MCP framing to stdout; all tracing/diagnostics
//! go to stderr. This red test spawns the binary, runs the initialize
//! handshake, and asserts every stdout line is a valid JSON-RPC message.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::Value;

fn locate_binary() -> std::path::PathBuf {
    // Tests run with CARGO_BIN_EXE_<name> env set to the built binary path.
    std::env::var_os("CARGO_BIN_EXE_xuanling-mcp")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            // Fallback for `cargo test -p xuanling-mcp --test protocol`.
            std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
        })
}

struct Server {
    child: Child,
    stdout: BufReader<ChildStdout>,
    stdin: ChildStdin,
    // Server-owned temp DB (C-15): explicit unique `--memory-db`.
    _db_dir: tempfile::TempDir,
}

impl Server {
    fn start() -> Self {
        let db_dir = tempfile::tempdir().expect("temp db dir");
        let mut cmd = Command::new(locate_binary());
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .arg("--memory-db")
            .arg(db_dir.path().join("framing.db"));
        let mut child = cmd.spawn().expect("spawn xuanling-mcp");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdout,
            stdin,
            _db_dir: db_dir,
        }
    }

    fn send(&mut self, json: &Value) {
        let line = serde_json::to_string(json).expect("serialize");
        writeln!(self.stdin, "{line}").expect("write");
        self.stdin.flush().expect("flush");
    }

    /// Read one stdout line and parse it as JSON-RPC.
    fn next_message(&mut self) -> Value {
        let mut line = String::new();
        self.stdout.read_line(&mut line).expect("read stdout line");
        assert!(!line.is_empty(), "server closed stdout without a message");
        serde_json::from_str(&line).unwrap_or_else(|e| {
            panic!("stdout line is not valid JSON-RPC (framing violated): {e:?}\nline: {line}")
        })
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn mcp_stdout_contains_protocol_frames_only() {
    let mut server = Server::start();

    // initialize handshake.
    server.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test-client", "version": "0.0.0"}
        }
    }));
    let init_resp = server.next_message();
    assert_eq!(init_resp["id"], 1, "initialize response id mismatch");
    assert_eq!(
        init_resp["result"]["serverInfo"]["name"], "xuanling-mcp",
        "serverInfo.name mismatch"
    );

    // tools/list — stdout must still be pure JSON-RPC.
    server.send(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    }));
    let list_resp = server.next_message();
    assert_eq!(list_resp["id"], 2);
    assert!(
        list_resp["result"]["tools"].is_array(),
        "tools must be an array"
    );

    // The contract: every line read from stdout parsed as JSON without error
    // inside `next_message`. If the server had written any log/diagnostic to
    // stdout, the parse would have panicked above (failing the test).
}
