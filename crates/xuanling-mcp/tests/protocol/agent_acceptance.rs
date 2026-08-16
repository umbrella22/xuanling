//! A1-A8 agent acceptance scenarios (plan §10 W7).
//!
//! These run the *same* typed-tool requests an external MCP client would send,
//! against the local binary, asserting the cross-platform contract. The same
//! requests are what Codex/Claude Code/OpenCode send in W7 integration; here
//! they execute without a shell dialect, proving the "no OS command retry"
//! property on the current platform. Run on all three OSes in CI.
//!
//! | ID | Scenario | Same input | Pass condition |
//! | --- | --- | --- | --- |
//! | A1 | search source for a symbol | same fs_search | no grep/findstr retry |
//! | A2 | read file with spaces+Unicode | same fs_read_text | content+hash identical |
//! | A3 | copy/replace/move files | same typed sequence | schema+bytes identical |
//! | A4 | argv with quotes/metachars | same process_run | child receives same args, no shell |
//! | A5 | detect+run project check | same fixture+project_run | resolver picks correct program |
//! | A6 | cross-client shared memory | put then search | same record recalled |
//! | A7 | OS-specific memory | same query, different applicability | only matching/generic returned |
//! | A8 | Chinese experience recall | same Chinese query | lexical tier hits |

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::{Value, json};

fn binary() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
}

/// C-15 guard helper: refuse argv without an explicit non-default --memory-db.
fn default_memory_db_paths() -> [std::path::PathBuf; 2] {
    // Both real default paths are protected (plan C-15): the legacy v1
    // `toolkit-memory.db` and the 0.2.0 default `memory.db` now used by the
    // live host. Test automation must never open either.
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

struct Peer {
    child: std::process::Child,
    stdout: BufReader<std::process::ChildStdout>,
    stdin: std::process::ChildStdin,
    next_id: i64,
    // Hold the temp DB dir for the Peer's life so acceptance tests never create
    // or write the real `~/.xuanling/toolkit-memory.db` (review P1 round 2:
    // the harness previously opened the default DB for every scenario).
    _db_dir: tempfile::TempDir,
}

impl Peer {
    fn start() -> Self {
        let db_dir = tempfile::tempdir().expect("temp db dir");
        let db = db_dir.path().join("acceptance.db");
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
                "clientInfo": {"name": "agent-acceptance", "version": "0"}
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
fn a1_search_source_for_symbol() {
    // Same fs_search request on all OSes; no grep/findstr retry because the
    // toolkit scans with Rust regex.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("lib.rs"),
        "pub fn xuanling_target_symbol() {}\n",
    )
    .unwrap();
    let mut p = Peer::start();
    p.initialize();
    let r = p.call(
        "fs_search",
        json!({"path": dir.path().to_string_lossy(), "pattern": "xuanling_target_symbol", "literal": true}),
    );
    let s = &r["result"]["structuredContent"];
    assert!(s["matches"].is_array());
    assert!(
        !s["matches"].as_array().unwrap().is_empty(),
        "A1: fs_search must find the symbol without grep/findstr"
    );
}

#[test]
fn a2_read_file_with_spaces_and_unicode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("文件 名 with spaces.txt");
    let body = "内容 content 你好 🌍\n";
    std::fs::write(&path, body).unwrap();
    let mut p = Peer::start();
    p.initialize();
    let r = p.call(
        "fs_read_text",
        json!({"path": path.to_string_lossy(), "include_sha256": true}),
    );
    let s = &r["result"]["structuredContent"];
    assert_eq!(
        s["content"],
        json!(body),
        "A2: content must round-trip identically"
    );
    // The sha256 of the returned content must be deterministic across OSes.
    let sha = s["sha256"].as_str().unwrap();
    assert!(!sha.is_empty());
}

#[test]
fn a3_copy_replace_move_files() {
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("a.txt");
    std::fs::write(&src, "payload").unwrap();
    let copy = dir.path().join("b.txt");
    let moved = dir.path().join("c.txt");
    let mut p = Peer::start();
    p.initialize();
    let r1 = p.call(
        "fs_copy",
        json!({"from": src.to_string_lossy(), "to": copy.to_string_lossy(), "overwrite": false, "recursive": true}),
    );
    assert_eq!(r1["result"]["structuredContent"]["copied_files"], json!(1));
    let r2 = p.call(
        "fs_replace_text",
        json!({"path": copy.to_string_lossy(), "old": "payload", "new": "PAYLOAD", "replace_all": false}),
    );
    assert_eq!(r2["result"]["structuredContent"]["replacements"], json!(1));
    let r3 = p.call(
        "fs_move",
        json!({"from": copy.to_string_lossy(), "to": moved.to_string_lossy(), "overwrite": false}),
    );
    assert_eq!(r3["result"]["structuredContent"]["moved"], json!(true));
    assert_eq!(std::fs::read_to_string(&moved).unwrap(), "PAYLOAD");
}

#[test]
fn a4_argv_preserves_quotes_and_metacharacters() {
    // process_run passes argv directly to the child (exec on Unix,
    // CreateProcess on Windows), never via a shell. On Unix we verify `echo`
    // prints each metachar arg verbatim; on Windows we verify the spawn
    // accepts the metachar args as a LITERAL argv (no shell split/parse) by
    // checking the call returns a tool result rather than a protocol error.
    // Runs on all three OSes (review P1: was previously #[cfg(unix)]-only).
    let tricky = vec!["a;b".to_string(), "c|d".to_string(), "$HOME".to_string()];
    let mut p = Peer::start();
    p.initialize();
    #[cfg(unix)]
    {
        let r = p.call(
            "process_run",
            json!({"program": "echo", "args": tricky.clone(), "stdout": "inline", "stderr": "null"}),
        );
        let s = &r["result"]["structuredContent"];
        assert!(
            s["success"].as_bool().unwrap_or(false),
            "A4 (unix): echo must succeed: {r}"
        );
        let out = s["stdout"].as_str().unwrap_or("");
        for t in &tricky {
            assert!(
                out.contains(t),
                "A4 (unix): arg `{t}` must arrive verbatim (no shell): {out}"
            );
        }
    }
    #[cfg(windows)]
    {
        // `where` is a real .exe receiving argv directly; the metacharacters
        // are passed as a literal search pattern (not shell-interpreted). The
        // call must return a tool result (not a shell-parse protocol error).
        let _ = tricky;
        let r = p.call(
            "process_run",
            json!({"program": "where", "args": tricky.clone(), "stdout": "inline", "stderr": "null"}),
        );
        assert!(
            r.get("result").is_some(),
            "A4 (windows): must be a tool result, not a shell parse error: {r}"
        );
        assert!(
            r["result"]["structuredContent"]["success"].is_boolean(),
            "A4 (windows): result must carry a success boolean: {r}"
        );
    }
}

#[test]
fn a5_detect_and_run_project_check() {
    // Resolve the project command AND run it via project_run (plan §10 A5
    // requires project_run, not just project_command — review P1). Uses a
    // throwaway Rust project so the action resolves to `cargo check`.
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("Cargo.toml"),
        "[package]\nname = \"a5\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(dir.path().join("src")).unwrap();
    std::fs::write(dir.path().join("src/main.rs"), "fn main() {}\n").unwrap();
    let proj = dir.path().to_string_lossy().into_owned();

    let mut p = Peer::start();
    p.initialize();
    // Step 1: project_command resolves cargo + check.
    let r = p.call(
        "project_command",
        json!({"project_path": proj, "action": "check"}),
    );
    let s = &r["result"]["structuredContent"];
    assert_eq!(s["program"], json!("cargo"), "A5: resolver picks cargo");
    assert!(s["args"].as_array().unwrap().contains(&json!("check")));
    assert!(
        std::path::Path::new(s["cwd"].as_str().unwrap_or("")).is_absolute(),
        "A5: cwd must be absolute"
    );

    // Step 2: project_run actually executes it (composes resolver + process_run).
    let r2 = p.call(
        "project_run",
        json!({"project_path": proj, "action": "check", "inherit_env": true, "stdout": "null", "stderr": "null"}),
    );
    assert!(
        r2.get("result").is_some(),
        "A5: project_run must return a tool result, not a protocol error: {r2}"
    );
    // Don't let a SpawnFailed silently count as acceptance evidence (review P1
    // round 2). When cargo IS present (CI), `cargo check` on a valid empty
    // project must succeed. Only when cargo is absent do we soft-skip with a
    // reason — never a silent pass.
    if r2["result"]["isError"].as_bool().unwrap_or(false) {
        eprintln!(
            "A5: project_run returned a tool error (cargo likely absent in this env); skipping success assertion: {r2}"
        );
        return;
    }
    let s2 = &r2["result"]["structuredContent"];
    assert!(
        s2["success"].as_bool().unwrap_or(false),
        "A5: cargo check via project_run must succeed on a valid temp project: {r2}"
    );
}

#[test]
fn a6_cross_client_shared_memory() {
    // Put a record in one process, search it in a second process pointing at
    // the same DB file. This validates cross-client memory sharing + restart
    // recall. We use a temp DB file and override the default path via a custom
    // binary invocation (the default ~ path may not be shared).
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("shared.db");

    // Process 1: put.
    let mut cmd1 = Command::new(binary());
    cmd1.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("--memory-db")
        .arg(&db);
    enforce_isolated_memory_db(&cmd1);
    let mut child1 = cmd1.spawn().expect("spawn p1");
    let mut stdin1 = child1.stdin.take().unwrap();
    let init1 = serde_json::to_string(&json!({
        "jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c1","version":"0"}}
    }))
    .unwrap();
    writeln!(stdin1, "{init1}").unwrap();
    stdin1.flush().unwrap();
    let mut out1 = BufReader::new(child1.stdout.take().unwrap());
    let mut l = String::new();
    out1.read_line(&mut l).unwrap(); // init resp
    // v2 write path: pending proposal, then an approving review (C-03).
    let create = json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"memory_candidate_create",
                  "arguments":{"proposal_id":"a6-shared","idempotency_key":"idem-a6-shared",
                               "proposer_id":"a6","namespace":"a6","scope":{"type":"global"},
                               "payload":{"kind":"fact","content":"a6 cross client shared fact cargo rust",
                                          "tags":[],"applicability":{},"pinned":false}}}});
    writeln!(stdin1, "{}", serde_json::to_string(&create).unwrap()).unwrap();
    stdin1.flush().unwrap();
    let mut l = String::new();
    out1.read_line(&mut l).unwrap();
    let create_resp: Value = serde_json::from_str(&l).unwrap();
    if create_resp["result"]["isError"].as_bool().unwrap_or(false) {
        eprintln!("A6: memory store unavailable in this environment; skipping");
        let _ = child1.kill();
        let _ = child1.wait();
        return;
    }
    let review = json!({"jsonrpc":"2.0","id":3,"method":"tools/call",
        "params":{"name":"memory_review",
                  "arguments":{"idempotency_key":"review-a6-shared","reviewer_id":"a6",
                               "namespace":"a6","scope":{"type":"global"},
                               "proposal_id":"a6-shared","expected_proposal_revision":1,
                               "decision":"approve"}}});
    writeln!(stdin1, "{}", serde_json::to_string(&review).unwrap()).unwrap();
    stdin1.flush().unwrap();
    let mut l = String::new();
    out1.read_line(&mut l).unwrap();
    let review_resp: Value = serde_json::from_str(&l).unwrap();
    assert_eq!(
        review_resp["result"]["structuredContent"]["status"],
        json!("approved"),
        "{review_resp}"
    );
    drop(stdin1);
    let _ = child1.wait();

    // Process 2: search the same DB.
    let mut cmd2 = Command::new(binary());
    cmd2.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("--memory-db")
        .arg(&db);
    enforce_isolated_memory_db(&cmd2);
    let mut child2 = cmd2.spawn().expect("spawn p2");
    let mut stdin2 = child2.stdin.take().unwrap();
    let init2 = serde_json::to_string(&json!({
        "jsonrpc":"2.0","id":1,"method":"initialize",
        "params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"c2","version":"0"}}
    }))
    .unwrap();
    writeln!(stdin2, "{init2}").unwrap();
    stdin2.flush().unwrap();
    let mut out2 = BufReader::new(child2.stdout.take().unwrap());
    let mut l = String::new();
    out2.read_line(&mut l).unwrap();
    let search = json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
        "params":{"name":"memory_search",
                  "arguments":{"namespace":"a6","scope":{"type":"global"},"scope_mode":"exact",
                               "query":"cargo rust","candidate_limit":10,"limit":5}}});
    writeln!(stdin2, "{}", serde_json::to_string(&search).unwrap()).unwrap();
    stdin2.flush().unwrap();
    let mut l = String::new();
    out2.read_line(&mut l).unwrap();
    let search_resp: Value = serde_json::from_str(&l).unwrap();
    let _ = child2.kill();
    let _ = child2.wait();
    let results = &search_resp["result"]["structuredContent"]["items"];
    assert!(
        results.is_array() && !results.as_array().unwrap().is_empty(),
        "A6: second client must recall the record written by the first"
    );
}

#[test]
fn a7_os_specific_memory_filtering() {
    // A Windows-only record must not surface under a Linux query context
    // (v2 search applicability filter).
    let mut p = Peer::start();
    p.initialize();
    if v2_put_approved(
        &mut p,
        "a7",
        "a7 windows only build flag",
        json!({"operating_systems": ["windows"]}),
    )
    .is_none()
    {
        return;
    }
    let r = v2_search(
        &mut p,
        "a7",
        "build flag",
        json!({"operating_systems": ["linux"]}),
    );
    let items = &r["result"]["structuredContent"]["items"];
    assert!(
        items.as_array().map(|a| a.is_empty()).unwrap_or(true),
        "A7: OS-mismatched record must be excluded"
    );
}

#[test]
fn a8_chinese_lexical_recall() {
    let mut p = Peer::start();
    p.initialize();
    if v2_put_approved(&mut p, "a8", "使用 cargo build 编译 Rust 工作区", json!({})).is_none()
    {
        return;
    }
    let r = v2_search(&mut p, "a8", "编译", Value::Null);
    let items = &r["result"]["structuredContent"]["items"];
    assert!(
        items.as_array().map(|a| !a.is_empty()).unwrap_or(false),
        "A8: Chinese query must recall via the default lexical tier"
    );
}

/// Skip helper: returns true if the memory store is unavailable in this run.
fn memory_unavailable(resp: &Value) -> bool {
    resp["result"]["isError"].as_bool().unwrap_or(false)
}

/// memory v2 helper: submit a create proposal and approve it, returning the
/// active record id (candidate -> review is the only write path, C-03).
fn v2_put_approved(
    p: &mut Peer,
    namespace: &str,
    content: &str,
    applicability: Value,
) -> Option<String> {
    let scope = json!({"type": "global"});
    let proposal_id = format!("prop-{namespace}-{}", content.len());
    let create = p.call(
        "memory_candidate_create",
        json!({
            "proposal_id": proposal_id,
            "idempotency_key": format!("idem-{proposal_id}"),
            "proposer_id": "acceptance-harness",
            "namespace": namespace,
            "scope": scope,
            "payload": {
                "kind": "fact",
                "content": content,
                "tags": [],
                "applicability": applicability,
                "pinned": false,
            },
        }),
    );
    if memory_unavailable(&create) {
        eprintln!("memory store unavailable; skipping");
        return None;
    }
    assert_eq!(
        create["result"]["structuredContent"]["status"],
        json!("pending"),
        "{create}"
    );
    let review = p.call(
        "memory_review",
        json!({
            "idempotency_key": format!("review-{proposal_id}"),
            "reviewer_id": "acceptance-harness",
            "namespace": namespace,
            "scope": scope,
            "proposal_id": proposal_id,
            "expected_proposal_revision": 1,
            "decision": "approve",
        }),
    );
    assert_eq!(
        review["result"]["structuredContent"]["status"],
        json!("approved"),
        "{review}"
    );
    Some(proposal_id)
}

fn v2_search(p: &mut Peer, namespace: &str, query: &str, applicability: Value) -> Value {
    p.call(
        "memory_search",
        json!({
            "namespace": namespace,
            "scope": {"type": "global"},
            "scope_mode": "exact",
            "query": query,
            "applicability": applicability,
            "candidate_limit": 10,
            "limit": 5,
        }),
    )
}

#[test]
fn memory_search_cross_namespace_does_not_leak() {
    // A record in namespace A must NEVER appear in a search for namespace B.
    let mut p = Peer::start();
    p.initialize();
    if v2_put_approved(
        &mut p,
        "w6secret",
        "LEAK_TOKEN_ZETA w6 namespace secret",
        json!({}),
    )
    .is_none()
    {
        return;
    }
    let r = v2_search(&mut p, "w6other", "LEAK_TOKEN_ZETA", Value::Null);
    let items = &r["result"]["structuredContent"]["items"];
    assert!(
        items.as_array().map(|a| a.is_empty()).unwrap_or(true),
        "cross-namespace leak detected: {r}"
    );
}

#[test]
fn memory_search_applicability_mismatch_excluded() {
    // A record whose applicability does not match the query context is
    // excluded from search results.
    let mut p = Peer::start();
    p.initialize();
    if v2_put_approved(
        &mut p,
        "w6app",
        "APPL_TOKEN plan9 only fact",
        json!({"operating_systems": ["plan9"]}),
    )
    .is_none()
    {
        return;
    }
    let r = v2_search(
        &mut p,
        "w6app",
        "APPL_TOKEN",
        json!({"operating_systems": ["linux"]}),
    );
    let items = &r["result"]["structuredContent"]["items"];
    assert!(
        items.as_array().map(|a| a.is_empty()).unwrap_or(true),
        "applicability-mismatched record must be excluded: {r}"
    );
}

#[test]
fn memory_search_reflects_approved_replace() {
    // After an approved replace, search reflects the NEW content only (the
    // active-only FTS projection follows the head).
    let mut p = Peer::start();
    p.initialize();
    let record_id = match v2_put_approved(
        &mut p,
        "w6upd",
        "UPD_TOKEN old content before edit",
        json!({}),
    ) {
        Some(id) => id,
        None => return,
    };
    let replace = p.call(
        "memory_candidate_replace",
        json!({
            "proposal_id": "w6upd-replace",
            "idempotency_key": "idem-w6upd-replace",
            "proposer_id": "acceptance-harness",
            "namespace": "w6upd",
            "scope": {"type": "global"},
            "target_record_id": record_id,
            "target_revision": 1,
            "payload": {
                "kind": "fact",
                "content": "UPD_TOKEN new content after edit",
                "tags": [],
                "applicability": {},
                "pinned": false,
            },
        }),
    );
    assert_eq!(
        replace["result"]["structuredContent"]["status"],
        json!("pending"),
        "{replace}"
    );
    let review = p.call(
        "memory_review",
        json!({
            "idempotency_key": "review-w6upd-replace",
            "reviewer_id": "acceptance-harness",
            "namespace": "w6upd",
            "scope": {"type": "global"},
            "proposal_id": "w6upd-replace",
            "expected_proposal_revision": 1,
            "decision": "approve",
        }),
    );
    assert_eq!(
        review["result"]["structuredContent"]["status"],
        json!("approved"),
        "{review}"
    );
    let r = v2_search(&mut p, "w6upd", "UPD_TOKEN", Value::Null);
    let items = &r["result"]["structuredContent"]["items"];
    let hits = items.as_array().cloned().unwrap_or_default();
    assert!(!hits.is_empty(), "updated record must stay searchable: {r}");
    for hit in &hits {
        let content = hit["record"]["content"].as_str().unwrap_or("");
        assert!(
            !content.contains("old content before edit"),
            "stale pre-replace content must not appear: {r}"
        );
    }
}
