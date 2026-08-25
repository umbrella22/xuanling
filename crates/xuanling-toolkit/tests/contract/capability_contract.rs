use std::collections::BTreeMap;

use xuanling_toolkit::fs::{
    ChangeSetState, EntryKind, FsCopyRequest, FsEditRequest, FsListRequest, FsReadTextRequest,
    FsRemoveRequest, FsSearchOptions, FsSearchRequest, FsStatRequest, FsWriteTextRequest,
    WriteMode, changeset_commit_with_context, changeset_rollback, changeset_rollback_with_context,
    fs_copy, fs_edit, fs_list, fs_remove, fs_stat, fs_write_text, read_text, search_with_options,
};
#[cfg(feature = "test-fixtures")]
use xuanling_toolkit::process::{PipelineStage, ProcessPipelineRequest, process_pipeline};
use xuanling_toolkit::process::{
    ProcessRunRequest, ProcessStreamMode, SessionCloseRequest, SessionExecRequest,
    SessionOpenRequest, process_run, session_close, session_exec, session_open,
};
use xuanling_toolkit::{FilesystemScope, InvocationContext, PathContext, ToolErrorCode};

fn contained(root: &std::path::Path) -> InvocationContext {
    InvocationContext::new(PathContext::new(root))
        .with_filesystem_scope(FilesystemScope::workspace(root).expect("valid workspace scope"))
}

#[cfg(feature = "test-fixtures")]
fn process_tree_helper() -> String {
    std::path::PathBuf::from(env!("CARGO_BIN_EXE_xuanling-process-tree-test-helper"))
        .to_string_lossy()
        .into_owned()
}

#[cfg(feature = "test-fixtures")]
fn assert_cwd_is(output: &str, expected: &std::path::Path) {
    let actual = std::fs::canonicalize(output.trim()).expect("helper must print an existing cwd");
    let expected = std::fs::canonicalize(expected).expect("expected cwd exists");
    assert_eq!(
        actual, expected,
        "child inherited the wrong cwd: {output:?}"
    );
}

#[test]
fn workspace_scope_allows_internal_read_and_rejects_absolute_escape() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(workspace.path().join("inside.txt"), "inside").expect("inside fixture");
    let outside_file = outside.path().join("outside.txt");
    std::fs::write(&outside_file, "outside").expect("outside fixture");
    let ctx = contained(workspace.path());

    let inside = read_text(
        &ctx,
        &FsReadTextRequest {
            path: "inside.txt".to_string(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect("inside read");
    assert_eq!(inside.content, "inside");

    let error = read_text(
        &ctx,
        &FsReadTextRequest {
            path: outside_file.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect_err("outside read must be rejected");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
    assert_eq!(error.details["reason"], "path_outside_workspace");
}

#[test]
fn request_base_cannot_expand_workspace_scope() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("outside.txt"), "outside").expect("outside fixture");
    let error = read_text(
        &contained(workspace.path()),
        &FsReadTextRequest {
            path: "outside.txt".to_string(),
            base_dir: Some(outside.path().to_string_lossy().into_owned()),
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect_err("outside request base must be rejected");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
}

#[test]
fn relative_request_base_is_resolved_against_the_invocation_context() {
    let workspace = tempfile::tempdir().expect("workspace");
    let nested = workspace.path().join("nested");
    std::fs::create_dir(&nested).expect("nested directory");
    std::fs::write(nested.join("inside.txt"), "inside").expect("inside fixture");

    let result = read_text(
        &contained(workspace.path()),
        &FsReadTextRequest {
            path: "inside.txt".to_string(),
            base_dir: Some("nested".to_string()),
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect("relative base resolves within the invocation workspace");
    assert_eq!(result.content, "inside");
}

#[test]
fn workspace_scope_writes_a_relative_target() {
    // This is intentionally independent of symlink support. In particular it
    // protects ordinary Windows workspace paths, where `canonicalize` may use
    // the extended-length spelling while the incoming path does not.
    let workspace = tempfile::tempdir().expect("workspace");
    let target = workspace.path().join("inside.txt");

    fs_write_text(
        &contained(workspace.path()),
        &FsWriteTextRequest {
            path: "inside.txt".to_string(),
            base_dir: None,
            content: "inside".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect("ordinary contained relative write");

    assert_eq!(
        std::fs::read_to_string(target).expect("read written file"),
        "inside"
    );
}

#[test]
fn workspace_scope_accepts_a_workspace_root_alias_for_relative_mutation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let aliases = tempfile::tempdir().expect("alias parent");
    let workspace_alias = aliases.path().join("workspace-alias");
    if !create_directory_symlink(workspace.path(), &workspace_alias) {
        return;
    }

    fs_write_text(
        &contained(&workspace_alias),
        &FsWriteTextRequest {
            path: "inside.txt".to_string(),
            base_dir: None,
            content: "through workspace alias".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect("workspace-root alias must be a valid default base");

    assert_eq!(
        std::fs::read_to_string(workspace.path().join("inside.txt")).expect("read written file"),
        "through workspace alias"
    );
}

#[test]
fn workspace_scope_freezes_an_internal_context_base_alias_before_mutation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let physical_base = workspace.path().join("sub");
    std::fs::create_dir(&physical_base).expect("base directory");
    let aliases = tempfile::tempdir().expect("alias parent");
    let alias = aliases.path().join("sub-alias");
    if !create_directory_symlink(&physical_base, &alias) {
        return;
    }
    let ctx = InvocationContext::new(PathContext::new(&alias)).with_filesystem_scope(
        FilesystemScope::workspace(workspace.path()).expect("valid workspace scope"),
    );

    fs_write_text(
        &ctx,
        &FsWriteTextRequest {
            path: "created.txt".to_string(),
            base_dir: None,
            content: "created through context alias".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect("an internal context base alias resolves to its physical directory");

    assert_eq!(
        std::fs::read_to_string(physical_base.join("created.txt")).expect("read created file"),
        "created through context alias"
    );
}

#[test]
fn workspace_scope_freezes_an_internal_request_base_alias_before_mutation() {
    let workspace = tempfile::tempdir().expect("workspace");
    let physical_base = workspace.path().join("sub");
    let physical_other = workspace.path().join("other");
    std::fs::create_dir(&physical_base).expect("base directory");
    std::fs::create_dir(&physical_other).expect("other directory");
    let aliases = tempfile::tempdir().expect("alias parent");
    let alias = aliases.path().join("sub-alias");
    if !create_directory_symlink(&physical_base, &alias) {
        return;
    }
    let ctx = contained(workspace.path());

    fs_write_text(
        &ctx,
        &FsWriteTextRequest {
            path: "created.txt".to_string(),
            base_dir: Some(alias.to_string_lossy().into_owned()),
            content: "created through base alias".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect("an internal base alias resolves to its physical directory");
    assert_eq!(
        std::fs::read_to_string(physical_base.join("created.txt")).expect("read created file"),
        "created through base alias"
    );

    let target_alias = physical_base.join("target-alias");
    if !create_directory_symlink(&physical_other, &target_alias) {
        return;
    }
    let error = fs_write_text(
        &ctx,
        &FsWriteTextRequest {
            path: "target-alias/blocked.txt".to_string(),
            base_dir: Some(alias.to_string_lossy().into_owned()),
            content: "must not write through target alias".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect_err("a symlink below the effective base remains a mutation escape");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
    assert_eq!(error.details["reason"], "symlink_escape");
    assert!(!physical_other.join("blocked.txt").exists());
}

#[test]
fn workspace_scope_rejects_an_external_request_base_alias() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let aliases = tempfile::tempdir().expect("alias parent");
    let alias = aliases.path().join("outside-alias");
    if !create_directory_symlink(outside.path(), &alias) {
        return;
    }

    let error = fs_write_text(
        &contained(workspace.path()),
        &FsWriteTextRequest {
            path: "blocked.txt".to_string(),
            base_dir: Some(alias.to_string_lossy().into_owned()),
            content: "must not write outside".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect_err("an external base alias must not expand the workspace");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
    assert!(!outside.path().join("blocked.txt").exists());
}

fn create_directory_symlink(target: &std::path::Path, link: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).expect("directory symlink fixture");
        true
    }

    #[cfg(windows)]
    {
        match std::os::windows::fs::symlink_dir(target, link) {
            Ok(()) => true,
            // Developer Mode or the SeCreateSymbolicLinkPrivilege privilege is
            // not guaranteed on every Windows CI worker. Keep the ordinary
            // relative-write test above active there, and skip only this
            // fixture-dependent contract when the OS forbids its setup.
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("skipping symlink capability contract: {error}");
                false
            }
            Err(error) => panic!("directory symlink fixture: {error}"),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        false
    }
}

fn create_file_symlink(target: &std::path::Path, link: &std::path::Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).expect("file symlink fixture");
        true
    }

    #[cfg(windows)]
    {
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => true,
            // Windows symlink creation depends on Developer Mode or an
            // explicit privilege. Skip only the fixture-dependent contract.
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                eprintln!("skipping symlink capability contract: {error}");
                false
            }
            Err(error) => panic!("file symlink fixture: {error}"),
        }
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (target, link);
        false
    }
}

#[test]
fn mutation_rejects_symlink_ancestor_escape() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    if !create_directory_symlink(outside.path(), &workspace.path().join("linked")) {
        return;
    }

    let error = fs_write_text(
        &contained(workspace.path()),
        &FsWriteTextRequest {
            path: "linked/new.txt".to_string(),
            base_dir: None,
            content: "blocked".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect_err("symlink escape must be rejected");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
    assert_eq!(error.details["reason"], "path_outside_workspace");
    assert!(!outside.path().join("new.txt").exists());
}

#[test]
fn symlink_followed_by_parent_traversal_keeps_os_path_semantics() {
    let container = tempfile::tempdir().expect("container");
    let workspace = container.path().join("workspace");
    let outside = container.path().join("outside");
    std::fs::create_dir(&workspace).expect("workspace");
    std::fs::create_dir(&outside).expect("outside");
    std::fs::write(container.path().join("secret.txt"), "outside").expect("outside fixture");
    let link = workspace.join("external-dir");
    if !create_directory_symlink(&outside, &link) {
        return;
    }

    let error = read_text(
        &contained(&workspace),
        &FsReadTextRequest {
            path: "external-dir/../secret.txt".to_string(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect_err("the OS resolves .. after following the preceding symlink");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);

    let missing_error = fs_stat(
        &contained(&workspace),
        &FsStatRequest {
            path: "external-dir/../missing.txt".to_string(),
            base_dir: None,
            follow_symlinks: true,
        },
    )
    .expect_err("a missing external intent must still fail at the capability");
    assert_eq!(missing_error.code, ToolErrorCode::OutsideCapability);
}

#[test]
fn missing_component_reintroduced_after_parent_traversal_returns_not_found() {
    let workspace = tempfile::tempdir().expect("workspace");

    let error = fs_stat(
        &contained(workspace.path()),
        &FsStatRequest {
            path: "missing/../missing".to_string(),
            base_dir: None,
            follow_symlinks: true,
        },
    )
    .expect_err("a missing component reintroduced after .. must terminate");

    assert_eq!(error.code, ToolErrorCode::NotFound);
}

#[test]
fn copy_validates_source_and_destination_independently() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(workspace.path().join("inside.txt"), "inside").expect("inside fixture");
    let error = fs_copy(
        &contained(workspace.path()),
        &FsCopyRequest {
            from: "inside.txt".to_string(),
            to: outside
                .path()
                .join("copy.txt")
                .to_string_lossy()
                .into_owned(),
            base_dir: None,
            overwrite: false,
            recursive: false,
        },
    )
    .expect_err("outside destination must be rejected");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
}

#[test]
fn list_follow_symlinks_prunes_external_descendants() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let sentinel_dir = outside.path().join("sentinel");
    std::fs::create_dir(&sentinel_dir).expect("sentinel dir");
    std::fs::write(sentinel_dir.join("secret.txt"), "secret").expect("outside fixture");
    if !create_directory_symlink(&sentinel_dir, &workspace.path().join("external")) {
        return;
    }

    let result = fs_list(
        &contained(workspace.path()),
        &FsListRequest {
            path: ".".to_string(),
            base_dir: None,
            recursive: true,
            max_depth: None,
            limit: None,
            cursor: None,
            include_hidden: true,
            respect_gitignore: false,
            follow_symlinks: true,
            max_output_bytes: None,
        },
    )
    .expect("list workspace");
    assert!(
        result
            .entries
            .iter()
            .all(|entry| !entry.path.ends_with("secret.txt")),
        "external descendant must not be listed: {result:?}"
    );
    assert!(
        result
            .entries
            .iter()
            .all(|entry| !entry.path.contains("sentinel")),
        "external directory itself must be pruned before descent: {result:?}"
    );
}

#[test]
fn nofollow_tools_can_inspect_and_unlink_an_external_target_symlink_entry() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let outside_file = outside.path().join("secret.txt");
    std::fs::write(&outside_file, "secret").expect("outside fixture");
    let link = workspace.path().join("external-link");
    if !create_file_symlink(&outside_file, &link) {
        return;
    }
    let ctx = contained(workspace.path());

    let stat = fs_stat(
        &ctx,
        &FsStatRequest {
            path: "external-link".to_string(),
            base_dir: None,
            follow_symlinks: false,
        },
    )
    .expect("nofollow stat should inspect the workspace directory entry");
    assert_eq!(stat.kind, EntryKind::Symlink);
    assert_eq!(
        stat.absolute_path,
        std::fs::canonicalize(workspace.path())
            .expect("workspace exists")
            .join("external-link")
            .to_string_lossy()
    );
    assert_eq!(
        stat.symlink_target.as_deref(),
        Some(outside_file.to_string_lossy().as_ref())
    );

    let follow_error = fs_stat(
        &ctx,
        &FsStatRequest {
            path: "external-link".to_string(),
            base_dir: None,
            follow_symlinks: true,
        },
    )
    .expect_err("following an external target must remain outside capability");
    assert_eq!(follow_error.code, ToolErrorCode::OutsideCapability);

    let read_error = read_text(
        &ctx,
        &FsReadTextRequest {
            path: "external-link".to_string(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect_err("reading an external target must remain outside capability");
    assert_eq!(read_error.code, ToolErrorCode::OutsideCapability);

    let removed = fs_remove(
        &ctx,
        &FsRemoveRequest {
            path: "external-link".to_string(),
            base_dir: None,
            recursive: false,
            missing_ok: false,
        },
    )
    .expect("remove should unlink the workspace directory entry");
    assert!(removed.removed);
    assert_eq!(removed.kind, "symlink");
    assert!(std::fs::symlink_metadata(&link).is_err());
    assert_eq!(
        std::fs::read_to_string(&outside_file).expect("target remains"),
        "secret"
    );
}

#[test]
fn list_nofollow_includes_external_target_symlink_without_descending() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("secret.txt"), "secret").expect("outside fixture");
    let link = workspace.path().join("external-dir");
    if !create_directory_symlink(outside.path(), &link) {
        return;
    }

    let result = fs_list(
        &contained(workspace.path()),
        &FsListRequest {
            path: ".".to_string(),
            base_dir: None,
            recursive: true,
            max_depth: None,
            limit: None,
            cursor: None,
            include_hidden: true,
            respect_gitignore: false,
            follow_symlinks: false,
            max_output_bytes: None,
        },
    )
    .expect("nofollow list");
    assert!(
        result.entries.iter().any(|entry| {
            entry.path
                == std::fs::canonicalize(workspace.path())
                    .expect("workspace exists")
                    .join("external-dir")
                    .to_string_lossy()
                && entry.kind == EntryKind::Symlink
        }),
        "symlink entry must remain visible: {result:?}"
    );
    assert!(
        result
            .entries
            .iter()
            .all(|entry| !entry.path.ends_with("secret.txt")),
        "nofollow list must not descend through the link: {result:?}"
    );
}

#[test]
fn nofollow_stat_and_remove_allow_a_dangling_workspace_symlink() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let missing_target = outside.path().join("missing-target");
    let link = workspace.path().join("dangling");
    if !create_file_symlink(&missing_target, &link) {
        return;
    }
    let ctx = contained(workspace.path());

    let stat = fs_stat(
        &ctx,
        &FsStatRequest {
            path: "dangling".to_string(),
            base_dir: None,
            follow_symlinks: false,
        },
    )
    .expect("nofollow stat should not require the target to exist");
    assert_eq!(stat.kind, EntryKind::Symlink);

    let follow_error = fs_stat(
        &ctx,
        &FsStatRequest {
            path: "dangling".to_string(),
            base_dir: None,
            follow_symlinks: true,
        },
    )
    .expect_err("following an external dangling target must fail closed");
    assert_eq!(follow_error.code, ToolErrorCode::OutsideCapability);

    let removed = fs_remove(
        &ctx,
        &FsRemoveRequest {
            path: "dangling".to_string(),
            base_dir: None,
            recursive: false,
            missing_ok: false,
        },
    )
    .expect("remove should unlink a dangling symlink");
    assert!(removed.removed);
    assert_eq!(removed.kind, "symlink");
    assert!(std::fs::symlink_metadata(&link).is_err());
}

#[test]
fn follow_stat_reports_not_found_for_a_dangling_internal_symlink() {
    let workspace = tempfile::tempdir().expect("workspace");
    let missing_target = workspace.path().join("missing-target");
    let link = workspace.path().join("dangling-internal");
    if !create_file_symlink(&missing_target, &link) {
        return;
    }

    let error = fs_stat(
        &contained(workspace.path()),
        &FsStatRequest {
            path: "dangling-internal".to_string(),
            base_dir: None,
            follow_symlinks: true,
        },
    )
    .expect_err("the contained target is missing");
    assert_eq!(error.code, ToolErrorCode::NotFound);
}

#[test]
fn remove_unlinks_an_external_target_directory_symlink_without_removing_the_target() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(outside.path().join("sentinel.txt"), "target remains").expect("outside fixture");
    let link = workspace.path().join("external-directory");
    if !create_directory_symlink(outside.path(), &link) {
        return;
    }

    let removed = fs_remove(
        &contained(workspace.path()),
        &FsRemoveRequest {
            path: "external-directory".to_string(),
            base_dir: None,
            recursive: false,
            missing_ok: false,
        },
    )
    .expect("remove should unlink the directory entry, not traverse it");

    assert!(removed.removed);
    assert_eq!(removed.kind, "symlink");
    assert!(std::fs::symlink_metadata(&link).is_err());
    assert_eq!(
        std::fs::read_to_string(outside.path().join("sentinel.txt"))
            .expect("target directory remains"),
        "target remains"
    );
}

fn entry_suffixes() -> [String; 2] {
    let separator = std::path::MAIN_SEPARATOR;
    [separator.to_string(), format!("{separator}.")]
}

#[test]
fn unrestricted_nofollow_entry_tools_ignore_directory_symlink_suffixes() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let ctx = InvocationContext::new(PathContext::new(workspace.path()));

    for (index, suffix) in entry_suffixes().into_iter().enumerate() {
        let target = outside.path().join(format!("target-{index}"));
        std::fs::create_dir(&target).expect("target directory");
        let sentinel = target.join("sentinel.txt");
        std::fs::write(&sentinel, "target remains").expect("target fixture");
        let link = workspace.path().join(format!("directory-link-{index}"));
        if !create_directory_symlink(&target, &link) {
            return;
        }
        let locator = format!("{}{suffix}", link.to_string_lossy());

        let stat = fs_stat(
            &ctx,
            &FsStatRequest {
                path: locator.clone(),
                base_dir: None,
                follow_symlinks: false,
            },
        )
        .expect("nofollow stat must inspect the final symlink entry");
        assert_eq!(stat.kind, EntryKind::Symlink);

        let removed = fs_remove(
            &ctx,
            &FsRemoveRequest {
                path: locator,
                base_dir: None,
                recursive: true,
                missing_ok: false,
            },
        )
        .expect("remove must unlink the final symlink entry");

        assert_eq!(removed.kind, "symlink");
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(
            std::fs::read_to_string(&sentinel).expect("target directory remains"),
            "target remains"
        );
    }
}

#[test]
fn contained_nofollow_entry_tools_ignore_directory_symlink_suffixes() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let ctx = contained(workspace.path());

    for (index, suffix) in entry_suffixes().into_iter().enumerate() {
        let target = outside.path().join(format!("target-{index}"));
        std::fs::create_dir(&target).expect("target directory");
        let sentinel = target.join("sentinel.txt");
        std::fs::write(&sentinel, "target remains").expect("target fixture");
        let link_name = format!("directory-link-{index}");
        let link = workspace.path().join(&link_name);
        if !create_directory_symlink(&target, &link) {
            return;
        }
        let locator = format!("{link_name}{suffix}");

        let stat = fs_stat(
            &ctx,
            &FsStatRequest {
                path: locator.clone(),
                base_dir: None,
                follow_symlinks: false,
            },
        )
        .expect("nofollow stat must inspect the final symlink entry");
        assert_eq!(stat.kind, EntryKind::Symlink);

        let removed = fs_remove(
            &ctx,
            &FsRemoveRequest {
                path: locator,
                base_dir: None,
                recursive: true,
                missing_ok: false,
            },
        )
        .expect("remove must unlink the final symlink entry");

        assert_eq!(removed.kind, "symlink");
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(
            std::fs::read_to_string(&sentinel).expect("target directory remains"),
            "target remains"
        );
    }
}

#[test]
fn nofollow_entry_tools_do_not_strip_a_regular_file_suffix() {
    for (index, ctx_factory) in [(0, false), (1, true)] {
        let workspace = tempfile::tempdir().expect("workspace");
        let path = workspace.path().join(format!("ordinary-{index}.txt"));
        std::fs::write(&path, "preserve me").expect("file fixture");
        let ctx = if ctx_factory {
            contained(workspace.path())
        } else {
            InvocationContext::new(PathContext::new(workspace.path()))
        };
        let locator = format!("{}{}", path.to_string_lossy(), std::path::MAIN_SEPARATOR);

        assert!(
            fs_stat(
                &ctx,
                &FsStatRequest {
                    path: locator.clone(),
                    base_dir: None,
                    follow_symlinks: false,
                },
            )
            .is_err(),
            "a trailing separator must not be erased for an ordinary file"
        );
        assert!(
            fs_remove(
                &ctx,
                &FsRemoveRequest {
                    path: locator,
                    base_dir: None,
                    recursive: true,
                    missing_ok: false,
                },
            )
            .is_err(),
            "a trailing separator must not turn an ordinary file into a deletion target"
        );
        assert_eq!(
            std::fs::read_to_string(path).expect("ordinary file remains"),
            "preserve me"
        );
    }
}

#[test]
fn delete_entry_still_rejects_a_symlink_ancestor() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let outside_file = outside.path().join("secret.txt");
    std::fs::write(&outside_file, "secret").expect("outside fixture");
    if !create_directory_symlink(outside.path(), &workspace.path().join("external")) {
        return;
    }

    let error = fs_remove(
        &contained(workspace.path()),
        &FsRemoveRequest {
            path: "external/secret.txt".to_string(),
            base_dir: None,
            recursive: false,
            missing_ok: false,
        },
    )
    .expect_err("delete-entry semantics must apply only to the final component");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
    assert_eq!(
        std::fs::read_to_string(&outside_file).expect("target remains"),
        "secret"
    );
}

#[test]
fn nofollow_stat_still_rejects_a_symlink_ancestor() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let outside_file = outside.path().join("secret.txt");
    std::fs::write(&outside_file, "secret").expect("outside fixture");
    if !create_directory_symlink(outside.path(), &workspace.path().join("external")) {
        return;
    }

    let error = fs_stat(
        &contained(workspace.path()),
        &FsStatRequest {
            path: "external/secret.txt".to_string(),
            base_dir: None,
            follow_symlinks: false,
        },
    )
    .expect_err("nofollow must apply only to the final path component");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
}

#[test]
fn contained_list_applies_local_ignores_in_a_non_git_workspace() {
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::write(
        workspace.path().join(".gitignore"),
        "root-ignored.txt\nnested/ignored-by-root.txt\n",
    )
    .expect("root gitignore fixture");
    std::fs::write(workspace.path().join("root-ignored.txt"), "ignored")
        .expect("root ignored fixture");
    std::fs::write(workspace.path().join("root-visible.txt"), "visible")
        .expect("root visible fixture");
    let nested = workspace.path().join("nested");
    std::fs::create_dir(&nested).expect("nested directory");
    std::fs::write(nested.join(".ignore"), "local-ignored.txt\n").expect("nested ignore fixture");
    std::fs::write(nested.join(".gitignore"), "*.tmp\n!important.tmp\n")
        .expect("nested gitignore fixture");
    let nested_child = nested.join("child");
    std::fs::create_dir(&nested_child).expect("nested child directory");
    std::fs::write(nested_child.join(".gitignore"), "!discard.tmp\n")
        .expect("child gitignore fixture");
    std::fs::write(nested_child.join(".ignore"), "discard.tmp\n").expect("child ignore fixture");
    std::fs::write(nested_child.join("discard.tmp"), "ignored").expect("child precedence fixture");
    std::fs::write(nested.join("ignored-by-root.txt"), "ignored")
        .expect("nested root-ignore fixture");
    std::fs::write(nested.join("local-ignored.txt"), "ignored")
        .expect("nested local-ignore fixture");
    std::fs::write(nested.join("discard.tmp"), "ignored").expect("nested glob fixture");
    std::fs::write(nested.join("important.tmp"), "visible").expect("nested whitelist fixture");
    std::fs::write(nested.join("visible.txt"), "visible").expect("nested visible fixture");

    let result = fs_list(
        &contained(workspace.path()),
        &FsListRequest {
            path: ".".to_string(),
            base_dir: None,
            recursive: true,
            max_depth: None,
            limit: None,
            cursor: None,
            include_hidden: true,
            respect_gitignore: true,
            follow_symlinks: true,
            max_output_bytes: None,
        },
    )
    .expect("list non-Git workspace");
    assert!(
        !workspace.path().join(".git").exists(),
        "fixture must exercise ignore matching outside a Git repository"
    );
    let canonical_workspace = std::fs::canonicalize(workspace.path()).expect("canonical workspace");
    let listed = result
        .entries
        .iter()
        .map(|entry| {
            std::path::Path::new(&entry.path)
                .strip_prefix(&canonical_workspace)
                .expect("entry below workspace")
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/")
        })
        .collect::<Vec<_>>();

    assert!(listed.iter().any(|path| path == "root-visible.txt"));
    assert!(listed.iter().any(|path| path == "nested/visible.txt"));
    assert!(listed.iter().any(|path| path == "nested/important.tmp"));
    assert!(!listed.iter().any(|path| path == "root-ignored.txt"));
    assert!(
        !listed
            .iter()
            .any(|path| path == "nested/ignored-by-root.txt")
    );
    assert!(!listed.iter().any(|path| path == "nested/local-ignored.txt"));
    assert!(!listed.iter().any(|path| path == "nested/discard.tmp"));
    assert!(!listed.iter().any(|path| path == "nested/child/discard.tmp"));
}

#[test]
fn contained_list_does_not_inherit_ignore_sources_above_its_root() {
    let workspace = tempfile::tempdir().expect("workspace");
    let list_root = workspace.path().join("listed");
    std::fs::create_dir(&list_root).expect("list root");
    std::fs::write(workspace.path().join(".gitignore"), "listed/ancestor.txt\n")
        .expect("ancestor gitignore fixture");
    std::fs::create_dir_all(list_root.join(".git/info")).expect("git info fixture");
    std::fs::write(list_root.join(".git/info/exclude"), "info-excluded.txt\n")
        .expect("git info exclude fixture");
    std::fs::write(list_root.join("ancestor.txt"), "visible").expect("ancestor-rule target");
    std::fs::write(list_root.join("info-excluded.txt"), "visible").expect("info-exclude target");

    let result = fs_list(
        &contained(workspace.path()),
        &FsListRequest {
            path: "listed".to_string(),
            base_dir: None,
            recursive: true,
            max_depth: None,
            limit: None,
            cursor: None,
            include_hidden: false,
            respect_gitignore: true,
            follow_symlinks: false,
            max_output_bytes: None,
        },
    )
    .expect("contained list with capability-local ignores");

    assert!(
        result
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("ancestor.txt")),
        "rules above the requested list root must not apply: {result:?}"
    );
    assert!(
        result
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("info-excluded.txt")),
        ".git/info/exclude must not apply in contained mode: {result:?}"
    );
}

#[test]
fn unrestricted_list_applies_gitignore_in_a_non_git_workspace() {
    let workspace = tempfile::tempdir().expect("workspace");
    std::fs::write(workspace.path().join(".gitignore"), "ignored.txt\n")
        .expect("gitignore fixture");
    std::fs::write(workspace.path().join("ignored.txt"), "ignored").expect("ignored fixture");
    std::fs::write(workspace.path().join("visible.txt"), "visible").expect("visible fixture");

    let result = fs_list(
        &InvocationContext::new(PathContext::new(workspace.path())),
        &FsListRequest {
            path: ".".to_string(),
            base_dir: None,
            recursive: true,
            max_depth: None,
            limit: None,
            cursor: None,
            include_hidden: true,
            respect_gitignore: true,
            follow_symlinks: false,
            max_output_bytes: None,
        },
    )
    .expect("unrestricted list non-Git workspace");

    assert!(
        result
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("visible.txt"))
    );
    assert!(
        result
            .entries
            .iter()
            .all(|entry| !entry.path.ends_with("ignored.txt"))
    );
}

#[test]
#[cfg(feature = "test-fixtures")]
fn contained_list_with_ignores_prunes_an_external_symlink_before_following() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(workspace.path().join(".gitignore"), "*.ignored\n").expect("gitignore fixture");
    let sentinel_dir = outside.path().join("sentinel");
    std::fs::create_dir(&sentinel_dir).expect("sentinel dir");
    std::fs::write(sentinel_dir.join("secret.txt"), "secret").expect("outside fixture");
    let external_link = workspace.path().join("external");
    if !create_directory_symlink(&sentinel_dir, &external_link) {
        return;
    }

    xuanling_toolkit::fs::stat_list::reset_contained_directory_open_log();
    let result = fs_list(
        &contained(workspace.path()),
        &FsListRequest {
            path: ".".to_string(),
            base_dir: None,
            recursive: true,
            max_depth: None,
            limit: None,
            cursor: None,
            include_hidden: true,
            respect_gitignore: true,
            follow_symlinks: true,
            max_output_bytes: None,
        },
    )
    .expect("list workspace");
    let opened = xuanling_toolkit::fs::stat_list::take_contained_directory_open_log();

    assert!(
        result
            .entries
            .iter()
            .all(|entry| !entry.path.contains("external") && !entry.path.contains("secret.txt")),
        "contained traversal must prune the external link before metadata or descent: {result:?}"
    );
    assert!(
        opened.iter().all(|directory| directory != &external_link),
        "contained traversal attempted to open the external symlink directory: {opened:?}"
    );
}

#[test]
fn contained_list_does_not_read_an_external_symlinked_ignore_file() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let external_ignore = outside.path().join("rules");
    std::fs::write(&external_ignore, "visible.txt\n").expect("external ignore fixture");
    std::fs::write(workspace.path().join("visible.txt"), "visible").expect("visible fixture");
    if !create_file_symlink(&external_ignore, &workspace.path().join(".gitignore")) {
        return;
    }

    let result = fs_list(
        &contained(workspace.path()),
        &FsListRequest {
            path: ".".to_string(),
            base_dir: None,
            recursive: true,
            max_depth: None,
            limit: None,
            cursor: None,
            include_hidden: true,
            respect_gitignore: true,
            follow_symlinks: false,
            max_output_bytes: None,
        },
    )
    .expect("list workspace");

    assert!(
        result
            .entries
            .iter()
            .any(|entry| entry.path.ends_with("visible.txt")),
        "rules outside the capability must not affect the result: {result:?}"
    );
}

#[test]
fn contained_search_does_not_read_an_external_symlinked_ignore_file() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let external_ignore = outside.path().join("rules");
    std::fs::write(&external_ignore, "visible.txt\n").expect("external ignore fixture");
    std::fs::write(workspace.path().join("visible.txt"), "search target\n")
        .expect("visible fixture");
    if !create_file_symlink(&external_ignore, &workspace.path().join(".gitignore")) {
        return;
    }

    let result = search_with_options(
        &contained(workspace.path()),
        &FsSearchRequest {
            path: ".".to_string(),
            pattern: "search target".to_string(),
            literal: true,
            case_sensitive: true,
            limit: None,
            cursor: None,
            max_output_bytes: None,
        },
        &FsSearchOptions {
            include_hidden: true,
            respect_gitignore: true,
            include_globs: Vec::new(),
            exclude_globs: Vec::new(),
            file_extensions: Vec::new(),
            group_by_line: false,
        },
    )
    .expect("search workspace");

    assert_eq!(
        result.matches.len(),
        1,
        "rules outside the capability must not affect search: {result:?}"
    );
    assert!(result.matches[0].path.ends_with("visible.txt"));
}

#[test]
fn contained_list_follows_each_internal_alias_but_stops_alias_cycles() {
    let workspace = tempfile::tempdir().expect("workspace");
    let shared = workspace.path().join("shared");
    std::fs::create_dir(&shared).expect("shared directory");
    std::fs::write(shared.join("visible.txt"), "visible").expect("shared fixture");
    if !create_directory_symlink(&shared, &workspace.path().join("alias-a"))
        || !create_directory_symlink(&shared, &workspace.path().join("alias-b"))
    {
        return;
    }
    if !create_directory_symlink(workspace.path(), &shared.join("cycle")) {
        return;
    }

    let result = fs_list(
        &contained(workspace.path()),
        &FsListRequest {
            path: ".".to_string(),
            base_dir: None,
            recursive: true,
            max_depth: None,
            limit: None,
            cursor: None,
            include_hidden: true,
            respect_gitignore: true,
            follow_symlinks: true,
            max_output_bytes: None,
        },
    )
    .expect("list internal aliases");

    let canonical_workspace = std::fs::canonicalize(workspace.path()).expect("canonical workspace");
    let listed = result
        .entries
        .iter()
        .map(|entry| {
            std::path::Path::new(&entry.path)
                .strip_prefix(&canonical_workspace)
                .expect("entry below workspace")
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/")
        })
        .collect::<Vec<_>>();
    assert!(listed.iter().any(|path| path == "alias-a/visible.txt"));
    assert!(listed.iter().any(|path| path == "alias-b/visible.txt"));
    assert_eq!(
        listed.len(),
        9,
        "ancestor identity tracking must terminate each alias loop after listing its leaf: {listed:?}"
    );
}

#[tokio::test]
async fn process_cwd_and_capture_paths_respect_workspace_scope() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let ctx = contained(workspace.path());

    let cwd_error = process_run(
        &ctx,
        &ProcessRunRequest {
            deterministic: false,
            program: "echo".to_string(),
            args: vec!["x".to_string()],
            cwd: Some(outside.path().to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            remove_env: Vec::new(),
            inherit_env: false,
            stdin: None,
            stdout: ProcessStreamMode::Null,
            stderr: ProcessStreamMode::Null,
            preview_max_bytes: None,
        },
    )
    .await
    .expect_err("outside cwd must be rejected before spawn");
    assert_eq!(cwd_error.code, ToolErrorCode::OutsideCapability);

    let capture_error = process_run(
        &ctx,
        &ProcessRunRequest {
            deterministic: false,
            program: "echo".to_string(),
            args: vec!["x".to_string()],
            cwd: None,
            env: BTreeMap::new(),
            remove_env: Vec::new(),
            inherit_env: false,
            stdin: None,
            stdout: ProcessStreamMode::File {
                path: outside
                    .path()
                    .join("stdout.txt")
                    .to_string_lossy()
                    .into_owned(),
            },
            stderr: ProcessStreamMode::Null,
            preview_max_bytes: None,
        },
    )
    .await
    .expect_err("outside capture must be rejected before spawn");
    assert_eq!(capture_error.code, ToolErrorCode::OutsideCapability);

    let session_error = session_open(
        &ctx,
        &SessionOpenRequest {
            cwd: Some(outside.path().to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            inherit_env: false,
        },
    )
    .expect_err("outside session cwd must be rejected");
    assert_eq!(session_error.code, ToolErrorCode::OutsideCapability);
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn contained_processes_default_to_the_invocation_base_dir() {
    let workspace = tempfile::tempdir().expect("workspace");
    let nested = workspace.path().join("nested");
    std::fs::create_dir(&nested).expect("nested workspace dir");
    let ctx = InvocationContext::new(PathContext::new(&nested)).with_filesystem_scope(
        FilesystemScope::workspace(workspace.path()).expect("workspace scope"),
    );
    let helper = process_tree_helper();

    let run = process_run(
        &ctx,
        &ProcessRunRequest {
            deterministic: false,
            program: helper.clone(),
            args: vec!["print-cwd".to_string()],
            cwd: None,
            env: BTreeMap::new(),
            remove_env: Vec::new(),
            inherit_env: false,
            stdin: None,
            stdout: ProcessStreamMode::Inline,
            stderr: ProcessStreamMode::Null,
            preview_max_bytes: None,
        },
    )
    .await
    .expect("contained process run");
    assert_cwd_is(run.stdout.as_deref().expect("run stdout"), &nested);

    let pipeline = process_pipeline(
        &ctx,
        &ProcessPipelineRequest {
            deterministic: false,
            stages: vec![PipelineStage {
                program: helper.clone(),
                args: vec!["print-cwd".to_string()],
                env: BTreeMap::new(),
                remove_env: Vec::new(),
                inherit_env: false,
                cwd: None,
            }],
            stdin: None,
            stdout: ProcessStreamMode::Inline,
            preview_max_bytes: None,
        },
    )
    .await
    .expect("contained pipeline");
    assert_cwd_is(
        pipeline.stdout.as_deref().expect("pipeline stdout"),
        &nested,
    );

    let session = session_open(
        &ctx,
        &SessionOpenRequest {
            cwd: None,
            env: BTreeMap::new(),
            inherit_env: false,
        },
    )
    .expect("contained session");
    let session_result = session_exec(
        &ctx,
        &SessionExecRequest {
            deterministic: false,
            session_id: session.session_id.clone(),
            program: helper,
            args: vec!["print-cwd".to_string()],
            stdin: None,
            stdout: ProcessStreamMode::Inline,
            stderr: ProcessStreamMode::Null,
            env: BTreeMap::new(),
            preview_max_bytes: None,
        },
    )
    .await
    .expect("contained session exec");
    assert_cwd_is(
        session_result.stdout.as_deref().expect("session stdout"),
        &nested,
    );
    session_close(
        &ctx,
        &SessionCloseRequest {
            session_id: session.session_id,
        },
    )
    .expect("close contained session");
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn unrestricted_process_with_omitted_cwd_inherits_the_server_cwd() {
    let locator_base = tempfile::tempdir().expect("locator base");
    let server_cwd = std::env::current_dir().expect("server cwd");
    assert_ne!(
        std::fs::canonicalize(locator_base.path()).expect("canonical locator base"),
        std::fs::canonicalize(&server_cwd).expect("canonical server cwd")
    );
    let ctx = InvocationContext::new(PathContext::new(locator_base.path()));

    let result = process_run(
        &ctx,
        &ProcessRunRequest {
            deterministic: false,
            program: process_tree_helper(),
            args: vec!["print-cwd".to_string()],
            cwd: None,
            env: BTreeMap::new(),
            remove_env: Vec::new(),
            inherit_env: false,
            stdin: None,
            stdout: ProcessStreamMode::Inline,
            stderr: ProcessStreamMode::Null,
            preview_max_bytes: None,
        },
    )
    .await
    .expect("unrestricted process run");
    assert_cwd_is(
        result.stdout.as_deref().expect("process stdout"),
        &server_cwd,
    );
}

#[tokio::test]
async fn contained_invocation_cannot_execute_session_opened_with_outside_cwd() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let unrestricted = InvocationContext::new(PathContext::new(workspace.path()));
    let opened = session_open(
        &unrestricted,
        &SessionOpenRequest {
            cwd: Some(outside.path().to_string_lossy().into_owned()),
            env: BTreeMap::new(),
            inherit_env: false,
        },
    )
    .expect("unrestricted context may open outside cwd");

    let error = session_exec(
        &contained(workspace.path()),
        &SessionExecRequest {
            deterministic: false,
            session_id: opened.session_id.clone(),
            program: "program-must-not-be-spawned".to_string(),
            args: Vec::new(),
            stdin: None,
            stdout: ProcessStreamMode::Null,
            stderr: ProcessStreamMode::Null,
            env: BTreeMap::new(),
            preview_max_bytes: None,
        },
    )
    .await
    .expect_err("contained invocation must revalidate the stored cwd before spawn");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
    assert_eq!(error.operation, "process.session.exec");

    session_close(
        &unrestricted,
        &SessionCloseRequest {
            session_id: opened.session_id,
        },
    )
    .expect("cleanup outside session");
}

#[test]
fn contained_invocation_cannot_finish_changeset_registered_outside_scope() {
    let workspace = tempfile::tempdir().expect("workspace");
    let outside = tempfile::tempdir().expect("outside");
    let rollback_target = outside.path().join("rollback.txt");
    std::fs::write(&rollback_target, "before").expect("rollback fixture");
    let unrestricted = InvocationContext::new(PathContext::new(workspace.path()));

    let rollback_change = fs_edit(
        &unrestricted,
        &FsEditRequest {
            path: rollback_target.to_string_lossy().into_owned(),
            old: "before".to_string(),
            new: "after".to_string(),
            replace_all: false,
            base_dir: None,
            expected_sha256: None,
            dry_run: false,
            reversible: true,
        },
    )
    .expect("unrestricted reversible edit");
    let rollback_id = rollback_change.change_id.expect("rollback change id");

    let rollback_error =
        changeset_rollback_with_context(&contained(workspace.path()), &rollback_id)
            .expect_err("contained invocation must not roll back an outside target");
    assert_eq!(rollback_error.code, ToolErrorCode::OutsideCapability);
    assert_eq!(rollback_error.operation, "fs.changeset.rollback");
    assert_eq!(
        std::fs::read_to_string(&rollback_target).expect("read rollback target"),
        "after",
        "rejected rollback must not mutate the outside target"
    );
    assert_eq!(
        changeset_rollback(&rollback_id).expect("authorized cleanup rollback"),
        ChangeSetState::RolledBack,
        "rejected rollback must leave the ChangeSet retryable"
    );

    let commit_target = outside.path().join("commit.txt");
    std::fs::write(&commit_target, "before").expect("commit fixture");
    let commit_change = fs_edit(
        &unrestricted,
        &FsEditRequest {
            path: commit_target.to_string_lossy().into_owned(),
            old: "before".to_string(),
            new: "after".to_string(),
            replace_all: false,
            base_dir: None,
            expected_sha256: None,
            dry_run: false,
            reversible: true,
        },
    )
    .expect("unrestricted reversible edit");
    let commit_id = commit_change.change_id.expect("commit change id");

    let commit_error = changeset_commit_with_context(&contained(workspace.path()), &commit_id)
        .expect_err("contained invocation must not commit an outside target");
    assert_eq!(commit_error.code, ToolErrorCode::OutsideCapability);
    assert_eq!(commit_error.operation, "fs.changeset.commit");
    assert_eq!(
        changeset_rollback(&commit_id).expect("authorized cleanup rollback"),
        ChangeSetState::RolledBack,
        "rejected commit must leave the ChangeSet pending"
    );
}

// --- ADR 0029: multi-root workspace + read-only external roots ---

/// Multiple `--workspace-root` values form a union write-visible capability:
/// reads and writes succeed in every configured root, and any path outside the
/// union is rejected exactly like the single-root case.
#[test]
fn multi_root_scope_reads_and_writes_every_root_and_rejects_outside() {
    let root_a = tempfile::tempdir().expect("root A");
    let root_b = tempfile::tempdir().expect("root B");
    let outside = tempfile::tempdir().expect("outside");
    std::fs::write(root_a.path().join("a.txt"), "a").expect("a fixture");
    std::fs::write(root_b.path().join("b.txt"), "b").expect("b fixture");
    let outside_file = outside.path().join("out.txt");
    std::fs::write(&outside_file, "out").expect("outside fixture");
    let ctx = InvocationContext::new(PathContext::new(root_a.path())).with_filesystem_scope(
        FilesystemScope::workspace_roots([root_a.path(), root_b.path()])
            .expect("multi-root workspace scope"),
    );

    let a = read_text(
        &ctx,
        &FsReadTextRequest {
            path: "a.txt".to_string(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect("read in root A");
    assert_eq!(a.content, "a");
    let b = read_text(
        &ctx,
        &FsReadTextRequest {
            path: root_b.path().join("b.txt").to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect("read in root B");
    assert_eq!(b.content, "b");

    fs_write_text(
        &ctx,
        &FsWriteTextRequest {
            path: "created-a.txt".to_string(),
            base_dir: None,
            content: "created".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect("write in root A");
    fs_write_text(
        &ctx,
        &FsWriteTextRequest {
            path: root_b
                .path()
                .join("created-b.txt")
                .to_string_lossy()
                .into_owned(),
            base_dir: None,
            content: "created".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect("write in root B");

    let error = read_text(
        &ctx,
        &FsReadTextRequest {
            path: outside_file.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect_err("outside path must be rejected");
    assert_eq!(error.code, ToolErrorCode::OutsideCapability);
}

/// A read-only root admits read-class access and rejects every write-class
/// access, while write roots keep their established behavior.
#[test]
fn read_only_root_allows_reads_and_rejects_writes_and_removal() {
    let workspace = tempfile::tempdir().expect("workspace");
    let upstream = tempfile::tempdir().expect("read-only root");
    let frozen = upstream.path().join("frozen.txt");
    std::fs::write(&frozen, "frozen").expect("upstream fixture");
    let ctx = InvocationContext::new(PathContext::new(workspace.path())).with_filesystem_scope(
        FilesystemScope::workspace_with_read_roots([workspace.path()], [upstream.path()])
            .expect("write + read root scope"),
    );

    let read = read_text(
        &ctx,
        &FsReadTextRequest {
            path: frozen.to_string_lossy().into_owned(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect("read-only root is readable");
    assert_eq!(read.content, "frozen");

    let write_error = fs_write_text(
        &ctx,
        &FsWriteTextRequest {
            path: upstream
                .path()
                .join("forged.txt")
                .to_string_lossy()
                .into_owned(),
            base_dir: None,
            content: "forged".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect_err("write into read-only root must be rejected");
    assert_eq!(write_error.code, ToolErrorCode::OutsideCapability);

    let remove_error = fs_remove(
        &ctx,
        &FsRemoveRequest {
            path: frozen.to_string_lossy().into_owned(),
            base_dir: None,
            recursive: false,
            missing_ok: false,
        },
    )
    .expect_err("removal from read-only root must be rejected");
    assert_eq!(remove_error.code, ToolErrorCode::OutsideCapability);

    fs_write_text(
        &ctx,
        &FsWriteTextRequest {
            path: "inside.txt".to_string(),
            base_dir: None,
            content: "writable".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect("write root stays writable");
}

/// A scope with only read roots is a read-only deployment: reads work, writes
/// and removal are rejected, and a server-directed child cwd (`ProcessCwd`)
/// has no write root to satisfy it.
#[tokio::test]
async fn read_only_scope_without_write_roots_rejects_writes_and_process_cwd() {
    let upstream = tempfile::tempdir().expect("read-only root");
    let frozen = upstream.path().join("frozen.txt");
    std::fs::write(&frozen, "frozen").expect("upstream fixture");
    let ctx = InvocationContext::new(PathContext::new(upstream.path())).with_filesystem_scope(
        FilesystemScope::workspace_with_read_roots(
            std::iter::empty::<&std::path::Path>(),
            [upstream.path()],
        )
        .expect("read-only scope"),
    );

    let read = read_text(
        &ctx,
        &FsReadTextRequest {
            path: "frozen.txt".to_string(),
            base_dir: None,
            start_line: None,
            end_line: None,
            include_sha256: false,
            max_bytes: None,
            resume: None,
        },
    )
    .expect("read within the read-only root");
    assert_eq!(read.content, "frozen");

    let write_error = fs_write_text(
        &ctx,
        &FsWriteTextRequest {
            path: "forged.txt".to_string(),
            base_dir: None,
            content: "forged".to_string(),
            mode: WriteMode::Overwrite,
            create_parents: false,
            expected_sha256: None,
            newline_mode: Default::default(),
        },
    )
    .expect_err("read-only deployment must reject writes");
    assert_eq!(write_error.code, ToolErrorCode::OutsideCapability);

    let run_error = process_run(
        &ctx,
        &ProcessRunRequest {
            program: "definitely-not-a-real-program".to_string(),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
            remove_env: Vec::new(),
            inherit_env: false,
            deterministic: false,
            stdin: None,
            stdout: ProcessStreamMode::Null,
            stderr: ProcessStreamMode::Null,
            preview_max_bytes: None,
        },
    )
    .await
    .expect_err("read-only deployment must reject the implied process cwd");
    assert_eq!(run_error.code, ToolErrorCode::OutsideCapability);
}
