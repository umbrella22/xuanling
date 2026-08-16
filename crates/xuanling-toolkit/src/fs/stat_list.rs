//! `fs_stat` and `fs_list` (plan §7.2).

use std::collections::HashMap;
use std::path::Path;
#[cfg(not(unix))]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{map_io_error, resolve_path};
use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;

/// `fs_stat` request.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsStatRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    /// When true, resolve symlinks before stat (follow). Default false returns
    /// the symlink entry itself.
    #[serde(default)]
    pub follow_symlinks: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsStatResult {
    pub path: String,
    pub absolute_path: String,
    pub kind: EntryKind,
    pub size: u64,
    pub readonly: bool,
    /// RFC3339 timestamps; `null` when unavailable on the platform.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accessed: Option<String>,
    /// Symlink target (display form), only when the entry is a symlink.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[schemars(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Directory,
    Symlink,
    Other,
}

pub fn fs_stat(ctx: &InvocationContext, req: &FsStatRequest) -> Result<FsStatResult, ToolError> {
    let access = if req.follow_symlinks {
        PathAccess::Read
    } else {
        PathAccess::ReadEntry
    };
    let path = resolve_path(ctx, &req.path, req.base_dir.as_deref(), access, "fs.stat")?;
    let meta = if req.follow_symlinks {
        std::fs::metadata(&path).map_err(|e| map_io_error(&e, "fs.stat", &path))?
    } else {
        std::fs::symlink_metadata(&path).map_err(|e| map_io_error(&e, "fs.stat", &path))?
    };

    let kind = if meta.file_type().is_symlink() {
        EntryKind::Symlink
    } else if meta.is_dir() {
        EntryKind::Directory
    } else if meta.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    };

    let symlink_target = if meta.file_type().is_symlink() {
        std::fs::read_link(&path)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };

    let absolute_path = if req.follow_symlinks {
        match std::fs::canonicalize(&path) {
            Ok(c) => c.to_string_lossy().into_owned(),
            Err(_) => path.to_string_lossy().into_owned(),
        }
    } else {
        path.to_string_lossy().into_owned()
    };

    Ok(FsStatResult {
        path: path.to_string_lossy().into_owned(),
        absolute_path,
        kind,
        size: meta.len(),
        readonly: meta.permissions().readonly(),
        modified: system_time_rfc3339(meta.modified()),
        created: system_time_rfc3339(meta.created()),
        accessed: system_time_rfc3339(meta.accessed()),
        symlink_target,
    })
}

fn system_time_rfc3339(t: std::io::Result<std::time::SystemTime>) -> Option<String> {
    let t = t.ok()?;
    let dt = time::OffsetDateTime::from(t);
    dt.format(&time::format_description::well_known::Rfc3339)
        .ok()
}

// ---------------------------------------------------------------------------
// fs_list
// ---------------------------------------------------------------------------

/// `fs_list` request (plan §7.2).
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsListRequest {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_dir: Option<String>,
    #[serde(default)]
    pub recursive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub respect_gitignore: bool,
    #[serde(default)]
    pub follow_symlinks: bool,
    /// Optional byte budget for serialized `entries` items. This budgets the
    /// variable result collection, not the fixed result envelope. `0` is a
    /// metadata-only page. Raw toolkit callers omit it for complete behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DirEntry {
    pub path: String,
    pub kind: EntryKind,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symlink_target: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsListResult {
    pub entries: Vec<DirEntry>,
    /// Only present when the caller requested a `limit` and more remain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Canonical JSON bytes occupied by returned `entries` items.
    pub returned_item_bytes: u64,
    /// True when either the item-count limit or byte budget left more entries.
    pub has_more: bool,
}

// --- Phase 2 snapshot cursors (ADR 0027 §6.3) ------------------------------
// When `fs_list` is called with a `limit`, the first page materializes the full
// sorted entry list into a short-lived in-process snapshot, and the cursor
// references (snapshot_id, position). Subsequent pages read from the snapshot,
// so they are STABLE across directory mutation (a file added/removed mid-walk
// does not shift later pages). Snapshots have a TTL, a process-wide cap, and a
// typed expiry/eviction error. They do not survive server restart (plan §9.2).

const LIST_SNAP_TAG: &[u8] = b"listsnap";

struct ListSnapshot {
    fingerprint: u64,
    entries: Vec<DirEntry>,
    created_at: Instant,
}

/// Default snapshot TTL (5 min). Overridable for tests via the
/// `XUANLING_LIST_SNAPSHOT_TTL_MS` env var (read on each call so a subprocess
/// inherits the test's value).
const DEFAULT_SNAPSHOT_TTL: Duration = Duration::from_secs(300);
/// Process-wide cap on live snapshots; inserting beyond this evicts the oldest.
const MAX_SNAPSHOTS: usize = 256;

fn snapshot_ttl() -> Duration {
    if let Some(v) = std::env::var("XUANLING_LIST_SNAPSHOT_TTL_MS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
    {
        Duration::from_millis(v)
    } else {
        DEFAULT_SNAPSHOT_TTL
    }
}

fn list_snapshots() -> &'static Mutex<HashMap<u64, ListSnapshot>> {
    static STORE: OnceLock<Mutex<HashMap<u64, ListSnapshot>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_snapshot_id() -> u64 {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn encode_list_snapshot_cursor(snapshot_id: u64, position: u64) -> String {
    use base64::Engine;
    let mut p = Vec::with_capacity(LIST_SNAP_TAG.len() + 16);
    p.extend_from_slice(LIST_SNAP_TAG);
    p.extend_from_slice(&snapshot_id.to_le_bytes());
    p.extend_from_slice(&position.to_le_bytes());
    base64::engine::general_purpose::STANDARD.encode(&p)
}

/// Decode a list-snapshot cursor. Returns `None` if the string is not a valid
/// list-snapshot cursor (wrong tag/length/base64); the caller treats that as an
/// invalid cursor (cross-tool / corrupt).
fn decode_list_snapshot_cursor(cursor: &str) -> Option<(u64, u64)> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(cursor)
        .ok()?;
    if bytes.len() != LIST_SNAP_TAG.len() + 16 {
        return None;
    }
    let (tag, rest) = bytes.split_at(LIST_SNAP_TAG.len());
    if tag != LIST_SNAP_TAG {
        return None;
    }
    let (id_b, pos_b) = rest.split_at(8);
    let id = u64::from_le_bytes(id_b.try_into().ok()?);
    let pos = u64::from_le_bytes(pos_b.try_into().ok()?);
    Some((id, pos))
}

/// Drop expired snapshots and enforce the cap (evict oldest). Called under the
/// store lock on insert and lookup.
fn evict_expired(store: &mut HashMap<u64, ListSnapshot>) {
    let ttl = snapshot_ttl();
    store.retain(|_, s| s.created_at.elapsed() < ttl);
    while store.len() > MAX_SNAPSHOTS {
        // Evict the oldest by created_at.
        if let Some((&oldest_id, _)) = store.iter().min_by_key(|(_, s)| s.created_at) {
            store.remove(&oldest_id);
        } else {
            break;
        }
    }
}

pub fn fs_list(ctx: &InvocationContext, req: &FsListRequest) -> Result<FsListResult, ToolError> {
    let root = resolve_path(
        ctx,
        &req.path,
        req.base_dir.as_deref(),
        PathAccess::Read,
        "fs.list",
    )?;
    let meta = std::fs::metadata(&root).map_err(|e| map_io_error(&e, "fs.list", &root))?;
    if !meta.is_dir() {
        return Err(ToolError::new(
            ToolErrorCode::NotDirectory,
            "fs.list",
            "fs_list path is not a directory",
        )
        .with_path(root.to_string_lossy()));
    }

    // Query fingerprint: binds the snapshot to the query identity (options +
    // root), NOT the page size, so a cursor is rejected when the underlying
    // query changes (ADR 0027 §3, plan §6.3). `limit` is a paging param.
    let fingerprint = super::fnv1a_64(
        format!(
            "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}\u{0}{}",
            req.recursive,
            req.max_depth.map(|d| d.to_string()).unwrap_or_default(),
            req.include_hidden,
            req.respect_gitignore,
            req.follow_symlinks,
            root.display()
        )
        .as_bytes(),
    );
    let limit = req.limit;

    // Snapshot resume (ADR 0027 §6.3 Phase 2): when a cursor is present, serve
    // the page from the stored snapshot instead of re-walking, so pages are
    // STABLE across directory mutation. The snapshot is validated against the
    // current query fingerprint and TTL.
    if let Some(cursor_str) = req.cursor.as_deref() {
        return list_resume(cursor_str, fingerprint, limit, req.max_output_bytes);
    }

    // First page: materialize + sort the full entry list.
    let mut entries = collect_entries(ctx, req, &root)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    if limit.is_some() || req.max_output_bytes.is_some() {
        // Build the page before allocating snapshot state. Metadata-only,
        // already-complete, and too-small first windows produce no usable
        // continuation, so storing their entry vectors would make them
        // unreachable until TTL eviction.
        let mut result = build_list_page(&entries, None, 0, limit, req.max_output_bytes)?;
        if result.has_more && !result.entries.is_empty() {
            let position = result.entries.len() as u64;
            let snapshot_id = store_snapshot(fingerprint, entries);
            result.next_cursor = Some(encode_list_snapshot_cursor(snapshot_id, position));
        }
        Ok(result)
    } else {
        // No limit: return everything (plan §4.2); no snapshot needed.
        let returned_item_bytes = serialized_items_bytes(&entries)?;
        Ok(FsListResult {
            entries,
            next_cursor: None,
            returned_item_bytes,
            has_more: false,
        })
    }
}

/// Walk the directory according to the request options and collect entries
/// (plan §7.2). Extracted so the snapshot resume path can skip re-walking.
fn collect_entries(
    ctx: &InvocationContext,
    req: &FsListRequest,
    root: &Path,
) -> Result<Vec<DirEntry>, ToolError> {
    let collect_entry = |p: &Path, ft: std::fs::FileType| -> DirEntry {
        let kind = if ft.is_symlink() {
            EntryKind::Symlink
        } else if ft.is_dir() {
            EntryKind::Directory
        } else if ft.is_file() {
            EntryKind::File
        } else {
            EntryKind::Other
        };
        let symlink_target = if ft.is_symlink() {
            std::fs::read_link(p)
                .ok()
                .map(|t| t.to_string_lossy().into_owned())
        } else {
            None
        };
        let size = std::fs::symlink_metadata(p).map(|m| m.len()).unwrap_or(0);
        DirEntry {
            path: p.to_string_lossy().into_owned(),
            kind,
            size,
            symlink_target,
        }
    };

    // Workspace mode uses a capability-aware traversal that never asks a
    // generic walker to follow a symlink before its target has been checked.
    // Unrestricted mode retains the established ignore/walkdir behavior.
    if ctx.filesystem_scope().is_contained() {
        return collect_entries_contained(ctx, req, root, &collect_entry);
    }

    let mut entries: Vec<DirEntry> = Vec::new();
    if req.respect_gitignore {
        let mut builder = ignore::WalkBuilder::new(root);
        builder
            .hidden(!req.include_hidden)
            .git_ignore(true)
            .require_git(false)
            .follow_links(req.follow_symlinks);
        if let Some(d) = req.max_depth {
            builder.max_depth(Some(d as usize));
        }
        let walker = builder.build();
        for result in walker {
            if ctx.cancellation().is_cancelled() {
                return Err(cancelled());
            }
            let dent = match result {
                Ok(d) => d,
                Err(_) => continue,
            };
            if dent.path() == root {
                continue;
            }
            if !req.recursive && dent.depth() > 1 {
                continue;
            }
            if let Some(ft) = dent.file_type() {
                entries.push(collect_entry(dent.path(), ft));
            }
        }
    } else {
        let max_depth = if req.recursive {
            req.max_depth.map(|d| d as usize).unwrap_or(usize::MAX)
        } else {
            1
        };
        for result in walkdir::WalkDir::new(root)
            .max_depth(max_depth)
            .follow_links(req.follow_symlinks)
            .into_iter()
            .filter_entry(|e| {
                // Never prune the root itself (its name may start with '.', e.g.
                // a tempfile `.tmpXXXXXX` dir); only filter hidden CHILDREN.
                if e.depth() == 0 {
                    return true;
                }
                e.file_name()
                    .to_str()
                    .map(|name| req.include_hidden || !name.starts_with('.'))
                    .unwrap_or(true)
            })
        {
            if ctx.cancellation().is_cancelled() {
                return Err(cancelled());
            }
            let dent = match result {
                Ok(d) => d,
                Err(_) => continue,
            };
            if dent.path() == root {
                continue;
            }
            entries.push(collect_entry(dent.path(), dent.file_type()));
        }
    }
    Ok(entries)
}

/// Capability-aware directory traversal for contained mode.
///
/// `walkdir` and `ignore` follow a link before their public filtering hooks
/// run. This traversal reads only the containing directory first, validates a
/// symlink's target, and calls `read_dir` on it only after that target remains
/// inside the configured workspace. Identity tracking also prevents symlink
/// loops without relying on pathname spelling.
fn collect_entries_contained<F>(
    ctx: &InvocationContext,
    req: &FsListRequest,
    root: &Path,
    collect_entry: &F,
) -> Result<Vec<DirEntry>, ToolError>
where
    F: Fn(&Path, std::fs::FileType) -> DirEntry,
{
    use std::collections::HashSet;

    let mut entries = Vec::new();
    // Stack entries carry the ignore rules inherited from parent
    // directories. Rules declared by the current directory are loaded only
    // after it becomes a validated traversal work item.
    let mut root_ancestors = HashSet::new();
    let root_identity =
        directory_identity(root).map_err(|error| map_io_error(&error, "fs.list", root))?;
    root_ancestors.insert(root_identity);
    let mut stack = vec![(
        root.to_path_buf(),
        0_usize,
        ContainedIgnoreState::default(),
        root_ancestors,
    )];
    let max_depth = if req.recursive {
        req.max_depth
            .map(|depth| depth as usize)
            .unwrap_or(usize::MAX)
    } else {
        1
    };

    while let Some((directory, depth, parent_ignores, ancestors)) = stack.pop() {
        if ctx.cancellation().is_cancelled() {
            return Err(cancelled());
        }
        if depth >= max_depth {
            continue;
        }

        let ignores = if req.respect_gitignore {
            parent_ignores.with_directory(ctx, &directory)?
        } else {
            parent_ignores
        };

        record_contained_directory_open(&directory);
        let read_dir = std::fs::read_dir(&directory)
            .map_err(|error| map_io_error(&error, "fs.list", &directory))?;
        for item in read_dir {
            if ctx.cancellation().is_cancelled() {
                return Err(cancelled());
            }
            let item = match item {
                Ok(item) => item,
                Err(_) => continue,
            };
            let path = item.path();
            let entry_metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let entry_type = entry_metadata.file_type();

            let effective_type = if entry_type.is_symlink() && req.follow_symlinks {
                if !ctx
                    .filesystem_scope()
                    .permits_directory_descent(&path, "fs.list")?
                {
                    continue;
                }
                // The capability check above resolves the target first. Do
                // not move this metadata call before it: following even a
                // metadata query through an external link is outside this
                // traversal's authority.
                let target_metadata = match std::fs::metadata(&path) {
                    Ok(metadata) => metadata,
                    Err(_) => continue,
                };
                target_metadata.file_type()
            } else {
                entry_type
            };

            let ignore_decision = req
                .respect_gitignore
                .then(|| ignores.decision(&path, effective_type.is_dir()))
                .flatten();
            if ignore_decision == Some(true) {
                continue;
            }
            // Match `ignore::WalkBuilder`: an explicit whitelist can make a
            // hidden path visible even when hidden entries are otherwise
            // filtered.
            if !req.include_hidden
                && ignore_decision != Some(false)
                && item
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with('.'))
            {
                continue;
            }

            entries.push(collect_entry(&path, effective_type));
            if effective_type.is_dir() && depth.saturating_add(1) < max_depth {
                let identity = directory_identity(&path)
                    .map_err(|error| map_io_error(&error, "fs.list", &path))?;
                if !ancestors.contains(&identity) {
                    let mut child_ancestors = ancestors.clone();
                    child_ancestors.insert(identity);
                    stack.push((
                        path,
                        depth.saturating_add(1),
                        ignores.clone(),
                        child_ancestors,
                    ));
                }
            }
        }
    }
    Ok(entries)
}

// Deterministic traversal oracle used by integration tests. It records the
// exact locator passed to `read_dir`, so containment tests can distinguish
// "the external subtree produced no rows" from the stronger property that
// the walker never attempted to open the linked directory at all.
#[cfg(feature = "test-fixtures")]
thread_local! {
    static CONTAINED_DIRECTORY_OPEN_LOG: std::cell::RefCell<Vec<std::path::PathBuf>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

#[cfg(feature = "test-fixtures")]
fn record_contained_directory_open(path: &Path) {
    CONTAINED_DIRECTORY_OPEN_LOG.with(|log| log.borrow_mut().push(path.to_path_buf()));
}

#[cfg(not(feature = "test-fixtures"))]
fn record_contained_directory_open(_path: &Path) {}

#[cfg(feature = "test-fixtures")]
#[doc(hidden)]
pub fn reset_contained_directory_open_log() {
    CONTAINED_DIRECTORY_OPEN_LOG.with(|log| log.borrow_mut().clear());
}

#[cfg(feature = "test-fixtures")]
#[doc(hidden)]
pub fn take_contained_directory_open_log() -> Vec<std::path::PathBuf> {
    CONTAINED_DIRECTORY_OPEN_LOG.with(|log| std::mem::take(&mut *log.borrow_mut()))
}

/// Workspace-local ignore matchers inherited by one contained traversal path.
///
/// The `ignore` crate gives `.ignore` rules precedence over `.gitignore`
/// rules, regardless of directory depth. Within either source kind, rules in
/// a closer directory win. Keep the two stacks separate so that ordering is
/// preserved rather than flattening both file types into one matcher.
#[derive(Clone, Default)]
struct ContainedIgnoreState {
    dot_ignore: Vec<ignore::gitignore::Gitignore>,
    git_ignore: Vec<ignore::gitignore::Gitignore>,
}

impl ContainedIgnoreState {
    /// Add only the current directory's local rules. We deliberately start at
    /// the requested list root instead of reading parent configuration: a
    /// valid root may be addressed through a lexical symlink alias, and an
    /// implicit parent scan could otherwise read configuration outside the
    /// workspace capability.
    fn with_directory(&self, ctx: &InvocationContext, directory: &Path) -> Result<Self, ToolError> {
        let mut next = self.clone();
        if let Some(matcher) = workspace_ignore_matcher(ctx, directory, ".ignore")? {
            next.dot_ignore.push(matcher);
        }
        if let Some(matcher) = workspace_ignore_matcher(ctx, directory, ".gitignore")? {
            next.git_ignore.push(matcher);
        }
        Ok(next)
    }

    /// `Some(true)` means ignored, `Some(false)` means explicitly
    /// whitelisted, and `None` means no local rule matched.
    fn decision(&self, path: &Path, is_dir: bool) -> Option<bool> {
        matcher_decision(&self.dot_ignore, path, is_dir)
            .or_else(|| matcher_decision(&self.git_ignore, path, is_dir))
    }
}

/// Build one local `.ignore` or `.gitignore` matcher without consulting Git
/// configuration or spawning a process. The optional configuration file is
/// itself an input read, so a linked file is admitted only after its target is
/// proven inside the workspace. A partially valid file contributes the rules
/// accepted by `ignore`; a matcher build failure leaves it inert.
fn workspace_ignore_matcher(
    ctx: &InvocationContext,
    directory: &Path,
    file_name: &str,
) -> Result<Option<ignore::gitignore::Gitignore>, ToolError> {
    let path = directory.join(file_name);
    match std::fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(map_io_error(&error, "fs.list", &path)),
    }
    match ctx
        .filesystem_scope()
        .permits_existing_read(&path, "fs.list")?
    {
        true => {}
        false => return Ok(None),
    }
    let metadata =
        std::fs::metadata(&path).map_err(|error| map_io_error(&error, "fs.list", &path))?;
    if !metadata.is_file() {
        return Ok(None);
    }

    let mut builder = ignore::gitignore::GitignoreBuilder::new(directory);
    let _ = builder.add(&path);
    Ok(builder.build().ok())
}

/// Return a concrete ignore/whitelist decision from the closest matcher of
/// one source kind. `None` means no rule of that kind matched.
fn matcher_decision(
    matchers: &[ignore::gitignore::Gitignore],
    path: &Path,
    is_dir: bool,
) -> Option<bool> {
    for matcher in matchers.iter().rev() {
        let matched = matcher.matched(path, is_dir);
        if matched.is_ignore() {
            return Some(true);
        }
        if matched.is_whitelist() {
            return Some(false);
        }
    }
    None
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum DirectoryIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(not(unix))]
    Canonical(PathBuf),
}

fn directory_identity(path: &Path) -> std::io::Result<DirectoryIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = std::fs::metadata(path)?;
        Ok(DirectoryIdentity::Unix {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        std::fs::canonicalize(path).map(DirectoryIdentity::Canonical)
    }
}

/// Store a snapshot, evicting expired/over-cap entries first. Returns the id.
fn store_snapshot(fingerprint: u64, entries: Vec<DirEntry>) -> u64 {
    let mut store = list_snapshots()
        .lock()
        .expect("snapshot store not poisoned");
    evict_expired(&mut store);
    while store.len() >= MAX_SNAPSHOTS {
        if let Some((&oldest_id, _)) = store.iter().min_by_key(|(_, snapshot)| snapshot.created_at)
        {
            store.remove(&oldest_id);
        } else {
            break;
        }
    }
    let id = next_snapshot_id();
    store.insert(
        id,
        ListSnapshot {
            fingerprint,
            entries,
            created_at: Instant::now(),
        },
    );
    id
}

/// Resume a bounded `fs_list` from a snapshot cursor. Validates the cursor
/// decodes as a list-snapshot, the snapshot still exists, is within TTL, and
/// matches the current query fingerprint; otherwise returns a typed error.
fn list_resume(
    cursor: &str,
    fingerprint: u64,
    limit: Option<u64>,
    max_output_bytes: Option<u64>,
) -> Result<FsListResult, ToolError> {
    let (id, position) = decode_list_snapshot_cursor(cursor).ok_or_else(|| {
        ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.list",
            "invalid cursor: not a valid fs_list snapshot cursor \
             (it may belong to another tool); request a fresh first page",
        )
        .with_details(serde_json::json!({"reason": "invalid_cursor"}))
    })?;

    let result: FsListResult;
    {
        let mut store = list_snapshots()
            .lock()
            .expect("snapshot store not poisoned");
        evict_expired(&mut store);
        let snap = store.get(&id).ok_or_else(|| {
            ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.list",
                "snapshot cursor expired or evicted (TTL/cap exceeded); \
                 request a fresh first page",
            )
            .with_details(serde_json::json!({"reason": "snapshot_unavailable"}))
        })?;
        if snap.fingerprint != fingerprint {
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.list",
                "invalid cursor: snapshot belongs to a different list query \
                 (options/root changed); request a fresh first page",
            )
            .with_details(serde_json::json!({"reason": "invalid_cursor"})));
        }
        // Re-check TTL explicitly so the error is precise even if the global
        // sweep hasn't run.
        if snap.created_at.elapsed() >= snapshot_ttl() {
            store.remove(&id);
            return Err(ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.list",
                "snapshot cursor expired (TTL exceeded); request a fresh first page",
            )
            .with_details(serde_json::json!({"reason": "snapshot_unavailable"})));
        }
        result = build_list_page(&snap.entries, Some(id), position, limit, max_output_bytes)?;
    }
    Ok(result)
}

fn build_list_page(
    entries: &[DirEntry],
    snapshot_id: Option<u64>,
    position: u64,
    limit: Option<u64>,
    max_output_bytes: Option<u64>,
) -> Result<FsListResult, ToolError> {
    let start = usize::try_from(position)
        .unwrap_or(usize::MAX)
        .min(entries.len());
    let item_limit = limit
        .map(|value| usize::try_from(value).unwrap_or(usize::MAX))
        .unwrap_or(usize::MAX);
    let mut page = Vec::new();
    let mut returned_item_bytes = 0_u64;
    for entry in entries.iter().skip(start).take(item_limit) {
        let item_bytes = serialized_item_bytes(entry)?;
        if max_output_bytes
            .is_some_and(|budget| returned_item_bytes.saturating_add(item_bytes) > budget)
        {
            if page.is_empty() && max_output_bytes != Some(0) {
                return Err(output_window_too_small(
                    "fs.list",
                    max_output_bytes.unwrap_or_default(),
                    item_bytes,
                ));
            }
            break;
        }
        returned_item_bytes = returned_item_bytes.saturating_add(item_bytes);
        page.push(entry.clone());
    }
    let new_position = start.saturating_add(page.len());
    let has_more = new_position < entries.len();
    let next_cursor = snapshot_id
        .filter(|_| has_more && !page.is_empty())
        .map(|id| encode_list_snapshot_cursor(id, new_position as u64));
    Ok(FsListResult {
        entries: page,
        next_cursor,
        returned_item_bytes,
        has_more,
    })
}

fn serialized_item_bytes<T: Serialize>(item: &T) -> Result<u64, ToolError> {
    serde_json::to_vec(item)
        .map(|bytes| bytes.len() as u64)
        .map_err(|error| {
            ToolError::new(
                ToolErrorCode::Internal,
                "fs.list",
                format!("failed to serialize list item: {error}"),
            )
        })
}

fn serialized_items_bytes<T: Serialize>(items: &[T]) -> Result<u64, ToolError> {
    items.iter().try_fold(0_u64, |total, item| {
        Ok(total.saturating_add(serialized_item_bytes(item)?))
    })
}

fn output_window_too_small(operation: &str, max_bytes: u64, minimum: u64) -> ToolError {
    ToolError::new(
        ToolErrorCode::InvalidInput,
        operation,
        "output byte window cannot hold the next result item",
    )
    .with_details(serde_json::json!({
        "reason": "output_window_too_small",
        "max_bytes": max_bytes,
        "minimum_next_item_bytes": minimum,
    }))
}

fn cancelled() -> ToolError {
    ToolError::new(ToolErrorCode::Cancelled, "fs.list", "operation cancelled")
}
