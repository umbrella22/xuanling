//! `fs_read_text`, `fs_read_bytes`, `fs_hash` (plan §7.2).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};

use super::{map_io_error, resolve_path, sha256_hex, sha256_open_file};
use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;

// ---------------------------------------------------------------------------
// fs_read_text
// ---------------------------------------------------------------------------

/// Typed resume token for `fs_read_text` byte-window reads (ADR 0027 §5.2). It
/// is bound to `fs_read_text` only; a cursor/resume from another tool is
/// rejected at the MCP layer. On resume the toolkit re-hashes the file and
/// compares to `preimage_sha256`; a mismatch (concurrent modification) returns
/// `conflict` instead of splicing inconsistent fragments (ADR 0027 §6.1).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub struct TextResume {
    /// Byte offset where the next window starts.
    pub offset_bytes: u64,
    /// Whole-file SHA-256 (lowercased hex) captured when the resume was issued.
    pub preimage_sha256: String,
    /// The logical line range that produced this window, if any. Its presence
    /// prevents a resume token from silently changing domains.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_range: Option<TextLineRange>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub struct TextLineRange {
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsReadTextRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default)]
    pub include_sha256: bool,
    /// Byte budget for the returned content window (ADR 0027 §6.1). When set,
    /// the file is read as a byte window cut at a UTF-8 code-point boundary and
    /// the result reports `truncated`/`total_bytes`/`returned_bytes`/
    /// `returned_chars`/`sha256`/`next_resume`. When `None`, the whole file is
    /// returned (current behavior; zero regression). `0` is a legal
    /// metadata-only window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    /// Resume a previous bounded read (ADR 0027 §6.1). The toolkit re-hashes the
    /// file and rejects a stale preimage with `conflict`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<TextResume>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsReadTextResult {
    pub content: String,
    pub total_lines: u64,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub newline_style: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// Bytes returned in `content` (bounded window only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returned_bytes: Option<u64>,
    /// Chars in `content` (bounded window only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returned_chars: Option<u64>,
    /// Total file size in bytes (bounded window only; from metadata).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    /// True when `content` is smaller than the remaining file content.
    #[serde(default)]
    pub truncated: bool,
    /// Resume token for the next window (present iff `truncated`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_resume: Option<TextResume>,
    /// Absolute byte bounds of the requested line range in the original file.
    /// These are present only when `start_line` or `end_line` was supplied and
    /// make the range/byte-window composition auditable without rewriting the
    /// selected bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_start_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_end_bytes: Option<u64>,
}

pub fn read_text(
    ctx: &InvocationContext,
    req: &FsReadTextRequest,
) -> Result<FsReadTextResult, ToolError> {
    let path = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::Read,
        "fs.read_text",
    )?;
    let mut file =
        std::fs::File::open(&path).map_err(|e| map_io_error(&e, "fs.read_text", &path))?;
    let meta = file
        .metadata()
        .map_err(|e| map_io_error(&e, "fs.read_text", &path))?;
    // Reject reading a directory as text.
    if meta.is_dir() {
        return Err(ToolError::new(
            ToolErrorCode::IsDirectory,
            "fs.read_text",
            "fs_read_text target is a directory",
        )
        .with_path(path.to_string_lossy()));
    }
    let total_bytes = meta.len();

    // A line range denotes a logical text slice. Resolve it before bounded
    // windowing so `start_line`/`end_line` never disappear just because the
    // public MCP layer selected an output budget.
    if req.start_line.is_some() || req.end_line.is_some() {
        return read_text_line_range(path, &mut file, req, total_bytes);
    }

    // Bounded byte-window path (ADR 0027 §6.1).
    if let Some(max_bytes) = req.max_bytes {
        return read_text_bounded(&path, &mut file, req, max_bytes, total_bytes);
    }

    // Full-read path (current behavior; zero regression).
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| map_io_error(&e, "fs.read_text", &path))?;
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        ToolError::new(
            ToolErrorCode::InvalidUtf8,
            "fs.read_text",
            "file content is not valid UTF-8",
        )
        .with_path(path.to_string_lossy())
    })?;

    let newline_style = detect_newline_style(&content);
    let total_lines = content.lines().count() as u64;

    let sha256 = if req.include_sha256 {
        Some(sha256_hex(&bytes))
    } else {
        None
    };

    Ok(FsReadTextResult {
        content,
        total_lines,
        start_line: None,
        end_line: None,
        newline_style,
        sha256: sha256.clone(),
        returned_bytes: None,
        returned_chars: None,
        total_bytes: None,
        truncated: false,
        next_resume: None,
        range_start_bytes: None,
        range_end_bytes: None,
    })
}

fn read_text_line_range(
    path: std::path::PathBuf,
    file: &mut std::fs::File,
    req: &FsReadTextRequest,
    whole_file_bytes: u64,
) -> Result<FsReadTextResult, ToolError> {
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| map_io_error(&e, "fs.read_text", &path))?;
    let resume_preimage = req.resume.as_ref().map(|_| sha256_hex(&bytes));
    if let (Some(resume), Some(actual)) = (&req.resume, &resume_preimage)
        && resume.preimage_sha256 != *actual
    {
        return Err(ToolError::new(
            ToolErrorCode::Conflict,
            "fs.read_text",
            "resume rejected: file changed since the previous window",
        )
        .with_path(path.to_string_lossy())
        .with_details(serde_json::json!({
            "reason": "resume_preimage_mismatch",
            "expected_sha256": resume.preimage_sha256,
            "actual_sha256": actual,
        })));
    }
    let content = String::from_utf8(bytes.clone()).map_err(|_| {
        ToolError::new(
            ToolErrorCode::InvalidUtf8,
            "fs.read_text",
            "file content is not valid UTF-8",
        )
        .with_path(path.to_string_lossy())
    })?;
    let spans = line_spans(&content);
    let total_lines = spans.len() as u64;
    let (line_range, range_start, range_end) =
        resolve_line_range(&spans, req.start_line, req.end_line, &path)?;
    let start_line = Some(line_range.start_line);
    let end_line = Some(line_range.end_line);
    if let Some(resume) = &req.resume
        && resume.line_range.as_ref() != Some(&line_range)
    {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_text",
            "resume token belongs to a different line range",
        )
        .with_path(path.to_string_lossy())
        .with_details(serde_json::json!({"reason": "resume_range_mismatch"})));
    }
    // TextResume offsets are absolute file offsets for both full-file and
    // line-range reads. This avoids a second, ambiguous offset domain.
    let offset = req
        .resume
        .as_ref()
        .map(|resume| resume.offset_bytes)
        .unwrap_or(range_start as u64);
    if offset < range_start as u64 || offset > range_end as u64 {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_text",
            "resume offset is outside the selected line range",
        )
        .with_path(path.to_string_lossy()));
    }
    let offset_usize = usize::try_from(offset).map_err(|_| {
        ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_text",
            "resume offset cannot be represented on this platform",
        )
        .with_path(path.to_string_lossy())
    })?;
    if !content.is_char_boundary(offset_usize) {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_text",
            "resume offset is not a UTF-8 boundary",
        )
        .with_path(path.to_string_lossy()));
    }
    let max_bytes = req.max_bytes;
    let remaining = &content[offset_usize..range_end];
    let (preview, truncated, returned_bytes) = match max_bytes {
        Some(max_bytes) => {
            let length = utf8_prefix_within_budget(remaining, max_bytes, &path)?;
            // A zero-byte request is a metadata-only probe. It intentionally
            // has no continuation token: the caller must issue a new window
            // with a positive budget, so a token at the same offset cannot be
            // replayed forever.
            (
                remaining[..length].to_string(),
                max_bytes > 0 && length < remaining.len(),
                length as u64,
            )
        }
        None => (remaining.to_string(), false, remaining.len() as u64),
    };
    let sha256 = if req.include_sha256 || max_bytes.is_some() || req.resume.is_some() {
        Some(resume_preimage.unwrap_or_else(|| sha256_hex(&bytes)))
    } else {
        None
    };
    Ok(FsReadTextResult {
        newline_style: detect_newline_style(&content[range_start..range_end]),
        total_lines,
        start_line,
        end_line,
        returned_chars: max_bytes.map(|_| preview.chars().count() as u64),
        total_bytes: max_bytes.map(|_| whole_file_bytes),
        content: preview,
        sha256: sha256.clone(),
        returned_bytes: max_bytes.map(|_| returned_bytes),
        truncated,
        next_resume: truncated.then(|| TextResume {
            offset_bytes: offset + returned_bytes,
            preimage_sha256: sha256.clone().expect("bounded range reads have a hash"),
            line_range: Some(line_range),
        }),
        range_start_bytes: Some(range_start as u64),
        range_end_bytes: Some(range_end as u64),
    })
}

/// Bounded byte-window read for `fs_read_text` (ADR 0027 §6.1).
///
/// - Hashes the whole file as a streaming pass (never cached) to produce/validate
///   the preimage hash.
/// - On resume, a stale preimage hash (concurrent modification) is `conflict`.
/// - Reads `[offset, offset+max_bytes)` and truncates the buffer at the last
///   valid UTF-8 boundary so `content` is always valid UTF-8 and reassembles to
///   the original bytes.
/// - `max_bytes=0` is a metadata-only window (empty content, full metadata).
fn read_text_bounded(
    path: &std::path::Path,
    file: &mut std::fs::File,
    req: &FsReadTextRequest,
    max_bytes: u64,
    total_bytes: u64,
) -> Result<FsReadTextResult, ToolError> {
    // Determine the read offset.
    let offset = req.resume.as_ref().map(|r| r.offset_bytes).unwrap_or(0);
    if req
        .resume
        .as_ref()
        .is_some_and(|resume| resume.line_range.is_some())
    {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_text",
            "resume token belongs to a line-range read",
        )
        .with_path(path.to_string_lossy())
        .with_details(serde_json::json!({"reason": "resume_range_mismatch"})));
    }
    if offset > total_bytes {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_text",
            format!("resume offset_bytes={offset} is past end of file (total_bytes={total_bytes})"),
        )
        .with_path(path.to_string_lossy()));
    }
    let resume_preimage = if let Some(resume) = &req.resume {
        let actual = sha256_open_file(file).map_err(|e| map_io_error(&e, "fs.read_text", path))?;
        if resume.preimage_sha256 != actual {
            return Err(ToolError::new(
                ToolErrorCode::Conflict,
                "fs.read_text",
                "resume rejected: file changed since the previous window \
                 (preimage hash mismatch); re-read from the start",
            )
            .with_path(path.to_string_lossy())
            .with_details(serde_json::json!({
                "reason": "resume_preimage_mismatch",
                "expected_sha256": resume.preimage_sha256,
                "actual_sha256": actual,
            })));
        }
        Some(actual)
    } else {
        None
    };
    if req.resume.is_some() && offset < total_bytes {
        let mut probe = [0_u8; 1];
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| map_io_error(&e, "fs.read_text", path))?;
        file.read_exact(&mut probe)
            .map_err(|e| map_io_error(&e, "fs.read_text", path))?;
        if probe[0] & 0b1100_0000 == 0b1000_0000 {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.read_text",
                "resume offset is not a UTF-8 boundary",
            )
            .with_path(path.to_string_lossy())
            .with_details(serde_json::json!({"reason": "resume_offset_invalid"})));
        }
    }

    // Read the requested window plus up to three look-ahead bytes. The preview
    // itself never exceeds `max_bytes`, but look-ahead lets a nonzero budget
    // advance over a multi-byte scalar instead of repeatedly returning the
    // same offset (e.g. `€` with a one-byte budget).
    let requested = max_bytes.min(total_bytes - offset);
    let want_u64 = requested.saturating_add(3).min(total_bytes - offset);
    let want = usize::try_from(want_u64).map_err(|_| {
        ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_text",
            "requested output window is too large for this platform",
        )
        .with_path(path.to_string_lossy())
    })?;
    let mut buf = vec![0u8; want];
    if want > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| map_io_error(&e, "fs.read_text", path))?;
        let mut filled = 0usize;
        while filled < want {
            let n = file
                .read(&mut buf[filled..])
                .map_err(|e| map_io_error(&e, "fs.read_text", path))?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        buf.truncate(filled);
    }

    // The window may be cut in a scalar. A malformed sequence is a file-level
    // invalid_utf8 error; an unfinished final scalar is simply outside this
    // window and is excluded until a larger window is requested.
    let valid_len = valid_utf8_prefix_len(&buf, path)?;
    buf.truncate(valid_len);
    let valid = std::str::from_utf8(&buf).expect("valid_utf8_prefix_len validated prefix");
    let preview_len = utf8_prefix_within_budget(valid, requested, path)?;
    buf.truncate(preview_len);
    let content = String::from_utf8(buf).map_err(|_| {
        ToolError::new(
            ToolErrorCode::InvalidUtf8,
            "fs.read_text",
            "window is not valid UTF-8 after boundary truncation",
        )
        .with_path(path.to_string_lossy())
    })?;

    let returned_bytes = content.len() as u64;
    let returned_chars = content.chars().count() as u64;
    let end_offset = offset + returned_bytes;
    // max_bytes=0 is a metadata-only probe, not a resumable truncation. It
    // deliberately returns no same-offset token; callers can request a
    // positive budget from offset zero on the next call.
    let truncated = max_bytes > 0 && end_offset < total_bytes;

    // Determine sha256 + resume token.
    // PERF: only call sha256_file (streaming whole-file I/O pass) when actually
    // needed — for resume validation or for a truncated read's resume token.
    // For the common case (first read, not truncated, small file), hash the
    // content bytes already in memory (O(content), no extra I/O).  This was the
    // #1 dogfood performance blocker: every fs_read_text was doing a full-file
    // hash pass even for <1KB source files.
    let (sha256, next_resume) = if resume_preimage.is_some() || truncated || max_bytes == 0 {
        let preimage = match resume_preimage {
            Some(preimage) => preimage,
            None => sha256_open_file(file).map_err(|e| map_io_error(&e, "fs.read_text", path))?,
        };
        let resume = if truncated {
            Some(TextResume {
                offset_bytes: end_offset,
                preimage_sha256: preimage.clone(),
                line_range: None,
            })
        } else {
            None
        };
        (Some(preimage), resume)
    } else {
        // First read, not truncated: content bytes ARE the whole file from offset 0.
        (Some(sha256_hex(content.as_bytes())), None)
    };
    let newline_style = detect_newline_style(&content);
    // For a bounded window we report the lines present in the returned content
    // (NOT the whole file — ADR 0027 §6.1: total over the full file is only
    // reported when the whole file is scanned).
    let total_lines = content.lines().count() as u64;

    Ok(FsReadTextResult {
        content,
        total_lines,
        start_line: None,
        end_line: None,
        newline_style,
        sha256,
        returned_bytes: Some(returned_bytes),
        returned_chars: Some(returned_chars),
        total_bytes: Some(total_bytes),
        truncated,
        next_resume,
        range_start_bytes: None,
        range_end_bytes: None,
    })
}

/// Return the valid UTF-8 prefix of a read buffer. An incomplete trailing
/// scalar is expected at a bounded-read seam; any other malformed sequence is
/// an invalid_utf8 error for the text tool.
fn valid_utf8_prefix_len(buf: &[u8], path: &std::path::Path) -> Result<usize, ToolError> {
    match std::str::from_utf8(buf) {
        Ok(_) => Ok(buf.len()),
        Err(error) if error.error_len().is_none() => Ok(error.valid_up_to()),
        Err(_) => Err(ToolError::new(
            ToolErrorCode::InvalidUtf8,
            "fs.read_text",
            "file content is not valid UTF-8",
        )
        .with_path(path.to_string_lossy())),
    }
}

/// Return the largest UTF-8 prefix that fits inside `budget` raw bytes. A
/// positive budget smaller than the next complete scalar is rejected instead
/// of returning an empty window with an unchanged resume offset or exceeding
/// the protocol's byte budget.
fn utf8_prefix_within_budget(
    text: &str,
    budget: u64,
    path: &std::path::Path,
) -> Result<usize, ToolError> {
    if budget == 0 || text.is_empty() {
        return Ok(0);
    }
    let mut end = 0usize;
    for (start, scalar) in text.char_indices() {
        let scalar_end = start + scalar.len_utf8();
        if scalar_end as u64 > budget {
            if end == 0 {
                return Err(ToolError::new(
                    ToolErrorCode::InvalidInput,
                    "fs.read_text",
                    "max_bytes is smaller than the next complete UTF-8 scalar",
                )
                .with_path(path.to_string_lossy())
                .with_details(serde_json::json!({
                    "reason": "text_window_too_small",
                    "minimum_next_window_bytes": scalar.len_utf8(),
                })));
            }
            break;
        }
        end = scalar_end;
    }
    Ok(end)
}

/// `lf`, `crlf`, `cr`, `mixed`, or `none`.
fn detect_newline_style(s: &str) -> String {
    // Count standalone LF (not preceded by CR) and CRLF and standalone CR.
    let bytes = s.as_bytes();
    let mut crlf = 0usize;
    let mut lf_only = 0usize;
    let mut cr_only = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    crlf += 1;
                    i += 2;
                    continue;
                }
                cr_only += 1;
            }
            b'\n' => lf_only += 1,
            _ => {}
        }
        i += 1;
    }
    if crlf == 0 && lf_only == 0 && cr_only == 0 {
        "none".to_string()
    } else if lf_only > 0 && crlf == 0 && cr_only == 0 {
        "lf".to_string()
    } else if crlf > 0 && lf_only == 0 && cr_only == 0 {
        "crlf".to_string()
    } else if cr_only > 0 && crlf == 0 && lf_only == 0 {
        "cr".to_string()
    } else {
        "mixed".to_string()
    }
}

/// Return byte spans for logical lines while retaining each line terminator in
/// its span. `str::lines()` drops CRLF/LF, which is suitable for display but
/// not for a byte-preserving file window.
fn line_spans(content: &str) -> Vec<(usize, usize)> {
    let bytes = content.as_bytes();
    let mut spans = Vec::new();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                spans.push((start, i + 1));
                i += 1;
                start = i;
            }
            b'\r' => {
                let end = if bytes.get(i + 1) == Some(&b'\n') {
                    i + 2
                } else {
                    i + 1
                };
                spans.push((start, end));
                i = end;
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < bytes.len() {
        spans.push((start, bytes.len()));
    }
    spans
}

fn resolve_line_range(
    spans: &[(usize, usize)],
    start: Option<u32>,
    end: Option<u32>,
    path: &std::path::Path,
) -> Result<(TextLineRange, usize, usize), ToolError> {
    let requested_start = start.unwrap_or(1).max(1);
    let requested_end = end.unwrap_or_else(|| spans.len().min(u32::MAX as usize) as u32);
    if end.is_some_and(|value| value > 0 && value < requested_start) {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_text",
            "end_line must be greater than or equal to start_line",
        )
        .with_path(path.to_string_lossy())
        .with_details(serde_json::json!({"reason": "line_range_invalid"})));
    }
    if spans.is_empty() {
        return Ok((
            TextLineRange {
                start_line: requested_start,
                end_line: 0,
            },
            0,
            0,
        ));
    }
    if requested_start as usize > spans.len() {
        let eof = spans.last().map(|(_, end)| *end).unwrap_or(0);
        return Ok((
            TextLineRange {
                start_line: requested_start,
                end_line: spans.len().min(u32::MAX as usize) as u32,
            },
            eof,
            eof,
        ));
    }
    let start_index = requested_start.saturating_sub(1) as usize;
    let end_line = requested_end.min(spans.len() as u32);
    let end_index = end_line as usize;
    let range_start = spans
        .get(start_index)
        .map(|(start, _)| *start)
        .unwrap_or_else(|| spans.last().map(|(_, end)| *end).unwrap_or(0));
    let range_end = if end_index > 0 {
        spans
            .get(end_index.saturating_sub(1))
            .map(|(_, end)| *end)
            .unwrap_or(range_start)
    } else {
        range_start
    };
    Ok((
        TextLineRange {
            start_line: requested_start,
            end_line,
        },
        range_start.min(range_end),
        range_end.max(range_start),
    ))
}

// ---------------------------------------------------------------------------
// fs_read_bytes
// ---------------------------------------------------------------------------

/// Typed resume token for `fs_read_bytes` (ADR 0027 §5.2/§6.2). Bound to
/// `fs_read_bytes` only. On resume the toolkit re-hashes the file; a mismatch
/// (file replaced/truncated/grown) returns `conflict` instead of silently
/// reading a different file version.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub struct ByteResume {
    /// Byte offset where the next window starts.
    pub offset_bytes: u64,
    /// Whole-file SHA-256 (lowercased hex) captured when the resume was issued.
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsReadBytesRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<u64>,
    #[serde(default)]
    pub include_sha256: bool,
    /// Resume a previous length-bounded read (ADR 0027 §6.2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<ByteResume>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsReadBytesResult {
    /// base64-encoded bytes.
    pub base64: String,
    pub offset: u64,
    pub length: u64,
    pub total_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    /// True when the returned window is smaller than the remaining file content
    /// (ADR 0027 §6.2).
    #[serde(default)]
    pub truncated: bool,
    /// Resume token for the next window (present iff `truncated`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_resume: Option<ByteResume>,
}

pub fn read_bytes(
    ctx: &InvocationContext,
    req: &FsReadBytesRequest,
) -> Result<FsReadBytesResult, ToolError> {
    use base64::Engine;
    let path = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::Read,
        "fs.read_bytes",
    )?;
    let mut file =
        std::fs::File::open(&path).map_err(|e| map_io_error(&e, "fs.read_bytes", &path))?;
    let meta = file
        .metadata()
        .map_err(|e| map_io_error(&e, "fs.read_bytes", &path))?;
    if meta.is_dir() {
        return Err(ToolError::new(
            ToolErrorCode::IsDirectory,
            "fs.read_bytes",
            "fs_read_bytes target is a directory",
        )
        .with_path(path.to_string_lossy()));
    }
    let total = meta.len();

    // A bounded read is one with an explicit `length` OR an active resume. A
    // full read (no length, no resume) returns the whole file from `offset`.
    let bounded = req.length.is_some() || req.resume.is_some();

    // Compute the whole-file hash once: needed for resume validation and/or
    // reported on bounded reads (ADR 0027 §6.2). On a full read without
    // include_sha256 we skip the hash pass entirely (zero regression).
    let need_hash = bounded || req.include_sha256;
    let file_hash = if need_hash {
        Some(sha256_open_file(&mut file).map_err(|e| map_io_error(&e, "fs.read_bytes", &path))?)
    } else {
        None
    };

    // Resolve offset: a resume token's offset wins; otherwise the request offset.
    let offset = match &req.resume {
        Some(r) => {
            let actual = file_hash.as_ref().expect("hash computed for resume");
            if r.sha256 != *actual {
                return Err(ToolError::new(
                    ToolErrorCode::Conflict,
                    "fs.read_bytes",
                    "resume rejected: file changed since the previous window \
                     (hash mismatch); re-read from the start",
                )
                .with_path(path.to_string_lossy())
                .with_details(serde_json::json!({
                    "reason": "resume_hash_mismatch",
                    "expected_sha256": r.sha256,
                    "actual_sha256": *actual,
                })));
            }
            r.offset_bytes
        }
        None => req.offset.unwrap_or(0),
    };
    if offset > total {
        return Err(ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_bytes",
            format!("offset {offset} exceeds file size {total}"),
        )
        .with_path(path.to_string_lossy()));
    }

    // Window end: saturating_add prevents offset+length overflow on hostile
    // requests; `.min(total)` preserves "read up to EOF".
    let end = match req.length {
        Some(len) => offset.saturating_add(len).min(total),
        None => total,
    };
    let want = usize::try_from(end - offset).map_err(|_| {
        ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.read_bytes",
            "requested byte window is too large for this platform",
        )
        .with_path(path.to_string_lossy())
    })?;

    // Read the window via seek (do not cache the whole file).
    let mut buf = vec![0u8; want];
    if want > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| map_io_error(&e, "fs.read_bytes", &path))?;
        let mut filled = 0usize;
        while filled < want {
            let n = file
                .read(&mut buf[filled..])
                .map_err(|e| map_io_error(&e, "fs.read_bytes", &path))?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        buf.truncate(filled);
    }
    let returned = buf.len() as u64;
    let end_offset = offset + returned;
    let metadata_only = req.length == Some(0);
    let truncated = !metadata_only && end_offset < total;
    let next_resume = if truncated {
        Some(ByteResume {
            offset_bytes: end_offset,
            sha256: file_hash.clone().unwrap_or_default(),
        })
    } else {
        None
    };

    Ok(FsReadBytesResult {
        base64: base64::engine::general_purpose::STANDARD.encode(&buf),
        offset,
        length: returned,
        total_bytes: total,
        sha256: file_hash,
        truncated,
        next_resume,
    })
}

// ---------------------------------------------------------------------------
// fs_hash
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsHashRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    /// MVP only promises sha256 (plan §7.2).
    #[serde(default = "default_algo")]
    pub algorithm: String,
}

fn default_algo() -> String {
    "sha256".to_string()
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsHashResult {
    pub algorithm: String,
    pub digest: String,
    pub bytes: u64,
}

pub fn fs_hash(ctx: &InvocationContext, req: &FsHashRequest) -> Result<FsHashResult, ToolError> {
    if req.algorithm != "sha256" {
        return Err(ToolError::new(
            ToolErrorCode::Unsupported,
            "fs.hash",
            format!(
                "unsupported hash algorithm `{}`; only sha256 is supported",
                req.algorithm
            ),
        ));
    }
    let path = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::Read,
        "fs.hash",
    )?;
    let bytes = std::fs::read(&path).map_err(|e| map_io_error(&e, "fs.hash", &path))?;
    Ok(FsHashResult {
        algorithm: "sha256".to_string(),
        digest: sha256_hex(&bytes),
        bytes: bytes.len() as u64,
    })
}
