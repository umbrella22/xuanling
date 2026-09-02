//! Single-file ChangeSet: transactional edit with conflict-aware rollback
//! (ADR 0013, plan §8.1/§8.4).
//!
//! State machine (plan §8.1):
//! ```text
//! Prepared -> DryRun
//! Prepared -> AppliedAwaitingCompletion
//! AppliedAwaitingCompletion -> Committed
//! AppliedAwaitingCompletion -> RolledBack
//! AppliedAwaitingCompletion -> RollbackConflict
//! AppliedAwaitingCompletion -> RecoveryFailed -> RolledBack
//! ```
//! Rollback re-reads the file and compares to the `after_hash` the ChangeSet
//! wrote; if a user/editor changed the file in the meantime, rollback is
//! REFUSED as `RollbackConflict` and the user's content is preserved (never
//! overwritten). Before-content is held as an in-process recovery buffer (it
//! does NOT enter normal tool results, memory, logs, or the default backup —
//! ADR 0013). Multi-file apply uses the same recovery rules: before state keeps
//! file existence separate from bytes, and a failed rollback is reported rather
//! than silently claimed as atomic (plan §8.4).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::fs::sha256_hex;
use crate::invocation::InvocationContext;

/// ChangeSet lifecycle state (plan §8.1).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum ChangeSetState {
    Prepared,
    DryRun,
    AppliedAwaitingCompletion,
    Committed,
    RolledBack,
    RollbackConflict,
    RecoveryFailed,
}

impl ChangeSetState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChangeSetState::Prepared => "prepared",
            ChangeSetState::DryRun => "dry_run",
            ChangeSetState::AppliedAwaitingCompletion => "applied_awaiting_completion",
            ChangeSetState::Committed => "committed",
            ChangeSetState::RolledBack => "rolled_back",
            ChangeSetState::RollbackConflict => "rollback_conflict",
            ChangeSetState::RecoveryFailed => "recovery_failed",
        }
    }
}

/// A registered single- or multi-file change with in-process recovery buffers.
struct ChangeSet {
    members: Vec<ChangeSetMember>,
    state: ChangeSetState,
}

struct ChangeSetMember {
    path: PathBuf,
    before_bytes: Vec<u8>,
    before_hash: String,
    after_hash: String,
}

fn store() -> &'static Mutex<HashMap<String, ChangeSet>> {
    static S: OnceLock<Mutex<HashMap<String, ChangeSet>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("chg-{pid}-{n}-{stamp}")
}

/// Outcome of registering/applying a change.
pub struct AppliedChange {
    pub change_id: String,
    pub state: ChangeSetState,
}

/// Register a change that has just been atomically applied to `path`. The
/// caller supplies the exact before/after bytes; the store keeps the before
/// bytes as a recovery buffer. State is `AppliedAwaitingCompletion`.
pub fn register_applied(path: PathBuf, before_bytes: Vec<u8>, after_bytes: &[u8]) -> AppliedChange {
    register_applied_group(vec![(path, before_bytes, sha256_hex(after_bytes))])
}

/// Register a group that has already been applied successfully. Every tuple is
/// `(resolved_path, exact_before_bytes, exact_after_hash)` in request order.
pub(crate) fn register_applied_group(members: Vec<(PathBuf, Vec<u8>, String)>) -> AppliedChange {
    let id = next_id();
    let entry = ChangeSet {
        members: members
            .into_iter()
            .map(|(path, before_bytes, after_hash)| ChangeSetMember {
                before_hash: sha256_hex(&before_bytes),
                path,
                before_bytes,
                after_hash,
            })
            .collect(),
        state: ChangeSetState::AppliedAwaitingCompletion,
    };
    store()
        .lock()
        .expect("changeset store not poisoned")
        .insert(id.clone(), entry);
    AppliedChange {
        change_id: id,
        state: ChangeSetState::AppliedAwaitingCompletion,
    }
}

// --- multi-file ChangeSet (plan §8.4: all-or-rollback) ---------------------
// Now that the single-file ChangeSet proves all-or-rollback
// (`rollback_conflict_preserves_user_change` / `rollback_restores_after_hash_match`),
// multi-file apply is opened with the SAME guarantee: if any file's preimage
// guard or write fails, every file already written in the same apply is restored
// to its before-bytes — never a partial apply.

/// One file in a multi-file apply. Direct bytes (no shell); the optional
/// preimage guard is checked before that file is written.
#[derive(Debug)]
pub struct MultiFileChange {
    pub path: PathBuf,
    pub after_bytes: Vec<u8>,
    pub expected_preimage_sha256: Option<String>,
}

/// Result of a successful multi-file apply (every file written).
#[derive(Debug)]
pub struct AppliedMultiChange {
    pub applied_paths: Vec<String>,
}

/// Apply multiple file changes atomically with respect to failures caused by
/// this call. All source states and CAS guards are read before the first write.
/// If a write fails, already-written targets are restored to their exact prior
/// state: an absent target is removed, and a present target is restored byte for
/// byte. A rollback never overwrites a concurrent external write; such a race
/// and every recovery I/O failure are reported as an error rather than hidden.
pub fn apply_multi(changes: Vec<MultiFileChange>) -> Result<AppliedMultiChange, ToolError> {
    let _mutation_guard = super::mutation_lock();
    let mut prepared = Vec::with_capacity(changes.len());
    let mut unique_paths = std::collections::HashSet::with_capacity(changes.len());

    // Preflight every target before any mutation. A guard failure therefore
    // cannot leave an earlier target half-applied.
    for change in changes {
        if !unique_paths.insert(change.path.clone()) {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.changeset.multi",
                "a multi-file ChangeSet may not target the same path twice",
            )
            .with_path(change.path.to_string_lossy())
            .with_details(serde_json::json!({"reason": "duplicate_target"})));
        }
        let before = read_before_state(&change.path)?;
        if let Some(expected) = &change.expected_preimage_sha256 {
            let Some(bytes) = before.bytes() else {
                return Err(ToolError::new(
                    ToolErrorCode::Conflict,
                    "fs.changeset.multi",
                    "expected_preimage_sha256 requires an existing target",
                )
                .with_path(change.path.to_string_lossy())
                .with_details(serde_json::json!({"reason": "preimage_target_absent"})));
            };
            let actual = sha256_hex(bytes);
            if actual != *expected {
                return Err(ToolError::new(
                    ToolErrorCode::Conflict,
                    "fs.changeset.multi",
                    "expected_preimage_sha256 does not match current content",
                )
                .with_path(change.path.to_string_lossy())
                .with_details(serde_json::json!({
                    "reason": "preimage_mismatch",
                    "actual_sha256": actual,
                })));
            }
        }
        prepared.push(PreparedMultiChange {
            path: change.path,
            before,
            after_bytes: change.after_bytes,
        });
    }

    let mut applied: Vec<AppliedWrite> = Vec::with_capacity(prepared.len());
    for change in &prepared {
        if let Err(error) = super::atomic_write_file(&change.path, &change.after_bytes) {
            let recovery = rollback_buffer(&applied);
            return Err(apply_failure(&change.path, error, recovery));
        }
        applied.push(AppliedWrite {
            path: change.path.clone(),
            before: change.before.clone(),
            after_hash: sha256_hex(&change.after_bytes),
        });
    }

    Ok(AppliedMultiChange {
        applied_paths: applied
            .iter()
            .map(|change| change.path.to_string_lossy().into_owned())
            .collect(),
    })
}

#[derive(Clone, Debug)]
enum BeforeState {
    Absent,
    Present(Vec<u8>),
}

impl BeforeState {
    fn bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Absent => None,
            Self::Present(bytes) => Some(bytes),
        }
    }
}

#[derive(Debug)]
struct PreparedMultiChange {
    path: PathBuf,
    before: BeforeState,
    after_bytes: Vec<u8>,
}

#[derive(Debug)]
struct AppliedWrite {
    path: PathBuf,
    before: BeforeState,
    after_hash: String,
}

fn read_before_state(path: &std::path::Path) -> Result<BeforeState, ToolError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(BeforeState::Present(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BeforeState::Absent),
        Err(error) => Err(ToolError::new(
            ToolErrorCode::IoError,
            "fs.changeset.multi",
            format!("failed to read multi-file preimage: {error}"),
        )
        .with_path(path.to_string_lossy())
        .with_raw_os_error(error.raw_os_error())
        .with_details(serde_json::json!({"reason": "multi_apply_preimage_read_failed"}))),
    }
}

/// Restore previously written paths in reverse order. Before restoring, verify
/// the on-disk hash still equals the bytes this call wrote, so recovery cannot
/// erase a concurrent editor's change.
fn rollback_buffer(applied: &[AppliedWrite]) -> Vec<serde_json::Value> {
    let mut failures = Vec::new();
    for change in applied.iter().rev() {
        let current = match std::fs::read(&change.path) {
            Ok(bytes) => bytes,
            Err(error) => {
                failures.push(serde_json::json!({
                    "path": change.path,
                    "reason": "rollback_read_failed",
                    "message": error.to_string(),
                    "raw_os_error": error.raw_os_error(),
                }));
                continue;
            }
        };
        if sha256_hex(&current) != change.after_hash {
            failures.push(serde_json::json!({
                "path": change.path,
                "reason": "rollback_conflict",
            }));
            continue;
        }
        let restore = match &change.before {
            BeforeState::Present(bytes) => super::atomic_write_file(&change.path, bytes),
            BeforeState::Absent => std::fs::remove_file(&change.path),
        };
        if let Err(error) = restore {
            failures.push(serde_json::json!({
                "path": change.path,
                "reason": "rollback_restore_failed",
                "message": error.to_string(),
                "raw_os_error": error.raw_os_error(),
            }));
        }
    }
    failures
}

fn apply_failure(
    path: &std::path::Path,
    error: std::io::Error,
    rollback_failures: Vec<serde_json::Value>,
) -> ToolError {
    let rollback_clean = rollback_failures.is_empty();
    let reason = if rollback_clean {
        "multi_apply_write_failed"
    } else {
        "multi_apply_rollback_failed"
    };
    ToolError::new(
        ToolErrorCode::IoError,
        "fs.changeset.multi",
        format!("multi-file write failed: {error}"),
    )
    .with_path(path.to_string_lossy())
    .with_raw_os_error(error.raw_os_error())
    .with_details(serde_json::json!({
        "reason": reason,
        "write_error": error.to_string(),
        "rollback_failures": rollback_failures,
    }))
}

/// Commit a change (finalize). The file is NOT re-read on commit — commit only
/// records intent that the change is final. Returns the new state.
pub fn commit(change_id: &str) -> Result<ChangeSetState, ToolError> {
    commit_impl(None, change_id)
}

/// Commit a change after revalidating its registered target against the
/// invoking context's filesystem capability. MCP callers should use this form;
/// [`commit`] remains the unrestricted toolkit compatibility API.
pub fn commit_with_context(
    ctx: &InvocationContext,
    change_id: &str,
) -> Result<ChangeSetState, ToolError> {
    commit_impl(Some(ctx), change_id)
}

fn commit_impl(
    ctx: Option<&InvocationContext>,
    change_id: &str,
) -> Result<ChangeSetState, ToolError> {
    let mut s = store().lock().expect("changeset store not poisoned");
    let entry = s.get_mut(change_id).ok_or_else(|| missing(change_id))?;
    if let Some(ctx) = ctx {
        for member in &entry.members {
            validate_registered_target(ctx, &member.path, "fs.changeset.commit")?;
        }
    }
    if entry.state != ChangeSetState::AppliedAwaitingCompletion {
        return Err(state_error(change_id, entry.state.as_str(), "commit"));
    }
    entry.state = ChangeSetState::Committed;
    Ok(entry.state.clone())
}

/// Roll back a change. Re-reads the file: if its current hash still equals the
/// `after_hash` the ChangeSet wrote, the before-bytes are restored (atomic) and
/// the state becomes `RolledBack`. If the file changed in the meantime, the
/// user's content is PRESERVED (no overwrite) and the state becomes
/// `RollbackConflict` (plan §8.2/§8.4). Returns `Ok(state)` — a conflict is a
/// reportable outcome, not a transport error.
pub fn rollback(change_id: &str) -> Result<ChangeSetState, ToolError> {
    rollback_impl(None, change_id)
}

/// Roll back a change after revalidating its registered target against the
/// invoking context's filesystem capability. A rejected target is put back in
/// the registry unchanged so an authorized caller can still commit or retry.
/// [`rollback`] remains the unrestricted toolkit compatibility API.
pub fn rollback_with_context(
    ctx: &InvocationContext,
    change_id: &str,
) -> Result<ChangeSetState, ToolError> {
    rollback_impl(Some(ctx), change_id)
}

fn rollback_impl(
    ctx: Option<&InvocationContext>,
    change_id: &str,
) -> Result<ChangeSetState, ToolError> {
    let _mutation_guard = super::mutation_lock();
    // Validate and take the entry under the same lock, then do rollback I/O
    // outside it. A capability rejection therefore leaves the registry
    // completely unchanged, without a transient not-found window.
    let mut entry = {
        let mut s = store().lock().expect("changeset store not poisoned");
        if let Some(ctx) = ctx {
            let entry = s.get(change_id).ok_or_else(|| missing(change_id))?;
            for member in &entry.members {
                validate_registered_target(ctx, &member.path, "fs.changeset.rollback")?;
            }
        }
        match s.remove(change_id) {
            Some(e) => e,
            None => return Err(missing(change_id)),
        }
    };
    let retrying_recovery = entry.state == ChangeSetState::RecoveryFailed;
    if entry.state != ChangeSetState::AppliedAwaitingCompletion && !retrying_recovery {
        let state = entry.state.clone();
        reinsert(change_id, entry);
        return Err(state_error(change_id, state.as_str(), "rollback"));
    }

    // Initial rollback requires every target to still equal its after hash.
    // A retry after partial recovery accepts either the known before or after
    // hash, but never an unrelated external value.
    let mut needs_restore = Vec::with_capacity(entry.members.len());
    for (index, member) in entry.members.iter().enumerate() {
        let current = match std::fs::read(&member.path) {
            Ok(current) => current,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                entry.state = ChangeSetState::RollbackConflict;
                reinsert(change_id, entry);
                return Ok(ChangeSetState::RollbackConflict);
            }
            Err(error) => {
                let path = member.path.to_string_lossy().into_owned();
                reinsert(change_id, entry);
                return Err(ToolError::new(
                    ToolErrorCode::IoError,
                    "fs.changeset",
                    format!("failed to read change target during rollback: {error}"),
                )
                .with_path(path)
                .with_raw_os_error(error.raw_os_error())
                .with_details(serde_json::json!({"reason": "rollback_read_failed"})));
            }
        };
        let current_hash = sha256_hex(&current);
        if current_hash == member.after_hash {
            needs_restore.push(index);
        } else if retrying_recovery && current_hash == member.before_hash {
            // This member was already restored by the previous attempt.
        } else {
            entry.state = ChangeSetState::RollbackConflict;
            reinsert(change_id, entry);
            return Ok(ChangeSetState::RollbackConflict);
        }
    }

    for index in needs_restore.into_iter().rev() {
        let member = &entry.members[index];
        if let Err(error) = super::atomic_write_file(&member.path, &member.before_bytes) {
            let path = member.path.to_string_lossy().into_owned();
            if entry.members.len() == 1 {
                // Preserve the established single-file contract: an I/O
                // restore failure remains pending and returns io_error.
                reinsert(change_id, entry);
                return Err(ToolError::new(
                    ToolErrorCode::IoError,
                    "fs.changeset",
                    format!("failed to restore change target during rollback: {error}"),
                )
                .with_path(path)
                .with_raw_os_error(error.raw_os_error())
                .with_details(serde_json::json!({"reason": "rollback_restore_failed"})));
            }

            entry.state = ChangeSetState::RecoveryFailed;
            let paths = changeset_path_states(&entry);
            reinsert(change_id, entry);
            return Err(ToolError::new(
                ToolErrorCode::RecoveryFailed,
                "fs.changeset",
                "group ChangeSet rollback could not restore every target",
            )
            .with_path(path)
            .with_raw_os_error(error.raw_os_error())
            .with_details(serde_json::json!({
                "reason": "changeset_recovery_incomplete",
                "paths": paths,
            })));
        }
    }

    entry.state = ChangeSetState::RolledBack;
    reinsert(change_id, entry);
    Ok(ChangeSetState::RolledBack)
}

fn reinsert(change_id: &str, entry: ChangeSet) {
    store()
        .lock()
        .expect("changeset store not poisoned")
        .insert(change_id.to_string(), entry);
}

fn changeset_path_states(entry: &ChangeSet) -> Vec<serde_json::Value> {
    entry
        .members
        .iter()
        .map(|member| match std::fs::read(&member.path) {
            Ok(bytes) => {
                let actual = sha256_hex(&bytes);
                let final_state = if actual == member.before_hash {
                    "restored"
                } else if actual == member.after_hash {
                    "still_applied"
                } else {
                    "changed_externally"
                };
                serde_json::json!({
                    "path": member.path,
                    "final_state": final_state,
                    "actual_sha256": actual,
                })
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::json!({
                "path": member.path,
                "final_state": "absent",
                "error_code": ToolErrorCode::NotFound.as_snake_case(),
            }),
            Err(error) => {
                let code = super::map_io_error(&error, "fs.changeset.rollback", &member.path).code;
                serde_json::json!({
                    "path": member.path,
                    "final_state": "unknown",
                    "error_code": code.as_snake_case(),
                })
            }
        })
        .collect()
}

fn validate_registered_target(
    ctx: &InvocationContext,
    path: &std::path::Path,
    operation: &str,
) -> Result<(), ToolError> {
    // A ChangeSet stores a resolved filesystem target, not a request locator.
    // Validate that same target directly; resolving it through a later
    // invocation's base_dir could silently change its meaning.
    ctx.filesystem_scope()
        .validate(path, PathAccess::Write, operation)
        .map(|_| ())
}

/// Look up a change's current state (for result reporting) without mutating it.
pub fn state_of(change_id: &str) -> Option<ChangeSetState> {
    store()
        .lock()
        .expect("changeset store not poisoned")
        .get(change_id)
        .map(|e| e.state.clone())
}

fn missing(change_id: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::NotFound,
        "fs.changeset",
        format!("no ChangeSet with id `{change_id}`"),
    )
    .with_details(serde_json::json!({"reason": "change_not_found"}))
}

fn state_error(change_id: &str, state: &str, op: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::Conflict,
        "fs.changeset",
        format!("ChangeSet `{change_id}` is in state `{state}`, cannot {op}"),
    )
    .with_details(serde_json::json!({"reason": "invalid_changeset_state", "state": state}))
}
