use std::path::PathBuf;

#[cfg(feature = "test-fixtures")]
use xuanling_toolkit::fs::BatchTestFault;
use xuanling_toolkit::fs::{
    self, FsEditBatchEdit, FsEditBatchFile, FsEditBatchRequest, FsPatchRequest,
};
use xuanling_toolkit::invocation::ManualCancellation;
use xuanling_toolkit::{PathContext, ToolErrorCode};

fn context() -> xuanling_toolkit::InvocationContext {
    xuanling_toolkit::InvocationContext::new(PathContext::new(PathBuf::from(".")))
}

#[test]
fn recovery_failed_is_a_stable_error_code() {
    let code: ToolErrorCode = serde_json::from_str("\"recovery_failed\"")
        .expect("batch recovery requires the stable recovery_failed code");
    assert_eq!(code.as_snake_case(), "recovery_failed");
}

#[test]
fn fs_patch_accepts_standard_ranges_with_implicit_unit_counts() {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("implicit-count.txt");
    let original = b"before\n";
    std::fs::write(&path, original).expect("write fixture");

    let result = fs::fs_patch(
        &context(),
        &FsPatchRequest {
            path: path.to_string_lossy().into_owned(),
            expected_preimage_sha256: fs::sha256_hex(original),
            unified_diff: "@@ -1 +1 @@\n-before\n+after\n".to_string(),
            base_dir: None,
        },
    )
    .expect("standard unified diff may omit the default ,1 counts");

    assert_eq!(result.hunks_applied, 1);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "after\n");
}

fn batch_file(
    path: &std::path::Path,
    before: &[u8],
    edits: Vec<FsEditBatchEdit>,
) -> FsEditBatchFile {
    FsEditBatchFile {
        path: path.to_string_lossy().into_owned(),
        expected_sha256: fs::sha256_hex(before),
        edits,
    }
}

fn edit(old: &str, new: &str) -> FsEditBatchEdit {
    FsEditBatchEdit {
        old: old.to_string(),
        new: new.to_string(),
        replace_all: false,
    }
}

fn request(files: Vec<FsEditBatchFile>) -> FsEditBatchRequest {
    FsEditBatchRequest {
        files,
        base_dir: None,
        dry_run: false,
        reversible: false,
        include_diff: true,
    }
}

#[test]
fn edit_batch_applies_edits_in_order_and_reports_one_diff_per_file() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    std::fs::write(&first, "alpha\n").unwrap();
    std::fs::write(&second, "left right\n").unwrap();

    let result = fs::fs_edit_batch(
        &context(),
        &request(vec![
            batch_file(
                &first,
                b"alpha\n",
                vec![edit("alpha", "middle"), edit("middle", "omega")],
            ),
            batch_file(&second, b"left right\n", vec![edit("right", "done")]),
        ]),
    )
    .expect("ordered batch");

    assert_eq!(std::fs::read_to_string(&first).unwrap(), "omega\n");
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "left done\n");
    assert_eq!(result.replacements, 3);
    assert_eq!(result.files[0].edits[0].index, 0);
    assert_eq!(result.files[0].edits[1].index, 1);
    assert_eq!(result.files[0].replacements, 2);
    assert!(result.files[0].diff.as_deref().unwrap().contains("+omega"));
    assert_eq!(result.change_id, None);
    assert_eq!(result.change_state, None);
}

#[test]
fn edit_batch_preflights_every_target_before_the_first_write() {
    for failure in ["stale", "utf8", "match"] {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first.txt");
        let second = dir.path().join("second.txt");
        std::fs::write(&first, "first before\n").unwrap();
        let second_bytes: &[u8] = if failure == "utf8" {
            b"\xff\xfe"
        } else {
            b"second before\n"
        };
        std::fs::write(&second, second_bytes).unwrap();
        let first_modified = std::fs::metadata(&first).unwrap().modified().unwrap();

        let mut second_file = batch_file(
            &second,
            second_bytes,
            vec![edit(
                if failure == "match" {
                    "missing"
                } else {
                    "second"
                },
                "changed",
            )],
        );
        if failure == "stale" {
            second_file.expected_sha256 = "0".repeat(64);
        }
        let error = fs::fs_edit_batch(
            &context(),
            &request(vec![
                batch_file(&first, b"first before\n", vec![edit("before", "after")]),
                second_file,
            ]),
        )
        .expect_err("second target must fail preflight");

        let expected = match failure {
            "stale" => ToolErrorCode::Conflict,
            "utf8" => ToolErrorCode::InvalidUtf8,
            "match" => ToolErrorCode::NotFound,
            _ => unreachable!(),
        };
        assert_eq!(
            error.code, expected,
            "wrong failure for {failure}: {error:?}"
        );
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "first before\n");
        assert_eq!(
            std::fs::metadata(&first).unwrap().modified().unwrap(),
            first_modified,
            "preflight failure must not rewrite an earlier target ({failure})"
        );
    }
}

#[test]
fn edit_batch_validates_public_shape_and_dry_run_contract() {
    let empty = fs::fs_edit_batch(&context(), &request(Vec::new())).unwrap_err();
    assert_eq!(empty.code, ToolErrorCode::InvalidInput);
    assert_eq!(empty.details["reason"], "empty_files");

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shape.txt");
    std::fs::write(&path, "before").unwrap();
    let mut invalid_hash = request(vec![batch_file(
        &path,
        b"before",
        vec![edit("before", "after")],
    )]);
    invalid_hash.files[0].expected_sha256 = "ABC".to_string();
    let error = fs::fs_edit_batch(&context(), &invalid_hash).unwrap_err();
    assert_eq!(error.details["reason"], "invalid_sha256");

    let mut dry_reversible = request(vec![batch_file(
        &path,
        b"before",
        vec![edit("before", "after")],
    )]);
    dry_reversible.dry_run = true;
    dry_reversible.reversible = true;
    let error = fs::fs_edit_batch(&context(), &dry_reversible).unwrap_err();
    assert_eq!(error.details["reason"], "dry_run_reversible");
    assert_eq!(std::fs::read_to_string(path).unwrap(), "before");
}

#[test]
fn edit_batch_rejects_duplicate_resolved_targets_before_writing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("duplicate.txt");
    std::fs::write(&path, "before").unwrap();
    let alias = dir.path().join(".").join("duplicate.txt");

    let error = fs::fs_edit_batch(
        &context(),
        &request(vec![
            batch_file(&path, b"before", vec![edit("before", "first")]),
            batch_file(&alias, b"before", vec![edit("before", "second")]),
        ]),
    )
    .expect_err("resolved duplicate target");

    assert_eq!(error.code, ToolErrorCode::InvalidInput);
    assert_eq!(error.details["reason"], "duplicate_target");
    assert_eq!(error.details["file_index"], 1);
    assert_eq!(error.details["first_file_index"], 0);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "before");
}

#[test]
fn edit_batch_dry_run_uses_read_capability_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("preview.txt");
    std::fs::write(&path, "before\n").unwrap();
    let mut req = request(vec![batch_file(
        &path,
        b"before\n",
        vec![edit("before", "after")],
    )]);
    req.dry_run = true;
    let result = fs::fs_edit_batch(&context(), &req).expect("preview");
    assert_eq!(result.change_state.as_deref(), Some("dry_run"));
    assert!(result.files[0].diff.as_deref().unwrap().contains("+after"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "before\n");
}

#[test]
#[cfg(feature = "test-fixtures")]
fn edit_batch_clean_write_failure_restores_in_reverse_order() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    std::fs::write(&first, "first before").unwrap();
    std::fs::write(&second, "second before").unwrap();
    let _faults = fs::install_batch_test_faults(vec![BatchTestFault::FailApply { file_index: 1 }]);

    let error = fs::fs_edit_batch(
        &context(),
        &request(vec![
            batch_file(&first, b"first before", vec![edit("before", "after")]),
            batch_file(&second, b"second before", vec![edit("before", "after")]),
        ]),
    )
    .expect_err("injected second write failure");

    assert_eq!(error.code, ToolErrorCode::IoError);
    assert_eq!(error.details["reason"], "batch_write_failed_recovered");
    assert_eq!(error.details["recovery_complete"], true);
    assert_eq!(std::fs::read_to_string(first).unwrap(), "first before");
    assert_eq!(std::fs::read_to_string(second).unwrap(), "second before");
}

#[test]
#[cfg(feature = "test-fixtures")]
fn edit_batch_incomplete_recovery_returns_per_path_terminal_states() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    std::fs::write(&first, "first before").unwrap();
    std::fs::write(&second, "second before").unwrap();
    let _faults = fs::install_batch_test_faults(vec![
        BatchTestFault::FailApply { file_index: 1 },
        BatchTestFault::FailRecovery { file_index: 0 },
    ]);

    let error = fs::fs_edit_batch(
        &context(),
        &request(vec![
            batch_file(&first, b"first before", vec![edit("before", "after")]),
            batch_file(&second, b"second before", vec![edit("before", "after")]),
        ]),
    )
    .expect_err("injected recovery failure");

    assert_eq!(error.code, ToolErrorCode::RecoveryFailed);
    assert_eq!(error.details["reason"], "batch_recovery_incomplete");
    assert_eq!(error.details["paths"][0]["final_state"], "still_applied");
    assert_eq!(error.details["paths"][1]["final_state"], "restored");
    assert_eq!(std::fs::read_to_string(first).unwrap(), "first after");
    assert_eq!(std::fs::read_to_string(second).unwrap(), "second before");
    let serialized = serde_json::to_string(&error).unwrap();
    assert!(!serialized.contains("first before"));
    assert!(!serialized.contains("first after"));
}

#[test]
#[cfg(feature = "test-fixtures")]
fn edit_batch_external_writer_triggers_revalidation_and_preserves_external_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    std::fs::write(&first, "first before").unwrap();
    std::fs::write(&second, "second before").unwrap();
    let _faults = fs::install_batch_test_faults(vec![BatchTestFault::ReplaceBeforeApply {
        file_index: 1,
        bytes: b"formatter output".to_vec(),
    }]);

    let error = fs::fs_edit_batch(
        &context(),
        &request(vec![
            batch_file(&first, b"first before", vec![edit("before", "after")]),
            batch_file(&second, b"second before", vec![edit("before", "after")]),
        ]),
    )
    .expect_err("external writer invalidates the second preimage");

    assert_eq!(error.code, ToolErrorCode::Conflict);
    assert_eq!(error.details["reason"], "batch_apply_conflict_recovered");
    assert_eq!(std::fs::read_to_string(first).unwrap(), "first before");
    assert_eq!(std::fs::read_to_string(second).unwrap(), "formatter output");
}

#[test]
fn grouped_changeset_rolls_back_all_files_after_full_preflight() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    std::fs::write(&first, "first before").unwrap();
    std::fs::write(&second, "second before").unwrap();
    let mut req = request(vec![
        batch_file(&first, b"first before", vec![edit("before", "after")]),
        batch_file(&second, b"second before", vec![edit("before", "after")]),
    ]);
    req.reversible = true;
    let applied = fs::fs_edit_batch(&context(), &req).expect("group apply");
    let change_id = applied.change_id.expect("group change id");
    assert_eq!(
        applied.change_state.as_deref(),
        Some("applied_awaiting_completion")
    );

    assert_eq!(
        fs::changeset_rollback(&change_id).expect("group rollback"),
        fs::ChangeSetState::RolledBack
    );
    assert_eq!(std::fs::read_to_string(first).unwrap(), "first before");
    assert_eq!(std::fs::read_to_string(second).unwrap(), "second before");
}

#[test]
fn grouped_changeset_formatter_conflict_restores_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.txt");
    let second = dir.path().join("second.txt");
    std::fs::write(&first, "first before").unwrap();
    std::fs::write(&second, "second before").unwrap();
    let mut req = request(vec![
        batch_file(&first, b"first before", vec![edit("before", "after")]),
        batch_file(&second, b"second before", vec![edit("before", "after")]),
    ]);
    req.reversible = true;
    let change_id = fs::fs_edit_batch(&context(), &req)
        .unwrap()
        .change_id
        .unwrap();
    std::fs::write(&second, "formatter output").unwrap();

    assert_eq!(
        fs::changeset_rollback(&change_id).expect("conflict is a state"),
        fs::ChangeSetState::RollbackConflict
    );
    assert_eq!(std::fs::read_to_string(first).unwrap(), "first after");
    assert_eq!(std::fs::read_to_string(second).unwrap(), "formatter output");
}

#[cfg(unix)]
#[test]
fn grouped_changeset_partial_restore_is_retryable_and_not_committable() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let first_dir = dir.path().join("first-dir");
    let second_dir = dir.path().join("second-dir");
    std::fs::create_dir_all(&first_dir).unwrap();
    std::fs::create_dir_all(&second_dir).unwrap();
    let first = first_dir.join("first.txt");
    let second = second_dir.join("second.txt");
    std::fs::write(&first, "first before").unwrap();
    std::fs::write(&second, "second before").unwrap();
    let mut req = request(vec![
        batch_file(&first, b"first before", vec![edit("before", "after")]),
        batch_file(&second, b"second before", vec![edit("before", "after")]),
    ]);
    req.reversible = true;
    let change_id = fs::fs_edit_batch(&context(), &req)
        .unwrap()
        .change_id
        .unwrap();

    let original_mode = std::fs::metadata(&first_dir).unwrap().permissions().mode();
    std::fs::set_permissions(&first_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let failed = fs::changeset_rollback(&change_id).expect_err("first directory is readonly");
    std::fs::set_permissions(&first_dir, std::fs::Permissions::from_mode(original_mode)).unwrap();

    assert_eq!(failed.code, ToolErrorCode::RecoveryFailed);
    assert_eq!(
        fs::change::state_of(&change_id),
        Some(fs::ChangeSetState::RecoveryFailed)
    );
    assert_eq!(std::fs::read_to_string(&first).unwrap(), "first after");
    assert_eq!(std::fs::read_to_string(&second).unwrap(), "second before");
    let commit = fs::changeset_commit(&change_id).expect_err("mixed state cannot commit");
    assert_eq!(commit.details["state"], "recovery_failed");

    assert_eq!(
        fs::changeset_rollback(&change_id).expect("retry completes recovery"),
        fs::ChangeSetState::RolledBack
    );
    assert_eq!(std::fs::read_to_string(first).unwrap(), "first before");
}

#[test]
fn edit_batch_cancelled_before_apply_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("cancelled.txt");
    std::fs::write(&path, "before").unwrap();
    let cancellation = ManualCancellation::new();
    cancellation.cancel();
    let ctx = context().with_cancellation(std::sync::Arc::new(cancellation));
    let error = fs::fs_edit_batch(
        &ctx,
        &request(vec![batch_file(
            &path,
            b"before",
            vec![edit("before", "after")],
        )]),
    )
    .expect_err("cancelled before preflight");
    assert_eq!(error.code, ToolErrorCode::Cancelled);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "before");
}
