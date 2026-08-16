//! Memory v2 store operations: proposal/review lifecycle (plan §5, C-03/C-04).
//!
//! Invariants enforced here:
//! - Mutations only create pending proposals; activation happens exclusively
//!   in [`review`] inside one transaction.
//! - Record versions are immutable; heads advance via CAS on `current_revision`.
//! - Reviews CAS on the pending proposal's revision (1 → 2 when terminal).
//! - Failures leave zero partial writes (single transaction per decision).
//! - Scope checks are exact; a mismatched scope observes `not_found`.

use sqlx::Row;
use sqlx::SqliteConnection;
use time::OffsetDateTime;

use crate::error::{ToolError, ToolErrorCode};
use crate::proposal::{
    CandidateArchiveRequest, CandidateCreateRequest, CandidateGetRequest, CandidateListRequest,
    CandidateListResult, CandidateReplaceRequest, FeedbackEventRequest, FeedbackEventResult,
    FeedbackValue, MemoryPayload, MemoryRecordView, ProposalOperation, ProposalStatus,
    ProposalView, RecordGetRequest, RecordStatus, ReviewDecision, ReviewRequest, ReviewView,
    ScopeMode, SearchItemV2, SearchRequestV2, SearchResultV2,
};
use crate::retrieval::{
    LexicalChannel, QueryPlan, fuse_candidates, reciprocal_rank, rerank_lexical_candidate,
};
use crate::scope::MemoryScope;
use crate::store::{MemoryStore, compute_content_sha256, compute_dedupe_key, rfc3339};

impl MemoryStore {
    /// `memory_candidate_create`: insert a pending create proposal.
    pub async fn candidate_create(
        &self,
        req: &CandidateCreateRequest,
    ) -> Result<ProposalView, ToolError> {
        crate::proposal::validate_common(
            &req.namespace,
            &req.scope,
            &[&req.proposal_id, &req.idempotency_key, &req.proposer_id],
        )?;
        req.payload.validate()?;

        let digest = request_digest(
            "create",
            &req.namespace,
            &req.scope.scope_key(),
            None,
            None,
            Some(&serde_json::to_string(&req.payload).map_err(|e| {
                ToolError::new(
                    ToolErrorCode::Internal,
                    "memory.candidate_create",
                    format!("payload serialization failed: {e}"),
                )
            })?),
        );

        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_create"))?;
        let replayed = check_proposal_idempotency(
            &mut tx,
            &req.idempotency_key,
            &digest,
            "memory.candidate_create",
        )
        .await?;
        if replayed.is_none() {
            let now = rfc3339(OffsetDateTime::now_utc());
            insert_proposal(
                &mut tx,
                &req.proposal_id,
                &req.idempotency_key,
                ProposalOperation::Create,
                &req.namespace,
                &req.scope,
                None,
                None,
                Some(&serde_json::to_string(&req.payload).expect("payload serializes")),
                &digest,
                &req.proposer_id,
                &now,
            )
            .await?;
        }
        tx.commit()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_create"))?;
        self.candidate_get(&CandidateGetRequest {
            namespace: req.namespace.clone(),
            scope: req.scope.clone(),
            proposal_id: replayed.unwrap_or_else(|| req.proposal_id.clone()),
        })
        .await
    }

    /// `memory_candidate_replace`: pending replace proposal with a target CAS.
    pub async fn candidate_replace(
        &self,
        req: &CandidateReplaceRequest,
    ) -> Result<ProposalView, ToolError> {
        crate::proposal::validate_common(
            &req.namespace,
            &req.scope,
            &[
                &req.proposal_id,
                &req.idempotency_key,
                &req.proposer_id,
                &req.target_record_id,
            ],
        )?;
        if req.target_revision == 0 {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.candidate_replace",
                "target_revision must be >= 1",
            ));
        }
        req.payload.validate()?;

        let digest = request_digest(
            "replace",
            &req.namespace,
            &req.scope.scope_key(),
            Some(&req.target_record_id),
            Some(req.target_revision),
            Some(&serde_json::to_string(&req.payload).expect("payload serializes")),
        );

        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_replace"))?;
        let replayed = check_proposal_idempotency(
            &mut tx,
            &req.idempotency_key,
            &digest,
            "memory.candidate_replace",
        )
        .await?;
        if replayed.is_none() {
            let now = rfc3339(OffsetDateTime::now_utc());
            insert_proposal(
                &mut tx,
                &req.proposal_id,
                &req.idempotency_key,
                ProposalOperation::Replace,
                &req.namespace,
                &req.scope,
                Some(&req.target_record_id),
                Some(req.target_revision),
                Some(&serde_json::to_string(&req.payload).expect("payload serializes")),
                &digest,
                &req.proposer_id,
                &now,
            )
            .await?;
        }
        tx.commit()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_replace"))?;
        self.candidate_get(&CandidateGetRequest {
            namespace: req.namespace.clone(),
            scope: req.scope.clone(),
            proposal_id: replayed.unwrap_or_else(|| req.proposal_id.clone()),
        })
        .await
    }

    /// `memory_candidate_archive`: pending archive proposal (no physical delete).
    pub async fn candidate_archive(
        &self,
        req: &CandidateArchiveRequest,
    ) -> Result<ProposalView, ToolError> {
        crate::proposal::validate_common(
            &req.namespace,
            &req.scope,
            &[
                &req.proposal_id,
                &req.idempotency_key,
                &req.proposer_id,
                &req.target_record_id,
            ],
        )?;
        if req.target_revision == 0 {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.candidate_archive",
                "target_revision must be >= 1",
            ));
        }
        let digest = request_digest(
            "archive",
            &req.namespace,
            &req.scope.scope_key(),
            Some(&req.target_record_id),
            Some(req.target_revision),
            None,
        );
        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_archive"))?;
        let replayed = check_proposal_idempotency(
            &mut tx,
            &req.idempotency_key,
            &digest,
            "memory.candidate_archive",
        )
        .await?;
        if replayed.is_none() {
            let now = rfc3339(OffsetDateTime::now_utc());
            insert_proposal(
                &mut tx,
                &req.proposal_id,
                &req.idempotency_key,
                ProposalOperation::Archive,
                &req.namespace,
                &req.scope,
                Some(&req.target_record_id),
                Some(req.target_revision),
                None,
                &digest,
                &req.proposer_id,
                &now,
            )
            .await?;
        }
        tx.commit()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_archive"))?;
        self.candidate_get(&CandidateGetRequest {
            namespace: req.namespace.clone(),
            scope: req.scope.clone(),
            proposal_id: replayed.unwrap_or_else(|| req.proposal_id.clone()),
        })
        .await
    }

    /// `memory_candidate_get`: exact-scope proposal lookup.
    pub async fn candidate_get(
        &self,
        req: &CandidateGetRequest,
    ) -> Result<ProposalView, ToolError> {
        crate::proposal::validate_common(&req.namespace, &req.scope, &[&req.proposal_id])?;
        let row = sqlx::query(
            "SELECT proposal_id, operation, status, revision, namespace, \
             scope_type, scope_project_id, scope_workspace_id, target_record_id, \
             target_revision, payload_json, proposer_id, created_at, decided_at \
             FROM memory_proposals \
             WHERE proposal_id = ? AND namespace = ? AND scope_key = ?",
        )
        .bind(&req.proposal_id)
        .bind(&req.namespace)
        .bind(req.scope.scope_key())
        .fetch_optional(self.pool())
        .await
        .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_get"))?;
        let row = row.ok_or_else(|| not_found_proposal(&req.proposal_id))?;
        let review = fetch_review(self.pool(), &req.proposal_id).await?;
        row_to_proposal(row, review)
    }

    /// `memory_candidate_list`: stable, query-bound pagination.
    pub async fn candidate_list(
        &self,
        req: &CandidateListRequest,
    ) -> Result<CandidateListResult, ToolError> {
        crate::proposal::validate_common(&req.namespace, &req.scope, &[])?;
        let limit = req.limit.unwrap_or(50).clamp(1, 200);
        let query_hash =
            list_query_hash(&req.namespace, &req.scope, req.status, req.operation, limit);
        let (after_created, after_id) = match &req.cursor {
            None => (String::new(), String::new()),
            Some(cursor) => parse_list_cursor(cursor, &query_hash)?,
        };

        // Static SQL only: filters and pagination are bind parameters, never
        // interpolated strings. The cursor tuple always participates; the
        // sentinel "" sorts before every real timestamp on the first page.
        let rows = sqlx::query(
            "SELECT proposal_id, operation, status, revision, namespace, \
             scope_type, scope_project_id, scope_workspace_id, target_record_id, \
             target_revision, payload_json, proposer_id, created_at, decided_at \
             FROM memory_proposals \
             WHERE namespace = ? AND scope_key = ? \
               AND (? IS NULL OR status = ?) \
               AND (? IS NULL OR operation = ?) \
               AND (created_at > ? OR (created_at = ? AND proposal_id > ?)) \
             ORDER BY created_at ASC, proposal_id ASC LIMIT ?",
        )
        .bind(&req.namespace)
        .bind(req.scope.scope_key())
        .bind(req.status.map(status_word))
        .bind(req.status.map(status_word))
        .bind(req.operation.map(|o| o.as_str()))
        .bind(req.operation.map(|o| o.as_str()))
        .bind(&after_created)
        .bind(&after_created)
        .bind(&after_id)
        .bind(limit as i64 + 1)
        .fetch_all(self.pool())
        .await
        .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_list"))?;

        let mut views = Vec::new();
        let count = (rows.len() as u64).min(limit);
        let mut rows = rows;
        rows.truncate(count as usize);
        for row in rows {
            let id: String = row.try_get("proposal_id").map_err(integrity)?;
            let review = fetch_review(self.pool(), &id).await?;
            views.push(row_to_proposal(row, review)?);
        }
        let next_cursor = if count < limit {
            None
        } else {
            let last = &views[views.len() - 1];
            Some(format!(
                "{query_hash}:{}:{}",
                last.created_at, last.proposal_id
            ))
        };
        Ok(CandidateListResult {
            proposals: views,
            next_cursor,
        })
    }

    /// `memory_review`: the only activation path. One transaction decides the
    /// proposal terminally; a stale CAS or an already-terminal proposal
    /// conflicts without writing anything.
    pub async fn review(&self, req: &ReviewRequest) -> Result<ProposalView, ToolError> {
        crate::proposal::validate_common(
            &req.namespace,
            &req.scope,
            &[&req.idempotency_key, &req.reviewer_id, &req.proposal_id],
        )?;
        if req.expected_proposal_revision != 1 {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.review",
                "expected_proposal_revision must be 1 while the proposal is pending",
            ));
        }

        let op = "memory.review";
        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;

        // Idempotent replay: same review key on the same proposal returns the
        // recorded terminal state without writing.
        if let Some(row) =
            sqlx::query("SELECT proposal_id FROM memory_reviews WHERE idempotency_key = ?")
                .bind(&req.idempotency_key)
                .fetch_optional(&mut *tx)
                .await
                .map_err(|e| crate::store::map_sqlx(&e, op))?
        {
            if row.try_get::<String, _>(0).map_err(integrity)? != req.proposal_id {
                return Err(ToolError::new(
                    ToolErrorCode::Conflict,
                    op,
                    "review idempotency_key already used by a different proposal",
                ));
            }
            let view =
                load_proposal_in_tx(&mut tx, &req.namespace, &req.scope, &req.proposal_id).await?;
            tx.commit()
                .await
                .map_err(|e| crate::store::map_sqlx(&e, op))?;
            return Ok(view);
        }

        let row = sqlx::query(
            "SELECT operation, status, revision, target_record_id, target_revision, payload_json \
             FROM memory_proposals \
             WHERE proposal_id = ? AND namespace = ? AND scope_key = ?",
        )
        .bind(&req.proposal_id)
        .bind(&req.namespace)
        .bind(req.scope.scope_key())
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| crate::store::map_sqlx(&e, op))?
        .ok_or_else(|| not_found_proposal(&req.proposal_id))?;

        let status: String = row.try_get("status").map_err(integrity)?;
        let revision: i64 = row.try_get("revision").map_err(integrity)?;
        if status != "pending" {
            return Err(ToolError::new(
                ToolErrorCode::Conflict,
                op,
                format!(
                    "proposal {id} is already {status}; only a pending proposal can be reviewed",
                    id = req.proposal_id
                ),
            )
            .with_details(serde_json::json!({
                "expected_status": "pending",
                "actual_status": status,
            })));
        }
        if revision as u64 != req.expected_proposal_revision {
            return Err(
                ToolError::new(ToolErrorCode::Conflict, op, "stale proposal revision")
                    .with_details(serde_json::json!({
                        "expected_revision": req.expected_proposal_revision,
                        "actual_revision": revision,
                    })),
            );
        }

        let operation = ProposalOperation::from_stored(
            row.try_get::<String, _>("operation")
                .map_err(integrity)?
                .as_str(),
        )?;
        let now = rfc3339(OffsetDateTime::now_utc());
        let applied: Option<u64> = match req.decision {
            ReviewDecision::Reject => None,
            ReviewDecision::Approve => {
                let target_record_id: Option<String> =
                    row.try_get("target_record_id").map_err(integrity)?;
                let target_revision: Option<i64> =
                    row.try_get("target_revision").map_err(integrity)?;
                let payload_json: Option<String> =
                    row.try_get("payload_json").map_err(integrity)?;
                match operation {
                    ProposalOperation::Create => {
                        let payload = decode_payload(payload_json.as_deref())?;
                        Some(apply_create(&mut tx, req, &payload, &now).await?)
                    }
                    ProposalOperation::Replace => {
                        let record_id = require_target(target_record_id.as_deref(), op, "replace")?;
                        let target = require_target_revision(target_revision, op)?;
                        let payload = decode_payload(payload_json.as_deref())?;
                        Some(apply_replace(&mut tx, req, &record_id, target, &payload, &now).await?)
                    }
                    ProposalOperation::Archive => {
                        let record_id = require_target(target_record_id.as_deref(), op, "archive")?;
                        let target = require_target_revision(target_revision, op)?;
                        Some(apply_archive(&mut tx, req, &record_id, target, &now).await?)
                    }
                }
            }
        };

        sqlx::query(
            "INSERT INTO memory_reviews \
             (proposal_id, idempotency_key, decision, reviewer_id, comment, \
              expected_proposal_revision, applied_record_revision, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&req.proposal_id)
        .bind(&req.idempotency_key)
        .bind(decision_word(req.decision))
        .bind(&req.reviewer_id)
        .bind(&req.comment)
        .bind(req.expected_proposal_revision as i64)
        .bind(applied.map(|r| r as i64))
        .bind(&now)
        .execute(&mut *tx)
        .await
        .map_err(|e| crate::store::map_sqlx(&e, op))?;

        let decided_word = match req.decision {
            ReviewDecision::Approve => "approved",
            ReviewDecision::Reject => "rejected",
        };
        let updated = sqlx::query(
            "UPDATE memory_proposals \
             SET status = ?, revision = 2, decided_at = ? \
             WHERE proposal_id = ? AND revision = 1",
        )
        .bind(decided_word)
        .bind(&now)
        .bind(&req.proposal_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| crate::store::map_sqlx(&e, op))?;
        if updated.rows_affected() != 1 {
            return Err(ToolError::new(
                ToolErrorCode::Conflict,
                op,
                "concurrent review won the proposal CAS",
            )
            .with_details(serde_json::json!({
                "expected_revision": 1,
                "winner": "another review transaction",
            })));
        }

        tx.commit()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;
        self.candidate_get(&CandidateGetRequest {
            namespace: req.namespace.clone(),
            scope: req.scope.clone(),
            proposal_id: req.proposal_id.clone(),
        })
        .await
    }

    /// `memory_get`: current or historical record version, exact scope.
    pub async fn record_get(&self, req: &RecordGetRequest) -> Result<MemoryRecordView, ToolError> {
        crate::proposal::validate_common(&req.namespace, &req.scope, &[&req.record_id])?;
        let head = sqlx::query(
            "SELECT current_revision, status FROM memory_record_heads \
             WHERE record_id = ? AND namespace = ? AND scope_key = ?",
        )
        .bind(&req.record_id)
        .bind(&req.namespace)
        .bind(req.scope.scope_key())
        .fetch_optional(self.pool())
        .await
        .map_err(|e| crate::store::map_sqlx(&e, "memory.get"))?
        .ok_or_else(|| {
            ToolError::new(
                ToolErrorCode::NotFound,
                "memory.get",
                format!("record {} not found in this scope", req.record_id),
            )
        })?;
        let current: i64 = head.try_get("current_revision").map_err(integrity)?;
        let status = RecordStatus::from_stored(
            head.try_get::<String, _>("status")
                .map_err(integrity)?
                .as_str(),
        )?;
        let revision = req.revision.unwrap_or(current as u64) as i64;
        load_record_view(self.pool(), &req.record_id, revision, status).await
    }

    /// `memory_feedback`: append-only, version-bound, idempotent event.
    pub async fn feedback_event(
        &self,
        req: &FeedbackEventRequest,
    ) -> Result<FeedbackEventResult, ToolError> {
        for id in [&req.event_id, &req.idempotency_key, &req.record_id] {
            if id.is_empty() {
                return Err(ToolError::new(
                    ToolErrorCode::InvalidInput,
                    "memory.feedback",
                    "event_id, idempotency_key and record_id must not be empty",
                ));
            }
        }
        // The event carries its own namespace/scope context implicitly via the
        // record; validate the record revision exists.
        let exists = sqlx::query(
            "SELECT 1 FROM memory_record_versions WHERE record_id = ? AND revision = ?",
        )
        .bind(&req.record_id)
        .bind(req.revision as i64)
        .fetch_optional(self.pool())
        .await
        .map_err(|e| crate::store::map_sqlx(&e, "memory.feedback"))?
        .ok_or_else(|| {
            ToolError::new(
                ToolErrorCode::NotFound,
                "memory.feedback",
                format!(
                    "record {} revision {} does not exist",
                    req.record_id, req.revision
                ),
            )
        })?;
        let _ = exists;

        if let Some(row) = sqlx::query(
            "SELECT event_id, record_id, revision, feedback, created_at \
             FROM memory_feedback_events WHERE idempotency_key = ?",
        )
        .bind(&req.idempotency_key)
        .fetch_optional(self.pool())
        .await
        .map_err(|e| crate::store::map_sqlx(&e, "memory.feedback"))?
        {
            let stored_event: String = row.try_get("event_id").map_err(integrity)?;
            if stored_event != req.event_id {
                return Err(ToolError::new(
                    ToolErrorCode::Conflict,
                    "memory.feedback",
                    "idempotency_key already used with a different event_id",
                ));
            }
            return row_to_feedback_event(row);
        }

        let now = rfc3339(OffsetDateTime::now_utc());
        let inserted = sqlx::query(
            "INSERT INTO memory_feedback_events \
             (event_id, idempotency_key, record_id, revision, feedback, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&req.event_id)
        .bind(&req.idempotency_key)
        .bind(&req.record_id)
        .bind(req.revision as i64)
        .bind(feedback_word(req.feedback))
        .bind(&now)
        .execute(self.pool())
        .await;
        if let Err(e) = &inserted {
            // UNIQUE(idempotency_key) raced with a concurrent insert: replay.
            let conflict = crate::store::map_sqlx(e, "memory.feedback");
            if conflict.code == ToolErrorCode::Conflict {
                let row = sqlx::query(
                    "SELECT event_id, record_id, revision, feedback, created_at \
                     FROM memory_feedback_events WHERE idempotency_key = ?",
                )
                .bind(&req.idempotency_key)
                .fetch_one(self.pool())
                .await
                .map_err(|e2| crate::store::map_sqlx(&e2, "memory.feedback"))?;
                return row_to_feedback_event(row);
            }
            return Err(conflict);
        }
        let row = sqlx::query(
            "SELECT event_id, record_id, revision, feedback, created_at \
             FROM memory_feedback_events WHERE event_id = ?",
        )
        .bind(&req.event_id)
        .fetch_one(self.pool())
        .await
        .map_err(|e| crate::store::map_sqlx(&e, "memory.feedback"))?;
        row_to_feedback_event(row)
    }

    /// `memory_search`: active records only; exact or ancestor scopes.
    /// `memory_search`: active records only; exact or ancestor scopes.
    ///
    /// Lexical recall runs on the derived dual-FTS projection (unicode61 +
    /// trigram) merged with Reciprocal Rank Fusion. One- and two-character
    /// queries fall back to a parameter-bound `instr` substring scan (W4.2)
    /// because trigram needs >= 3 chars and unicode61 tokenizes CJK poorly.
    /// Ranking: lexical score -> scope distance -> pinned -> current-revision
    /// feedback delta -> record id. Identical database + request yield
    /// byte-identical results (no timestamps, no volatile ids).
    pub async fn search_v2(&self, req: &SearchRequestV2) -> Result<SearchResultV2, ToolError> {
        crate::proposal::validate_common(&req.namespace, &req.scope, &[])?;
        let plan = QueryPlan::build(&req.query)?;
        if req.limit == 0 || req.candidate_limit < req.limit {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.search",
                "requires candidate_limit >= limit > 0",
            ));
        }
        let limit_error = || {
            ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.search",
                "candidate_limit and limit exceed the supported platform range",
            )
        };
        let candidate_limit_sql = i64::try_from(req.candidate_limit).map_err(|_| limit_error())?;
        let candidate_limit = usize::try_from(req.candidate_limit).map_err(|_| limit_error())?;
        let result_limit = usize::try_from(req.limit).map_err(|_| limit_error())?;
        let scopes: Vec<MemoryScope> = match req.scope_mode {
            ScopeMode::Exact => vec![req.scope.clone()],
            ScopeMode::Ancestors => req.scope.ancestors(),
        };
        let distance_of = |key: &str| -> u64 {
            scopes
                .iter()
                .position(|s| s.scope_key() == key)
                .map(|i| i as u64)
                .unwrap_or(u64::MAX)
        };
        let applicability_json = req
            .applicability
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| {
                ToolError::new(
                    ToolErrorCode::Internal,
                    "memory.search",
                    format!("applicability serialization failed: {error}"),
                )
            })?;
        let scope_keys = [
            scopes
                .first()
                .map(MemoryScope::scope_key)
                .unwrap_or_else(|| "\u{0}none".to_string()),
            scopes
                .get(1)
                .map(MemoryScope::scope_key)
                .unwrap_or_else(|| "\u{0}none".to_string()),
            scopes
                .get(2)
                .map(MemoryScope::scope_key)
                .unwrap_or_else(|| "\u{0}none".to_string()),
        ];
        let mut read_tx = self
            .pool()
            .begin()
            .await
            .map_err(|error| crate::store::map_sqlx(&error, "memory.search"))?;

        // --- visible candidate ids from deterministic lexical channels ---
        let mut rrf: std::collections::BTreeMap<String, (f64, Vec<String>)> =
            std::collections::BTreeMap::new();
        if plan.channels == [LexicalChannel::ShortSubstring] {
            let rows = sqlx::query(SHORT_SUBSTRING_SQL)
                .bind(applicability_json.as_deref())
                .bind(&scope_keys[0])
                .bind(&scope_keys[1])
                .bind(&scope_keys[2])
                .bind(&req.namespace)
                .bind(&scope_keys[0])
                .bind(&scope_keys[1])
                .bind(&scope_keys[2])
                .bind(&plan.normalized)
                .bind(&plan.normalized)
                .bind(&plan.normalized)
                .bind(&plan.normalized)
                .bind(candidate_limit_sql)
                .fetch_all(&mut *read_tx)
                .await
                .map_err(map_search_sqlx)?;
            for row in rows {
                let id: String = row.try_get(0).map_err(integrity)?;
                rrf.entry(id)
                    .or_insert((0.0, Vec::new()))
                    .1
                    .push("instr_fallback".to_string());
            }
        } else {
            for channel in plan.channels.iter().copied() {
                let Some(match_expression) = plan.match_expression(channel) else {
                    continue;
                };
                let rows = fetch_visible_fts_candidates(
                    &mut read_tx,
                    channel,
                    &match_expression,
                    CandidateVisibility {
                        scope_mode: req.scope_mode,
                        applicability_json: applicability_json.as_deref(),
                        namespace: &req.namespace,
                        scope_keys: &scope_keys,
                    },
                    candidate_limit_sql,
                )
                .await?;
                for (rank, row) in rows.iter().enumerate() {
                    let id: String = row.try_get(0).map_err(integrity)?;
                    let entry = rrf.entry(id).or_insert((0.0, Vec::new()));
                    entry.0 += reciprocal_rank(rank)?;
                    entry.1.push(channel.reason().to_string());
                }
            }
        }

        let fused = fuse_candidates(rrf, candidate_limit)?;

        // --- load active, in-scope records for the capped candidates ---
        let mut items: Vec<SearchItemV2> = Vec::new();
        let mut nearest_by_dedupe: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();
        for candidate in &fused {
            let row = match sqlx::query(
                "SELECT v.record_id, v.revision, v.namespace, v.scope_key, v.scope_type, \
                 v.scope_project_id, v.scope_workspace_id, v.kind, v.title, v.content, \
                 v.summary, v.applicability_json, v.pinned, v.content_sha256, v.created_at, \
                 h.status AS status, v.dedupe_key, \
                 (SELECT COUNT(*) FROM memory_feedback_events f \
                   WHERE f.record_id = v.record_id AND f.revision = v.revision \
                     AND f.feedback = 'helpful') AS helpful_count, \
                 (SELECT COUNT(*) FROM memory_feedback_events f \
                   WHERE f.record_id = v.record_id AND f.revision = v.revision \
                     AND f.feedback = 'unhelpful') AS unhelpful_count, \
                 (SELECT COALESCE(GROUP_CONCAT(t.tag), '') FROM memory_record_tags t \
                   WHERE t.record_id = v.record_id AND t.revision = v.revision) AS tags \
                 FROM memory_record_heads h \
                 JOIN memory_record_versions v \
                   ON v.record_id = h.record_id AND v.revision = h.current_revision \
                 WHERE h.status = 'active' AND h.namespace = ? \
                   AND h.scope_key IN (?, ?, ?) AND h.record_id = ?",
            )
            .bind(&req.namespace)
            .bind(
                scopes
                    .first()
                    .map(|s| s.scope_key())
                    .unwrap_or_else(|| "\u{0}none".to_string()),
            )
            .bind(
                scopes
                    .get(1)
                    .map(|s| s.scope_key())
                    .unwrap_or_else(|| "\u{0}none".to_string()),
            )
            .bind(
                scopes
                    .get(2)
                    .map(|s| s.scope_key())
                    .unwrap_or_else(|| "\u{0}none".to_string()),
            )
            .bind(&candidate.record_id)
            .fetch_optional(&mut *read_tx)
            .await
            .map_err(|e| crate::store::map_sqlx(&e, "memory.search"))?
            {
                Some(row) => row,
                None => continue, // stale projection row: not active/in scope
            };
            let view = row_to_record_view(row)?;
            if !applicability_matches(&req.applicability, &view.applicability) {
                continue;
            }
            let (score, reasons) = rerank_lexical_candidate(
                candidate.score,
                &candidate.reasons,
                &plan,
                view.title.as_deref(),
                &view.tags,
                view.summary.as_deref(),
                &view.content,
            )?;
            let scope_distance = distance_of(&view.scope.scope_key());
            // W4 dedupe: for ancestor mode the same dedupe key in a nearer
            // scope shadows farther copies; exact mode is a single scope.
            if req.scope_mode == ScopeMode::Ancestors {
                let dedupe = format!("{}\u{1f}{}", view.namespace, view.content_sha256);
                if let Some(&prev) = nearest_by_dedupe.get(&dedupe) {
                    if items[prev].scope_distance <= scope_distance {
                        continue;
                    }
                    items[prev] = SearchItemV2 {
                        score,
                        reasons,
                        record: view,
                        scope_distance,
                    };
                    continue;
                }
                nearest_by_dedupe.insert(dedupe, items.len());
            }
            items.push(SearchItemV2 {
                score,
                reasons,
                record: view,
                scope_distance,
            });
        }

        items.sort_by(|left, right| {
            compare_search_rank(SearchRankKey::from(left), SearchRankKey::from(right))
        });
        items.truncate(result_limit);
        read_tx
            .commit()
            .await
            .map_err(|error| crate::store::map_sqlx(&error, "memory.search"))?;
        Ok(SearchResultV2 {
            items,
            scope_mode: req.scope_mode,
        })
    }

    /// W4.6: rebuild the derived FTS projection from canonical rows. Runs in
    /// one transaction; canonical tables are never touched.
    pub async fn rebuild_projection(&self) -> Result<u64, ToolError> {
        let op = "memory.rebuild_index";
        let mut tx = self
            .pool()
            .begin()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;
        sqlx::query("DELETE FROM memory_fts_v2_unicode")
            .execute(&mut *tx)
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;
        sqlx::query("DELETE FROM memory_fts_v2_trigram")
            .execute(&mut *tx)
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;
        let rows = sqlx::query(
            "SELECT v.record_id, v.title, v.content, v.summary, \
             (SELECT COALESCE(GROUP_CONCAT(tag, ' '), '') FROM ( \
                SELECT t.tag AS tag FROM memory_record_tags t \
                WHERE t.record_id = v.record_id AND t.revision = v.revision \
                ORDER BY t.tag \
              )) AS tags \
             FROM memory_record_heads h \
             JOIN memory_record_versions v \
               ON v.record_id = h.record_id AND v.revision = h.current_revision \
             WHERE h.status = 'active'",
        )
        .fetch_all(&mut *tx)
        .await
        .map_err(|e| crate::store::map_sqlx(&e, op))?;
        for row in &rows {
            let record_id: String = row.try_get("record_id").map_err(integrity)?;
            let title: Option<String> = row.try_get("title").map_err(integrity)?;
            let content: String = row.try_get("content").map_err(integrity)?;
            let summary: Option<String> = row.try_get("summary").map_err(integrity)?;
            let tags: String = row.try_get("tags").map_err(integrity)?;
            sqlx::query(
                "INSERT INTO memory_fts_v2_unicode (record_id, title, content, summary, tags) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&record_id)
            .bind(&title)
            .bind(&content)
            .bind(&summary)
            .bind(&tags)
            .execute(&mut *tx)
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;
            sqlx::query(
                "INSERT INTO memory_fts_v2_trigram (record_id, title, content, summary, tags) \
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&record_id)
            .bind(&title)
            .bind(&content)
            .bind(&summary)
            .bind(&tags)
            .execute(&mut *tx)
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;
        }
        let rebuilt = rows.len() as u64;
        tx.commit()
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;
        Ok(rebuilt)
    }
}

// --- helpers ---------------------------------------------------------------

const SHORT_SUBSTRING_SQL: &str = "WITH requested(applicability_json, scope_0, scope_1, scope_2) AS (VALUES (?, ?, ?, ?)), \
     visible_ranked AS ( \
     SELECT h.record_id, v.title, v.content, v.summary, \
       (SELECT COALESCE(GROUP_CONCAT(t.tag), '') \
        FROM memory_record_tags t \
        WHERE t.record_id = v.record_id AND t.revision = v.revision) AS tags, \
       ROW_NUMBER() OVER (PARTITION BY h.dedupe_key ORDER BY \
         CASE h.scope_key WHEN requested.scope_0 THEN 0 \
                          WHEN requested.scope_1 THEN 1 \
                          WHEN requested.scope_2 THEN 2 ELSE 3 END, \
         h.record_id) AS nearest_rank \
     FROM memory_record_heads h \
     JOIN memory_record_versions v \
       ON v.record_id = h.record_id AND v.revision = h.current_revision \
     CROSS JOIN requested \
     WHERE h.status = 'active' AND h.namespace = ? \
       AND h.scope_key IN (?, ?, ?) \
       AND (requested.applicability_json IS NULL OR ( \
         (COALESCE(json_array_length(json_extract(v.applicability_json, '$.operating_systems')), 0) = 0 \
          OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.operating_systems')), 0) = 0 \
          OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.operating_systems') record_value \
                    JOIN json_each(requested.applicability_json, '$.operating_systems') query_value \
                      ON query_value.value = record_value.value)) \
         AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.architectures')), 0) = 0 \
          OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.architectures')), 0) = 0 \
          OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.architectures') record_value \
                    JOIN json_each(requested.applicability_json, '$.architectures') query_value \
                      ON query_value.value = record_value.value)) \
         AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.toolchains')), 0) = 0 \
          OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.toolchains')), 0) = 0 \
          OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.toolchains') record_value \
                    JOIN json_each(requested.applicability_json, '$.toolchains') query_value \
                      ON query_value.value = record_value.value)) \
         AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.project_markers')), 0) = 0 \
          OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.project_markers')), 0) = 0 \
          OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.project_markers') record_value \
                    JOIN json_each(requested.applicability_json, '$.project_markers') query_value \
                      ON query_value.value = record_value.value))))) \
     SELECT record_id FROM visible_ranked \
     WHERE nearest_rank = 1 \
       AND (instr(content, ?) > 0 OR instr(COALESCE(title, ''), ?) > 0 \
            OR instr(COALESCE(summary, ''), ?) > 0 OR instr(tags, ?) > 0) \
     ORDER BY record_id LIMIT ?";

#[derive(Clone, Copy)]
struct SearchRankKey<'a> {
    score: f64,
    scope_distance: u64,
    pinned: bool,
    feedback_delta: i128,
    record_id: &'a str,
}

impl<'a> From<&'a SearchItemV2> for SearchRankKey<'a> {
    fn from(item: &'a SearchItemV2) -> Self {
        Self {
            score: item.score,
            scope_distance: item.scope_distance,
            pinned: item.record.pinned,
            feedback_delta: i128::from(item.record.helpful_count)
                - i128::from(item.record.unhelpful_count),
            record_id: &item.record.id,
        }
    }
}

fn compare_search_rank(left: SearchRankKey<'_>, right: SearchRankKey<'_>) -> std::cmp::Ordering {
    right
        .score
        .total_cmp(&left.score)
        .then(left.scope_distance.cmp(&right.scope_distance))
        .then(right.pinned.cmp(&left.pinned))
        .then(right.feedback_delta.cmp(&left.feedback_delta))
        .then(left.record_id.cmp(right.record_id))
}

macro_rules! visible_fts_sql {
    ($table:literal) => {
        concat!(
            "WITH requested(applicability_json, scope_0, scope_1, scope_2) AS (VALUES (?, ?, ?, ?)), ",
            "matched(record_id, fts_rank) AS MATERIALIZED (SELECT record_id, rank FROM ",
            $table,
            " WHERE ",
            $table,
            " MATCH ?), ",
            "visible_ranked(record_id, fts_rank, nearest_rank) AS (",
            "SELECT h.record_id, matched.fts_rank, ",
            "ROW_NUMBER() OVER (PARTITION BY h.dedupe_key ORDER BY ",
            "CASE h.scope_key WHEN requested.scope_0 THEN 0 WHEN requested.scope_1 THEN 1 ",
            "WHEN requested.scope_2 THEN 2 ELSE 3 END, h.record_id) FROM matched ",
            "CROSS JOIN memory_record_heads h ON h.record_id = matched.record_id ",
            "JOIN memory_record_versions v ",
            "ON v.record_id = h.record_id AND v.revision = h.current_revision ",
            "CROSS JOIN requested ",
            "WHERE h.status = 'active' AND h.namespace = ? ",
            "AND h.scope_key IN (?, ?, ?) ",
            "AND (requested.applicability_json IS NULL OR (",
            "(COALESCE(json_array_length(json_extract(v.applicability_json, '$.operating_systems')), 0) = 0 ",
            "OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.operating_systems')), 0) = 0 ",
            "OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.operating_systems') record_value ",
            "JOIN json_each(requested.applicability_json, '$.operating_systems') query_value ",
            "ON query_value.value = record_value.value)) ",
            "AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.architectures')), 0) = 0 ",
            "OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.architectures')), 0) = 0 ",
            "OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.architectures') record_value ",
            "JOIN json_each(requested.applicability_json, '$.architectures') query_value ",
            "ON query_value.value = record_value.value)) ",
            "AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.toolchains')), 0) = 0 ",
            "OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.toolchains')), 0) = 0 ",
            "OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.toolchains') record_value ",
            "JOIN json_each(requested.applicability_json, '$.toolchains') query_value ",
            "ON query_value.value = record_value.value)) ",
            "AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.project_markers')), 0) = 0 ",
            "OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.project_markers')), 0) = 0 ",
            "OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.project_markers') record_value ",
            "JOIN json_each(requested.applicability_json, '$.project_markers') query_value ",
            "ON query_value.value = record_value.value))))",
            ") ",
            "SELECT record_id FROM visible_ranked WHERE nearest_rank = 1 ",
            "ORDER BY fts_rank, record_id LIMIT ?"
        )
    };
}

macro_rules! exact_visible_fts_sql {
    ($table:literal) => {
        concat!(
            "WITH requested(applicability_json) AS (VALUES (?)), ",
            "matched(record_id, fts_rank) AS MATERIALIZED (SELECT record_id, rank FROM ",
            $table,
            " WHERE ",
            $table,
            " MATCH ?) ",
            "SELECT h.record_id FROM matched ",
            "CROSS JOIN memory_record_heads h ON h.record_id = matched.record_id ",
            "JOIN memory_record_versions v ",
            "ON v.record_id = h.record_id AND v.revision = h.current_revision ",
            "CROSS JOIN requested ",
            "WHERE h.status = 'active' AND h.namespace = ? AND h.scope_key = ? ",
            "AND (requested.applicability_json IS NULL OR (",
            "(COALESCE(json_array_length(json_extract(v.applicability_json, '$.operating_systems')), 0) = 0 ",
            "OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.operating_systems')), 0) = 0 ",
            "OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.operating_systems') record_value ",
            "JOIN json_each(requested.applicability_json, '$.operating_systems') query_value ",
            "ON query_value.value = record_value.value)) ",
            "AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.architectures')), 0) = 0 ",
            "OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.architectures')), 0) = 0 ",
            "OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.architectures') record_value ",
            "JOIN json_each(requested.applicability_json, '$.architectures') query_value ",
            "ON query_value.value = record_value.value)) ",
            "AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.toolchains')), 0) = 0 ",
            "OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.toolchains')), 0) = 0 ",
            "OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.toolchains') record_value ",
            "JOIN json_each(requested.applicability_json, '$.toolchains') query_value ",
            "ON query_value.value = record_value.value)) ",
            "AND (COALESCE(json_array_length(json_extract(v.applicability_json, '$.project_markers')), 0) = 0 ",
            "OR COALESCE(json_array_length(json_extract(requested.applicability_json, '$.project_markers')), 0) = 0 ",
            "OR EXISTS(SELECT 1 FROM json_each(v.applicability_json, '$.project_markers') record_value ",
            "JOIN json_each(requested.applicability_json, '$.project_markers') query_value ",
            "ON query_value.value = record_value.value))))",
            " ORDER BY matched.fts_rank, h.record_id LIMIT ?"
        )
    };
}

macro_rules! exact_visible_fts_without_applicability_sql {
    ($table:literal) => {
        concat!(
            "WITH matched(record_id, fts_rank) AS MATERIALIZED (SELECT record_id, rank FROM ",
            $table,
            " WHERE ",
            $table,
            " MATCH ?) ",
            "SELECT h.record_id FROM matched ",
            "CROSS JOIN memory_record_heads h ON h.record_id = matched.record_id ",
            "WHERE h.status = 'active' AND h.namespace = ? AND h.scope_key = ? ",
            "ORDER BY matched.fts_rank, h.record_id LIMIT ?"
        )
    };
}

struct CandidateVisibility<'a> {
    scope_mode: ScopeMode,
    applicability_json: Option<&'a str>,
    namespace: &'a str,
    scope_keys: &'a [String; 3],
}

async fn fetch_visible_fts_candidates(
    connection: &mut SqliteConnection,
    channel: LexicalChannel,
    match_expression: &str,
    visibility: CandidateVisibility<'_>,
    candidate_limit: i64,
) -> Result<Vec<sqlx::sqlite::SqliteRow>, ToolError> {
    let exact = visibility.scope_mode == ScopeMode::Exact;
    if exact && visibility.applicability_json.is_none() {
        let sql = match channel {
            LexicalChannel::PhraseUnicode61
            | LexicalChannel::TermsAndUnicode61
            | LexicalChannel::TermsOrUnicode61 => {
                exact_visible_fts_without_applicability_sql!("memory_fts_v2_unicode")
            }
            LexicalChannel::PhraseTrigram | LexicalChannel::TermsOrTrigram => {
                exact_visible_fts_without_applicability_sql!("memory_fts_v2_trigram")
            }
            LexicalChannel::ShortSubstring => {
                return Err(ToolError::new(
                    ToolErrorCode::Internal,
                    "memory.search",
                    "short substring channel cannot execute an FTS query",
                ));
            }
        };
        return sqlx::query(sql)
            .bind(match_expression)
            .bind(visibility.namespace)
            .bind(&visibility.scope_keys[0])
            .bind(candidate_limit)
            .fetch_all(&mut *connection)
            .await
            .map_err(map_search_sqlx);
    }
    let sql: &'static str = match (channel, exact) {
        (
            LexicalChannel::PhraseUnicode61
            | LexicalChannel::TermsAndUnicode61
            | LexicalChannel::TermsOrUnicode61,
            true,
        ) => exact_visible_fts_sql!("memory_fts_v2_unicode"),
        (LexicalChannel::PhraseTrigram | LexicalChannel::TermsOrTrigram, true) => {
            exact_visible_fts_sql!("memory_fts_v2_trigram")
        }
        (
            LexicalChannel::PhraseUnicode61
            | LexicalChannel::TermsAndUnicode61
            | LexicalChannel::TermsOrUnicode61,
            false,
        ) => visible_fts_sql!("memory_fts_v2_unicode"),
        (LexicalChannel::PhraseTrigram | LexicalChannel::TermsOrTrigram, false) => {
            visible_fts_sql!("memory_fts_v2_trigram")
        }
        (LexicalChannel::ShortSubstring, _) => {
            return Err(ToolError::new(
                ToolErrorCode::Internal,
                "memory.search",
                "short substring channel cannot execute an FTS query",
            ));
        }
    };
    if exact {
        sqlx::query(sql)
            .bind(visibility.applicability_json)
            .bind(match_expression)
            .bind(visibility.namespace)
            .bind(&visibility.scope_keys[0])
            .bind(candidate_limit)
            .fetch_all(&mut *connection)
            .await
            .map_err(map_search_sqlx)
    } else {
        sqlx::query(sql)
            .bind(visibility.applicability_json)
            .bind(&visibility.scope_keys[0])
            .bind(&visibility.scope_keys[1])
            .bind(&visibility.scope_keys[2])
            .bind(match_expression)
            .bind(visibility.namespace)
            .bind(&visibility.scope_keys[0])
            .bind(&visibility.scope_keys[1])
            .bind(&visibility.scope_keys[2])
            .bind(candidate_limit)
            .fetch_all(&mut *connection)
            .await
            .map_err(map_search_sqlx)
    }
}

fn map_search_sqlx(error: sqlx::Error) -> ToolError {
    if let sqlx::Error::Database(database) = &error {
        let message = database.message();
        if message.contains("malformed JSON") {
            return ToolError::new(
                ToolErrorCode::IntegrityError,
                "memory.search",
                "stored applicability JSON is malformed",
            );
        }
        if message.contains("no such function: json_") {
            return ToolError::new(
                ToolErrorCode::Unsupported,
                "memory.search",
                "bundled SQLite lacks required JSON query functions",
            );
        }
    }
    crate::store::map_sqlx(&error, "memory.search")
}

fn applicability_matches(
    query: &Option<crate::MemoryApplicability>,
    record: &crate::MemoryApplicability,
) -> bool {
    let Some(query) = query else {
        return true;
    };
    let intersects = |q: &[String], r: &[String]| {
        r.is_empty() || q.is_empty() || q.iter().any(|v| r.contains(v))
    };
    intersects(&query.operating_systems, &record.operating_systems)
        && intersects(&query.architectures, &record.architectures)
        && intersects(&query.toolchains, &record.toolchains)
        && intersects(&query.project_markers, &record.project_markers)
}

fn kind_word(kind: &crate::MemoryKind) -> String {
    serde_json::to_value(kind)
        .expect("kind serializes")
        .as_str()
        .expect("kind serializes to a scalar")
        .to_string()
}

fn integrity(e: sqlx::Error) -> ToolError {
    ToolError::new(
        ToolErrorCode::IntegrityError,
        "memory.store",
        format!("column access failed: {e}"),
    )
}

fn not_found_proposal(id: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::NotFound,
        "memory.proposal",
        format!("proposal {id} not found in this scope"),
    )
}

fn decision_word(d: ReviewDecision) -> &'static str {
    match d {
        ReviewDecision::Approve => "approve",
        ReviewDecision::Reject => "reject",
    }
}

fn status_word(s: ProposalStatus) -> &'static str {
    match s {
        ProposalStatus::Pending => "pending",
        ProposalStatus::Approved => "approved",
        ProposalStatus::Rejected => "rejected",
    }
}

fn feedback_word(f: FeedbackValue) -> &'static str {
    match f {
        FeedbackValue::Helpful => "helpful",
        FeedbackValue::Unhelpful => "unhelpful",
    }
}

fn request_digest(
    operation: &str,
    namespace: &str,
    scope_key: &str,
    target_record_id: Option<&str>,
    target_revision: Option<u64>,
    payload_json: Option<&str>,
) -> String {
    let canonical = format!(
        "{operation}\x1f{namespace}\x1f{scope_key}\x1f{}\x1f{}\x1f{}",
        target_record_id.unwrap_or(""),
        target_revision.map(|r| r.to_string()).unwrap_or_default(),
        payload_json.unwrap_or(""),
    );
    crate::sha256_hex(canonical.as_bytes())
}

fn list_query_hash(
    namespace: &str,
    scope: &MemoryScope,
    status: Option<ProposalStatus>,
    operation: Option<ProposalOperation>,
    limit: u64,
) -> String {
    let canonical = format!(
        "{namespace}\x1f{}\x1f{}\x1f{}\x1f{limit}",
        scope.scope_key(),
        status.map(status_word).unwrap_or(""),
        operation.map(|o| o.as_str()).unwrap_or(""),
    );
    crate::sha256_hex(canonical.as_bytes())[..16].to_string()
}

fn parse_list_cursor(cursor: &str, query_hash: &str) -> Result<(String, String), ToolError> {
    let parts: Vec<&str> = cursor.splitn(3, ':').collect();
    if parts.len() != 3 || parts[0] != query_hash {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "memory.candidate_list",
            "cursor does not belong to this query; restart pagination from the first page",
        ));
    }
    Ok((parts[1].to_string(), parts[2].to_string()))
}

fn decode_payload(json: Option<&str>) -> Result<MemoryPayload, ToolError> {
    let json = json.ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::IntegrityError,
            "memory.review",
            "create/replace proposal is missing its stored payload",
        )
    })?;
    serde_json::from_str(json).map_err(|e| {
        ToolError::new(
            ToolErrorCode::IntegrityError,
            "memory.review",
            format!("stored payload is not valid: {e}"),
        )
    })
}

fn require_target(id: Option<&str>, op: &str, kind: &str) -> Result<String, ToolError> {
    id.map(str::to_string).ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::IntegrityError,
            op,
            format!("{kind} proposal is missing its stored target_record_id"),
        )
    })
}

fn require_target_revision(rev: Option<i64>, op: &str) -> Result<u64, ToolError> {
    rev.filter(|r| *r >= 1).map(|r| r as u64).ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::IntegrityError,
            op,
            "proposal is missing its stored target_revision",
        )
    })
}

/// Replay check for proposal idempotency keys. Returns the existing proposal
/// id when the key was already used with the same request digest (idempotent
/// replay: nothing is written), or `None` when the key is new. A key reused
/// with a *different* digest is a `conflict`.
async fn check_proposal_idempotency(
    tx: &mut SqliteConnection,
    idempotency_key: &str,
    digest: &str,
    op: &str,
) -> Result<Option<String>, ToolError> {
    if let Some(row) = sqlx::query(
        "SELECT proposal_id, request_digest FROM memory_proposals WHERE idempotency_key = ?",
    )
    .bind(idempotency_key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?
    {
        let stored: String = row.try_get(1).map_err(integrity)?;
        if stored != digest {
            return Err(ToolError::new(
                ToolErrorCode::Conflict,
                op,
                "idempotency_key already used with a different request payload",
            )
            .with_details(serde_json::json!({
                "idempotency_key": idempotency_key,
            })));
        }
        // Same key + same digest is an idempotent replay: the existing proposal
        // is returned and nothing is written.
        let existing: String = row.try_get(0).map_err(integrity)?;
        return Ok(Some(existing));
    }
    Ok(None)
}

#[expect(clippy::too_many_arguments)]
async fn insert_proposal(
    tx: &mut SqliteConnection,
    proposal_id: &str,
    idempotency_key: &str,
    operation: ProposalOperation,
    namespace: &str,
    scope: &MemoryScope,
    target_record_id: Option<&str>,
    target_revision: Option<u64>,
    payload_json: Option<&str>,
    digest: &str,
    proposer_id: &str,
    now: &str,
) -> Result<(), ToolError> {
    let op = "memory.candidate";
    sqlx::query(
        "INSERT INTO memory_proposals \
         (proposal_id, idempotency_key, operation, namespace, scope_type, \
          scope_project_id, scope_workspace_id, scope_key, target_record_id, \
          target_revision, payload_json, request_digest, proposer_id, status, \
          revision, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?)",
    )
    .bind(proposal_id)
    .bind(idempotency_key)
    .bind(operation.as_str())
    .bind(namespace)
    .bind(scope.type_name())
    .bind(scope.project_id())
    .bind(scope.workspace_id())
    .bind(scope.scope_key())
    .bind(target_record_id)
    .bind(target_revision.map(|r| r as i64))
    .bind(payload_json)
    .bind(digest)
    .bind(proposer_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;
    Ok(())
}

async fn load_proposal_in_tx(
    tx: &mut SqliteConnection,
    namespace: &str,
    scope: &MemoryScope,
    proposal_id: &str,
) -> Result<ProposalView, ToolError> {
    let row = sqlx::query(
        "SELECT proposal_id, operation, status, revision, namespace, \
         scope_type, scope_project_id, scope_workspace_id, target_record_id, \
         target_revision, payload_json, proposer_id, created_at, decided_at \
         FROM memory_proposals \
         WHERE proposal_id = ? AND namespace = ? AND scope_key = ?",
    )
    .bind(proposal_id)
    .bind(namespace)
    .bind(scope.scope_key())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_get"))?
    .ok_or_else(|| not_found_proposal(proposal_id))?;
    let review = fetch_review_tx(tx, proposal_id).await?;
    row_to_proposal(row, review)
}

async fn fetch_review(
    pool: &sqlx::SqlitePool,
    proposal_id: &str,
) -> Result<Option<ReviewView>, ToolError> {
    let row = sqlx::query(
        "SELECT decision, reviewer_id, comment, expected_proposal_revision, \
         applied_record_revision, created_at FROM memory_reviews WHERE proposal_id = ?",
    )
    .bind(proposal_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_get"))?;
    row.map(row_to_review).transpose()
}

async fn fetch_review_tx(
    tx: &mut SqliteConnection,
    proposal_id: &str,
) -> Result<Option<ReviewView>, ToolError> {
    let row = sqlx::query(
        "SELECT decision, reviewer_id, comment, expected_proposal_revision, \
         applied_record_revision, created_at FROM memory_reviews WHERE proposal_id = ?",
    )
    .bind(proposal_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, "memory.candidate_get"))?;
    row.map(row_to_review).transpose()
}

fn row_to_review(row: sqlx::sqlite::SqliteRow) -> Result<ReviewView, ToolError> {
    let decision = match row
        .try_get::<String, _>("decision")
        .map_err(integrity)?
        .as_str()
    {
        "approve" => ReviewDecision::Approve,
        "reject" => ReviewDecision::Reject,
        other => {
            return Err(ToolError::new(
                ToolErrorCode::IntegrityError,
                "memory.review",
                format!("unknown stored decision {other:?}"),
            ));
        }
    };
    Ok(ReviewView {
        decision,
        reviewer_id: row.try_get("reviewer_id").map_err(integrity)?,
        comment: row.try_get("comment").map_err(integrity)?,
        expected_proposal_revision: row
            .try_get::<i64, _>("expected_proposal_revision")
            .map_err(integrity)? as u64,
        applied_record_revision: row
            .try_get::<Option<i64>, _>("applied_record_revision")
            .map_err(integrity)?
            .map(|r| r as u64),
        created_at: row.try_get("created_at").map_err(integrity)?,
    })
}

fn row_to_proposal(
    row: sqlx::sqlite::SqliteRow,
    review: Option<ReviewView>,
) -> Result<ProposalView, ToolError> {
    let scope = MemoryScope::from_columns(
        row.try_get::<String, _>("scope_type")
            .map_err(integrity)?
            .as_str(),
        row.try_get::<Option<String>, _>("scope_project_id")
            .map_err(integrity)?
            .as_deref(),
        row.try_get::<Option<String>, _>("scope_workspace_id")
            .map_err(integrity)?
            .as_deref(),
    )?;
    let payload = row
        .try_get::<Option<String>, _>("payload_json")
        .map_err(integrity)?
        .map(|json| {
            serde_json::from_str(&json).map_err(|e| {
                ToolError::new(
                    ToolErrorCode::IntegrityError,
                    "memory.proposal",
                    format!("stored payload is not valid: {e}"),
                )
            })
        })
        .transpose()?;
    Ok(ProposalView {
        proposal_id: row.try_get("proposal_id").map_err(integrity)?,
        operation: ProposalOperation::from_stored(
            row.try_get::<String, _>("operation")
                .map_err(integrity)?
                .as_str(),
        )?,
        status: ProposalStatus::from_stored(
            row.try_get::<String, _>("status")
                .map_err(integrity)?
                .as_str(),
        )?,
        revision: row.try_get::<i64, _>("revision").map_err(integrity)? as u64,
        namespace: row.try_get("namespace").map_err(integrity)?,
        scope,
        target_record_id: row.try_get("target_record_id").map_err(integrity)?,
        target_revision: row
            .try_get::<Option<i64>, _>("target_revision")
            .map_err(integrity)?
            .map(|r| r as u64),
        payload,
        proposer_id: row.try_get("proposer_id").map_err(integrity)?,
        created_at: row.try_get("created_at").map_err(integrity)?,
        decided_at: row.try_get("decided_at").map_err(integrity)?,
        review,
    })
}

fn row_to_feedback_event(row: sqlx::sqlite::SqliteRow) -> Result<FeedbackEventResult, ToolError> {
    let feedback = match row
        .try_get::<String, _>("feedback")
        .map_err(integrity)?
        .as_str()
    {
        "helpful" => FeedbackValue::Helpful,
        "unhelpful" => FeedbackValue::Unhelpful,
        other => {
            return Err(ToolError::new(
                ToolErrorCode::IntegrityError,
                "memory.feedback",
                format!("unknown stored feedback {other:?}"),
            ));
        }
    };
    Ok(FeedbackEventResult {
        event_id: row.try_get("event_id").map_err(integrity)?,
        record_id: row.try_get("record_id").map_err(integrity)?,
        revision: row.try_get::<i64, _>("revision").map_err(integrity)? as u64,
        feedback,
        created_at: row.try_get("created_at").map_err(integrity)?,
    })
}

fn row_to_record_view(row: sqlx::sqlite::SqliteRow) -> Result<MemoryRecordView, ToolError> {
    let kind = serde_json::from_value::<crate::MemoryKind>(serde_json::Value::String(
        row.try_get::<String, _>("kind").map_err(integrity)?,
    ))
    .map_err(|e| {
        ToolError::new(
            ToolErrorCode::IntegrityError,
            "memory.record",
            format!("unknown stored kind: {e}"),
        )
    })?;
    let applicability: crate::MemoryApplicability = serde_json::from_str(
        row.try_get::<String, _>("applicability_json")
            .map_err(integrity)?
            .as_str(),
    )
    .map_err(|e| {
        ToolError::new(
            ToolErrorCode::IntegrityError,
            "memory.record",
            format!("stored applicability is not valid: {e}"),
        )
    })?;
    let tags: Vec<String> = {
        let joined: String = row.try_get("tags").map_err(integrity)?;
        if joined.is_empty() {
            Vec::new()
        } else {
            joined.split(',').map(str::to_string).collect()
        }
    };
    let status = RecordStatus::from_stored(
        row.try_get::<String, _>("status")
            .map_err(integrity)?
            .as_str(),
    )?;
    Ok(MemoryRecordView {
        id: row.try_get("record_id").map_err(integrity)?,
        namespace: row.try_get("namespace").map_err(integrity)?,
        scope: MemoryScope::from_columns(
            row.try_get::<String, _>("scope_type")
                .map_err(integrity)?
                .as_str(),
            row.try_get::<Option<String>, _>("scope_project_id")
                .map_err(integrity)?
                .as_deref(),
            row.try_get::<Option<String>, _>("scope_workspace_id")
                .map_err(integrity)?
                .as_deref(),
        )?,
        kind,
        title: row.try_get("title").map_err(integrity)?,
        content: row.try_get("content").map_err(integrity)?,
        summary: row.try_get("summary").map_err(integrity)?,
        tags,
        applicability,
        pinned: row.try_get::<i64, _>("pinned").map_err(integrity)? != 0,
        revision: row.try_get::<i64, _>("revision").map_err(integrity)? as u64,
        status,
        content_sha256: row.try_get("content_sha256").map_err(integrity)?,
        created_at: row.try_get("created_at").map_err(integrity)?,
        helpful_count: row.try_get::<i64, _>("helpful_count").map_err(integrity)? as u64,
        unhelpful_count: row
            .try_get::<i64, _>("unhelpful_count")
            .map_err(integrity)? as u64,
    })
}

async fn load_record_view(
    pool: &sqlx::SqlitePool,
    record_id: &str,
    revision: i64,
    status: RecordStatus,
) -> Result<MemoryRecordView, ToolError> {
    let row = sqlx::query(
        "SELECT v.record_id, v.revision, v.namespace, v.scope_key, v.scope_type, \
         v.scope_project_id, v.scope_workspace_id, v.kind, v.title, v.content, \
         v.summary, v.applicability_json, v.pinned, v.content_sha256, v.created_at, \
         ? AS status, \
         (SELECT COUNT(*) FROM memory_feedback_events f \
           WHERE f.record_id = v.record_id AND f.revision = v.revision \
             AND f.feedback = 'helpful') AS helpful_count, \
         (SELECT COUNT(*) FROM memory_feedback_events f \
           WHERE f.record_id = v.record_id AND f.revision = v.revision \
             AND f.feedback = 'unhelpful') AS unhelpful_count, \
         (SELECT COALESCE(GROUP_CONCAT(t.tag), '') FROM memory_record_tags t \
           WHERE t.record_id = v.record_id AND t.revision = v.revision) AS tags \
         FROM memory_record_versions v \
         WHERE v.record_id = ? AND v.revision = ?",
    )
    .bind(match status {
        RecordStatus::Active => "active",
        RecordStatus::Archived => "archived",
    })
    .bind(record_id)
    .bind(revision)
    .fetch_optional(pool)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, "memory.get"))?
    .ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::NotFound,
            "memory.get",
            format!("record {record_id} revision {revision} does not exist"),
        )
    })?;
    row_to_record_view(row)
}

async fn apply_create(
    tx: &mut SqliteConnection,
    req: &ReviewRequest,
    payload: &MemoryPayload,
    now: &str,
) -> Result<u64, ToolError> {
    let op = "memory.review";
    let dedupe_key = compute_dedupe_key(&payload.content, &req.namespace);
    let content_sha = compute_content_sha256(&payload.content);

    let dup = sqlx::query(
        "SELECT record_id FROM memory_record_heads \
         WHERE namespace = ? AND scope_key = ? AND dedupe_key = ? AND status = 'active'",
    )
    .bind(&req.namespace)
    .bind(req.scope.scope_key())
    .bind(&dedupe_key)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;
    if let Some(row) = dup {
        let other: String = row.try_get(0).map_err(integrity)?;
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            op,
            "an active record with the same dedupe key already exists in this scope",
        )
        .with_details(serde_json::json!({"existing_record_id": other})));
    }

    sqlx::query(
        "INSERT INTO memory_record_versions \
         (record_id, revision, namespace, scope_type, scope_project_id, \
          scope_workspace_id, scope_key, kind, title, content, summary, \
          applicability_json, pinned, content_sha256, dedupe_key, proposal_id, created_at) \
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&req.proposal_id)
    .bind(&req.namespace)
    .bind(req.scope.type_name())
    .bind(req.scope.project_id())
    .bind(req.scope.workspace_id())
    .bind(req.scope.scope_key())
    .bind(kind_word(&payload.kind))
    .bind(&payload.title)
    .bind(&payload.content)
    .bind(&payload.summary)
    .bind(serde_json::to_string(&payload.applicability).expect("applicability serializes"))
    .bind(payload.pinned as i64)
    .bind(&content_sha)
    .bind(&dedupe_key)
    .bind(&req.proposal_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;

    sqlx::query(
        "INSERT INTO memory_record_heads \
         (record_id, namespace, scope_type, scope_project_id, scope_workspace_id, \
          scope_key, dedupe_key, current_revision, status, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)",
    )
    .bind(&req.proposal_id)
    .bind(&req.namespace)
    .bind(req.scope.type_name())
    .bind(req.scope.project_id())
    .bind(req.scope.workspace_id())
    .bind(req.scope.scope_key())
    .bind(&dedupe_key)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;

    insert_tags_and_fts(tx, &req.proposal_id, 1, payload).await?;
    Ok(1)
}

async fn apply_replace(
    tx: &mut SqliteConnection,
    req: &ReviewRequest,
    record_id: &str,
    target_revision: u64,
    payload: &MemoryPayload,
    now: &str,
) -> Result<u64, ToolError> {
    let op = "memory.review";
    let head = sqlx::query(
        "SELECT current_revision, status, dedupe_key FROM memory_record_heads \
         WHERE record_id = ? AND namespace = ? AND scope_key = ?",
    )
    .bind(record_id)
    .bind(&req.namespace)
    .bind(req.scope.scope_key())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?
    .ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::NotFound,
            op,
            format!("replace target {record_id} not found in this scope"),
        )
    })?;
    let current: i64 = head.try_get("current_revision").map_err(integrity)?;
    let status: String = head.try_get("status").map_err(integrity)?;
    if status != "active" {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            op,
            format!("replace target {record_id} is {status}; only active records can be replaced"),
        ));
    }
    if current as u64 != target_revision {
        return Err(
            ToolError::new(ToolErrorCode::Conflict, op, "stale target revision").with_details(
                serde_json::json!({
                    "expected_revision": target_revision,
                    "actual_revision": current,
                }),
            ),
        );
    }

    let new_revision = current as u64 + 1;
    let dedupe_key = compute_dedupe_key(&payload.content, &req.namespace);
    let content_sha = compute_content_sha256(&payload.content);

    let dup = sqlx::query(
        "SELECT record_id FROM memory_record_heads \
         WHERE namespace = ? AND scope_key = ? AND dedupe_key = ? AND status = 'active' \
           AND record_id != ?",
    )
    .bind(&req.namespace)
    .bind(req.scope.scope_key())
    .bind(&dedupe_key)
    .bind(record_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;
    if let Some(row) = dup {
        let other: String = row.try_get(0).map_err(integrity)?;
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            op,
            "an active record with the same dedupe key already exists in this scope",
        )
        .with_details(serde_json::json!({"existing_record_id": other})));
    }

    sqlx::query(
        "INSERT INTO memory_record_versions \
         (record_id, revision, namespace, scope_type, scope_project_id, \
          scope_workspace_id, scope_key, kind, title, content, summary, \
          applicability_json, pinned, content_sha256, dedupe_key, proposal_id, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(record_id)
    .bind(new_revision as i64)
    .bind(&req.namespace)
    .bind(req.scope.type_name())
    .bind(req.scope.project_id())
    .bind(req.scope.workspace_id())
    .bind(req.scope.scope_key())
    .bind(kind_word(&payload.kind))
    .bind(&payload.title)
    .bind(&payload.content)
    .bind(&payload.summary)
    .bind(serde_json::to_string(&payload.applicability).expect("applicability serializes"))
    .bind(payload.pinned as i64)
    .bind(&content_sha)
    .bind(&dedupe_key)
    .bind(&req.proposal_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;

    let updated = sqlx::query(
        "UPDATE memory_record_heads \
         SET current_revision = ?, dedupe_key = ?, updated_at = ? \
         WHERE record_id = ? AND current_revision = ?",
    )
    .bind(new_revision as i64)
    .bind(&dedupe_key)
    .bind(now)
    .bind(record_id)
    .bind(current)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;
    if updated.rows_affected() != 1 {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            op,
            "concurrent writer won the head CAS",
        )
        .with_details(serde_json::json!({
            "expected_revision": current,
            "actual_revision": new_revision,
        })));
    }

    delete_fts(tx, record_id).await?;
    insert_tags_and_fts(tx, record_id, new_revision, payload).await?;
    Ok(new_revision)
}

async fn apply_archive(
    tx: &mut SqliteConnection,
    req: &ReviewRequest,
    record_id: &str,
    target_revision: u64,
    now: &str,
) -> Result<u64, ToolError> {
    let op = "memory.review";
    let head = sqlx::query(
        "SELECT current_revision, status FROM memory_record_heads \
         WHERE record_id = ? AND namespace = ? AND scope_key = ?",
    )
    .bind(record_id)
    .bind(&req.namespace)
    .bind(req.scope.scope_key())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?
    .ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::NotFound,
            op,
            format!("archive target {record_id} not found in this scope"),
        )
    })?;
    let current: i64 = head.try_get("current_revision").map_err(integrity)?;
    let status: String = head.try_get("status").map_err(integrity)?;
    if current as u64 != target_revision {
        return Err(
            ToolError::new(ToolErrorCode::Conflict, op, "stale target revision").with_details(
                serde_json::json!({
                    "expected_revision": target_revision,
                    "actual_revision": current,
                }),
            ),
        );
    }
    if status == "archived" {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            op,
            format!("record {record_id} is already archived"),
        ));
    }
    let updated = sqlx::query(
        "UPDATE memory_record_heads \
         SET status = 'archived', updated_at = ? \
         WHERE record_id = ? AND current_revision = ? AND status = 'active'",
    )
    .bind(now)
    .bind(record_id)
    .bind(current)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;
    if updated.rows_affected() != 1 {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            op,
            "concurrent writer won the archive CAS",
        ));
    }
    delete_fts(tx, record_id).await?;
    Ok(current as u64)
}

async fn insert_tags_and_fts(
    tx: &mut SqliteConnection,
    record_id: &str,
    revision: u64,
    payload: &MemoryPayload,
) -> Result<(), ToolError> {
    let op = "memory.review";
    for tag in &payload.tags {
        sqlx::query("INSERT INTO memory_record_tags (record_id, revision, tag) VALUES (?, ?, ?)")
            .bind(record_id)
            .bind(revision as i64)
            .bind(tag)
            .execute(&mut *tx)
            .await
            .map_err(|e| crate::store::map_sqlx(&e, op))?;
    }
    // Tags are a canonical set in memory_record_tags (its primary key does
    // not preserve request order), so every projection path uses this order.
    let mut projection_tags = payload.tags.clone();
    projection_tags.sort_unstable();
    let tags_text = projection_tags.join(" ");
    sqlx::query(
        "INSERT INTO memory_fts_v2_unicode (record_id, title, content, summary, tags) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(record_id)
    .bind(&payload.title)
    .bind(&payload.content)
    .bind(&payload.summary)
    .bind(&tags_text)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;
    sqlx::query(
        "INSERT INTO memory_fts_v2_trigram (record_id, title, content, summary, tags) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(record_id)
    .bind(&payload.title)
    .bind(&payload.content)
    .bind(&payload.summary)
    .bind(&tags_text)
    .execute(&mut *tx)
    .await
    .map_err(|e| crate::store::map_sqlx(&e, op))?;
    Ok(())
}

async fn delete_fts(tx: &mut SqliteConnection, record_id: &str) -> Result<(), ToolError> {
    let op = "memory.review";
    sqlx::query("DELETE FROM memory_fts_v2_unicode WHERE record_id = ?")
        .bind(record_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| crate::store::map_sqlx(&e, op))?;
    sqlx::query("DELETE FROM memory_fts_v2_trigram WHERE record_id = ?")
        .bind(record_id)
        .execute(&mut *tx)
        .await
        .map_err(|e| crate::store::map_sqlx(&e, op))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{SHORT_SUBSTRING_SQL, SearchRankKey, compare_search_rank};
    use crate::store::MemoryStore;
    use sqlx::Row;
    use std::cmp::Ordering;

    fn key<'a>(
        score: f64,
        scope_distance: u64,
        pinned: bool,
        feedback_delta: i128,
        record_id: &'a str,
    ) -> SearchRankKey<'a> {
        SearchRankKey {
            score,
            scope_distance,
            pinned,
            feedback_delta,
            record_id,
        }
    }

    #[test]
    fn search_rank_tuple_applies_every_tie_break_in_order() {
        let baseline = key(1.0, 1, false, 0, "b");
        assert_eq!(
            compare_search_rank(key(2.0, 9, false, -9, "z"), baseline),
            Ordering::Less,
            "lexical score is the primary key"
        );
        assert_eq!(
            compare_search_rank(key(1.0, 0, false, -9, "z"), baseline),
            Ordering::Less,
            "nearer scope wins an exact lexical tie"
        );
        assert_eq!(
            compare_search_rank(key(1.0, 1, true, -9, "z"), baseline),
            Ordering::Less,
            "pinned wins after score and scope"
        );
        assert_eq!(
            compare_search_rank(key(1.0, 1, false, 1, "z"), baseline),
            Ordering::Less,
            "feedback delta wins after pinned"
        );
        assert_eq!(
            compare_search_rank(key(1.0, 1, false, 0, "a"), baseline),
            Ordering::Less,
            "record id is the final deterministic tie-break"
        );
    }

    async fn explain_fts(store: &MemoryStore, sql: &str) -> Vec<String> {
        let statement = format!("EXPLAIN QUERY PLAN {sql}");
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(Option::<&str>::None)
            .bind("workspace:project-a/workspace-a")
            .bind("project:project-a")
            .bind("global")
            .bind("\"cargo\"")
            .bind("memory")
            .bind("workspace:project-a/workspace-a")
            .bind("project:project-a")
            .bind("global")
            .bind(25_i64)
            .fetch_all(store.pool())
            .await
            .expect("explain visible FTS candidate query")
            .into_iter()
            .map(|row| row.try_get("detail").expect("EXPLAIN detail"))
            .collect()
    }

    async fn explain_exact_fts(store: &MemoryStore, sql: &str) -> Vec<String> {
        let statement = format!("EXPLAIN QUERY PLAN {sql}");
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(Option::<&str>::None)
            .bind("\"cargo\"")
            .bind("memory")
            .bind("workspace:project-a/workspace-a")
            .bind(25_i64)
            .fetch_all(store.pool())
            .await
            .expect("explain exact-scope FTS candidate query")
            .into_iter()
            .map(|row| row.try_get("detail").expect("EXPLAIN detail"))
            .collect()
    }

    async fn explain_exact_fts_without_applicability(
        store: &MemoryStore,
        sql: &str,
    ) -> Vec<String> {
        let statement = format!("EXPLAIN QUERY PLAN {sql}");
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind("\"cargo\"")
            .bind("memory")
            .bind("workspace:project-a/workspace-a")
            .bind(25_i64)
            .fetch_all(store.pool())
            .await
            .expect("explain exact-scope FTS query without applicability")
            .into_iter()
            .map(|row| row.try_get("detail").expect("EXPLAIN detail"))
            .collect()
    }

    async fn explain_short(store: &MemoryStore) -> Vec<String> {
        let statement = format!("EXPLAIN QUERY PLAN {SHORT_SUBSTRING_SQL}");
        sqlx::query(sqlx::AssertSqlSafe(statement))
            .bind(Option::<&str>::None)
            .bind("workspace:project-a/workspace-a")
            .bind("project:project-a")
            .bind("global")
            .bind("memory")
            .bind("workspace:project-a/workspace-a")
            .bind("project:project-a")
            .bind("global")
            .bind("中")
            .bind("中")
            .bind("中")
            .bind("中")
            .bind(25_i64)
            .fetch_all(store.pool())
            .await
            .expect("explain short substring query")
            .into_iter()
            .map(|row| row.try_get("detail").expect("EXPLAIN detail"))
            .collect()
    }

    #[tokio::test]
    async fn retrieval_query_plans_use_fts_and_canonical_indexes() {
        let store = MemoryStore::open_in_memory().await.unwrap();
        let unicode = explain_fts(&store, visible_fts_sql!("memory_fts_v2_unicode")).await;
        let trigram = explain_fts(&store, visible_fts_sql!("memory_fts_v2_trigram")).await;
        let exact_unicode =
            explain_exact_fts(&store, exact_visible_fts_sql!("memory_fts_v2_unicode")).await;
        let exact_trigram =
            explain_exact_fts(&store, exact_visible_fts_sql!("memory_fts_v2_trigram")).await;
        let exact_no_app_unicode = explain_exact_fts_without_applicability(
            &store,
            exact_visible_fts_without_applicability_sql!("memory_fts_v2_unicode"),
        )
        .await;
        let exact_no_app_trigram = explain_exact_fts_without_applicability(
            &store,
            exact_visible_fts_without_applicability_sql!("memory_fts_v2_trigram"),
        )
        .await;
        let short = explain_short(&store).await;
        eprintln!(
            "EXPLAIN_QUERY_PLAN={}",
            serde_json::to_string(&serde_json::json!({
                "unicode61": unicode,
                "trigram": trigram,
                "exact_unicode61": exact_unicode,
                "exact_trigram": exact_trigram,
                "exact_no_app_unicode61": exact_no_app_unicode,
                "exact_no_app_trigram": exact_no_app_trigram,
                "short_substring": short,
            }))
            .unwrap()
        );
        assert!(
            unicode
                .iter()
                .any(|detail| detail.contains("memory_fts_v2_unicode VIRTUAL TABLE INDEX"))
        );
        assert!(
            trigram
                .iter()
                .any(|detail| detail.contains("memory_fts_v2_trigram VIRTUAL TABLE INDEX"))
        );
        assert!(
            exact_unicode
                .iter()
                .any(|detail| detail.contains("memory_fts_v2_unicode VIRTUAL TABLE INDEX"))
        );
        assert!(
            exact_trigram
                .iter()
                .any(|detail| detail.contains("memory_fts_v2_trigram VIRTUAL TABLE INDEX"))
        );
        assert!(
            exact_no_app_unicode
                .iter()
                .any(|detail| detail.contains("memory_fts_v2_unicode VIRTUAL TABLE INDEX"))
        );
        assert!(
            exact_no_app_trigram
                .iter()
                .any(|detail| detail.contains("memory_fts_v2_trigram VIRTUAL TABLE INDEX"))
        );
        for (label, details) in [
            ("unicode61", &unicode),
            ("trigram", &trigram),
            ("exact_unicode61", &exact_unicode),
            ("exact_trigram", &exact_trigram),
            ("exact_no_app_unicode61", &exact_no_app_unicode),
            ("exact_no_app_trigram", &exact_no_app_trigram),
        ] {
            assert!(
                details.iter().any(|detail| detail == "MATERIALIZE matched"),
                "{label} must evaluate its FTS iterator once: {details:?}"
            );
            assert!(
                details.iter().any(|detail| detail == "SCAN matched"),
                "{label} must drive the join from materialized FTS hits: {details:?}"
            );
            assert!(
                details.iter().any(|detail| {
                    detail.contains(
                        "SEARCH h USING INDEX sqlite_autoindex_memory_record_heads_1 (record_id=?)",
                    )
                }),
                "{label} must load each matched head by primary key: {details:?}"
            );
        }
        assert!(
            short.iter().any(|detail| {
                detail.contains(
                    "SEARCH h USING INDEX memory_active_dedupe (namespace=? AND scope_key=?)",
                )
            }),
            "short_substring must constrain namespace and scope through the active index: {short:?}"
        );
        for (label, details) in [
            ("exact_no_app_unicode61", &exact_no_app_unicode),
            ("exact_no_app_trigram", &exact_no_app_trigram),
        ] {
            assert!(
                details
                    .iter()
                    .all(|detail| !detail.contains("memory_record_versions")),
                "{label} must not load versions when no applicability filter exists: {details:?}"
            );
        }
        for (label, details) in [
            ("unicode61", &unicode),
            ("trigram", &trigram),
            ("exact_unicode61", &exact_unicode),
            ("exact_trigram", &exact_trigram),
            ("short_substring", &short),
        ] {
            assert!(
                details
                    .iter()
                    .any(|detail| { detail.contains("sqlite_autoindex_memory_record_versions_1") }),
                "{label} must join the current version by primary key: {details:?}"
            );
            assert!(
                !details.iter().any(|detail| {
                    detail == "SCAN h"
                        || detail.starts_with("SCAN h ")
                        || detail == "SCAN v"
                        || detail.starts_with("SCAN v ")
                }),
                "{label} must not perform an unbounded canonical table scan: {details:?}"
            );
        }
        for (label, details) in [
            ("exact_no_app_unicode61", &exact_no_app_unicode),
            ("exact_no_app_trigram", &exact_no_app_trigram),
        ] {
            assert!(
                !details.iter().any(|detail| {
                    detail == "SCAN h"
                        || detail.starts_with("SCAN h ")
                        || detail == "SCAN v"
                        || detail.starts_with("SCAN v ")
                }),
                "{label} must not perform an unbounded canonical table scan: {details:?}"
            );
        }
    }
}
