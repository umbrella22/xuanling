//! XuanLing memory — v2 proposal/review memory persistence and recall.
//!
//! Extracted from `xuanling-toolkit::memory` as an independent crate (memory
//! v2 plan W2, C-02). This crate MUST NOT depend on `xuanling-toolkit`,
//! `xuanling-mcp`, or any host crate; MCP consumes it as a sibling.
//!
//! All mutations are proposals; only a review carrying a proposal-revision CAS
//! can activate one (immutable record versions, CAS heads, active-only FTS
//! projection, terminal reviews, append-only feedback). Legacy v1 databases
//! are refused, never migrated. NO audit/event/evidence/task tables.

// `ToolError` is the structured failure type used across this crate. It
// carries multiple `String` fields plus a `serde_json::Value`, so it exceeds
// clippy's `result_large_err` threshold; boxing it at every call site adds
// overhead for no benefit (same rationale as the toolkit crate).
#![allow(clippy::result_large_err)]

// Semantic embedding surface is feature-gated (plan W6, C-07): the default
// build exposes no embedder API and carries no model runtime, downloader, or
// network dependency. `experimental-embeddings` is a non-default feature that
// only exposes the protocol-neutral trait plus deterministic test doubles —
// no real model adapter ships with this crate, and no model installation flow
// is provided anywhere.
#[cfg(feature = "experimental-embeddings")]
pub mod embedder;
pub mod error;
pub mod jsonl;
pub mod proposal;
mod retrieval;
pub mod scope;
pub mod store;

#[cfg(feature = "experimental-embeddings")]
pub use embedder::{Embedder, FakeEmbedder, NoopEmbedder, cosine};
pub use error::{ToolError, ToolErrorCode};
pub use scope::MemoryScope;
pub use store::{
    CandidateArchiveRequest, CandidateCreateRequest, CandidateGetRequest, CandidateListRequest,
    CandidateListResult, CandidateReplaceRequest, FeedbackEventRequest, FeedbackEventResult,
    FeedbackValue, MemoryPayload, MemoryRecordView, MemoryStore, ProposalOperation, ProposalStatus,
    ProposalView, RecordGetRequest, RecordStatus, ReviewDecision, ReviewRequest, ReviewView,
    ScopeMode, SearchItemV2, SearchRequestV2, SearchResultV2, default_db_path,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Kind of memory record (plan §8).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum MemoryKind {
    Fact,
    Preference,
    Procedure,
    Solution,
    Summary,
}

/// Applicability filter (plan §8). Empty lists mean "applies everywhere".
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MemoryApplicability {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operating_systems: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub architectures: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub toolchains: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub project_markers: Vec<String>,
}

/// SHA-256 of a byte slice, lowercased hex. Local copy of the toolkit helper
/// so this crate carries no toolkit dependency.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
