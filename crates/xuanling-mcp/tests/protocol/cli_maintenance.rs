//! W5 CLI maintenance subcommand contract tests (plan §6, C-06).
//!
//! `xuanling-mcp memory {export,import,rebuild-index}` is a one-shot
//! maintenance surface: a single-line JSON summary on stdout, diagnostics on
//! stderr, nonzero exit on failure — and it must never start the stdio MCP
//! server. Every spawn here carries an explicit unique temp `--memory-db`
//! (C-15): the real default database is never opened.

use std::ffi::OsStr;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};

use serde_json::{Value, json};
use xuanling_memory::MemoryStore;
use xuanling_memory::proposal::{
    CandidateCreateRequest, CandidateReplaceRequest, FeedbackEventRequest, FeedbackValue,
    MemoryPayload, RecordGetRequest, ReviewDecision, ReviewRequest, ScopeMode, SearchRequestV2,
};
use xuanling_memory::scope::MemoryScope;

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_xuanling-mcp"))
}

/// C-15: maintenance spawns must carry an explicit `--memory-db` pointing away
/// from the real default database (mirrors the Peer guard in
/// `contract_hardening.rs`).
fn assert_isolated_memory_db(args: &[&OsStr]) {
    let position = args
        .iter()
        .position(|arg| *arg == OsStr::new("--memory-db"));
    let value = position
        .and_then(|index| args.get(index + 1))
        .unwrap_or_else(|| panic!("C-15 violation: maintenance spawn without --memory-db"));
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    let defaults = match home {
        Some(home) => {
            let root = std::path::Path::new(&home).join(".xuanling");
            [root.join("toolkit-memory.db"), root.join("memory.db")]
        }
        None => [
            PathBuf::from("toolkit-memory.db"),
            PathBuf::from("memory.db"),
        ],
    };
    for default in defaults {
        assert_ne!(
            PathBuf::from(value),
            default,
            "C-15 violation: --memory-db points at the real default memory DB"
        );
    }
}

/// Spawn the binary with stdin HELD OPEN and no frames written. A maintenance
/// subcommand must still exit; the stdio server would block forever.
fn run_with_open_stdin(args: &[&OsStr]) -> (ExitStatus, Vec<u8>, Vec<u8>) {
    // C-15: args must carry an explicit temp --memory-db, verified here.
    assert_isolated_memory_db(args);
    let mut child = Command::new(binary())
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn maintenance binary");
    // C-15: the args above carry an explicit temp --memory-db, asserted by
    // `assert_isolated_memory_db` before this spawn.
    let stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let (out_tx, out_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let (err_tx, err_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let out_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut reader = stdout;
        let _ = reader.read_to_end(&mut buf);
        out_tx.send(buf).ok();
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut reader = stderr;
        let _ = reader.read_to_end(&mut buf);
        err_tx.send(buf).ok();
    });
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    let status = loop {
        if let Some(status) = child.try_wait().expect("try_wait") {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "subcommand did not exit within 15s while stdin was held open; \
             it is running the stdio server"
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    drop(stdin);
    let _ = child.wait();
    let stdout_bytes = out_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("stdout reader");
    let stderr_bytes = err_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("stderr reader");
    out_thread.join().ok();
    err_thread.join().ok();
    (status, stdout_bytes, stderr_bytes)
}

/// Seed a disk DB with the canonical fixture: one created record, one replace
/// (two versions), one rejected proposal, and one feedback event.
async fn seed_disk_db(path: &std::path::Path) {
    let store = MemoryStore::open(path, 5000).await.expect("open seed DB");
    let scope = MemoryScope::Global;
    let payload = |content: &str| MemoryPayload {
        kind: xuanling_memory::MemoryKind::Fact,
        title: Some("title".to_string()),
        content: content.to_string(),
        summary: None,
        tags: vec!["cli".to_string()],
        applicability: Default::default(),
        pinned: false,
    };
    store
        .candidate_create(&CandidateCreateRequest {
            proposal_id: "p1".to_string(),
            idempotency_key: "idem-p1".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: scope.clone(),
            payload: payload("first fact about cargo rust"),
        })
        .await
        .unwrap();
    store
        .review(&ReviewRequest {
            idempotency_key: "review-p1".to_string(),
            reviewer_id: "reviewer".to_string(),
            namespace: "ns".to_string(),
            scope: scope.clone(),
            proposal_id: "p1".to_string(),
            expected_proposal_revision: 1,
            decision: ReviewDecision::Approve,
            comment: None,
        })
        .await
        .unwrap();
    store
        .candidate_replace(&CandidateReplaceRequest {
            proposal_id: "p2".to_string(),
            idempotency_key: "idem-p2".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: scope.clone(),
            target_record_id: "p1".to_string(),
            target_revision: 1,
            payload: payload("replaced fact about cargo rust"),
        })
        .await
        .unwrap();
    store
        .review(&ReviewRequest {
            idempotency_key: "review-p2".to_string(),
            reviewer_id: "reviewer".to_string(),
            namespace: "ns".to_string(),
            scope: scope.clone(),
            proposal_id: "p2".to_string(),
            expected_proposal_revision: 1,
            decision: ReviewDecision::Approve,
            comment: Some("replaced".to_string()),
        })
        .await
        .unwrap();
    store
        .candidate_create(&CandidateCreateRequest {
            proposal_id: "p3".to_string(),
            idempotency_key: "idem-p3".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: scope.clone(),
            payload: payload("rejected fact never stored"),
        })
        .await
        .unwrap();
    store
        .review(&ReviewRequest {
            idempotency_key: "review-p3".to_string(),
            reviewer_id: "reviewer".to_string(),
            namespace: "ns".to_string(),
            scope: scope.clone(),
            proposal_id: "p3".to_string(),
            expected_proposal_revision: 1,
            decision: ReviewDecision::Reject,
            comment: None,
        })
        .await
        .unwrap();
    store
        .feedback_event(&FeedbackEventRequest {
            event_id: "e1".to_string(),
            idempotency_key: "idem-e1".to_string(),
            record_id: "p1".to_string(),
            revision: 2,
            feedback: FeedbackValue::Helpful,
        })
        .await
        .unwrap();
}

fn parse_summary(stdout: &[u8]) -> Value {
    let text = String::from_utf8(stdout.to_vec()).expect("stdout is UTF-8 JSON");
    assert!(
        !text.contains("Content-Length"),
        "MCP framing leaked onto stdout: {text}"
    );
    serde_json::from_str(text.trim()).expect("single-line JSON summary")
}

/// The plan §6 red test: a maintenance subcommand completes as a one-shot
/// command instead of remaining a stdio server.
#[test]
fn no_subcommand_remains_stdio_server() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = dir.path().join("cli.db");
    let out = dir.path().join("empty.jsonl");
    let (status, stdout, stderr) = run_with_open_stdin(&[
        OsStr::new("--memory-db"),
        db.as_os_str(),
        OsStr::new("memory"),
        OsStr::new("export"),
        OsStr::new("--output"),
        out.as_os_str(),
    ]);
    assert!(
        status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&stderr)
    );
    let summary = parse_summary(&stdout);
    assert_eq!(summary["command"], json!("memory_export"));
    assert_eq!(
        summary["entity_lines"],
        json!(0),
        "empty store exports no entities"
    );
    assert_eq!(summary["format_version"], json!(1));
    assert_eq!(summary["schema_version"], json!(2));
    assert!(out.exists(), "export file was written");

    // Negative control: WITHOUT a subcommand the binary keeps running as the
    // stdio server (stdin open, no frames). This proves the positive case
    // above would hang if the server path were taken.
    let mut server = Command::new(binary())
        .arg("--memory-db")
        .arg(dir.path().join("server.db"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn server control");
    std::thread::sleep(std::time::Duration::from_millis(800));
    assert!(
        server.try_wait().expect("try_wait").is_none(),
        "the subcommand-less binary exited without stdin EOF"
    );
    server.kill().ok();
    let _ = server.wait();
}

#[tokio::test]
async fn cli_export_import_rebuild_round_trip_with_restart() {
    let dir = tempfile::tempdir().expect("temp dir");
    let seed_db = dir.path().join("seed.db");
    let target_db = dir.path().join("target.db");
    seed_disk_db(&seed_db).await;

    // export
    let out = dir.path().join("export.jsonl");
    let (status, stdout, stderr) = run_with_open_stdin(&[
        OsStr::new("--memory-db"),
        seed_db.as_os_str(),
        OsStr::new("memory"),
        OsStr::new("export"),
        OsStr::new("--output"),
        out.as_os_str(),
    ]);
    assert!(
        status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&stderr)
    );
    let summary = parse_summary(&stdout);
    assert_eq!(summary["command"], json!("memory_export"));
    assert_eq!(
        summary["entity_lines"],
        json!(10),
        "2 versions + 1 head + 3 proposals + 3 reviews + 1 event"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&out)
            .expect("export metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "export file is private");
    }

    // import into an empty disk DB
    let (status, stdout, stderr) = run_with_open_stdin(&[
        OsStr::new("--memory-db"),
        target_db.as_os_str(),
        OsStr::new("memory"),
        OsStr::new("import"),
        OsStr::new("--input"),
        out.as_os_str(),
    ]);
    assert!(
        status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&stderr)
    );
    let summary = parse_summary(&stdout);
    assert_eq!(summary["command"], json!("memory_import"));
    assert_eq!(summary["entity_lines"], json!(10));

    // rebuild-index on the imported DB
    let (status, stdout, stderr) = run_with_open_stdin(&[
        OsStr::new("--memory-db"),
        target_db.as_os_str(),
        OsStr::new("memory"),
        OsStr::new("rebuild-index"),
    ]);
    assert!(
        status.success(),
        "stderr: {}",
        String::from_utf8_lossy(&stderr)
    );
    let summary = parse_summary(&stdout);
    assert_eq!(summary["command"], json!("memory_rebuild_index"));
    assert_eq!(summary["active_records_indexed"], json!(1));

    // Restart evidence: reopen the imported DB in-process and verify history
    // and recall through the rebuilt projection.
    let reopened = MemoryStore::open(&target_db, 5000).await.expect("reopen");
    let record = reopened
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: MemoryScope::Global,
            record_id: "p1".to_string(),
            revision: Some(2),
        })
        .await
        .expect("record_get after import");
    assert_eq!(record.content, "replaced fact about cargo rust");
    let results = reopened
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: MemoryScope::Global,
            scope_mode: ScopeMode::Exact,
            query: "replaced fact".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .expect("search after import");
    assert_eq!(results.items.len(), 1);
    assert_eq!(results.items[0].record.id, "p1");
}

#[tokio::test]
async fn cli_export_refuses_existing_target() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = dir.path().join("seed.db");
    seed_disk_db(&db).await;
    let out = dir.path().join("existing.jsonl");
    std::fs::write(&out, "precious").expect("fixture file");
    let (status, _stdout, _stderr) = run_with_open_stdin(&[
        OsStr::new("--memory-db"),
        db.as_os_str(),
        OsStr::new("memory"),
        OsStr::new("export"),
        OsStr::new("--output"),
        out.as_os_str(),
    ]);
    assert!(!status.success(), "export over an existing file must fail");
    assert_eq!(
        std::fs::read_to_string(&out).expect("read fixture"),
        "precious",
        "existing target content is preserved"
    );
}

#[tokio::test]
async fn cli_import_rejects_invalid_file_and_leaves_target_empty() {
    let dir = tempfile::tempdir().expect("temp dir");
    let target_db = dir.path().join("target.db");
    let bad = dir.path().join("bad.jsonl");
    std::fs::write(&bad, "not an export file\n").expect("fixture file");
    let (status, _stdout, stderr) = run_with_open_stdin(&[
        OsStr::new("--memory-db"),
        target_db.as_os_str(),
        OsStr::new("memory"),
        OsStr::new("import"),
        OsStr::new("--input"),
        bad.as_os_str(),
    ]);
    assert!(!status.success(), "invalid import must fail");
    assert!(!stderr.is_empty(), "failure must be explained on stderr");

    // The target stayed empty: exporting it yields zero entities.
    let out = dir.path().join("after.jsonl");
    let (status, stdout, _stderr) = run_with_open_stdin(&[
        OsStr::new("--memory-db"),
        target_db.as_os_str(),
        OsStr::new("memory"),
        OsStr::new("export"),
        OsStr::new("--output"),
        out.as_os_str(),
    ]);
    assert!(status.success());
    let summary = parse_summary(&stdout);
    assert_eq!(
        summary["entity_lines"],
        json!(0),
        "failed import wrote nothing"
    );
}
