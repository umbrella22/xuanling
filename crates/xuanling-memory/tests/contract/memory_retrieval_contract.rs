//! Contract fixtures and red tests for RFC 0003 retrieval quality.
//!
//! W1 deliberately keeps this module outside production source. The corpus is
//! synthetic, versioned, and validated before any search behavior is changed.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use xuanling_memory::proposal::{
    CandidateCreateRequest, MemoryPayload, ReviewDecision, ReviewRequest, ScopeMode,
    SearchRequestV2,
};
use xuanling_memory::scope::MemoryScope;
use xuanling_memory::{MemoryApplicability, MemoryKind, MemoryStore, ToolErrorCode};

pub(crate) const CORPUS_TEXT: &str = include_str!("../fixtures/retrieval-corpus-v1.jsonl");
pub(crate) const CORPUS_SHA256: &str =
    "70b15f5ef901a29fa8a66a0c3d2b2705d6c1f860f91bd2dce153ef9c8338968d";

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CorpusMeta {
    version: String,
    active_records: usize,
    non_searchable_records: usize,
    queries: usize,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecordState {
    Active,
    Pending,
    Rejected,
    Archived,
    Historical,
}

impl RecordState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Pending => "pending",
            Self::Rejected => "rejected",
            Self::Archived => "archived",
            Self::Historical => "historical",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
// This module is compiled by two integration-test targets. Replacement fields
// are consumed by retrieval_eval but intentionally not by the red-test target.
#[allow(dead_code)]
pub(crate) struct ReplacementFixture {
    #[serde(default)]
    pub(crate) title: Option<String>,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) applicability: MemoryApplicability,
    #[serde(default)]
    pub(crate) pinned: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
// Full payload fields are consumed by retrieval_eval's lifecycle seeder.
#[allow(dead_code)]
pub(crate) struct RecordFixture {
    pub(crate) id: String,
    pub(crate) state: RecordState,
    pub(crate) namespace: String,
    pub(crate) scope: MemoryScope,
    pub(crate) kind: MemoryKind,
    #[serde(default)]
    pub(crate) title: Option<String>,
    pub(crate) content: String,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) applicability: MemoryApplicability,
    #[serde(default)]
    pub(crate) pinned: bool,
    #[serde(default)]
    pub(crate) replacement: Option<ReplacementFixture>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub(crate) enum QuerySlice {
    EnglishMultiTerm,
    CjkMixed,
    CodeSymbol,
    ScopeApplicability,
    TitleTag,
    NoMatch,
}

impl QuerySlice {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::EnglishMultiTerm => "english_multi_term",
            Self::CjkMixed => "cjk_mixed",
            Self::CodeSymbol => "code_symbol",
            Self::ScopeApplicability => "scope_applicability",
            Self::TitleTag => "title_tag",
            Self::NoMatch => "no_match",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
// Search-only fields are consumed by retrieval_eval's query runner.
#[allow(dead_code)]
pub(crate) struct QueryFixture {
    pub(crate) id: String,
    pub(crate) slice: QuerySlice,
    pub(crate) namespace: String,
    pub(crate) scope: MemoryScope,
    pub(crate) scope_mode: ScopeMode,
    pub(crate) query: String,
    #[serde(default)]
    pub(crate) applicability: Option<MemoryApplicability>,
    pub(crate) candidate_limit: u64,
    pub(crate) limit: u64,
    pub(crate) relevant: BTreeMap<String, u8>,
    #[serde(default)]
    pub(crate) forbidden_ids: Vec<String>,
    pub(crate) critical: bool,
}

#[derive(Clone, Debug)]
pub(crate) struct RetrievalCorpus {
    pub(crate) records: Vec<RecordFixture>,
    pub(crate) queries: Vec<QueryFixture>,
    pub(crate) sha256: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct QueryMetrics {
    pub(crate) recall_at_1: f64,
    pub(crate) recall_at_5: f64,
    pub(crate) reciprocal_rank_at_5: f64,
    pub(crate) ndcg_at_5: f64,
}

pub(crate) fn metrics_at_5(
    relevant: &BTreeMap<String, u8>,
    ranked_ids: &[String],
) -> Result<QueryMetrics, String> {
    if relevant.is_empty() {
        return Err("positive-query metrics require at least one relevant id".to_string());
    }
    if relevant.values().any(|grade| !(1..=3).contains(grade)) {
        return Err("relevance grades must be in 1..=3".to_string());
    }
    let unique_ranked: BTreeSet<&str> = ranked_ids.iter().map(String::as_str).collect();
    if unique_ranked.len() != ranked_ids.len() {
        return Err("ranked ids must be unique".to_string());
    }

    let recall = |k: usize| {
        ranked_ids
            .iter()
            .take(k)
            .filter(|record_id| relevant.contains_key(record_id.as_str()))
            .count() as f64
            / relevant.len() as f64
    };
    let reciprocal_rank_at_5 = ranked_ids
        .iter()
        .take(5)
        .position(|record_id| relevant.contains_key(record_id.as_str()))
        .map(|rank| 1.0 / (rank + 1) as f64)
        .unwrap_or(0.0);
    let gain = |grade: u8| (2_u64.pow(u32::from(grade)) - 1) as f64;
    let dcg_at_5 = ranked_ids
        .iter()
        .take(5)
        .enumerate()
        .map(|(rank, record_id)| {
            let grade = relevant.get(record_id).copied().unwrap_or_default();
            gain(grade) / ((rank + 2) as f64).log2()
        })
        .sum::<f64>();
    let mut ideal_grades: Vec<u8> = relevant.values().copied().collect();
    ideal_grades.sort_unstable_by(|a, b| b.cmp(a));
    let ideal_dcg_at_5 = ideal_grades
        .iter()
        .take(5)
        .enumerate()
        .map(|(rank, grade)| gain(*grade) / ((rank + 2) as f64).log2())
        .sum::<f64>();
    if !dcg_at_5.is_finite() || !ideal_dcg_at_5.is_finite() || ideal_dcg_at_5 <= 0.0 {
        return Err("metric arithmetic produced a non-finite or empty ideal DCG".to_string());
    }

    let ndcg_at_5 = dcg_at_5 / ideal_dcg_at_5;
    Ok(QueryMetrics {
        recall_at_1: recall(1),
        recall_at_5: recall(5),
        reciprocal_rank_at_5,
        ndcg_at_5: if ndcg_at_5 == 0.0 { 0.0 } else { ndcg_at_5 },
    })
}

pub(crate) fn load_corpus(input: &str) -> Result<RetrievalCorpus, String> {
    let mut meta = None;
    let mut records: Vec<RecordFixture> = Vec::new();
    let mut queries: Vec<QueryFixture> = Vec::new();

    for (index, raw_line) in input.lines().enumerate() {
        let line_number = index + 1;
        if raw_line.trim().is_empty() {
            return Err(format!(
                "line {line_number}: blank JSONL rows are forbidden"
            ));
        }
        let value: serde_json::Value = serde_json::from_str(raw_line)
            .map_err(|error| format!("line {line_number}: invalid JSON: {error}"))?;
        let mut object = value
            .as_object()
            .cloned()
            .ok_or_else(|| format!("line {line_number}: row must be a JSON object"))?;
        let row_type = object
            .remove("type")
            .and_then(|value| value.as_str().map(str::to_owned))
            .ok_or_else(|| format!("line {line_number}: row requires string type"))?;
        let payload = serde_json::Value::Object(object);
        match row_type.as_str() {
            "meta" => {
                if line_number != 1 || meta.is_some() {
                    return Err(format!(
                        "line {line_number}: exactly one meta row must be first"
                    ));
                }
                meta = Some(
                    serde_json::from_value(payload)
                        .map_err(|error| format!("line {line_number}: invalid meta: {error}"))?,
                );
            }
            "record" => records.push(
                serde_json::from_value(payload)
                    .map_err(|error| format!("line {line_number}: invalid record: {error}"))?,
            ),
            "query" => queries.push(
                serde_json::from_value(payload)
                    .map_err(|error| format!("line {line_number}: invalid query: {error}"))?,
            ),
            other => return Err(format!("line {line_number}: unknown row type {other:?}")),
        }
    }

    let meta = meta.ok_or_else(|| "missing meta row".to_string())?;
    validate_corpus(&meta, &records, &queries)?;
    Ok(RetrievalCorpus {
        records,
        queries,
        sha256: xuanling_memory::sha256_hex(input.as_bytes()),
    })
}

fn validate_corpus(
    meta: &CorpusMeta,
    records: &[RecordFixture],
    queries: &[QueryFixture],
) -> Result<(), String> {
    if meta.version != "retrieval-corpus-v1" {
        return Err(format!("unsupported corpus version {:?}", meta.version));
    }

    let mut record_ids = BTreeSet::new();
    let mut state_counts: BTreeMap<&str, usize> = BTreeMap::new();
    let mut namespaces = BTreeSet::new();
    let mut projects = BTreeSet::new();
    let mut workspaces = BTreeSet::new();
    for record in records {
        if record.id.trim().is_empty()
            || record.namespace.trim().is_empty()
            || record.content.trim().is_empty()
        {
            return Err("record id, namespace, and content must be non-empty".to_string());
        }
        if !record_ids.insert(record.id.clone()) {
            return Err(format!("duplicate record id {:?}", record.id));
        }
        *state_counts.entry(record.state.as_str()).or_default() += 1;
        namespaces.insert(record.namespace.clone());
        match &record.scope {
            MemoryScope::Global => {}
            MemoryScope::Project { project_id } => {
                projects.insert(project_id.clone());
            }
            MemoryScope::Workspace {
                project_id,
                workspace_id,
            } => {
                projects.insert(project_id.clone());
                workspaces.insert(format!("{project_id}/{workspace_id}"));
            }
        }
        match (record.state, record.replacement.is_some()) {
            (RecordState::Historical, false) => {
                return Err(format!(
                    "historical record {:?} requires replacement payload",
                    record.id
                ));
            }
            (RecordState::Historical, true) | (_, false) => {}
            (_, true) => {
                return Err(format!(
                    "non-historical record {:?} must not have replacement payload",
                    record.id
                ));
            }
        }
    }

    let active_records = state_counts.get("active").copied().unwrap_or_default();
    let non_searchable_records = records.len().saturating_sub(active_records);
    if (active_records, non_searchable_records, queries.len())
        != (
            meta.active_records,
            meta.non_searchable_records,
            meta.queries,
        )
    {
        return Err(format!(
            "meta counts mismatch: observed active={active_records}, non_searchable={non_searchable_records}, queries={}",
            queries.len()
        ));
    }
    if (active_records, non_searchable_records, queries.len()) != (48, 12, 40) {
        return Err(
            "retrieval-corpus-v1 requires exactly 48 active, 12 non-searchable, and 40 query rows"
                .to_string(),
        );
    }
    for state in ["pending", "rejected", "archived", "historical"] {
        if state_counts.get(state).copied() != Some(3) {
            return Err(format!("expected exactly 3 {state} records"));
        }
    }
    if namespaces.len() < 2 || projects.len() < 3 || workspaces.len() < 4 {
        return Err(format!(
            "scope diversity too small: namespaces={}, projects={}, workspaces={}",
            namespaces.len(),
            projects.len(),
            workspaces.len()
        ));
    }

    let active_ids: BTreeSet<&str> = records
        .iter()
        .filter(|record| record.state == RecordState::Active)
        .map(|record| record.id.as_str())
        .collect();
    let mut query_ids = BTreeSet::new();
    let mut query_inputs = BTreeSet::new();
    let mut slice_counts: BTreeMap<QuerySlice, usize> = BTreeMap::new();
    for query in queries {
        if query.id.trim().is_empty()
            || query.namespace.trim().is_empty()
            || query.query.trim().is_empty()
        {
            return Err("query id, namespace, and text must be non-empty".to_string());
        }
        if !query_ids.insert(query.id.clone()) {
            return Err(format!("duplicate query id {:?}", query.id));
        }
        let query_key = format!(
            "{}\u{1f}{}\u{1f}{}",
            query.namespace,
            query.scope.scope_key(),
            query.query
        );
        if !query_inputs.insert(query_key) {
            return Err(format!("duplicate query input for {:?}", query.id));
        }
        if query.limit == 0 || query.candidate_limit == 0 || query.candidate_limit < query.limit {
            return Err(format!("invalid limits for query {:?}", query.id));
        }
        *slice_counts.entry(query.slice).or_default() += 1;
        if query.slice == QuerySlice::NoMatch && !query.relevant.is_empty() {
            return Err(format!("no_match query {:?} has relevant ids", query.id));
        }
        if query.slice != QuerySlice::NoMatch && query.relevant.is_empty() {
            return Err(format!("positive query {:?} has no relevant ids", query.id));
        }
        let forbidden: BTreeSet<&str> = query.forbidden_ids.iter().map(String::as_str).collect();
        if forbidden.len() != query.forbidden_ids.len() {
            return Err(format!("query {:?} repeats forbidden ids", query.id));
        }
        for (record_id, grade) in &query.relevant {
            if !active_ids.contains(record_id.as_str()) {
                return Err(format!(
                    "query {:?} references non-active or missing relevant record {:?}",
                    query.id, record_id
                ));
            }
            if !(1..=3).contains(grade) {
                return Err(format!(
                    "query {:?} has invalid relevance grade {grade}",
                    query.id
                ));
            }
            if forbidden.contains(record_id.as_str()) {
                return Err(format!(
                    "query {:?} marks {:?} both relevant and forbidden",
                    query.id, record_id
                ));
            }
        }
        for record_id in &query.forbidden_ids {
            if !record_ids.contains(record_id) {
                return Err(format!(
                    "query {:?} references missing forbidden record {:?}",
                    query.id, record_id
                ));
            }
        }
    }
    let expected_slices = [
        (QuerySlice::EnglishMultiTerm, 8),
        (QuerySlice::CjkMixed, 8),
        (QuerySlice::CodeSymbol, 8),
        (QuerySlice::ScopeApplicability, 8),
        (QuerySlice::TitleTag, 4),
        (QuerySlice::NoMatch, 4),
    ];
    for (slice, expected) in expected_slices {
        if slice_counts.get(&slice).copied() != Some(expected) {
            return Err(format!(
                "slice {} expected {expected} queries",
                slice.as_str()
            ));
        }
    }

    for forbidden_fragment in ["sk-", "Bearer ", "DEEPSEEK_API_KEY="] {
        if CORPUS_TEXT.contains(forbidden_fragment) {
            return Err(format!(
                "corpus contains credential-shaped fragment {forbidden_fragment:?}"
            ));
        }
    }
    Ok(())
}

#[test]
fn frozen_corpus_has_expected_shape_and_digest() {
    let corpus = load_corpus(CORPUS_TEXT).expect("frozen corpus must validate");
    assert_eq!(corpus.records.len(), 60);
    assert_eq!(corpus.queries.len(), 40);
    assert_eq!(corpus.sha256, CORPUS_SHA256);
}

#[test]
fn corpus_loader_rejects_invalid_references() {
    let missing = CORPUS_TEXT.replacen("\"r-en-01\":3", "\"missing-record\":3", 1);
    let error = load_corpus(&missing).unwrap_err();
    assert!(
        error.contains("missing-record"),
        "unexpected error: {error}"
    );

    let duplicate = CORPUS_TEXT.replacen("\"id\":\"r-en-02\"", "\"id\":\"r-en-01\"", 1);
    let error = load_corpus(&duplicate).unwrap_err();
    assert!(
        error.contains("duplicate record id"),
        "unexpected error: {error}"
    );
}

#[test]
fn corpus_loader_rejects_count_and_grade_drift() {
    let wrong_count = CORPUS_TEXT.replacen("\"active_records\":48", "\"active_records\":47", 1);
    let error = load_corpus(&wrong_count).unwrap_err();
    assert!(
        error.contains("meta counts mismatch"),
        "unexpected error: {error}"
    );

    let wrong_grade = CORPUS_TEXT.replacen("\"r-en-01\":3", "\"r-en-01\":4", 1);
    let error = load_corpus(&wrong_grade).unwrap_err();
    assert!(
        error.contains("invalid relevance grade"),
        "unexpected error: {error}"
    );
}

#[test]
fn metrics_match_hand_calculated_fixture() {
    let relevant = BTreeMap::from([("a".to_string(), 3), ("b".to_string(), 2)]);
    let ranked = ["x", "b", "a"].map(str::to_string);
    let metrics = metrics_at_5(&relevant, &ranked).expect("valid metric fixture");
    assert_eq!(metrics.recall_at_1, 0.0);
    assert_eq!(metrics.recall_at_5, 1.0);
    assert_eq!(metrics.reciprocal_rank_at_5, 0.5);
    assert!((metrics.ndcg_at_5 - 0.606_422_698_504_514).abs() < 1e-12);
}

#[test]
fn metrics_fail_closed_on_invalid_labels_or_rankings() {
    let ranked = ["a".to_string()];
    assert!(metrics_at_5(&BTreeMap::new(), &ranked).is_err());

    let invalid_grade = BTreeMap::from([("a".to_string(), 4)]);
    assert!(metrics_at_5(&invalid_grade, &ranked).is_err());

    let relevant = BTreeMap::from([("a".to_string(), 3)]);
    let duplicate = ["a".to_string(), "a".to_string()];
    assert!(metrics_at_5(&relevant, &duplicate).is_err());
}

#[tokio::test]
async fn bundled_sqlite_supports_visibility_query_primitives() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let record_json = r#"{"operating_systems":["macos"]}"#;
    let query_json = r#"{"operating_systems":["macos","linux"]}"#;
    let row: (i64, i64, i64) = sqlx::query_as(
        "SELECT json_valid(?), \
         COALESCE(json_array_length(json_extract(?, '$.operating_systems')), 0), \
         EXISTS(SELECT 1 \
                FROM json_each(?, '$.operating_systems') record_value \
                JOIN json_each(?, '$.operating_systems') query_value \
                  ON query_value.value = record_value.value)",
    )
    .bind(record_json)
    .bind(record_json)
    .bind(record_json)
    .bind(query_json)
    .fetch_one(store.pool())
    .await
    .expect("bundled SQLite JSON functions must execute");
    assert_eq!(row, (1, 1, 1));

    let rows: Vec<(i64,)> = sqlx::query_as(
        "WITH values_in_scope(value, distance) AS (VALUES ('x', 2), ('x', 0), ('y', 1)), \
         ranked AS (SELECT ROW_NUMBER() OVER (PARTITION BY value ORDER BY distance) AS ordinal \
                    FROM values_in_scope) \
         SELECT ordinal FROM ranked ORDER BY ordinal",
    )
    .fetch_all(store.pool())
    .await
    .expect("bundled SQLite window functions must execute");
    assert_eq!(rows, vec![(1,), (1,), (2,)]);
}

async fn approve_test_record(
    store: &MemoryStore,
    id: &str,
    namespace: &str,
    scope: &MemoryScope,
    title: &str,
    content: &str,
) {
    approve_test_record_with_applicability(
        store,
        id,
        namespace,
        scope,
        title,
        content,
        MemoryApplicability::default(),
    )
    .await;
}

async fn approve_test_record_with_applicability(
    store: &MemoryStore,
    id: &str,
    namespace: &str,
    scope: &MemoryScope,
    title: &str,
    content: &str,
    applicability: MemoryApplicability,
) {
    store
        .candidate_create(&CandidateCreateRequest {
            proposal_id: id.to_string(),
            idempotency_key: format!("retrieval-red-create-{id}"),
            proposer_id: "retrieval-red-seeder".to_string(),
            namespace: namespace.to_string(),
            scope: scope.clone(),
            payload: MemoryPayload {
                kind: MemoryKind::Procedure,
                title: Some(title.to_string()),
                content: content.to_string(),
                summary: None,
                tags: vec!["retrieval-red".to_string()],
                applicability,
                pinned: false,
            },
        })
        .await
        .expect("red fixture candidate must be valid");
    store
        .review(&ReviewRequest {
            idempotency_key: format!("retrieval-red-review-{id}"),
            reviewer_id: "retrieval-red-reviewer".to_string(),
            namespace: namespace.to_string(),
            scope: scope.clone(),
            proposal_id: id.to_string(),
            expected_proposal_revision: 1,
            decision: ReviewDecision::Approve,
            comment: None,
        })
        .await
        .expect("red fixture review must apply");
}

async fn canonical_table_counts(store: &MemoryStore) -> (i64, i64, i64, i64, i64, i64) {
    sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM memory_proposals), \
                (SELECT COUNT(*) FROM memory_reviews), \
                (SELECT COUNT(*) FROM memory_record_heads), \
                (SELECT COUNT(*) FROM memory_record_versions), \
                (SELECT COUNT(*) FROM memory_record_tags), \
                (SELECT COUNT(*) FROM memory_feedback_events)",
    )
    .fetch_one(store.pool())
    .await
    .expect("canonical table counts must be readable")
}

#[tokio::test]
async fn search_treats_operator_text_literally_and_never_writes_canonical_tables() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let scope = MemoryScope::Global;
    approve_test_record(
        &store,
        "literal-operator-target",
        "literal-input",
        &scope,
        "AND NEAR operator text",
        "Quoted token \"quoted\" plus gamma* and ^delta remain searchable text.",
    )
    .await;
    let before = canonical_table_counts(&store).await;

    for query in ["AND", "NEAR", "\"quoted\"", "gamma*", "^delta"] {
        let result = store
            .search_v2(&SearchRequestV2 {
                namespace: "literal-input".to_string(),
                scope: scope.clone(),
                scope_mode: ScopeMode::Exact,
                query: query.to_string(),
                applicability: None,
                candidate_limit: 10,
                limit: 5,
            })
            .await
            .unwrap_or_else(|error| panic!("literal query {query:?} failed: {error}"));
        assert!(
            result
                .items
                .iter()
                .any(|item| item.record.id == "literal-operator-target"),
            "literal query {query:?} must recall the seeded text"
        );
    }

    for query in ["***", "\"\" -- /", " \t\n "] {
        let error = store
            .search_v2(&SearchRequestV2 {
                namespace: "literal-input".to_string(),
                scope: scope.clone(),
                scope_mode: ScopeMode::Exact,
                query: query.to_string(),
                applicability: None,
                candidate_limit: 10,
                limit: 5,
            })
            .await
            .expect_err("punctuation-only queries must fail closed");
        assert_eq!(error.code, ToolErrorCode::InvalidInput);
    }

    let limit_error = store
        .search_v2(&SearchRequestV2 {
            namespace: "literal-input".to_string(),
            scope,
            scope_mode: ScopeMode::Exact,
            query: "AND".to_string(),
            applicability: None,
            candidate_limit: u64::MAX,
            limit: 5,
        })
        .await
        .expect_err("limits outside SQLite's signed range must fail closed");
    assert_eq!(limit_error.code, ToolErrorCode::InvalidInput);

    assert_eq!(
        canonical_table_counts(&store).await,
        before,
        "successful and rejected searches must not mutate canonical tables"
    );
}

retrieval_behavior_test! {
#[tokio::test]
async fn multi_term_reordered_query_recalls_target() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let scope = MemoryScope::Global;
    approve_test_record(
        &store,
        "multi-term-target",
        "retrieval-red",
        &scope,
        "Verify filesystem evaluation results independently",
        "Use a SQLite oracle to verify DSH filesystem results independently instead of relying on model self report.",
    )
    .await;

    let result = store
        .search_v2(&SearchRequestV2 {
            namespace: "retrieval-red".to_string(),
            scope,
            scope_mode: ScopeMode::Exact,
            query: "filesystem results independent verification".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .expect("search itself must remain valid");
    let ids: Vec<&str> = result
        .items
        .iter()
        .map(|item| item.record.id.as_str())
        .collect();
    assert!(
        ids.contains(&"multi-term-target"),
        "reordered multi-term query must recall target in top 5; got {ids:?}"
    );
}
}

retrieval_behavior_test! {
#[tokio::test]
async fn in_scope_hit_survives_invisible_crowding() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let visible_scope = MemoryScope::Project {
        project_id: "visible-project".to_string(),
    };
    let sibling_scope = MemoryScope::Project {
        project_id: "sibling-project".to_string(),
    };
    let diluted_target = format!("{} candidate budget phrase", "unrelated ".repeat(80));
    approve_test_record(
        &store,
        "visible-crowding-target",
        "visible-namespace",
        &visible_scope,
        "Visible retrieval target",
        &diluted_target,
    )
    .await;

    for index in 0..4 {
        let (namespace, scope) = if index < 2 {
            ("other-namespace", &visible_scope)
        } else {
            ("visible-namespace", &sibling_scope)
        };
        approve_test_record(
            &store,
            &format!("invisible-crowding-{index}"),
            namespace,
            scope,
            "candidate budget phrase",
            &format!("candidate budget phrase invisible {index}"),
        )
        .await;
    }

    let result = store
        .search_v2(&SearchRequestV2 {
            namespace: "visible-namespace".to_string(),
            scope: visible_scope,
            scope_mode: ScopeMode::Exact,
            query: "candidate budget phrase".to_string(),
            applicability: None,
            candidate_limit: 2,
            limit: 2,
        })
        .await
        .expect("crowding search must remain valid");
    let ids: Vec<&str> = result
        .items
        .iter()
        .map(|item| item.record.id.as_str())
        .collect();
    assert!(
        ids.contains(&"visible-crowding-target"),
        "other namespace/sibling scope candidates must not consume the visible budget; got {ids:?}"
    );
}
}

retrieval_behavior_test! {
#[tokio::test]
async fn applicable_hit_survives_mismatch_crowding() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let scope = MemoryScope::Project {
        project_id: "applicability-project".to_string(),
    };
    let macos = MemoryApplicability {
        operating_systems: vec!["macos".to_string()],
        architectures: vec!["arm64".to_string()],
        toolchains: vec!["rust".to_string()],
        project_markers: vec!["Cargo.toml".to_string()],
    };
    let windows = MemoryApplicability {
        operating_systems: vec!["windows".to_string()],
        architectures: vec!["x86_64".to_string()],
        toolchains: vec!["powershell".to_string()],
        project_markers: vec!["Cargo.toml".to_string()],
    };
    let diluted_target = format!("{} platform signing toolchain", "unrelated ".repeat(80));
    approve_test_record_with_applicability(
        &store,
        "applicable-crowding-target",
        "applicability-namespace",
        &scope,
        "Applicable retrieval target",
        &diluted_target,
        macos.clone(),
    )
    .await;
    for index in 0..4 {
        approve_test_record_with_applicability(
            &store,
            &format!("mismatch-crowding-{index}"),
            "applicability-namespace",
            &scope,
            "platform signing toolchain",
            &format!("platform signing toolchain mismatch {index}"),
            windows.clone(),
        )
        .await;
    }

    let result = store
        .search_v2(&SearchRequestV2 {
            namespace: "applicability-namespace".to_string(),
            scope,
            scope_mode: ScopeMode::Exact,
            query: "platform signing toolchain".to_string(),
            applicability: Some(macos),
            candidate_limit: 2,
            limit: 2,
        })
        .await
        .expect("applicability crowding search must remain valid");
    let ids: Vec<&str> = result
        .items
        .iter()
        .map(|item| item.record.id.as_str())
        .collect();
    assert!(
        ids.contains(&"applicable-crowding-target"),
        "applicability mismatches must not consume the visible budget; got {ids:?}"
    );
}
}

retrieval_behavior_test! {
#[tokio::test]
async fn nearest_scope_duplicate_does_not_consume_candidate_budget() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let global = MemoryScope::Global;
    let project = MemoryScope::Project {
        project_id: "dedupe-project".to_string(),
    };
    let workspace = MemoryScope::Workspace {
        project_id: "dedupe-project".to_string(),
        workspace_id: "dedupe-workspace".to_string(),
    };
    let duplicate_content = "duplicate budget phrase exact content";
    for (id, scope) in [
        ("dedupe-global", &global),
        ("dedupe-project", &project),
        ("dedupe-workspace", &workspace),
    ] {
        approve_test_record(
            &store,
            id,
            "dedupe-red",
            scope,
            "duplicate budget phrase",
            duplicate_content,
        )
        .await;
    }
    approve_test_record(
        &store,
        "dedupe-independent-target",
        "dedupe-red",
        &global,
        "Independent target",
        &format!("{} duplicate budget phrase", "unrelated ".repeat(80)),
    )
    .await;

    let result = store
        .search_v2(&SearchRequestV2 {
            namespace: "dedupe-red".to_string(),
            scope: workspace,
            scope_mode: ScopeMode::Ancestors,
            query: "duplicate budget phrase".to_string(),
            applicability: None,
            candidate_limit: 2,
            limit: 2,
        })
        .await
        .expect("nearest-scope budget search must remain valid");
    let ids: Vec<&str> = result
        .items
        .iter()
        .map(|item| item.record.id.as_str())
        .collect();
    assert_eq!(
        ids,
        ["dedupe-workspace", "dedupe-independent-target"],
        "farther duplicate scopes must be removed before candidate_limit"
    );
}
}

retrieval_behavior_test! {
#[tokio::test]
async fn title_match_outranks_content_only_match() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let scope = MemoryScope::Global;
    approve_test_record(
        &store,
        "content-only-match",
        "rank-red",
        &scope,
        "Generic maintenance note",
        "priority signal phrase",
    )
    .await;
    approve_test_record(
        &store,
        "title-match",
        "rank-red",
        &scope,
        "priority signal phrase",
        &format!("{} unique title evidence", "unrelated ".repeat(80)),
    )
    .await;

    let result = store
        .search_v2(&SearchRequestV2 {
            namespace: "rank-red".to_string(),
            scope,
            scope_mode: ScopeMode::Exact,
            query: "priority signal phrase".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .expect("rank fixture search must remain valid");
    let ids: Vec<&str> = result
        .items
        .iter()
        .map(|item| item.record.id.as_str())
        .collect();
    assert_eq!(
        ids.first().copied(),
        Some("title-match"),
        "title field evidence must outrank a content-only match; got {ids:?}"
    );
}
}

#[tokio::test]
async fn full_query_coverage_outranks_partial_match_with_stable_reasons() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let scope = MemoryScope::Global;
    approve_test_record(
        &store,
        "coverage-partial",
        "rank-red",
        &scope,
        "coverage alpha",
        "coverage alpha only",
    )
    .await;
    approve_test_record(
        &store,
        "coverage-full",
        "rank-red",
        &scope,
        "Complete coverage",
        "coverage alpha beta",
    )
    .await;

    let result = store
        .search_v2(&SearchRequestV2 {
            namespace: "rank-red".to_string(),
            scope,
            scope_mode: ScopeMode::Exact,
            query: "coverage alpha beta".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .expect("coverage fixture search must remain valid");
    let full = result
        .items
        .iter()
        .find(|item| item.record.id == "coverage-full")
        .expect("full-coverage record must be recalled");
    let partial = result
        .items
        .iter()
        .find(|item| item.record.id == "coverage-partial")
        .expect("partial-coverage record must remain a candidate");
    assert!(full.score > partial.score);
    assert!(full.reasons.iter().any(|reason| reason == "coverage_full"));
    assert!(
        partial
            .reasons
            .iter()
            .any(|reason| reason == "coverage_partial")
    );
}

retrieval_behavior_test! {
#[tokio::test]
async fn rrf_uses_one_based_rank_with_k_60() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let scope = MemoryScope::Global;
    approve_test_record(
        &store,
        "rrf-target",
        "rank-red",
        &scope,
        "one based reciprocal rank",
        "one based reciprocal rank fusion",
    )
    .await;
    let result = store
        .search_v2(&SearchRequestV2 {
            namespace: "rank-red".to_string(),
            scope,
            scope_mode: ScopeMode::Exact,
            query: "one based reciprocal rank".to_string(),
            applicability: None,
            candidate_limit: 10,
            limit: 5,
        })
        .await
        .expect("RRF fixture search must remain valid");
    assert_eq!(result.items.len(), 1);
    assert_eq!(
        result.items[0].reasons,
        [
            "phrase_unicode61",
            "phrase_trigram",
            "terms_and_unicode61",
            "terms_or_unicode61",
            "terms_or_trigram",
            "coverage_full",
            "phrase_title",
            "field_title",
            "exact_token_full",
        ]
    );
    let rrf = (0..5).fold(0.0, |score, _| score + 1.0 / 61.0);
    let expected = rrf + 1.0 + 0.80 + 0.40 + 0.25;
    assert!(
        (result.items[0].score - expected).abs() < 1e-12,
        "composite score must preserve one-based RRF plus fixed lexical evidence; got {}",
        result.items[0].score
    );
}
}

retrieval_behavior_test! {
#[tokio::test]
async fn exact_lexical_tie_is_record_id_deterministic() {
    let store = MemoryStore::open_in_memory().await.unwrap();
    let scope = MemoryScope::Global;
    for (id, suffix) in [("tie-b", "bravo"), ("tie-a", "alpha")] {
        approve_test_record(
            &store,
            id,
            "rank-red",
            &scope,
            "stable lexical tie",
            &format!("stable lexical tie {suffix}"),
        )
        .await;
    }
    let run = || async {
        store
            .search_v2(&SearchRequestV2 {
                namespace: "rank-red".to_string(),
                scope: scope.clone(),
                scope_mode: ScopeMode::Exact,
                query: "stable lexical tie".to_string(),
                applicability: None,
                candidate_limit: 10,
                limit: 5,
            })
            .await
            .unwrap()
            .items
            .into_iter()
            .map(|item| item.record.id)
            .collect::<Vec<_>>()
    };
    let first = run().await;
    let second = run().await;
    assert_eq!(first, vec!["tie-a", "tie-b"]);
    assert_eq!(first, second);
}
}
