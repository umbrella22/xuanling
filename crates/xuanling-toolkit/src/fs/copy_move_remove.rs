//! `fs_copy`, `fs_move`, `fs_remove` (plan §7.2).
//!
//! File/dir copy/move/remove using Rust std APIs — no `cp`/`mv`/`rm`.
//! Cross-filesystem move fallback is explicit in the result. Directory removal
//! requires an explicit `recursive=true`.

use std::path::{Path, PathBuf};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{map_io_error, resolve_path};
use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;

// ---------------------------------------------------------------------------
// fs_copy
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsCopyRequest {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default = "default_true")]
    pub recursive: bool,
}

fn default_true() -> bool {
    true
}

/// Detect whether `from` and `to` overlap: same object, OR one lives inside
/// the other's subtree. Either direction is dangerous — a source inside the
/// destination means an `overwrite=true` delete of the destination also deletes
/// the source; a destination inside the source makes a recursive copy diverge.
/// Symlinks are resolved by canonicalize.
///
/// Both directions are checked (review P0 round 2: the first pass only checked
/// destination-inside-source and missed source-inside-destination, so copying
/// `/a/b` onto `/a` with overwrite deleted both).
///
/// `to` need not exist yet: when it does not, we canonicalize its longest
/// existing ancestor and re-append the remaining components.
fn same_or_nested(from: &Path, to: &Path, op: &str) -> Result<bool, ToolError> {
    let cf = std::fs::canonicalize(from).map_err(|e| map_io_error(&e, op, from))?;
    let ct = match std::fs::canonicalize(to) {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => resolve_nonexistent(to),
        Err(e) => return Err(map_io_error(&e, op, to)),
    };
    Ok(cf == ct || ct.starts_with(&cf) || cf.starts_with(&ct))
}

/// Resolve a non-existent `path` to the canonical path it WOULD have by
/// canonicalizing its longest existing ancestor and re-appending the missing
/// components. Returns an absolute path when any ancestor exists; an empty
/// path (never inside anything) when none exists up to the filesystem root.
fn resolve_nonexistent(path: &Path) -> PathBuf {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    if let Some(name) = path.file_name() {
        tail.push(name.to_os_string());
    }
    let mut cursor = path.parent();
    let base = loop {
        match cursor {
            Some(p) => match std::fs::canonicalize(p) {
                Ok(c) => break c,
                Err(_) => {
                    if let Some(name) = p.file_name() {
                        tail.push(name.to_os_string());
                    }
                    cursor = p.parent();
                }
            },
            None => break PathBuf::new(),
        }
    };
    // tail was collected leaf-first; reverse to re-append root-first.
    let mut ct = base;
    for name in tail.into_iter().rev() {
        ct = ct.join(name);
    }
    ct
}

/// Cross-device rename detection that works on both POSIX (EXDEV = 18) and
/// Windows (ERROR_NOT_SAME_DEVICE = 17). Hardcoding only `Some(18)` misses the
/// Windows cross-volume case (review P1).
fn is_cross_device_error(e: &std::io::Error) -> bool {
    if cfg!(target_os = "windows") {
        e.raw_os_error() == Some(17) // ERROR_NOT_SAME_DEVICE
    } else {
        e.raw_os_error() == Some(18) // EXDEV
    }
}

static STAGE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Classify a copy failure to the right operand (plan W7.2, C-11).
///
/// The direct branch verifies the source's existence up front, so a
/// `NotFound` from `std::fs::copy` there is the destination (typically a
/// missing parent) — previously it was mis-attributed to the source. Branches
/// that stage into a directory the caller just proved exists (or that create
/// the destination parent first) can only see `NotFound` from a vanished
/// source. Every other kind (permission, ENOSPC, EISDIR) cannot be attributed
/// to one side without an extra probe, so it stays `ambiguous` carrying both
/// operands. `details.path_role` is the stable discriminator clients branch
/// on; the top-level `path` always names the most likely operand.
fn copy_io_error(
    e: &std::io::Error,
    operation: &str,
    from: &Path,
    to: &Path,
    not_found_is_destination: bool,
) -> ToolError {
    if e.kind() == std::io::ErrorKind::NotFound {
        let (role, path) = if not_found_is_destination {
            ("destination", to)
        } else {
            ("source", from)
        };
        return map_io_error(e, operation, path)
            .with_details(serde_json::json!({"path_role": role}));
    }
    map_io_error(e, operation, to).with_details(serde_json::json!({
        "path_role": "ambiguous",
        "source": from.to_string_lossy(),
        "destination": to.to_string_lossy(),
    }))
}

/// Stage a file copy so the destination is never left deleted or half-written
/// when the copy fails: copy `from` into a temp file in the SAME directory as
/// `to`, then atomically rename it over `to`. On any failure the temp is
/// removed and the original destination is preserved. `std::fs::rename`
/// atomically replaces an existing file on both POSIX and Windows (review P0
/// round 2).
fn stage_copy_over(from: &Path, to: &Path) -> Result<(), ToolError> {
    let dir = to.parent().unwrap_or(Path::new("."));
    let seq = STAGE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".xuanling-stage-{}-{}", std::process::id(), seq));
    if let Err(e) = std::fs::copy(from, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(copy_io_error(&e, "fs.copy", from, &tmp, false));
    }
    if let Err(e) = std::fs::rename(&tmp, to) {
        let _ = std::fs::remove_file(&tmp);
        return Err(map_io_error(&e, "fs.copy", to));
    }
    Ok(())
}

/// Remove a path of any kind (file, symlink, or directory tree) without
/// following symlinks. Used where the destination type is not known ahead of
/// time (e.g. the symlink-overwrite path).
fn remove_symlink_nofollow(path: &Path, file_type: &std::fs::FileType) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;

        if file_type.is_symlink_dir() {
            return std::fs::remove_dir(path);
        }
    }

    let _ = file_type;
    std::fs::remove_file(path)
}

fn remove_any(path: &Path, operation: &str) -> Result<(), ToolError> {
    let meta = std::fs::symlink_metadata(path).map_err(|e| map_io_error(&e, operation, path))?;
    if meta.file_type().is_symlink() {
        remove_symlink_nofollow(path, &meta.file_type())
            .map_err(|e| map_io_error(&e, operation, path))
    } else if meta.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| map_io_error(&e, operation, path))
    } else {
        std::fs::remove_file(path).map_err(|e| map_io_error(&e, operation, path))
    }
}

/// Variant of [`stage_copy_over`] for replacing a DIRECTORY destination with a
/// file: stage the file copy into a temp, and only after it succeeds remove the
/// destination dir and rename the temp into place. A copy failure (unreadable
/// source, ENOSPC) cleans the temp and leaves the destination dir intact; only
/// the narrow "remove succeeded, rename failed" window can lose the
/// destination (unavoidable for a type-changing overwrite).
fn stage_copy_over_remove_dest(from: &Path, to: &Path) -> Result<(), ToolError> {
    let dir = to.parent().unwrap_or(Path::new("."));
    let seq = STAGE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".xuanling-stage-{}-{}", std::process::id(), seq));
    if let Err(e) = std::fs::copy(from, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(copy_io_error(&e, "fs.copy", from, &tmp, false));
    }
    // Destination is a dir (checked by caller) — remove it now that the staged
    // copy succeeded, then atomically rename the staged file into place.
    if let Err(e) = std::fs::remove_dir_all(to) {
        let _ = std::fs::remove_file(&tmp);
        return Err(map_io_error(&e, "fs.copy", to));
    }
    if let Err(e) = std::fs::rename(&tmp, to) {
        let _ = std::fs::remove_file(&tmp);
        return Err(map_io_error(&e, "fs.copy", to));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsCopyResult {
    pub copied_files: u64,
    pub copied_bytes: u64,
}

pub fn fs_copy(ctx: &InvocationContext, req: &FsCopyRequest) -> Result<FsCopyResult, ToolError> {
    let from = resolve_path(
        ctx,
        &req.from,
        req.base_dir.as_deref(),
        PathAccess::Read,
        "fs.copy",
    )?;
    let to = resolve_path(
        ctx,
        &req.to,
        req.base_dir.as_deref(),
        PathAccess::Write,
        "fs.copy",
    )?;

    if !from.exists() {
        return Err(
            ToolError::new(ToolErrorCode::NotFound, "fs.copy", "source does not exist")
                .with_path(from.to_string_lossy()),
        );
    }
    // Refuse to copy onto self or into the source subtree BEFORE any deletion.
    // `same_or_nested` handles a non-existent destination by resolving its
    // longest existing ancestor, so a fresh dest nested inside `from` is still
    // caught. Without this, `overwrite=true` with from==to deletes the (shared)
    // target and then fails, losing the source (review P0).
    if same_or_nested(&from, &to, "fs.copy")? {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.copy",
            "source and destination overlap (one is inside the other); refusing to avoid data loss",
        )
        .with_path(to.to_string_lossy()));
    }
    if to.exists() && !req.overwrite {
        return Err(ToolError::new(
            ToolErrorCode::AlreadyExists,
            "fs.copy",
            "destination exists and overwrite=false",
        )
        .with_path(to.to_string_lossy()));
    }

    let from_meta = std::fs::metadata(&from).map_err(|e| map_io_error(&e, "fs.copy", &from))?;

    let (copied_files, copied_bytes) = if from_meta.is_dir() {
        if !req.recursive {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.copy",
                "source is a directory but recursive=false",
            )
            .with_path(from.to_string_lossy()));
        }
        copy_dir_recursive(ctx, &from, &to, req.overwrite)?
    } else {
        let bytes = from_meta.len();
        if to.exists() && req.overwrite && to.is_file() {
            // Stage the replacement: copy into a temp file in the SAME
            // directory, then atomically rename over the destination. A copy
            // failure removes the temp and leaves the old destination intact
            // (review P0 round 2: previously the destination was deleted
            // before the copy, so any failure lost it).
            stage_copy_over(&from, &to)?;
        } else {
            if to.exists() && req.overwrite && to.is_dir() {
                // File over a dir: a file cannot be staged over a directory
                // (rename(temp_file, dir) fails on type mismatch). Stage the
                // copy into a temp first, and only remove the destination dir
                // once the staged copy succeeded — so a copy/ENOSPC failure
                // leaves the destination intact instead of deleting it before
                // the copy (review round-3 F2: this branch still used
                // delete-then-copy).
                stage_copy_over_remove_dest(&from, &to)?;
            } else {
                std::fs::copy(&from, &to)
                    .map_err(|e| copy_io_error(&e, "fs.copy", &from, &to, true))?;
            }
        }
        (1, bytes)
    };

    Ok(FsCopyResult {
        copied_files,
        copied_bytes,
    })
}

fn copy_dir_recursive(
    ctx: &InvocationContext,
    from: &Path,
    to: &Path,
    overwrite: bool,
) -> Result<(u64, u64), ToolError> {
    let mut files = 0u64;
    let mut bytes = 0u64;
    std::fs::create_dir_all(to).map_err(|e| map_io_error(&e, "fs.copy", to))?;
    for result in walkdir::WalkDir::new(from).into_iter() {
        if ctx.cancellation().is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "fs.copy",
                "operation cancelled",
            ));
        }
        // Propagate traversal errors instead of `continue`-ing. Silently
        // skipping an unreadable entry would make the copy incomplete; for a
        // cross-device move that incomplete copy is then followed by source
        // deletion, losing data (review P1).
        let dent = match result {
            Ok(d) => d,
            Err(e) => {
                return Err(ToolError::new(
                    ToolErrorCode::IoError,
                    "fs.copy",
                    format!("directory traversal failed: {e}"),
                )
                .with_path(from.to_string_lossy())
                .with_raw_os_error(e.io_error().and_then(|io| io.raw_os_error())));
            }
        };
        let rel = dent.path().strip_prefix(from).unwrap_or(dent.path());
        let dest = to.join(rel);
        let ft = dent.file_type();
        if ft.is_dir() {
            std::fs::create_dir_all(&dest).map_err(|e| map_io_error(&e, "fs.copy", &dest))?;
        } else if ft.is_file() {
            if dest.exists() && !overwrite {
                return Err(ToolError::new(
                    ToolErrorCode::AlreadyExists,
                    "fs.copy",
                    "destination exists and overwrite=false",
                )
                .with_path(dest.to_string_lossy()));
            }
            let copied = std::fs::copy(dent.path(), &dest)
                .map_err(|e| copy_io_error(&e, "fs.copy", dent.path(), &dest, false))?;
            files += 1;
            bytes += copied;
        } else if ft.is_symlink() {
            // Honor overwrite for symlinks too (review round-3 F4: previously
            // this branch created unconditionally, surfacing EEXIST as an
            // untyped IO error and ignoring overwrite). With overwrite=false an
            // existing dest is `already_exists`; with overwrite=true the old
            // entry is removed first so the link can be (re)created.
            if dest.exists() || std::fs::symlink_metadata(&dest).is_ok() {
                if !overwrite {
                    return Err(ToolError::new(
                        ToolErrorCode::AlreadyExists,
                        "fs.copy",
                        "destination exists and overwrite=false",
                    )
                    .with_path(dest.to_string_lossy()));
                }
                remove_any(&dest, "fs.copy")?;
            }
            copy_symlink(dent.path(), &dest)?;
            files += 1;
        } else {
            // FIFO / socket / device / other special files cannot be copied
            // faithfully. Silently skipping them would make a cross-device move
            // delete the (still-present-in-source) entry, losing it; error
            // before any source deletion instead (review P1 round 2).
            return Err(ToolError::new(
                ToolErrorCode::Unsupported,
                "fs.copy",
                format!(
                    "cannot copy special file (FIFO/socket/device): {}",
                    dent.path().display()
                ),
            )
            .with_path(dent.path().to_string_lossy()));
        }
    }
    Ok((files, bytes))
}

/// Copy a symlink by re-reading its target and creating a new symlink at the
/// destination. On platforms without symlink creation in std, return a typed
/// `unsupported` rather than silently skipping.
fn copy_symlink(src: &Path, dest: &Path) -> Result<(), ToolError> {
    let target = std::fs::read_link(src).map_err(|e| map_io_error(&e, "fs.copy", src))?;
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&target, dest).map_err(|e| map_io_error(&e, "fs.copy", dest))?;
        Ok(())
    }
    #[cfg(windows)]
    {
        let res = if target.is_dir() {
            std::os::windows::fs::symlink_dir(&target, dest)
        } else {
            std::os::windows::fs::symlink_file(&target, dest)
        };
        res.map_err(|e| map_io_error(&e, "fs.copy", dest))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = target;
        Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "fs.copy",
            "symlink replication is not supported on this platform",
        )
        .with_path(src.to_string_lossy()))
    }
}

// ---------------------------------------------------------------------------
// fs_move
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsMoveRequest {
    pub from: String,
    pub to: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default)]
    pub overwrite: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsMoveResult {
    pub moved: bool,
    /// True when the cross-filesystem rename failed and we fell back to
    /// copy+delete. Explicit per plan §7.2.
    pub fallback_copy_delete: bool,
    /// Non-fatal diagnostic carried alongside a *successful* move — e.g. the
    /// replaced destination's backup could not be cleaned up, or the source
    /// could not be removed after a cross-device copy. `None` on a clean move.
    /// Surfaced rather than returning unconditional success (plan §4.2: backup
    /// 清理失败必须在结果中报告).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Fresh per-call entropy for staging/backup names, drawn from std only (no new
/// dependency): monotonic time, the process id, a global counter, and a
/// call-site stack address. The goal is unpredictability plus practical
/// uniqueness so a staging/backup name never collides with an unrelated
/// sibling (plan §4.2: staging/backup 文件名使用不可预测、创建即独占的方式).
fn fresh_entropy() -> u128 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let seq = STAGE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as u128;
    let site = (&nanos as *const u128) as u128;
    nanos ^ pid.rotate_left(7) ^ seq.rotate_left(17) ^ site.rotate_left(29)
}

/// Build a sibling path for `base` whose name is unpredictable and (practically
/// guaranteed) non-existent, so renaming a destination aside into it never
/// clobbers an unrelated entry (plan §4.2). Used to back a destination up before
/// installing a new one.
fn unique_backup_path(base: &Path) -> PathBuf {
    let dir = base.parent().unwrap_or_else(|| Path::new("."));
    let pid = std::process::id();
    loop {
        let token = fresh_entropy();
        let candidate = dir.join(format!(".xuanling-backup-{pid}-{token:032x}"));
        if !candidate.exists() {
            return candidate;
        }
        // Astronomically unlikely collision: regenerate with fresh entropy.
    }
}

/// Cross-filesystem move install: copy `from` into the destination slot `to`
/// (assumed already cleared / backed up by the caller), then remove `from`.
///
/// On copy failure `from` is preserved and an error is returned — the source is
/// never deleted after an incomplete copy (plan §4.2: EXDEV copy-delete fallback
/// 在 copy 不完整、特殊文件、删除源失败时保留源和可诊断的目标状态). On
/// source-removal failure after a successful copy the data is present at BOTH
/// `from` and `to`; the move is reported as succeeded with a `warning` rather
/// than failing.
///
/// Exposed (`#[doc(hidden)] pub`) only as a contract-test seam for the EXDEV
/// failure invariant; not part of the stable public API.
#[doc(hidden)]
pub fn fs_move_exdev_install(
    ctx: &InvocationContext,
    from: &Path,
    to: &Path,
) -> Result<FsMoveResult, ToolError> {
    let from_meta =
        std::fs::symlink_metadata(from).map_err(|e| map_io_error(&e, "fs.move", from))?;
    if let Some(parent) = to.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|e| map_io_error(&e, "fs.move", to))?;
    }
    if from_meta.is_dir() {
        copy_dir_recursive(ctx, from, to, true)?;
    } else if from_meta.is_symlink() {
        // Preserve top-level symlink identity instead of letting std::fs::copy
        // follow the link and materialize a regular file (review P1 round 2).
        copy_symlink(from, to)?;
    } else if from_meta.is_file() {
        std::fs::copy(from, to).map_err(|e| copy_io_error(&e, "fs.move", from, to, false))?;
    } else {
        // FIFO/socket/device: cannot be copied faithfully. Do not delete the
        // source (plan §4.2).
        return Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "fs.move",
            "cannot cross-device move a special file (FIFO/socket/device)",
        )
        .with_path(from.to_string_lossy()));
    }
    // Copy succeeded: remove the source. If removal fails the data lives at
    // both locations — surface a warning, not a hard failure.
    let warning = match remove_any(from, "fs.move") {
        Ok(()) => None,
        Err(e) => Some(format!(
            "cross-device move copied successfully but could not remove the source: {e}"
        )),
    };
    Ok(FsMoveResult {
        moved: true,
        fallback_copy_delete: true,
        warning,
    })
}

pub fn fs_move(ctx: &InvocationContext, req: &FsMoveRequest) -> Result<FsMoveResult, ToolError> {
    let from = resolve_path(
        ctx,
        &req.from,
        req.base_dir.as_deref(),
        PathAccess::Delete,
        "fs.move",
    )?;
    let to = resolve_path(
        ctx,
        &req.to,
        req.base_dir.as_deref(),
        PathAccess::Write,
        "fs.move",
    )?;

    if !from.exists() {
        return Err(
            ToolError::new(ToolErrorCode::NotFound, "fs.move", "source does not exist")
                .with_path(from.to_string_lossy()),
        );
    }
    // Refuse overlap in EITHER direction before any deletion (review P0 round 2:
    // source-inside-destination deleted both when the destination was removed).
    if same_or_nested(&from, &to, "fs.move")? {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.move",
            "source and destination overlap (one is inside the other); refusing to avoid data loss",
        )
        .with_path(to.to_string_lossy()));
    }

    let dest_exists = to.exists();
    if dest_exists && !req.overwrite {
        return Err(ToolError::new(
            ToolErrorCode::AlreadyExists,
            "fs.move",
            "destination exists and overwrite=false",
        )
        .with_path(to.to_string_lossy()));
    }

    // If the destination exists, move it aside into a unique, non-colliding
    // backup BEFORE attempting the install. This eliminates the previous
    // delete-before-install data-loss window (F1): on any install failure the
    // backup is restored, so the original destination is never lost. It also
    // makes a same-type dir-over-dir replace work on POSIX (where renaming over
    // a non-empty directory fails ENOTEMPTY) and on Windows (where a directory
    // cannot be replaced by rename at all) — the destination is gone from the
    // slot, so the source renames cleanly into place (plan §4.2, §3.1.1).
    let backup: Option<PathBuf> = if dest_exists {
        let bp = unique_backup_path(&to);
        std::fs::rename(&to, &bp).map_err(|e| map_io_error(&e, "fs.move", &to))?;
        Some(bp)
    } else {
        None
    };

    // Install the source into the (now empty) destination slot. A same-device
    // rename is atomic; EXDEV falls back to copy+delete.
    let installed = match std::fs::rename(&from, &to) {
        Ok(()) => Ok(FsMoveResult {
            moved: true,
            fallback_copy_delete: false,
            warning: None,
        }),
        Err(e) if is_cross_device_error(&e) => fs_move_exdev_install(ctx, &from, &to),
        // Portable EXDEV detector so Windows ERROR_NOT_SAME_DEVICE (17) is also
        // caught, not only POSIX EXDEV (18) (review P1).
        Err(e) => Err(map_io_error(&e, "fs.move", &from)),
    };

    match installed {
        Ok(mut res) => {
            // Install succeeded: remove the backup (the old destination). A
            // cleanup failure is surfaced as a warning rather than returning
            // unconditional success (plan §4.2: backup 清理失败必须在结果中报告).
            if let Some(bp) = &backup
                && let Err(e) = remove_any(bp, "fs.move")
            {
                let msg = format!(
                    "move succeeded but could not clean up the replaced destination backup at {}: {e}",
                    bp.display()
                );
                res.warning = Some(match res.warning.take() {
                    Some(existing) => format!("{existing}; {msg}"),
                    None => msg,
                });
            }
            Ok(res)
        }
        Err(e) => {
            // Install failed: best-effort restore the backup to the destination
            // slot so the original destination survives. The original
            // destination is safe in `backup`; `to` (if it exists at all here)
            // can only be a partial install artifact — never the original
            // destination, which was moved aside up front. A partial EXDEV copy
            // may have left an entry of a different type at `to` (e.g. a
            // half-written file where a directory used to be), which would make
            // a bare `rename(backup, to)` fail; remove it first so the backup
            // restores cleanly (plan §3.1.1: no failure path may lose the
            // original destination).
            if let Some(bp) = &backup {
                if to.exists() {
                    let _ = remove_any(&to, "fs.move");
                }
                let _ = std::fs::rename(bp, &to);
            }
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// fs_remove
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsRemoveRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    /// Defaults to `false`: a non-empty directory is NOT removed unless the
    /// caller passes `recursive=true` explicitly. Removal is destructive, so
    /// the safe default refuses to recurse (plan §7.2, review P0).
    #[serde(default)]
    pub recursive: bool,
    #[serde(default)]
    pub missing_ok: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsRemoveResult {
    pub removed: bool,
    /// Stable result vocabulary: `file`, `directory`, `symlink`, `other`, or
    /// `missing`. This remains a string for compatibility with the published
    /// v1 schema; callers should allow future additive kinds.
    pub kind: String,
}

pub fn fs_remove(
    ctx: &InvocationContext,
    req: &FsRemoveRequest,
) -> Result<FsRemoveResult, ToolError> {
    let _ = ctx;
    let path = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::DeleteEntry,
        "fs.remove",
    )?;
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if req.missing_ok {
                return Ok(FsRemoveResult {
                    removed: false,
                    kind: "missing".to_string(),
                });
            }
            return Err(map_io_error(&e, "fs.remove", &path));
        }
        Err(e) => return Err(map_io_error(&e, "fs.remove", &path)),
    };

    let kind = if meta.file_type().is_symlink() {
        "symlink"
    } else if meta.is_dir() {
        "directory"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    };

    if meta.file_type().is_symlink() {
        remove_symlink_nofollow(&path, &meta.file_type())
            .map_err(|e| map_io_error(&e, "fs.remove", &path))?;
    } else if meta.is_dir() {
        // Check if non-empty and recursive=false.
        let is_empty = std::fs::read_dir(&path)
            .map(|mut d| d.next().is_none())
            .unwrap_or(true);
        if !is_empty && !req.recursive {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.remove",
                "directory is not empty and recursive=false",
            )
            .with_path(path.to_string_lossy()));
        }
        if req.recursive {
            std::fs::remove_dir_all(&path).map_err(|e| map_io_error(&e, "fs.remove", &path))?;
        } else {
            std::fs::remove_dir(&path).map_err(|e| map_io_error(&e, "fs.remove", &path))?;
        }
    } else {
        std::fs::remove_file(&path).map_err(|e| map_io_error(&e, "fs.remove", &path))?;
    }

    Ok(FsRemoveResult {
        removed: true,
        kind: kind.to_string(),
    })
}
