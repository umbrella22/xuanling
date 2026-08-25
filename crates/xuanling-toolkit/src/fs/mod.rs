//! Filesystem typed tools (plan §7.2).
//!
//! W2 implements the full filesystem catalog using Rust std / `ignore` /
//! `walkdir` / `regex` APIs — no shell (`grep`/`find`/`sed`/`cp`/`mv`/`rm`).
//!
//! Key invariants (plan §4.2, §13):
//! - No hidden truncation: read/list/search return everything when no
//!   `limit`/range is requested; cursors only appear when the caller asks for a
//!   range/limit.
//! - The raw toolkit remains unrestricted by default. Deployments may attach
//!   a workspace filesystem capability to an [`InvocationContext`]; every
//!   resolved operation path is then checked against that capability.
//! - Writes use a temp file in the same directory + atomic replace.
//! - Cancellation is observed at iteration boundaries in long traversals.

pub mod change;
pub mod copy_move_remove;
pub mod read;
pub mod search;
pub mod stat_list;
pub mod write;

pub use change::{
    AppliedMultiChange, ChangeSetState, MultiFileChange, apply_multi as changeset_apply_multi,
    commit as changeset_commit, commit_with_context as changeset_commit_with_context,
    rollback as changeset_rollback, rollback_with_context as changeset_rollback_with_context,
};
pub use read::{
    ByteResume, FsHashRequest, FsHashResult, FsReadBytesRequest, FsReadBytesResult,
    FsReadTextRequest, FsReadTextResult, TextResume, fs_hash, read_bytes, read_text,
};
pub use search::{
    FsGlobRequest, FsGlobResult, FsSearchOptions, FsSearchRequest, FsSearchResult, SearchMatch,
    SearchOccurrence, glob, search, search_with_options,
};
pub use stat_list::{
    DirEntry, EntryKind, FsListRequest, FsListResult, FsStatRequest, FsStatResult, fs_list, fs_stat,
};
pub use write::{
    FsEditRequest, FsEditResult, FsMkdirRequest, FsMkdirResult, FsPatchRequest, FsPatchResult,
    FsReplaceTextRequest, FsReplaceTextResult, FsWriteTextRequest, FsWriteTextResult,
    MatchLocation, NewlineMode, WriteMode, fs_edit, fs_mkdir, fs_patch, fs_replace_text,
    fs_write_text,
};
// re-export copy/move/remove
pub use copy_move_remove::{
    FsCopyRequest, FsCopyResult, FsMoveRequest, FsMoveResult, FsRemoveRequest, FsRemoveResult,
    fs_copy, fs_move, fs_remove,
};

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use crate::capability::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;

/// Serialize guarded filesystem mutations inside one toolkit process.
///
/// `expected_sha256` is a preimage contract. Holding this lock from the
/// preimage read through the atomic replacement makes that contract linear
/// for concurrent MCP calls sharing the server. It does not coordinate with
/// unrelated processes that write the same path outside this toolkit.
fn mutation_lock_cell() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) fn mutation_lock() -> MutexGuard<'static, ()> {
    mutation_lock_cell()
        .lock()
        .expect("filesystem mutation lock poisoned")
}

/// Resolve `req.path` (with optional per-request `base_dir`) against the
/// invocation's [`crate::PathContext`], then validate the resolved locator for
/// the operation's requested access. The default scope is unrestricted;
/// workspace-contained invocations reject paths outside their capability.
pub(crate) fn resolve_path(
    ctx: &InvocationContext,
    path: &str,
    base_dir: Option<&str>,
    access: PathAccess,
    operation: &str,
) -> Result<PathBuf, ToolError> {
    ctx.resolve_path(Path::new(path), base_dir.map(Path::new), access, operation)
}

/// Map a std `io::Error` to a typed `ToolError`, distinguishing NotFound /
/// PermissionDenied / IsADirectory / NotADirectory where the kind is
/// detectable.
pub(crate) fn map_io_error(e: &std::io::Error, operation: &str, path: &Path) -> ToolError {
    use std::io::ErrorKind;
    let code = match e.kind() {
        ErrorKind::NotFound => ToolErrorCode::NotFound,
        ErrorKind::PermissionDenied => ToolErrorCode::PermissionDenied,
        ErrorKind::AlreadyExists => ToolErrorCode::AlreadyExists,
        _ if e.raw_os_error() == Some(21) => ToolErrorCode::IsDirectory, // EISDIR
        _ if e.raw_os_error() == Some(20) => ToolErrorCode::NotDirectory, // ENOTDIR
        _ => ToolErrorCode::IoError,
    };
    ToolError::new(code, operation, e.to_string())
        .with_path(path.to_string_lossy())
        .with_raw_os_error(e.raw_os_error())
}

/// SHA-256 of a byte slice, lowercased hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    hex_lower(&digest)
}

/// Streaming SHA-256 of an already-open file's full contents (lowercased hex).
/// Using the same handle for metadata, window bytes and hashing prevents an
/// atomic path replacement from mixing two file instances in one result.
pub(crate) fn sha256_open_file(file: &mut std::fs::File) -> Result<String, std::io::Error> {
    use sha2::{Digest, Sha256};
    use std::io::{Read as _, Seek as _, SeekFrom};
    let mut hasher = Sha256::new();
    file.seek(SeekFrom::Start(0))?;
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// Alias kept for callers that imported the old `pub(crate)` name.
pub fn sha256_hex_pub(bytes: &[u8]) -> String {
    sha256_hex(bytes)
}

/// Atomic write (temp file in same dir + fsync + rename). Re-exported for
/// cross-module callers (e.g. ChangeSet rollback restores before-bytes).
pub fn atomic_write_file(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    let tmp = dir.join(format!(".xuanling-tmp-{}", uuid::Uuid::now_v7().simple()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, target).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })?;
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(hex_nibble(b >> 4));
        s.push(hex_nibble(b & 0x0f));
    }
    s
}

fn hex_nibble(n: u8) -> char {
    if n < 10 {
        (b'0' + n) as char
    } else {
        (b'a' + (n - 10)) as char
    }
}

// --- tagged + query-fingerprinted cursors (ADR 0027 §3, plan §6.3) ---------
// A cursor is opaque base64 carrying: a tool tag + a 64-bit query fingerprint
// + a u64 position. The tag makes a cursor from one tool (e.g. `fs_search`)
// invalid for another (e.g. `fs_list`). The fingerprint (hash of the query
// params + root) makes a cursor from a *different* query invalid, so resuming
// with a stale cursor returns a typed `invalid_cursor` error instead of
// silently returning a different result page (ADR 0027 §3, plan §3.1.3/§6.3).
// A present cursor that fails to decode (wrong tag/fingerprint/corrupt length)
// is an error, NOT a silent fallback to position 0.

/// Encode a tool-tagged, query-fingerprinted position cursor.
pub(crate) fn encode_cursor(tag: &[u8], fingerprint: u64, count: u64) -> String {
    use base64::Engine;
    let mut payload = Vec::with_capacity(tag.len() + 16);
    payload.extend_from_slice(tag);
    payload.extend_from_slice(&fingerprint.to_le_bytes());
    payload.extend_from_slice(&count.to_le_bytes());
    base64::engine::general_purpose::STANDARD.encode(&payload)
}

/// Outcome of decoding a cursor for a given tool tag + query fingerprint.
pub(crate) enum CursorDecode {
    /// No cursor supplied: start from the beginning.
    Absent,
    /// Cursor decoded, and its embedded tag + fingerprint matched this tool/query.
    Position(u64),
}

/// Decode a cursor for `tag` + expected `fingerprint`:
/// - `Absent` when no cursor was supplied;
/// - `Position(n)` when the cursor decodes and its tag AND fingerprint match;
/// - `Err` when the cursor is present but corrupt, tagged for a different tool,
///   or bound to a different query (ADR 0027 §3, plan §6.3).
pub(crate) fn decode_cursor(
    cursor: Option<&str>,
    tag: &[u8],
    fingerprint: u64,
) -> Result<CursorDecode, ToolError> {
    use base64::Engine;
    let Some(raw) = cursor else {
        return Ok(CursorDecode::Absent);
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw)
        .map_err(|_| invalid_cursor("cursor is not valid base64"))?;
    let expected_len = tag.len() + 16;
    if bytes.len() != expected_len {
        return Err(invalid_cursor("cursor has the wrong length for this tool"));
    }
    let (tag_part, rest) = bytes.split_at(tag.len());
    if tag_part != tag {
        return Err(invalid_cursor("cursor belongs to a different tool"));
    }
    let (fp_part, count_part) = rest.split_at(8);
    let cursor_fp = u64::from_le_bytes(
        fp_part
            .try_into()
            .map_err(|_| invalid_cursor("cursor fingerprint bytes are malformed"))?,
    );
    if cursor_fp != fingerprint {
        return Err(invalid_cursor(
            "cursor belongs to a different query (pattern/options/root changed)",
        ));
    }
    let count = u64::from_le_bytes(
        count_part
            .try_into()
            .map_err(|_| invalid_cursor("cursor position bytes are malformed"))?,
    );
    Ok(CursorDecode::Position(count))
}

/// Deterministic 64-bit FNV-1a hash over `bytes`. Used to fingerprint the query
/// params + root that determine a search/list/glob result set, so a cursor is
/// bound to the query that produced it (no extra dependency, stable within a
/// process and across builds).
pub(crate) fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn invalid_cursor(reason: &str) -> ToolError {
    ToolError::new(
        ToolErrorCode::InvalidInput,
        "fs.cursor",
        format!(
            "invalid cursor: {reason}; the cursor is bound to a specific tool \
             and query, request a fresh first page instead of reusing a stale \
             one (ADR 0027 §3)"
        ),
    )
    .with_details(serde_json::json!({"reason": "invalid_cursor"}))
}
