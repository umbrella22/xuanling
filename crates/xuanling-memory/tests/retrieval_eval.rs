//! Deterministic synthetic retrieval evaluator for RFC 0003.

macro_rules! retrieval_behavior_test {
    ($item:item) => {
        #[ignore = "behavior red runs in the contract integration target"]
        $item
    };
}

#[path = "contract/memory_retrieval_contract.rs"]
mod retrieval_contract;

use std::collections::{BTreeMap, BTreeSet};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::time::{Duration, Instant};

use retrieval_contract::{
    CORPUS_SHA256, CORPUS_TEXT, QueryMetrics, QuerySlice, RecordFixture, RecordState,
    RetrievalCorpus, load_corpus, metrics_at_5,
};
use serde::Serialize;
use sqlx::Row;
use xuanling_memory::proposal::{
    CandidateArchiveRequest, CandidateCreateRequest, CandidateReplaceRequest, MemoryPayload,
    ReviewDecision, ReviewRequest, SearchRequestV2,
};
use xuanling_memory::{MemoryScope, MemoryStore, ProposalStatus, ToolErrorCode, jsonl};

#[derive(Clone, Debug, Serialize, PartialEq)]
struct LatencyContract {
    mode: &'static str,
    measured_in_wave: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
struct QueryReport {
    id: String,
    slice: &'static str,
    critical: bool,
    ranked_ids: Vec<String>,
    metrics: Option<QueryMetrics>,
    forbidden_hits: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
struct SliceReport {
    query_count: usize,
    positive_query_count: usize,
    recall_at_1: f64,
    recall_at_5: f64,
    reciprocal_rank_at_5: f64,
    ndcg_at_5: f64,
    empty_result_count: usize,
    no_match_false_positive_count: usize,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
struct EvaluationBody {
    schema_version: u32,
    mode: &'static str,
    corpus_version: &'static str,
    corpus_sha256: &'static str,
    active_record_count: usize,
    non_searchable_record_count: usize,
    query_count: usize,
    positive_query_count: usize,
    critical_query_count: usize,
    aggregate_recall_at_1: f64,
    aggregate_recall_at_5: f64,
    aggregate_mrr_at_5: f64,
    aggregate_ndcg_at_5: f64,
    critical_recall_at_5: f64,
    visibility_violations: usize,
    no_match_false_positive_count: usize,
    empty_result_count: usize,
    returned_item_count: usize,
    channel_hits: BTreeMap<String, usize>,
    slices: BTreeMap<&'static str, SliceReport>,
    canonical_counts_before_search: BTreeMap<&'static str, i64>,
    canonical_counts_after_search: BTreeMap<&'static str, i64>,
    latency: LatencyContract,
    queries: Vec<QueryReport>,
}

#[derive(Debug, Serialize, PartialEq)]
struct EvaluationEnvelope {
    report_sha256: String,
    report: EvaluationBody,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EvaluationMode {
    Baseline,
    After,
}

impl EvaluationMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Baseline => "baseline",
            Self::After => "after",
        }
    }
}

fn payload(record: &RecordFixture) -> MemoryPayload {
    MemoryPayload {
        kind: record.kind.clone(),
        title: record.title.clone(),
        content: record.content.clone(),
        summary: record.summary.clone(),
        tags: record.tags.clone(),
        applicability: record.applicability.clone(),
        pinned: record.pinned,
    }
}

fn review_request(
    record: &RecordFixture,
    proposal_id: &str,
    decision: ReviewDecision,
) -> ReviewRequest {
    ReviewRequest {
        idempotency_key: format!("retrieval-review-{proposal_id}"),
        reviewer_id: "retrieval-corpus-reviewer".to_string(),
        namespace: record.namespace.clone(),
        scope: record.scope.clone(),
        proposal_id: proposal_id.to_string(),
        expected_proposal_revision: 1,
        decision,
        comment: None,
    }
}

async fn seed_record(store: &MemoryStore, record: &RecordFixture) -> Result<(), String> {
    let create = CandidateCreateRequest {
        proposal_id: record.id.clone(),
        idempotency_key: format!("retrieval-create-{}", record.id),
        proposer_id: "retrieval-corpus-seeder".to_string(),
        namespace: record.namespace.clone(),
        scope: record.scope.clone(),
        payload: payload(record),
    };
    store
        .candidate_create(&create)
        .await
        .map_err(|error| format!("seed create {}: {error}", record.id))?;

    match record.state {
        RecordState::Pending => return Ok(()),
        RecordState::Rejected => {
            let view = store
                .review(&review_request(record, &record.id, ReviewDecision::Reject))
                .await
                .map_err(|error| format!("seed reject {}: {error}", record.id))?;
            if view.status != ProposalStatus::Rejected {
                return Err(format!("seed reject {} did not reject", record.id));
            }
            return Ok(());
        }
        RecordState::Active | RecordState::Archived | RecordState::Historical => {
            let view = store
                .review(&review_request(record, &record.id, ReviewDecision::Approve))
                .await
                .map_err(|error| format!("seed approve {}: {error}", record.id))?;
            if view.status != ProposalStatus::Approved {
                return Err(format!("seed approve {} did not approve", record.id));
            }
        }
    }

    if record.state == RecordState::Archived {
        let proposal_id = format!("{}-archive", record.id);
        store
            .candidate_archive(&CandidateArchiveRequest {
                proposal_id: proposal_id.clone(),
                idempotency_key: format!("retrieval-archive-{}", record.id),
                proposer_id: "retrieval-corpus-seeder".to_string(),
                namespace: record.namespace.clone(),
                scope: record.scope.clone(),
                target_record_id: record.id.clone(),
                target_revision: 1,
            })
            .await
            .map_err(|error| format!("seed archive proposal {}: {error}", record.id))?;
        store
            .review(&review_request(
                record,
                &proposal_id,
                ReviewDecision::Approve,
            ))
            .await
            .map_err(|error| format!("seed archive review {}: {error}", record.id))?;
    }

    if record.state == RecordState::Historical {
        let replacement = record
            .replacement
            .as_ref()
            .ok_or_else(|| format!("historical record {} lacks replacement", record.id))?;
        let proposal_id = format!("{}-replace", record.id);
        store
            .candidate_replace(&CandidateReplaceRequest {
                proposal_id: proposal_id.clone(),
                idempotency_key: format!("retrieval-replace-{}", record.id),
                proposer_id: "retrieval-corpus-seeder".to_string(),
                namespace: record.namespace.clone(),
                scope: record.scope.clone(),
                target_record_id: record.id.clone(),
                target_revision: 1,
                payload: MemoryPayload {
                    kind: record.kind.clone(),
                    title: replacement.title.clone(),
                    content: replacement.content.clone(),
                    summary: replacement.summary.clone(),
                    tags: replacement.tags.clone(),
                    applicability: replacement.applicability.clone(),
                    pinned: replacement.pinned,
                },
            })
            .await
            .map_err(|error| format!("seed replace proposal {}: {error}", record.id))?;
        store
            .review(&review_request(
                record,
                &proposal_id,
                ReviewDecision::Approve,
            ))
            .await
            .map_err(|error| format!("seed replace review {}: {error}", record.id))?;
    }
    Ok(())
}

async fn seed_corpus(store: &MemoryStore, corpus: &RetrievalCorpus) -> Result<(), String> {
    for record in &corpus.records {
        seed_record(store, record).await?;
    }
    Ok(())
}

async fn canonical_counts(store: &MemoryStore) -> Result<BTreeMap<&'static str, i64>, String> {
    let mut counts = BTreeMap::new();
    for (table, query) in [
        ("memory_proposals", "SELECT COUNT(*) FROM memory_proposals"),
        ("memory_reviews", "SELECT COUNT(*) FROM memory_reviews"),
        (
            "memory_record_heads",
            "SELECT COUNT(*) FROM memory_record_heads",
        ),
        (
            "memory_record_versions",
            "SELECT COUNT(*) FROM memory_record_versions",
        ),
        (
            "memory_record_tags",
            "SELECT COUNT(*) FROM memory_record_tags",
        ),
        (
            "memory_feedback_events",
            "SELECT COUNT(*) FROM memory_feedback_events",
        ),
    ] {
        let count: (i64,) = sqlx::query_as(query)
            .fetch_one(store.pool())
            .await
            .map_err(|error| format!("count {table}: {error}"))?;
        counts.insert(table, count.0);
    }
    Ok(counts)
}

async fn canonical_digest(store: &MemoryStore) -> Result<String, String> {
    let mut framed = Vec::new();
    for (table, query) in [
        (
            "memory_record_versions",
            "SELECT json_array(record_id, revision, namespace, scope_type, scope_project_id, \
             scope_workspace_id, scope_key, kind, title, content, summary, applicability_json, \
             pinned, content_sha256, dedupe_key, proposal_id, created_at) \
             FROM memory_record_versions ORDER BY record_id, revision",
        ),
        (
            "memory_record_heads",
            "SELECT json_array(record_id, namespace, scope_type, scope_project_id, \
             scope_workspace_id, scope_key, dedupe_key, current_revision, status, created_at, \
             updated_at) FROM memory_record_heads ORDER BY record_id",
        ),
        (
            "memory_record_tags",
            "SELECT json_array(record_id, revision, tag) FROM memory_record_tags \
             ORDER BY record_id, revision, tag",
        ),
        (
            "memory_proposals",
            "SELECT json_array(proposal_id, idempotency_key, operation, namespace, scope_type, \
             scope_project_id, scope_workspace_id, scope_key, target_record_id, target_revision, \
             payload_json, request_digest, proposer_id, status, revision, created_at, decided_at) \
             FROM memory_proposals ORDER BY proposal_id",
        ),
        (
            "memory_reviews",
            "SELECT json_array(proposal_id, idempotency_key, decision, reviewer_id, comment, \
             expected_proposal_revision, applied_record_revision, created_at) \
             FROM memory_reviews ORDER BY proposal_id",
        ),
        (
            "memory_feedback_events",
            "SELECT json_array(event_id, idempotency_key, record_id, revision, feedback, \
             created_at) FROM memory_feedback_events ORDER BY event_id",
        ),
    ] {
        let rows: Vec<(String,)> = sqlx::query_as(query)
            .fetch_all(store.pool())
            .await
            .map_err(|error| format!("snapshot {table}: {error}"))?;
        for value in std::iter::once(table).chain(rows.iter().map(|row| row.0.as_str())) {
            let bytes = value.as_bytes();
            let len = u64::try_from(bytes.len())
                .map_err(|_| format!("snapshot value in {table} is too large"))?;
            framed.extend_from_slice(&len.to_be_bytes());
            framed.extend_from_slice(bytes);
        }
    }
    Ok(xuanling_memory::sha256_hex(&framed))
}

async fn projection_counts(store: &MemoryStore) -> Result<(i64, i64), String> {
    sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM memory_fts_v2_unicode), \
                (SELECT COUNT(*) FROM memory_fts_v2_trigram)",
    )
    .fetch_one(store.pool())
    .await
    .map_err(|error| format!("count retrieval projections: {error}"))
}

async fn projection_digest(store: &MemoryStore) -> Result<String, String> {
    let mut framed = Vec::new();
    for table in ["memory_fts_v2_unicode", "memory_fts_v2_trigram"] {
        let statement = format!(
            "SELECT json_array(record_id, title, content, summary, tags) \
             FROM {table} ORDER BY record_id"
        );
        let rows: Vec<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(statement))
            .fetch_all(store.pool())
            .await
            .map_err(|error| format!("snapshot projection {table}: {error}"))?;
        for value in std::iter::once(table).chain(rows.iter().map(|row| row.0.as_str())) {
            let bytes = value.as_bytes();
            let len = u64::try_from(bytes.len())
                .map_err(|_| format!("projection value in {table} is too large"))?;
            framed.extend_from_slice(&len.to_be_bytes());
            framed.extend_from_slice(bytes);
        }
    }
    Ok(xuanling_memory::sha256_hex(&framed))
}

async fn search_matrix(
    store: &MemoryStore,
    corpus: &RetrievalCorpus,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut responses = Vec::with_capacity(corpus.queries.len());
    for query in &corpus.queries {
        let result = store
            .search_v2(&SearchRequestV2 {
                namespace: query.namespace.clone(),
                scope: query.scope.clone(),
                scope_mode: query.scope_mode,
                query: query.query.clone(),
                applicability: query.applicability.clone(),
                candidate_limit: query.candidate_limit,
                limit: query.limit,
            })
            .await
            .map_err(|error| format!("restart query {}: {error}", query.id))?;
        let ids: Vec<&str> = result
            .items
            .iter()
            .map(|item| item.record.id.as_str())
            .collect();
        if let Some(forbidden) = query
            .forbidden_ids
            .iter()
            .find(|record_id| ids.contains(&record_id.as_str()))
        {
            return Err(format!(
                "restart query {} exposed forbidden record {forbidden}",
                query.id
            ));
        }
        if query.slice == QuerySlice::NoMatch && !ids.is_empty() {
            return Err(format!(
                "restart no-match query {} returned {ids:?}",
                query.id
            ));
        }
        let bytes = serde_json::to_vec(&result)
            .map_err(|error| format!("serialize restart query {}: {error}", query.id))?;
        responses.push((query.id.clone(), bytes));
    }
    Ok(responses)
}

const PERF_VISIBLE_RECORDS: usize = 10_000;
const PERF_INVISIBLE_RECORDS: usize = 20_000;
const PERF_QUERY_COUNT: usize = 32;
const PERF_QUERY_ROUNDS: usize = 3;
const PERF_FIXTURE_SHA256: &str =
    "875f1750da17f1cb41cf8bb77adacb593fc71bae67444b43ec29f497db89a113";
const PERF_QUERY_SHA256: &str = "01d14fb42cb10a1844b989681d223224f47d1a6ee87a6ba16d1fb1190a96df3b";

#[derive(Clone, Debug, Serialize)]
struct LatencyStats {
    sample_count: usize,
    median_us: u64,
    p95_us: u64,
    max_us: u64,
}

#[derive(Debug, Serialize)]
struct PerformanceReport {
    schema_version: u32,
    fixture_sha256: &'static str,
    query_sha256: &'static str,
    visible_active_records: usize,
    invisible_active_records: usize,
    query_count: usize,
    query_rounds: usize,
    baseline_source_sha256: &'static str,
    baseline_latency: LatencyStats,
    after_latency: LatencyStats,
    baseline_rebuild_us: u64,
    after_rebuild_us: u64,
    baseline_peak_rss_sample_bytes: u64,
    after_peak_rss_sample_bytes: u64,
    startup_us: u64,
    startup_projection_rows: i64,
    startup_sentinel_preserved: bool,
}

struct RssSampler {
    stop: Arc<AtomicBool>,
    worker: std::thread::JoinHandle<Result<u64, String>>,
}

impl RssSampler {
    fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let worker = std::thread::spawn(move || {
            let mut peak = 0_u64;
            while !worker_stop.load(AtomicOrdering::Relaxed) {
                peak = peak.max(current_rss_bytes()?);
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(peak.max(current_rss_bytes()?))
        });
        Self { stop, worker }
    }

    fn finish(self) -> Result<u64, String> {
        self.stop.store(true, AtomicOrdering::Relaxed);
        self.worker
            .join()
            .map_err(|_| "RSS sampler thread panicked".to_string())?
    }
}

fn current_rss_bytes() -> Result<u64, String> {
    let pid = std::process::id().to_string();
    let output = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .output()
        .map_err(|error| format!("run ps for RSS sampling: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "ps RSS sampling failed with status {}",
            output.status
        ));
    }
    let kibibytes = std::str::from_utf8(&output.stdout)
        .map_err(|error| format!("ps RSS output is not UTF-8: {error}"))?
        .trim()
        .parse::<u64>()
        .map_err(|error| format!("parse ps RSS output: {error}"))?;
    kibibytes
        .checked_mul(1024)
        .ok_or_else(|| "RSS byte count overflowed u64".to_string())
}

fn performance_queries() -> Vec<String> {
    let queries: Vec<String> = (0..PERF_QUERY_COUNT)
        .map(|index| format!("needle_{index:02}"))
        .collect();
    let mut bytes = Vec::new();
    for query in &queries {
        bytes.extend_from_slice(query.as_bytes());
        bytes.push(b'\n');
    }
    assert_eq!(xuanling_memory::sha256_hex(&bytes), PERF_QUERY_SHA256);
    queries
}

async fn seed_performance_store(path: &std::path::Path) -> Result<MemoryStore, String> {
    let store = MemoryStore::open(path, 5_000)
        .await
        .map_err(|error| format!("open performance store: {error}"))?;
    let mut fixture_bytes = Vec::new();
    let total = PERF_VISIBLE_RECORDS + PERF_INVISIBLE_RECORDS;
    for batch_start in (0..total).step_by(1_000) {
        let batch_end = (batch_start + 1_000).min(total);
        let mut tx = store
            .pool()
            .begin()
            .await
            .map_err(|error| format!("begin performance batch: {error}"))?;
        for index in batch_start..batch_end {
            let visible = index < PERF_VISIBLE_RECORDS;
            let local_index = if visible {
                index
            } else {
                index - PERF_VISIBLE_RECORDS
            };
            let id = if visible {
                format!("perf-visible-{local_index:05}")
            } else {
                format!("perf-invisible-{local_index:05}")
            };
            let workspace_id = if visible {
                "visible".to_string()
            } else {
                format!("invisible-{:02}", local_index % 20)
            };
            let scope = MemoryScope::Workspace {
                project_id: "perf-project".to_string(),
                workspace_id: workspace_id.clone(),
            };
            let scope_key = scope.scope_key();
            let content = if visible {
                format!(
                    "visible retrieval performance record {local_index:05} needle_{:02} stable lexical token",
                    local_index % PERF_QUERY_COUNT
                )
            } else {
                format!(
                    "invisible retrieval performance distractor {local_index:05} needle_{:02} stable lexical token",
                    local_index % PERF_QUERY_COUNT
                )
            };
            fixture_bytes.extend_from_slice(id.as_bytes());
            fixture_bytes.push(0x1f);
            fixture_bytes.extend_from_slice(scope_key.as_bytes());
            fixture_bytes.push(0x1f);
            fixture_bytes.extend_from_slice(content.as_bytes());
            fixture_bytes.push(b'\n');
            let content_sha256 = xuanling_memory::sha256_hex(content.as_bytes());
            let dedupe_key = format!("performance\x1f{content}");

            sqlx::query(
                "INSERT INTO memory_record_versions \
                 (record_id, revision, namespace, scope_type, scope_project_id, \
                  scope_workspace_id, scope_key, kind, title, content, summary, \
                  applicability_json, pinned, content_sha256, dedupe_key, proposal_id, created_at) \
                 VALUES (?, 1, 'performance', 'workspace', 'perf-project', ?, ?, 'fact', \
                         NULL, ?, NULL, '{}', 0, ?, ?, 'performance-fixture', \
                         '2026-08-16T00:00:00Z')",
            )
            .bind(&id)
            .bind(&workspace_id)
            .bind(&scope_key)
            .bind(&content)
            .bind(&content_sha256)
            .bind(&dedupe_key)
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("insert performance version {id}: {error}"))?;
            sqlx::query(
                "INSERT INTO memory_record_heads \
                 (record_id, namespace, scope_type, scope_project_id, scope_workspace_id, \
                  scope_key, dedupe_key, current_revision, status, created_at, updated_at) \
                 VALUES (?, 'performance', 'workspace', 'perf-project', ?, ?, ?, 1, 'active', \
                         '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')",
            )
            .bind(&id)
            .bind(&workspace_id)
            .bind(&scope_key)
            .bind(&dedupe_key)
            .execute(&mut *tx)
            .await
            .map_err(|error| format!("insert performance head {id}: {error}"))?;
            for table in ["memory_fts_v2_unicode", "memory_fts_v2_trigram"] {
                let statement = format!(
                    "INSERT INTO {table} (record_id, title, content, summary, tags) \
                     VALUES (?, NULL, ?, NULL, '')"
                );
                sqlx::query(sqlx::AssertSqlSafe(statement))
                    .bind(&id)
                    .bind(&content)
                    .execute(&mut *tx)
                    .await
                    .map_err(|error| format!("insert performance projection {id}: {error}"))?;
            }
        }
        tx.commit()
            .await
            .map_err(|error| format!("commit performance batch: {error}"))?;
    }
    let observed_digest = xuanling_memory::sha256_hex(&fixture_bytes);
    if observed_digest != PERF_FIXTURE_SHA256 {
        return Err(format!(
            "performance fixture digest drifted: {observed_digest}"
        ));
    }
    Ok(store)
}

async fn frozen_baseline_search_count(
    store: &MemoryStore,
    query: &str,
    target_scope_key: &str,
) -> Result<usize, String> {
    let match_expression = format!("\"{}\"", query.replace('"', "\"\""));
    let mut candidates = BTreeSet::new();
    for table in ["memory_fts_v2_unicode", "memory_fts_v2_trigram"] {
        let statement =
            format!("SELECT record_id FROM {table} WHERE {table} MATCH ? ORDER BY rank LIMIT 100");
        let rows = sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(&match_expression)
            .fetch_all(store.pool())
            .await
            .map_err(|error| format!("baseline FTS query: {error}"))?;
        for row in rows {
            candidates.insert(
                row.try_get::<String, _>(0)
                    .map_err(|error| format!("baseline candidate id: {error}"))?,
            );
        }
    }

    let mut visible = 0_usize;
    for record_id in candidates {
        let row = sqlx::query(
            "SELECT v.record_id, v.content, \
             (SELECT COUNT(*) FROM memory_feedback_events f \
               WHERE f.record_id = v.record_id AND f.revision = v.revision \
                 AND f.feedback = 'helpful') AS helpful_count, \
             (SELECT COUNT(*) FROM memory_feedback_events f \
               WHERE f.record_id = v.record_id AND f.revision = v.revision \
                 AND f.feedback = 'unhelpful') AS unhelpful_count, \
             (SELECT COALESCE(GROUP_CONCAT(t.tag), '') FROM memory_record_tags t \
               WHERE t.record_id = v.record_id AND t.revision = v.revision) AS tags \
             FROM memory_record_heads h JOIN memory_record_versions v \
               ON v.record_id = h.record_id AND v.revision = h.current_revision \
             WHERE h.status = 'active' AND h.namespace = 'performance' \
               AND h.scope_key = ? AND h.record_id = ?",
        )
        .bind(target_scope_key)
        .bind(&record_id)
        .fetch_optional(store.pool())
        .await
        .map_err(|error| format!("baseline visible candidate load: {error}"))?;
        if let Some(row) = row {
            let _: String = row
                .try_get("record_id")
                .map_err(|error| format!("baseline record id: {error}"))?;
            let _: String = row
                .try_get("content")
                .map_err(|error| format!("baseline content: {error}"))?;
            let _: i64 = row
                .try_get("helpful_count")
                .map_err(|error| format!("baseline helpful count: {error}"))?;
            let _: i64 = row
                .try_get("unhelpful_count")
                .map_err(|error| format!("baseline unhelpful count: {error}"))?;
            let _: String = row
                .try_get("tags")
                .map_err(|error| format!("baseline tags: {error}"))?;
            visible += 1;
        }
    }
    Ok(visible)
}

fn latency_stats(mut samples: Vec<u64>) -> LatencyStats {
    assert!(!samples.is_empty(), "latency samples must not be empty");
    samples.sort_unstable();
    let count = samples.len();
    let p95_index = count.saturating_mul(95).div_ceil(100).saturating_sub(1);
    LatencyStats {
        sample_count: count,
        median_us: samples[count / 2],
        p95_us: samples[p95_index],
        max_us: samples[count - 1],
    }
}

async fn measure_baseline_latency(
    store: &MemoryStore,
    queries: &[String],
    target_scope_key: &str,
) -> Result<LatencyStats, String> {
    for query in queries.iter().take(4) {
        let _ = frozen_baseline_search_count(store, query, target_scope_key).await?;
    }
    let mut samples = Vec::with_capacity(queries.len() * PERF_QUERY_ROUNDS);
    for _ in 0..PERF_QUERY_ROUNDS {
        for query in queries {
            let started = Instant::now();
            let count = frozen_baseline_search_count(store, query, target_scope_key).await?;
            if count == 0 {
                return Err(format!("baseline query {query:?} returned no visible rows"));
            }
            samples.push(
                u64::try_from(started.elapsed().as_micros())
                    .map_err(|_| "baseline latency overflowed u64".to_string())?
                    .max(1),
            );
        }
    }
    Ok(latency_stats(samples))
}

async fn measure_after_latency(
    store: &MemoryStore,
    queries: &[String],
    target_scope: &MemoryScope,
) -> Result<LatencyStats, String> {
    let run = |query: &str| SearchRequestV2 {
        namespace: "performance".to_string(),
        scope: target_scope.clone(),
        scope_mode: xuanling_memory::ScopeMode::Exact,
        query: query.to_string(),
        applicability: None,
        candidate_limit: 100,
        limit: 10,
    };
    for query in queries.iter().take(4) {
        store
            .search_v2(&run(query))
            .await
            .map_err(|error| format!("after warmup query {query:?}: {error}"))?;
    }
    let mut samples = Vec::with_capacity(queries.len() * PERF_QUERY_ROUNDS);
    for _ in 0..PERF_QUERY_ROUNDS {
        for query in queries {
            let started = Instant::now();
            let result = store
                .search_v2(&run(query))
                .await
                .map_err(|error| format!("after query {query:?}: {error}"))?;
            if result.items.is_empty() {
                return Err(format!("after query {query:?} returned no visible rows"));
            }
            samples.push(
                u64::try_from(started.elapsed().as_micros())
                    .map_err(|_| "after latency overflowed u64".to_string())?
                    .max(1),
            );
        }
    }
    Ok(latency_stats(samples))
}

async fn frozen_baseline_rebuild(store: &MemoryStore) -> Result<u64, String> {
    let mut tx = store
        .pool()
        .begin()
        .await
        .map_err(|error| format!("begin baseline rebuild: {error}"))?;
    sqlx::query("DELETE FROM memory_fts_v2_unicode")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("clear baseline unicode61: {error}"))?;
    sqlx::query("DELETE FROM memory_fts_v2_trigram")
        .execute(&mut *tx)
        .await
        .map_err(|error| format!("clear baseline trigram: {error}"))?;
    let rows = sqlx::query(
        "SELECT v.record_id, v.title, v.content, v.summary, \
         (SELECT COALESCE(GROUP_CONCAT(t.tag), '') FROM memory_record_tags t \
           WHERE t.record_id = v.record_id AND t.revision = v.revision) AS tags \
         FROM memory_record_heads h JOIN memory_record_versions v \
           ON v.record_id = h.record_id AND v.revision = h.current_revision \
         WHERE h.status = 'active'",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|error| format!("load baseline rebuild rows: {error}"))?;
    for row in &rows {
        let record_id: String = row
            .try_get("record_id")
            .map_err(|error| format!("baseline rebuild id: {error}"))?;
        let title: Option<String> = row
            .try_get("title")
            .map_err(|error| format!("baseline rebuild title: {error}"))?;
        let content: String = row
            .try_get("content")
            .map_err(|error| format!("baseline rebuild content: {error}"))?;
        let summary: Option<String> = row
            .try_get("summary")
            .map_err(|error| format!("baseline rebuild summary: {error}"))?;
        let tags: String = row
            .try_get("tags")
            .map_err(|error| format!("baseline rebuild tags: {error}"))?;
        for table in ["memory_fts_v2_unicode", "memory_fts_v2_trigram"] {
            let statement = format!(
                "INSERT INTO {table} (record_id, title, content, summary, tags) \
                 VALUES (?, ?, ?, ?, ?)"
            );
            sqlx::query(sqlx::AssertSqlSafe(statement))
                .bind(&record_id)
                .bind(&title)
                .bind(&content)
                .bind(&summary)
                .bind(&tags)
                .execute(&mut *tx)
                .await
                .map_err(|error| format!("baseline rebuild projection: {error}"))?;
        }
    }
    let rebuilt = u64::try_from(rows.len())
        .map_err(|_| "baseline rebuild row count overflowed u64".to_string())?;
    tx.commit()
        .await
        .map_err(|error| format!("commit baseline rebuild: {error}"))?;
    Ok(rebuilt)
}

async fn checkpoint_and_close(store: MemoryStore) -> Result<(), String> {
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_all(store.pool())
        .await
        .map_err(|error| format!("checkpoint performance database: {error}"))?;
    store.pool().close().await;
    Ok(())
}

fn average_metrics(metrics: &[QueryMetrics]) -> QueryMetrics {
    let count = metrics.len() as f64;
    let average = |select: fn(&QueryMetrics) -> f64| {
        if metrics.is_empty() {
            0.0
        } else {
            round_six(metrics.iter().map(select).sum::<f64>() / count)
        }
    };
    QueryMetrics {
        recall_at_1: average(|item| item.recall_at_1),
        recall_at_5: average(|item| item.recall_at_5),
        reciprocal_rank_at_5: average(|item| item.reciprocal_rank_at_5),
        ndcg_at_5: average(|item| item.ndcg_at_5),
    }
}

fn round_six(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

async fn evaluate_once(mode: EvaluationMode) -> Result<EvaluationEnvelope, String> {
    let corpus = load_corpus(CORPUS_TEXT)?;
    if corpus.sha256 != CORPUS_SHA256 {
        return Err("loaded corpus digest drifted".to_string());
    }
    let store = MemoryStore::open_in_memory()
        .await
        .map_err(|error| error.to_string())?;
    seed_corpus(&store, &corpus).await?;
    let canonical_before = canonical_counts(&store).await?;

    let mut query_reports = Vec::new();
    let mut metrics = Vec::new();
    let mut critical_metrics = Vec::new();
    let mut slice_metrics: BTreeMap<QuerySlice, Vec<QueryMetrics>> = BTreeMap::new();
    let mut slices: BTreeMap<&'static str, SliceReport> = BTreeMap::new();
    let mut channel_hits = BTreeMap::new();
    let mut visibility_violations = 0;
    let mut no_match_false_positive_count = 0;
    let mut empty_result_count = 0;
    let mut returned_item_count = 0;

    for query in &corpus.queries {
        let result = store
            .search_v2(&SearchRequestV2 {
                namespace: query.namespace.clone(),
                scope: query.scope.clone(),
                scope_mode: query.scope_mode,
                query: query.query.clone(),
                applicability: query.applicability.clone(),
                candidate_limit: query.candidate_limit,
                limit: query.limit,
            })
            .await
            .map_err(|error| format!("query {}: {error}", query.id))?;
        let ranked_ids: Vec<String> = result
            .items
            .iter()
            .map(|item| item.record.id.clone())
            .collect();
        let forbidden_hits: Vec<String> = ranked_ids
            .iter()
            .filter(|record_id| query.forbidden_ids.contains(record_id))
            .cloned()
            .collect();
        visibility_violations += forbidden_hits.len();
        returned_item_count += ranked_ids.len();
        if ranked_ids.is_empty() {
            empty_result_count += 1;
        }
        if query.slice == QuerySlice::NoMatch && !ranked_ids.is_empty() {
            no_match_false_positive_count += 1;
        }
        for item in &result.items {
            for reason in &item.reasons {
                *channel_hits.entry(reason.clone()).or_default() += 1;
            }
        }
        let query_metrics = if query.relevant.is_empty() {
            None
        } else {
            let value = metrics_at_5(&query.relevant, &ranked_ids)?;
            metrics.push(value.clone());
            slice_metrics
                .entry(query.slice)
                .or_default()
                .push(value.clone());
            if query.critical {
                critical_metrics.push(value.clone());
            }
            Some(value)
        };
        let slice = slices.entry(query.slice.as_str()).or_default();
        slice.query_count += 1;
        slice.positive_query_count += usize::from(query_metrics.is_some());
        slice.empty_result_count += usize::from(ranked_ids.is_empty());
        slice.no_match_false_positive_count +=
            usize::from(query.slice == QuerySlice::NoMatch && !ranked_ids.is_empty());
        query_reports.push(QueryReport {
            id: query.id.clone(),
            slice: query.slice.as_str(),
            critical: query.critical,
            ranked_ids,
            metrics: query_metrics,
            forbidden_hits,
        });
    }

    for (slice, values) in slice_metrics {
        let average = average_metrics(&values);
        let report = slices
            .get_mut(slice.as_str())
            .ok_or_else(|| format!("missing slice report for {}", slice.as_str()))?;
        report.recall_at_1 = average.recall_at_1;
        report.recall_at_5 = average.recall_at_5;
        report.reciprocal_rank_at_5 = average.reciprocal_rank_at_5;
        report.ndcg_at_5 = average.ndcg_at_5;
    }

    let canonical_after = canonical_counts(&store).await?;
    if canonical_before != canonical_after {
        return Err("search changed canonical table counts".to_string());
    }
    let aggregate = average_metrics(&metrics);
    let critical = average_metrics(&critical_metrics);
    let active_record_count = corpus
        .records
        .iter()
        .filter(|record| record.state == RecordState::Active)
        .count();
    let body = EvaluationBody {
        schema_version: 1,
        mode: mode.as_str(),
        corpus_version: "retrieval-corpus-v1",
        corpus_sha256: CORPUS_SHA256,
        active_record_count,
        non_searchable_record_count: corpus.records.len() - active_record_count,
        query_count: corpus.queries.len(),
        positive_query_count: metrics.len(),
        critical_query_count: critical_metrics.len(),
        aggregate_recall_at_1: aggregate.recall_at_1,
        aggregate_recall_at_5: aggregate.recall_at_5,
        aggregate_mrr_at_5: aggregate.reciprocal_rank_at_5,
        aggregate_ndcg_at_5: aggregate.ndcg_at_5,
        critical_recall_at_5: critical.recall_at_5,
        visibility_violations,
        no_match_false_positive_count,
        empty_result_count,
        returned_item_count,
        channel_hits,
        slices,
        canonical_counts_before_search: canonical_before,
        canonical_counts_after_search: canonical_after,
        latency: LatencyContract {
            mode: "excluded_from_deterministic_report",
            measured_in_wave: "W4",
        },
        queries: query_reports,
    };
    let canonical = serde_json::to_vec(&body).map_err(|error| error.to_string())?;
    Ok(EvaluationEnvelope {
        report_sha256: xuanling_memory::sha256_hex(&canonical),
        report: body,
    })
}

fn assert_after_thresholds(report: &EvaluationBody) {
    assert_eq!(report.mode, "after");
    assert_eq!(report.corpus_sha256, CORPUS_SHA256);
    assert_eq!(report.visibility_violations, 0);
    assert_eq!(report.no_match_false_positive_count, 0);
    assert_eq!(report.critical_recall_at_5, 1.0);
    assert!(report.aggregate_recall_at_5 >= 0.90);
    assert!(report.aggregate_mrr_at_5 >= 0.75);
    assert!(report.aggregate_ndcg_at_5 >= 0.80);
    assert!(
        report.aggregate_ndcg_at_5 >= 0.277_778,
        "after nDCG must not regress below the frozen baseline"
    );
    assert_eq!(
        report.canonical_counts_before_search,
        report.canonical_counts_after_search
    );
}

#[test]
fn evaluator_mode_labels_are_explicit() {
    assert_eq!(EvaluationMode::Baseline.as_str(), "baseline");
    assert_eq!(EvaluationMode::After.as_str(), "after");
}

#[tokio::test]
async fn disk_restart_preserves_search_matrix_and_canonical_facts() {
    let corpus = load_corpus(CORPUS_TEXT).expect("frozen corpus must load");
    assert_eq!(corpus.sha256, CORPUS_SHA256);
    let directory = tempfile::tempdir().expect("restart temp directory");
    let database = directory.path().join("retrieval-restart.db");

    let store = MemoryStore::open(&database, 5_000)
        .await
        .expect("create disk-backed retrieval store");
    seed_corpus(&store, &corpus)
        .await
        .expect("seed disk-backed retrieval corpus");
    let expected_counts = canonical_counts(&store).await.expect("canonical counts");
    let expected_canonical = canonical_digest(&store).await.expect("canonical digest");
    let expected_projection = projection_counts(&store).await.expect("projection counts");
    let expected_search = search_matrix(&store, &corpus)
        .await
        .expect("pre-restart search matrix");
    store.pool().close().await;

    for restart in 1..=3 {
        let reopened = MemoryStore::open(&database, 5_000)
            .await
            .unwrap_or_else(|error| panic!("restart {restart} could not reopen store: {error}"));
        assert_eq!(
            canonical_counts(&reopened)
                .await
                .expect("post-restart canonical counts"),
            expected_counts,
            "restart {restart} changed canonical table counts"
        );
        assert_eq!(
            canonical_digest(&reopened)
                .await
                .expect("post-restart canonical digest"),
            expected_canonical,
            "restart {restart} changed canonical facts"
        );
        assert_eq!(
            projection_counts(&reopened)
                .await
                .expect("post-restart projection counts"),
            expected_projection,
            "restart {restart} changed projection row counts"
        );
        assert_eq!(
            search_matrix(&reopened, &corpus)
                .await
                .expect("post-restart search matrix"),
            expected_search,
            "restart {restart} changed ranked ids, scores, reasons, visibility, or record facts"
        );
        reopened.pool().close().await;
    }
}

#[tokio::test]
async fn jsonl_round_trip_preserves_search_matrix_and_failed_import_writes_nothing() {
    let corpus = load_corpus(CORPUS_TEXT).expect("frozen corpus must load");
    assert_eq!(corpus.sha256, CORPUS_SHA256);
    let directory = tempfile::tempdir().expect("JSONL matrix temp directory");
    let source_database = directory.path().join("retrieval-source.db");
    let target_database = directory.path().join("retrieval-target.db");
    let rejected_database = directory.path().join("retrieval-rejected.db");
    let export_path = directory.path().join("retrieval.jsonl");
    let tampered_path = directory.path().join("retrieval-tampered.jsonl");

    let source = MemoryStore::open(&source_database, 5_000)
        .await
        .expect("create JSONL source store");
    seed_corpus(&source, &corpus)
        .await
        .expect("seed JSONL source corpus");
    let expected_counts = canonical_counts(&source).await.expect("source counts");
    let expected_canonical = canonical_digest(&source).await.expect("source digest");
    let expected_projection = projection_counts(&source).await.expect("source projection");
    let expected_search = search_matrix(&source, &corpus)
        .await
        .expect("source search matrix");
    jsonl::export(&source, &export_path)
        .await
        .expect("export canonical JSONL");
    source.pool().close().await;

    let target = MemoryStore::open(&target_database, 5_000)
        .await
        .expect("create JSONL target store");
    assert!(
        canonical_counts(&target)
            .await
            .expect("empty target counts")
            .values()
            .all(|count| *count == 0),
        "JSONL target must start canonically empty"
    );
    jsonl::import(&target, &export_path)
        .await
        .expect("import canonical JSONL");
    assert_eq!(
        canonical_counts(&target).await.expect("imported counts"),
        expected_counts,
        "JSONL import changed canonical row counts"
    );
    assert_eq!(
        canonical_digest(&target).await.expect("imported digest"),
        expected_canonical,
        "JSONL import changed canonical facts"
    );
    assert_eq!(
        projection_counts(&target)
            .await
            .expect("imported projection"),
        expected_projection,
        "JSONL import rebuilt a different active projection"
    );
    assert_eq!(
        search_matrix(&target, &corpus)
            .await
            .expect("imported search matrix"),
        expected_search,
        "JSONL import changed ranked ids, scores, reasons, visibility, or record facts"
    );
    target.pool().close().await;

    let mut tampered = std::fs::read_to_string(&export_path).expect("read canonical export");
    tampered = tampered.replacen("retrieval-corpus-seeder", "retrieval-corpus-tampered", 1);
    assert_ne!(
        tampered,
        std::fs::read_to_string(&export_path).expect("reread canonical export"),
        "tamper fixture must change one exported canonical fact"
    );
    std::fs::write(&tampered_path, tampered).expect("write tampered JSONL fixture");

    let rejected = MemoryStore::open(&rejected_database, 5_000)
        .await
        .expect("create rejected-import target");
    let error = jsonl::import(&rejected, &tampered_path)
        .await
        .expect_err("checksum mismatch must reject the import");
    assert_eq!(error.code, ToolErrorCode::IntegrityError);
    assert!(
        canonical_counts(&rejected)
            .await
            .expect("rejected target counts")
            .values()
            .all(|count| *count == 0),
        "failed JSONL import must not write canonical rows"
    );
    assert_eq!(
        projection_counts(&rejected)
            .await
            .expect("rejected target projection"),
        (0, 0),
        "failed JSONL import must not write projection rows"
    );
    rejected.pool().close().await;
}

#[tokio::test]
async fn projection_rebuild_restores_search_matrix_without_canonical_writes() {
    let corpus = load_corpus(CORPUS_TEXT).expect("frozen corpus must load");
    assert_eq!(corpus.sha256, CORPUS_SHA256);
    let directory = tempfile::tempdir().expect("rebuild matrix temp directory");
    let database = directory.path().join("retrieval-rebuild.db");
    let store = MemoryStore::open(&database, 5_000)
        .await
        .expect("create rebuild matrix store");
    seed_corpus(&store, &corpus)
        .await
        .expect("seed rebuild matrix corpus");

    let expected_counts = canonical_counts(&store).await.expect("canonical counts");
    let expected_canonical = canonical_digest(&store).await.expect("canonical digest");
    let expected_projection = projection_counts(&store).await.expect("projection counts");
    assert_eq!(
        expected_projection.0, expected_projection.1,
        "unicode61 and trigram projections must cover the same active heads"
    );
    let expected_search = search_matrix(&store, &corpus)
        .await
        .expect("pre-corruption search matrix");

    let mut corruption = store
        .pool()
        .begin()
        .await
        .expect("begin corruption fixture");
    sqlx::query("DELETE FROM memory_fts_v2_unicode")
        .execute(&mut *corruption)
        .await
        .expect("clear unicode61 projection");
    sqlx::query("DELETE FROM memory_fts_v2_trigram")
        .execute(&mut *corruption)
        .await
        .expect("clear trigram projection");
    corruption
        .commit()
        .await
        .expect("commit corruption fixture");
    assert_eq!(
        projection_counts(&store)
            .await
            .expect("corrupt projection counts"),
        (0, 0)
    );
    assert_ne!(
        search_matrix(&store, &corpus)
            .await
            .expect("corrupt search matrix"),
        expected_search,
        "cleared projections must cause a reproducible retrieval failure"
    );
    assert_eq!(
        canonical_digest(&store)
            .await
            .expect("post-corruption canonical digest"),
        expected_canonical,
        "projection corruption fixture must not mutate canonical facts"
    );

    let rebuilt = store
        .rebuild_projection()
        .await
        .expect("rebuild derived projection");
    assert_eq!(
        rebuilt,
        u64::try_from(expected_projection.0).expect("projection count must fit u64")
    );
    assert_eq!(
        projection_counts(&store)
            .await
            .expect("rebuilt projection counts"),
        expected_projection
    );
    assert_eq!(
        search_matrix(&store, &corpus)
            .await
            .expect("rebuilt search matrix"),
        expected_search,
        "rebuild must exactly restore ids, scores, reasons, visibility, and record facts"
    );
    assert_eq!(
        canonical_counts(&store)
            .await
            .expect("post-rebuild canonical counts"),
        expected_counts
    );
    assert_eq!(
        canonical_digest(&store)
            .await
            .expect("post-rebuild canonical digest"),
        expected_canonical,
        "rebuild must not mutate canonical facts"
    );
    store.pool().close().await;

    let reopened = MemoryStore::open(&database, 5_000)
        .await
        .expect("reopen rebuilt store");
    assert_eq!(
        search_matrix(&reopened, &corpus)
            .await
            .expect("restarted rebuilt search matrix"),
        expected_search,
        "rebuilt projection must remain exact after restart"
    );
    assert_eq!(
        canonical_digest(&reopened)
            .await
            .expect("restarted rebuilt canonical digest"),
        expected_canonical
    );
    reopened.pool().close().await;
}

fn w4_payload(content: impl Into<String>) -> MemoryPayload {
    MemoryPayload {
        kind: xuanling_memory::MemoryKind::Solution,
        title: None,
        content: content.into(),
        summary: None,
        tags: Vec::new(),
        applicability: xuanling_memory::MemoryApplicability::default(),
        pinned: false,
    }
}

async fn seed_w4_active_record(
    store: &MemoryStore,
    record_id: &str,
    namespace: &str,
    scope: &MemoryScope,
    content: &str,
) {
    store
        .candidate_create(&CandidateCreateRequest {
            proposal_id: record_id.to_string(),
            idempotency_key: format!("{record_id}-create-idempotency"),
            proposer_id: "w4-recovery-seeder".to_string(),
            namespace: namespace.to_string(),
            scope: scope.clone(),
            payload: w4_payload(content),
        })
        .await
        .expect("create W4 active-record proposal");
    store
        .review(&ReviewRequest {
            idempotency_key: format!("{record_id}-review-idempotency"),
            reviewer_id: "w4-recovery-reviewer".to_string(),
            namespace: namespace.to_string(),
            scope: scope.clone(),
            proposal_id: record_id.to_string(),
            expected_proposal_revision: 1,
            decision: ReviewDecision::Approve,
            comment: None,
        })
        .await
        .expect("approve W4 active-record proposal");
}

#[tokio::test]
async fn database_busy_is_typed_and_retry_preserves_canonical_and_projection() {
    let corpus = load_corpus(CORPUS_TEXT).expect("frozen corpus must load");
    let directory = tempfile::tempdir().expect("busy recovery temp directory");
    let database = directory.path().join("retrieval-busy.db");
    let store = MemoryStore::open(&database, 25)
        .await
        .expect("open busy recovery store");
    seed_corpus(&store, &corpus)
        .await
        .expect("seed busy recovery corpus");
    let expected_canonical = canonical_digest(&store).await.expect("canonical digest");
    let expected_projection = projection_digest(&store).await.expect("projection digest");

    let mut writer = store.pool().begin().await.expect("begin lock holder");
    sqlx::query(
        "UPDATE memory_record_heads SET updated_at = updated_at \
         WHERE record_id = (SELECT record_id FROM memory_record_heads ORDER BY record_id LIMIT 1)",
    )
    .execute(&mut *writer)
    .await
    .expect("acquire SQLite writer lock");

    let error = store
        .rebuild_projection()
        .await
        .expect_err("a competing writer must make rebuild fail within the configured timeout");
    assert_eq!(error.code, ToolErrorCode::DatabaseBusy);
    assert_eq!(error.operation, "memory.rebuild_index");
    assert_eq!(
        canonical_digest(&store)
            .await
            .expect("busy canonical digest"),
        expected_canonical,
        "database_busy must not mutate canonical facts"
    );
    assert_eq!(
        projection_digest(&store)
            .await
            .expect("busy projection digest"),
        expected_projection,
        "database_busy must leave the previous complete projection visible"
    );

    writer.rollback().await.expect("release SQLite writer lock");
    let rebuilt = store
        .rebuild_projection()
        .await
        .expect("retry rebuild after releasing writer lock");
    assert_eq!(
        rebuilt,
        u64::try_from(projection_counts(&store).await.unwrap().0).unwrap()
    );
    assert_eq!(canonical_digest(&store).await.unwrap(), expected_canonical);
    assert_eq!(
        projection_digest(&store).await.unwrap(),
        expected_projection
    );
}

#[tokio::test]
async fn rebuild_insert_failure_rolls_back_both_projections_and_retries_cleanly() {
    let corpus = load_corpus(CORPUS_TEXT).expect("frozen corpus must load");
    let directory = tempfile::tempdir().expect("rebuild rollback temp directory");
    let database = directory.path().join("retrieval-rollback.db");
    let store = MemoryStore::open(&database, 5_000)
        .await
        .expect("open rebuild rollback store");
    seed_corpus(&store, &corpus)
        .await
        .expect("seed rebuild rollback corpus");
    let expected_canonical = canonical_digest(&store).await.expect("canonical digest");
    let expected_projection = projection_digest(&store).await.expect("projection digest");
    let expected_search = search_matrix(&store, &corpus)
        .await
        .expect("pre-failure search matrix");

    sqlx::query(
        "CREATE TRIGGER w4_fail_rebuild BEFORE INSERT ON memory_fts_v2_trigram_content \
         BEGIN SELECT RAISE(ABORT, 'w4 forced rebuild failure'); END",
    )
    .execute(store.pool())
    .await
    .expect("install deterministic FTS insertion failure");
    let error = store
        .rebuild_projection()
        .await
        .expect_err("the injected second-projection insert must fail");
    assert_eq!(error.code, ToolErrorCode::IoError);
    assert_eq!(error.operation, "memory.rebuild_index");
    assert_eq!(canonical_digest(&store).await.unwrap(), expected_canonical);
    assert_eq!(
        projection_digest(&store).await.unwrap(),
        expected_projection,
        "a failed rebuild must roll back both FTS projections"
    );
    assert_eq!(
        search_matrix(&store, &corpus).await.unwrap(),
        expected_search,
        "a failed rebuild must retain the previous complete search surface"
    );

    sqlx::query("DROP TRIGGER w4_fail_rebuild")
        .execute(store.pool())
        .await
        .expect("remove deterministic FTS insertion failure");
    store
        .rebuild_projection()
        .await
        .expect("retry rebuild after removing the injected failure");
    assert_eq!(canonical_digest(&store).await.unwrap(), expected_canonical);
    assert_eq!(
        projection_digest(&store).await.unwrap(),
        expected_projection
    );
}

#[tokio::test]
async fn host_cancelled_searches_return_no_partial_result_and_restart_cleanly() {
    let corpus = load_corpus(CORPUS_TEXT).expect("frozen corpus must load");
    let directory = tempfile::tempdir().expect("search cancellation temp directory");
    let database = directory.path().join("retrieval-cancel.db");
    let store = MemoryStore::open(&database, 5_000)
        .await
        .expect("open search cancellation store");
    seed_corpus(&store, &corpus)
        .await
        .expect("seed search cancellation corpus");
    let expected_canonical = canonical_digest(&store).await.expect("canonical digest");
    let expected_projection = projection_digest(&store).await.expect("projection digest");
    let expected_search = search_matrix(&store, &corpus)
        .await
        .expect("pre-cancellation search matrix");
    let fixture = corpus.queries.first().expect("at least one frozen query");
    let request = SearchRequestV2 {
        namespace: fixture.namespace.clone(),
        scope: fixture.scope.clone(),
        scope_mode: fixture.scope_mode,
        query: fixture.query.clone(),
        applicability: fixture.applicability.clone(),
        candidate_limit: fixture.candidate_limit,
        limit: fixture.limit,
    };

    let cancelled_before_poll = store.search_v2(&request);
    drop(cancelled_before_poll);

    let mut leases = Vec::with_capacity(8);
    for _ in 0..8 {
        leases.push(
            store
                .pool()
                .acquire()
                .await
                .expect("reserve a pool connection"),
        );
    }
    let task_store = store.clone();
    let task_request = request.clone();
    let search = tokio::spawn(async move { task_store.search_v2(&task_request).await });
    tokio::task::yield_now().await;
    assert!(
        !search.is_finished(),
        "the search must be pending at the database boundary before cancellation"
    );
    search.abort();
    let cancelled = search
        .await
        .expect_err("aborted search must not return a result");
    assert!(cancelled.is_cancelled());
    drop(leases);

    assert_eq!(canonical_digest(&store).await.unwrap(), expected_canonical);
    assert_eq!(
        projection_digest(&store).await.unwrap(),
        expected_projection
    );
    store.pool().close().await;
    let reopened = MemoryStore::open(&database, 5_000)
        .await
        .expect("restart after cancelled searches");
    assert_eq!(
        canonical_digest(&reopened).await.unwrap(),
        expected_canonical
    );
    assert_eq!(
        projection_digest(&reopened).await.unwrap(),
        expected_projection
    );
    assert_eq!(
        search_matrix(&reopened, &corpus).await.unwrap(),
        expected_search
    );
}

const W4_CRASH_DB_ENV: &str = "XUANLING_W4_CRASH_REBUILD_DB";
const W4_CRASH_READY_ENV: &str = "XUANLING_W4_CRASH_REBUILD_READY";

#[tokio::test]
async fn rebuild_crash_subprocess_helper() {
    let Some(database) = std::env::var_os(W4_CRASH_DB_ENV) else {
        return;
    };
    let ready =
        std::env::var_os(W4_CRASH_READY_ENV).expect("crash helper requires a ready marker path");
    let store = MemoryStore::open(std::path::Path::new(&database), 5_000)
        .await
        .expect("crash helper opens the fixture database");

    let mut connections = Vec::with_capacity(8);
    for _ in 0..8 {
        let mut connection = store.pool().acquire().await.expect("acquire helper pool");
        sqlx::query("PRAGMA cache_size = 1")
            .execute(&mut *connection)
            .await
            .expect("set helper cache size");
        sqlx::query("PRAGMA cache_spill = ON")
            .execute(&mut *connection)
            .await
            .expect("enable helper cache spill");
        connections.push(connection);
    }
    drop(connections);
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .fetch_all(store.pool())
        .await
        .expect("truncate helper WAL before rebuild");
    std::fs::write(&ready, b"ready").expect("publish rebuild-ready marker");

    let result = store.rebuild_projection().await;
    panic!("crash helper rebuild completed before forced termination: {result:?}");
}

#[tokio::test]
async fn crash_during_uncommitted_rebuild_recovers_old_projection_after_restart() {
    let corpus = load_corpus(CORPUS_TEXT).expect("frozen corpus must load");
    let directory = tempfile::tempdir().expect("crash recovery temp directory");
    let database = directory.path().join("retrieval-crash.db");
    let ready = directory.path().join("rebuild.ready");
    let store = MemoryStore::open(&database, 5_000)
        .await
        .expect("open crash recovery store");
    seed_corpus(&store, &corpus)
        .await
        .expect("seed crash recovery corpus");
    let expected_canonical = canonical_digest(&store).await.expect("canonical digest");
    let expected_projection = projection_digest(&store).await.expect("projection digest");
    let expected_search = search_matrix(&store, &corpus)
        .await
        .expect("pre-crash search matrix");

    sqlx::query(
        "CREATE TRIGGER w4_delay_rebuild AFTER INSERT ON memory_fts_v2_trigram_content \
         BEGIN \
           SELECT sum(value) FROM ( \
             WITH RECURSIVE delay(value) AS ( \
               VALUES(1) UNION ALL SELECT value + 1 FROM delay WHERE value < 5000000 \
             ) SELECT value FROM delay \
           ); \
         END",
    )
    .execute(store.pool())
    .await
    .expect("install deterministic in-transaction delay");
    checkpoint_and_close(store)
        .await
        .expect("checkpoint crash fixture");

    let mut child = Command::new(std::env::current_exe().expect("current retrieval test binary"))
        .arg("--exact")
        .arg("rebuild_crash_subprocess_helper")
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env(W4_CRASH_DB_ENV, &database)
        .env(W4_CRASH_READY_ENV, &ready)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn rebuild crash helper");

    let ready_deadline = Instant::now() + Duration::from_secs(10);
    while !ready.exists() {
        if let Some(status) = child.try_wait().expect("poll rebuild crash helper") {
            panic!("rebuild crash helper exited before ready marker: {status}");
        }
        assert!(
            Instant::now() < ready_deadline,
            "rebuild crash helper did not publish its ready marker"
        );
        std::thread::sleep(Duration::from_millis(2));
    }

    let mut wal_os = database.as_os_str().to_owned();
    wal_os.push("-wal");
    let wal = std::path::PathBuf::from(wal_os);
    let wal_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if std::fs::metadata(&wal).map(|meta| meta.len()).unwrap_or(0) > 32 {
            break;
        }
        if let Some(status) = child.try_wait().expect("poll rebuild WAL writer") {
            panic!("rebuild completed before uncommitted WAL evidence: {status}");
        }
        assert!(
            Instant::now() < wal_deadline,
            "rebuild produced no observable uncommitted WAL frames"
        );
        std::thread::sleep(Duration::from_millis(2));
    }

    child.kill().expect("force-stop rebuild helper");
    let status = child.wait().expect("reap rebuild helper");
    assert!(!status.success(), "forced crash must be a nonzero terminal");

    let reopened = MemoryStore::open(&database, 5_000)
        .await
        .expect("restart after rebuild crash");
    assert_eq!(
        canonical_digest(&reopened).await.unwrap(),
        expected_canonical
    );
    assert_eq!(
        projection_digest(&reopened).await.unwrap(),
        expected_projection,
        "restart must expose the old complete projection, not partial rebuild rows"
    );
    assert_eq!(
        search_matrix(&reopened, &corpus).await.unwrap(),
        expected_search
    );
    sqlx::query("DROP TRIGGER w4_delay_rebuild")
        .execute(reopened.pool())
        .await
        .expect("remove in-transaction delay");
    reopened
        .rebuild_projection()
        .await
        .expect("explicit retry after crash");
    assert_eq!(
        canonical_digest(&reopened).await.unwrap(),
        expected_canonical
    );
    assert_eq!(
        projection_digest(&reopened).await.unwrap(),
        expected_projection
    );
}

async fn seed_race_distractors(
    store: &MemoryStore,
    scope: &MemoryScope,
    count: usize,
) -> Result<(), String> {
    let mut transaction = store
        .pool()
        .begin()
        .await
        .map_err(|error| format!("begin race fixture: {error}"))?;
    for index in 0..count {
        let record_id = format!("race-distractor-{index:05}");
        let content = format!("race_old_revision_token payload {index:05}");
        let content_sha256 = xuanling_memory::sha256_hex(content.as_bytes());
        let dedupe_key = format!("race\x1f{content}");
        sqlx::query(
            "INSERT INTO memory_record_versions \
             (record_id, revision, namespace, scope_type, scope_project_id, \
              scope_workspace_id, scope_key, kind, title, content, summary, \
              applicability_json, pinned, content_sha256, dedupe_key, proposal_id, created_at) \
             VALUES (?, 1, 'race', 'workspace', 'race-project', 'race-workspace', ?, \
                     'solution', NULL, ?, NULL, '{}', 0, ?, ?, 'race-fixture', \
                     '2026-08-16T00:00:00Z')",
        )
        .bind(&record_id)
        .bind(scope.scope_key())
        .bind(&content)
        .bind(&content_sha256)
        .bind(&dedupe_key)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("insert race version {record_id}: {error}"))?;
        sqlx::query(
            "INSERT INTO memory_record_heads \
             (record_id, namespace, scope_type, scope_project_id, scope_workspace_id, \
              scope_key, dedupe_key, current_revision, status, created_at, updated_at) \
             VALUES (?, 'race', 'workspace', 'race-project', 'race-workspace', ?, ?, 1, \
                     'active', '2026-08-16T00:00:00Z', '2026-08-16T00:00:00Z')",
        )
        .bind(&record_id)
        .bind(scope.scope_key())
        .bind(&dedupe_key)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("insert race head {record_id}: {error}"))?;
        for table in ["memory_fts_v2_unicode", "memory_fts_v2_trigram"] {
            let statement = format!(
                "INSERT INTO {table} (record_id, title, content, summary, tags) \
                 VALUES (?, NULL, ?, NULL, '')"
            );
            sqlx::query(sqlx::AssertSqlSafe(statement))
                .bind(&record_id)
                .bind(&content)
                .execute(&mut *transaction)
                .await
                .map_err(|error| format!("insert race projection {record_id}: {error}"))?;
        }
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("commit race fixture: {error}"))
}

#[tokio::test]
async fn concurrent_review_and_search_never_mix_candidate_and_head_revisions() {
    const DISTRACTORS: usize = 2_000;
    let directory = tempfile::tempdir().expect("review/search race temp directory");
    let database = directory.path().join("retrieval-race.db");
    let store = MemoryStore::open(&database, 5_000)
        .await
        .expect("open review/search race store");
    let scope = MemoryScope::Workspace {
        project_id: "race-project".to_string(),
        workspace_id: "race-workspace".to_string(),
    };
    let record_id = "zzzz-race-target";
    seed_w4_active_record(
        &store,
        record_id,
        "race",
        &scope,
        "race_old_revision_token payload target",
    )
    .await;
    seed_race_distractors(&store, &scope, DISTRACTORS)
        .await
        .expect("seed race distractors");
    let replace_proposal = "zzzz-race-target-replace";
    store
        .candidate_replace(&CandidateReplaceRequest {
            proposal_id: replace_proposal.to_string(),
            idempotency_key: "race-replace-idempotency".to_string(),
            proposer_id: "race-proposer".to_string(),
            namespace: "race".to_string(),
            scope: scope.clone(),
            target_record_id: record_id.to_string(),
            target_revision: 1,
            payload: w4_payload("race_new_revision_token payload target"),
        })
        .await
        .expect("create race replacement proposal");

    let request = SearchRequestV2 {
        namespace: "race".to_string(),
        scope: scope.clone(),
        scope_mode: xuanling_memory::ScopeMode::Exact,
        query: "race_old_revision_token".to_string(),
        applicability: None,
        candidate_limit: u64::try_from(DISTRACTORS + 1).unwrap(),
        limit: u64::try_from(DISTRACTORS + 1).unwrap(),
    };
    let mut leases = Vec::with_capacity(7);
    for _ in 0..7 {
        leases.push(store.pool().acquire().await.expect("reserve race pool"));
    }
    let search_store = store.clone();
    let search = tokio::spawn(async move { search_store.search_v2(&request).await });
    let acquisition_deadline = Instant::now() + Duration::from_secs(5);
    while store.pool().num_idle() != 0 {
        assert!(
            !search.is_finished(),
            "search completed before the production query acquired its only connection"
        );
        assert!(
            Instant::now() < acquisition_deadline,
            "search did not acquire the only available pool connection"
        );
        tokio::task::yield_now().await;
    }

    drop(leases.pop());
    store
        .review(&ReviewRequest {
            idempotency_key: "race-replace-review-idempotency".to_string(),
            reviewer_id: "race-reviewer".to_string(),
            namespace: "race".to_string(),
            scope: scope.clone(),
            proposal_id: replace_proposal.to_string(),
            expected_proposal_revision: 1,
            decision: ReviewDecision::Approve,
            comment: None,
        })
        .await
        .expect("approve race replacement while search is in flight");
    drop(leases);

    let result = search
        .await
        .expect("join in-flight race search")
        .expect("in-flight race search succeeds");
    if let Some(target) = result.items.iter().find(|item| item.record.id == record_id) {
        assert_eq!(
            target.record.revision, 1,
            "an old-token candidate must not be combined with the new canonical head"
        );
        assert_eq!(
            target.record.content,
            "race_old_revision_token payload target"
        );
    }

    let current = store
        .search_v2(&SearchRequestV2 {
            namespace: "race".to_string(),
            scope,
            scope_mode: xuanling_memory::ScopeMode::Exact,
            query: "race_new_revision_token".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .expect("search the committed replacement");
    let target = current
        .items
        .iter()
        .find(|item| item.record.id == record_id)
        .expect("new revision must be searchable after review");
    assert_eq!(target.record.revision, 2);
    assert_eq!(
        target.record.content,
        "race_new_revision_token payload target"
    );
}

#[tokio::test]
#[ignore = "measurement: fixed 10k visible + 20k invisible retrieval resource gate"]
async fn retrieval_performance_resource_measurement() {
    let directory = tempfile::tempdir().expect("performance temp directory");
    let database = directory.path().join("performance.db");
    let baseline_rebuild_database = directory.path().join("baseline-rebuild.db");
    let after_rebuild_database = directory.path().join("after-rebuild.db");
    let startup_database = directory.path().join("startup.db");
    let store = seed_performance_store(&database)
        .await
        .expect("seed fixed performance fixture");
    eprintln!("PERF_PHASE=fixture_seeded");
    assert_eq!(
        projection_counts(&store)
            .await
            .expect("performance projection counts"),
        (30_000, 30_000)
    );
    let canonical_before = canonical_digest(&store)
        .await
        .expect("performance canonical digest");
    let queries = performance_queries();
    let target_scope = MemoryScope::Workspace {
        project_id: "perf-project".to_string(),
        workspace_id: "visible".to_string(),
    };
    let target_scope_key = target_scope.scope_key();

    let baseline_query_rss = RssSampler::start();
    let baseline_latency = measure_baseline_latency(&store, &queries, &target_scope_key)
        .await
        .expect("measure frozen W0 baseline latency");
    let baseline_query_rss = baseline_query_rss.finish().expect("baseline query RSS");
    eprintln!("PERF_PHASE=baseline_queries_complete");

    let after_query_rss = RssSampler::start();
    let after_latency = measure_after_latency(&store, &queries, &target_scope)
        .await
        .expect("measure after latency");
    let after_query_rss = after_query_rss.finish().expect("after query RSS");
    eprintln!("PERF_PHASE=after_queries_complete");
    assert_eq!(
        canonical_digest(&store)
            .await
            .expect("post-query canonical digest"),
        canonical_before,
        "baseline and after queries must not write canonical facts"
    );
    checkpoint_and_close(store)
        .await
        .expect("close performance source database");

    for target in [
        &baseline_rebuild_database,
        &after_rebuild_database,
        &startup_database,
    ] {
        std::fs::copy(&database, target).unwrap_or_else(|error| {
            panic!("copy performance database to {}: {error}", target.display())
        });
    }

    let baseline_rebuild_store = MemoryStore::open(&baseline_rebuild_database, 5_000)
        .await
        .expect("open baseline rebuild database");
    let baseline_rebuild_rss = RssSampler::start();
    let baseline_rebuild_started = Instant::now();
    let baseline_rebuilt = frozen_baseline_rebuild(&baseline_rebuild_store)
        .await
        .expect("frozen baseline rebuild");
    let baseline_rebuild_us = u64::try_from(baseline_rebuild_started.elapsed().as_micros())
        .expect("baseline rebuild duration must fit u64")
        .max(1);
    let baseline_rebuild_rss = baseline_rebuild_rss.finish().expect("baseline rebuild RSS");
    assert_eq!(baseline_rebuilt, 30_000);
    eprintln!("PERF_PHASE=baseline_rebuild_complete");
    checkpoint_and_close(baseline_rebuild_store)
        .await
        .expect("close baseline rebuild database");

    let after_rebuild_store = MemoryStore::open(&after_rebuild_database, 5_000)
        .await
        .expect("open after rebuild database");
    let after_rebuild_rss = RssSampler::start();
    let after_rebuild_started = Instant::now();
    let after_rebuilt = after_rebuild_store
        .rebuild_projection()
        .await
        .expect("after rebuild");
    let after_rebuild_us = u64::try_from(after_rebuild_started.elapsed().as_micros())
        .expect("after rebuild duration must fit u64")
        .max(1);
    let after_rebuild_rss = after_rebuild_rss.finish().expect("after rebuild RSS");
    assert_eq!(after_rebuilt, 30_000);
    eprintln!("PERF_PHASE=after_rebuild_complete");
    checkpoint_and_close(after_rebuild_store)
        .await
        .expect("close after rebuild database");

    let startup_fixture = MemoryStore::open(&startup_database, 5_000)
        .await
        .expect("open startup fixture database");
    for table in ["memory_fts_v2_unicode", "memory_fts_v2_trigram"] {
        let statement = format!(
            "INSERT INTO {table} (record_id, title, content, summary, tags) \
             VALUES ('__startup_sentinel__', NULL, 'startup sentinel', NULL, '')"
        );
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .execute(startup_fixture.pool())
            .await
            .expect("insert startup projection sentinel");
    }
    checkpoint_and_close(startup_fixture)
        .await
        .expect("close startup fixture database");

    let startup_rss = RssSampler::start();
    let startup_started = Instant::now();
    let startup_store = MemoryStore::open(&startup_database, 5_000)
        .await
        .expect("measure disk startup");
    let startup_us = u64::try_from(startup_started.elapsed().as_micros())
        .expect("startup duration must fit u64")
        .max(1);
    let startup_rss = startup_rss.finish().expect("startup RSS");
    let startup_projection = projection_counts(&startup_store)
        .await
        .expect("startup projection counts");
    let sentinel: (i64, i64) = sqlx::query_as(
        "SELECT \
         (SELECT COUNT(*) FROM memory_fts_v2_unicode WHERE record_id = '__startup_sentinel__'), \
         (SELECT COUNT(*) FROM memory_fts_v2_trigram WHERE record_id = '__startup_sentinel__')",
    )
    .fetch_one(startup_store.pool())
    .await
    .expect("read startup projection sentinel");
    let startup_sentinel_preserved = sentinel == (1, 1);
    assert_eq!(startup_projection, (30_001, 30_001));
    assert!(
        startup_sentinel_preserved,
        "startup must not rebuild or rewrite the derived projection"
    );
    eprintln!("PERF_PHASE=startup_complete");
    checkpoint_and_close(startup_store)
        .await
        .expect("close startup measurement database");

    assert!(
        after_latency.p95_us <= baseline_latency.p95_us.saturating_mul(2),
        "after p95 {}us exceeds the 2x baseline gate {}us",
        after_latency.p95_us,
        baseline_latency.p95_us
    );
    assert!(
        after_rebuild_us <= baseline_rebuild_us.saturating_mul(2),
        "after rebuild {after_rebuild_us}us exceeds the 2x baseline gate {baseline_rebuild_us}us"
    );
    let baseline_peak_rss = baseline_query_rss.max(baseline_rebuild_rss);
    let after_peak_rss = after_query_rss.max(after_rebuild_rss).max(startup_rss);
    assert!(
        after_peak_rss <= baseline_peak_rss.saturating_add(128 * 1024 * 1024),
        "after sampled peak RSS {after_peak_rss} exceeds baseline {baseline_peak_rss} + 128 MiB"
    );

    let report = PerformanceReport {
        schema_version: 1,
        fixture_sha256: PERF_FIXTURE_SHA256,
        query_sha256: PERF_QUERY_SHA256,
        visible_active_records: PERF_VISIBLE_RECORDS,
        invisible_active_records: PERF_INVISIBLE_RECORDS,
        query_count: PERF_QUERY_COUNT,
        query_rounds: PERF_QUERY_ROUNDS,
        baseline_source_sha256: "0beda501f7d76a8ba0583e601da8b23dd4d1a2161f66262789dcfe26d963bb1d",
        baseline_latency,
        after_latency,
        baseline_rebuild_us,
        after_rebuild_us,
        baseline_peak_rss_sample_bytes: baseline_peak_rss,
        after_peak_rss_sample_bytes: after_peak_rss,
        startup_us,
        startup_projection_rows: startup_projection.0,
        startup_sentinel_preserved,
    };
    println!(
        "PERFORMANCE_REPORT={}",
        serde_json::to_string(&report).expect("serialize performance report")
    );
}

#[tokio::test]
async fn after_report_meets_thresholds_and_is_byte_identical_across_three_runs() {
    let first = evaluate_once(EvaluationMode::After)
        .await
        .expect("first after evaluation");
    let second = evaluate_once(EvaluationMode::After)
        .await
        .expect("second after evaluation");
    let third = evaluate_once(EvaluationMode::After)
        .await
        .expect("third after evaluation");
    assert_after_thresholds(&first.report);
    let first_json = serde_json::to_string(&first).expect("serialize first after report");
    let second_json = serde_json::to_string(&second).expect("serialize second after report");
    let third_json = serde_json::to_string(&third).expect("serialize third after report");
    assert_eq!(
        first_json, second_json,
        "after report must be byte-identical"
    );
    assert_eq!(
        second_json, third_json,
        "after report must be byte-identical"
    );
    println!("{first_json}");
}
