//! `fs_search` and `fs_glob` (plan §7.2).
//!
//! Uses `regex` for pattern matching and `walkdir`/`ignore` for traversal — no
//! `grep`/`findstr`/`Select-String`. Search scans line-by-line per file.

use std::io::{BufRead, BufReader};
use std::path::Path;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::{map_io_error, resolve_path};
use crate::PathAccess;
use crate::error::{ToolError, ToolErrorCode};
use crate::invocation::InvocationContext;

// ---------------------------------------------------------------------------
// fs_search
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsSearchRequest {
    pub path: String,
    pub pattern: String,
    #[serde(default)]
    pub literal: bool,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Optional byte budget for serialized `matches` items. `0` is a
    /// metadata-only page; omitted preserves the raw toolkit contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<u64>,
}

/// Optional traversal and path filters for [`search_with_options`]. Kept
/// separate from [`FsSearchRequest`] so existing raw toolkit callers retain
/// their source-compatible, unfiltered search contract.
#[derive(Clone, Debug, Default, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsSearchOptions {
    /// Include hidden path components. Defaults to false.
    #[serde(default)]
    pub include_hidden: bool,
    /// Apply `.ignore` and `.gitignore` rules found at or below `path`.
    /// Ancestor, global, and `.git/info/exclude` rules are not consulted.
    #[serde(default)]
    pub respect_gitignore: bool,
    /// Optional path globs, matched against `/`-separated paths relative to
    /// the search root. A file must match at least one when this is non-empty.
    #[serde(default)]
    pub include_globs: Vec<String>,
    /// Path globs excluded after include matching.
    #[serde(default)]
    pub exclude_globs: Vec<String>,
    /// Optional exact file extension suffixes. Simple (`rs`, `.rs`) and
    /// compound (`d.ts`, `.d.ts`) forms are supported; a leading dot is
    /// ignored and comparisons are case-sensitive on every platform.
    #[serde(default)]
    pub file_extensions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchMatch {
    pub path: String,
    pub line: u64,
    pub column: u64,
    pub r#match: String,
    pub line_text: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsSearchResult {
    pub matches: Vec<SearchMatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub returned_item_bytes: u64,
    pub has_more: bool,
}

pub fn search(ctx: &InvocationContext, req: &FsSearchRequest) -> Result<FsSearchResult, ToolError> {
    // The original raw toolkit API searched hidden paths. Keep that behavioral
    // contract while MCP callers opt into their own traversal policy through
    // `search_with_options`.
    search_with_options(
        ctx,
        req,
        &FsSearchOptions {
            include_hidden: true,
            ..FsSearchOptions::default()
        },
    )
}

pub fn search_with_options(
    ctx: &InvocationContext,
    req: &FsSearchRequest,
    options: &FsSearchOptions,
) -> Result<FsSearchResult, ToolError> {
    let root = resolve_path(ctx, &req.path, None, PathAccess::Read, "fs.search")?;
    let filters = SearchPathFilters::new(options)?;
    // Build the matcher.
    let pattern = if req.literal {
        regex::escape(&req.pattern)
    } else {
        req.pattern.clone()
    };
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!req.case_sensitive)
        .build()
        .map_err(|e| {
            ToolError::new(
                ToolErrorCode::InvalidInput,
                "fs.search",
                format!("invalid regex pattern: {e}"),
            )
        })?;

    // Cursor encodes the number of matches already returned, as a stable
    // resume point. Because matches are collected in deterministic file/line
    // order, a match-offset skip guarantees no duplicate and no gap. The cursor
    // is tool-tagged (ADR 0027 §3): a cursor from another tool is rejected with
    // a typed `invalid_cursor` error instead of silently restarting from 0.
    // Bind the cursor to this query (pattern/literal/case/root) so a cursor
    // from a different query is rejected (ADR 0027 §3, plan §6.3).
    let fingerprint_input = serde_json::json!({
        "pattern": req.pattern,
        "literal": req.literal,
        "case_sensitive": req.case_sensitive,
        "include_hidden": options.include_hidden,
        "respect_gitignore": options.respect_gitignore,
        "include_globs": &filters.include_patterns,
        "exclude_globs": &filters.exclude_patterns,
        "file_extensions": &filters.extension_suffixes,
        "root": root.to_string_lossy(),
    });
    let fingerprint_bytes = serde_json::to_vec(&fingerprint_input).map_err(|error| {
        ToolError::new(
            ToolErrorCode::Internal,
            "fs.search",
            format!("failed to fingerprint search request: {error}"),
        )
    })?;
    let fingerprint = super::fnv1a_64(&fingerprint_bytes);
    let skip = match super::decode_cursor(req.cursor.as_deref(), b"search", fingerprint)? {
        super::CursorDecode::Absent => 0u64,
        super::CursorDecode::Position(n) => n,
    };

    // Candidate files are path-sorted for deterministic cursors. Build the page
    // while scanning so count- and byte-bounded calls stop after one lookahead
    // match instead of materializing every hit in a large workspace.
    let files = collect_files(ctx, &root, options, &filters)?;
    let mut matches: Vec<SearchMatch> = Vec::new();
    let mut skipped = 0_u64;
    let mut returned_item_bytes = 0_u64;
    let item_limit = req.limit.unwrap_or(u64::MAX);
    let mut has_more = false;

    'files: for file in &files {
        if ctx.cancellation().is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "fs.search",
                "operation cancelled",
            ));
        }
        // Skip non-files and unreadable.
        let f = match std::fs::File::open(file) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(f);
        for (line_no, line) in reader.lines().enumerate() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue, // skip non-utf8 lines
            };
            for m in re.find_iter(&line) {
                if skipped < skip {
                    skipped = skipped.saturating_add(1);
                    continue;
                }
                if matches.len() as u64 >= item_limit {
                    has_more = true;
                    break 'files;
                }
                let item = SearchMatch {
                    path: file.to_string_lossy().into_owned(),
                    line: (line_no + 1) as u64,
                    column: (m.start() + 1) as u64,
                    r#match: m.as_str().to_string(),
                    line_text: line.clone(),
                };
                let item_bytes = serialized_match_bytes(&item)?;
                if req
                    .max_output_bytes
                    .is_some_and(|budget| returned_item_bytes.saturating_add(item_bytes) > budget)
                {
                    if matches.is_empty() && req.max_output_bytes != Some(0) {
                        return Err(output_window_too_small(
                            "fs.search",
                            req.max_output_bytes.unwrap_or_default(),
                            item_bytes,
                        ));
                    }
                    has_more = true;
                    break 'files;
                }
                returned_item_bytes = returned_item_bytes.saturating_add(item_bytes);
                matches.push(item);
            }
        }
    }

    let new_position = skip.saturating_add(matches.len() as u64);
    let next_cursor = (has_more && !matches.is_empty())
        .then(|| super::encode_cursor(b"search", fingerprint, new_position));
    Ok(FsSearchResult {
        matches,
        next_cursor,
        returned_item_bytes,
        has_more,
    })
}

fn serialized_match_bytes(item: &SearchMatch) -> Result<u64, ToolError> {
    serde_json::to_vec(item)
        .map(|bytes| bytes.len() as u64)
        .map_err(|error| {
            ToolError::new(
                ToolErrorCode::Internal,
                "fs.search",
                format!("failed to serialize result item: {error}"),
            )
        })
}

fn output_window_too_small(operation: &str, max_bytes: u64, item_bytes: u64) -> ToolError {
    ToolError::new(
        ToolErrorCode::InvalidInput,
        operation,
        "output byte window cannot hold the next result item",
    )
    .with_details(serde_json::json!({
        "reason": "output_window_too_small",
        "max_bytes": max_bytes,
        "minimum_next_item_bytes": item_bytes,
    }))
}

struct SearchPathFilters {
    include: Option<globset::GlobSet>,
    exclude: globset::GlobSet,
    include_patterns: Vec<String>,
    exclude_patterns: Vec<String>,
    extension_suffixes: Vec<String>,
}

impl SearchPathFilters {
    fn new(options: &FsSearchOptions) -> Result<Self, ToolError> {
        let include_patterns = normalized_set(&options.include_globs);
        let exclude_patterns = normalized_set(&options.exclude_globs);
        let include = if include_patterns.is_empty() {
            None
        } else {
            Some(build_glob_set("include_globs", &include_patterns)?)
        };
        let exclude = build_glob_set("exclude_globs", &exclude_patterns)?;

        let mut extension_suffixes = Vec::with_capacity(options.file_extensions.len());
        for value in &options.file_extensions {
            let suffix = value.strip_prefix('.').unwrap_or(value);
            if suffix.is_empty() || suffix.contains('/') || suffix.contains('\\') {
                return Err(ToolError::new(
                    ToolErrorCode::InvalidInput,
                    "fs.search",
                    format!(
                        "invalid file extension `{value}`: use a suffix such as `rs`, `.rs`, `d.ts`, or `.d.ts`"
                    ),
                )
                .with_details(serde_json::json!({
                    "field": "file_extensions",
                    "value": value,
                })));
            }
            extension_suffixes.push(suffix.to_string());
        }
        extension_suffixes.sort();
        extension_suffixes.dedup();

        Ok(Self {
            include,
            exclude,
            include_patterns,
            exclude_patterns,
            extension_suffixes,
        })
    }

    fn matches(&self, root: &Path, path: &Path) -> bool {
        let relative = path
            .strip_prefix(root)
            .ok()
            .filter(|value| !value.as_os_str().is_empty())
            .unwrap_or_else(|| path.file_name().map(Path::new).unwrap_or(path));
        let portable = relative.to_string_lossy().replace('\\', "/");
        if self
            .include
            .as_ref()
            .is_some_and(|patterns| !patterns.is_match(&portable))
        {
            return false;
        }
        if self.exclude.is_match(&portable) {
            return false;
        }
        self.extension_suffixes.is_empty()
            || self
                .extension_suffixes
                .iter()
                .any(|suffix| matches_extension_suffix(path, suffix))
    }
}

fn matches_extension_suffix(path: &Path, suffix: &str) -> bool {
    if suffix.contains('.') {
        return path
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|file_name| file_name.strip_suffix(suffix))
            .is_some_and(|prefix| prefix.ends_with('.'));
    }

    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension == suffix)
}

fn normalized_set(values: &[String]) -> Vec<String> {
    let mut normalized = values.to_vec();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn build_glob_set(field: &str, patterns: &[String]) -> Result<globset::GlobSet, ToolError> {
    let mut builder = globset::GlobSetBuilder::new();
    for pattern in patterns {
        let glob = globset::GlobBuilder::new(pattern)
            .literal_separator(true)
            .build()
            .map_err(|error| {
                ToolError::new(
                    ToolErrorCode::InvalidInput,
                    "fs.search",
                    format!("invalid {field} pattern `{pattern}`: {error}"),
                )
                .with_details(serde_json::json!({
                    "field": field,
                    "pattern": pattern,
                }))
            })?;
        builder.add(glob);
    }
    builder.build().map_err(|error| {
        ToolError::new(
            ToolErrorCode::InvalidInput,
            "fs.search",
            format!("failed to build {field}: {error}"),
        )
    })
}

/// Recursively collect files under `root`, sorted by path for determinism.
/// Skips entries that error rather than failing the whole search.
fn collect_files(
    ctx: &InvocationContext,
    root: &Path,
    options: &FsSearchOptions,
    filters: &SearchPathFilters,
) -> Result<Vec<std::path::PathBuf>, ToolError> {
    let meta = std::fs::metadata(root).map_err(|e| map_io_error(&e, "fs.search", root))?;
    if meta.is_file() {
        let hidden = root
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with('.'));
        return Ok((options.include_hidden || !hidden)
            .then(|| root.to_path_buf())
            .filter(|path| filters.matches(root, path))
            .into_iter()
            .collect());
    }
    if ctx.filesystem_scope().is_contained() {
        // Generic ignore walkers may open a symlinked `.gitignore` before a
        // capability filter can reject its target. Reuse the filesystem
        // listing traversal, which validates ignore sources and directory
        // descent inside contained workspaces before opening them.
        let listed = super::stat_list::fs_list(
            ctx,
            &super::stat_list::FsListRequest {
                path: root.to_string_lossy().into_owned(),
                base_dir: None,
                recursive: true,
                max_depth: None,
                limit: None,
                cursor: None,
                include_hidden: options.include_hidden,
                respect_gitignore: options.respect_gitignore,
                follow_symlinks: false,
                max_output_bytes: None,
            },
        )?;
        let mut files = listed
            .entries
            .into_iter()
            .filter(|entry| entry.kind == super::stat_list::EntryKind::File)
            .map(|entry| std::path::PathBuf::from(entry.path))
            .filter(|path| filters.matches(root, path))
            .collect::<Vec<_>>();
        files.sort();
        return Ok(files);
    }
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        .hidden(!options.include_hidden)
        .parents(false)
        .ignore(options.respect_gitignore)
        .git_ignore(options.respect_gitignore)
        .git_global(false)
        .git_exclude(false)
        .require_git(false)
        .follow_links(false);
    for result in builder.build() {
        if ctx.cancellation().is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "fs.search",
                "operation cancelled",
            ));
        }
        let dent = match result {
            Ok(d) => d,
            Err(_) => continue,
        };
        if dent.file_type().is_some_and(|kind| kind.is_file()) && filters.matches(root, dent.path())
        {
            files.push(dent.path().to_path_buf());
        }
    }
    files.sort();
    Ok(files)
}

// ---------------------------------------------------------------------------
// fs_glob
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsGlobRequest {
    pub path: String,
    pub patterns: Vec<String>,
    #[serde(default = "default_true")]
    pub include_files: bool,
    #[serde(default = "default_true")]
    pub include_dirs: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_bytes: Option<u64>,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FsGlobResult {
    pub matches: Vec<GlobMatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    pub returned_item_bytes: u64,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GlobMatch {
    pub path: String,
    pub kind: super::stat_list::EntryKind,
}

pub fn glob(ctx: &InvocationContext, req: &FsGlobRequest) -> Result<FsGlobResult, ToolError> {
    use super::stat_list::EntryKind;
    let root = resolve_path(ctx, &req.path, None, PathAccess::Read, "fs.glob")?;
    // Compile patterns with `/` as separator.
    let matchers: Vec<globset::GlobMatcher> = req
        .patterns
        .iter()
        .map(|p| {
            globset::GlobBuilder::new(p)
                .literal_separator(true)
                .build()
                .map(|g| g.compile_matcher())
                .map_err(|e| {
                    ToolError::new(
                        ToolErrorCode::InvalidInput,
                        "fs.glob",
                        format!("invalid glob pattern `{p}`: {e}"),
                    )
                })
        })
        .collect::<Result<_, _>>()?;

    // Bind the cursor to this query (patterns/include_files/include_dirs/root).
    let fingerprint = super::fnv1a_64(
        format!(
            "{}\u{0}{}\u{0}{}\u{0}{}",
            req.patterns.join("\u{1}"),
            req.include_files,
            req.include_dirs,
            root.display()
        )
        .as_bytes(),
    );
    let start = match super::decode_cursor(req.cursor.as_deref(), b"glob", fingerprint)? {
        super::CursorDecode::Absent => 0u64,
        super::CursorDecode::Position(n) => n,
    };
    let mut entries: Vec<(std::path::PathBuf, EntryKind)> = Vec::new();
    let walker = walkdir::WalkDir::new(&root).into_iter();
    for result in walker {
        if ctx.cancellation().is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "fs.glob",
                "operation cancelled",
            ));
        }
        let dent = match result {
            Ok(d) => d,
            Err(_) => continue,
        };
        if dent.path() == root {
            continue;
        }
        // Relative path from root, with forward slashes for matching.
        let rel = dent
            .path()
            .strip_prefix(&root)
            .unwrap_or(dent.path())
            .to_string_lossy()
            .replace('\\', "/");
        let kind = if dent.file_type().is_dir() {
            EntryKind::Directory
        } else if dent.file_type().is_file() {
            EntryKind::File
        } else if dent.file_type().is_symlink() {
            EntryKind::Symlink
        } else {
            EntryKind::Other
        };
        let kind_ok = match &kind {
            EntryKind::File => req.include_files,
            EntryKind::Directory => req.include_dirs,
            _ => req.include_files || req.include_dirs,
        };
        if !kind_ok {
            continue;
        }
        if matchers.iter().any(|m| m.is_match(&rel)) {
            entries.push((dent.path().to_path_buf(), kind));
        }
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let matches: Vec<GlobMatch> = entries
        .into_iter()
        .map(|(p, k)| GlobMatch {
            path: p.to_string_lossy().into_owned(),
            kind: k,
        })
        .collect();
    let page = build_match_page(
        matches,
        start,
        req.limit,
        req.max_output_bytes,
        b"glob",
        fingerprint,
        "fs.glob",
    )?;
    Ok(FsGlobResult {
        matches: page.matches,
        next_cursor: page.next_cursor,
        returned_item_bytes: page.returned_item_bytes,
        has_more: page.has_more,
    })
}

fn build_match_page<T>(
    items: Vec<T>,
    skip: u64,
    limit: Option<u64>,
    max_output_bytes: Option<u64>,
    cursor_tag: &[u8],
    fingerprint: u64,
    operation: &str,
) -> Result<Page<T>, ToolError>
where
    T: Serialize,
{
    let start = usize::try_from(skip).unwrap_or(usize::MAX).min(items.len());
    let item_limit = limit
        .map(|value| usize::try_from(value).unwrap_or(usize::MAX))
        .unwrap_or(usize::MAX);
    let total = items.len();
    let mut page = Vec::new();
    let mut returned_item_bytes = 0_u64;
    for item in items.into_iter().skip(start).take(item_limit) {
        let item_bytes = serde_json::to_vec(&item)
            .map_err(|error| {
                ToolError::new(
                    ToolErrorCode::Internal,
                    operation,
                    format!("failed to serialize result item: {error}"),
                )
            })?
            .len() as u64;
        if max_output_bytes
            .is_some_and(|budget| returned_item_bytes.saturating_add(item_bytes) > budget)
        {
            if page.is_empty() && max_output_bytes != Some(0) {
                return Err(output_window_too_small(
                    operation,
                    max_output_bytes.unwrap_or_default(),
                    item_bytes,
                ));
            }
            break;
        }
        returned_item_bytes = returned_item_bytes.saturating_add(item_bytes);
        page.push(item);
    }
    let new_position = start.saturating_add(page.len());
    let has_more = new_position < total;
    let next_cursor = (has_more && !page.is_empty())
        .then(|| super::encode_cursor(cursor_tag, fingerprint, new_position as u64));
    Ok(Page {
        matches: page,
        next_cursor,
        returned_item_bytes,
        has_more,
    })
}

struct Page<T> {
    matches: Vec<T>,
    next_cursor: Option<String>,
    returned_item_bytes: u64,
    has_more: bool,
}
