//! Memory store: SQLite persistence for the v2 proposal/review schema.
//!
//! Fresh v2 databases only: opening a legacy v1 database (detected by the
//! v1-only `memory_records` table) is refused before any migration runs — no
//! v1 data is migrated, repaired, or modified.

pub mod v2;

use std::path::{Path, PathBuf};
use std::str::FromStr;

use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};

use crate::error::{ToolError, ToolErrorCode};

pub use crate::proposal::{
    CandidateArchiveRequest, CandidateCreateRequest, CandidateGetRequest, CandidateListRequest,
    CandidateListResult, CandidateReplaceRequest, FeedbackEventRequest, FeedbackEventResult,
    FeedbackValue, MemoryPayload, MemoryRecordView, ProposalOperation, ProposalStatus,
    ProposalView, RecordGetRequest, RecordStatus, ReviewDecision, ReviewRequest, ReviewView,
    ScopeMode, SearchItemV2, SearchRequestV2, SearchResultV2,
};

/// Default DB path: `~/.xuanling/memory.db` (memory v2). `None` when neither
/// HOME nor USERPROFILE resolves; callers must surface `unavailable` instead
/// of falling back to the working directory.
pub fn default_db_path() -> Option<PathBuf> {
    dirs_home().map(|home| home.join(".xuanling/memory.db"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

/// The toolkit-owned SQLite pool. Cheaply cloneable.
#[derive(Clone)]
pub struct MemoryStore {
    pool: SqlitePool,
}

impl MemoryStore {
    /// Open (and migrate) the memory DB at `path`. Enables foreign keys, WAL,
    /// and a caller-configured busy timeout. Refuses legacy v1 databases
    /// before running any migration. If the bundled SQLite lacks the FTS5
    /// trigram tokenizer, returns `unsupported` with a capability probe.
    pub async fn open(path: &Path, busy_timeout_ms: u32) -> Result<Self, ToolError> {
        // Ensure parent dir exists.
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                ToolError::new(ToolErrorCode::IoError, "memory.open", e.to_string())
                    .with_path(path.to_string_lossy())
            })?;
        }

        // Build options from the raw filesystem path (via `.filename`) rather
        // than a `sqlite://` URL. A URL would percent-decode the path and split
        // on `#`/`?`, breaking paths that contain those bytes.
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .foreign_keys(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_millis(busy_timeout_ms as u64));

        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(options)
            .await
            .map_err(|e| map_sqlx(&e, "memory.open"))?;

        refuse_legacy_v1(&pool).await?;
        run_migrations(&pool).await?;
        probe_trigram(&pool).await?;

        Ok(Self { pool })
    }

    /// In-memory DB for tests.
    pub async fn open_in_memory() -> Result<Self, ToolError> {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .map_err(|e| ToolError::new(ToolErrorCode::InvalidInput, "memory.open", e.to_string()))?
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .map_err(|e| map_sqlx(&e, "memory.open"))?;
        refuse_legacy_v1(&pool).await?;
        run_migrations(&pool).await?;
        probe_trigram(&pool).await?;
        Ok(Self { pool })
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }
}

/// Refuse legacy v1 databases without reading or modifying them (plan W3.7):
/// the v1-only `memory_records` table marks the file as schema v1 (including
/// hybrid v1+v2 files created before the isolation fix).
async fn refuse_legacy_v1(pool: &SqlitePool) -> Result<(), ToolError> {
    let legacy =
        sqlx::query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_records'")
            .fetch_optional(pool)
            .await
            .map_err(|e| map_sqlx(&e, "memory.open"))?;
    if legacy.is_some() {
        return Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "memory.open",
            "legacy v1 memory database detected; this build only opens fresh v2 \
             databases — choose a new --memory-db path (no migration, no repair)",
        ));
    }
    Ok(())
}

async fn run_migrations(pool: &SqlitePool) -> Result<(), ToolError> {
    sqlx::migrate!("./migrations")
        .run(pool)
        .await
        .map_err(|e| map_migrate(&e, "memory.open"))
}

/// Verify the bundled SQLite supports the FTS5 trigram tokenizer. If missing,
/// return `unsupported` with a diagnostic; callers must stop rather than
/// silently degrade to unicode61-only recall.
async fn probe_trigram(pool: &SqlitePool) -> Result<(), ToolError> {
    let res: Result<(i64,), _> = sqlx::query_as(
        "SELECT 1 FROM pragma_compile_options() WHERE compile_options = 'ENABLE_FTS5'",
    )
    .fetch_one(pool)
    .await;
    if res.is_err() {
        return Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "memory.open",
            "bundled SQLite lacks FTS5; cannot create recall indexes",
        ));
    }
    // Try creating+dropping a throwaway trigram FTS table to confirm the
    // tokenizer is available at runtime.
    let probe = sqlx::query(
        "CREATE VIRTUAL TABLE IF NOT EXISTS __trigram_probe USING fts5(x, tokenize='trigram')",
    )
    .execute(pool)
    .await;
    let _ = sqlx::query("DROP TABLE IF EXISTS __trigram_probe")
        .execute(pool)
        .await;
    if probe.is_err() {
        return Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "memory.open",
            "bundled SQLite FTS5 lacks the trigram tokenizer; CJK recall would silently degrade",
        )
        .with_details(serde_json::json!({"tokenizer_required": "trigram"})));
    }
    Ok(())
}

pub(crate) fn map_sqlx(e: &sqlx::Error, op: &str) -> ToolError {
    let code = match e {
        sqlx::Error::Database(db) => {
            let msg = db.message();
            if msg.contains("locked") || msg.contains("busy") {
                ToolErrorCode::DatabaseBusy
            } else if msg.contains("UNIQUE constraint failed") {
                ToolErrorCode::Conflict
            } else {
                ToolErrorCode::IoError
            }
        }
        _ => ToolErrorCode::IoError,
    };
    ToolError::new(code, op, e.to_string())
}

pub(crate) fn map_migrate(e: &sqlx::migrate::MigrateError, op: &str) -> ToolError {
    ToolError::new(ToolErrorCode::IoError, op, format!("migration failed: {e}"))
}

/// Format an OffsetDateTime as RFC3339 for storage.
pub(crate) fn rfc3339(t: time::OffsetDateTime) -> String {
    t.format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| t.to_string())
}

/// Parse an RFC3339 timestamp.
#[allow(dead_code)]
pub(crate) fn parse_rfc3339(s: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
}

/// Compute the dedupe key: Unicode NFC + newline normalize + trim; no internal
/// whitespace fold, no lower-case. NFC means canonically equivalent strings
/// (e.g. composed vs decomposed accents) dedupe together.
pub(crate) fn compute_dedupe_key(content: &str, namespace: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let unified = content.replace("\r\n", "\n").replace('\r', "\n");
    let normalized: String = unified.trim().nfc().collect();
    format!("{namespace}\x1f{normalized}")
}

/// Compute content_sha256 = SHA-256 of the raw UTF-8 bytes, hex-encoded.
pub(crate) fn compute_content_sha256(content: &str) -> String {
    crate::sha256_hex(content.as_bytes())
}
