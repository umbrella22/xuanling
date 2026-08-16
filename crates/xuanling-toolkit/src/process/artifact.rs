//! Controlled raw-artifact store for bounded process output (ADR 0027 §6).
//!
//! An artifact reference is a server-owned record id, never a caller-supplied
//! filesystem path. Records carry ownership, retention and cleanup facts;
//! objects are addressed by their SHA-256 and are verified before every read.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::error::{ToolError, ToolErrorCode};

const DEFAULT_RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const DEFAULT_QUARANTINE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Public immutable reference to one server-owned artifact record.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactRef {
    /// Opaque record id. It is not a filesystem path and is validated before
    /// lookup, so callers cannot use it to escape the artifact store.
    pub id: String,
    pub kind: String,
    /// Opaque store key. Currently equal to `id`; retained as an explicit
    /// boundary so clients never infer an on-disk path.
    pub store_key: String,
    /// SHA-256 of the complete raw object (lowercase hex).
    pub sha256: String,
    pub size_bytes: u64,
    /// `raw`: exact process bytes, never a lossy text projection.
    pub encoding: String,
    pub lossy: bool,
    pub retention_class: String,
    /// RFC3339 UTC record creation time.
    pub created_at: String,
    /// Opaque invocation identity that created the record. This is audit
    /// metadata, not an authorization principal.
    pub owner: String,
    /// Bearer capability required by `artifact_read`. It is deliberately
    /// distinct from `owner`, because identity metadata is not authorization.
    pub read_capability: String,
    /// Current MCP stdio scope. Authorization still belongs to the host.
    pub scope: String,
    pub cleanup_state: ArtifactCleanupState,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ArtifactCleanupState {
    Active,
    Quarantined,
    Purged,
}

/// Controlled read request. `id` is the only locator accepted; there is no
/// path field. `length` uses bytes; callers decide whether an omitted length
/// means a bounded default or an explicit complete read at their own boundary.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReadRequest {
    pub id: String,
    /// Bearer capability copied from the producing `ArtifactRef`.
    pub read_capability: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReadResult {
    pub id: String,
    /// Base64 of exact raw bytes in this window.
    pub base64: String,
    pub offset: u64,
    pub length: u64,
    pub total_bytes: u64,
    pub sha256: String,
    pub truncated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_offset: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactCleanupRequest {
    /// `true` reports candidates without moving/purging anything.
    #[serde(default)]
    pub dry_run: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ArtifactCleanupResult {
    pub dry_run: bool,
    pub quarantined_ids: Vec<String>,
    pub purged_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
struct ArtifactRecord {
    version: u8,
    artifact: ArtifactRef,
    /// SHA-addressed object filename, never sourced from an MCP request.
    object_key: String,
    expires_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quarantined_at: Option<String>,
}

struct StorePaths {
    root: PathBuf,
    staging: PathBuf,
    objects: PathBuf,
    records: PathBuf,
    quarantine: PathBuf,
    purging: PathBuf,
}

impl StorePaths {
    fn current_config() -> Self {
        let root = std::env::var_os("XUANLING_ARTIFACT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("xuanling-mcp-artifacts"));
        Self {
            staging: root.join("staging"),
            objects: root.join("objects"),
            records: root.join("records"),
            quarantine: root.join("quarantine"),
            purging: root.join("purging"),
            root,
        }
    }

    fn for_current_config() -> Result<Self, ToolError> {
        let paths = Self::current_config();
        for dir in [
            &paths.root,
            &paths.staging,
            &paths.objects,
            &paths.records,
            &paths.quarantine,
            &paths.purging,
        ] {
            std::fs::create_dir_all(dir).map_err(|error| artifact_io_error(error, dir))?;
            set_private_dir_permissions(dir).map_err(|error| artifact_io_error(error, dir))?;
        }
        Ok(paths)
    }

    fn record_path(&self, id: &str) -> PathBuf {
        self.records.join(format!("{id}.json"))
    }

    fn quarantined_record_path(&self, id: &str) -> PathBuf {
        self.quarantine.join(format!("{id}.json"))
    }

    fn purging_record_path(&self, id: &str) -> PathBuf {
        self.purging.join(format!("{id}.json"))
    }

    fn object_path(&self, object_key: &str) -> PathBuf {
        self.objects.join(format!("{object_key}.bin"))
    }

    fn lock_path(&self) -> PathBuf {
        self.root.join(".store.lock")
    }

    fn quota_path(&self) -> PathBuf {
        self.root.join(".quota")
    }

    fn quota_limit_path(&self) -> PathBuf {
        self.root.join(".quota-limit")
    }
}

struct StoreLock(std::fs::File);

impl StoreLock {
    fn acquire(paths: &StorePaths) -> Result<Self, ToolError> {
        let lock_path = paths.lock_path();
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|error| artifact_io_error(error, &lock_path))?;
        set_private_file_permissions(&lock_path)
            .map_err(|error| artifact_io_error(error, &lock_path))?;
        std::fs::File::lock(&file).map_err(|error| artifact_io_error(error, &lock_path))?;
        Ok(Self(file))
    }

    fn acquire_existing(paths: &StorePaths) -> Result<Option<Self>, ToolError> {
        let lock_path = paths.lock_path();
        let file = match std::fs::OpenOptions::new().read(true).open(&lock_path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(artifact_io_error(error, &lock_path)),
        };
        std::fs::File::lock_shared(&file).map_err(|error| artifact_io_error(error, &lock_path))?;
        Ok(Some(Self(file)))
    }
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = std::fs::File::unlock(&self.0);
    }
}

/// A staging writer for one raw object. It is published only after fsync,
/// hash/address validation, object install and record install all succeed.
pub struct ArtifactWriter {
    paths: StorePaths,
    file: Option<std::fs::File>,
    staging_path: PathBuf,
    hasher: Sha256,
    written: u64,
    id: String,
    kind: String,
    owner: String,
    quota_reserved: u64,
    finalized: bool,
}

impl ArtifactWriter {
    pub fn create(kind: &str, owner: &str) -> Result<Self, ToolError> {
        let paths = StorePaths::for_current_config()?;
        let configured_limit = configured_quota_limit()?;
        let id = uuid::Uuid::now_v7().to_string();
        let staging_path = paths.staging.join(format!("{id}.tmp"));
        let _store_lock = StoreLock::acquire(&paths)?;
        // The quota limit is the shared store's configuration identity. Check
        // it before cleanup, orphan removal, staging recovery, or ledger
        // reconciliation so conflicting configuration cannot mutate the store.
        ensure_quota_limit(&paths, configured_limit)?;
        // A best-effort maintenance pass keeps expired raw data from consuming
        // quota indefinitely. Corrupt records fail closed rather than being
        // silently deleted or interpreted as paths.
        // Maintenance must never make a fresh invocation fail because an
        // artifact record from an older schema/release is unreadable. Public
        // `artifact_cleanup` remains strict and reports corruption; this
        // best-effort sweep only prevents stale records from blocking output
        // capture during a schema migration.
        let _ = cleanup_store_locked(&paths, false);
        // `finalize` publishes object + record while holding this same lock.
        // Once the lock is reacquired, an object with no record reference can
        // only be crash residue and is safe to remove before quota rebuild.
        let _ = remove_unreferenced_objects(&paths);
        // Reconciliation is cheap relative to starting a new capture and is
        // the recovery boundary for a process that died between reserving
        // quota and publishing/removing its staging file.
        reconcile_quota(&paths)?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&staging_path)
            .map_err(|error| artifact_io_error(error, &staging_path))?;
        set_private_file_permissions(&staging_path)
            .map_err(|error| artifact_io_error(error, &staging_path))?;
        // The file lock is a liveness lease. Another server can distinguish an
        // active capture from staging left by a crashed process when rebuilding
        // the shared quota counter.
        std::fs::File::lock(&file).map_err(|error| artifact_io_error(error, &staging_path))?;
        Ok(Self {
            paths,
            file: Some(file),
            staging_path,
            hasher: Sha256::new(),
            written: 0,
            id,
            kind: kind.to_string(),
            owner: owner.to_string(),
            quota_reserved: 0,
            finalized: false,
        })
    }

    pub fn write_chunk(&mut self, chunk: &[u8]) -> Result<(), ToolError> {
        let _store_lock = StoreLock::acquire(&self.paths)?;
        reserve_quota(&self.paths, chunk.len() as u64)?;
        self.quota_reserved += chunk.len() as u64;
        let file = self
            .file
            .as_mut()
            .expect("artifact writer file exists until finalize");
        if let Err(error) = file.write_all(chunk) {
            // A partial write cannot be included in the running hash. Remove
            // the complete staging object while the store lock is held. If
            // removal fails, retain the conservative reservation; a later
            // reconciliation will recover its exact on-disk size.
            self.discard_staging_locked();
            return Err(artifact_io_error(error, &self.staging_path));
        }
        self.hasher.update(chunk);
        self.written += chunk.len() as u64;
        Ok(())
    }

    pub fn finalize(mut self) -> Result<ArtifactRef, ToolError> {
        let file = self
            .file
            .as_ref()
            .expect("artifact writer file exists until finalize");
        file.sync_all()
            .map_err(|error| artifact_io_error(error, &self.staging_path))?;

        let sha256 = hex_lower(&self.hasher.clone().finalize());
        let _store_lock = StoreLock::acquire(&self.paths)?;
        let file = self
            .file
            .take()
            .expect("artifact writer file exists until finalize");
        let _ = std::fs::File::unlock(&file);
        drop(file);
        let object_path = self.paths.object_path(&sha256);
        // Publish with create-if-absent semantics. The staging inode is already
        // private and fsync'd; a hard link exposes that complete inode under
        // its content address without the exists+rename race that could make
        // concurrent identical writers count one object twice.
        let object_preexisted = match std::fs::hard_link(&self.staging_path, &object_path) {
            Ok(()) => {
                if let Err(error) = std::fs::remove_file(&self.staging_path)
                    .and_then(|()| sync_dir(&self.paths.staging))
                    .and_then(|()| sync_dir(&self.paths.objects))
                {
                    let _ = std::fs::remove_file(&object_path);
                    let _ = sync_dir(&self.paths.objects);
                    return Err(artifact_io_error(error, &object_path));
                }
                // The reservation changes representation from staging bytes to
                // a published object, so the shared total is unchanged.
                self.quota_reserved = 0;
                false
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                verify_object(&object_path, &sha256, self.written, &self.id)?;
                std::fs::remove_file(&self.staging_path)
                    .map_err(|error| artifact_io_error(error, &self.staging_path))?;
                sync_dir(&self.paths.staging)
                    .map_err(|error| artifact_io_error(error, &self.staging_path))?;
                release_quota(&self.paths, self.quota_reserved)?;
                self.quota_reserved = 0;
                true
            }
            Err(error) => return Err(artifact_io_error(error, &object_path)),
        };

        let created_at = now_rfc3339();
        let artifact = ArtifactRef {
            id: self.id.clone(),
            kind: self.kind.clone(),
            store_key: self.id.clone(),
            sha256: sha256.clone(),
            size_bytes: self.written,
            encoding: "raw".to_string(),
            lossy: false,
            retention_class: "raw_artifact".to_string(),
            created_at: created_at.clone(),
            owner: self.owner.clone(),
            read_capability: uuid::Uuid::new_v4().to_string(),
            scope: "server".to_string(),
            cleanup_state: ArtifactCleanupState::Active,
        };
        let record = ArtifactRecord {
            version: 1,
            artifact: artifact.clone(),
            object_key: sha256,
            expires_at: format_rfc3339(OffsetDateTime::now_utc() + retention_duration()),
            quarantined_at: None,
        };
        let record_path = self.paths.record_path(&self.id);
        if let Err(error) = write_record_atomic(&record_path, &record) {
            // A directory-fsync failure can happen after the record rename.
            // Keep the object when the final record is visible; otherwise a
            // caller could later observe a durable record pointing at a
            // deleted object. If no record was published, roll back this
            // invocation's newly installed object and its active quota.
            if !object_preexisted && !record_path_matches(&record_path, &record) {
                self.rollback_committed_object(&object_path);
            }
            return Err(error);
        }
        self.finalized = true;
        Ok(artifact)
    }

    /// Undo a newly installed object after its bytes became active quota. A
    /// failed removal leaves both the object and its quota accounted; a
    /// successful removal decrements the active total exactly once.
    fn rollback_committed_object(&mut self, object_path: &Path) {
        match std::fs::remove_file(object_path) {
            Ok(()) => {
                let _ = release_quota(&self.paths, self.written);
                let _ = sync_dir(&self.paths.objects);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let _ = release_quota(&self.paths, self.written);
            }
            Err(_) => {}
        }
    }

    fn discard_staging_locked(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = std::fs::File::unlock(&file);
            drop(file);
        }
        match std::fs::remove_file(&self.staging_path) {
            Ok(()) => {
                let _ = sync_dir(&self.paths.staging);
                let _ = release_quota(&self.paths, self.quota_reserved);
                self.quota_reserved = 0;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let _ = release_quota(&self.paths, self.quota_reserved);
                self.quota_reserved = 0;
            }
            Err(_) => {}
        }
    }
}

impl Drop for ArtifactWriter {
    fn drop(&mut self) {
        if !self.finalized
            && let Ok(_store_lock) = StoreLock::acquire(&self.paths)
        {
            self.discard_staging_locked();
        }
    }
}

pub fn read(req: &ArtifactReadRequest) -> Result<ArtifactReadResult, ToolError> {
    use base64::Engine;
    validate_id(&req.id)?;
    let paths = StorePaths::for_current_config()?;
    let _store_lock = StoreLock::acquire(&paths)?;
    let record_path = paths.record_path(&req.id);
    let record = match read_record(&record_path) {
        Ok(record) => record,
        Err(error) if error.code == ToolErrorCode::NotFound => {
            return Err(artifact_unavailable(
                &req.id,
                "artifact record is unavailable",
            ));
        }
        Err(error) => return Err(error),
    };
    validate_stored_record(&record_path, &record, ArtifactCleanupState::Active)?;
    if record.artifact.cleanup_state != ArtifactCleanupState::Active || is_expired(&record)? {
        return Err(artifact_unavailable(
            &req.id,
            "artifact has expired or is quarantined",
        ));
    }
    if req.read_capability.is_empty()
        || record.artifact.read_capability.is_empty()
        || req.read_capability != record.artifact.read_capability
    {
        return Err(artifact_unavailable(
            &req.id,
            "artifact read capability does not match the producing invocation",
        ));
    }
    let object_path = safe_object_path(&paths, &record)?;
    verify_object(
        &object_path,
        &record.artifact.sha256,
        record.artifact.size_bytes,
        &record.artifact.id,
    )?;

    let offset = req.offset.unwrap_or(0);
    if offset > record.artifact.size_bytes {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "process.artifact.read",
            format!(
                "offset {offset} exceeds artifact size {}",
                record.artifact.size_bytes
            ),
        )
        .with_details(serde_json::json!({"reason": "artifact_offset_invalid"})));
    }
    let end = req
        .length
        .map(|length| {
            offset
                .saturating_add(length)
                .min(record.artifact.size_bytes)
        })
        .unwrap_or(record.artifact.size_bytes);
    let mut file = std::fs::File::open(&object_path)
        .map_err(|_| artifact_unavailable(&req.id, "artifact object is unavailable"))?;
    use std::io::{Seek, SeekFrom};
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| artifact_unavailable(&req.id, "artifact object is unavailable"))?;
    let read_len = usize::try_from(end - offset).map_err(|_| {
        ToolError::new(
            ToolErrorCode::InvalidInput,
            "process.artifact.read",
            "artifact window is too large for this platform",
        )
        .with_details(serde_json::json!({"reason": "artifact_window_too_large"}))
    })?;
    let mut bytes = vec![0_u8; read_len];
    file.read_exact(&mut bytes)
        .map_err(|_| artifact_unavailable(&req.id, "artifact object changed during read"))?;
    let length = bytes.len() as u64;
    // A zero-length request is a metadata-only probe. Returning the same
    // offset as a continuation would let a client loop forever without making
    // progress.
    let metadata_only = req.length == Some(0);
    let next_offset =
        (!metadata_only && offset + length < record.artifact.size_bytes).then_some(offset + length);
    Ok(ArtifactReadResult {
        id: record.artifact.id,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        offset,
        length,
        total_bytes: record.artifact.size_bytes,
        sha256: record.artifact.sha256,
        truncated: next_offset.is_some(),
        next_offset,
    })
}

pub fn cleanup(req: &ArtifactCleanupRequest) -> Result<ArtifactCleanupResult, ToolError> {
    let paths = if req.dry_run {
        StorePaths::current_config()
    } else {
        StorePaths::for_current_config()?
    };
    cleanup_store(&paths, req.dry_run)
}

fn cleanup_store(paths: &StorePaths, dry_run: bool) -> Result<ArtifactCleanupResult, ToolError> {
    let _store_lock = if dry_run {
        StoreLock::acquire_existing(paths)?
    } else {
        Some(StoreLock::acquire(paths)?)
    };
    let configured_limit = configured_quota_limit()?;
    if dry_run {
        validate_quota_limit(paths, configured_limit)?;
    } else {
        ensure_quota_limit(paths, configured_limit)?;
    }
    cleanup_store_locked(paths, dry_run)
}

fn cleanup_store_locked(
    paths: &StorePaths,
    dry_run: bool,
) -> Result<ArtifactCleanupResult, ToolError> {
    let mut result = ArtifactCleanupResult {
        dry_run,
        quarantined_ids: Vec::new(),
        purged_ids: Vec::new(),
    };
    for record_path in record_paths(&paths.records)? {
        let record = read_record(&record_path)?;
        validate_stored_record(&record_path, &record, ArtifactCleanupState::Active)?;
        if !is_expired(&record)? {
            continue;
        }
        if dry_run {
            result.quarantined_ids.push(record.artifact.id);
            continue;
        }
        publish_or_validate_quarantine_record(paths, &record)?;
        remove_file_durable(&record_path, &paths.records)?;
        result.quarantined_ids.push(record.artifact.id);
    }
    for record_path in record_paths(&paths.quarantine)? {
        let record = read_record(&record_path)?;
        validate_stored_record(&record_path, &record, ArtifactCleanupState::Quarantined)?;
        let quarantined_at = record
            .quarantined_at
            .as_deref()
            .expect("validated quarantine record has a timestamp");
        if !older_than(quarantined_at, quarantine_duration())? {
            continue;
        }
        if dry_run {
            result.purged_ids.push(record.artifact.id);
            continue;
        }
        if has_other_object_reference(paths, &record.object_key, &record_path)? {
            remove_file_durable(&record_path, &paths.quarantine)?;
        } else {
            ensure_object_present_for_purge(paths, &record)?;
            let purging_path = begin_purge(paths, &record_path, &record)?;
            complete_purge(paths, &purging_path, &record)?;
        }
        result.purged_ids.push(record.artifact.id);
    }
    // A purging record is a durable delete intent. It makes cleanup retryable
    // across a crash after object removal but before record removal/fsync.
    for record_path in record_paths(&paths.purging)? {
        let record = read_record(&record_path)?;
        validate_stored_record(&record_path, &record, ArtifactCleanupState::Quarantined)?;
        if dry_run {
            result.purged_ids.push(record.artifact.id);
            continue;
        }
        complete_purge(paths, &record_path, &record)?;
        result.purged_ids.push(record.artifact.id);
    }
    result.quarantined_ids.sort();
    result.purged_ids.sort();
    result.purged_ids.dedup();
    Ok(result)
}

fn begin_purge(
    paths: &StorePaths,
    quarantine_path: &Path,
    record: &ArtifactRecord,
) -> Result<PathBuf, ToolError> {
    let purging_path = paths.purging_record_path(&record.artifact.id);
    if purging_path.exists() {
        return Err(artifact_record_conflict(
            &record.artifact.id,
            "artifact has both quarantine and purge-intent records",
        ));
    }
    std::fs::rename(quarantine_path, &purging_path)
        .map_err(|error| artifact_io_error(error, quarantine_path))?;
    sync_dir(&paths.purging).map_err(|error| artifact_io_error(error, &purging_path))?;
    sync_dir(&paths.quarantine).map_err(|error| artifact_io_error(error, quarantine_path))?;
    Ok(purging_path)
}

fn complete_purge(
    paths: &StorePaths,
    purging_path: &Path,
    record: &ArtifactRecord,
) -> Result<(), ToolError> {
    if !has_other_object_reference(paths, &record.object_key, purging_path)? {
        remove_object_after_purge_intent(paths, record)?;
    }
    remove_file_durable(purging_path, &paths.purging)
}

fn publish_or_validate_quarantine_record(
    paths: &StorePaths,
    active: &ArtifactRecord,
) -> Result<(), ToolError> {
    let quarantine_path = paths.quarantined_record_path(&active.artifact.id);
    match read_record(&quarantine_path) {
        Ok(quarantined) => {
            validate_stored_record(
                &quarantine_path,
                &quarantined,
                ArtifactCleanupState::Quarantined,
            )?;
            let mut recovered_active = quarantined;
            recovered_active.artifact.cleanup_state = ArtifactCleanupState::Active;
            recovered_active.quarantined_at = None;
            if recovered_active != *active {
                return Err(artifact_record_conflict(
                    &active.artifact.id,
                    "active and quarantine records disagree",
                ));
            }
            Ok(())
        }
        Err(error) if error.code == ToolErrorCode::NotFound => {
            let mut quarantined = active.clone();
            quarantined.artifact.cleanup_state = ArtifactCleanupState::Quarantined;
            quarantined.quarantined_at = Some(now_rfc3339());
            write_record_atomic(&quarantine_path, &quarantined)
        }
        Err(error) => Err(error),
    }
}

fn has_other_object_reference(
    paths: &StorePaths,
    object_key: &str,
    excluded_path: &Path,
) -> Result<bool, ToolError> {
    for directory in [&paths.records, &paths.quarantine, &paths.purging] {
        for path in record_paths(directory)? {
            if path == excluded_path {
                continue;
            }
            let record = read_record(&path)?;
            let expected_state = if directory == &paths.records {
                ArtifactCleanupState::Active
            } else {
                ArtifactCleanupState::Quarantined
            };
            validate_stored_record(&path, &record, expected_state)?;
            if record.object_key == object_key {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn remove_unreferenced_objects(paths: &StorePaths) -> Result<(), ToolError> {
    let referenced = referenced_object_keys(paths)?;
    for entry in std::fs::read_dir(&paths.objects)
        .map_err(|error| artifact_io_error(error, &paths.objects))?
    {
        let entry = entry.map_err(|error| artifact_io_error(error, &paths.objects))?;
        let path = entry.path();
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|error| artifact_io_error(error, &path))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let Some(object_key) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".bin"))
        else {
            continue;
        };
        if !is_sha256(object_key) || referenced.contains(object_key) {
            continue;
        }
        std::fs::remove_file(&path).map_err(|error| artifact_io_error(error, &path))?;
        sync_dir(&paths.objects).map_err(|error| artifact_io_error(error, &paths.objects))?;
    }
    Ok(())
}

fn referenced_object_keys(
    paths: &StorePaths,
) -> Result<std::collections::HashSet<String>, ToolError> {
    let mut referenced = std::collections::HashSet::new();
    for directory in [&paths.records, &paths.quarantine, &paths.purging] {
        for path in record_paths(directory)? {
            let record = read_record(&path)?;
            let expected_state = if directory == &paths.records {
                ArtifactCleanupState::Active
            } else {
                ArtifactCleanupState::Quarantined
            };
            validate_stored_record(&path, &record, expected_state)?;
            referenced.insert(record.object_key);
        }
    }
    Ok(referenced)
}

fn ensure_object_present_for_purge(
    paths: &StorePaths,
    record: &ArtifactRecord,
) -> Result<(), ToolError> {
    let object_path = safe_object_path(paths, record)?;
    object_metadata_for_purge(&object_path, record).map(|_| ())
}

fn object_metadata_for_purge(
    object_path: &Path,
    record: &ArtifactRecord,
) -> Result<std::fs::Metadata, ToolError> {
    let metadata = match std::fs::symlink_metadata(object_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError::new(
                ToolErrorCode::Conflict,
                "process.artifact.cleanup",
                "artifact object is missing; purge record retained for recovery",
            )
            .with_details(serde_json::json!({
                "reason": "artifact_object_missing",
                "id": record.artifact.id,
            })));
        }
        Err(error) => return Err(artifact_io_error(error, object_path)),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(artifact_record_conflict(
            &record.artifact.id,
            "artifact object is not a regular file",
        ));
    }
    Ok(metadata)
}

fn remove_object_after_purge_intent(
    paths: &StorePaths,
    record: &ArtifactRecord,
) -> Result<(), ToolError> {
    let object_path = safe_object_path(paths, record)?;
    let metadata = match std::fs::symlink_metadata(&object_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // The durable purging record proves that cleanup previously began
            // deleting this object. Reconcile the projection and finish the
            // record cleanup rather than turning a partial success permanent.
            release_quota(paths, record.artifact.size_bytes)?;
            return sync_dir(&paths.objects)
                .map_err(|error| artifact_io_error(error, &paths.objects));
        }
        Err(error) => return Err(artifact_io_error(error, &object_path)),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(artifact_record_conflict(
            &record.artifact.id,
            "artifact object is not a regular file",
        ));
    }
    std::fs::remove_file(&object_path).map_err(|error| artifact_io_error(error, &object_path))?;
    release_quota(paths, metadata.len())?;
    sync_dir(&paths.objects).map_err(|error| artifact_io_error(error, &object_path))
}

fn remove_file_durable(path: &Path, parent: &Path) -> Result<(), ToolError> {
    match std::fs::remove_file(path) {
        Ok(()) => sync_dir(parent).map_err(|error| artifact_io_error(error, path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(artifact_io_error(error, path)),
    }
}

fn record_paths(directory: &Path) -> Result<Vec<PathBuf>, ToolError> {
    let mut paths = Vec::new();
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(paths),
        Err(error) => return Err(artifact_io_error(error, directory)),
    };
    for entry in entries {
        let entry = entry.map_err(|error| artifact_io_error(error, directory))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("json") {
            paths.push(path);
        }
    }
    paths.sort();
    Ok(paths)
}

fn validate_stored_record(
    path: &Path,
    record: &ArtifactRecord,
    expected_state: ArtifactCleanupState,
) -> Result<(), ToolError> {
    let file_id = path.file_stem().and_then(|stem| stem.to_str());
    let canonical_id = uuid::Uuid::parse_str(&record.artifact.id)
        .is_ok_and(|id| id.to_string() == record.artifact.id);
    let state_matches = record.artifact.cleanup_state == expected_state;
    let timestamp_matches = match expected_state {
        ArtifactCleanupState::Active => record.quarantined_at.is_none(),
        ArtifactCleanupState::Quarantined => record.quarantined_at.is_some(),
        ArtifactCleanupState::Purged => false,
    };
    if record.version != 1
        || !canonical_id
        || file_id != Some(record.artifact.id.as_str())
        || record.artifact.store_key != record.artifact.id
        || !is_sha256(&record.object_key)
        || record.object_key != record.artifact.sha256
        || !state_matches
        || !timestamp_matches
    {
        return Err(artifact_record_conflict(
            &record.artifact.id,
            "artifact record violates the store contract",
        ));
    }
    Ok(())
}

fn artifact_record_conflict(id: &str, message: &str) -> ToolError {
    ToolError::new(ToolErrorCode::Conflict, "process.artifact.record", message)
        .with_details(serde_json::json!({"reason": "artifact_record_corrupt", "id": id}))
}

fn read_record(path: &Path) -> Result<ArtifactRecord, ToolError> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ToolError::new(
                ToolErrorCode::NotFound,
                "process.artifact.record",
                "artifact record not found",
            ));
        }
        Err(error) => return Err(artifact_io_error(error, path)),
    };
    serde_json::from_slice(&bytes).map_err(|error| {
        ToolError::new(
            ToolErrorCode::Conflict,
            "process.artifact.record",
            format!("artifact record is corrupt: {error}"),
        )
        .with_details(serde_json::json!({"reason": "artifact_record_corrupt"}))
    })
}

fn write_record_atomic(path: &Path, record: &ArtifactRecord) -> Result<(), ToolError> {
    let bytes = serde_json::to_vec(record).map_err(|error| {
        ToolError::new(
            ToolErrorCode::Internal,
            "process.artifact.record",
            format!("serialize artifact record: {error}"),
        )
    })?;
    let parent = path.parent().expect("record path has a parent");
    let temporary = parent.join(format!(".{}.tmp", uuid::Uuid::now_v7()));
    let write_result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| artifact_io_error(error, &temporary))?;
        file.write_all(&bytes)
            .map_err(|error| artifact_io_error(error, &temporary))?;
        file.sync_all()
            .map_err(|error| artifact_io_error(error, &temporary))?;
        set_private_file_permissions(&temporary)
            .map_err(|error| artifact_io_error(error, &temporary))?;
        std::fs::hard_link(&temporary, path).map_err(|error| artifact_io_error(error, path))?;
        std::fs::remove_file(&temporary).map_err(|error| artifact_io_error(error, &temporary))?;
        sync_dir(parent).map_err(|error| artifact_io_error(error, path))
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

fn record_path_matches(path: &Path, expected: &ArtifactRecord) -> bool {
    read_record(path).is_ok_and(|actual| actual == *expected)
}

fn safe_object_path(paths: &StorePaths, record: &ArtifactRecord) -> Result<PathBuf, ToolError> {
    if !is_sha256(&record.object_key) || record.object_key != record.artifact.sha256 {
        return Err(artifact_unavailable(
            &record.artifact.id,
            "artifact object key does not match the record hash",
        ));
    }
    Ok(paths.object_path(&record.object_key))
}

fn verify_object(
    path: &Path,
    expected_sha256: &str,
    expected_size: u64,
    artifact_id: &str,
) -> Result<(), ToolError> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| artifact_unavailable(artifact_id, "artifact object is unavailable"))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(artifact_unavailable(
            artifact_id,
            "artifact object is not a regular file",
        ));
    }
    if metadata.len() != expected_size {
        return Err(artifact_conflict(artifact_id, "artifact size mismatch"));
    }
    let actual = sha256_file(path)
        .map_err(|_| artifact_unavailable(artifact_id, "artifact object is unavailable"))?;
    if actual != expected_sha256 {
        return Err(artifact_conflict(artifact_id, "artifact hash mismatch"));
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<(), ToolError> {
    match uuid::Uuid::parse_str(id) {
        Ok(parsed) if parsed.to_string() == id => Ok(()),
        _ => Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "process.artifact.read",
            "artifact id is not a canonical UUID",
        )
        .with_details(serde_json::json!({"reason": "artifact_id_invalid"}))),
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_expired(record: &ArtifactRecord) -> Result<bool, ToolError> {
    older_than(&record.expires_at, Duration::ZERO)
}

fn older_than(timestamp: &str, age: Duration) -> Result<bool, ToolError> {
    let timestamp =
        OffsetDateTime::parse(timestamp, &time::format_description::well_known::Rfc3339).map_err(
            |error| {
                ToolError::new(
                    ToolErrorCode::Conflict,
                    "process.artifact.record",
                    format!("artifact timestamp is invalid: {error}"),
                )
                .with_details(serde_json::json!({"reason": "artifact_record_corrupt"}))
            },
        )?;
    let age = time::Duration::try_from(age).map_err(|_| {
        ToolError::new(
            ToolErrorCode::Internal,
            "process.artifact.record",
            "artifact retention duration is out of range",
        )
    })?;
    Ok(OffsetDateTime::now_utc() >= timestamp + age)
}

fn retention_duration() -> Duration {
    env_duration("XUANLING_ARTIFACT_TTL_SECONDS", DEFAULT_RETENTION)
}

fn quarantine_duration() -> Duration {
    env_duration("XUANLING_ARTIFACT_QUARANTINE_SECONDS", DEFAULT_QUARANTINE)
}

fn env_duration(name: &str, default: Duration) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(default)
}

fn now_rfc3339() -> String {
    format_rfc3339(OffsetDateTime::now_utc())
}

fn format_rfc3339(time: OffsetDateTime) -> String {
    time.format(&time::format_description::well_known::Rfc3339)
        .expect("RFC3339 formatting is infallible for OffsetDateTime")
}

fn artifact_unavailable(id: &str, message: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::InvalidInput,
        "process.artifact.read",
        message,
    )
    .with_details(serde_json::json!({"reason": "artifact_unavailable", "id": id}))
}

fn artifact_conflict(id: &str, message: &str) -> ToolError {
    ToolError::new(ToolErrorCode::Conflict, "process.artifact.read", message)
        .with_details(serde_json::json!({"reason": "artifact_hash_mismatch", "id": id}))
}

fn artifact_io_error(error: std::io::Error, _path: &Path) -> ToolError {
    ToolError::new(
        ToolErrorCode::IoError,
        "process.artifact",
        format!("artifact store I/O failed: {error}"),
    )
    .with_raw_os_error(error.raw_os_error())
    .with_details(serde_json::json!({"reason": "artifact_write_failed"}))
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 65_536];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

fn sync_dir(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::fs::File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

#[cfg(unix)]
fn set_private_dir_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_dir_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn reserve_quota(paths: &StorePaths, bytes: u64) -> Result<(), ToolError> {
    let configured_limit = configured_quota_limit()?;
    let limit = read_quota_limit(paths)?;
    if configured_limit != limit {
        return Err(quota_config_mismatch(configured_limit, limit));
    }
    let mut used = match read_quota(paths) {
        Ok(used) => used,
        Err(_) => reconcile_quota(paths)?.bytes,
    };
    let mut requested = used.saturating_add(bytes);
    if limit > 0 && requested > limit {
        // A writer may have crashed after advancing the ledger but before its
        // staging write. Reconcile under the cross-process lock before denying
        // a healthy writer so abandoned reservations are recoverable.
        used = reconcile_quota(paths)?.bytes;
        requested = used.saturating_add(bytes);
    }
    if limit > 0 && requested > limit {
        return Err(ToolError::new(
            ToolErrorCode::IoError,
            "process.artifact",
            "artifact quota would be exceeded",
        )
        .with_details(serde_json::json!({
            "reason": "artifact_quota_exceeded",
            "max_total_bytes": limit,
        })));
    }
    write_quota(paths, requested)
}

fn release_quota(paths: &StorePaths, _bytes: u64) -> Result<(), ToolError> {
    reconcile_quota(paths).map(|_| ())
}

fn configured_quota_limit() -> Result<u64, ToolError> {
    match std::env::var("XUANLING_ARTIFACT_MAX_TOTAL_BYTES") {
        Ok(value) => value.parse::<u64>().map_err(|_| {
            ToolError::new(
                ToolErrorCode::InvalidInput,
                "process.artifact.quota",
                "XUANLING_ARTIFACT_MAX_TOTAL_BYTES must be an unsigned integer",
            )
            .with_details(serde_json::json!({"reason": "artifact_quota_config_invalid"}))
        }),
        Err(std::env::VarError::NotPresent) => Ok(0),
        Err(std::env::VarError::NotUnicode(_)) => Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "process.artifact.quota",
            "XUANLING_ARTIFACT_MAX_TOTAL_BYTES must be valid Unicode",
        )
        .with_details(serde_json::json!({"reason": "artifact_quota_config_invalid"}))),
    }
}

/// Rebuild the shared quota ledger from retained objects and live staging
/// files. The caller holds the store lock, so file-size snapshots cannot race
/// a writer's reserve/write pair or publication.
fn reconcile_quota(paths: &StorePaths) -> Result<QuotaUsage, ToolError> {
    let object_usage = directory_file_usage(&paths.objects, false)?;
    let staging_usage = directory_file_usage(&paths.staging, true)?;
    let usage = QuotaUsage {
        bytes: object_usage.bytes.saturating_add(staging_usage.bytes),
    };
    write_quota(paths, usage.bytes)?;
    Ok(usage)
}

#[derive(Clone, Copy)]
struct QuotaUsage {
    bytes: u64,
}

#[derive(Clone, Copy, Default)]
struct DirectoryUsage {
    bytes: u64,
}

fn directory_file_usage(
    directory: &Path,
    remove_unlocked: bool,
) -> Result<DirectoryUsage, ToolError> {
    let mut usage = DirectoryUsage::default();
    for entry in
        std::fs::read_dir(directory).map_err(|error| artifact_io_error(error, directory))?
    {
        let entry = entry.map_err(|error| artifact_io_error(error, directory))?;
        let path = entry.path();
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|error| artifact_io_error(error, &path))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        if remove_unlocked {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| artifact_io_error(error, &path))?;
            match std::fs::File::try_lock(&file) {
                Ok(()) => {
                    let _ = std::fs::File::unlock(&file);
                    drop(file);
                    std::fs::remove_file(&path).map_err(|error| artifact_io_error(error, &path))?;
                    sync_dir(directory).map_err(|error| artifact_io_error(error, directory))?;
                    continue;
                }
                Err(std::fs::TryLockError::WouldBlock) => {}
                Err(std::fs::TryLockError::Error(error)) => {
                    return Err(artifact_io_error(error, &path));
                }
            }
        }
        usage.bytes = usage.bytes.saturating_add(metadata.len());
    }
    Ok(usage)
}

fn read_quota(paths: &StorePaths) -> Result<u64, ToolError> {
    let quota_path = paths.quota_path();
    let raw = std::fs::read_to_string(&quota_path)
        .map_err(|error| artifact_io_error(error, &quota_path))?;
    raw.trim().parse::<u64>().map_err(|_| {
        ToolError::new(
            ToolErrorCode::Conflict,
            "process.artifact.quota",
            "artifact quota ledger is corrupt",
        )
        .with_details(serde_json::json!({"reason": "artifact_quota_corrupt"}))
    })
}

fn ensure_quota_limit(paths: &StorePaths, configured: u64) -> Result<(), ToolError> {
    let path = paths.quota_limit_path();
    match read_u64_projection(&path) {
        Ok(stored) if stored == configured => Ok(()),
        Ok(_) if store_is_empty_for_quota_reconfiguration(paths)? => {
            write_u64_projection(&path, configured)
        }
        Ok(stored) => Err(quota_config_mismatch(configured, stored)),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && !has_active_staging_writer(paths)? =>
        {
            // Migration path for stores created before the shared limit
            // projection existed. The configured value becomes canonical.
            write_u64_projection(&path, configured)
        }
        Err(_) => Err(ToolError::new(
            ToolErrorCode::Conflict,
            "process.artifact.quota",
            "artifact quota limit projection is unavailable",
        )
        .with_details(serde_json::json!({"reason": "artifact_quota_config_unavailable"}))),
    }
}

/// Validate cleanup against the shared configuration without publishing or
/// changing it. In particular, `artifact_cleanup(dry_run=true)` must remain a
/// read-only inspection even for an empty or legacy store.
fn validate_quota_limit(paths: &StorePaths, configured: u64) -> Result<(), ToolError> {
    let path = paths.quota_limit_path();
    match read_u64_projection(&path) {
        Ok(stored) if stored == configured => Ok(()),
        Ok(_) if store_is_empty_for_quota_reconfiguration(paths)? => Ok(()),
        Ok(stored) => Err(quota_config_mismatch(configured, stored)),
        Err(error)
            if error.kind() == std::io::ErrorKind::NotFound
                && !has_active_staging_writer(paths)? =>
        {
            Ok(())
        }
        Err(_) => Err(ToolError::new(
            ToolErrorCode::Conflict,
            "process.artifact.quota",
            "artifact quota limit projection is unavailable",
        )
        .with_details(serde_json::json!({"reason": "artifact_quota_config_unavailable"}))),
    }
}

/// A quota configuration may change only when no retained or recoverable store
/// state exists. Count directory entries rather than bytes: zero-byte objects,
/// missing-object records, quarantine records, purge intents, and abandoned
/// staging files all still carry store identity and must fail closed.
fn store_is_empty_for_quota_reconfiguration(paths: &StorePaths) -> Result<bool, ToolError> {
    for directory in [
        &paths.staging,
        &paths.objects,
        &paths.records,
        &paths.quarantine,
        &paths.purging,
    ] {
        if !directory_is_empty(directory)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn directory_is_empty(directory: &Path) -> Result<bool, ToolError> {
    let mut entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(artifact_io_error(error, directory)),
    };
    match entries.next() {
        Some(Ok(_)) => Ok(false),
        Some(Err(error)) => Err(artifact_io_error(error, directory)),
        None => Ok(true),
    }
}

/// Inspect staging writer leases without removing crash residue. This is used
/// only for the legacy migration where `.quota-limit` does not exist yet: an
/// active old writer makes choosing a canonical limit ambiguous, while
/// unlocked staging can be reclaimed after the limit has been established.
fn has_active_staging_writer(paths: &StorePaths) -> Result<bool, ToolError> {
    let entries = match std::fs::read_dir(&paths.staging) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(artifact_io_error(error, &paths.staging)),
    };
    for entry in entries {
        let entry = entry.map_err(|error| artifact_io_error(error, &paths.staging))?;
        let path = entry.path();
        let metadata =
            std::fs::symlink_metadata(&path).map_err(|error| artifact_io_error(error, &path))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            continue;
        }
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .map_err(|error| artifact_io_error(error, &path))?;
        match std::fs::File::try_lock(&file) {
            Ok(()) => {
                std::fs::File::unlock(&file).map_err(|error| artifact_io_error(error, &path))?;
            }
            Err(std::fs::TryLockError::WouldBlock) => return Ok(true),
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(artifact_io_error(error, &path));
            }
        }
    }
    Ok(false)
}

fn read_quota_limit(paths: &StorePaths) -> Result<u64, ToolError> {
    let path = paths.quota_limit_path();
    read_u64_projection(&path).map_err(|_| {
        ToolError::new(
            ToolErrorCode::Conflict,
            "process.artifact.quota",
            "artifact quota limit projection is unavailable",
        )
        .with_details(serde_json::json!({"reason": "artifact_quota_config_unavailable"}))
    })
}

fn quota_config_mismatch(configured: u64, stored: u64) -> ToolError {
    ToolError::new(
        ToolErrorCode::Conflict,
        "process.artifact.quota",
        "artifact store is in use with a different total-byte quota",
    )
    .with_details(serde_json::json!({
        "reason": "artifact_quota_config_mismatch",
        "configured_max_total_bytes": configured,
        "store_max_total_bytes": stored,
    }))
}

fn read_u64_projection(path: &Path) -> std::io::Result<u64> {
    let raw = std::fs::read_to_string(path)?;
    raw.trim()
        .parse::<u64>()
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidData, "invalid u64 projection"))
}

fn write_u64_projection(path: &Path, value: u64) -> Result<(), ToolError> {
    let parent = path.parent().expect("quota projection path has a parent");
    let temporary = parent.join(format!(".quota-limit-{}.tmp", uuid::Uuid::now_v7()));
    let write_result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| artifact_io_error(error, &temporary))?;
        set_private_file_permissions(&temporary)
            .map_err(|error| artifact_io_error(error, &temporary))?;
        writeln!(file, "{value}").map_err(|error| artifact_io_error(error, &temporary))?;
        file.sync_all()
            .map_err(|error| artifact_io_error(error, &temporary))?;
        drop(file);
        replace_file_atomic(&temporary, path).map_err(|error| artifact_io_error(error, path))?;
        sync_dir(parent).map_err(|error| artifact_io_error(error, path))
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    write_result
}

#[cfg(not(windows))]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file_atomic(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let source_wide: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    // SAFETY: both UTF-16 buffers are NUL-terminated and remain alive for the
    // call. Source and destination are paths in the same store directory, and
    // the BOOL return is checked before success is reported.
    let replaced = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn write_quota(paths: &StorePaths, bytes: u64) -> Result<(), ToolError> {
    let quota_path = paths.quota_path();
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&quota_path)
        .map_err(|error| artifact_io_error(error, &quota_path))?;
    set_private_file_permissions(&quota_path)
        .map_err(|error| artifact_io_error(error, &quota_path))?;
    writeln!(file, "{bytes}").map_err(|error| artifact_io_error(error, &quota_path))?;
    // Reservation is visible to other processes before the corresponding
    // staging write. The ledger is a reconstructable projection: a torn write
    // after process/OS failure is recovered by `reconcile_quota`.
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut result, "{byte:02x}");
    }
    result
}
