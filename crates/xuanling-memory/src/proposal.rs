//! Memory v2 proposal/review DTOs (plan §5).
//!
//! All mutations are proposals; only [`review`] can activate one. Every
//! request carries caller-provided `idempotency_key` and actor ids — the
//! server never attests that a human performed the review.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::error::{ToolError, ToolErrorCode};
use crate::scope::MemoryScope;
use crate::{MemoryApplicability, MemoryKind};

/// Complete replacement payload for create/replace proposals. Partial patches
/// are not accepted; namespace, scope and record id live on the proposal, not
/// the payload.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryPayload {
    pub kind: MemoryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub applicability: MemoryApplicability,
    #[serde(default)]
    pub pinned: bool,
}

impl MemoryPayload {
    pub(crate) fn validate(&self) -> Result<(), ToolError> {
        if self.content.trim().is_empty() {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.payload",
                "content must not be empty",
            ));
        }
        if self.tags.iter().any(|tag| tag.trim().is_empty()) {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "memory.payload",
                "tags must be non-empty strings",
            ));
        }
        Ok(())
    }
}

/// Proposal operation.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ProposalOperation {
    Create,
    Replace,
    Archive,
}

impl ProposalOperation {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Replace => "replace",
            Self::Archive => "archive",
        }
    }

    pub(crate) fn from_stored(s: &str) -> Result<Self, ToolError> {
        match s {
            "create" => Ok(Self::Create),
            "replace" => Ok(Self::Replace),
            "archive" => Ok(Self::Archive),
            other => Err(ToolError::new(
                ToolErrorCode::IntegrityError,
                "memory.proposal",
                format!("unknown stored operation {other:?}"),
            )),
        }
    }
}

/// Proposal lifecycle status.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ProposalStatus {
    Pending,
    Approved,
    Rejected,
}

impl ProposalStatus {
    pub(crate) fn from_stored(s: &str) -> Result<Self, ToolError> {
        match s {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            other => Err(ToolError::new(
                ToolErrorCode::IntegrityError,
                "memory.proposal",
                format!("unknown stored status {other:?}"),
            )),
        }
    }
}

/// Terminal review decision.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approve,
    Reject,
}

fn validate_id_field(value: &str, field: &str) -> Result<(), ToolError> {
    if value.is_empty() {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "memory.proposal",
            format!("{field} must not be empty"),
        ));
    }
    Ok(())
}

fn validate_namespace(namespace: &str) -> Result<(), ToolError> {
    validate_id_field(namespace, "namespace")
}

/// `memory_candidate_create` request.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateCreateRequest {
    pub proposal_id: String,
    pub idempotency_key: String,
    pub proposer_id: String,
    pub namespace: String,
    pub scope: MemoryScope,
    pub payload: MemoryPayload,
}

/// `memory_candidate_replace` request. The payload fully replaces the target;
/// namespace/scope/record id cannot move.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateReplaceRequest {
    pub proposal_id: String,
    pub idempotency_key: String,
    pub proposer_id: String,
    pub namespace: String,
    pub scope: MemoryScope,
    pub target_record_id: String,
    pub target_revision: u64,
    pub payload: MemoryPayload,
}

/// `memory_candidate_archive` request. Archive only flips head status; no
/// physical delete exists.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateArchiveRequest {
    pub proposal_id: String,
    pub idempotency_key: String,
    pub proposer_id: String,
    pub namespace: String,
    pub scope: MemoryScope,
    pub target_record_id: String,
    pub target_revision: u64,
}

/// `memory_review` request. `expected_proposal_revision` is the CAS guard: it
/// must equal the pending proposal's revision (1).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewRequest {
    pub idempotency_key: String,
    pub reviewer_id: String,
    pub namespace: String,
    pub scope: MemoryScope,
    pub proposal_id: String,
    pub expected_proposal_revision: u64,
    pub decision: ReviewDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// Terminal review record attached to a proposal.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewView {
    pub decision: ReviewDecision,
    pub reviewer_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    pub expected_proposal_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_record_revision: Option<u64>,
    pub created_at: String,
}

/// Proposal as observed by get/list/review results.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProposalView {
    pub proposal_id: String,
    pub operation: ProposalOperation,
    pub status: ProposalStatus,
    pub revision: u64,
    pub namespace: String,
    pub scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<MemoryPayload>,
    pub proposer_id: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<ReviewView>,
}

/// `memory_candidate_get` request (exact scope, no ancestor expansion).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateGetRequest {
    pub namespace: String,
    pub scope: MemoryScope,
    pub proposal_id: String,
}

/// `memory_candidate_list` request (exact scope, stable pagination).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateListRequest {
    pub namespace: String,
    pub scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ProposalStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation: Option<ProposalOperation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CandidateListResult {
    pub proposals: Vec<ProposalView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Head status of a record.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum RecordStatus {
    Active,
    Archived,
}

impl RecordStatus {
    pub(crate) fn from_stored(s: &str) -> Result<Self, ToolError> {
        match s {
            "active" => Ok(Self::Active),
            "archived" => Ok(Self::Archived),
            other => Err(ToolError::new(
                ToolErrorCode::IntegrityError,
                "memory.record",
                format!("unknown stored status {other:?}"),
            )),
        }
    }
}

/// A record version as returned by `memory_get` (current or historical).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MemoryRecordView {
    pub id: String,
    pub namespace: String,
    pub scope: MemoryScope,
    pub kind: MemoryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    pub tags: Vec<String>,
    pub applicability: MemoryApplicability,
    pub pinned: bool,
    pub revision: u64,
    pub status: RecordStatus,
    pub content_sha256: String,
    pub created_at: String,
    pub helpful_count: u64,
    pub unhelpful_count: u64,
}

/// `memory_get` request.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RecordGetRequest {
    pub namespace: String,
    pub scope: MemoryScope,
    pub record_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
}

/// `memory_feedback` request: append-only event bound to a record revision.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackEventRequest {
    pub event_id: String,
    pub idempotency_key: String,
    pub record_id: String,
    pub revision: u64,
    pub feedback: FeedbackValue,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum FeedbackValue {
    Helpful,
    Unhelpful,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackEventResult {
    pub event_id: String,
    pub record_id: String,
    pub revision: u64,
    pub feedback: FeedbackValue,
    pub created_at: String,
}

/// Scope resolution mode for `memory_search`.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ScopeMode {
    Exact,
    Ancestors,
}

/// `memory_search` request: active records only.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchRequestV2 {
    pub namespace: String,
    pub scope: MemoryScope,
    #[serde(default = "default_scope_mode")]
    pub scope_mode: ScopeMode,
    pub query: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applicability: Option<MemoryApplicability>,
    pub candidate_limit: u64,
    pub limit: u64,
}

fn default_scope_mode() -> ScopeMode {
    ScopeMode::Exact
}

/// One ranked search hit.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchItemV2 {
    pub record: MemoryRecordView,
    pub score: f64,
    pub reasons: Vec<String>,
    pub scope_distance: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchResultV2 {
    pub items: Vec<SearchItemV2>,
    pub scope_mode: ScopeMode,
}

pub(crate) fn validate_common(
    namespace: &str,
    scope: &MemoryScope,
    ids: &[&str],
) -> Result<(), ToolError> {
    validate_namespace(namespace)?;
    scope.validate()?;
    for (value, field) in ids.iter().map(|v| (*v, "id")) {
        validate_id_field(value, field)?;
    }
    Ok(())
}
