//! Memory v2 lifecycle contract tests (plan W3, C-03/C-04).
//!
//! Store-level: proposal invisibility, typed failures with zero partial
//! writes, review CAS, archive history preservation, idempotency, and exact
//! scope isolation.

use xuanling_memory::proposal::{
    CandidateCreateRequest, MemoryPayload, ProposalStatus, RecordGetRequest, ReviewDecision,
    ReviewRequest, ScopeMode, SearchRequestV2,
};
use xuanling_memory::scope::MemoryScope;
use xuanling_memory::{MemoryKind, MemoryStore, ToolErrorCode};

fn payload(content: &str) -> MemoryPayload {
    MemoryPayload {
        kind: MemoryKind::Fact,
        title: Some("title".to_string()),
        content: content.to_string(),
        summary: None,
        tags: vec!["v2test".to_string()],
        applicability: Default::default(),
        pinned: false,
    }
}

fn create_req(id: &str, scope: &MemoryScope, content: &str) -> CandidateCreateRequest {
    CandidateCreateRequest {
        proposal_id: id.to_string(),
        idempotency_key: format!("idem-{id}"),
        proposer_id: "proposer".to_string(),
        namespace: "ns".to_string(),
        scope: scope.clone(),
        payload: payload(content),
    }
}

fn review_req(id: &str, scope: &MemoryScope, decision: ReviewDecision) -> ReviewRequest {
    ReviewRequest {
        idempotency_key: format!("review-idem-{id}"),
        reviewer_id: "reviewer".to_string(),
        namespace: "ns".to_string(),
        scope: scope.clone(),
        proposal_id: id.to_string(),
        expected_proposal_revision: 1,
        decision,
        comment: None,
    }
}

const GLOBAL: MemoryScope = MemoryScope::Global;

#[tokio::test]
async fn candidate_is_invisible_until_approved() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let view = store
        .candidate_create(&create_req("p1", &GLOBAL, "rust edition 2024 facts"))
        .await
        .unwrap();
    assert_eq!(view.status, ProposalStatus::Pending);
    assert_eq!(view.revision, 1);

    // Not visible as a record or in search while pending.
    let err = store
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            record_id: "p1".to_string(),
            revision: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, ToolErrorCode::NotFound);
    let results = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            scope_mode: ScopeMode::Exact,
            query: "rust edition".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert!(
        results.items.is_empty(),
        "pending candidate must not be searchable"
    );

    let approved = store
        .review(&review_req("p1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();
    assert_eq!(approved.status, ProposalStatus::Approved);
    assert_eq!(
        approved.review.as_ref().unwrap().applied_record_revision,
        Some(1)
    );

    let record = store
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            record_id: "p1".to_string(),
            revision: None,
        })
        .await
        .unwrap();
    assert_eq!(record.content, "rust edition 2024 facts");
    assert_eq!(record.revision, 1);
}

#[tokio::test]
async fn invalid_candidate_writes_nothing() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let mut req = create_req("p1", &GLOBAL, "valid");
    req.payload.content = "   ".to_string();
    let err = store.candidate_create(&req).await.unwrap_err();
    assert_eq!(err.code, ToolErrorCode::InvalidInput);
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM memory_proposals")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(count.0, 0, "invalid candidate must write zero proposals");
}

#[tokio::test]
async fn rejected_candidate_never_changes_head() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req("p1", &GLOBAL, "approved content"))
        .await
        .unwrap();
    store
        .review(&review_req("p1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();

    // A rejected replace proposal leaves the head untouched.
    store
        .candidate_replace(&xuanling_memory::proposal::CandidateReplaceRequest {
            proposal_id: "p2".to_string(),
            idempotency_key: "idem-p2".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            target_record_id: "p1".to_string(),
            target_revision: 1,
            payload: payload("replacement content"),
        })
        .await
        .unwrap();
    let rejected = store
        .review(&review_req("p2", &GLOBAL, ReviewDecision::Reject))
        .await
        .unwrap();
    assert_eq!(rejected.status, ProposalStatus::Rejected);
    assert_eq!(
        rejected.review.as_ref().unwrap().applied_record_revision,
        None
    );

    let record = store
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            record_id: "p1".to_string(),
            revision: None,
        })
        .await
        .unwrap();
    assert_eq!(record.content, "approved content");
    assert_eq!(record.revision, 1);

    let versions: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM memory_record_versions WHERE record_id = 'p1'")
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(versions.0, 1, "rejected proposal must not create versions");
}

#[tokio::test]
async fn stale_target_revision_conflicts() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req("p1", &GLOBAL, "v1 content"))
        .await
        .unwrap();
    store
        .review(&review_req("p1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();

    // Replace against a stale target revision must conflict atomically.
    store
        .candidate_replace(&xuanling_memory::proposal::CandidateReplaceRequest {
            proposal_id: "p2".to_string(),
            idempotency_key: "idem-p2".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            target_record_id: "p1".to_string(),
            target_revision: 99,
            payload: payload("v2 content"),
        })
        .await
        .unwrap();
    let err = store
        .review(&review_req("p2", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap_err();
    assert_eq!(err.code, ToolErrorCode::Conflict);
    let details = err.details;
    assert_eq!(details["expected_revision"], 99);
    assert_eq!(details["actual_revision"], 1);

    let versions: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM memory_record_versions WHERE record_id = 'p1'")
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(versions.0, 1, "stale replace must write zero versions");
    let proposals: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM memory_proposals WHERE proposal_id = 'p2' AND status = 'approved'",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(
        proposals.0, 0,
        "failed review must leave the proposal pending"
    );
}

#[tokio::test]
async fn concurrent_review_cas_allows_one_terminal_decision() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req("p1", &GLOBAL, "raced content"))
        .await
        .unwrap();
    let mut req_a = review_req("p1", &GLOBAL, ReviewDecision::Approve);
    req_a.idempotency_key = "review-a".to_string();
    let mut req_b = review_req("p1", &GLOBAL, ReviewDecision::Reject);
    req_b.idempotency_key = "review-b".to_string();

    let (a, b) = tokio::join!(store.review(&req_a), store.review(&req_b));
    let outcomes = [a.is_ok(), b.is_ok()];
    assert_eq!(
        outcomes.iter().filter(|ok| **ok).count(),
        1,
        "exactly one concurrent review may reach a terminal decision"
    );
    let winner_status = if a.is_ok() {
        ProposalStatus::Approved
    } else {
        ProposalStatus::Rejected
    };
    let view = store
        .candidate_get(&xuanling_memory::proposal::CandidateGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            proposal_id: "p1".to_string(),
        })
        .await
        .unwrap();
    assert_eq!(view.status, winner_status);
    assert_eq!(view.revision, 2);
    let reviews: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM memory_reviews")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(reviews.0, 1);
}

#[tokio::test]
async fn archive_preserves_history() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req("p1", &GLOBAL, "v1 content"))
        .await
        .unwrap();
    store
        .review(&review_req("p1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();
    store
        .candidate_replace(&xuanling_memory::proposal::CandidateReplaceRequest {
            proposal_id: "p2".to_string(),
            idempotency_key: "idem-p2".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            target_record_id: "p1".to_string(),
            target_revision: 1,
            payload: payload("v2 content"),
        })
        .await
        .unwrap();
    store
        .review(&review_req("p2", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();

    store
        .candidate_archive(&xuanling_memory::proposal::CandidateArchiveRequest {
            proposal_id: "p3".to_string(),
            idempotency_key: "idem-p3".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            target_record_id: "p1".to_string(),
            target_revision: 2,
        })
        .await
        .unwrap();
    let archived = store
        .review(&review_req("p3", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();
    assert_eq!(archived.status, ProposalStatus::Approved);

    let head = store
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            record_id: "p1".to_string(),
            revision: None,
        })
        .await
        .unwrap();
    assert_eq!(
        head.status,
        xuanling_memory::proposal::RecordStatus::Archived
    );
    assert_eq!(head.revision, 2);

    // Immutable history remains readable at every revision.
    let v1 = store
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            record_id: "p1".to_string(),
            revision: Some(1),
        })
        .await
        .unwrap();
    assert_eq!(v1.content, "v1 content");

    // Archived records are not searchable.
    let results = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            scope_mode: ScopeMode::Exact,
            query: "content".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert!(
        results.items.is_empty(),
        "archived records must not be searchable"
    );

    let versions: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM memory_record_versions WHERE record_id = 'p1'")
            .fetch_one(store.pool())
            .await
            .unwrap();
    assert_eq!(versions.0, 2, "archive must not delete history");
}

#[tokio::test]
async fn idempotency_key_payload_mismatch_conflicts() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req("p1", &GLOBAL, "first content"))
        .await
        .unwrap();

    // Same idempotency key with a different payload conflicts.
    let mut mismatched = create_req("p2", &GLOBAL, "different content");
    mismatched.idempotency_key = "idem-p1".to_string();
    let err = store.candidate_create(&mismatched).await.unwrap_err();
    assert_eq!(err.code, ToolErrorCode::Conflict);

    // Same key + same payload replays the first proposal.
    let mut replay = create_req("p1", &GLOBAL, "first content");
    replay.idempotency_key = "idem-p1".to_string();
    let view = store.candidate_create(&replay).await.unwrap();
    assert_eq!(view.proposal_id, "p1");
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM memory_proposals")
        .fetch_one(store.pool())
        .await
        .unwrap();
    assert_eq!(
        count.0, 1,
        "idempotent replay must not create a second proposal"
    );
}

#[tokio::test]
async fn exact_scope_isolation_and_ancestor_search() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let workspace = MemoryScope::Workspace {
        project_id: "proj-1".to_string(),
        workspace_id: "ws-1".to_string(),
    };
    let sibling = MemoryScope::Workspace {
        project_id: "proj-2".to_string(),
        workspace_id: "ws-1".to_string(),
    };

    store
        .candidate_create(&create_req("w1", &workspace, "workspace knowledge"))
        .await
        .unwrap();
    store
        .review(&review_req("w1", &workspace, ReviewDecision::Approve))
        .await
        .unwrap();
    store
        .candidate_create(&create_req("g1", &GLOBAL, "global knowledge"))
        .await
        .unwrap();
    store
        .review(&review_req("g1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();

    // Exact scope never reads ancestors.
    let exact = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: workspace.clone(),
            scope_mode: ScopeMode::Exact,
            query: "knowledge".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!(exact.items.len(), 1);
    assert_eq!(exact.items[0].record.id, "w1");

    // Ancestors walks workspace → project → global.
    let ancestors = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: workspace.clone(),
            scope_mode: ScopeMode::Ancestors,
            query: "knowledge".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!(ancestors.items.len(), 2);

    // A sibling project never sees other projects' records.
    let sibling_view = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: sibling.clone(),
            scope_mode: ScopeMode::Ancestors,
            query: "knowledge".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!(
        sibling_view.items.len(),
        1,
        "ancestor search sees only its own chain (global), never sibling projects"
    );
    assert_eq!(sibling_view.items[0].record.id, "g1");

    // Cross-scope record access is not_found, not a leak.
    let err = store
        .record_get(&RecordGetRequest {
            namespace: "ns".to_string(),
            scope: sibling.clone(),
            record_id: "w1".to_string(),
            revision: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err.code, ToolErrorCode::NotFound);
}

#[tokio::test]
async fn legacy_v1_database_is_refused_without_modification() {
    // Build a v1-shaped fixture in a temp dir (v1's `memory_records` table).
    // The real legacy database is never opened (C-15).
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("v1-fixture.db");
    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(&db)
        .create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE memory_records (id TEXT PRIMARY KEY)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO memory_records (id) VALUES ('v1-row')")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;

    let err = match MemoryStore::open(&db, 5000).await {
        Err(error) => error,
        Ok(store) => panic!("v1 database must be refused, got {:?}", store.pool()),
    };
    assert_eq!(err.code, ToolErrorCode::Unsupported);
    assert!(err.message.contains("v1"), "message: {}", err.message);

    // The v1 file must be untouched by the refusal (no migration, no repair).
    let options = sqlx::sqlite::SqliteConnectOptions::new().filename(&db);
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM memory_records")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    let v2_tables: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'memory_proposals'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(v2_tables.0, 0, "refusal must not create any v2 table");
    pool.close().await;
}

#[tokio::test]
async fn reopening_existing_v2_database_does_not_modify_main_file() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("existing-v2.db");

    let store = MemoryStore::open(&db, 5000).await.unwrap();
    store.pool().close().await;
    let before = std::fs::read(&db).unwrap();

    let reopened = MemoryStore::open(&db, 5000).await.unwrap();
    reopened.pool().close().await;
    let after = std::fs::read(&db).unwrap();

    assert!(
        before == after,
        "opening an existing v2 database for read-only tools must not rewrite durable bytes"
    );
}

#[tokio::test]
async fn one_and_two_character_cjk_are_recalled() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req(
            "cjk",
            &GLOBAL,
            "使用 cargo build 编译 Rust 工作区",
        ))
        .await
        .unwrap();
    store
        .review(&review_req("cjk", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();
    for query in ["编", "编译", "工"] {
        let results = store
            .search_v2(&SearchRequestV2 {
                namespace: "ns".to_string(),
                scope: GLOBAL.clone(),
                scope_mode: ScopeMode::Exact,
                query: query.to_string(),
                applicability: None,
                candidate_limit: 10,
                limit: 5,
            })
            .await
            .unwrap();
        assert!(
            !results.items.is_empty(),
            "1-2 char CJK query {query:?} must recall via the instr fallback"
        );
        assert!(
            results.items[0]
                .reasons
                .iter()
                .any(|r| r == "instr_fallback"),
            "short query must be served by the parameter-bound fallback"
        );
    }
}

#[tokio::test]
async fn historical_versions_are_not_searchable() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req("h1", &GLOBAL, "OLD_TOKEN ancient content"))
        .await
        .unwrap();
    store
        .review(&review_req("h1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();
    store
        .candidate_replace(&xuanling_memory::proposal::CandidateReplaceRequest {
            proposal_id: "h2".to_string(),
            idempotency_key: "idem-h2".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            target_record_id: "h1".to_string(),
            target_revision: 1,
            payload: payload("NEW_TOKEN modern content"),
        })
        .await
        .unwrap();
    store
        .review(&review_req("h2", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();

    let old = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            scope_mode: ScopeMode::Exact,
            query: "OLD_TOKEN".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert!(
        old.items.is_empty(),
        "superseded versions must not be searchable"
    );

    let new = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            scope_mode: ScopeMode::Exact,
            query: "NEW_TOKEN".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!(new.items.len(), 1, "the active version must be searchable");
}

#[tokio::test]
async fn nearest_scope_wins_exact_duplicate() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let workspace = MemoryScope::Workspace {
        project_id: "p".to_string(),
        workspace_id: "w".to_string(),
    };
    let same_content = "duplicate fact shared across scopes";
    store
        .candidate_create(&create_req("g1", &GLOBAL, same_content))
        .await
        .unwrap();
    store
        .review(&review_req("g1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();
    store
        .candidate_create(&create_req("w1", &workspace, same_content))
        .await
        .unwrap();
    store
        .review(&review_req("w1", &workspace, ReviewDecision::Approve))
        .await
        .unwrap();

    let results = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: workspace.clone(),
            scope_mode: ScopeMode::Ancestors,
            query: "duplicate fact".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!(
        results.items.len(),
        1,
        "ancestor search dedupes by content and keeps the nearest scope"
    );
    assert_eq!(results.items[0].record.id, "w1");
    assert_eq!(results.items[0].scope_distance, 0);
}

#[tokio::test]
async fn unchanged_search_is_byte_identical() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req(
            "b1",
            &GLOBAL,
            "stable output determinism check",
        ))
        .await
        .unwrap();
    store
        .review(&review_req("b1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();
    store
        .feedback_event(&xuanling_memory::proposal::FeedbackEventRequest {
            event_id: "e1".to_string(),
            idempotency_key: "idem-e1".to_string(),
            record_id: "b1".to_string(),
            revision: 1,
            feedback: xuanling_memory::proposal::FeedbackValue::Helpful,
        })
        .await
        .unwrap();

    let run = || async {
        store
            .search_v2(&SearchRequestV2 {
                namespace: "ns".to_string(),
                scope: GLOBAL.clone(),
                scope_mode: ScopeMode::Exact,
                query: "stable output".to_string(),
                applicability: None,
                candidate_limit: 10,
                limit: 5,
            })
            .await
    };
    let first = serde_json::to_string(&run().await.unwrap()).unwrap();
    let second = serde_json::to_string(&run().await.unwrap()).unwrap();
    assert_eq!(
        first, second,
        "same database + request must serialize byte-identically"
    );
    assert!(first.contains("helpful_count"));
}

#[tokio::test]
async fn search_feedback_counts_only_the_current_record_revision() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req(
            "feedback-head",
            &GLOBAL,
            "revision feedback signal initial",
        ))
        .await
        .unwrap();
    store
        .review(&review_req(
            "feedback-head",
            &GLOBAL,
            ReviewDecision::Approve,
        ))
        .await
        .unwrap();
    store
        .feedback_event(&xuanling_memory::proposal::FeedbackEventRequest {
            event_id: "feedback-r1-helpful".to_string(),
            idempotency_key: "feedback-r1-helpful-idem".to_string(),
            record_id: "feedback-head".to_string(),
            revision: 1,
            feedback: xuanling_memory::proposal::FeedbackValue::Helpful,
        })
        .await
        .unwrap();
    store
        .candidate_replace(&xuanling_memory::proposal::CandidateReplaceRequest {
            proposal_id: "feedback-r2".to_string(),
            idempotency_key: "feedback-r2-idem".to_string(),
            proposer_id: "proposer".to_string(),
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            target_record_id: "feedback-head".to_string(),
            target_revision: 1,
            payload: payload("revision feedback signal current"),
        })
        .await
        .unwrap();
    store
        .review(&review_req("feedback-r2", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();

    let search = || async {
        store
            .search_v2(&SearchRequestV2 {
                namespace: "ns".to_string(),
                scope: GLOBAL.clone(),
                scope_mode: ScopeMode::Exact,
                query: "revision feedback signal".to_string(),
                applicability: None,
                candidate_limit: 10,
                limit: 5,
            })
            .await
            .unwrap()
    };
    let result = search().await;
    assert_eq!(result.items.len(), 1);
    assert_eq!(result.items[0].record.revision, 2);
    assert_eq!(result.items[0].record.helpful_count, 0);
    assert_eq!(result.items[0].record.unhelpful_count, 0);

    store
        .feedback_event(&xuanling_memory::proposal::FeedbackEventRequest {
            event_id: "feedback-r2-unhelpful".to_string(),
            idempotency_key: "feedback-r2-unhelpful-idem".to_string(),
            record_id: "feedback-head".to_string(),
            revision: 2,
            feedback: xuanling_memory::proposal::FeedbackValue::Unhelpful,
        })
        .await
        .unwrap();
    let result = search().await;
    assert_eq!(result.items[0].record.helpful_count, 0);
    assert_eq!(result.items[0].record.unhelpful_count, 1);
}

#[tokio::test]
async fn rebuild_projection_restores_recall_and_preserves_canonical_state() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    store
        .candidate_create(&create_req("r1", &GLOBAL, "rebuildable projection content"))
        .await
        .unwrap();
    store
        .review(&review_req("r1", &GLOBAL, ReviewDecision::Approve))
        .await
        .unwrap();

    // Corrupt the derived projection directly.
    sqlx::query("DELETE FROM memory_fts_v2_unicode")
        .execute(store.pool())
        .await
        .unwrap();
    sqlx::query("DELETE FROM memory_fts_v2_trigram")
        .execute(store.pool())
        .await
        .unwrap();
    let broken = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            scope_mode: ScopeMode::Exact,
            query: "rebuildable projection".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert!(
        broken.items.is_empty(),
        "corrupted projection must not recall"
    );

    let canonical_before: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM memory_record_versions), \
                (SELECT COUNT(*) FROM memory_record_heads)",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();

    let rebuilt = store.rebuild_projection().await.unwrap();
    assert_eq!(rebuilt, 1, "one active record rebuilt");

    let healed = store
        .search_v2(&SearchRequestV2 {
            namespace: "ns".to_string(),
            scope: GLOBAL.clone(),
            scope_mode: ScopeMode::Exact,
            query: "rebuildable projection".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .unwrap();
    assert_eq!(healed.items.len(), 1, "rebuild restores recall");

    let canonical_after: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM memory_record_versions), \
                (SELECT COUNT(*) FROM memory_record_heads)",
    )
    .fetch_one(store.pool())
    .await
    .unwrap();
    assert_eq!(
        canonical_before, canonical_after,
        "canonical rows untouched"
    );
}
