//! Canonical JSONL export/import for the memory v2 store (plan §6, C-06).
//!
//! Format version 1: a header line, entity lines sorted by stable primary
//! keys, and a trailer with per-type counts plus a SHA-256 over the raw UTF-8
//! bytes of the header through the last entity line (newlines included; the
//! trailer itself is not hashed). The derived FTS projection is never
//! exported; import rebuilds it from canonical rows.

use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::Row;
use time::OffsetDateTime;

use crate::error::{ToolError, ToolErrorCode};
use crate::proposal::{
    FeedbackValue, MemoryPayload, ProposalOperation, ProposalStatus, RecordStatus, ReviewDecision,
};
use crate::scope::MemoryScope;
use crate::store::{MemoryStore, map_sqlx, rfc3339};

pub const FORMAT_VERSION: u64 = 1;
pub const SCHEMA_VERSION: u64 = 2;

const OP_EXPORT: &str = "memory.export";
const OP_IMPORT: &str = "memory.import";

#[derive(Serialize, Deserialize)]
struct Header {
    #[serde(rename = "type")]
    kind: String,
    format_version: u64,
    schema_version: u64,
    exported_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct RecordVersionLine {
    #[serde(rename = "type")]
    kind: String,
    record_id: String,
    revision: u64,
    namespace: String,
    scope: MemoryScope,
    kind_of: MemoryKindWire,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    applicability: crate::MemoryApplicability,
    pinned: bool,
    content_sha256: String,
    dedupe_key: String,
    proposal_id: String,
    created_at: String,
}

/// Wire form of the record kind (avoids `kind` colliding with the line tag).
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MemoryKindWire {
    Fact,
    Preference,
    Procedure,
    Solution,
    Summary,
}

#[derive(Serialize, Deserialize, Clone)]
struct RecordHeadLine {
    #[serde(rename = "type")]
    kind: String,
    record_id: String,
    namespace: String,
    scope: MemoryScope,
    dedupe_key: String,
    current_revision: u64,
    status: RecordStatus,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct ProposalLine {
    #[serde(rename = "type")]
    kind: String,
    proposal_id: String,
    idempotency_key: String,
    operation: ProposalOperation,
    namespace: String,
    scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_record_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<MemoryPayload>,
    request_digest: String,
    proposer_id: String,
    status: ProposalStatus,
    revision: u64,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    decided_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ReviewLine {
    #[serde(rename = "type")]
    kind: String,
    proposal_id: String,
    idempotency_key: String,
    decision: ReviewDecision,
    reviewer_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    comment: Option<String>,
    expected_proposal_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    applied_record_revision: Option<u64>,
    created_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct FeedbackEventLine {
    #[serde(rename = "type")]
    kind: String,
    event_id: String,
    idempotency_key: String,
    record_id: String,
    revision: u64,
    feedback: FeedbackValue,
    created_at: String,
}

#[derive(Serialize, Deserialize, Default)]
struct Counts {
    #[serde(default)]
    record_version: u64,
    #[serde(default)]
    record_head: u64,
    #[serde(default)]
    proposal: u64,
    #[serde(default)]
    review: u64,
    #[serde(default)]
    feedback_event: u64,
}

#[derive(Serialize, Deserialize)]
struct Trailer {
    #[serde(rename = "type")]
    kind: String,
    counts: Counts,
    sha256: String,
}

fn export_err(message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorCode::IoError, OP_EXPORT, message.into())
}

fn import_err(message: impl Into<String>) -> ToolError {
    ToolError::new(ToolError::new_code(), OP_IMPORT, message.into())
}

impl ToolError {
    fn new_code() -> ToolErrorCode {
        ToolErrorCode::IntegrityError
    }
}

/// Export the canonical tables to `output` atomically: one consistency read,
/// a same-directory temp file (flushed + fsynced), then rename. An existing
/// target is a `conflict`; nothing is overwritten. Unix permissions 0600.
pub async fn export(store: &MemoryStore, output: &Path) -> Result<u64, ToolError> {
    if output.exists() {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            OP_EXPORT,
            "output file already exists; export never overwrites",
        )
        .with_path(output.to_string_lossy()));
    }
    let parent = output
        .parent()
        .ok_or_else(|| export_err("output path has no parent directory"))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| export_err(format!("create output parent: {e}")))?;

    let mut tx = store
        .pool()
        .begin()
        .await
        .map_err(|e| map_sqlx(&e, OP_EXPORT))?;

    let mut buffer = Vec::new();
    let header = Header {
        kind: "xuanling_memory_export".to_string(),
        format_version: FORMAT_VERSION,
        schema_version: SCHEMA_VERSION,
        exported_at: rfc3339(OffsetDateTime::now_utc()),
    };
    let mut counts = Counts::default();
    writeln_json(&mut buffer, &header)?;

    let versions = sqlx::query(
        "SELECT record_id, revision, namespace, scope_type, scope_project_id, \
         scope_workspace_id, kind, title, content, summary, applicability_json, pinned, \
         content_sha256, dedupe_key, proposal_id, created_at \
         FROM memory_record_versions ORDER BY record_id ASC, revision ASC",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| map_sqlx(&e, OP_EXPORT))?;
    for row in &versions {
        let record_id: String = row.try_get("record_id").map_err(integrity)?;
        let line = RecordVersionLine {
            kind: "record_version".to_string(),
            record_id,
            revision: row.try_get::<i64, _>("revision").map_err(integrity)? as u64,
            namespace: row.try_get("namespace").map_err(integrity)?,
            scope: row_scope(row)?,
            kind_of: serde_json::from_value::<MemoryKindWire>(serde_json::Value::String(
                row.try_get::<String, _>("kind").map_err(integrity)?,
            ))
            .map_err(|e| integrity_msg(format!("record kind: {e}")))?,
            title: row.try_get("title").map_err(integrity)?,
            content: row.try_get("content").map_err(integrity)?,
            summary: row.try_get("summary").map_err(integrity)?,
            tags: version_tags(&mut tx, row).await?,
            applicability: serde_json::from_str(
                row.try_get::<String, _>("applicability_json")
                    .map_err(integrity)?
                    .as_str(),
            )
            .map_err(|e| integrity_msg(format!("applicability: {e}")))?,
            pinned: row.try_get::<i64, _>("pinned").map_err(integrity)? != 0,
            content_sha256: row.try_get("content_sha256").map_err(integrity)?,
            dedupe_key: row.try_get("dedupe_key").map_err(integrity)?,
            proposal_id: row.try_get("proposal_id").map_err(integrity)?,
            created_at: row.try_get("created_at").map_err(integrity)?,
        };
        writeln_json(&mut buffer, &line)?;
        counts.record_version += 1;
    }

    let heads = sqlx::query(
        "SELECT record_id, namespace, scope_type, scope_project_id, scope_workspace_id, \
         dedupe_key, current_revision, status, created_at, updated_at \
         FROM memory_record_heads ORDER BY record_id ASC",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| map_sqlx(&e, OP_EXPORT))?;
    for row in &heads {
        let line = RecordHeadLine {
            kind: "record_head".to_string(),
            record_id: row.try_get("record_id").map_err(integrity)?,
            namespace: row.try_get("namespace").map_err(integrity)?,
            scope: row_scope(row)?,
            dedupe_key: row.try_get("dedupe_key").map_err(integrity)?,
            current_revision: row
                .try_get::<i64, _>("current_revision")
                .map_err(integrity)? as u64,
            status: RecordStatus::from_stored(
                row.try_get::<String, _>("status")
                    .map_err(integrity)?
                    .as_str(),
            )?,
            created_at: row.try_get("created_at").map_err(integrity)?,
            updated_at: row.try_get("updated_at").map_err(integrity)?,
        };
        writeln_json(&mut buffer, &line)?;
        counts.record_head += 1;
    }

    let proposals = sqlx::query(
        "SELECT proposal_id, idempotency_key, operation, namespace, scope_type, \
         scope_project_id, scope_workspace_id, target_record_id, target_revision, \
         payload_json, request_digest, proposer_id, status, revision, created_at, decided_at \
         FROM memory_proposals ORDER BY proposal_id ASC",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| map_sqlx(&e, OP_EXPORT))?;
    for row in &proposals {
        let line = ProposalLine {
            kind: "proposal".to_string(),
            proposal_id: row.try_get("proposal_id").map_err(integrity)?,
            idempotency_key: row.try_get("idempotency_key").map_err(integrity)?,
            operation: ProposalOperation::from_stored(
                row.try_get::<String, _>("operation")
                    .map_err(integrity)?
                    .as_str(),
            )?,
            namespace: row.try_get("namespace").map_err(integrity)?,
            scope: row_scope(row)?,
            target_record_id: row.try_get("target_record_id").map_err(integrity)?,
            target_revision: row
                .try_get::<Option<i64>, _>("target_revision")
                .map_err(integrity)?
                .map(|r| r as u64),
            payload: row
                .try_get::<Option<String>, _>("payload_json")
                .map_err(integrity)?
                .map(|json| {
                    serde_json::from_str(&json)
                        .map_err(|e| integrity_msg(format!("proposal payload: {e}")))
                })
                .transpose()?,
            request_digest: row.try_get("request_digest").map_err(integrity)?,
            proposer_id: row.try_get("proposer_id").map_err(integrity)?,
            status: ProposalStatus::from_stored(
                row.try_get::<String, _>("status")
                    .map_err(integrity)?
                    .as_str(),
            )?,
            revision: row.try_get::<i64, _>("revision").map_err(integrity)? as u64,
            created_at: row.try_get("created_at").map_err(integrity)?,
            decided_at: row.try_get("decided_at").map_err(integrity)?,
        };
        writeln_json(&mut buffer, &line)?;
        counts.proposal += 1;
    }

    let reviews = sqlx::query(
        "SELECT proposal_id, idempotency_key, decision, reviewer_id, comment, \
         expected_proposal_revision, applied_record_revision, created_at \
         FROM memory_reviews ORDER BY proposal_id ASC",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| map_sqlx(&e, OP_EXPORT))?;
    for row in &reviews {
        let decision = match row
            .try_get::<String, _>("decision")
            .map_err(integrity)?
            .as_str()
        {
            "approve" => ReviewDecision::Approve,
            "reject" => ReviewDecision::Reject,
            other => return Err(integrity_msg(format!("decision {other:?}"))),
        };
        let line = ReviewLine {
            kind: "review".to_string(),
            proposal_id: row.try_get("proposal_id").map_err(integrity)?,
            idempotency_key: row.try_get("idempotency_key").map_err(integrity)?,
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
        };
        writeln_json(&mut buffer, &line)?;
        counts.review += 1;
    }

    let events = sqlx::query(
        "SELECT event_id, idempotency_key, record_id, revision, feedback, created_at \
         FROM memory_feedback_events ORDER BY event_id ASC",
    )
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| map_sqlx(&e, OP_EXPORT))?;
    for row in &events {
        let feedback = match row
            .try_get::<String, _>("feedback")
            .map_err(integrity)?
            .as_str()
        {
            "helpful" => FeedbackValue::Helpful,
            "unhelpful" => FeedbackValue::Unhelpful,
            other => return Err(integrity_msg(format!("feedback {other:?}"))),
        };
        let line = FeedbackEventLine {
            kind: "feedback_event".to_string(),
            event_id: row.try_get("event_id").map_err(integrity)?,
            idempotency_key: row.try_get("idempotency_key").map_err(integrity)?,
            record_id: row.try_get("record_id").map_err(integrity)?,
            revision: row.try_get::<i64, _>("revision").map_err(integrity)? as u64,
            feedback,
            created_at: row.try_get("created_at").map_err(integrity)?,
        };
        writeln_json(&mut buffer, &line)?;
        counts.feedback_event += 1;
    }

    tx.commit().await.map_err(|e| map_sqlx(&e, OP_EXPORT))?;

    // Hash covers header..last entity line; the trailer is excluded.
    let digest = crate::sha256_hex(&buffer);
    let total = counts.record_version
        + counts.record_head
        + counts.proposal
        + counts.review
        + counts.feedback_event;
    let trailer = Trailer {
        kind: "trailer".to_string(),
        counts,
        sha256: digest,
    };
    writeln_json(&mut buffer, &trailer)?;

    let temp = same_dir_temp(output);
    write_private(&temp, &buffer)?;
    std::fs::rename(&temp, output).map_err(|e| export_err(format!("atomic rename failed: {e}")))?;
    Ok(total)
}

async fn version_tags(
    tx: &mut sqlx::SqliteConnection,
    row: &sqlx::sqlite::SqliteRow,
) -> Result<Vec<String>, ToolError> {
    let record_id: String = row.try_get("record_id").map_err(integrity)?;
    let revision: i64 = row.try_get("revision").map_err(integrity)?;
    let rows = sqlx::query(
        "SELECT tag FROM memory_record_tags WHERE record_id = ? AND revision = ? ORDER BY tag ASC",
    )
    .bind(&record_id)
    .bind(revision)
    .fetch_all(&mut *tx)
    .await
    .map_err(|e| map_sqlx(&e, OP_EXPORT))?;
    rows.iter()
        .map(|r| r.try_get::<String, _>(0).map_err(integrity))
        .collect::<Result<_, _>>()
}

fn row_scope(row: &sqlx::sqlite::SqliteRow) -> Result<MemoryScope, ToolError> {
    MemoryScope::from_columns(
        row.try_get::<String, _>("scope_type")
            .map_err(integrity)?
            .as_str(),
        row.try_get::<Option<String>, _>("scope_project_id")
            .map_err(integrity)?
            .as_deref(),
        row.try_get::<Option<String>, _>("scope_workspace_id")
            .map_err(integrity)?
            .as_deref(),
    )
}

fn writeln_json<T: Serialize>(buffer: &mut Vec<u8>, value: &T) -> Result<(), ToolError> {
    let mut line = serde_json::to_string(value)
        .map_err(|e| export_err(format!("serialization failed: {e}")))?;
    line.push('\n');
    buffer.extend_from_slice(line.as_bytes());
    Ok(())
}

fn same_dir_temp(target: &Path) -> std::path::PathBuf {
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".to_string());
    target
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".{name}.tmp-{}", std::process::id()))
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), ToolError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| export_err(format!("create temp file: {e}")))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| export_err(format!("write temp file: {e}")))?;
    }
    #[cfg(not(unix))]
    {
        let mut file = std::fs::File::create(path)
            .map_err(|e| export_err(format!("create temp file: {e}")))?;
        file.write_all(bytes)
            .map_err(|e| export_err(format!("write temp file: {e}")))?;
    }
    Ok(())
}

fn integrity(e: sqlx::Error) -> ToolError {
    integrity_msg(format!("column access failed: {e}"))
}

fn integrity_msg(message: String) -> ToolError {
    ToolError::new(ToolErrorCode::IntegrityError, OP_EXPORT, message)
}

/// Import a canonical JSONL file into an EMPTY store: full validation first
/// (format, hash, counts, references, lifecycle), then one transaction that
/// inserts every canonical row and rebuilds the FTS projection. Any failure
/// leaves the target empty.
pub async fn import(store: &MemoryStore, input: &Path) -> Result<u64, ToolError> {
    let bytes = std::fs::read(input)
        .map_err(|e| ToolError::new(ToolErrorCode::IoError, OP_IMPORT, e.to_string()))?;
    let text =
        std::str::from_utf8(&bytes).map_err(|e| import_err(format!("input is not UTF-8: {e}")))?;
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.len() < 2 {
        return Err(import_err("file must contain a header and a trailer"));
    }

    // --- validate ---
    let header: Header =
        serde_json::from_str(lines[0]).map_err(|e| import_err(format!("header: {e}")))?;
    if header.kind != "xuanling_memory_export"
        || header.format_version != FORMAT_VERSION
        || header.schema_version != SCHEMA_VERSION
    {
        return Err(import_err(format!(
            "unsupported export header (type={:?}, format_version={}, schema_version={}); \
             expected format_version={FORMAT_VERSION}, schema_version={SCHEMA_VERSION}",
            header.kind, header.format_version, header.schema_version
        )));
    }
    let trailer: Trailer = serde_json::from_str(lines[lines.len() - 1])
        .map_err(|e| import_err(format!("trailer: {e}")))?;
    if trailer.kind != "trailer" {
        return Err(import_err("last line must be the trailer"));
    }
    let hashed = &bytes[..bytes.len() - lines[lines.len() - 1].len() - 1];
    let digest = crate::sha256_hex(hashed);
    if digest != trailer.sha256 {
        return Err(ToolError::new(
            ToolErrorCode::IntegrityError,
            OP_IMPORT,
            "checksum mismatch",
        )
        .with_details(serde_json::json!({
            "expected": trailer.sha256,
            "actual": digest,
        })));
    }

    let mut versions: Vec<RecordVersionLine> = Vec::new();
    let mut heads: Vec<RecordHeadLine> = Vec::new();
    let mut proposals: Vec<ProposalLine> = Vec::new();
    let mut reviews: Vec<ReviewLine> = Vec::new();
    let mut events: Vec<FeedbackEventLine> = Vec::new();
    for (index, line) in lines[1..lines.len() - 1].iter().enumerate() {
        let value: Value = serde_json::from_str(line)
            .map_err(|e| import_err(format!("entity line {}: {e}", index + 2)))?;
        let kind = value["type"].as_str().unwrap_or_default();
        match kind {
            "record_version" => versions.push(
                serde_json::from_value(value)
                    .map_err(|e| import_err(format!("record_version line {}: {e}", index + 2)))?,
            ),
            "record_head" => heads.push(
                serde_json::from_value(value)
                    .map_err(|e| import_err(format!("record_head line {}: {e}", index + 2)))?,
            ),
            "proposal" => proposals.push(
                serde_json::from_value(value)
                    .map_err(|e| import_err(format!("proposal line {}: {e}", index + 2)))?,
            ),
            "review" => reviews.push(
                serde_json::from_value(value)
                    .map_err(|e| import_err(format!("review line {}: {e}", index + 2)))?,
            ),
            "feedback_event" => events.push(
                serde_json::from_value(value)
                    .map_err(|e| import_err(format!("feedback_event line {}: {e}", index + 2)))?,
            ),
            other => return Err(import_err(format!("unknown entity type {other:?}"))),
        }
    }
    let counts = Counts {
        record_version: versions.len() as u64,
        record_head: heads.len() as u64,
        proposal: proposals.len() as u64,
        review: reviews.len() as u64,
        feedback_event: events.len() as u64,
    };
    if counts.record_version != trailer.counts.record_version
        || counts.record_head != trailer.counts.record_head
        || counts.proposal != trailer.counts.proposal
        || counts.review != trailer.counts.review
        || counts.feedback_event != trailer.counts.feedback_event
    {
        return Err(import_err("entity counts do not match the trailer"));
    }

    // Cross-reference and lifecycle validation.
    use std::collections::{HashMap, HashSet};
    let proposal_ids: HashSet<&str> = proposals.iter().map(|p| p.proposal_id.as_str()).collect();
    let mut version_keys: HashSet<(String, u64)> = HashSet::new();
    for v in &versions {
        if v.revision == 0 || !proposal_ids.contains(v.proposal_id.as_str()) {
            return Err(import_err(format!(
                "record_version {} references unknown proposal {}",
                v.record_id, v.proposal_id
            )));
        }
        if !version_keys.insert((v.record_id.clone(), v.revision)) {
            return Err(import_err(format!(
                "duplicate record_version key {}",
                v.record_id
            )));
        }
        let recomputed = crate::store::compute_dedupe_key(&v.content, &v.namespace);
        if recomputed != v.dedupe_key {
            return Err(import_err(format!(
                "record_version {} dedupe_key does not match its content",
                v.record_id
            )));
        }
        if crate::sha256_hex(v.content.as_bytes()) != v.content_sha256 {
            return Err(import_err(format!(
                "record_version {} content_sha256 mismatch",
                v.record_id
            )));
        }
    }
    let mut head_ids: HashSet<&str> = HashSet::new();
    for h in &heads {
        if !head_ids.insert(h.record_id.as_str()) {
            return Err(import_err(format!("duplicate record_head {}", h.record_id)));
        }
        if !version_keys.contains(&(h.record_id.clone(), h.current_revision)) {
            return Err(import_err(format!(
                "record_head {} points at missing revision {}",
                h.record_id, h.current_revision
            )));
        }
    }
    let mut proposal_idem: HashSet<&str> = HashSet::new();
    let mut review_by_proposal: HashMap<&str, &ReviewLine> = HashMap::new();
    let mut review_idem: HashSet<&str> = HashSet::new();
    for r in &reviews {
        if !proposal_ids.contains(r.proposal_id.as_str()) {
            return Err(import_err(format!(
                "review references unknown proposal {}",
                r.proposal_id
            )));
        }
        if review_by_proposal
            .insert(r.proposal_id.as_str(), r)
            .is_some()
        {
            return Err(import_err(format!(
                "proposal {} has more than one review",
                r.proposal_id
            )));
        }
        if !review_idem.insert(r.idempotency_key.as_str()) {
            return Err(import_err("duplicate review idempotency_key"));
        }
    }
    for p in &proposals {
        if !proposal_idem.insert(p.idempotency_key.as_str()) {
            return Err(import_err("duplicate proposal idempotency_key"));
        }
        if p.revision != 1 && p.revision != 2 {
            return Err(import_err(format!(
                "proposal {} revision must be 1 or 2",
                p.proposal_id
            )));
        }
        let terminal = matches!(
            p.status,
            ProposalStatus::Approved | ProposalStatus::Rejected
        );
        let review = review_by_proposal.get(p.proposal_id.as_str()).copied();
        if terminal && review.is_none() {
            return Err(import_err(format!(
                "terminal proposal {} has no review",
                p.proposal_id
            )));
        }
        if !terminal && (review.is_some() || p.decided_at.is_some()) {
            return Err(import_err(format!(
                "pending proposal {} must have no review or decided_at",
                p.proposal_id
            )));
        }
        if matches!(p.operation, ProposalOperation::Create) && p.payload.is_none() {
            return Err(import_err(format!(
                "create proposal {} must carry a payload",
                p.proposal_id
            )));
        }
        if let Some(target) = &p.target_record_id {
            let target_revision = p.target_revision.unwrap_or(0);
            if !version_keys.contains(&(target.clone(), target_revision)) {
                return Err(import_err(format!(
                    "proposal {} targets missing version {target}@{target_revision}",
                    p.proposal_id
                )));
            }
        }
    }
    let mut event_idem: HashSet<&str> = HashSet::new();
    for e in &events {
        if !event_idem.insert(e.idempotency_key.as_str()) {
            return Err(import_err("duplicate feedback idempotency_key"));
        }
        if !version_keys.contains(&(e.record_id.clone(), e.revision)) {
            return Err(import_err(format!(
                "feedback event {} targets missing version {}@{}",
                e.event_id, e.record_id, e.revision
            )));
        }
    }

    // --- target must be empty ---
    let (empty,): (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM memory_record_versions) + \
                (SELECT COUNT(*) FROM memory_proposals) + \
                (SELECT COUNT(*) FROM memory_feedback_events)",
    )
    .fetch_one(store.pool())
    .await
    .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    if empty != 0 {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            OP_IMPORT,
            "import target is not empty; only empty databases can be imported into",
        ));
    }

    // --- single-transaction insert + projection rebuild ---
    let mut tx = store
        .pool()
        .begin()
        .await
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    for v in &versions {
        let kind_word = match v.kind_of {
            MemoryKindWire::Fact => "fact",
            MemoryKindWire::Preference => "preference",
            MemoryKindWire::Procedure => "procedure",
            MemoryKindWire::Solution => "solution",
            MemoryKindWire::Summary => "summary",
        };
        sqlx::query(
            "INSERT INTO memory_record_versions \
             (record_id, revision, namespace, scope_type, scope_project_id, scope_workspace_id, \
              scope_key, kind, title, content, summary, applicability_json, pinned, \
              content_sha256, dedupe_key, proposal_id, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&v.record_id)
        .bind(v.revision as i64)
        .bind(&v.namespace)
        .bind(v.scope.type_name())
        .bind(v.scope.project_id())
        .bind(v.scope.workspace_id())
        .bind(v.scope.scope_key())
        .bind(kind_word)
        .bind(&v.title)
        .bind(&v.content)
        .bind(&v.summary)
        .bind(serde_json::to_string(&v.applicability).expect("applicability serializes"))
        .bind(v.pinned as i64)
        .bind(&v.content_sha256)
        .bind(&v.dedupe_key)
        .bind(&v.proposal_id)
        .bind(&v.created_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
        for tag in &v.tags {
            sqlx::query(
                "INSERT INTO memory_record_tags (record_id, revision, tag) VALUES (?, ?, ?)",
            )
            .bind(&v.record_id)
            .bind(v.revision as i64)
            .bind(tag)
            .execute(&mut *tx)
            .await
            .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
        }
    }
    for h in &heads {
        sqlx::query(
            "INSERT INTO memory_record_heads \
             (record_id, namespace, scope_type, scope_project_id, scope_workspace_id, \
              scope_key, dedupe_key, current_revision, status, created_at, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&h.record_id)
        .bind(&h.namespace)
        .bind(h.scope.type_name())
        .bind(h.scope.project_id())
        .bind(h.scope.workspace_id())
        .bind(h.scope.scope_key())
        .bind(&h.dedupe_key)
        .bind(h.current_revision as i64)
        .bind(match h.status {
            RecordStatus::Active => "active",
            RecordStatus::Archived => "archived",
        })
        .bind(&h.created_at)
        .bind(&h.updated_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    }
    for p in &proposals {
        sqlx::query(
            "INSERT INTO memory_proposals \
             (proposal_id, idempotency_key, operation, namespace, scope_type, \
              scope_project_id, scope_workspace_id, scope_key, target_record_id, \
              target_revision, payload_json, request_digest, proposer_id, status, \
              revision, created_at, decided_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&p.proposal_id)
        .bind(&p.idempotency_key)
        .bind(p.operation.as_str())
        .bind(&p.namespace)
        .bind(p.scope.type_name())
        .bind(p.scope.project_id())
        .bind(p.scope.workspace_id())
        .bind(p.scope.scope_key())
        .bind(&p.target_record_id)
        .bind(p.target_revision.map(|r| r as i64))
        .bind(
            p.payload
                .as_ref()
                .map(|payload| serde_json::to_string(payload).expect("payload serializes")),
        )
        .bind(&p.request_digest)
        .bind(&p.proposer_id)
        .bind(match p.status {
            ProposalStatus::Pending => "pending",
            ProposalStatus::Approved => "approved",
            ProposalStatus::Rejected => "rejected",
        })
        .bind(p.revision as i64)
        .bind(&p.created_at)
        .bind(&p.decided_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    }
    for r in &reviews {
        sqlx::query(
            "INSERT INTO memory_reviews \
             (proposal_id, idempotency_key, decision, reviewer_id, comment, \
              expected_proposal_revision, applied_record_revision, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&r.proposal_id)
        .bind(&r.idempotency_key)
        .bind(match r.decision {
            ReviewDecision::Approve => "approve",
            ReviewDecision::Reject => "reject",
        })
        .bind(&r.reviewer_id)
        .bind(&r.comment)
        .bind(r.expected_proposal_revision as i64)
        .bind(r.applied_record_revision.map(|v| v as i64))
        .bind(&r.created_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    }
    for e in &events {
        sqlx::query(
            "INSERT INTO memory_feedback_events \
             (event_id, idempotency_key, record_id, revision, feedback, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&e.event_id)
        .bind(&e.idempotency_key)
        .bind(&e.record_id)
        .bind(e.revision as i64)
        .bind(match e.feedback {
            FeedbackValue::Helpful => "helpful",
            FeedbackValue::Unhelpful => "unhelpful",
        })
        .bind(&e.created_at)
        .execute(&mut *tx)
        .await
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    }

    // Rebuild the active-only projection from the imported canonical rows.
    sqlx::query("DELETE FROM memory_fts_v2_unicode")
        .execute(&mut *tx)
        .await
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    sqlx::query("DELETE FROM memory_fts_v2_trigram")
        .execute(&mut *tx)
        .await
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    let active = sqlx::query(
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
    .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    for row in &active {
        let record_id: String = row.try_get("record_id").map_err(integrity)?;
        let title: Option<String> = row.try_get("title").map_err(integrity)?;
        let content: String = row.try_get("content").map_err(integrity)?;
        let summary: Option<String> = row.try_get("summary").map_err(integrity)?;
        let tags: String = row.try_get("tags").map_err(integrity)?;
        // Static queries (SqlSafeStr): both tables explicitly.
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
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
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
        .map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    }

    tx.commit().await.map_err(|e| map_sqlx(&e, OP_IMPORT))?;
    Ok(counts.record_version
        + counts.record_head
        + counts.proposal
        + counts.review
        + counts.feedback_event)
}
