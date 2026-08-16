//! Golden request/response fixtures per tool (plan §10 W6).
//!
//! Each entry is a representative `tools/call` request + the invariant the
//! response must satisfy. This serves as the per-tool golden fixture corpus:
//! the same inputs feed the W7 cross-platform matrix and the A1-A8 agent
//! scenarios. Fixtures are run live against the binary (no hardcoded response
//! bytes that drift with the runtime), asserting structural invariants rather
//! than exact values that vary by platform (timestamps, paths).

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

fn binary() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
}

struct Peer {
    child: std::process::Child,
    stdout: BufReader<std::process::ChildStdout>,
    stdin: std::process::ChildStdin,
    next_id: i64,
    // Hold the temp DB dir for the life of the Peer so tests never touch the
    // real `~/.xuanling/toolkit-memory.db` (review P1). Previously
    // `golden_memory_lifecycle` wrote+deleted records in the user's real DB.
    _db_dir: tempfile::TempDir,
}

/// C-15 guard helper: refuse argv without an explicit non-default --memory-db.
fn default_memory_db_path() -> std::path::PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match home {
        Some(home) => std::path::Path::new(&home).join(".xuanling/toolkit-memory.db"),
        None => std::path::PathBuf::from("toolkit-memory.db"),
    }
}

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
    assert_ne!(
        value.as_str(),
        default_memory_db_path().to_string_lossy().as_ref(),
        "C-15 violation: --memory-db points at the real default memory DB"
    );
}

impl Peer {
    fn start() -> Self {
        let db_dir = tempfile::tempdir().expect("temp db dir");
        let db = db_dir.path().join("golden.db");
        let mut cmd = Command::new(binary());
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .arg("--memory-db")
            .arg(&db);
        enforce_isolated_memory_db(&cmd);
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
                "clientInfo": {"name": "golden", "version": "0"}
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

/// Assert the response is a successful structured result (isError absent or
/// false) and return its structuredContent.
fn ok_structured(resp: &Value) -> &Value {
    assert!(
        resp.get("result").is_some(),
        "expected a result, got error: {resp}"
    );
    assert!(
        !resp["result"]["isError"].as_bool().unwrap_or(false),
        "expected isError=false: {resp}"
    );
    &resp["result"]["structuredContent"]
}

/// A file that exists on the current OS (for read/stat/hash golden fixtures).
fn known_file() -> &'static str {
    if cfg!(target_os = "windows") {
        "C:\\Windows\\System32\\drivers\\etc\\hosts"
    } else {
        "/etc/hosts"
    }
}

fn create_directory_symlink(target: &std::path::Path, link: &std::path::Path) -> bool {
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
                eprintln!("skipping symlink golden fixture: {error}");
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

/// A directory that exists on the current OS (for list/search/glob fixtures).
fn known_dir() -> &'static str {
    if cfg!(target_os = "windows") {
        "C:\\Windows\\System32\\drivers\\etc"
    } else {
        "/etc"
    }
}

#[test]
fn golden_system_info() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call("system_info", json!({}));
    let s = ok_structured(&r);
    assert!(s["os"].is_string());
    assert!(s["arch"].is_string());
}

#[test]
fn golden_path_resolve() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call(
        "path_resolve",
        json!({"path": known_file(), "canonicalize": false}),
    );
    let s = ok_structured(&r);
    assert_eq!(s["path"], json!(known_file()));
}

#[test]
fn golden_path_relative() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call("path_relative", json!({"path": "a/b.txt", "base_dir": "."}));
    let s = ok_structured(&r);
    assert!(s["relative_path"].is_string());
}

#[test]
fn golden_fs_stat() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call("fs_stat", json!({"path": known_file()}));
    let s = ok_structured(&r);
    assert!(s["kind"].is_string());
}

#[test]
fn golden_fs_list() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call(
        "fs_list",
        json!({"path": known_dir(), "recursive": false, "limit": 5}),
    );
    let s = ok_structured(&r);
    assert!(s["entries"].is_array());
}

#[test]
fn golden_fs_read_text() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call("fs_read_text", json!({"path": known_file()}));
    let s = ok_structured(&r);
    assert!(s["content"].is_string());
}

#[test]
fn golden_fs_read_bytes() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call("fs_read_bytes", json!({"path": known_file(), "length": 16}));
    let s = ok_structured(&r);
    assert!(s["base64"].is_string());
    assert!(s["length"].is_number());
}

#[test]
fn golden_fs_hash() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call("fs_hash", json!({"path": known_file()}));
    let s = ok_structured(&r);
    assert!(s["digest"].is_string());
    assert_eq!(s["algorithm"], json!("sha256"));
}

#[test]
fn golden_fs_search() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call(
        "fs_search",
        json!({"path": known_dir(), "pattern": "127", "literal": true}),
    );
    let s = ok_structured(&r);
    assert!(s["matches"].is_array());
}

#[test]
fn golden_fs_glob() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call(
        "fs_glob",
        json!({"path": known_dir(), "patterns": ["host*"]}),
    );
    let s = ok_structured(&r);
    assert!(s["matches"].is_array());
}

#[test]
fn golden_process_which() {
    let mut p = Peer::start();
    p.initialize();
    let prog = if cfg!(unix) { "sh" } else { "cmd" };
    let r = p.call("process_which", json!({"program": prog}));
    let s = ok_structured(&r);
    assert!(s["candidates"].is_array());
}

#[test]
#[cfg(unix)]
fn golden_process_run() {
    let mut p = Peer::start();
    p.initialize();
    let r = p.call(
        "process_run",
        json!({"program": "echo", "args": ["golden"], "stdout": "inline", "stderr": "null"}),
    );
    let s = ok_structured(&r);
    assert!(s["success"].is_boolean());
}

#[test]
fn golden_project_detect() {
    let mut p = Peer::start();
    p.initialize();
    // Detect on the repo root (Cargo.toml present).
    let dir = env!("CARGO_MANIFEST_DIR");
    let r = p.call("project_detect", json!({"path": dir}));
    let s = ok_structured(&r);
    assert!(s["ecosystems"].is_array());
}

#[test]
fn golden_project_command() {
    let mut p = Peer::start();
    p.initialize();
    let dir = env!("CARGO_MANIFEST_DIR");
    let r = p.call(
        "project_command",
        json!({"project_path": dir, "action": "check"}),
    );
    let s = ok_structured(&r);
    assert!(s["program"].is_string());
    assert!(s["args"].is_array());
}

#[test]
fn golden_fs_mkdir_write_replace() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("sub/g.txt");
    let mut p = Peer::start();
    p.initialize();
    let mk = p.call(
        "fs_mkdir",
        json!({"path": dir.path().join("sub").to_string_lossy(), "recursive": true}),
    );
    assert_eq!(mk["result"]["structuredContent"]["created"], json!(true));
    let w = p.call(
        "fs_write_text",
        json!({"path": target.to_string_lossy(), "content": "hello world", "mode": "create", "create_parents": true}),
    );
    assert!(w.get("result").is_some(), "fs_write_text: {w}");
    let r = p.call(
        "fs_replace_text",
        json!({"path": target.to_string_lossy(), "old": "hello", "new": "goodbye", "replace_all": false}),
    );
    assert_eq!(
        r["result"]["structuredContent"]["replacements"],
        json!(1),
        "fs_replace_text: {r}"
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "goodbye world");
}

#[test]
fn golden_fs_copy_move_remove() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("orig.txt");
    std::fs::write(&src, "payload").unwrap();
    let copy = dir.path().join("copy.txt");
    let moved = dir.path().join("moved.txt");
    let mut p = Peer::start();
    p.initialize();
    let c = p.call(
        "fs_copy",
        json!({"from": src.to_string_lossy(), "to": copy.to_string_lossy(), "overwrite": false, "recursive": true}),
    );
    assert_eq!(c["result"]["structuredContent"]["copied_files"], json!(1));
    let m = p.call(
        "fs_move",
        json!({"from": copy.to_string_lossy(), "to": moved.to_string_lossy(), "overwrite": false}),
    );
    assert_eq!(m["result"]["structuredContent"]["moved"], json!(true));
    // Default recursive=false on a FILE remove must succeed (files aren't dirs).
    let rm = p.call("fs_remove", json!({"path": moved.to_string_lossy()}));
    assert_eq!(rm["result"]["structuredContent"]["removed"], json!(true));
    assert_eq!(rm["result"]["structuredContent"]["kind"], json!("file"));
    assert!(!moved.exists());

    // A directory symlink is an entry, not the target directory. This also
    // pins the public `symlink` result kind on every worker that can create the
    // platform fixture.
    let target_dir = dir.path().join("target-dir");
    std::fs::create_dir(&target_dir).unwrap();
    std::fs::write(target_dir.join("kept.txt"), "kept").unwrap();
    let link = dir.path().join("directory-link");
    if create_directory_symlink(&target_dir, &link) {
        let rm_link = p.call("fs_remove", json!({"path": link.to_string_lossy()}));
        assert_eq!(
            rm_link["result"]["structuredContent"]["kind"],
            json!("symlink")
        );
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(
            std::fs::read_to_string(target_dir.join("kept.txt")).unwrap(),
            "kept"
        );
    }
}

#[test]
fn golden_fs_remove_default_refuses_nonempty_dir() {
    // The default recursive=false must refuse a non-empty directory (review P0).
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("keep");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(nested.join("f.txt"), "x").unwrap();
    let mut p = Peer::start();
    p.initialize();
    let r = p.call("fs_remove", json!({"path": nested.to_string_lossy()}));
    assert_eq!(
        r["result"]["isError"],
        json!(true),
        "default remove on non-empty dir must be a tool error: {r}"
    );
    assert!(nested.exists(), "non-empty dir must survive");
}

#[test]
fn golden_project_run_dispatches() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("Cargo.toml"),
        "[package]\nname = \"g\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/main.rs"), "fn main() {}\n").unwrap();
    let mut p = Peer::start();
    p.initialize();
    let r = p.call(
        "project_run",
        json!({"project_path": dir.path().to_string_lossy(), "action": "check", "inherit_env": true, "stdout": "null", "stderr": "null"}),
    );
    // Must dispatch to a tool result (cargo may be absent -> SpawnFailed,
    // which is isError=true but still a result, not a protocol error).
    assert!(r.get("result").is_some(), "project_run: {r}");
}

#[test]
fn golden_memory_lifecycle() {
    // v2 round-trip: candidate_create -> review approve -> get -> search ->
    // archive. Only the review mutates canonical rows.
    let mut p = Peer::start();
    p.initialize();
    let create = p.call(
        "memory_candidate_create",
        json!({"proposal_id": "golden-lifecycle", "idempotency_key": "idem-golden-lifecycle",
               "proposer_id": "golden", "namespace": "golden", "scope": {"type": "global"},
               "payload": {"kind": "fact", "content": "golden lifecycle fact cargo",
                           "tags": [], "applicability": {}, "pinned": false}}),
    );
    let s = ok_structured(&create);
    assert_eq!(s["status"], json!("pending"));
    assert_eq!(s["revision"], json!(1));
    assert!(s["review"].is_null(), "pending proposal has no review yet");

    // Invisible to reads until approved (C-03).
    let get_pending = p.call(
        "memory_get",
        json!({"namespace": "golden", "scope": {"type": "global"},
               "record_id": "golden-lifecycle"}),
    );
    assert_eq!(
        get_pending["result"]["isError"],
        json!(true),
        "{get_pending}"
    );

    let approve = p.call(
        "memory_review",
        json!({"idempotency_key": "review-golden-lifecycle", "reviewer_id": "golden",
               "namespace": "golden", "scope": {"type": "global"},
               "proposal_id": "golden-lifecycle", "expected_proposal_revision": 1,
               "decision": "approve"}),
    );
    let s = ok_structured(&approve);
    assert_eq!(s["status"], json!("approved"));
    assert_eq!(s["review"]["decision"], json!("approve"));
    assert_eq!(s["review"]["applied_record_revision"], json!(1));

    let get_resp = p.call(
        "memory_get",
        json!({"namespace": "golden", "scope": {"type": "global"},
               "record_id": "golden-lifecycle"}),
    );
    let record = ok_structured(&get_resp);
    assert_eq!(record["revision"], json!(1));
    assert_eq!(record["status"], json!("active"));
    assert_eq!(record["content"], json!("golden lifecycle fact cargo"));

    let search_resp = p.call(
        "memory_search",
        json!({"namespace": "golden", "scope": {"type": "global"}, "scope_mode": "exact",
               "query": "golden lifecycle", "candidate_limit": 10, "limit": 5}),
    );
    let search = ok_structured(&search_resp);
    assert_eq!(search["items"].as_array().map(Vec::len), Some(1));

    // Archive keeps history readable.
    let archive = p.call(
        "memory_candidate_archive",
        json!({"proposal_id": "golden-archive", "idempotency_key": "idem-golden-archive",
               "proposer_id": "golden", "namespace": "golden", "scope": {"type": "global"},
               "target_record_id": "golden-lifecycle", "target_revision": 1}),
    );
    assert_eq!(ok_structured(&archive)["status"], json!("pending"));
    let decide = p.call(
        "memory_review",
        json!({"idempotency_key": "review-golden-archive", "reviewer_id": "golden",
               "namespace": "golden", "scope": {"type": "global"},
               "proposal_id": "golden-archive", "expected_proposal_revision": 1,
               "decision": "approve"}),
    );
    assert_eq!(ok_structured(&decide)["status"], json!("approved"));
    let archived_resp = p.call(
        "memory_get",
        json!({"namespace": "golden", "scope": {"type": "global"},
               "record_id": "golden-lifecycle"}),
    );
    let archived = ok_structured(&archived_resp);
    assert_eq!(archived["status"], json!("archived"));
    assert_eq!(
        archived["revision"],
        json!(1),
        "archive preserves the version"
    );

    let empty_resp = p.call(
        "memory_search",
        json!({"namespace": "golden", "scope": {"type": "global"}, "scope_mode": "exact",
               "query": "golden lifecycle", "candidate_limit": 10, "limit": 5}),
    );
    let empty = ok_structured(&empty_resp);
    assert_eq!(empty["items"].as_array().map(Vec::len), Some(0));
}

#[test]
fn golden_memory_replace_flow() {
    let mut p = Peer::start();
    p.initialize();
    let create = p.call(
        "memory_candidate_create",
        json!({"proposal_id": "golden-replace", "idempotency_key": "idem-golden-replace",
               "proposer_id": "golden", "namespace": "golden", "scope": {"type": "global"},
               "payload": {"kind": "fact", "content": "before update",
                           "tags": [], "applicability": {}, "pinned": false}}),
    );
    assert_eq!(create["result"]["isError"], json!(false), "{create}");
    let approve = p.call(
        "memory_review",
        json!({"idempotency_key": "review-golden-replace", "reviewer_id": "golden",
               "namespace": "golden", "scope": {"type": "global"},
               "proposal_id": "golden-replace", "expected_proposal_revision": 1,
               "decision": "approve"}),
    );
    assert_eq!(approve["result"]["isError"], json!(false), "{approve}");
    let replace = p.call(
        "memory_candidate_replace",
        json!({"proposal_id": "golden-replace-2", "idempotency_key": "idem-golden-replace-2",
               "proposer_id": "golden", "namespace": "golden", "scope": {"type": "global"},
               "target_record_id": "golden-replace", "target_revision": 1,
               "payload": {"kind": "fact", "content": "after update",
                           "tags": [], "applicability": {}, "pinned": false}}),
    );
    assert_eq!(replace["result"]["isError"], json!(false), "{replace}");
    let decide = p.call(
        "memory_review",
        json!({"idempotency_key": "review-golden-replace-2", "reviewer_id": "golden",
               "namespace": "golden", "scope": {"type": "global"},
               "proposal_id": "golden-replace-2", "expected_proposal_revision": 1,
               "decision": "approve"}),
    );
    assert_eq!(decide["result"]["isError"], json!(false), "{decide}");
    let get_resp = p.call(
        "memory_get",
        json!({"namespace": "golden", "scope": {"type": "global"},
               "record_id": "golden-replace"}),
    );
    let record = ok_structured(&get_resp);
    assert_eq!(record["content"], json!("after update"));
    assert_eq!(record["revision"], json!(2));
    // Immutable history: revision 1 is still readable.
    let v1_resp = p.call(
        "memory_get",
        json!({"namespace": "golden", "scope": {"type": "global"},
               "record_id": "golden-replace", "revision": 1}),
    );
    let v1 = ok_structured(&v1_resp);
    assert_eq!(v1["content"], json!("before update"));
}

#[test]
fn golden_memory_feedback() {
    let mut p = Peer::start();
    p.initialize();
    let create = p.call(
        "memory_candidate_create",
        json!({"proposal_id": "golden-feedback", "idempotency_key": "idem-golden-feedback",
               "proposer_id": "golden", "namespace": "golden", "scope": {"type": "global"},
               "payload": {"kind": "fact", "content": "feedback target",
                           "tags": [], "applicability": {}, "pinned": false}}),
    );
    assert_eq!(create["result"]["isError"], json!(false), "{create}");
    let approve = p.call(
        "memory_review",
        json!({"idempotency_key": "review-golden-feedback", "reviewer_id": "golden",
               "namespace": "golden", "scope": {"type": "global"},
               "proposal_id": "golden-feedback", "expected_proposal_revision": 1,
               "decision": "approve"}),
    );
    assert_eq!(approve["result"]["isError"], json!(false), "{approve}");
    let r = p.call(
        "memory_feedback",
        json!({"event_id": "golden-evt-1", "idempotency_key": "idem-golden-evt-1",
               "record_id": "golden-feedback", "revision": 1, "feedback": "helpful"}),
    );
    let s = ok_structured(&r);
    assert_eq!(s["feedback"], json!("helpful"));
    let get_resp = p.call(
        "memory_get",
        json!({"namespace": "golden", "scope": {"type": "global"},
               "record_id": "golden-feedback"}),
    );
    let record = ok_structured(&get_resp);
    assert_eq!(
        record["helpful_count"],
        json!(1),
        "memory_feedback: {record}"
    );
}
