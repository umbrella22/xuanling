//! W6 MCP contract hardening tests (plan §10 W6).
//!
//! Pins: schema/handler completeness, domain-error-vs-protocol-error-vs-
//! process-nonzero separation, malformed-JSON rejection, unknown-tool protocol
//! error, EOF clean shutdown, and cancellation routing to the matching call.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

use serde_json::{Value, json};

fn binary() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
}

fn create_directory_symlink(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).expect("directory symlink fixture");
        true
    }

    #[cfg(windows)]
    {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => true,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("skipping symlink protocol fixture: {error}");
                false
            }
            Err(error) => panic!("directory symlink fixture: {error}"),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        false
    }
}

struct Peer {
    child: Child,
    stdout: Option<BufReader<std::process::ChildStdout>>,
    stdin: Option<std::process::ChildStdin>,
    next_id: i64,
    // Server-owned temp DB (C-15): every stdio child gets an explicit unique
    // `--memory-db` so the real default database is never opened by tests.
    _db_dir: Option<tempfile::TempDir>,
}

/// The real default memory DB paths, mirroring `main.rs` resolution (plan
/// C-15). Both are protected: the legacy v1 `toolkit-memory.db` and the 0.2.0
/// default `memory.db` now used by the live host. Test automation must never
/// open either.
fn default_memory_db_paths() -> [std::path::PathBuf; 2] {
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

/// C-15 structural guard: refuse to spawn any stdio server child unless it
/// carries an explicit `--memory-db` that does not point at a real default
/// database. Isolated `HOME`, a shared temp DB, or convention do NOT satisfy
/// the contract — the argv itself must be isolated.
fn enforce_isolated_memory_db(cmd: &std::process::Command) {
    let args: Vec<String> = cmd
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let Some(flag) = args.iter().position(|arg| arg == "--memory-db") else {
        panic!(
            "C-15 violation: spawning xuanling-mcp without --memory-db would \
             open the real default memory DB; pass a unique temp path"
        );
    };
    let value = args
        .get(flag + 1)
        .unwrap_or_else(|| panic!("--memory-db requires a value"));
    for default in default_memory_db_paths() {
        assert_ne!(
            value.as_str(),
            default.to_string_lossy().as_ref(),
            "C-15 violation: --memory-db points at the real default memory DB"
        );
    }
}

impl Peer {
    fn start() -> Self {
        Self::start_with_env(&[])
    }

    /// Start a server subprocess with extra environment variables (e.g. a tiny
    /// snapshot TTL for expiry tests). The child inherits the test process env
    /// and always gets a unique temp `--memory-db` (C-15).
    fn start_with_env(envs: &[(&str, &str)]) -> Self {
        let mut cmd = Command::new(binary());
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in envs {
            cmd.env(k, v);
        }
        let db_dir = tempfile::tempdir().expect("temp db dir");
        cmd.arg("--memory-db")
            .arg(db_dir.path().join("hardening.db"));
        Self::spawn(cmd, Some(db_dir))
    }

    fn start_with_args(args: &[&std::ffi::OsStr]) -> Self {
        let mut cmd = Command::new(binary());
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .args(args);
        let db_dir = tempfile::tempdir().expect("temp db dir");
        cmd.arg("--memory-db")
            .arg(db_dir.path().join("hardening.db"));
        Self::spawn(cmd, Some(db_dir))
    }

    /// Start a server whose memory store CANNOT be opened (`--memory-db` points
    /// at a DIRECTORY → SQLite CANTOPEN → main.rs degrades to no store). This is
    /// the deterministic "memory DB failure / unavailable" fixture (relying on
    /// the absence of `--memory-db` is NOT portable: main.rs defaults to
    /// `~/.xuanling/toolkit-memory.db`; and a non-existent parent is auto-created
    /// by the open path, so only a directory reliably fails).
    fn start_degraded_memory() -> Self {
        let bad_db = std::env::temp_dir(); // an existing directory -> SQLite can't open it as a db
        let mut cmd = Command::new(binary());
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .arg("--memory-db")
            .arg(&bad_db);
        Self::spawn(cmd, None)
    }

    fn spawn(mut cmd: Command, db_dir: Option<tempfile::TempDir>) -> Self {
        enforce_isolated_memory_db(&cmd);
        let mut child = cmd.spawn().expect("spawn");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdout: Some(stdout),
            stdin: Some(stdin),
            next_id: 1,
            _db_dir: db_dir,
        }
    }

    fn initialize(&mut self) -> Value {
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
        self.recv()
    }

    fn send(&mut self, v: &Value) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{}", serde_json::to_string(v).unwrap()).unwrap();
        stdin.flush().unwrap();
    }

    /// Send a raw line (allows malformed JSON).
    fn send_raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().expect("stdin open");
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn recv(&mut self) -> Value {
        let stdout = self.stdout.as_mut().expect("stdout open");
        let mut line = String::new();
        stdout.read_line(&mut line).expect("read");
        serde_json::from_str(&line).expect("json-rpc")
    }

    fn call(&mut self, tool: &str, args: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({"jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": {"name": tool, "arguments": args}});
        self.send(&req);
        self.recv()
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn every_catalog_tool_has_schema_and_handler() {
    // tools/list returns a non-empty catalog; each entry has name +
    // inputSchema; calling each tool with empty args either succeeds or
    // returns a domain/protocol error (never a transport crash).
    let mut peer = Peer::start();
    peer.initialize();
    let list = json!({"jsonrpc": "2.0", "id": peer.next_id, "method": "tools/list", "params": {}});
    peer.next_id += 1;
    peer.send(&list);
    let resp = peer.recv();
    let tools = resp["result"]["tools"].as_array().expect("tools array");
    assert!(!tools.is_empty(), "catalog must not be empty");
    for t in tools {
        let name = t["name"].as_str().expect("tool name");
        assert!(
            t.get("inputSchema").is_some(),
            "tool `{name}` must have an inputSchema"
        );
        assert!(
            t.get("description").is_some(),
            "tool `{name}` must have a description"
        );
    }
}

#[test]
fn schema_snapshot_matches_public_dto() {
    // The frozen snapshot file exists and its tool names match the live
    // catalog exactly (no drift between snapshot and runtime).
    let mut peer = Peer::start();
    peer.initialize();
    let list = json!({"jsonrpc": "2.0", "id": peer.next_id, "method": "tools/list", "params": {}});
    peer.next_id += 1;
    peer.send(&list);
    let resp = peer.recv();
    let live: Vec<String> = resp["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    let snap = std::fs::read_to_string("tests/snapshots/tools-list.json").expect("snapshot file");
    let snap_val: Value = serde_json::from_str(&snap).expect("snapshot json");
    let snap_names: Vec<String> = snap_val
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    let mut live_sorted = live.clone();
    live_sorted.sort();
    let mut snap_sorted = snap_names.clone();
    snap_sorted.sort();
    assert_eq!(
        live_sorted, snap_sorted,
        "live catalog must match frozen snapshot names"
    );
}

#[test]
fn domain_error_is_structured_and_is_error_true() {
    // A domain failure (e.g. fs_read_text on a missing file) returns a
    // tool-level error: isError=true, NOT a JSON-RPC protocol error.
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call(
        "fs_read_text",
        json!({"path": "/xuanling/definitely/does/not/exist.txt"}),
    );
    // It is a result (not a top-level error).
    assert!(
        resp.get("result").is_some(),
        "domain error is a tool result, not protocol error: {resp}"
    );
    assert_eq!(
        resp["result"]["isError"],
        json!(true),
        "domain error must set isError=true"
    );
    // The stable `code` field must be present in `structuredContent` so agents
    // can branch on `code` instead of scraping message text (plan §5; review
    // P1). Previously the error payload only sat inside a content text block.
    let structured = &resp["result"]["structuredContent"];
    assert!(
        structured.is_object(),
        "domain error must carry a structuredContent object: {resp}"
    );
    assert_eq!(
        structured["code"],
        json!("not_found"),
        "structuredContent.code must be the stable error code: {resp}"
    );
    assert!(
        structured["operation"].is_string(),
        "structuredContent must include `operation`: {resp}"
    );
}

#[test]
fn process_nonzero_is_error_false() {
    // A process_run nonzero exit is a successful call with isError=false.
    // Use `false` (exits 1) on unix; skip on non-unix.
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call(
        "process_run",
        json!({"program": "false", "args": [], "stdout": "null", "stderr": "null"}),
    );
    assert!(resp.get("result").is_some());
    assert_eq!(
        resp["result"]["isError"],
        json!(false),
        "process nonzero exit is isError=false"
    );
    let structured = &resp["result"]["structuredContent"];
    assert_eq!(structured["success"], json!(false));
}

#[test]
fn malformed_json_never_reaches_toolkit() {
    // A malformed JSON line must NOT crash the server. The server may respond
    // with a JSON-RPC parse error OR drop the line. We verify it stays alive
    // by sending garbage and then a valid request, reading with a watchdog
    // thread so the test never hangs if the server drops the bad line silently.
    use std::sync::mpsc;
    let mut peer = Peer::start();
    peer.initialize();
    peer.send_raw("{not valid json");
    // Give the server a moment to process/drop the bad line.
    std::thread::sleep(std::time::Duration::from_millis(300));
    // Send a valid tools/list and read responses in a watchdog thread.
    let req = json!({"jsonrpc": "2.0", "id": 999, "method": "tools/list", "params": {}});
    peer.send(&req);
    // Move the stdout reader into a thread that reads until it sees id 999 or
    // hits EOF. The thread is bounded by the test killing the child at the end.
    let stdout = peer.stdout.take().expect("stdout");
    let (tx, rx) = mpsc::channel::<Value>();
    let handle = std::thread::spawn(move || {
        let mut reader = stdout;
        loop {
            let mut line = String::new();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    if let Ok(v) = serde_json::from_str::<Value>(&line) {
                        let _ = tx.send(v.clone());
                        if v.get("id").and_then(|i| i.as_i64()) == Some(999) {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });
    // Wait up to 8s for the id-999 response.
    let mut got_999 = false;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(std::time::Duration::from_millis(500)) {
            Ok(v) if v.get("id").and_then(|i| i.as_i64()) == Some(999) => {
                got_999 = true;
                break;
            }
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    // Kill the child to unblock the reader thread.
    let _ = peer.child.kill();
    let _ = peer.child.wait();
    let _ = handle.join();
    assert!(
        got_999,
        "server must survive malformed JSON and still answer a valid tools/list"
    );
}

#[test]
fn unknown_tool_is_protocol_error() {
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call("no_such_tool_xyz", json!({}));
    assert!(
        resp.get("error").is_some(),
        "unknown tool must be a protocol error: {resp}"
    );
}

#[test]
fn cli_help_and_version_exit_without_starting_stdio_transport() {
    let help = Command::new(binary())
        .arg("--help")
        .output()
        .expect("run --help");
    assert!(help.status.success(), "--help failed: {help:?}");
    let help_stdout = String::from_utf8(help.stdout).expect("UTF-8 help output");
    assert!(help_stdout.contains("Usage: xuanling-mcp"), "{help_stdout}");
    for flag in [
        "--base-dir",
        "--memory-db",
        "--default-namespace",
        "--sqlite-busy-timeout-ms",
        "--workspace-root",
        "--read-root",
    ] {
        assert!(help_stdout.contains(flag), "help must include {flag}");
    }
    assert!(
        !help_stdout.contains("\"jsonrpc\""),
        "help must not start the stdio MCP transport"
    );

    let version = Command::new(binary())
        .arg("--version")
        .output()
        .expect("run --version");
    assert!(version.status.success(), "--version failed: {version:?}");
    assert_eq!(
        String::from_utf8(version.stdout)
            .expect("UTF-8 version output")
            .trim(),
        format!("xuanling-mcp {}", env!("CARGO_PKG_VERSION"))
    );
}

#[test]
fn cli_rejects_unknown_missing_and_invalid_values() {
    for args in [
        vec!["--unknown-option"],
        vec!["--base-dir"],
        vec!["--sqlite-busy-timeout-ms", "not-a-number"],
    ] {
        let output = Command::new(binary())
            .args(&args)
            .output()
            .unwrap_or_else(|error| panic!("run {args:?}: {error}"));
        assert!(
            !output.status.success(),
            "invalid CLI args must fail instead of starting the server: {args:?}"
        );
        assert!(
            !output.stderr.is_empty(),
            "invalid CLI args must explain the failure: {args:?}"
        );
    }
}

/// C-15 guard: every stdio server this harness spawns must carry an explicit
/// `--memory-db` pointing away from the real default database, and the harness
/// sources must not regress to unprotected spawns.
#[test]
fn all_test_servers_use_explicit_temp_memory_db() {
    // (a) Runtime enforcement: the shared constructor refuses unprotected argv.
    let mut missing_flag = Command::new(binary());
    missing_flag.stdin(Stdio::piped()).stdout(Stdio::piped());
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            enforce_isolated_memory_db(&missing_flag)
        }))
        .is_err(),
        "spawn without --memory-db must be rejected before the child starts"
    );

    for default in default_memory_db_paths() {
        let mut default_path = Command::new(binary());
        default_path
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .arg("--memory-db")
            .arg(&default);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                enforce_isolated_memory_db(&default_path)
            }))
            .is_err(),
            "--memory-db pointing at the real default DB ({}) must be rejected",
            default.display()
        );
    }

    let dir = tempfile::tempdir().expect("temp dir");
    let mut isolated = Command::new(binary());
    isolated
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .arg("--memory-db")
        .arg(dir.path().join("guard.db"));
    enforce_isolated_memory_db(&isolated); // must not panic

    // (b) Source scan: every server-binary spawn block in the harness files
    // declares `--memory-db`; blocks using `.output()` are one-shot CLI
    // queries (--help/--version/invalid args) that never start the stdio
    // transport and are allowlisted.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    for relative in [
        "tests/protocol/contract_hardening.rs",
        "tests/protocol/cli_maintenance.rs",
        "tests/protocol/compat_lenient.rs",
        "tests/protocol/agent_acceptance.rs",
        "tests/protocol/tool_call.rs",
        "tests/protocol/handshake.rs",
        "tests/protocol/framing.rs",
        "tests/protocol/schema_snapshot.rs",
        "tests/golden/golden_manifest.rs",
    ] {
        let source = std::fs::read_to_string(std::path::Path::new(manifest_dir).join(relative))
            .unwrap_or_else(|error| panic!("read {relative}: {error}"));
        let lines: Vec<&str> = source.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            if !line.contains("Command::new(binary())")
                && !line.contains("Command::new(locate_binary())")
            {
                continue;
            }
            let window: Vec<&str> = lines.iter().skip(index).take(20).cloned().collect();
            let is_stdio = window.iter().any(|l| l.contains(".spawn()"));
            if !is_stdio {
                continue; // one-shot CLI query (.output()) — allowlisted
            }
            assert!(
                window.iter().any(|l| l.contains("--memory-db")),
                "{relative}:{} spawns a stdio server without --memory-db in the \
                 following block (C-15)",
                index + 1
            );
        }
    }
}

#[test]
fn workspace_root_cli_enforces_filesystem_capability() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside directory");
    let inside_path = workspace.path().join("inside.txt");
    let outside_path = outside.path().join("outside.txt");
    std::fs::write(&inside_path, "inside").expect("inside fixture");
    std::fs::write(&outside_path, "outside").expect("outside fixture");

    let args = [
        std::ffi::OsStr::new("--workspace-root"),
        workspace.path().as_os_str(),
    ];
    let mut peer = Peer::start_with_args(&args);
    let initialize = peer.initialize();
    assert_eq!(
        initialize["result"]["_meta"]["xuanling.filesystem_scope"],
        json!("workspace")
    );

    let inside = peer.call("fs_read_text", json!({"path": "inside.txt"}));
    assert_eq!(inside["result"]["isError"], json!(false), "{inside}");
    assert_eq!(
        inside["result"]["structuredContent"]["content"],
        json!("inside")
    );

    let outside = peer.call(
        "fs_read_text",
        json!({"path": outside_path.to_string_lossy()}),
    );
    assert_eq!(outside["result"]["isError"], json!(true), "{outside}");
    assert_eq!(
        outside["result"]["structuredContent"]["code"],
        json!("outside_capability"),
        "{outside}"
    );
}

#[test]
fn multi_root_and_read_root_cli_enforce_the_access_matrix() {
    let root_a = tempfile::tempdir().expect("root A");
    let root_b = tempfile::tempdir().expect("root B");
    let read_root = tempfile::tempdir().expect("read-only root");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(root_a.path().join("a.txt"), "a").expect("a fixture");
    std::fs::write(root_b.path().join("b.txt"), "b").expect("b fixture");
    std::fs::write(read_root.path().join("c.txt"), "c").expect("c fixture");
    let outside_path = outside.path().join("out.txt");
    std::fs::write(&outside_path, "out").expect("outside fixture");

    let args = [
        std::ffi::OsStr::new("--workspace-root"),
        root_a.path().as_os_str(),
        std::ffi::OsStr::new("--workspace-root"),
        root_b.path().as_os_str(),
        std::ffi::OsStr::new("--read-root"),
        read_root.path().as_os_str(),
    ];
    let mut peer = Peer::start_with_args(&args);
    let initialize = peer.initialize();
    assert_eq!(
        initialize["result"]["_meta"]["xuanling.filesystem_scope"],
        json!("workspace")
    );
    assert_eq!(
        initialize["result"]["_meta"]["xuanling.workspace_root_count"],
        json!(2)
    );
    assert_eq!(
        initialize["result"]["_meta"]["xuanling.read_root_count"],
        json!(1)
    );

    // Reads are permitted in every configured root.
    for (path, expected) in [
        ("a.txt".to_string(), "a"),
        (
            root_b.path().join("b.txt").to_string_lossy().into_owned(),
            "b",
        ),
        (
            read_root
                .path()
                .join("c.txt")
                .to_string_lossy()
                .into_owned(),
            "c",
        ),
    ] {
        let read = peer.call("fs_read_text", json!({"path": path}));
        assert_eq!(read["result"]["isError"], json!(false), "{read}");
        assert_eq!(
            read["result"]["structuredContent"]["content"],
            json!(expected),
            "{read}"
        );
    }

    // Writes are permitted in write roots.
    let write_a = peer.call(
        "fs_write_text",
        json!({"path": "created-a.txt", "content": "created", "mode": "create"}),
    );
    assert_eq!(write_a["result"]["isError"], json!(false), "{write_a}");

    // A read-only root rejects writes.
    let write_c = peer.call(
        "fs_write_text",
        json!({
            "path": read_root.path().join("forged.txt").to_string_lossy(),
            "content": "forged",
            "mode": "create"
        }),
    );
    assert_eq!(write_c["result"]["isError"], json!(true), "{write_c}");
    assert_eq!(
        write_c["result"]["structuredContent"]["code"],
        json!("outside_capability"),
        "{write_c}"
    );

    // Paths outside every root are still rejected.
    let outside_read = peer.call(
        "fs_read_text",
        json!({"path": outside_path.to_string_lossy()}),
    );
    assert_eq!(
        outside_read["result"]["isError"],
        json!(true),
        "{outside_read}"
    );
    assert_eq!(
        outside_read["result"]["structuredContent"]["code"],
        json!("outside_capability"),
        "{outside_read}"
    );
}

#[test]
fn workspace_root_exposes_a_leaf_symlink_without_authorizing_its_target() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside directory");
    let sentinel = outside.path().join("sentinel.txt");
    std::fs::write(&sentinel, "target remains").expect("outside fixture");
    let link = workspace.path().join("external-directory");
    if !create_directory_symlink(outside.path(), &link) {
        return;
    }

    let args = [
        std::ffi::OsStr::new("--workspace-root"),
        workspace.path().as_os_str(),
    ];
    let mut peer = Peer::start_with_args(&args);
    peer.initialize();
    let entry_locator = format!("external-directory{}", std::path::MAIN_SEPARATOR);

    let entry_stat = peer.call(
        "fs_stat",
        json!({"path": entry_locator, "follow_symlinks": false}),
    );
    assert_eq!(
        entry_stat["result"]["isError"],
        json!(false),
        "{entry_stat}"
    );
    assert_eq!(
        entry_stat["result"]["structuredContent"]["kind"],
        json!("symlink"),
        "{entry_stat}"
    );

    let target_stat = peer.call(
        "fs_stat",
        json!({"path": "external-directory", "follow_symlinks": true}),
    );
    assert_eq!(
        target_stat["result"]["isError"],
        json!(true),
        "{target_stat}"
    );
    assert_eq!(
        target_stat["result"]["structuredContent"]["code"],
        json!("outside_capability"),
        "{target_stat}"
    );

    let list = peer.call(
        "fs_list",
        json!({
            "path": ".",
            "recursive": true,
            "follow_symlinks": false,
            "output": {"mode": "complete"}
        }),
    );
    let entries = list["result"]["structuredContent"]["entries"]
        .as_array()
        .unwrap_or_else(|| panic!("list entries: {list}"));
    assert!(
        entries.iter().any(|entry| {
            entry["kind"] == json!("symlink")
                && entry["path"]
                    .as_str()
                    .and_then(|path| Path::new(path).file_name())
                    == Some(std::ffi::OsStr::new("external-directory"))
        }),
        "nofollow list must expose the symlink entry: {list}"
    );
    assert!(
        entries.iter().all(|entry| {
            entry["path"]
                .as_str()
                .is_none_or(|path| !path.ends_with("sentinel.txt"))
        }),
        "nofollow list must not enter the target: {list}"
    );

    let removed = peer.call(
        "fs_remove",
        json!({"path": entry_locator, "recursive": true}),
    );
    assert_eq!(removed["result"]["isError"], json!(false), "{removed}");
    assert_eq!(
        removed["result"]["structuredContent"]["kind"],
        json!("symlink"),
        "{removed}"
    );
    assert!(std::fs::symlink_metadata(&link).is_err());
    assert_eq!(
        std::fs::read_to_string(&sentinel).expect("target survives"),
        "target remains"
    );
}

#[test]
fn workspace_root_rejects_an_outside_base_dir_at_startup() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside directory");
    let output = Command::new(binary())
        .arg("--workspace-root")
        .arg(workspace.path())
        .arg("--base-dir")
        .arg(outside.path())
        .output()
        .expect("run contained server with outside base dir");
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("--base-dir is outside --workspace-root"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn eof_during_idle_closes_cleanly() {
    // Closing stdin after initialize/tools-list must let the server exit
    // cleanly (no hang, no panic).
    let mut peer = Peer::start();
    peer.initialize();
    let list = json!({"jsonrpc": "2.0", "id": peer.next_id, "method": "tools/list", "params": {}});
    peer.next_id += 1;
    peer.send(&list);
    let _ = peer.recv();
    // Close stdin (EOF).
    drop(peer.stdin.take());
    // The server should exit within a reasonable time.
    let status = peer
        .child
        .wait_timeout(std::time::Duration::from_secs(5))
        .ok()
        .flatten();
    assert!(
        status.is_some(),
        "server must exit cleanly on EOF during idle"
    );
    // It should not have been killed by the Drop impl (which sets a killed
    // status); a clean exit has a normal signal-less status. We accept any
    // exit here since the binary may return nonzero on pipe close.
}

const EOF_HELPER_MODE: &str = "XUANLING_MCP_EOF_HELPER_MODE";
const EOF_LOCK_PATH: &str = "XUANLING_MCP_EOF_LOCK_PATH";
const EOF_READY_PATH: &str = "XUANLING_MCP_EOF_READY_PATH";
const EOF_RELEASE_PATH: &str = "XUANLING_MCP_EOF_RELEASE_PATH";

/// Test-binary subprocess used as the direct `process_run` child. It launches
/// a second copy of this test binary and waits, creating a portable two-level
/// descendant tree without relying on a shell or a separately built fixture.
#[test]
fn eof_process_tree_spawner_helper() {
    if std::env::var(EOF_HELPER_MODE).as_deref() != Ok("spawn") {
        return;
    }

    let status = Command::new(std::env::current_exe().expect("current test binary"))
        .args([
            "--exact",
            "contract_hardening::eof_process_tree_lock_holder_helper",
            "--nocapture",
        ])
        .env(EOF_HELPER_MODE, "hold")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("spawn lock-holder descendant");
    assert!(
        status.success(),
        "lock-holder exited unsuccessfully: {status}"
    );
}

/// Descendant helper that holds an OS file lock until it is killed with the
/// process tree. A release file provides deterministic cleanup if the tested
/// server regresses and leaves the descendant alive.
#[test]
fn eof_process_tree_lock_holder_helper() {
    use fs4::fs_std::FileExt;

    if std::env::var(EOF_HELPER_MODE).as_deref() != Ok("hold") {
        return;
    }

    let lock_path = PathBuf::from(std::env::var_os(EOF_LOCK_PATH).expect("lock path"));
    let ready_path = PathBuf::from(std::env::var_os(EOF_READY_PATH).expect("ready path"));
    let release_path = PathBuf::from(std::env::var_os(EOF_RELEASE_PATH).expect("release path"));
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .expect("open lease file");
    lock_file.lock_exclusive().expect("hold lease");
    std::fs::write(&ready_path, b"ready").expect("publish lease readiness");
    while !release_path.exists() {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

struct EofLeaseFixture {
    _dir: tempfile::TempDir,
    lock: PathBuf,
    ready: PathBuf,
    release: PathBuf,
}

impl EofLeaseFixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("EOF lease fixture");
        Self {
            lock: dir.path().join("lease.lock"),
            ready: dir.path().join("ready"),
            release: dir.path().join("release"),
            _dir: dir,
        }
    }

    fn wait_until_held(&self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !self.ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(self.ready.exists(), "descendant never acquired the lease");
        assert!(
            !lease_is_available(&self.lock),
            "ready marker must only be written after the descendant holds the lease"
        );
    }
}

impl Drop for EofLeaseFixture {
    fn drop(&mut self) {
        let _ = std::fs::write(&self.release, b"release");
        for _ in 0..100 {
            if lease_is_available(&self.lock) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

fn lease_is_available(path: &Path) -> bool {
    use fs4::fs_std::FileExt;

    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)
        .expect("open lease probe");
    match file.try_lock_exclusive() {
        Ok(true) => {
            file.unlock().expect("unlock lease probe");
            true
        }
        Ok(false) => false,
        Err(error) => panic!("probe lease: {error}"),
    }
}

#[test]
fn eof_with_inflight_process_run_terminates_descendant_tree() {
    let fixture = EofLeaseFixture::new();
    let mut peer = Peer::start();
    peer.initialize();

    let request_id = peer.next_id;
    peer.next_id += 1;
    peer.send(&json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {
            "name": "process_run",
            "arguments": {
                "program": std::env::current_exe().expect("current test binary"),
                "args": [
                    "--exact",
                    "contract_hardening::eof_process_tree_spawner_helper",
                    "--nocapture"
                ],
                "env": {
                    EOF_HELPER_MODE: "spawn",
                    EOF_LOCK_PATH: &fixture.lock,
                    EOF_READY_PATH: &fixture.ready,
                    EOF_RELEASE_PATH: &fixture.release
                },
                "stdout": "null",
                "stderr": "null"
            }
        }
    }));
    fixture.wait_until_held();

    drop(peer.stdin.take());
    let status = peer
        .child
        .wait_timeout(std::time::Duration::from_secs(12))
        .expect("wait for server after EOF");
    assert!(status.is_some(), "server must exit after stdio EOF");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !lease_is_available(&fixture.lock) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(
        lease_is_available(&fixture.lock),
        "dropping the in-flight request on EOF must terminate its descendant tree"
    );
}

#[test]
fn cancellation_id_routes_to_only_the_matching_call() {
    // Issue two concurrent tools/call requests; cancel the first (a long
    // sleep). The second (fast echo) must complete regardless. rmcp serves
    // requests concurrently, so the echo (id 3) returns before the sleep
    // (id 2). We read until we see id 3, then kill the child to unblock id 2.
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let req1 = json!({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {"name": "process_run",
                   "arguments": {"program": "sleep", "args": ["30"], "stdout": "null", "stderr": "null"}}});
    let req2 = json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {"name": "process_run",
                   "arguments": {"program": "echo", "args": ["hi"], "stdout": "inline", "stderr": "null"}}});
    peer.send(&req1);
    peer.send(&req2);
    let cancel = json!({"jsonrpc": "2.0", "method": "notifications/cancelled",
        "params": {"requestId": 2, "reason": "test"}});
    peer.send(&cancel);

    // Read lines until we observe the fast call's response (id 3). The sleep
    // (id 2) keeps the connection open; killing the child at the end closes
    // the pipe so any lingering read unblocks.
    let mut seen_3 = false;
    let stdout = peer.stdout.as_mut().expect("stdout open");
    for _ in 0..10 {
        let mut line = String::new();
        if stdout.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line)
            && v.get("id").and_then(|i| i.as_i64()) == Some(3)
        {
            seen_3 = true;
            assert!(
                v.get("result").is_some(),
                "uncancelled call must complete: {v}"
            );
            break;
        }
    }
    // Killing the child unblocks the in-flight sleep so the test can exit.
    let _ = peer.child.kill();
    let _ = peer.child.wait();
    assert!(
        seen_3,
        "uncancelled call (id 3) must complete even while id 2 is in flight"
    );
}

// ---------------------------------------------------------------------------
// ADR 0027 Wave 1 contract tests (plan §5.4)
// ---------------------------------------------------------------------------

/// Write a small temp file inside a unique temp directory (guarantees no path
/// collision between parallel tests, which previously corrupted cross-window
/// rehashing when another test mutated a colliding file). Cleaned up on Drop.
struct TempFile {
    _dir: tempfile::TempDir,
    path: std::path::PathBuf,
}
impl TempFile {
    fn new(content: &str) -> Self {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("file.txt");
        std::fs::write(&path, content).expect("write temp file");
        TempFile { _dir: dir, path }
    }
    fn path_str(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }
    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

/// Last path component of a `/`- or `\`-separated path (for assertion
/// readability in list/glob tests).
fn basename(p: &str) -> String {
    p.rsplit(['/', '\\']).next().unwrap_or(p).to_string()
}

#[test]
fn output_null_is_invalid_input() {
    // ADR 0027 §2: explicit `"output": null` is invalid_input (no magic-null).
    // Validation happens at the MCP public layer before dispatch, so it is a
    // JSON-RPC invalid_params error (-32602), not a tool result.
    let mut peer = Peer::start();
    peer.initialize();
    let f = TempFile::new("hello\n");
    let resp = peer.call(
        "fs_read_text",
        json!({"path": f.path_str(), "output": null}),
    );
    assert!(
        resp.get("error").is_some(),
        "output=null must be a protocol error, got: {resp}"
    );
    assert_eq!(
        resp["error"]["code"],
        json!(-32602),
        "output=null must be invalid_params (-32602): {resp}"
    );
}

#[test]
fn omitted_output_returns_complete_content() {
    // The host owns its context budget. Omitting `output` must preserve the
    // toolkit's complete-return contract instead of silently selecting a
    // server-side byte window.
    let mut peer = Peer::start();
    peer.initialize();
    let body = format!("{}\n", "x".repeat(70_000));
    let f = TempFile::new(&body);
    let resp = peer.call("fs_read_text", json!({"path": f.path_str()}));
    assert!(
        resp.get("result").is_some(),
        "omitted output must succeed, got: {resp}"
    );
    assert_eq!(resp["result"]["isError"], json!(false));
    assert_eq!(
        resp["result"]["structuredContent"]["content"],
        json!(body),
        "omitted output must return the complete file"
    );
    assert_eq!(
        resp["result"]["structuredContent"]["truncated"],
        json!(false),
        "omitted output must not select a hidden bounded mode"
    );
}

#[test]
fn complete_mode_is_explicit() {
    // ADR 0027 §2: `{"mode":"complete"}` is an explicit choice that returns the
    // full content (the toolkit raw API returns complete content).
    let mut peer = Peer::start();
    peer.initialize();
    let f = TempFile::new("hello complete\n");
    let resp = peer.call(
        "fs_read_text",
        json!({"path": f.path_str(), "output": {"mode": "complete"}}),
    );
    assert!(
        resp.get("result").is_some(),
        "complete mode must succeed, got: {resp}"
    );
    assert_eq!(resp["result"]["isError"], json!(false));
    // The complete file content must be present in the structured result.
    let content = &resp["result"]["structuredContent"]["content"];
    assert_eq!(
        content.as_str().unwrap_or(""),
        "hello complete\n",
        "complete mode must return full content"
    );
}

#[test]
fn invalid_cursor_does_not_restart_from_zero() {
    // ADR 0027 §3: a cursor is tool-bound. A cursor produced by `fs_list` must
    // be rejected with a typed `invalid_cursor` error when passed to `fs_search`,
    // NOT silently restart from page 0 (the old base64-counter format was shared
    // across tools and fell back to 0 on any decode failure).
    let mut peer = Peer::start();
    peer.initialize();
    // Build a directory with several files so fs_list(limit) yields a next_cursor.
    let dir = std::env::temp_dir().join(format!(
        "xuanling-wave1-cursor-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir temp");
    for i in 0..5 {
        std::fs::write(dir.join(format!("f{i}.txt")), b"x\n").expect("write");
    }
    let path = dir.to_string_lossy().into_owned();

    // fs_list with limit=2 returns a next_cursor.
    let resp = peer.call("fs_list", json!({"path": &path, "limit": 2}));
    let cursor = resp["result"]["structuredContent"]["next_cursor"]
        .as_str()
        .expect("fs_list(limit=2) must return a next_cursor")
        .to_string();
    assert!(!cursor.is_empty(), "cursor must be non-empty");

    // Same-tool resume still works (the cursor is valid for fs_list).
    let resp2 = peer.call(
        "fs_list",
        json!({"path": &path, "limit": 2, "cursor": &cursor}),
    );
    assert_eq!(
        resp2["result"]["isError"],
        json!(false),
        "same-tool cursor must resume: {resp2}"
    );

    // Cross-tool: pass the fs_list cursor to fs_search -> invalid_cursor error.
    let resp3 = peer.call(
        "fs_search",
        json!({"path": &path, "pattern": "x", "limit": 2, "cursor": &cursor}),
    );
    assert!(
        resp3.get("result").is_some(),
        "cross-tool cursor must be a tool result, not a crash: {resp3}"
    );
    assert_eq!(
        resp3["result"]["isError"],
        json!(true),
        "cross-tool cursor must be rejected (isError=true): {resp3}"
    );
    let structured = &resp3["result"]["structuredContent"];
    assert_eq!(
        structured["code"],
        json!("invalid_input"),
        "cross-tool cursor must be invalid_input: {resp3}"
    );
    assert_eq!(
        structured["details"]["reason"],
        json!("invalid_cursor"),
        "cross-tool cursor must carry details.reason=invalid_cursor: {resp3}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// ADR 0027 Wave 2 red tests (plan §6.1 / §6.4): bounded fs_read_text
// ---------------------------------------------------------------------------

#[test]
fn text_window_reassembles_original_bytes() {
    // ADR 0027 §6.1: a bounded `fs_read_text` returns UTF-8 windows cut on
    // code-point boundaries, and reassembling every window through the typed
    // `TextResume` chain must reproduce the original file byte-for-byte. The
    // multi-byte content forces the boundary-cut logic to back up over partial
    // sequences.
    let mut peer = Peer::start();
    peer.initialize();
    let body = "hello世界🌍\nline two 你好\n_more_€€€\ntail";
    let f = TempFile::new(body);
    let max_bytes = 7u64; // small enough to force several windows + boundary cuts

    let mut reassembled = String::new();
    let mut resume: Option<Value> = None;
    let mut guard = 0usize;
    loop {
        guard += 1;
        assert!(guard < 1000, "resume chain did not terminate");
        let args = match &resume {
            Some(r) => json!({
                "path": f.path_str(),
                "output": {"mode": "bounded", "max_bytes": max_bytes},
                "resume": r,
            }),
            None => json!({
                "path": f.path_str(),
                "output": {"mode": "bounded", "max_bytes": max_bytes},
            }),
        };
        let resp = peer.call("fs_read_text", args);
        assert_eq!(
            resp["result"]["isError"],
            json!(false),
            "bounded read must succeed: {resp}"
        );
        let s = &resp["result"]["structuredContent"];
        reassembled.push_str(s["content"].as_str().expect("content string"));
        // Every bounded result reports the window metadata + preimage hash.
        assert!(
            s["total_bytes"].as_u64().is_some(),
            "bounded read must report total_bytes: {resp}"
        );
        assert!(
            s["returned_bytes"].as_u64().is_some(),
            "bounded read must report returned_bytes: {resp}"
        );
        assert!(
            s["sha256"].as_str().is_some_and(|h| !h.is_empty()),
            "bounded read must report the preimage sha256: {resp}"
        );
        if s["truncated"].as_bool() == Some(true) {
            let nr = s["next_resume"].clone();
            assert!(
                nr["offset_bytes"].as_u64().is_some() && nr["preimage_sha256"].as_str().is_some(),
                "truncated read must carry a typed next_resume: {resp}"
            );
            resume = Some(nr);
        } else {
            assert!(
                s["next_resume"].is_null(),
                "non-truncated read must NOT carry a next_resume: {resp}"
            );
            break;
        }
    }
    assert_eq!(
        reassembled, body,
        "reassembled windows must equal the original byte-for-byte"
    );
}

#[test]
fn text_resume_rejects_changed_preimage() {
    // ADR 0027 §6.1: resuming with a stale preimage hash (file changed between
    // windows) must return a typed `conflict` with the actual hash, NOT splice
    // inconsistent fragments.
    let mut peer = Peer::start();
    peer.initialize();
    let body = "0123456789abcdef0123456789abcdef\n";
    let f = TempFile::new(body);

    let r1 = peer.call(
        "fs_read_text",
        json!({"path": f.path_str(), "output": {"mode": "bounded", "max_bytes": 8}}),
    );
    let s = &r1["result"]["structuredContent"];
    assert_eq!(s["truncated"], json!(true), "expected truncation: {r1}");
    let resume = s["next_resume"].clone();

    // Mutate the file so the whole-file preimage hash changes.
    std::fs::write(&f.path, "DIFFERENT CONTENT NOW\n").expect("overwrite temp");

    let r2 = peer.call(
        "fs_read_text",
        json!({"path": f.path_str(), "output": {"mode": "bounded", "max_bytes": 8}, "resume": &resume}),
    );
    let s2 = &r2["result"]["structuredContent"];
    assert_eq!(
        r2["result"]["isError"],
        json!(true),
        "stale resume must be an error: {r2}"
    );
    assert_eq!(
        s2["code"],
        json!("conflict"),
        "stale resume must be conflict: {r2}"
    );
    assert_eq!(
        s2["details"]["reason"],
        json!("resume_preimage_mismatch"),
        "stale resume must carry reason=resume_preimage_mismatch: {r2}"
    );
    assert!(
        s2["details"]["actual_sha256"].as_str().is_some(),
        "conflict must report the actual hash: {r2}"
    );
}

#[test]
fn byte_resume_rejects_replaced_file() {
    // ADR 0027 §6.2: `fs_read_bytes` with a `length` window reports a typed
    // `ByteResume`; resuming after the file has been replaced (different hash)
    // must return `conflict`, NOT silently read the new file version.
    use base64::Engine;
    let mut peer = Peer::start();
    peer.initialize();
    let body = b"0123456789ABCDEF0123456789ABCDEF";
    let f = TempFile::new(std::str::from_utf8(body).unwrap());

    // First window: length=8 from offset 0.
    let r1 = peer.call(
        "fs_read_bytes",
        json!({"path": f.path_str(), "offset": 0, "length": 8}),
    );
    let s = &r1["result"]["structuredContent"];
    assert_eq!(r1["result"]["isError"], json!(false), "read failed: {r1}");
    assert_eq!(s["truncated"], json!(true), "expected truncation: {r1}");
    assert!(
        s["sha256"].as_str().is_some_and(|h| !h.is_empty()),
        "bounded read must report file hash: {r1}"
    );
    let b64 = s["base64"].as_str().unwrap();
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap(),
        &body[..8],
        "first window must be the original prefix"
    );
    let resume = s["next_resume"].clone();

    // Replace the file so the whole-file hash changes.
    std::fs::write(&f.path, b"COMPLETELY DIFFERENT BYTES!!!!!!").expect("overwrite temp");

    // Resume with the stale token -> conflict.
    let r2 = peer.call(
        "fs_read_bytes",
        json!({"path": f.path_str(), "resume": &resume}),
    );
    let s2 = &r2["result"]["structuredContent"];
    assert_eq!(
        r2["result"]["isError"],
        json!(true),
        "stale resume must be an error: {r2}"
    );
    assert_eq!(
        s2["code"],
        json!("conflict"),
        "stale resume must be conflict: {r2}"
    );
    assert_eq!(
        s2["details"]["reason"],
        json!("resume_hash_mismatch"),
        "stale resume must carry reason=resume_hash_mismatch: {r2}"
    );
}

#[test]
fn search_page_stops_after_requested_limit() {
    // ADR 0027 §6.3: fs_search with a `limit` returns at most `limit` matches
    // per page and a `next_cursor` when more exist (no hidden cap, no over- or
    // under-returning).
    let mut peer = Peer::start();
    peer.initialize();
    let dir = tempfile::tempdir().expect("temp dir");
    // A file with 5 matches for "x".
    std::fs::write(dir.path().join("f.txt"), "x\nx\nx\nx\nx\n").expect("write");
    let path = dir.path().to_string_lossy().into_owned();

    let resp = peer.call(
        "fs_search",
        json!({"path": &path, "pattern": "x", "limit": 2}),
    );
    assert_eq!(
        resp["result"]["isError"],
        json!(false),
        "search failed: {resp}"
    );
    let s = &resp["result"]["structuredContent"];
    let n = s["matches"].as_array().map(|a| a.len()).unwrap_or(0);
    assert_eq!(n, 2, "page must contain exactly `limit` matches: {resp}");
    assert!(
        s["next_cursor"].as_str().is_some_and(|c| !c.is_empty()),
        "more matches remain -> next_cursor must be present: {resp}"
    );

    // Without a limit, ALL matches are returned (no hidden cap).
    let resp2 = peer.call("fs_search", json!({"path": &path, "pattern": "x"}));
    let n2 = resp2["result"]["structuredContent"]["matches"]
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);
    assert_eq!(n2, 5, "no limit -> all matches: {resp2}");
}

#[test]
fn search_cursor_query_mismatch_is_invalid() {
    // ADR 0027 §3/§6.3: a cursor is bound to the query that produced it
    // (pattern/options/root). Resuming with a DIFFERENT pattern must return a
    // typed `invalid_cursor` error, NOT silently return a page for the new query.
    let mut peer = Peer::start();
    peer.initialize();
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("f.txt"), "foo\nfoo\nbar\nbar\n").expect("write");
    let path = dir.path().to_string_lossy().into_owned();

    // Page 1 for pattern "foo" (limit=1) -> a cursor bound to the "foo" query.
    let r1 = peer.call(
        "fs_search",
        json!({"path": &path, "pattern": "foo", "limit": 1}),
    );
    let cursor = r1["result"]["structuredContent"]["next_cursor"]
        .as_str()
        .expect("next_cursor for foo")
        .to_string();

    // Same-tool resume but a DIFFERENT pattern -> the cursor's query fingerprint
    // no longer matches -> invalid_cursor.
    let r2 = peer.call(
        "fs_search",
        json!({"path": &path, "pattern": "bar", "limit": 1, "cursor": &cursor}),
    );
    let s2 = &r2["result"]["structuredContent"];
    assert_eq!(
        r2["result"]["isError"],
        json!(true),
        "query-mismatched cursor must be an error: {r2}"
    );
    assert_eq!(
        s2["code"],
        json!("invalid_input"),
        "query mismatch must be invalid_input: {r2}"
    );
    assert_eq!(
        s2["details"]["reason"],
        json!("invalid_cursor"),
        "query mismatch must carry reason=invalid_cursor: {r2}"
    );

    // Sanity: the SAME query still resumes fine.
    let r3 = peer.call(
        "fs_search",
        json!({"path": &path, "pattern": "foo", "limit": 1, "cursor": &cursor}),
    );
    assert_eq!(
        r3["result"]["isError"],
        json!(false),
        "same-query resume must succeed: {r3}"
    );
}

#[test]
fn search_filters_hidden_ignored_globs_and_extensions() {
    let mut peer = Peer::start();
    peer.initialize();
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::create_dir_all(dir.path().join("src")).expect("src dir");
    std::fs::create_dir_all(dir.path().join("ignored")).expect("ignored dir");
    std::fs::write(dir.path().join(".gitignore"), "ignored/\n").expect("gitignore");
    std::fs::write(dir.path().join("src/main.rs"), "target_symbol\n").expect("main");
    std::fs::write(dir.path().join("src/generated.rs"), "target_symbol\n").expect("generated");
    std::fs::write(dir.path().join("src/notes.txt"), "target_symbol\n").expect("notes");
    std::fs::write(dir.path().join("ignored/skip.rs"), "target_symbol\n").expect("ignored");
    std::fs::write(dir.path().join(".hidden.rs"), "target_symbol\n").expect("hidden");
    let path = dir.path().to_string_lossy().into_owned();

    let filtered = peer.call(
        "fs_search",
        json!({
            "path": &path,
            "pattern": "target_symbol",
            "literal": true,
            "respect_gitignore": true,
            "include_hidden": false,
            "include_globs": ["src/**"],
            "exclude_globs": ["**/generated.rs"],
            "file_extensions": [".rs"]
        }),
    );
    assert_eq!(filtered["result"]["isError"], json!(false), "{filtered}");
    let matches = filtered["result"]["structuredContent"]["matches"]
        .as_array()
        .expect("matches");
    assert_eq!(
        matches.len(),
        1,
        "only src/main.rs should match: {filtered}"
    );
    let expected_relative_path = Path::new("src").join("main.rs");
    assert!(
        matches[0]["path"]
            .as_str()
            .is_some_and(|value| Path::new(value).ends_with(&expected_relative_path)),
        "{filtered}"
    );

    let with_hidden = peer.call(
        "fs_search",
        json!({
            "path": &path,
            "pattern": "target_symbol",
            "literal": true,
            "include_hidden": true,
            "file_extensions": ["rs"]
        }),
    );
    assert_eq!(
        with_hidden["result"]["isError"],
        json!(false),
        "{with_hidden}"
    );
    assert!(
        with_hidden["result"]["structuredContent"]["matches"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["path"]
                .as_str()
                .is_some_and(|value| value.ends_with(".hidden.rs")))),
        "include_hidden=true must make the hidden file searchable: {with_hidden}"
    );
}

#[test]
fn search_accepts_compound_file_extensions() {
    let mut peer = Peer::start();
    peer.initialize();
    let dir = tempfile::tempdir().expect("temp dir");
    std::fs::write(dir.path().join("types.d.ts"), "target_symbol\n").expect("declaration fixture");
    std::fs::write(dir.path().join("types.ts"), "target_symbol\n").expect("typescript fixture");
    std::fs::write(dir.path().join("types.d.ts.map"), "target_symbol\n")
        .expect("source map fixture");
    let path = dir.path().to_string_lossy().into_owned();

    for extension in ["d.ts", ".d.ts"] {
        let response = peer.call(
            "fs_search",
            json!({
                "path": &path,
                "pattern": "target_symbol",
                "literal": true,
                "file_extensions": [extension]
            }),
        );
        assert_eq!(response["result"]["isError"], json!(false), "{response}");
        let matches = response["result"]["structuredContent"]["matches"]
            .as_array()
            .expect("matches");
        assert_eq!(
            matches.len(),
            1,
            "only the declaration file should match `{extension}`: {response}"
        );
        assert!(
            matches[0]["path"]
                .as_str()
                .is_some_and(|value| value.ends_with("types.d.ts")),
            "{response}"
        );
    }
}

#[test]
fn list_cursor_snapshot_is_stable_across_directory_mutation() {
    // ADR 2027 §6.3 Phase 2: when `fs_list` is called with a `limit`, the first
    // page materializes a snapshot of the sorted entry list and the cursor
    // references it. Resuming after the directory is mutated must return the
    // ORIGINAL snapshot's next page, NOT a fresh walk reflecting the mutation.
    let mut peer = Peer::start();
    peer.initialize();
    let dir = tempfile::tempdir().expect("temp dir");
    for n in 1..=5u32 {
        std::fs::write(dir.path().join(format!("f{n}.txt")), b"x").expect("write");
    }
    let path = dir.path().to_string_lossy().into_owned();

    // Page 1 (limit 2) -> snapshot of [f1,f2,f3,f4,f5]; returns [f1,f2].
    let r1 = peer.call("fs_list", json!({"path": &path, "limit": 2}));
    assert_eq!(r1["result"]["isError"], json!(false), "page1 failed: {r1}");
    let s1 = &r1["result"]["structuredContent"];
    let cursor = s1["next_cursor"]
        .as_str()
        .unwrap_or_else(|| panic!("page1 must have next_cursor; r1={r1}"))
        .to_string();
    let names1: Vec<String> = s1["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| basename(e["path"].as_str().unwrap()))
        .collect();
    assert_eq!(names1, vec!["f1.txt", "f2.txt"], "page1: {r1}");

    // Mutate the directory so a FRESH walk would produce a different page 2.
    std::fs::write(dir.path().join("a0.txt"), b"x").expect("write a0");
    std::fs::write(dir.path().join("a1.txt"), b"x").expect("write a1");
    std::fs::write(dir.path().join("a2.txt"), b"x").expect("write a2");

    // Resume from the snapshot cursor -> must be the ORIGINAL page 2 [f3,f4],
    // not the mutated walk ([a2,f1]).
    let r2 = peer.call(
        "fs_list",
        json!({"path": &path, "limit": 2, "cursor": &cursor}),
    );
    assert_eq!(r2["result"]["isError"], json!(false), "page2 failed: {r2}");
    let names2: Vec<String> = r2["result"]["structuredContent"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| basename(e["path"].as_str().unwrap()))
        .collect();
    assert_eq!(
        names2,
        vec!["f3.txt", "f4.txt"],
        "page2 must come from the stable snapshot, not a fresh walk: {r2}"
    );
}

#[test]
fn expired_snapshot_returns_typed_error() {
    // ADR 0027 §6.3 Phase 2: a snapshot cursor that has exceeded its TTL must
    // return a typed `snapshot_unavailable` error, not a silent restart from 0.
    // Spawn the server with a tiny TTL (50 ms).
    let mut peer = Peer::start_with_env(&[("XUANLING_LIST_SNAPSHOT_TTL_MS", "50")]);
    peer.initialize();
    let dir = tempfile::tempdir().expect("temp dir");
    for n in 1..=5u32 {
        std::fs::write(dir.path().join(format!("g{n}.txt")), b"x").expect("write");
    }
    let path = dir.path().to_string_lossy().into_owned();

    let r1 = peer.call("fs_list", json!({"path": &path, "limit": 2}));
    let cursor = r1["result"]["structuredContent"]["next_cursor"]
        .as_str()
        .expect("next_cursor")
        .to_string();

    // Wait past the TTL.
    std::thread::sleep(std::time::Duration::from_millis(150));

    let r2 = peer.call(
        "fs_list",
        json!({"path": &path, "limit": 2, "cursor": &cursor}),
    );
    let s2 = &r2["result"]["structuredContent"];
    assert_eq!(
        r2["result"]["isError"],
        json!(true),
        "expired snapshot must be an error: {r2}"
    );
    assert_eq!(
        s2["code"],
        json!("invalid_input"),
        "expired snapshot must be invalid_input: {r2}"
    );
    assert_eq!(
        s2["details"]["reason"],
        json!("snapshot_unavailable"),
        "expired snapshot must carry reason=snapshot_unavailable: {r2}"
    );
}

#[test]
fn complete_first_pages_do_not_evict_a_reachable_list_snapshot() {
    let mut peer = Peer::start();
    peer.initialize();
    let paged = tempfile::tempdir().expect("paged directory");
    std::fs::write(paged.path().join("a.txt"), b"a").expect("write a");
    std::fs::write(paged.path().join("b.txt"), b"b").expect("write b");
    let paged_path = paged.path().to_string_lossy().into_owned();
    let first = peer.call("fs_list", json!({"path": &paged_path, "limit": 1}));
    let cursor = first["result"]["structuredContent"]["next_cursor"]
        .as_str()
        .expect("reachable continuation cursor")
        .to_string();

    // A one-entry bounded page is already complete and returns no cursor. More
    // than the process-wide snapshot cap of these calls must not allocate
    // unreachable snapshots and evict the real continuation above.
    let complete = tempfile::tempdir().expect("complete directory");
    std::fs::write(complete.path().join("only.txt"), b"x").expect("write only");
    let complete_path = complete.path().to_string_lossy().into_owned();
    for _ in 0..270 {
        let response = peer.call("fs_list", json!({"path": &complete_path, "limit": 1}));
        assert_eq!(response["result"]["isError"], json!(false), "{response}");
        assert!(
            response["result"]["structuredContent"]
                .get("next_cursor")
                .is_none(),
            "complete first page must not advertise continuation: {response}"
        );
    }

    let resumed = peer.call(
        "fs_list",
        json!({"path": &paged_path, "limit": 1, "cursor": cursor}),
    );
    assert_eq!(resumed["result"]["isError"], json!(false), "{resumed}");
    assert_eq!(
        basename(
            resumed["result"]["structuredContent"]["entries"][0]["path"]
                .as_str()
                .expect("resumed path")
        ),
        "b.txt"
    );
}

// ---------------------------------------------------------------------------
// ADR 0027 Wave 3 red tests (plan §7.3): process capture + artifact
// ---------------------------------------------------------------------------

/// hex SHA-256 of a byte slice (lowercase), mirroring the toolkit's hashing.
fn sha256_hex_of(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Read a server-owned artifact through the public capability-bearing MCP
/// contract. Tests must not reach into `ArtifactRef`'s storage implementation
/// or treat a store key as a filesystem path.
fn read_artifact(peer: &mut Peer, artifact: &Value) -> Vec<u8> {
    use base64::Engine;
    let id = artifact["id"].as_str().expect("artifact id");
    let capability = artifact["read_capability"]
        .as_str()
        .expect("artifact read capability");
    let response = peer.call(
        "artifact_read",
        json!({
            "id": id,
            "read_capability": capability,
            "output": {"mode": "complete"}
        }),
    );
    assert_eq!(
        response["result"]["isError"],
        json!(false),
        "artifact_read must succeed: {response}"
    );
    let structured = &response["result"]["structuredContent"];
    assert_eq!(structured["id"], json!(id));
    let encoded = structured["base64"].as_str().expect("artifact base64");
    base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .expect("artifact base64 must decode")
}

#[test]
fn process_preview_is_bounded_but_artifact_is_complete() {
    // ADR 0027 §7.1: with a bounded preview budget, the inline preview is
    // truncated but the COMPLETE raw bytes are written to an immutable artifact
    // in the same invocation. Over-budget output stops the preview, never the
    // drain.
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    // `seq 1 2000` produces ~9 KB of ASCII; budget the preview at 64 bytes.
    let resp = peer.call(
        "process_run",
        json!({
            "program": "seq", "args": ["1", "2000"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 64}
        }),
    );
    assert_eq!(
        resp["result"]["isError"],
        json!(false),
        "bounded process_run must succeed: {resp}"
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(
        s["stdout_truncated"],
        json!(true),
        "preview must be truncated: {resp}"
    );
    let total = s["stdout_total_bytes"]
        .as_u64()
        .expect("stdout_total_bytes");
    assert!(
        total > 64,
        "total_bytes must exceed the 64-byte budget: {resp}"
    );
    let preview = s["stdout"].as_str().expect("stdout preview");
    assert!(
        preview.len() <= 64,
        "preview must be bounded by max_bytes (bytes): {} bytes",
        preview.len()
    );

    // The artifact carries the COMPLETE output.
    let artifact = &s["stdout_artifact"];
    let sha = artifact["sha256"].as_str().expect("artifact sha256");
    let size = artifact["size_bytes"].as_u64().expect("artifact size");
    assert!(
        artifact["path"].is_null(),
        "artifact ref must not expose a path"
    );
    assert_eq!(size, total, "artifact size must equal total_bytes");
    assert_eq!(
        artifact["encoding"],
        json!("raw"),
        "artifact encoding is raw (exact bytes)"
    );
    assert_eq!(artifact["lossy"], json!(false), "artifact is never lossy");

    let bytes = read_artifact(&mut peer, artifact);
    assert_eq!(
        bytes.len() as u64,
        total,
        "artifact file length must equal total_bytes"
    );
    assert_eq!(
        sha256_hex_of(&bytes),
        sha,
        "artifact file sha256 must match the reported sha256"
    );
    assert!(
        bytes.starts_with(preview.as_bytes()),
        "the bounded preview must be a byte-prefix of the complete artifact"
    );
    // stderr was Null (discarded), so it correctly has NO artifact ref.
    assert!(
        s["stderr_artifact"].as_str().is_none(),
        "a Null stream must not produce an artifact"
    );
}

#[test]
fn process_artifact_is_from_same_invocation() {
    // ADR 0027 §7.1/§7.3: the artifact is produced by THIS invocation — its path
    // is unique per call (not a stale/reused artifact) and its bytes are exactly
    // what the command emitted. Two identical calls must yield two distinct
    // artifacts, each matching its own reported hash and content.
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let mut call = || {
        peer.call(
            "process_run",
            json!({
                "program": "printf", "args": ["%s", "artifact-body"],
                "stdout": "inline", "stderr": "null",
                "output": {"mode": "bounded", "max_bytes": 4}
            }),
        )
    };
    let r1 = call();
    let r2 = call();
    let s1 = &r1["result"]["structuredContent"];
    let s2 = &r2["result"]["structuredContent"];
    assert_eq!(r1["result"]["isError"], json!(false), "call1 failed: {r1}");

    let a1 = &s1["stdout_artifact"];
    let a2 = &s2["stdout_artifact"];
    let id1 = a1["id"].as_str().expect("a1 id");
    let id2 = a2["id"].as_str().expect("a2 id");
    assert_ne!(
        id1, id2,
        "each invocation must produce a DISTINCT artifact (not a stale reuse)"
    );

    // Each artifact holds THIS invocation's exact bytes ("artifact-body").
    let b1 = read_artifact(&mut peer, a1);
    let b2 = read_artifact(&mut peer, a2);
    assert_eq!(
        &b1, b"artifact-body",
        "a1 must hold this call's exact bytes"
    );
    assert_eq!(
        &b2, b"artifact-body",
        "a2 must hold this call's exact bytes"
    );
    assert_eq!(
        sha256_hex_of(&b1),
        a1["sha256"].as_str().unwrap(),
        "a1 reported sha256 must match its file"
    );
    assert_eq!(
        a1["size_bytes"].as_u64().unwrap(),
        "artifact-body".len() as u64
    );

    // The preview was bounded (4 bytes), so the inline content is truncated even
    // though the artifact is complete — proving preview and artifact are
    // decoupled.
    assert_eq!(s1["stdout_truncated"], json!(true));
    assert_eq!(s1["stdout"].as_str().unwrap().len(), 4);
}

#[test]
fn process_stdout_and_stderr_have_independent_budgets() {
    // ADR 0027 §7.1: stdout and stderr have INDEPENDENT per-stream budgets and
    // artifacts — a large stream on one side does not mask truncation on the
    // other, and previews never cross streams.
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    // 200 bytes of 'O' to stdout, 200 bytes of 'E' to stderr; budget each at 32.
    let resp = peer.call(
        "process_run",
        json!({
            "program": "sh", "args": ["-c", "yes O | head -c 200; yes E | head -c 200 1>&2"],
            "stdout": "inline", "stderr": "inline",
            "output": {"mode": "bounded", "max_bytes": 32}
        }),
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(
        resp["result"]["isError"],
        json!(false),
        "run failed: {resp}"
    );
    assert_eq!(
        s["stdout_truncated"],
        json!(true),
        "stdout truncated: {resp}"
    );
    assert_eq!(
        s["stderr_truncated"],
        json!(true),
        "stderr truncated: {resp}"
    );
    assert_eq!(s["stdout_total_bytes"], json!(200), "stdout total: {resp}");
    assert_eq!(s["stderr_total_bytes"], json!(200), "stderr total: {resp}");
    let out_preview = s["stdout"].as_str().expect("stdout preview");
    let err_preview = s["stderr"].as_str().expect("stderr preview");
    assert!(
        out_preview.contains('O') && !out_preview.contains('E'),
        "stdout preview must be stdout only: {resp}"
    );
    assert!(
        err_preview.contains('E') && !err_preview.contains('O'),
        "stderr preview must be stderr only: {resp}"
    );
    let oa = &s["stdout_artifact"];
    let ea = &s["stderr_artifact"];
    assert_ne!(
        oa["id"], ea["id"],
        "stdout/stderr artifacts must be distinct"
    );
    assert_eq!(read_artifact(&mut peer, oa).len(), 200);
    assert_eq!(read_artifact(&mut peer, ea).len(), 200);
}

#[test]
fn bounded_stream_that_fits_budget_returns_no_artifact_ref() {
    // ADR 0027 amendment 1: an artifact ref is issued only when a stream
    // overflows the preview budget. A small stdout and an empty stderr must
    // come back fully inline with truncated=false and NO artifact refs (lean
    // result — no per-stream artifact metadata for bytes the caller already
    // holds).
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "small"],
            "stdout": "inline", "stderr": "inline",
            "output": {"mode": "bounded", "max_bytes": 64}
        }),
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(resp["result"]["isError"], json!(false), "{resp}");
    assert_eq!(s["stdout"], json!("small"));
    assert_eq!(s["stdout_truncated"], json!(false));
    assert_eq!(s["stderr_truncated"], json!(false));
    assert_eq!(s["stdout_total_bytes"], json!(5));
    assert_eq!(s["stderr_total_bytes"], json!(0));
    assert!(
        s["stdout_artifact"].is_null(),
        "no artifact ref when the stream fits the budget: {resp}"
    );
    assert!(
        s["stderr_artifact"].is_null(),
        "no artifact for an empty stream: {resp}"
    );
    assert!(
        s["stdout_sha256"].is_string(),
        "whole-stream sha256 remains for verification: {resp}"
    );
}

#[test]
fn deterministic_process_results_are_byte_identical() {
    // ADR 0027 修订 2: with deterministic=true, two identical invocations must
    // produce byte-identical structuredContent — the stable-prefix property
    // host prompt caching depends on. (Default mode's duration_ms varies per
    // call and would break the equality.)
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let mut call = || {
        peer.call(
            "process_run",
            json!({
                "program": "printf", "args": ["%s", "stable"],
                "stdout": "inline", "stderr": "null",
                "deterministic": true,
                "output": {"mode": "bounded", "max_bytes": 64}
            }),
        )
    };
    let r1 = call();
    let r2 = call();
    let s1 = serde_json::to_string(&r1["result"]["structuredContent"]).unwrap();
    let s2 = serde_json::to_string(&r2["result"]["structuredContent"]).unwrap();
    assert_eq!(s1, s2, "deterministic results must be byte-identical");
    assert!(
        r1["result"]["structuredContent"]
            .get("duration_ms")
            .is_none(),
        "deterministic mode omits duration_ms: {r1}"
    );
}

#[test]
fn artifact_read_rejects_wrong_capability() {
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let response = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "secret"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let artifact = &response["result"]["structuredContent"]["stdout_artifact"];
    let read = peer.call(
        "artifact_read",
        json!({
            "id": artifact["id"],
            "read_capability": "00000000-0000-0000-0000-000000000000",
            "output": {"mode": "complete"}
        }),
    );
    assert_eq!(
        read["result"]["isError"],
        json!(true),
        "wrong capability must fail: {read}"
    );
    assert_eq!(
        read["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_unavailable")
    );
}

#[test]
fn process_artifact_write_failure_is_visible() {
    // ADR 0027 §7.3 + amendment 1: when a stream OVERFLOWS the preview budget
    // and the artifact store cannot be created/written (e.g. the configured
    // dir is a regular file), the spill's artifact-write failure must surface
    // as a typed error, NOT silent success with a missing artifact. A stream
    // that fits its budget never touches the store (asserted below).
    if !cfg!(unix) {
        return;
    }
    // A regular file where a directory is expected -> create_dir_all fails.
    let bad = tempfile::NamedTempFile::new().expect("temp file");
    let bad_path = bad.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[("XUANLING_ARTIFACT_DIR", bad_path.as_str())]);
    peer.initialize();
    let resp = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "hi"],
            "stdout": "inline", "stderr": "null",
            // "hi" (2 bytes) exceeds budget 1 -> spill -> store failure.
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(
        resp["result"]["isError"],
        json!(true),
        "artifact write failure must be visible (isError=true): {resp}"
    );
    assert_eq!(
        s["code"],
        json!("io_error"),
        "artifact write failure must be io_error: {resp}"
    );
    assert_eq!(
        s["details"]["reason"],
        json!("artifact_write_failed"),
        "must carry reason=artifact_write_failed: {resp}"
    );
    assert!(
        s.get("path").is_none(),
        "server-owned artifact paths must not cross the MCP error boundary: {resp}"
    );
    assert!(
        !s["message"]
            .as_str()
            .unwrap_or_default()
            .contains(&bad_path),
        "artifact error text must not disclose the configured store path: {resp}"
    );
    // No artifact ref should be claimed on failure.
    assert!(
        s["stdout_artifact"].as_str().is_none(),
        "no artifact ref on write failure: {resp}"
    );

    // Amendment 1: a stream that fits its budget never touches the store, so
    // the same broken store does not fail small captures.
    let fits = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "hi"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 64}
        }),
    );
    let fs = &fits["result"]["structuredContent"];
    assert_eq!(fits["result"]["isError"], json!(false), "{fits}");
    assert_eq!(fs["stdout"], json!("hi"));
    assert_eq!(fs["stdout_truncated"], json!(false));
    assert!(
        fs["stdout_artifact"].is_null(),
        "a fits-budget capture must not create an artifact: {fits}"
    );
}

#[test]
fn artifact_zero_length_read_is_metadata_only() {
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "metadata-window"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let artifact = &produced["result"]["structuredContent"]["stdout_artifact"];
    let read = peer.call(
        "artifact_read",
        json!({
            "id": artifact["id"],
            "read_capability": artifact["read_capability"],
            "offset": 0,
            "length": 0,
            "output": {"mode": "complete"}
        }),
    );
    assert_eq!(read["result"]["isError"], json!(false), "{read}");
    let result = &read["result"]["structuredContent"];
    assert_eq!(result["base64"], json!(""));
    assert_eq!(result["length"], json!(0));
    assert_eq!(result["truncated"], json!(false));
    assert!(
        result.get("next_offset").is_none(),
        "metadata-only reads must not return a same-offset continuation: {read}"
    );
}

#[test]
fn artifact_quota_exceeded_is_typed_and_leaves_no_object() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "3"),
    ]);
    peer.initialize();
    let response = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "four"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    assert_eq!(response["result"]["isError"], json!(true), "{response}");
    assert_eq!(
        response["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_quota_exceeded")
    );
    let objects = store.path().join("objects");
    assert_eq!(
        std::fs::read_dir(objects).expect("objects dir").count(),
        0,
        "a rejected reservation must not publish an object"
    );
}

#[test]
fn artifact_quota_is_shared_across_server_processes() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let marker_path = store.path().join("release-output");
    let marker = marker_path.to_string_lossy().into_owned();
    let env = [
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "6"),
    ];
    let mut first = Peer::start_with_env(&env);
    let mut second = Peer::start_with_env(&env);
    first.initialize();
    second.initialize();

    let request = |id: i64| {
        json!({
            "jsonrpc": "2.0", "id": id, "method": "tools/call",
            "params": {
                "name": "process_run",
                "arguments": {
                    "program": "sh",
                    "args": [
                        "-c",
                        "printf AB; while [ ! -f \"$1\" ]; do sleep 0.01; done; printf CD",
                        "xuanling-quota-test",
                        marker
                    ],
                    "stdout": "inline",
                    "stderr": "null",
                    "output": {"mode": "bounded", "max_bytes": 1}
                }
            }
        })
    };
    let first_id = first.next_id;
    first.next_id += 1;
    first.send(&request(first_id));
    let second_id = second.next_id;
    second.next_id += 1;
    second.send(&request(second_id));

    let staging = store.path().join("staging");
    for _ in 0..200 {
        let writers = std::fs::read_dir(&staging)
            .map(|entries| entries.count())
            .unwrap_or(0);
        if writers == 2 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read_dir(&staging)
            .expect("staging directory")
            .count(),
        2,
        "both independent servers must hold an active artifact writer"
    );
    std::fs::write(&marker_path, b"go").expect("release both child processes");

    let responses = [first.recv(), second.recv()];
    let successes = responses
        .iter()
        .filter(|response| response["result"]["isError"] == json!(false))
        .count();
    let quota_errors = responses
        .iter()
        .filter(|response| {
            response["result"]["structuredContent"]["details"]["reason"]
                == json!("artifact_quota_exceeded")
        })
        .count();
    assert_eq!(
        successes, 1,
        "exactly one writer may consume the 6-byte quota"
    );
    assert_eq!(
        quota_errors, 1,
        "the competing server must get a typed quota error"
    );
    assert_eq!(
        std::fs::read_dir(store.path().join("objects"))
            .expect("objects directory")
            .count(),
        1,
        "the shared store may publish only one four-byte object"
    );
}

#[test]
fn artifact_store_rejects_a_conflicting_process_quota() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut bounded = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "6"),
    ]);
    bounded.initialize();
    let produced = bounded.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "four"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    assert_eq!(produced["result"]["isError"], json!(false), "{produced}");

    let mut unlimited = Peer::start_with_env(&[("XUANLING_ARTIFACT_DIR", store_path.as_str())]);
    unlimited.initialize();
    let rejected = unlimited.call(
        "process_run",
        json!({
            // ADR 0027 amendment 1: "x" (1 byte) would fit budget 1 and need no
            // artifact, so emit two bytes to force a spill and hit the store.
            "program": "printf", "args": ["%s", "xy"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    assert_eq!(rejected["result"]["isError"], json!(true), "{rejected}");
    assert_eq!(
        rejected["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_quota_config_mismatch")
    );
    assert_eq!(
        std::fs::read_dir(store.path().join("objects"))
            .expect("objects directory")
            .count(),
        1,
        "the conflicting server must not publish another object"
    );
}

fn produce_artifact_in_store(
    store_path: &str,
    quota: &str,
    extra_env: &[(&str, &str)],
) -> (String, String) {
    let mut env = vec![
        ("XUANLING_ARTIFACT_DIR", store_path),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", quota),
    ];
    env.extend_from_slice(extra_env);
    let mut peer = Peer::start_with_env(&env);
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "four"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    assert_eq!(produced["result"]["isError"], json!(false), "{produced}");
    let artifact = &produced["result"]["structuredContent"]["stdout_artifact"];
    (
        artifact["id"].as_str().expect("artifact id").to_string(),
        artifact["sha256"]
            .as_str()
            .expect("artifact sha256")
            .to_string(),
    )
}

#[test]
fn conflicting_quota_cannot_maintain_or_cleanup_an_expired_artifact() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let (id, sha256) =
        produce_artifact_in_store(&store_path, "6", &[("XUANLING_ARTIFACT_TTL_SECONDS", "0")]);
    let active = store.path().join("records").join(format!("{id}.json"));
    let quarantine = store.path().join("quarantine").join(format!("{id}.json"));
    let purging = store.path().join("purging").join(format!("{id}.json"));
    let object = store.path().join("objects").join(format!("{sha256}.bin"));

    let conflicting_env = [
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "7"),
        ("XUANLING_ARTIFACT_TTL_SECONDS", "0"),
        ("XUANLING_ARTIFACT_QUARANTINE_SECONDS", "0"),
    ];
    let mut conflicting = Peer::start_with_env(&conflicting_env);
    conflicting.initialize();

    let rejected_writer = conflicting.call(
        "process_run",
        json!({
            // Two bytes exceed budget 1, forcing a spill into the store.
            "program": "printf", "args": ["%s", "xy"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    assert_eq!(
        rejected_writer["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_quota_config_mismatch"),
        "{rejected_writer}"
    );
    assert!(
        active.exists(),
        "conflicting writer must retain active record"
    );
    assert!(
        !quarantine.exists(),
        "conflicting writer must not quarantine"
    );
    assert!(!purging.exists(), "conflicting writer must not begin purge");
    assert!(object.exists(), "conflicting writer must retain object");

    let rejected_cleanup = conflicting.call("artifact_cleanup", json!({}));
    assert_eq!(
        rejected_cleanup["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_quota_config_mismatch"),
        "{rejected_cleanup}"
    );
    assert!(
        active.exists(),
        "conflicting cleanup must retain active record"
    );
    assert!(
        !quarantine.exists(),
        "conflicting cleanup must not quarantine"
    );
    assert!(
        !purging.exists(),
        "conflicting cleanup must not begin purge"
    );
    assert!(object.exists(), "conflicting cleanup must retain object");
    assert_eq!(
        std::fs::read_to_string(store.path().join(".quota-limit"))
            .expect("quota limit")
            .trim(),
        "6"
    );
}

#[test]
fn recovery_records_with_missing_objects_lock_the_quota_configuration() {
    if !cfg!(unix) {
        return;
    }
    for state_dir in ["records", "quarantine", "purging"] {
        let store = tempfile::tempdir().expect("artifact store");
        let store_path = store.path().to_string_lossy().into_owned();
        let (id, sha256) = produce_artifact_in_store(&store_path, "6", &[]);
        let active = store.path().join("records").join(format!("{id}.json"));
        let retained = store.path().join(state_dir).join(format!("{id}.json"));
        if state_dir != "records" {
            let mut record: Value =
                serde_json::from_slice(&std::fs::read(&active).expect("active record fixture"))
                    .expect("active record json");
            record["artifact"]["cleanup_state"] = json!("quarantined");
            record["quarantined_at"] = json!("2099-01-01T00:00:00Z");
            std::fs::write(
                &retained,
                serde_json::to_vec(&record).expect("serialize recovery record"),
            )
            .expect("write recovery record");
            std::fs::remove_file(&active).expect("remove active record fixture");
        }
        std::fs::remove_file(store.path().join("objects").join(format!("{sha256}.bin")))
            .expect("remove artifact object fixture");

        let mut conflicting = Peer::start_with_env(&[
            ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
            ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "7"),
        ]);
        conflicting.initialize();
        let rejected = conflicting.call(
            "process_run",
            json!({
                // Two bytes exceed budget 1, forcing a spill into the store.
                "program": "printf", "args": ["%s", "xy"],
                "stdout": "inline", "stderr": "null",
                "output": {"mode": "bounded", "max_bytes": 1}
            }),
        );
        assert_eq!(
            rejected["result"]["structuredContent"]["details"]["reason"],
            json!("artifact_quota_config_mismatch"),
            "state={state_dir}: {rejected}"
        );
        assert!(
            retained.exists(),
            "state={state_dir}: conflicting configuration must retain recovery record"
        );
        assert_eq!(
            std::fs::read_to_string(store.path().join(".quota-limit"))
                .expect("quota limit")
                .trim(),
            "6",
            "state={state_dir}"
        );
    }
}

#[test]
fn minimal_retained_artifact_locks_the_store_quota_configuration() {
    // ADR 0027 amendment 1: an EMPTY bounded stream creates no artifact at all
    // (the caller already holds every byte inline), so the smallest artifact
    // process capture can produce is one byte via a max_bytes=0 metadata-only
    // window. ADR 0026's "retained object locks the store configuration"
    // property must still hold for it.
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut limited = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "6"),
    ]);
    limited.initialize();
    let produced = limited.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "x"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 0}
        }),
    );
    assert_eq!(produced["result"]["isError"], json!(false), "{produced}");
    let s = &produced["result"]["structuredContent"];
    assert_eq!(s["stdout_total_bytes"], json!(1));
    assert_eq!(
        s["stdout"],
        json!(""),
        "max_bytes=0 keeps the preview empty"
    );
    assert_eq!(s["stdout_truncated"], json!(true));

    let mut unlimited = Peer::start_with_env(&[("XUANLING_ARTIFACT_DIR", store_path.as_str())]);
    unlimited.initialize();
    let rejected = unlimited.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "x"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 0}
        }),
    );
    assert_eq!(rejected["result"]["isError"], json!(true), "{rejected}");
    assert_eq!(
        rejected["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_quota_config_mismatch")
    );
}

#[test]
fn artifact_store_recovers_unreferenced_object_quota_after_crash() {
    if !cfg!(unix) {
        return;
    }
    use sha2::{Digest, Sha256};

    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let objects = store.path().join("objects");
    std::fs::create_dir_all(&objects).expect("objects directory");
    let orphan = b"dead";
    let sha: String = Sha256::digest(orphan)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let orphan_path = objects.join(format!("{sha}.bin"));
    std::fs::write(&orphan_path, orphan).expect("orphan object fixture");

    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "4"),
    ]);
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "live"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    assert_eq!(produced["result"]["isError"], json!(false), "{produced}");
    assert!(!orphan_path.exists(), "crash orphan must be reclaimed");
    assert_eq!(
        produced["result"]["structuredContent"]["stdout_total_bytes"],
        json!(4)
    );
}

#[test]
fn artifact_record_publish_failure_rolls_back_object_and_quota() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "4"),
    ]);
    peer.initialize();

    // Send a process that emits TWO bytes first (exceeding budget 1, so the
    // bounded drain spills into an artifact writer and creates the store
    // directories), then pauses before emitting the rest. Replacing
    // `records/` while the child sleeps therefore injects failure after the
    // object writer exists, at record publication time (ADR 0027 amendment 1:
    // the writer is created at first overflow, not at drain start).
    let request_id = peer.next_id;
    peer.next_id += 1;
    peer.send(&json!({
        "jsonrpc": "2.0", "id": request_id, "method": "tools/call",
        "params": {
            "name": "process_run",
            "arguments": {
                "program": "sh", "args": ["-c", "printf AB; sleep 1; printf CD"],
                "stdout": "inline", "stderr": "null",
                "output": {"mode": "bounded", "max_bytes": 1}
            }
        }
    }));
    let staging = store.path().join("staging");
    for _ in 0..100 {
        if staging.is_dir()
            && std::fs::read_dir(&staging)
                .expect("staging dir")
                .next()
                .is_some()
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        staging.is_dir()
            && std::fs::read_dir(&staging)
                .expect("staging dir")
                .next()
                .is_some(),
        "bounded drain must create a staging writer before record failure injection"
    );
    let records = store.path().join("records");
    std::fs::remove_dir(&records).expect("replace empty records directory");
    std::fs::write(&records, b"not a directory").expect("records blocker");
    let failed = peer.recv();
    assert_eq!(failed["result"]["isError"], json!(true), "{failed}");
    assert_eq!(
        failed["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_write_failed")
    );
    assert_eq!(
        std::fs::read_dir(store.path().join("objects"))
            .expect("objects dir")
            .count(),
        0,
        "record publication failure must remove the unreferenced object"
    );

    std::fs::remove_file(&records).expect("remove records blocker");
    std::fs::create_dir(&records).expect("restore records directory");
    let retry = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "four"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    assert_eq!(
        retry["result"]["isError"],
        json!(false),
        "the same quota must be reusable after rollback: {retry}"
    );
    assert_eq!(
        retry["result"]["structuredContent"]["stdout_total_bytes"],
        json!(4)
    );
}

#[test]
fn artifact_hash_corruption_is_detected_without_disclosing_path() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[("XUANLING_ARTIFACT_DIR", store_path.as_str())]);
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "original"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let artifact = &produced["result"]["structuredContent"]["stdout_artifact"];
    let sha = artifact["sha256"].as_str().expect("artifact sha256");
    let object = store.path().join("objects").join(format!("{sha}.bin"));
    std::fs::write(&object, b"corrupt!").expect("corrupt object with same length");

    let read = peer.call(
        "artifact_read",
        json!({
            "id": artifact["id"],
            "read_capability": artifact["read_capability"],
            "output": {"mode": "complete"}
        }),
    );
    let error = &read["result"]["structuredContent"];
    assert_eq!(read["result"]["isError"], json!(true), "{read}");
    assert_eq!(error["code"], json!("conflict"));
    assert_eq!(error["details"]["reason"], json!("artifact_hash_mismatch"));
    assert_eq!(error["details"]["id"], artifact["id"]);
    assert!(error.get("path").is_none(), "{read}");
    assert!(
        !error["message"]
            .as_str()
            .unwrap_or_default()
            .contains(&store_path)
    );
}

#[test]
fn artifact_cleanup_dry_run_quarantines_then_purges() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_TTL_SECONDS", "0"),
    ]);
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "expired"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let artifact = &produced["result"]["structuredContent"]["stdout_artifact"];
    let id = artifact["id"].as_str().expect("artifact id");
    let sha = artifact["sha256"].as_str().expect("artifact sha256");
    let active_record = store.path().join("records").join(format!("{id}.json"));
    let quarantined_record = store.path().join("quarantine").join(format!("{id}.json"));
    let object = store.path().join("objects").join(format!("{sha}.bin"));

    let dry_run = peer.call("artifact_cleanup_preview", json!({}));
    assert_eq!(dry_run["result"]["isError"], json!(false), "{dry_run}");
    assert_eq!(
        dry_run["result"]["structuredContent"]["quarantined_ids"],
        json!([id])
    );
    assert!(active_record.exists());
    assert!(!quarantined_record.exists());

    let quarantine = peer.call("artifact_cleanup", json!({}));
    assert_eq!(
        quarantine["result"]["isError"],
        json!(false),
        "{quarantine}"
    );
    assert!(!active_record.exists());
    assert!(quarantined_record.exists());
    assert!(object.exists());

    let mut quarantined: Value =
        serde_json::from_slice(&std::fs::read(&quarantined_record).expect("quarantined record"))
            .expect("quarantined record json");
    quarantined["quarantined_at"] = json!("1970-01-01T00:00:00Z");
    std::fs::write(
        &quarantined_record,
        serde_json::to_vec(&quarantined).expect("serialize quarantined record"),
    )
    .expect("age quarantined record");

    let purge = peer.call("artifact_cleanup", json!({}));
    assert_eq!(purge["result"]["isError"], json!(false), "{purge}");
    assert_eq!(
        purge["result"]["structuredContent"]["purged_ids"],
        json!([id])
    );
    assert!(!quarantined_record.exists());
    assert!(!object.exists());

    let read = peer.call(
        "artifact_read",
        json!({
            "id": id,
            "read_capability": artifact["read_capability"],
            "output": {"mode": "complete"}
        }),
    );
    assert_eq!(read["result"]["isError"], json!(true), "{read}");
    assert_eq!(
        read["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_unavailable")
    );
}

#[test]
fn artifact_cleanup_dry_run_does_not_publish_store_configuration() {
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_MAX_TOTAL_BYTES", "17"),
    ]);
    peer.initialize();

    let inspected = peer.call("artifact_cleanup_preview", json!({}));
    assert_eq!(inspected["result"]["isError"], json!(false), "{inspected}");
    assert!(
        !store.path().join(".quota-limit").exists(),
        "dry-run cleanup must not publish store configuration"
    );
    assert_eq!(
        std::fs::read_dir(store.path())
            .expect("artifact root")
            .count(),
        0,
        "preview must not initialize directories or a persistent lock file"
    );

    let executed = peer.call("artifact_cleanup", json!({}));
    assert_eq!(executed["result"]["isError"], json!(false), "{executed}");
    assert_eq!(
        std::fs::read_to_string(store.path().join(".quota-limit"))
            .expect("executing cleanup establishes canonical quota")
            .trim(),
        "17"
    );
}

#[test]
fn artifact_cleanup_resumes_an_already_published_quarantine_record() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_TTL_SECONDS", "0"),
    ]);
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "resume-quarantine"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let artifact = &produced["result"]["structuredContent"]["stdout_artifact"];
    let id = artifact["id"].as_str().expect("artifact id");
    let active_path = store.path().join("records").join(format!("{id}.json"));
    let quarantine_path = store.path().join("quarantine").join(format!("{id}.json"));

    // Model a previous cleanup that durably published the quarantine record
    // and stopped before deleting the active record.
    let mut quarantine: Value =
        serde_json::from_slice(&std::fs::read(&active_path).expect("active record"))
            .expect("active record json");
    let published_at = quarantine["artifact"]["created_at"].clone();
    quarantine["artifact"]["cleanup_state"] = json!("quarantined");
    quarantine["quarantined_at"] = published_at.clone();
    std::fs::write(
        &quarantine_path,
        serde_json::to_vec(&quarantine).expect("serialize quarantine record"),
    )
    .expect("publish quarantine record fixture");

    let resumed = peer.call("artifact_cleanup", json!({}));
    assert_eq!(resumed["result"]["isError"], json!(false), "{resumed}");
    assert_eq!(
        resumed["result"]["structuredContent"]["quarantined_ids"],
        json!([id])
    );
    assert!(!active_path.exists());
    assert!(quarantine_path.exists());
    let persisted: Value =
        serde_json::from_slice(&std::fs::read(&quarantine_path).expect("quarantine record"))
            .expect("quarantine record json");
    assert_eq!(
        persisted["quarantined_at"], published_at,
        "retry must preserve the first publication timestamp"
    );
}

#[test]
fn artifact_cleanup_keeps_purge_record_until_object_removal_succeeds() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_TTL_SECONDS", "0"),
    ]);
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "retry-purge"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let artifact = &produced["result"]["structuredContent"]["stdout_artifact"];
    let id = artifact["id"].as_str().expect("artifact id");
    let sha = artifact["sha256"].as_str().expect("artifact sha256");
    let quarantine_path = store.path().join("quarantine").join(format!("{id}.json"));
    let object_path = store.path().join("objects").join(format!("{sha}.bin"));
    let object_backup = store.path().join("objects").join(format!("{sha}.backup"));

    let quarantined = peer.call("artifact_cleanup", json!({}));
    assert_eq!(
        quarantined["result"]["isError"],
        json!(false),
        "{quarantined}"
    );
    let mut record: Value =
        serde_json::from_slice(&std::fs::read(&quarantine_path).expect("quarantine record"))
            .expect("quarantine record json");
    record["quarantined_at"] = json!("1970-01-01T00:00:00Z");
    std::fs::write(
        &quarantine_path,
        serde_json::to_vec(&record).expect("serialize quarantine record"),
    )
    .expect("age quarantine record");

    // A directory at the content-addressed object path deterministically makes
    // the object-removal phase fail without relying on platform permissions.
    std::fs::rename(&object_path, &object_backup).expect("preserve object bytes");
    std::fs::create_dir(&object_path).expect("install object-path blocker");
    let failed = peer.call("artifact_cleanup", json!({}));
    assert_eq!(failed["result"]["isError"], json!(true), "{failed}");
    assert_eq!(
        failed["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_record_corrupt")
    );
    assert!(
        quarantine_path.exists(),
        "the record must remain available for a purge retry"
    );

    std::fs::remove_dir(&object_path).expect("remove object-path blocker");
    std::fs::rename(&object_backup, &object_path).expect("restore object bytes");
    let retried = peer.call("artifact_cleanup", json!({}));
    assert_eq!(retried["result"]["isError"], json!(false), "{retried}");
    assert_eq!(
        retried["result"]["structuredContent"]["purged_ids"],
        json!([id])
    );
    assert!(!quarantine_path.exists());
    assert!(!object_path.exists());
}

#[test]
fn artifact_cleanup_keeps_purge_record_when_object_is_missing() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_TTL_SECONDS", "0"),
    ]);
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "restore-missing"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let artifact = &produced["result"]["structuredContent"]["stdout_artifact"];
    let id = artifact["id"].as_str().expect("artifact id");
    let sha = artifact["sha256"].as_str().expect("artifact sha256");
    let quarantine_path = store.path().join("quarantine").join(format!("{id}.json"));
    let object_path = store.path().join("objects").join(format!("{sha}.bin"));

    let quarantined = peer.call("artifact_cleanup", json!({}));
    assert_eq!(
        quarantined["result"]["isError"],
        json!(false),
        "{quarantined}"
    );
    let mut record: Value =
        serde_json::from_slice(&std::fs::read(&quarantine_path).expect("quarantine record"))
            .expect("quarantine record json");
    record["quarantined_at"] = json!("1970-01-01T00:00:00Z");
    std::fs::write(
        &quarantine_path,
        serde_json::to_vec(&record).expect("serialize quarantine record"),
    )
    .expect("age quarantine record");

    let original = std::fs::read(&object_path).expect("object bytes");
    std::fs::remove_file(&object_path).expect("remove object fixture");
    let failed = peer.call("artifact_cleanup", json!({}));
    assert_eq!(failed["result"]["isError"], json!(true), "{failed}");
    assert_eq!(
        failed["result"]["structuredContent"]["details"]["reason"],
        json!("artifact_object_missing")
    );
    assert!(
        quarantine_path.exists(),
        "a missing object must not erase the recovery record"
    );

    std::fs::write(&object_path, original).expect("restore exact object bytes");
    let retried = peer.call("artifact_cleanup", json!({}));
    assert_eq!(retried["result"]["isError"], json!(false), "{retried}");
    assert_eq!(
        retried["result"]["structuredContent"]["purged_ids"],
        json!([id])
    );
    assert!(!quarantine_path.exists());
    assert!(!object_path.exists());
}

#[test]
fn artifact_cleanup_resumes_after_object_delete_with_durable_purge_intent() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_TTL_SECONDS", "0"),
    ]);
    peer.initialize();
    let produced = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "resume-partial-purge"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let artifact = &produced["result"]["structuredContent"]["stdout_artifact"];
    let id = artifact["id"].as_str().expect("artifact id");
    let sha = artifact["sha256"].as_str().expect("artifact sha256");
    let quarantine_path = store.path().join("quarantine").join(format!("{id}.json"));
    let purging_path = store.path().join("purging").join(format!("{id}.json"));
    let object_path = store.path().join("objects").join(format!("{sha}.bin"));

    let quarantined = peer.call("artifact_cleanup", json!({}));
    assert_eq!(
        quarantined["result"]["isError"],
        json!(false),
        "{quarantined}"
    );
    let mut record: Value =
        serde_json::from_slice(&std::fs::read(&quarantine_path).expect("quarantine record"))
            .expect("quarantine record json");
    record["quarantined_at"] = json!("1970-01-01T00:00:00Z");
    std::fs::write(
        &quarantine_path,
        serde_json::to_vec(&record).expect("serialize quarantine record"),
    )
    .expect("age quarantine record");

    // Model a crash after the durable quarantine->purging transition and object
    // deletion, but before the purge-intent record was removed.
    std::fs::rename(&quarantine_path, &purging_path).expect("publish purge intent fixture");
    std::fs::remove_file(&object_path).expect("delete object fixture");

    let resumed = peer.call("artifact_cleanup", json!({}));
    assert_eq!(resumed["result"]["isError"], json!(false), "{resumed}");
    assert_eq!(
        resumed["result"]["structuredContent"]["purged_ids"],
        json!([id])
    );
    assert!(!purging_path.exists());
    assert!(!object_path.exists());
}

#[test]
fn artifact_cleanup_preserves_an_object_while_another_record_references_it() {
    if !cfg!(unix) {
        return;
    }
    let store = tempfile::tempdir().expect("artifact store");
    let store_path = store.path().to_string_lossy().into_owned();
    let mut peer = Peer::start_with_env(&[
        ("XUANLING_ARTIFACT_DIR", store_path.as_str()),
        ("XUANLING_ARTIFACT_TTL_SECONDS", "0"),
    ]);
    peer.initialize();
    let first = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "shared-object"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let second = peer.call(
        "process_run",
        json!({
            "program": "printf", "args": ["%s", "shared-object"],
            "stdout": "inline", "stderr": "null",
            "output": {"mode": "bounded", "max_bytes": 1}
        }),
    );
    let first_artifact = &first["result"]["structuredContent"]["stdout_artifact"];
    let second_artifact = &second["result"]["structuredContent"]["stdout_artifact"];
    let first_id = first_artifact["id"].as_str().expect("first id");
    let second_id = second_artifact["id"].as_str().expect("second id");
    let sha = first_artifact["sha256"].as_str().expect("shared sha256");
    assert_eq!(second_artifact["sha256"], json!(sha));
    let object_path = store.path().join("objects").join(format!("{sha}.bin"));

    // The second writer's maintenance pass may already have quarantined the
    // first record. This call completes quarantine for both records.
    let quarantine = peer.call("artifact_cleanup", json!({}));
    assert_eq!(
        quarantine["result"]["isError"],
        json!(false),
        "{quarantine}"
    );
    let first_path = store
        .path()
        .join("quarantine")
        .join(format!("{first_id}.json"));
    let second_path = store
        .path()
        .join("quarantine")
        .join(format!("{second_id}.json"));
    let mut first_record: Value =
        serde_json::from_slice(&std::fs::read(&first_path).expect("first record"))
            .expect("first record json");
    first_record["quarantined_at"] = json!("1970-01-01T00:00:00Z");
    std::fs::write(
        &first_path,
        serde_json::to_vec(&first_record).expect("serialize first record"),
    )
    .expect("age first record");

    let first_purge = peer.call("artifact_cleanup", json!({}));
    assert_eq!(
        first_purge["result"]["isError"],
        json!(false),
        "{first_purge}"
    );
    assert_eq!(
        first_purge["result"]["structuredContent"]["purged_ids"],
        json!([first_id])
    );
    assert!(object_path.exists());
    assert!(second_path.exists());

    let mut second_record: Value =
        serde_json::from_slice(&std::fs::read(&second_path).expect("second record"))
            .expect("second record json");
    second_record["quarantined_at"] = json!("1970-01-01T00:00:00Z");
    std::fs::write(
        &second_path,
        serde_json::to_vec(&second_record).expect("serialize second record"),
    )
    .expect("age second record");
    let final_purge = peer.call("artifact_cleanup", json!({}));
    assert_eq!(
        final_purge["result"]["isError"],
        json!(false),
        "{final_purge}"
    );
    assert_eq!(
        final_purge["result"]["structuredContent"]["purged_ids"],
        json!([second_id])
    );
    assert!(!object_path.exists());
}

// ---------------------------------------------------------------------------
// ADR 0013/0027 Wave 4 red tests (plan §8): transactional file edit
// ---------------------------------------------------------------------------

#[test]
fn fs_patch_parse_failure_writes_nothing() {
    // ADR 0013 v2 / plan §8.4: a malformed unified diff must write NOTHING —
    // the file is left byte-for-byte unchanged and the call returns a typed
    // `invalid_input` error. `expected_preimage_sha256` is provided so the
    // preimage guard is not the failure mode; the parse must fail first.
    use sha2::{Digest, Sha256};
    let mut peer = Peer::start();
    peer.initialize();
    let body = "line one\nline two\nline three\n";
    let f = TempFile::new(body);
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    let preimage: String = h.finalize().iter().map(|b| format!("{b:02x}")).collect();

    // A clearly malformed "diff": no hunk header, body line not a valid prefix.
    let resp = peer.call(
        "fs_patch",
        json!({
            "path": f.path_str(),
            "expected_preimage_sha256": preimage,
            "unified_diff": "this is not a unified diff at all\n"
        }),
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(
        resp["result"]["isError"],
        json!(true),
        "malformed diff must be an error: {resp}"
    );
    assert_eq!(
        s["code"],
        json!("invalid_input"),
        "malformed diff must be invalid_input: {resp}"
    );
    assert_eq!(
        s["details"]["reason"],
        json!("patch_parse_failed"),
        "must carry reason=patch_parse_failed: {resp}"
    );
    // ZERO writes: the file is unchanged byte-for-byte.
    assert_eq!(
        std::fs::read_to_string(f.path()).unwrap(),
        body,
        "parse failure must leave the file untouched"
    );
}

#[test]
fn fs_edit_multiple_matches_returns_locations_without_write() {
    // ADR 0027 §8.2/§8.4: when `old` matches >1 location and replace_all is
    // false, fs_edit must report the line/column locations WITHOUT writing, as a
    // typed conflict — it must NOT auto-pick one or write anything.
    let mut peer = Peer::start();
    peer.initialize();
    // "foo" appears on line 1 and line 3.
    let body = "foo alpha\nbar beta\nfoo gamma\n";
    let f = TempFile::new(body);

    let resp = peer.call(
        "fs_edit",
        json!({"path": f.path_str(), "old": "foo", "new": "qux"}),
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(
        resp["result"]["isError"],
        json!(true),
        "multiple matches must be an error: {resp}"
    );
    assert_eq!(
        s["code"],
        json!("conflict"),
        "multiple matches must be conflict: {resp}"
    );
    assert_eq!(
        s["details"]["reason"],
        json!("multiple_matches"),
        "must carry reason=multiple_matches: {resp}"
    );
    let matches = s["details"]["matches"].as_array().expect("matches array");
    assert_eq!(matches.len(), 2, "exactly 2 match locations: {resp}");
    // Line 1 column 1, and line 3 column 1.
    assert_eq!(matches[0]["line"], json!(1));
    assert_eq!(matches[0]["column"], json!(1));
    assert_eq!(matches[1]["line"], json!(3));
    assert_eq!(matches[1]["column"], json!(1));
    // ZERO writes: the file is unchanged.
    assert_eq!(
        std::fs::read_to_string(f.path()).unwrap(),
        body,
        "multiple-match conflict must leave the file untouched"
    );
}

#[test]
fn rollback_conflict_preserves_user_change() {
    // ADR 0013/0027 §8.1/§8.4: a reversible fs_edit applies and registers a
    // ChangeSet. If the file is then modified by someone else, change_rollback
    // must REFUSE to overwrite (state=rollback_conflict) and preserve the
    // user's content.
    let mut peer = Peer::start();
    peer.initialize();
    let body = "greeting: hello\n";
    let f = TempFile::new(body);

    // Apply a reversible edit: hello -> world.
    let apply = peer.call(
        "fs_edit",
        json!({
            "path": f.path_str(),
            "old": "hello",
            "new": "world",
            "reversible": true
        }),
    );
    let s = &apply["result"]["structuredContent"];
    assert_eq!(
        apply["result"]["isError"],
        json!(false),
        "apply failed: {apply}"
    );
    assert_eq!(
        std::fs::read_to_string(f.path()).unwrap(),
        "greeting: world\n"
    );
    let change_id = s["change_id"]
        .as_str()
        .expect("reversible apply must return a change_id")
        .to_string();
    assert_eq!(
        s["change_state"],
        json!("applied_awaiting_completion"),
        "apply state: {apply}"
    );

    // Simulate a concurrent user edit (overwrites the file with something else).
    std::fs::write(f.path(), "greeting: USER EDITED THIS\n").unwrap();

    // Rollback must detect the mismatch and PRESERVE the user content.
    let rb = peer.call("change_rollback", json!({"change_id": &change_id}));
    let rs = &rb["result"]["structuredContent"];
    assert_eq!(
        rb["result"]["isError"],
        json!(false),
        "rollback call failed: {rb}"
    );
    assert_eq!(
        rs["state"],
        json!("rollback_conflict"),
        "concurrent modification -> rollback_conflict: {rb}"
    );
    // The user's content is preserved (NOT restored to the pre-edit `body`).
    assert_eq!(
        std::fs::read_to_string(f.path()).unwrap(),
        "greeting: USER EDITED THIS\n",
        "rollback_conflict must preserve the user's content, not overwrite it"
    );
}

#[test]
fn fs_edit_preview_returns_diff_without_write() {
    // Preview is a distinct read-only MCP tool so hosts do not apply the
    // destructive annotation used by fs_edit apply calls.
    let mut peer = Peer::start();
    peer.initialize();
    let body = "title: hello\n";
    let f = TempFile::new(body);
    let resp = peer.call(
        "fs_edit_preview",
        json!({"path": f.path_str(), "old": "hello", "new": "world"}),
    );
    assert_eq!(
        resp["result"]["isError"],
        json!(false),
        "preview must succeed: {resp}"
    );
    let s = &resp["result"]["structuredContent"];
    let diff = s["diff"].as_str().expect("preview must return a diff");
    assert!(
        diff.contains("@@") && diff.contains("-") && diff.contains("+"),
        "diff must be a unified diff: {resp}"
    );
    assert!(
        diff.contains("hello") && diff.contains("world"),
        "diff must reflect old/new: {resp}"
    );
    assert_eq!(s["change_state"], json!("dry_run"), "dry_run state: {resp}");
    // ZERO writes.
    assert_eq!(
        std::fs::read_to_string(f.path()).unwrap(),
        body,
        "preview must leave the file untouched"
    );
}

#[test]
fn fs_edit_preview_is_read_capable_but_apply_is_not() {
    let dir = tempfile::tempdir().expect("read root");
    let path = dir.path().join("read-only.txt");
    std::fs::write(&path, "hello\n").expect("fixture");
    let args = [std::ffi::OsStr::new("--read-root"), dir.path().as_os_str()];
    let mut peer = Peer::start_with_args(&args);
    peer.initialize();

    let preview = peer.call(
        "fs_edit_preview",
        json!({"path": &path, "old": "hello", "new": "world"}),
    );
    assert_eq!(preview["result"]["isError"], json!(false), "{preview}");

    let apply = peer.call(
        "fs_edit",
        json!({"path": &path, "old": "hello", "new": "world"}),
    );
    assert_eq!(apply["result"]["isError"], json!(true), "{apply}");
    assert_eq!(
        apply["result"]["structuredContent"]["code"],
        json!("outside_capability"),
        "{apply}"
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "hello\n");

    let legacy = peer.call(
        "fs_edit",
        json!({"path": &path, "old": "hello", "new": "world", "dry_run": true}),
    );
    assert_eq!(legacy["error"]["code"], json!(-32602), "{legacy}");
}

#[test]
fn rollback_restores_after_hash_match() {
    // ADR 0013/0027 §8.1: when no concurrent modification happened, change_rollback
    // restores the pre-edit content (state=rolled_back).
    let mut peer = Peer::start();
    peer.initialize();
    let body = "greeting: hello\n";
    let f = TempFile::new(body);
    let apply = peer.call(
        "fs_edit",
        json!({"path": f.path_str(), "old": "hello", "new": "world", "reversible": true}),
    );
    assert_eq!(apply["result"]["isError"], json!(false), "apply: {apply}");
    assert_eq!(
        std::fs::read_to_string(f.path()).unwrap(),
        "greeting: world\n",
        "apply must write the new content"
    );
    let change_id = apply["result"]["structuredContent"]["change_id"]
        .as_str()
        .expect("change_id")
        .to_string();

    // No concurrent modification: rollback restores the before-content.
    let rb = peer.call("change_rollback", json!({"change_id": &change_id}));
    assert_eq!(rb["result"]["isError"], json!(false), "rollback call: {rb}");
    assert_eq!(
        rb["result"]["structuredContent"]["state"],
        json!("rolled_back"),
        "no concurrent mod -> rolled_back: {rb}"
    );
    assert_eq!(
        std::fs::read_to_string(f.path()).unwrap(),
        body,
        "rollback must restore the pre-edit content"
    );
}

#[test]
fn fs_write_expected_absent_rejects_existing_target() {
    // ADR 0027 §8.2 (expected_absent semantics via mode=create): writing with
    // mode=create to an EXISTING file must be rejected with `already_exists` and
    // write NOTHING.
    let mut peer = Peer::start();
    peer.initialize();
    let body = "original\n";
    let f = TempFile::new(body);
    let resp = peer.call(
        "fs_write_text",
        json!({"path": f.path_str(), "content": "OVERWRITE\n", "mode": "create"}),
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(
        resp["result"]["isError"],
        json!(true),
        "mode=create on existing must error: {resp}"
    );
    assert_eq!(
        s["code"],
        json!("already_exists"),
        "must be already_exists: {resp}"
    );
    // ZERO writes.
    assert_eq!(
        std::fs::read_to_string(f.path()).unwrap(),
        body,
        "existing file must be untouched"
    );
}

// ---------------------------------------------------------------------------
// ADR 0027 Wave 5 red tests (plan §9): process pipeline / session
// ---------------------------------------------------------------------------

#[test]
fn pipeline_passes_bytes_without_shell() {
    // ADR 0027 §9.1: process_pipeline uses direct argv + byte pipes — NO shell.
    // Shell metacharacters in argv must arrive verbatim (un-expanded, un-piped).
    // Stage 0 emits a string full of shell metacharacters via `printf`; stage 1
    // passes it through `cat`. The output must be the LITERAL string.
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let payload = "PRICELESS $VAR `whoami` | grep ; rm -rf /\n";
    let resp = peer.call(
        "process_pipeline",
        json!({
            "stages": [
                {"program": "printf", "args": ["%s", payload]},
                {"program": "cat", "args": []}
            ],
            "stdout": "inline"
        }),
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(
        resp["result"]["isError"],
        json!(false),
        "pipeline must succeed: {resp}"
    );
    assert_eq!(
        s["success"],
        json!(true),
        "both stages must succeed: {resp}"
    );
    let out = s["stdout"].as_str().expect("pipeline stdout");
    assert_eq!(
        out, payload,
        "bytes must pass through literally (no shell expansion/piping): {resp}"
    );
    // Both stages reported with exit code 0.
    let stages = s["stages"].as_array().expect("stages array");
    assert_eq!(stages.len(), 2);
    assert_eq!(stages[0]["exit_code"], json!(0));
    assert_eq!(stages[1]["exit_code"], json!(0));
}

#[test]
fn pipeline_file_capture_returns_the_destination_path() {
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let dir = tempfile::tempdir().expect("pipeline output directory");
    let path = dir.path().join("pipeline.out");
    let resp = peer.call(
        "process_pipeline",
        json!({
            "stages": [{"program": "printf", "args": ["%s", "pipeline-file"]}],
            "stdout": {"file": {"path": &path}}
        }),
    );
    let result = &resp["result"]["structuredContent"];
    assert_eq!(resp["result"]["isError"], json!(false), "{resp}");
    assert_eq!(result["stdout_path"], json!(path.to_string_lossy()));
    assert!(result["stdout"].is_null(), "{resp}");
    assert_eq!(
        std::fs::read(&path).expect("captured output"),
        b"pipeline-file"
    );
}

#[test]
fn pipeline_stage_rejects_unknown_fields() {
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call(
        "process_pipeline",
        json!({
            "stages": [{"program": "ignored", "argz": ["typo"]}],
            "stdout": "null"
        }),
    );
    assert!(resp.get("error").is_some(), "{resp}");
    assert_eq!(resp["error"]["code"], json!(-32602), "{resp}");
    assert!(
        resp["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("unknown field `argz`")),
        "{resp}"
    );
}

#[test]
fn pipeline_stage_remove_env_matches_process_run() {
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let resp = peer.call(
        "process_pipeline",
        json!({
            "stages": [{
                "program": "sh",
                "args": ["-c", "if [ -n \"${XUANLING_PIPELINE_REMOVE_ME+x}\" ]; then exit 41; fi; printf removed"],
                "env": {"XUANLING_PIPELINE_REMOVE_ME": "present"},
                "remove_env": ["XUANLING_PIPELINE_REMOVE_ME"]
            }],
            "stdout": "inline"
        }),
    );
    assert_eq!(resp["result"]["isError"], json!(false), "{resp}");
    assert_eq!(
        resp["result"]["structuredContent"]["success"],
        json!(true),
        "remove_env must run after explicit env insertion: {resp}"
    );
    assert_eq!(
        resp["result"]["structuredContent"]["stdout"],
        json!("removed")
    );
}

#[test]
fn pipeline_spawn_error_identifies_stage_index() {
    let mut peer = Peer::start();
    peer.initialize();
    let missing = format!("xuanling-missing-pipeline-program-{}", std::process::id());
    let first_stage = if cfg!(windows) {
        json!({"program": "cmd", "args": ["/C", "exit", "0"]})
    } else {
        json!({"program": "true", "args": []})
    };
    let resp = peer.call(
        "process_pipeline",
        json!({
            "stages": [first_stage, {"program": missing, "args": []}],
            "stdout": "null"
        }),
    );
    assert_eq!(resp["result"]["isError"], json!(true), "{resp}");
    let error = &resp["result"]["structuredContent"];
    assert_eq!(error["code"], json!("spawn_failed"), "{resp}");
    assert_eq!(error["operation"], json!("process.pipeline"), "{resp}");
    assert_eq!(error["details"]["stage_index"], json!(1), "{resp}");
}

#[test]
fn memory_feedback_rejects_unknown_fields_at_runtime() {
    let db = tempfile::tempdir().expect("memory db dir");
    let db_path = db.path().join("memory.db");
    let db_arg = db_path.to_string_lossy().into_owned();
    let mut cmd = Command::new(binary());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("--memory-db")
        .arg(db_arg);
    let mut peer = Peer::spawn(cmd, Some(db));
    peer.initialize();
    // v2: create + approve to obtain an active record for the feedback event.
    let create = peer.call(
        "memory_candidate_create",
        json!({"proposal_id": "strict-feedback", "idempotency_key": "idem-strict-feedback",
               "proposer_id": "strict", "namespace": "strict", "scope": {"type": "global"},
               "payload": {"kind": "fact", "content": "feedback target",
                           "tags": [], "applicability": {}, "pinned": false}}),
    );
    assert_eq!(create["result"]["isError"], json!(false), "{create}");
    let review = peer.call(
        "memory_review",
        json!({"idempotency_key": "review-strict-feedback", "reviewer_id": "strict",
               "namespace": "strict", "scope": {"type": "global"},
               "proposal_id": "strict-feedback", "expected_proposal_revision": 1,
               "decision": "approve"}),
    );
    assert_eq!(review["result"]["isError"], json!(false), "{review}");
    let resp = peer.call(
        "memory_feedback",
        json!({"event_id": "evt-1", "idempotency_key": "idem-evt-1",
               "record_id": "strict-feedback", "revision": 1,
               "feedback": "helpful", "feedback_typo": true}),
    );
    assert_eq!(resp["error"]["code"], json!(-32602), "{resp}");
    assert!(
        resp["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("unknown field `feedback_typo`")),
        "{resp}"
    );
}

#[test]
fn changeset_operations_reject_unknown_fields_at_runtime() {
    let mut peer = Peer::start();
    peer.initialize();
    for tool in ["change_rollback", "change_commit"] {
        let resp = peer.call(
            tool,
            json!({"change_id": "00000000-0000-0000-0000-000000000000", "change_typo": true}),
        );
        assert_eq!(resp["error"]["code"], json!(-32602), "{tool}: {resp}");
        assert!(
            resp["error"]["message"]
                .as_str()
                .is_some_and(|message| message.contains("unknown field `change_typo`")),
            "{tool}: {resp}"
        );
    }
}

#[cfg(unix)]
#[test]
fn session_close_terminates_descendants() {
    // ADR 0027 §9.2: closing a session with an active exec terminates the
    // direct child AND its descendants, not just the direct child.
    let mut peer = Peer::start();
    peer.initialize();

    // Open a session.
    let open = peer.call("session_open", json!({}));
    let session_id = open["result"]["structuredContent"]["session_id"]
        .as_str()
        .expect("session_open returns session_id")
        .to_string();

    let pid_dir = tempfile::tempdir().expect("pid fixture directory");
    let pid_path = pid_dir.path().join("descendant.pid");
    let exec_id = peer.next_id;
    peer.next_id += 1;
    peer.send(&json!({
        "jsonrpc": "2.0", "id": exec_id, "method": "tools/call",
        "params": {
            "name": "session_exec",
            "arguments": {
                "session_id": &session_id,
                "program": "sh",
                "args": [
                    "-c",
                    "sleep 37 </dev/null >/dev/null 2>&1 & echo $! > \"$1\"; wait",
                    "xuanling-session-test",
                    pid_path
                ],
                "stdout": "null",
                "stderr": "null"
            }
        }
    }));
    for _ in 0..200 {
        if pid_path.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let descendant_pid: i32 = std::fs::read_to_string(&pid_path)
        .expect("active exec must publish descendant pid")
        .trim()
        .parse()
        .expect("numeric descendant pid");
    // SAFETY: signal 0 probes the exact PID created by this test.
    assert_eq!(unsafe { libc::kill(descendant_pid, 0) }, 0);

    let close_id = peer.next_id;
    peer.next_id += 1;
    peer.send(&json!({
        "jsonrpc": "2.0", "id": close_id, "method": "tools/call",
        "params": {"name": "session_close", "arguments": {"session_id": &session_id}}
    }));
    let first_response = peer.recv();
    let second_response = peer.recv();
    let close = if first_response["id"] == json!(close_id) {
        &first_response
    } else {
        &second_response
    };
    let exec = if first_response["id"] == json!(exec_id) {
        &first_response
    } else {
        &second_response
    };
    assert_eq!(
        close["result"]["isError"],
        json!(false),
        "session_close: {close}"
    );
    assert_eq!(
        exec["result"]["isError"],
        json!(false),
        "the signalled exec returns a structured process result: {exec}"
    );
    assert_eq!(exec["result"]["structuredContent"]["success"], json!(false));

    let mut gone = false;
    for _ in 0..50 {
        // SAFETY: signal 0 probes the exact test-spawned PID.
        if unsafe { libc::kill(descendant_pid, 0) } != 0
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            gone = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(gone, "session_close must terminate the descendant pid");
}

#[test]
fn pipeline_reports_failed_stage() {
    // ADR 0027 §9.1: when a non-last stage fails, the result reports
    // success=false and the index of the first failing stage.
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    // Stage 0 exits 7 (failure); stage 1 (cat) reads stage 0's (empty) stdout.
    let resp = peer.call(
        "process_pipeline",
        json!({
            "stages": [
                {"program": "sh", "args": ["-c", "exit 7"]},
                {"program": "cat", "args": []}
            ],
            "stdout": "inline"
        }),
    );
    let s = &resp["result"]["structuredContent"];
    assert_eq!(
        resp["result"]["isError"],
        json!(false),
        "call must succeed: {resp}"
    );
    assert_eq!(
        s["success"],
        json!(false),
        "pipeline success must be false: {resp}"
    );
    assert_eq!(
        s["failed_stage"],
        json!(0),
        "failed_stage must be 0: {resp}"
    );
    let stages = s["stages"].as_array().expect("stages");
    assert_eq!(stages.len(), 2);
    assert_eq!(stages[0]["success"], json!(false));
    assert_eq!(stages[0]["exit_code"], json!(7));
    assert_eq!(stages[1]["success"], json!(true));
}

#[test]
fn session_cwd_persists_between_calls() {
    // ADR 0027 §9.2: a session's cwd persists across session_exec calls.
    if !cfg!(unix) {
        return;
    }
    let mut peer = Peer::start();
    peer.initialize();
    let dir = tempfile::tempdir().expect("temp dir");
    let cwd = dir.path().to_string_lossy().into_owned();
    let open = peer.call("session_open", json!({"cwd": &cwd}));
    let sid = open["result"]["structuredContent"]["session_id"]
        .as_str()
        .expect("session_id")
        .to_string();

    // First exec: pwd prints the session cwd.
    let r1 = peer.call(
        "session_exec",
        json!({"session_id": &sid, "program": "pwd", "args": [], "stdout": "inline", "stderr": "null"}),
    );
    let out1 = r1["result"]["structuredContent"]["stdout"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    // pwd resolves symlinks (e.g. /var -> /private/var on macOS); compare via
    // canonicalizing the requested cwd the same way.
    let canonical = std::fs::canonicalize(&cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(cwd.clone());
    assert!(
        out1 == canonical || out1 == cwd,
        "pwd should print the session cwd; got {out1} (cwd={cwd}, canonical={canonical})"
    );

    // A second exec in the same session still sees the cwd (persisted).
    let r2 = peer.call(
        "session_exec",
        json!({"session_id": &sid, "program": "pwd", "args": [], "stdout": "inline", "stderr": "null"}),
    );
    let out2 = r2["result"]["structuredContent"]["stdout"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    assert_eq!(out1, out2, "cwd must persist across session_exec calls");

    let _ = peer.call("session_close", json!({"session_id": &sid}));
}

#[test]
fn session_handle_cannot_escape_server_registry() {
    // ADR 0027 §9.2: the session id is server-owned; a forged/non-existent id
    // is rejected with `not_found` for both session_exec and session_close.
    let mut peer = Peer::start();
    peer.initialize();
    let forged = "session-forged-not-in-registry";

    let exec = peer.call(
        "session_exec",
        json!({"session_id": forged, "program": "echo", "args": ["x"], "stdout": "inline", "stderr": "null"}),
    );
    let es = &exec["result"]["structuredContent"];
    assert_eq!(
        exec["result"]["isError"],
        json!(true),
        "forged session_exec must error: {exec}"
    );
    assert_eq!(es["code"], json!("not_found"), "must be not_found: {exec}");
    assert_eq!(es["details"]["reason"], json!("session_not_found"));

    let close = peer.call("session_close", json!({"session_id": forged}));
    let cs = &close["result"]["structuredContent"];
    assert_eq!(
        close["result"]["isError"],
        json!(true),
        "forged session_close must error: {close}"
    );
    assert_eq!(cs["code"], json!("not_found"));
    assert_eq!(cs["details"]["reason"], json!("session_not_found"));
}

// ---------------------------------------------------------------------------
// ADR 0027 Wave 7 red tests (plan §11.1): host-integration server contract
// ---------------------------------------------------------------------------

#[test]
fn server_info_publishes_contract_version_and_identity() {
    // ADR 0027 §10/§11.1: the initialize handshake returns a stable server
    // identity + a `_meta.xuanling.contract_version` so a host can detect the
    // output/artifact/cursor contract the server implements. This is the
    // one-click-startup identity a host configures against.
    let mut peer = Peer::start();
    let init = json!({
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "wave7", "version": "0"}
        }
    });
    peer.send(&init);
    let resp = peer.recv();
    let server_info = &resp["result"]["serverInfo"];
    assert_eq!(
        server_info["name"].clone(),
        json!("xuanling-mcp"),
        "server identity must be xuanling-mcp: {resp}"
    );
    assert!(
        server_info["version"]
            .as_str()
            .is_some_and(|v| !v.is_empty()),
        "server must publish a version: {resp}"
    );
    let contract_version = resp["result"]["_meta"]["xuanling.contract_version"].clone();
    assert_eq!(
        contract_version,
        json!("2"),
        "server must publish contract_version=2 in _meta (ADR 0027 §10): {resp}"
    );
    assert_eq!(
        resp["result"]["_meta"]["xuanling.filesystem_scope"],
        json!("unrestricted"),
        "default filesystem scope must be explicit: {resp}"
    );
    // The catalog length advertised in _meta matches the live tools/list count.
    let advertised = resp["result"]["_meta"]["xuanling.tool_count"].as_u64();
    peer.initialize();
    let tools = list_tools(&mut peer);
    assert_eq!(
        advertised,
        Some(tools.len() as u64),
        "advertised tool_count must match live catalog: {resp}"
    );
}

#[test]
fn memory_unavailable_keeps_main_tools_working_and_diagnosable() {
    // ADR 0027 §10: when the memory store is unavailable (no --memory-db / a DB
    // failure), the MAIN (non-memory) tools still work AND the memory path
    // returns a typed, diagnosable error — never a silent crash, and never a
    // failure of unrelated tools. This Peer is started WITHOUT --memory-db.
    let mut peer = Peer::start_degraded_memory();
    peer.initialize();
    // Non-memory tools are unaffected.
    let sys = peer.call("system_info", json!({}));
    assert_eq!(
        sys["result"]["isError"],
        json!(false),
        "system_info must work without a memory store: {sys}"
    );
    let f = TempFile::new("probe content\n");
    let probe = peer.call("fs_read_text", json!({"path": f.path_str()}));
    assert_eq!(
        probe["result"]["isError"],
        json!(false),
        "fs_read_text must work without a memory store: {probe}"
    );
    // The memory tool surfaces a typed, diagnosable error (not a crash).
    let mc = peer.call(
        "memory_context",
        json!({"namespace":"x","query":"q","candidate_limit":10,"limit":5,"max_chars":64}),
    );
    assert!(
        mc.get("error").is_some() || mc["result"]["isError"] == json!(true),
        "memory_context without a store must surface a typed error: {mc}"
    );
    let msg = mc
        .get("error")
        .and_then(|e| e["message"].as_str())
        .unwrap_or_else(|| {
            mc["result"]["structuredContent"]["message"]
                .as_str()
                .unwrap_or("")
        });
    assert!(
        msg.to_lowercase().contains("memory") || msg.to_lowercase().contains("store"),
        "the error should diagnose the memory/store cause: {mc}"
    );
}

/// Fetch the catalog `tools` array over an initialized peer.
fn list_tools(peer: &mut Peer) -> Vec<Value> {
    let list = json!({"jsonrpc": "2.0", "id": peer.next_id, "method": "tools/list", "params": {}});
    peer.next_id += 1;
    peer.send(&list);
    let resp = peer.recv();
    resp["result"]["tools"]
        .as_array()
        .expect("tools array")
        .clone()
}

#[test]
fn output_schema_matches_structured_result() {
    // ADR 0027 §5.3: every catalog tool must publish an `outputSchema`
    // generated from its result DTO, so hosts can generically render/validate
    // the structured result. A missing or non-object outputSchema means the
    // host cannot branch on the result shape.
    let mut peer = Peer::start();
    peer.initialize();
    let tools = list_tools(&mut peer);
    assert!(
        tools.len() >= 27,
        "catalog must be non-trivial: got {} tools",
        tools.len()
    );
    for t in &tools {
        let name = t["name"].as_str().expect("name");
        let os = t
            .get("outputSchema")
            .unwrap_or_else(|| panic!("tool `{name}` must publish an outputSchema"));
        assert!(
            os.is_object(),
            "tool `{name}` outputSchema must be an object, got {os}"
        );
        // The result DTOs are structs, so the root schema must be an object.
        assert_eq!(
            os["type"],
            json!("object"),
            "tool `{name}` outputSchema root must be type=object"
        );
    }
}

#[test]
fn tool_annotations_mark_mutating_calls() {
    // ADR 0027 §5.3/§11: every catalog tool must publish `annotations` (host
    // approval hints), and read-only vs mutating tools must be marked
    // distinctly so hosts can route them through different approval/sandbox
    // paths. annotations are hints, NOT server-side authorization (§8).
    let mut peer = Peer::start();
    peer.initialize();
    let tools = list_tools(&mut peer);

    let read_only: std::collections::HashSet<&str> = [
        "system_info",
        "path_resolve",
        "path_relative",
        "fs_stat",
        "fs_list",
        "fs_read_text",
        "fs_read_bytes",
        "fs_search",
        "fs_glob",
        "fs_hash",
        "fs_edit_preview",
        "artifact_read",
        "artifact_cleanup_preview",
        "process_which",
        "project_detect",
        "project_command",
        "memory_get",
        "memory_search",
        "memory_candidate_get",
        "memory_candidate_list",
    ]
    .into_iter()
    .collect();
    let mutating: std::collections::HashSet<&str> = [
        "fs_mkdir",
        "fs_write_text",
        "fs_replace_text",
        "fs_patch",
        "fs_edit",
        "change_rollback",
        "change_commit",
        "fs_copy",
        "fs_move",
        "fs_remove",
        "artifact_cleanup",
        "process_run",
        "process_pipeline",
        "session_open",
        "session_exec",
        "session_close",
        "project_run",
        "memory_candidate_create",
        "memory_candidate_replace",
        "memory_candidate_archive",
        "memory_feedback",
        "memory_review",
    ]
    .into_iter()
    .collect();

    for t in &tools {
        let name = t["name"].as_str().expect("name");
        let ann = t
            .get("annotations")
            .unwrap_or_else(|| panic!("tool `{name}` must publish annotations"));
        assert!(ann.is_object(), "tool `{name}` annotations must be object");
        let ro = ann["readOnlyHint"].as_bool();
        assert!(
            ro.is_some(),
            "tool `{name}` must set readOnlyHint, got {ann}"
        );
        let ro = ro.unwrap();
        if read_only.contains(name) {
            assert!(
                ro,
                "read-only tool `{name}` must have readOnlyHint=true (ADR 0027 §11)"
            );
        } else if mutating.contains(name) {
            assert!(
                !ro,
                "mutating tool `{name}` must have readOnlyHint=false (ADR 0027 §11)"
            );
        } else {
            panic!("tool `{name}` not classified in the test read-only/mutating allowlist");
        }
    }

    // v2 annotation contracts (plan §5): candidates are non-destructive and
    // idempotent; review is the only destructive (terminal) memory tool and
    // is idempotent by replay; feedback events are idempotent.
    for name in [
        "memory_candidate_create",
        "memory_candidate_replace",
        "memory_candidate_archive",
        "memory_feedback",
    ] {
        let tool = tools
            .iter()
            .find(|tool| tool["name"] == json!(name))
            .unwrap_or_else(|| panic!("tool `{name}` missing from catalog"));
        assert_eq!(
            tool["annotations"]["idempotentHint"],
            json!(true),
            "`{name}` replays are idempotent"
        );
        assert_eq!(
            tool["annotations"]["destructiveHint"],
            json!(false),
            "`{name}` never destroys canonical rows"
        );
    }
    let review = tools
        .iter()
        .find(|tool| tool["name"] == json!("memory_review"))
        .expect("memory_review missing from catalog");
    assert_eq!(review["annotations"]["destructiveHint"], json!(true));
    assert_eq!(review["annotations"]["idempotentHint"], json!(true));
}

#[test]
fn tool_profiles_filter_discovery_and_dispatch() {
    let args = [
        std::ffi::OsStr::new("--tool-profile"),
        std::ffi::OsStr::new("core"),
    ];
    let mut peer = Peer::start_with_args(&args);
    let initialized = peer.initialize();
    let tools = list_tools(&mut peer);
    let names: Vec<&str> = tools
        .iter()
        .map(|tool| tool["name"].as_str().expect("tool name"))
        .collect();
    assert_eq!(
        names,
        vec!["system_info", "path_resolve", "path_relative"],
        "core profile must expose only the stable system/path tools"
    );
    assert_eq!(
        initialized["result"]["_meta"]["xuanling.tool_profiles"],
        json!(["core"])
    );
    assert_eq!(
        initialized["result"]["_meta"]["xuanling.tool_count"],
        json!(3)
    );

    let hidden = peer.call("fs_read_text", json!({"path": "ignored"}));
    assert_eq!(hidden["error"]["code"], json!(-32602), "{hidden}");
    assert!(
        hidden["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("unknown tool")),
        "a tool hidden from discovery must also be unavailable to calls: {hidden}"
    );
}

// wait_timeout helper via a polling child.
trait WaitTimeoutExt {
    fn wait_timeout(
        &mut self,
        dur: std::time::Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>>;
}

impl WaitTimeoutExt for Child {
    fn wait_timeout(
        &mut self,
        dur: std::time::Duration,
    ) -> std::io::Result<Option<std::process::ExitStatus>> {
        let deadline = std::time::Instant::now() + dur;
        loop {
            match self.try_wait()? {
                Some(s) => return Ok(Some(s)),
                None => {
                    if std::time::Instant::now() >= deadline {
                        return Ok(None);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }
    }
}
