//! `fs_mkdir`, `fs_write_text`, `fs_replace_text` (plan §7.2).
//!
//! Writes use a temp file in the SAME directory + atomic replace, so a crash
//! never leaves the target half-written. `fs_write_text` with `mode=create`
//! fails `already_exists` when the file exists; `mode=overwrite` replaces.
//! `fs_replace_text` does single/multi replace with preimage hashing.

use std::io::Write;
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{map_io_error, resolve_path, sha256_hex};
use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum WriteMode {
    Create,
    Overwrite,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum NewlineMode {
    /// Overwrite of an existing text file keeps the detected dominant newline;
    /// new files use the content as-is. (default)
    #[default]
    Preserve,
    Lf,
    Crlf,
    /// Current OS newline.
    Native,
    /// Do not transform content.
    Raw,
}

// ---------------------------------------------------------------------------
// fs_mkdir
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsMkdirRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default = "default_true")]
    pub recursive: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsMkdirResult {
    pub created: bool,
    pub path: String,
}

pub fn fs_mkdir(ctx: &InvocationContext, req: &FsMkdirRequest) -> Result<FsMkdirResult, ToolError> {
    let path = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::Write,
        "fs.mkdir",
    )?;
    let existed = path.is_dir();
    if req.recursive {
        std::fs::create_dir_all(&path).map_err(|e| map_io_error(&e, "fs.mkdir", &path))?;
    } else {
        std::fs::create_dir(&path).map_err(|e| map_io_error(&e, "fs.mkdir", &path))?;
    }
    Ok(FsMkdirResult {
        created: !existed,
        path: path.to_string_lossy().into_owned(),
    })
}

// ---------------------------------------------------------------------------
// fs_write_text
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsWriteTextRequest {
    pub path: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default = "default_overwrite")]
    pub mode: WriteMode,
    #[serde(default = "default_true")]
    pub create_parents: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
    #[serde(default)]
    pub newline_mode: NewlineMode,
}

fn default_overwrite() -> WriteMode {
    WriteMode::Overwrite
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsWriteTextResult {
    pub created: bool,
    pub bytes: u64,
    pub before_sha256: Option<String>,
    pub after_sha256: String,
}

pub fn fs_write_text(
    ctx: &InvocationContext,
    req: &FsWriteTextRequest,
) -> Result<FsWriteTextResult, ToolError> {
    let path = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::Write,
        "fs.write_text",
    )?;
    let existed = path.exists();

    // mode=create must fail if the file already exists.
    if existed && req.mode == WriteMode::Create {
        return Err(ToolError::new(
            ToolErrorCode::AlreadyExists,
            "fs.write_text",
            "file already exists and mode=create",
        )
        .with_path(path.to_string_lossy()));
    }

    let before_sha256 = if existed {
        std::fs::read(&path).ok().map(|b| sha256_hex(&b))
    } else {
        None
    };

    // expected_sha256 guard (against the CURRENT content before write).
    if let Some(expected) = &req.expected_sha256 {
        let actual = before_sha256.clone().unwrap_or_else(|| sha256_hex(b""));
        if actual != *expected {
            return Err(ToolError::new(
                ToolErrorCode::Conflict,
                "fs.write_text",
                "expected_sha256 does not match current content",
            )
            .with_path(path.to_string_lossy())
            .with_details(serde_json::json!({ "actual_sha256": actual })));
        }
    }

    // Determine output bytes with newline normalization.
    let bytes = normalize_newlines(&req.content, req.newline_mode, existed, &path);

    // create_parents
    if let Some(parent) = path.parent()
        && req.create_parents
    {
        std::fs::create_dir_all(parent).map_err(|e| map_io_error(&e, "fs.write_text", parent))?;
    }

    // Temp file in same dir + atomic replace.
    atomic_write(&path, &bytes).map_err(|e| map_io_error(&e, "fs.write_text", &path))?;

    let after_sha256 = sha256_hex(&bytes);
    Ok(FsWriteTextResult {
        created: !existed,
        bytes: bytes.len() as u64,
        before_sha256,
        after_sha256,
    })
}

fn normalize_newlines(content: &str, mode: NewlineMode, existed: bool, path: &Path) -> Vec<u8> {
    match mode {
        NewlineMode::Raw => content.as_bytes().to_vec(),
        NewlineMode::Lf => content
            .replace("\r\n", "\n")
            .replace('\r', "\n")
            .into_bytes(),
        NewlineMode::Crlf => {
            // First normalize to LF, then to CRLF.
            let lf = content.replace("\r\n", "\n").replace('\r', "\n");
            lf.replace('\n', "\r\n").into_bytes()
        }
        NewlineMode::Native => {
            if cfg!(target_os = "windows") {
                let lf = content.replace("\r\n", "\n").replace('\r', "\n");
                lf.replace('\n', "\r\n").into_bytes()
            } else {
                content
                    .replace("\r\n", "\n")
                    .replace('\r', "\n")
                    .into_bytes()
            }
        }
        NewlineMode::Preserve => {
            if existed {
                // Detect dominant newline of existing file.
                let existing = std::fs::read(path).unwrap_or_default();
                let existing_str = String::from_utf8_lossy(&existing);
                let crlf = existing_str.matches("\r\n").count();
                let lf = existing_str.matches('\n').count();
                let dominant_is_crlf = crlf * 2 >= lf;
                // Normalize input to LF first, then apply dominant.
                let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
                if dominant_is_crlf {
                    normalized.replace('\n', "\r\n").into_bytes()
                } else {
                    normalized.into_bytes()
                }
            } else {
                content.as_bytes().to_vec()
            }
        }
    }
}

/// Write `bytes` to a temp file in the same directory as `target`, then
/// atomically rename over `target`. On Windows this is still a single rename
/// (atomic on the same volume).
fn atomic_write(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(".xuanling-tmp-{}", uuid::Uuid::now_v7().simple()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    // rename-over-existing is atomic on POSIX same-fs and on Win32 same-volume.
    std::fs::rename(&tmp, target).inspect_err(|_| {
        // Clean up the temp file on failure.
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

// ---------------------------------------------------------------------------
// fs_replace_text
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsReplaceTextRequest {
    pub path: String,
    pub old: String,
    pub new: String,
    #[serde(default)]
    pub replace_all: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsReplaceTextResult {
    pub replacements: u64,
    pub before_sha256: String,
    pub after_sha256: String,
}

pub fn fs_replace_text(
    ctx: &InvocationContext,
    req: &FsReplaceTextRequest,
) -> Result<FsReplaceTextResult, ToolError> {
    let path = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::Write,
        "fs.replace_text",
    )?;
    let original =
        std::fs::read_to_string(&path).map_err(|e| map_io_error(&e, "fs.replace_text", &path))?;
    let before_sha256 = sha256_hex(original.as_bytes());

    if let Some(expected) = &req.expected_sha256
        && before_sha256 != *expected
    {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            "fs.replace_text",
            "expected_sha256 does not match current content",
        )
        .with_path(path.to_string_lossy())
        .with_details(serde_json::json!({ "actual_sha256": before_sha256 })));
    }

    let count = original.matches(&req.old).count() as u64;
    if count == 0 {
        return Err(ToolError::new(
            ToolErrorCode::NotFound,
            "fs.replace_text",
            "pattern not found in file",
        )
        .with_path(path.to_string_lossy()));
    }
    if count > 1 && !req.replace_all {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            "fs.replace_text",
            format!("multiple matches ({count}) but replace_all=false"),
        )
        .with_path(path.to_string_lossy()));
    }

    let updated = if req.replace_all {
        original.replace(&req.old, &req.new)
    } else {
        original.replacen(&req.old, &req.new, 1)
    };
    let bytes = updated.into_bytes();
    atomic_write(&path, &bytes).map_err(|e| map_io_error(&e, "fs.replace_text", &path))?;
    let after_sha256 = sha256_hex(&bytes);

    let replacements = if req.replace_all { count } else { 1 };
    Ok(FsReplaceTextResult {
        replacements,
        before_sha256,
        after_sha256,
    })
}

// ---------------------------------------------------------------------------
// fs_patch (ADR 0013 v2: strict single-file unified diff)
// ---------------------------------------------------------------------------

/// `fs_patch` request (ADR 0013 v2 / ADR 0027 §8). Strict single-file unified
/// diff with a preimage CAS guard. `content`/`text`/`replacement` are NOT
/// accepted (zero write on any parse failure).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsPatchRequest {
    pub path: String,
    /// Whole-file SHA-256 of the expected preimage (lowercased hex). The file
    /// is re-hashed at apply time; a mismatch is `conflict` with zero writes.
    pub expected_preimage_sha256: String,
    pub unified_diff: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct FsPatchResult {
    pub hunks_applied: u64,
    pub before_sha256: String,
    pub after_sha256: String,
}

/// A parsed unified-diff hunk.
struct Hunk {
    /// 1-based start line in the old file.
    old_start: usize,
    /// Old-side lines (context + removed), in order.
    old_lines: Vec<String>,
    /// New-side lines (context + added), in order.
    new_lines: Vec<String>,
}

struct HunkHeader {
    old_start: usize,
    old_len: usize,
    _new_start: usize,
    new_len: usize,
}

pub fn fs_patch(ctx: &InvocationContext, req: &FsPatchRequest) -> Result<FsPatchResult, ToolError> {
    let path = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::Write,
        "fs.patch",
    )?;
    let original =
        std::fs::read_to_string(&path).map_err(|e| map_io_error(&e, "fs.patch", &path))?;
    let before_sha256 = sha256_hex(original.as_bytes());

    // Preimage CAS guard (ADR 0013/0015). Zero writes on mismatch.
    if before_sha256 != req.expected_preimage_sha256 {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            "fs.patch",
            "expected_preimage_sha256 does not match current content",
        )
        .with_path(path.to_string_lossy())
        .with_details(serde_json::json!({ "actual_sha256": before_sha256 })));
    }

    // Parse the unified diff BEFORE any write: a parse failure must leave the
    // file untouched (ADR 0013 v2 / plan §8.4 `fs_patch_parse_failure_writes_nothing`).
    let hunks = parse_unified_diff(&req.unified_diff)?;
    let updated = apply_hunks(&original, &hunks)?;
    let bytes = updated.into_bytes();
    atomic_write(&path, &bytes).map_err(|e| map_io_error(&e, "fs.patch", &path))?;
    let after_sha256 = sha256_hex(&bytes);

    Ok(FsPatchResult {
        hunks_applied: hunks.len() as u64,
        before_sha256,
        after_sha256,
    })
}

/// Strict unified-diff parser. Returns a typed error (no panic) on any
/// malformation; the caller treats that as a zero-write `invalid_input`.
fn parse_unified_diff(diff: &str) -> Result<Vec<Hunk>, ToolError> {
    let mut lines = diff.lines().peekable();
    let mut hunks = Vec::new();
    while let Some(line) = lines.next() {
        if let Some(rest) = line.strip_prefix("@@") {
            let header = parse_hunk_header(rest)?;
            let mut old_lines = Vec::new();
            let mut new_lines = Vec::new();
            let mut old_count = 0usize;
            let mut new_count = 0usize;
            while old_count < header.old_len || new_count < header.new_len {
                let body = lines
                    .next()
                    .ok_or_else(|| invalid_diff("hunk body is truncated"))?;
                if body.starts_with("@@") {
                    return Err(invalid_diff(
                        "new hunk started before the declared line counts were satisfied",
                    ));
                }
                match body.chars().next() {
                    Some(' ') => {
                        let l = body[1..].to_string();
                        old_lines.push(l.clone());
                        new_lines.push(l);
                        old_count += 1;
                        new_count += 1;
                    }
                    Some('-') => {
                        old_lines.push(body[1..].to_string());
                        old_count += 1;
                    }
                    Some('+') => {
                        new_lines.push(body[1..].to_string());
                        new_count += 1;
                    }
                    Some('\\') => {
                        // "\ No newline at end of file" marker — does not count.
                    }
                    _ => {
                        return Err(invalid_diff(
                            "hunk body line must start with ' ', '-', '+', or '\\'",
                        ));
                    }
                }
            }
            if old_count != header.old_len || new_count != header.new_len {
                return Err(invalid_diff("hunk line counts do not match the header"));
            }
            hunks.push(Hunk {
                old_start: header.old_start,
                old_lines,
                new_lines,
            });
        } else if line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.is_empty()
        {
            // Per-file preamble lines are tolerated (and ignored) for a strict
            // single-file patch.
            continue;
        } else {
            return Err(invalid_diff("unexpected line outside a hunk"));
        }
    }
    if hunks.is_empty() {
        return Err(invalid_diff("no hunks found in the unified diff"));
    }
    Ok(hunks)
}

/// Parse the `... -a,b +c,d ...` tail of an `@@` hunk header.
fn parse_hunk_header(tail: &str) -> Result<HunkHeader, ToolError> {
    // tail looks like " -a,b +c,d @@ <optional section>"
    let s = tail.trim_start();
    let Some(minus) = s.strip_prefix('-') else {
        return Err(invalid_diff("hunk header missing `-old` range"));
    };
    let comma_old = minus.find(',').unwrap_or(minus.len());
    let old_start: usize = minus[..comma_old]
        .parse()
        .map_err(|_| invalid_diff("hunk header old-start is not a number"))?;
    let after_old = &minus[comma_old.min(minus.len())..];
    let rest = after_old.strip_prefix(',').unwrap_or(after_old);
    // Skip the old-len digits.
    let old_len_digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    let old_len: usize = if old_len_digits == 0 {
        1
    } else {
        rest[..old_len_digits]
            .parse()
            .map_err(|_| invalid_diff("hunk header old-len is not a number"))?
    };
    let rest = &rest[old_len_digits..];
    let rest = rest.trim_start();
    let Some(plus_part) = rest.strip_prefix('+') else {
        return Err(invalid_diff("hunk header missing `+new` range"));
    };
    let comma_new = plus_part.find(',').unwrap_or(plus_part.len());
    let new_start: usize = plus_part[..comma_new]
        .parse()
        .map_err(|_| invalid_diff("hunk header new-start is not a number"))?;
    let after_new = &plus_part[comma_new.min(plus_part.len())..];
    let rest = after_new.strip_prefix(',').unwrap_or(after_new);
    let new_len_digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    let new_len: usize = if new_len_digits == 0 {
        1
    } else {
        rest[..new_len_digits]
            .parse()
            .map_err(|_| invalid_diff("hunk header new-len is not a number"))?
    };
    Ok(HunkHeader {
        old_start,
        old_len,
        _new_start: new_start,
        new_len,
    })
}

/// Apply parsed hunks to `original`, validating that each hunk's old-side lines
/// match the file at the declared position. A mismatch is `conflict` (zero
/// writes — the caller has not written yet).
fn apply_hunks(original: &str, hunks: &[Hunk]) -> Result<String, ToolError> {
    let had_trailing_newline = original.ends_with('\n');
    let body = if had_trailing_newline {
        &original[..original.len() - 1]
    } else {
        original
    };
    let lines: Vec<&str> = body.split('\n').collect();
    let mut result: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    for hunk in hunks {
        let start_idx = hunk.old_start.saturating_sub(1);
        if start_idx < cursor {
            return Err(invalid_diff("hunks overlap or are out of order"));
        }
        while cursor < start_idx {
            result.push(lines.get(cursor).copied().unwrap_or("").to_string());
            cursor += 1;
        }
        for (i, ol) in hunk.old_lines.iter().enumerate() {
            match lines.get(start_idx + i) {
                Some(actual) if *actual == ol.as_str() => {}
                _ => {
                    return Err(ToolError::new(
                        ToolErrorCode::Conflict,
                        "fs.patch",
                        "hunk context/remove line does not match the file at the declared line",
                    )
                    .with_details(serde_json::json!({"reason": "hunk_context_mismatch"})));
                }
            }
        }
        for nl in &hunk.new_lines {
            result.push(nl.clone());
        }
        cursor = start_idx + hunk.old_lines.len();
    }
    while cursor < lines.len() {
        result.push(lines[cursor].to_string());
        cursor += 1;
    }
    let mut out = result.join("\n");
    if had_trailing_newline {
        out.push('\n');
    }
    Ok(out)
}

fn invalid_diff(reason: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::InvalidInput,
        "fs.patch",
        format!("invalid unified diff: {reason}"),
    )
    .with_details(serde_json::json!({"reason": "patch_parse_failed"}))
}

// ---------------------------------------------------------------------------
// fs_edit (ADR 0027 §8.2): precise old/new replacement with multi-match
// location diagnostics, dry-run diff, and optional reversible ChangeSet.
// ---------------------------------------------------------------------------

/// `fs_edit` request. Precise `old`->`new` replacement; by default the match
/// must be UNIQUE (`replace_all=false`). Multiple matches return their
/// line/column locations WITHOUT writing (plan §8.2/§8.4).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsEditRequest {
    pub path: String,
    pub old: String,
    pub new: String,
    #[serde(default)]
    pub replace_all: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_sha256: Option<String>,
    /// Return a unified-diff preview without writing (plan §8.2).
    #[serde(default)]
    pub dry_run: bool,
    /// Register a reversible ChangeSet so the apply can be rolled back (§8.1).
    #[serde(default)]
    pub reversible: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct MatchLocation {
    pub line: u64,
    pub column: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
pub struct FsEditResult {
    pub replacements: u64,
    pub before_sha256: String,
    pub after_sha256: String,
    /// Unified-diff preview (present on dry_run, or on a successful apply).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
    /// Match locations reported when `old` matches >1 and `replace_all=false`
    /// (NO write occurs in that case). Each location is 1-based line/column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matches: Option<Vec<MatchLocation>>,
    /// ChangeSet id when `reversible=true` and the change was applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_id: Option<String>,
    /// ChangeSet state (`applied_awaiting_completion` after apply).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub change_state: Option<String>,
}

pub fn fs_edit(ctx: &InvocationContext, req: &FsEditRequest) -> Result<FsEditResult, ToolError> {
    if req.old.is_empty() {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.edit",
            "`old` must be non-empty",
        ));
    }
    let access = if req.dry_run {
        PathAccess::Read
    } else {
        PathAccess::Write
    };
    let path = resolve_path(ctx, &req.path, req.base_dir.as_deref(), access, "fs.edit")?;
    let original = std::fs::read(&path).map_err(|e| map_io_error(&e, "fs.edit", &path))?;
    let before_sha256 = sha256_hex(&original);
    let original_str = std::str::from_utf8(&original).map_err(|_| {
        ToolError::new(
            ToolErrorCode::InvalidUtf8,
            "fs.edit",
            "file content is not valid UTF-8",
        )
        .with_path(path.to_string_lossy())
    })?;

    // Preimage CAS guard.
    if let Some(expected) = &req.expected_sha256
        && before_sha256 != *expected
    {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            "fs.edit",
            "expected_sha256 does not match current content",
        )
        .with_path(path.to_string_lossy())
        .with_details(serde_json::json!({ "actual_sha256": before_sha256 })));
    }

    // Collect all match byte-offsets.
    let offsets: Vec<usize> = original_str
        .match_indices(&req.old)
        .map(|(i, _)| i)
        .collect();
    let count = offsets.len() as u64;
    if count == 0 {
        return Err(ToolError::new(
            ToolErrorCode::NotFound,
            "fs.edit",
            "`old` not found in file",
        )
        .with_path(path.to_string_lossy()));
    }
    if count > 1 && !req.replace_all {
        // Multiple matches: report locations WITHOUT writing (plan §8.4).
        let locations: Vec<MatchLocation> = offsets
            .iter()
            .map(|&off| line_column(original_str, off))
            .collect();
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            "fs.edit",
            format!(
                "`old` matches {count} locations; pass replace_all=true or make the match unique"
            ),
        )
        .with_path(path.to_string_lossy())
        .with_details(serde_json::json!({
            "reason": "multiple_matches",
            "matches": locations,
        })));
    }

    let updated = if req.replace_all {
        original_str.replace(&req.old, &req.new)
    } else {
        original_str.replacen(&req.old, &req.new, 1)
    };
    let updated_bytes = updated.into_bytes();
    let after_sha256 = sha256_hex(&updated_bytes);
    let diff = Some(make_unified_diff(
        original_str,
        std::str::from_utf8(&updated_bytes).unwrap_or(""),
    ));

    if req.dry_run {
        // NO write.
        return Ok(FsEditResult {
            replacements: if req.replace_all { count } else { 1 },
            before_sha256,
            after_sha256,
            diff,
            matches: None,
            change_id: None,
            change_state: Some(super::change::ChangeSetState::DryRun.as_str().to_string()),
        });
    }

    super::atomic_write_file(&path, &updated_bytes)
        .map_err(|e| map_io_error(&e, "fs.edit", &path))?;

    let (change_id, change_state) = if req.reversible {
        let applied =
            super::change::register_applied(path.clone(), original.clone(), &updated_bytes);
        (
            Some(applied.change_id),
            Some(applied.state.as_str().to_string()),
        )
    } else {
        (None, None)
    };

    Ok(FsEditResult {
        replacements: if req.replace_all { count } else { 1 },
        before_sha256,
        after_sha256,
        diff,
        matches: None,
        change_id,
        change_state,
    })
}

/// 1-based (line, column) of a byte `offset` in `s` (column is a byte column
/// within the line, 1-based).
fn line_column(s: &str, offset: usize) -> MatchLocation {
    let mut line = 1u64;
    let mut last_nl = None;
    for (i, b) in s.as_bytes().iter().enumerate() {
        if i >= offset {
            break;
        }
        if *b == b'\n' {
            line += 1;
            last_nl = Some(i);
        }
    }
    let column = (offset - last_nl.map(|i| i + 1).unwrap_or(0)) as u64 + 1;
    MatchLocation { line, column }
}

/// Context lines kept around each change region (plan W7.3, C-11).
const DIFF_CONTEXT_LINES: usize = 3;

/// Edit-script operation produced by [`diff_lines`].
#[derive(Clone, Copy, PartialEq, Eq)]
enum DiffOp {
    Keep,
    Delete,
    Insert,
}

/// Myers O(ND) shortest-edit-script between two line slices. Returns one op
/// per consumed position: `Keep` advances both sides, `Delete` advances the
/// old side, `Insert` advances the new side.
fn diff_lines(old: &[&str], new: &[&str]) -> Vec<DiffOp> {
    let n = old.len();
    let m = new.len();
    let max = n + m;
    let offset = max as isize;
    // v[k] = furthest old-index reachable on diagonal k (= old - new offset).
    let mut v = vec![0isize; 2 * max + 1];
    let mut trace: Vec<Vec<isize>> = Vec::new();
    let mut found = false;
    for d in 0..=max {
        trace.push(v.clone());
        for k in (-(d as isize)..=(d as isize)).step_by(2) {
            let down = k == -(d as isize)
                || (k != d as isize && v[(k - 1 + offset) as usize] < v[(k + 1 + offset) as usize]);
            let mut x = if down {
                v[(k + 1 + offset) as usize] as usize
            } else {
                v[(k - 1 + offset) as usize] as usize + 1
            };
            let mut y = x as isize - k;
            while x < n && y >= 0 && (y as usize) < m && old[x] == new[y as usize] {
                x += 1;
                y += 1;
            }
            v[(k + offset) as usize] = x as isize;
            if x >= n && y as usize >= m {
                found = true;
                break;
            }
        }
        if found {
            break;
        }
    }

    // Backtrack from (n, m) to (0, 0), then reverse into forward order.
    let mut ops = Vec::with_capacity(max);
    let mut x = n;
    let mut y = m;
    for d in (0..trace.len()).rev() {
        let vd = &trace[d];
        let k = x as isize - y as isize;
        let (prev_x, prev_y) = if d == 0 {
            (0usize, 0usize)
        } else {
            let down = k == -(d as isize)
                || (k != d as isize
                    && vd[(k - 1 + offset) as usize] < vd[(k + 1 + offset) as usize]);
            let pk = if down { k + 1 } else { k - 1 };
            let px = vd[(pk + offset) as usize] as usize;
            let py = px as isize - pk;
            debug_assert!(py >= 0, "backtrack diagonal stays within bounds");
            (px, py as usize)
        };
        while x > prev_x && y > prev_y {
            ops.push(DiffOp::Keep);
            x -= 1;
            y -= 1;
        }
        if d > 0 {
            if x == prev_x {
                ops.push(DiffOp::Insert);
                y -= 1;
            } else {
                ops.push(DiffOp::Delete);
                x -= 1;
            }
        }
    }
    ops.reverse();
    ops
}

/// One output hunk: 1-based old/new start lines plus `(prefix, text)` body
/// rows (`' '` context, `'-'` removal, `'+'` addition).
struct DiffHunkSpec {
    old_start: usize,
    new_start: usize,
    body: Vec<(char, String)>,
}

/// Group an edit script into hunks, each padded with up to
/// [`DIFF_CONTEXT_LINES`] shared lines; overlapping padded regions merge into
/// one hunk.
fn group_hunks(old: &[&str], new: &[&str], ops: &[DiffOp]) -> Vec<DiffHunkSpec> {
    // Change regions: maximal runs of non-Keep ops, as old/new index ranges.
    #[derive(Clone, Copy)]
    struct Region {
        old_start: usize,
        old_end: usize,
        new_start: usize,
    }
    let mut regions: Vec<Region> = Vec::new();
    let mut oi = 0usize;
    let mut ni = 0usize;
    let mut index = 0usize;
    while index < ops.len() {
        if ops[index] == DiffOp::Keep {
            oi += 1;
            ni += 1;
            index += 1;
            continue;
        }
        let (r_old_start, r_new_start) = (oi, ni);
        while index < ops.len() && ops[index] != DiffOp::Keep {
            match ops[index] {
                DiffOp::Delete => oi += 1,
                DiffOp::Insert => ni += 1,
                DiffOp::Keep => unreachable!("loop condition excludes Keep"),
            }
            index += 1;
        }
        regions.push(Region {
            old_start: r_old_start,
            old_end: oi,
            new_start: r_new_start,
        });
    }

    // Expand each region by context and merge overlapping/adjacent windows.
    let ctx = DIFF_CONTEXT_LINES;
    let mut windows: Vec<(usize, usize, usize)> = Vec::new(); // (old start, old end, new start)
    for region in regions {
        let hs = region.old_start.saturating_sub(ctx);
        let he = (region.old_end + ctx).min(old.len());
        let pre_context = region.old_start - hs;
        let new_start = region.new_start - pre_context;
        if let Some(last) = windows.last_mut()
            && hs <= last.1
        {
            last.1 = last.1.max(he);
            continue;
        }
        windows.push((hs, he, new_start));
    }

    // Emit one body per merged window by walking the op list fresh (ops are
    // indexed by consumed positions on both sides).
    let mut hunks = Vec::with_capacity(windows.len());
    for (window_start, window_end, window_new_start) in windows {
        let mut body: Vec<(char, String)> = Vec::new();
        let mut oi = 0usize;
        let mut ni = 0usize;
        for op in ops {
            let inside = oi >= window_start && oi < window_end;
            let at_end = oi == window_end;
            match op {
                DiffOp::Keep => {
                    if inside {
                        body.push((' ', old[oi].to_string()));
                    }
                    oi += 1;
                    ni += 1;
                }
                DiffOp::Delete => {
                    if inside {
                        body.push(('-', old[oi].to_string()));
                    }
                    oi += 1;
                }
                DiffOp::Insert => {
                    if inside || at_end {
                        body.push(('+', new[ni].to_string()));
                    }
                    ni += 1;
                }
            }
        }
        hunks.push(DiffHunkSpec {
            old_start: window_start + 1,
            new_start: window_new_start + 1,
            body,
        });
    }
    hunks
}

/// Produce a unified diff from `original` to `updated` as LOCAL hunks with
/// [`DIFF_CONTEXT_LINES`] of context (plan W7.3, C-11) — re-applicable by
/// `fs_patch`'s parser. The line model matches `apply_hunks` exactly: one
/// trailing newline is stripped before splitting and the ORIGINAL trailing
/// newline state is preserved by the apply step, so the diff never encodes
/// trailing-newline changes.
fn make_unified_diff(original: &str, updated: &str) -> String {
    let old_body = original.strip_suffix('\n').unwrap_or(original);
    let new_body = updated.strip_suffix('\n').unwrap_or(updated);
    let old: Vec<&str> = old_body.split('\n').collect();
    let new: Vec<&str> = new_body.split('\n').collect();
    let ops = diff_lines(&old, &new);
    let hunks = group_hunks(&old, &new, &ops);

    let mut out = String::new();
    out.push_str("--- file\n+++ file\n");
    for hunk in &hunks {
        let old_len = hunk.body.iter().filter(|(p, _)| *p != '+').count();
        let new_len = hunk.body.iter().filter(|(p, _)| *p != '-').count();
        out.push_str(&format!(
            "@@ -{},{} +{},{} @@\n",
            hunk.old_start, old_len, hunk.new_start, new_len
        ));
        for (prefix, text) in &hunk.body {
            out.push(*prefix);
            out.push_str(text);
            out.push('\n');
        }
    }
    out
}
