//! Memory v2 JSONL export/import contract tests (plan W5, C-06).

use std::path::PathBuf;

use xuanling_memory::proposal::{
    CandidateReplaceRequest, FeedbackEventRequest, FeedbackValue, ProposalStatus, RecordGetRequest,
    ReviewDecision, ReviewRequest, ScopeMode, SearchRequestV2,
};
use xuanling_memory::scope::MemoryScope;
use xuanling_memory::{MemoryKind, MemoryStore, ToolErrorCode, jsonl};

const GLOBAL: MemoryScope = MemoryScope::Global;

fn payload(content: &str) -> xuanling_memory::proposal::MemoryPayload {
    xuanling_memory::proposal::MemoryPayload {
        kind: MemoryKind::Fact,
        title: Some("title".to_string()),
        content: content.to_string(),
        summary: None,
        tags: vec!["jsonl".to_string()],
        applicability: Default::default(),
        pinned: false,
    }
}

/// Seed a store: one created record, one replaced (two versions), one
/// archived proposal rejected, and a feedback event.
async fn seed_store(store: &MemoryStore) {
    store
        .candidate_create(&xuanling_memory::proposal::CandidateCreateRequest {
            proposal_id: "p1".to_string(),
            idempotency_key: "idem-p1".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            payload: payload("first fact about cargo rust"),
        })
        .await
        .unwrap();
    store
        .review(&ReviewRequest {
            idempotency_key: "review-p1".to_string(),
            reviewer_id: "reviewer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
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
            scope: GLOBAL.clone(),
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
            scope: GLOBAL.clone(),
            proposal_id: "p2".to_string(),
            expected_proposal_revision: 1,
            decision: ReviewDecision::Approve,
            comment: Some("replaced".to_string()),
        })
        .await
        .unwrap();
    store
        .candidate_create(&xuanling_memory::proposal::CandidateCreateRequest {
            proposal_id: "p3".to_string(),
            idempotency_key: "idem-p3".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            payload: payload("rejected fact never stored"),
        })
        .await
        .unwrap();
    store
        .review(&ReviewRequest {
            idempotency_key: "review-p3".to_string(),
            reviewer_id: "reviewer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
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

/// Build a populated in-memory store.
async fn populated_store() -> MemoryStore {
    let store = MemoryStore::open_in_memory().await.unwrap();
    seed_store(&store).await;
    store
}

fn temp_file(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("xuanling-jsonl-{}-{name}", std::process::id()))
}

async fn canonical_counts(store: &MemoryStore) -> (i64, i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM memory_record_versions), \
                (SELECT COUNT(*) FROM memory_record_heads), \
                (SELECT COUNT(*) FROM memory_proposals), \
                (SELECT COUNT(*) FROM memory_reviews), \
                (SELECT COUNT(*) FROM memory_feedback_events)",
    )
    .fetch_one(store.pool())
    .await
    .unwrap()
}

#[tokio::test]
async fn export_has_versioned_header_and_verified_trailer() {
    let store = populated_store().await;
    let out = temp_file("header.jsonl");
    let _ = std::fs::remove_file(&out);
    let lines_written = jsonl::export(&store, &out).await.unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    assert_eq!(lines_written as usize, lines.len() - 2, "entities only");

    let header: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(header["type"], "xuanling_memory_export");
    assert_eq!(header["format_version"], 1);
    assert_eq!(header["schema_version"], 2);
    assert!(header["exported_at"].is_string());

    let trailer: serde_json::Value = serde_json::from_str(lines[lines.len() - 1]).unwrap();
    assert_eq!(trailer["type"], "trailer");
    let counts = &trailer["counts"];
    assert_eq!(counts["record_version"], 2, "two immutable versions");
    assert_eq!(counts["record_head"], 1);
    assert_eq!(counts["proposal"], 3);
    assert_eq!(counts["review"], 3);
    assert_eq!(counts["feedback_event"], 1);

    // Trailer hash covers header..last entity line, excluding the trailer.
    let bytes = std::fs::read(&out).unwrap();
    let hashed = &bytes[..bytes.len() - lines[lines.len() - 1].len() - 1];
    assert_eq!(
        xuanling_memory::sha256_hex(hashed),
        trailer["sha256"].as_str().unwrap()
    );

    // Existing targets are never overwritten.
    let err = jsonl::export(&store, &out).await.unwrap_err();
    assert_eq!(err.code, ToolErrorCode::Conflict);
    std::fs::remove_file(&out).ok();
}

#[tokio::test]
async fn truncated_import_leaves_empty_store() {
    let store = populated_store().await;
    let out = temp_file("truncated.jsonl");
    let _ = std::fs::remove_file(&out);
    jsonl::export(&store, &out).await.unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    // Drop the last two entity lines but keep the (now lying) trailer.
    let truncated: String = lines[..lines.len() - 2].join("\n") + "\n";
    std::fs::write(&out, truncated).unwrap();

    let target = MemoryStore::open_in_memory().await.unwrap();
    let err = jsonl::import(&target, &out).await.unwrap_err();
    assert_eq!(err.code, ToolErrorCode::IntegrityError, "{err}");
    assert_eq!(canonical_counts(&target).await, (0, 0, 0, 0, 0));
    std::fs::remove_file(&out).ok();
}

#[tokio::test]
async fn checksum_mismatch_leaves_empty_store() {
    let store = populated_store().await;
    let out = temp_file("tampered.jsonl");
    let _ = std::fs::remove_file(&out);
    jsonl::export(&store, &out).await.unwrap();
    let mut text = std::fs::read_to_string(&out).unwrap();
    // Tamper with an entity line without touching the trailer.
    text = text.replacen("first fact", "tampered fact", 1);
    std::fs::write(&out, text).unwrap();

    let target = MemoryStore::open_in_memory().await.unwrap();
    let err = jsonl::import(&target, &out).await.unwrap_err();
    assert_eq!(err.code, ToolErrorCode::IntegrityError);
    assert_eq!(canonical_counts(&target).await, (0, 0, 0, 0, 0));
    std::fs::remove_file(&out).ok();
}

#[tokio::test]
async fn nonempty_import_conflicts() {
    let source = populated_store().await;
    let out = temp_file("nonempty.jsonl");
    let _ = std::fs::remove_file(&out);
    jsonl::export(&source, &out).await.unwrap();

    let target = populated_store().await;
    let err = jsonl::import(&target, &out).await.unwrap_err();
    assert_eq!(err.code, ToolErrorCode::Conflict, "{err}");
    assert_eq!(
        canonical_counts(&target).await,
        (2, 1, 3, 3, 1),
        "target untouched"
    );
    std::fs::remove_file(&out).ok();
}

#[tokio::test]
async fn round_trip_preserves_ids_revisions_and_idempotency() {
    let source = populated_store().await;
    let out = temp_file("roundtrip.jsonl");
    let _ = std::fs::remove_file(&out);
    jsonl::export(&source, &out).await.unwrap();

    let target = MemoryStore::open_in_memory().await.unwrap();
    jsonl::import(&target, &out).await.unwrap();
    assert_eq!(
        canonical_counts(&target).await,
        canonical_counts(&source).await
    );

    // Ids, revisions, statuses and idempotency keys survive the trip.
    let record = target
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            record_id: "p1".to_string(),
            revision: Some(2),
        })
        .await
        .unwrap();
    assert_eq!(record.content, "replaced fact about cargo rust");
    let v1 = target
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            record_id: "p1".to_string(),
            revision: Some(1),
        })
        .await
        .unwrap();
    assert_eq!(v1.content, "first fact about cargo rust");
    assert_eq!(v1.helpful_count, 0);
    assert_eq!(record.helpful_count, 1, "feedback bound to revision 2");

    let p3 = target
        .candidate_get(&xuanling_memory::proposal::CandidateGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            proposal_id: "p3".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(p3.status, ProposalStatus::Rejected);

    // Idempotency keys still replay: same key + same digest returns p1.
    let replay = target
        .candidate_create(&xuanling_memory::proposal::CandidateCreateRequest {
            proposal_id: "p9".to_string(),
            idempotency_key: "idem-p1".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            payload: payload("first fact about cargo rust"),
        })
        .await
        .unwrap();
    assert_eq!(replay.proposal_id, "p1", "digest-keyed replay survives");

    // Restart + search recall through the rebuilt projection.
    let results = target
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            scope_mode: ScopeMode::Exact,
            query: "replaced fact".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!(results.items.len(), 1);
    assert_eq!(results.items[0].record.id, "p1");
    std::fs::remove_file(&out).ok();
}

#[tokio::test]
async fn restart_after_import_recalls_through_rebuilt_projection() {
    let dir = tempfile::tempdir().unwrap();
    let source_path = dir.path().join("source.db");
    let target_path = dir.path().join("target.db");
    let out = dir.path().join("restart.jsonl");

    // Populate a disk store, export, and import into a second disk store.
    {
        let store = MemoryStore::open(&source_path, 5000).await.unwrap();
        seed_store(&store).await;
        jsonl::export(&store, &out).await.unwrap();
    }
    {
        let store = MemoryStore::open(&target_path, 5000).await.unwrap();
        jsonl::import(&store, &out).await.unwrap();
    } // both handles dropped — a real process restart

    // Reopen the imported database from disk and verify recall + history.
    let reopened = MemoryStore::open(&target_path, 5000).await.unwrap();
    let record = reopened
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            record_id: "p1".to_string(),
            revision: Some(2),
        })
        .await
        .unwrap();
    assert_eq!(record.content, "replaced fact about cargo rust");
    let results = reopened
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            scope_mode: ScopeMode::Exact,
            query: "replaced fact".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!(results.items.len(), 1);
    assert_eq!(results.items[0].record.id, "p1");
}

#[tokio::test]
async fn export_excludes_projections() {
    let store = populated_store().await;
    let out = temp_file("noproj.jsonl");
    let _ = std::fs::remove_file(&out);
    jsonl::export(&store, &out).await.unwrap();
    let text = std::fs::read_to_string(&out).unwrap();
    assert!(
        !text.contains("fts"),
        "FTS rows must never be exported: {text}"
    );
    assert!(
        !text.contains("memory_fts"),
        "projection tables absent from the export"
    );
    std::fs::remove_file(&out).ok();
}
