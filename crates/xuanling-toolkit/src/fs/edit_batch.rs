//! Ordered exact-text batch editing with mandatory preimage CAS.
//!
//! Every target is resolved, read, decoded, hash-checked, and edited in memory
//! before the first write. Apply writes each file once in request order. A
//! later failure restores already-written files in reverse order without
//! overwriting bytes changed by an external writer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{map_io_error, resolve_path, sha256_hex};
use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsEditBatchEdit {
    #[schemars(length(min = 1))]
    pub old: String,
    pub new: String,
    #[serde(default)]
    pub replace_all: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsEditBatchFile {
    pub path: String,
    #[schemars(regex(pattern = r"^[0-9a-f]{64}$"))]
    pub expected_sha256: String,
    #[schemars(length(min = 1))]
    pub edits: Vec<FsEditBatchEdit>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsEditBatchRequest {
    #[schemars(length(min = 1))]
    pub files: Vec<FsEditBatchFile>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub reversible: bool,
    #[serde(default = "default_include_diff")]
    pub include_diff: bool,
}

fn default_include_diff() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FsEditBatchEditResult {
    pub index: u64,
    pub replacements: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsEditBatchFileResult {
    pub path: String,
    pub before_sha256: String,
    pub after_sha256: String,
    pub replacements: u64,
    pub edits: Vec<FsEditBatchEditResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsEditBatchResult {
    pub files: Vec<FsEditBatchFileResult>,
    pub replacements: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_state: Option<String>,
}

struct PreparedFile {
    path: PathBuf,
    before_bytes: Vec<u8>,
    after_bytes: Vec<u8>,
    before_sha256: String,
    after_sha256: String,
    replacements: u64,
    edits: Vec<FsEditBatchEditResult>,
    diff: Option<String>,
}

#[derive(Serialize)]
struct RecoveryPathDetail {
    path: String,
    final_state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    actual_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
}

pub fn fs_edit_batch(
    ctx: &InvocationContext,
    req: &FsEditBatchRequest,
) -> Result<FsEditBatchResult, ToolError> {
    validate_request(req)?;
    check_cancelled(ctx)?;

    let _mutation_guard = (!req.dry_run).then(super::mutation_lock);
    let access = if req.dry_run {
        PathAccess::Read
    } else {
        PathAccess::Write
    };
    let mut prepared = Vec::with_capacity(req.files.len());
    let mut unique_paths: HashMap<PathBuf, usize> = HashMap::with_capacity(req.files.len());

    for (file_index, file) in req.files.iter().enumerate() {
        check_cancelled(ctx)?;
        let path = resolve_path(
            ctx,
            &file.path,
            req.base_dir.as_deref(),
            access,
            "fs.edit_batch",
        )?;
        let before_bytes = std::fs::read(&path).map_err(|error| {
            indexed_error(
                map_io_error(&error, "fs.edit_batch", &path),
                file_index,
                None,
            )
        })?;
        let identity = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone());
        if let Some(first_file_index) = unique_paths.insert(identity, file_index) {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.edit_batch",
                "a batch may not target the same resolved path twice",
            )
            .with_path(path.to_string_lossy())
            .with_details(serde_json::json!({
                "reason": "duplicate_target",
                "file_index": file_index,
                "first_file_index": first_file_index,
            })));
        }
        let before_sha256 = sha256_hex(&before_bytes);
        if before_sha256 != file.expected_sha256 {
            return Err(ToolError::new(
                ToolErrorCode::Conflict,
                "fs.edit_batch",
                "expected_sha256 does not match current content",
            )
            .with_path(path.to_string_lossy())
            .with_details(serde_json::json!({
                "reason": "preimage_mismatch",
                "file_index": file_index,
                "actual_sha256": before_sha256,
            })));
        }
        let original = std::str::from_utf8(&before_bytes).map_err(|_| {
            ToolError::new(
                ToolErrorCode::InvalidUtf8,
                "fs.edit_batch",
                "file content is not valid UTF-8",
            )
            .with_path(path.to_string_lossy())
            .with_details(serde_json::json!({
                "reason": "invalid_utf8",
                "file_index": file_index,
            }))
        })?;
        let plan = plan_edits(original, &file.edits, file_index, &path)?;
        let after_bytes = plan.working_copy.into_bytes();
        let after_sha256 = sha256_hex(&after_bytes);
        let diff = req.include_diff.then(|| {
            super::write::make_unified_diff(
                original,
                std::str::from_utf8(&after_bytes).expect("planned edits remain UTF-8"),
            )
        });
        prepared.push(PreparedFile {
            path,
            before_bytes,
            after_bytes,
            before_sha256,
            after_sha256,
            replacements: plan.replacements,
            edits: plan.edits,
            diff,
        });
    }

    let replacements = prepared.iter().map(|file| file.replacements).sum();
    if req.dry_run {
        return Ok(FsEditBatchResult {
            files: prepared.iter().map(file_result).collect(),
            replacements,
            change_id: None,
            change_state: Some(super::change::ChangeSetState::DryRun.as_str().to_string()),
        });
    }

    check_cancelled(ctx)?;
    let mut applied_indices = Vec::with_capacity(prepared.len());
    for (file_index, file) in prepared.iter().enumerate() {
        #[cfg(feature = "test-fixtures")]
        run_before_apply_fault(file_index, &file.path)?;

        let current = match std::fs::read(&file.path) {
            Ok(current) => current,
            Err(error) => {
                let failure = map_io_error(&error, "fs.edit_batch", &file.path);
                return Err(recover_after_failure(&prepared, &applied_indices, failure));
            }
        };
        let current_sha256 = sha256_hex(&current);
        if current_sha256 != file.before_sha256 {
            let failure = ToolError::new(
                ToolErrorCode::Conflict,
                "fs.edit_batch",
                "file changed after batch preflight",
            )
            .with_path(file.path.to_string_lossy())
            .with_details(serde_json::json!({
                "reason": "preimage_changed_during_apply",
                "file_index": file_index,
                "actual_sha256": current_sha256,
            }));
            return Err(recover_after_failure(&prepared, &applied_indices, failure));
        }

        #[cfg(feature = "test-fixtures")]
        if take_matching_fault(|fault| {
            matches!(fault, BatchTestFault::FailApply { file_index: index } if *index == file_index)
        })
        .is_some()
        {
            let error = std::io::Error::other("injected batch apply failure");
            let failure = map_io_error(&error, "fs.edit_batch", &file.path);
            return Err(recover_after_failure(&prepared, &applied_indices, failure));
        }

        if let Err(error) = super::atomic_write_file(&file.path, &file.after_bytes) {
            let failure = map_io_error(&error, "fs.edit_batch", &file.path);
            return Err(recover_after_failure(&prepared, &applied_indices, failure));
        }
        applied_indices.push(file_index);
    }

    let (change_id, change_state) = if req.reversible {
        let members = prepared
            .iter()
            .map(|file| {
                (
                    file.path.clone(),
                    file.before_bytes.clone(),
                    file.after_sha256.clone(),
                )
            })
            .collect();
        let applied = super::change::register_applied_group(members);
        (
            Some(applied.change_id),
            Some(applied.state.as_str().to_string()),
        )
    } else {
        (None, None)
    };

    Ok(FsEditBatchResult {
        files: prepared.iter().map(file_result).collect(),
        replacements,
        change_id,
        change_state,
    })
}

fn validate_request(req: &FsEditBatchRequest) -> Result<(), ToolError> {
    if req.files.is_empty() {
        return Err(invalid_input(
            "files must be non-empty",
            "empty_files",
            None,
            None,
        ));
    }
    if req.dry_run && req.reversible {
        return Err(invalid_input(
            "dry_run and reversible cannot both be true",
            "dry_run_reversible",
            None,
            None,
        ));
    }
    for (file_index, file) in req.files.iter().enumerate() {
        if !is_lower_sha256(&file.expected_sha256) {
            return Err(invalid_input(
                "expected_sha256 must be 64 lowercase hexadecimal characters",
                "invalid_sha256",
                Some(file_index),
                None,
            )
            .with_path(file.path.clone()));
        }
        if file.edits.is_empty() {
            return Err(invalid_input(
                "edits must be non-empty",
                "empty_edits",
                Some(file_index),
                None,
            )
            .with_path(file.path.clone()));
        }
        for (edit_index, edit) in file.edits.iter().enumerate() {
            if edit.old.is_empty() {
                return Err(invalid_input(
                    "old must be non-empty",
                    "empty_old",
                    Some(file_index),
                    Some(edit_index),
                )
                .with_path(file.path.clone()));
            }
        }
    }
    Ok(())
}

fn is_lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
}

struct EditPlan {
    working_copy: String,
    replacements: u64,
    edits: Vec<FsEditBatchEditResult>,
}

fn plan_edits(
    original: &str,
    edits: &[FsEditBatchEdit],
    file_index: usize,
    path: &Path,
) -> Result<EditPlan, ToolError> {
    let mut working_copy = original.to_string();
    let mut replacements = 0_u64;
    let mut edit_results = Vec::with_capacity(edits.len());
    for (edit_index, edit) in edits.iter().enumerate() {
        let count = working_copy.match_indices(&edit.old).count() as u64;
        if count == 0 {
            return Err(ToolError::new(
                ToolErrorCode::NotFound,
                "fs.edit_batch",
                "old text was not found in the current working copy",
            )
            .with_path(path.to_string_lossy())
            .with_details(serde_json::json!({
                "reason": "no_match",
                "file_index": file_index,
                "edit_index": edit_index,
            })));
        }
        if count > 1 && !edit.replace_all {
            return Err(ToolError::new(
                ToolErrorCode::Conflict,
                "fs.edit_batch",
                "old text matches multiple locations and replace_all is false",
            )
            .with_path(path.to_string_lossy())
            .with_details(serde_json::json!({
                "reason": "multiple_matches",
                "file_index": file_index,
                "edit_index": edit_index,
                "matches": count,
            })));
        }
        let replaced = if edit.replace_all { count } else { 1 };
        working_copy = if edit.replace_all {
            working_copy.replace(&edit.old, &edit.new)
        } else {
            working_copy.replacen(&edit.old, &edit.new, 1)
        };
        replacements += replaced;
        edit_results.push(FsEditBatchEditResult {
            index: edit_index as u64,
            replacements: replaced,
        });
    }
    Ok(EditPlan {
        working_copy,
        replacements,
        edits: edit_results,
    })
}

fn file_result(file: &PreparedFile) -> FsEditBatchFileResult {
    FsEditBatchFileResult {
        path: file.path.to_string_lossy().into_owned(),
        before_sha256: file.before_sha256.clone(),
        after_sha256: file.after_sha256.clone(),
        replacements: file.replacements,
        edits: file.edits.clone(),
        diff: file.diff.clone(),
    }
}

fn recover_after_failure(
    prepared: &[PreparedFile],
    applied_indices: &[usize],
    failure: ToolError,
) -> ToolError {
    for &file_index in applied_indices.iter().rev() {
        let file = &prepared[file_index];
        let current = match std::fs::read(&file.path) {
            Ok(current) => current,
            Err(_) => continue,
        };
        if sha256_hex(&current) != file.after_sha256 {
            continue;
        }

        #[cfg(feature = "test-fixtures")]
        if take_matching_fault(|fault| {
            matches!(fault, BatchTestFault::FailRecovery { file_index: index } if *index == file_index)
        })
        .is_some()
        {
            continue;
        }

        let _ = super::atomic_write_file(&file.path, &file.before_bytes);
    }

    let paths: Vec<RecoveryPathDetail> = prepared.iter().map(classify_final_state).collect();
    let recovery_complete = applied_indices
        .iter()
        .all(|&index| paths[index].final_state == "restored");
    if recovery_complete {
        let reason = if failure.code == ToolErrorCode::Conflict {
            "batch_apply_conflict_recovered"
        } else {
            "batch_write_failed_recovered"
        };
        let mut error = ToolError::new(
            failure.code,
            "fs.edit_batch",
            "batch apply failed and all earlier writes were restored",
        )
        .with_details(serde_json::json!({
            "reason": reason,
            "recovery_complete": true,
        }));
        error.path = failure.path;
        error.raw_os_error = failure.raw_os_error;
        return error;
    }

    ToolError::new(
        ToolErrorCode::RecoveryFailed,
        "fs.edit_batch",
        "batch apply failed and recovery did not restore every target",
    )
    .with_path(failure.path.unwrap_or_else(|| "<batch>".to_string()))
    .with_details(serde_json::json!({
        "reason": "batch_recovery_incomplete",
        "cause_code": failure.code.as_snake_case(),
        "paths": paths,
    }))
}

fn classify_final_state(file: &PreparedFile) -> RecoveryPathDetail {
    match std::fs::read(&file.path) {
        Ok(bytes) => {
            let actual = sha256_hex(&bytes);
            let final_state = if actual == file.before_sha256 {
                "restored"
            } else if actual == file.after_sha256 {
                "still_applied"
            } else {
                "changed_externally"
            };
            RecoveryPathDetail {
                path: file.path.to_string_lossy().into_owned(),
                final_state,
                actual_sha256: Some(actual),
                error_code: None,
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => RecoveryPathDetail {
            path: file.path.to_string_lossy().into_owned(),
            final_state: "absent",
            actual_sha256: None,
            error_code: Some(ToolErrorCode::NotFound.as_snake_case()),
        },
        Err(error) => {
            let code = map_io_error(&error, "fs.edit_batch", &file.path).code;
            RecoveryPathDetail {
                path: file.path.to_string_lossy().into_owned(),
                final_state: "unknown",
                actual_sha256: None,
                error_code: Some(code.as_snake_case()),
            }
        }
    }
}

fn invalid_input(
    message: &str,
    reason: &str,
    file_index: Option<usize>,
    edit_index: Option<usize>,
) -> ToolError {
    let mut details = serde_json::json!({"reason": reason});
    if let Some(file_index) = file_index {
        details["file_index"] = serde_json::json!(file_index);
    }
    if let Some(edit_index) = edit_index {
        details["edit_index"] = serde_json::json!(edit_index);
    }
    ToolError::new(ToolErrorCode::InvalidInput, "fs.edit_batch", message).with_details(details)
}

fn indexed_error(mut error: ToolError, file_index: usize, edit_index: Option<usize>) -> ToolError {
    if !error.details.is_object() {
        error.details = serde_json::json!({});
    }
    error.details["file_index"] = serde_json::json!(file_index);
    if let Some(edit_index) = edit_index {
        error.details["edit_index"] = serde_json::json!(edit_index);
    }
    error
}

fn check_cancelled(ctx: &InvocationContext) -> Result<(), ToolError> {
    if ctx.cancellation().is_cancelled() {
        Err(ToolError::new(
            ToolErrorCode::Cancelled,
            "fs.edit_batch",
            "batch edit was cancelled before its write phase",
        )
        .with_details(serde_json::json!({"reason": "cancelled_before_apply"})))
    } else {
        Ok(())
    }
}

#[cfg(feature = "test-fixtures")]
#[derive(Clone, Debug)]
pub enum BatchTestFault {
    FailApply { file_index: usize },
    FailRecovery { file_index: usize },
    ReplaceBeforeApply { file_index: usize, bytes: Vec<u8> },
}

#[cfg(feature = "test-fixtures")]
thread_local! {
    static BATCH_TEST_FAULTS: std::cell::RefCell<Vec<BatchTestFault>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(feature = "test-fixtures")]
pub struct BatchTestFaultGuard {
    _private: (),
}

#[cfg(feature = "test-fixtures")]
pub fn install_batch_test_faults(faults: Vec<BatchTestFault>) -> BatchTestFaultGuard {
    BATCH_TEST_FAULTS.with(|configured| *configured.borrow_mut() = faults);
    BatchTestFaultGuard { _private: () }
}

#[cfg(feature = "test-fixtures")]
impl Drop for BatchTestFaultGuard {
    fn drop(&mut self) {
        BATCH_TEST_FAULTS.with(|configured| configured.borrow_mut().clear());
    }
}

#[cfg(feature = "test-fixtures")]
fn take_matching_fault(predicate: impl Fn(&BatchTestFault) -> bool) -> Option<BatchTestFault> {
    BATCH_TEST_FAULTS.with(|configured| {
        let mut configured = configured.borrow_mut();
        configured
            .iter()
            .position(predicate)
            .map(|index| configured.remove(index))
    })
}

#[cfg(feature = "test-fixtures")]
fn run_before_apply_fault(file_index: usize, path: &Path) -> Result<(), ToolError> {
    let Some(BatchTestFault::ReplaceBeforeApply { bytes, .. }) = take_matching_fault(
        |fault| matches!(fault, BatchTestFault::ReplaceBeforeApply { file_index: index, .. } if *index == file_index),
    ) else {
        return Ok(());
    };
    super::atomic_write_file(path, &bytes)
        .map_err(|error| map_io_error(&error, "fs.edit_batch.test_external_write", path))
}
