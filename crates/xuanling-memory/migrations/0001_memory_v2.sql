-- XuanLing memory v2 canonical schema (proposal/review + immutable versions).
--
-- v2 replaces direct CRUD: every create/replace/archive only produces a
-- pending proposal; only a review carrying a proposal-revision CAS can
-- atomically activate it (insert immutable record version, CAS the head,
-- refresh the active FTS projection, record the terminal review).
--
-- Legacy v1 databases are REFUSED by the store before any migration runs:
-- presence of the v1-only `memory_records` table marks the file as v1. No v1
-- data is migrated or modified.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory_schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR REPLACE INTO memory_schema_meta (key, value) VALUES ('schema_version', '2');

-- Immutable record versions. Payload is complete per revision; nothing is
-- ever updated in place.
CREATE TABLE IF NOT EXISTS memory_record_versions (
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    namespace TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'project', 'workspace')),
    scope_project_id TEXT,
    scope_workspace_id TEXT,
    scope_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'procedure', 'solution', 'summary')),
    title TEXT,
    content TEXT NOT NULL,
    summary TEXT,
    applicability_json TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0,
    content_sha256 TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (record_id, revision)
);

-- Current head per record: current revision plus active/archived status.
-- Archive only flips the status; no row is ever deleted.
CREATE TABLE IF NOT EXISTS memory_record_heads (
    record_id TEXT PRIMARY KEY,
    namespace TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'project', 'workspace')),
    scope_project_id TEXT,
    scope_workspace_id TEXT,
    scope_key TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
    status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Active dedupe: namespace + exact scope + NFC/newline-normalized content.
-- NULL scope ids would break UNIQUE semantics in SQLite, so the denormalized
-- `scope_key` carries the canonical scope identity instead.
CREATE UNIQUE INDEX IF NOT EXISTS memory_active_dedupe
ON memory_record_heads(namespace, scope_key, dedupe_key)
WHERE status = 'active';

-- Version-scoped canonical tags.
CREATE TABLE IF NOT EXISTS memory_record_tags (
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (record_id, revision, tag),
    FOREIGN KEY (record_id, revision)
        REFERENCES memory_record_versions(record_id, revision)
        ON DELETE CASCADE
);

-- Pending or terminal proposals. `revision` is 1 while pending and 2 once a
-- terminal review has been applied (the CAS input for reviews).
CREATE TABLE IF NOT EXISTS memory_proposals (
    proposal_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'replace', 'archive')),
    namespace TEXT NOT NULL,
    scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'project', 'workspace')),
    scope_project_id TEXT,
    scope_workspace_id TEXT,
    scope_key TEXT NOT NULL,
    target_record_id TEXT,
    target_revision INTEGER,
    payload_json TEXT,
    request_digest TEXT NOT NULL,
    proposer_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision IN (1, 2)),
    created_at TEXT NOT NULL,
    decided_at TEXT
);

-- At most one terminal review per proposal. A failed review writes nothing.
CREATE TABLE IF NOT EXISTS memory_reviews (
    proposal_id TEXT PRIMARY KEY
        REFERENCES memory_proposals(proposal_id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL UNIQUE,
    decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
    reviewer_id TEXT NOT NULL,
    comment TEXT,
    expected_proposal_revision INTEGER NOT NULL,
    applied_record_revision INTEGER,
    created_at TEXT NOT NULL
);

-- Append-only, version-bound feedback. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS memory_feedback_events (
    event_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    feedback TEXT NOT NULL CHECK (feedback IN ('helpful', 'unhelpful')),
    created_at TEXT NOT NULL
);

-- Derived active-only lexical projection (W4 refines recall; W3 keeps the
-- tables and maintains them from the review transaction). Never exported.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_v2_unicode USING fts5(
    record_id UNINDEXED,
    title,
    content,
    summary,
    tags,
    tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts_v2_trigram USING fts5(
    record_id UNINDEXED,
    title,
    content,
    summary,
    tags,
    tokenize = 'trigram'
);
