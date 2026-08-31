//! Tool catalog and dispatch (plan §9.3, §6).
//!
//! Each wave registers tools here. A tool is a `(name, description,
//! input_schema)` triple plus a dispatch function that decodes the request
//! DTO, runs the toolkit operation, and returns a structured MCP result.
//!
//! W1 registers `system_info`, `path_resolve`, `path_relative`.
//!
//! Result mapping (plan §5, §9.3):
//! - success -> `Ok(CallToolResult::structured(json))` (`is_error=false`).
//! - domain failure (`ToolError`) -> `Ok(CallToolResult::error(...))`
//!   (`is_error=true`, caller-visible structured payload).
//! - protocol failure (unknown tool, malformed args) -> `Err(McpError)`.

use rmcp::model::{CallToolResult, ContentBlock, JsonObject, Tool, ToolAnnotations};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use xuanling_memory as tk_memory;
use xuanling_toolkit::FilesystemScope;
use xuanling_toolkit::PathContext;
use xuanling_toolkit::fs::{
    self as tk_fs, FsCopyRequest, FsCopyResult, FsEditRequest, FsEditResult, FsGlobRequest,
    FsGlobResult, FsHashRequest, FsHashResult, FsListRequest, FsListResult, FsMkdirRequest,
    FsMkdirResult, FsMoveRequest, FsMoveResult, FsPatchRequest, FsPatchResult, FsReadBytesRequest,
    FsReadBytesResult, FsReadTextRequest, FsReadTextResult, FsRemoveRequest, FsRemoveResult,
    FsReplaceTextRequest, FsReplaceTextResult, FsSearchOptions, FsSearchRequest, FsSearchResult,
    FsStatRequest, FsStatResult, FsWriteTextRequest, FsWriteTextResult,
};
use xuanling_toolkit::invocation::Cancellation;
use xuanling_toolkit::invocation::InvocationContext;
use xuanling_toolkit::path::{
    self as tk_path, PathRelativeRequest, PathRelativeResult, PathResolveRequest, PathResolveResult,
};
use xuanling_toolkit::process::{
    self as tk_process, ArtifactCleanupRequest, ArtifactCleanupResult, ArtifactReadRequest,
    ArtifactReadResult, ProcessPipelineRequest, ProcessPipelineResult, ProcessRunRequest,
    ProcessRunResult, ProcessStreamMode, ProcessWhichRequest, ProcessWhichResult, ProjectAction,
    ProjectCommandRequest, ProjectCommandResult, ProjectDetectRequest, ProjectDetectResult,
    ProjectRunRequest, ProjectRunResult, SessionCloseRequest, SessionCloseResult,
    SessionExecRequest, SessionOpenRequest, SessionOpenResult,
};
use xuanling_toolkit::system::{self as tk_system, SystemInfoRequest, SystemInfoResult};

/// Process-lifetime tool catalog. Schema generation is relatively expensive,
/// while these definitions are immutable, so materialize them exactly once.
static CATALOG: LazyLock<Vec<Tool>> = LazyLock::new(build_catalog);

/// Return the static tool catalog (plan §6, §7). Tool names are ASCII
/// snake_case; the catalog is the same on all platforms.
pub fn catalog() -> Vec<Tool> {
    shared_catalog().to_vec()
}

pub(crate) fn shared_catalog() -> &'static [Tool] {
    CATALOG.as_slice()
}

fn build_catalog() -> Vec<Tool> {
    // `Tool::with_input_schema::<T>()` generates the JSON Schema from the DTO's
    // `JsonSchema` impl.
    vec![
        tool::<SystemInfoRequest, SystemInfoResult>(
            "system_info",
            "Return deterministic runtime facts: OS family/name, architecture, process cwd, path separator, newline style, and executable suffixes (PATHEXT on Windows). Does not return the full environment or any secret.",
            read_only(),
            SystemInfoRequest {},
        ),
        tool::<PathResolveRequest, PathResolveResult>(
            "path_resolve",
            "Resolve a path relative to a base directory (or an explicit per-request base_dir), following current OS path semantics. Absolute paths pass through unchanged. parent (`..`) traversal is NOT rejected for escaping base_dir. With canonicalize=true the resolved path is canonicalized (symlinks resolved); canonicalize=false allows the target to not exist. Returns resolved path, optional absolute_path, and exists flag.",
            read_only(),
            PathResolveRequest {
                path: String::new(),
                base_dir: None,
                canonicalize: false,
            },
        ),
        tool::<PathRelativeRequest, PathRelativeResult>(
            "path_relative",
            "Express `path` relative to `base_dir`. base_dir is the resolution context supplied by the request, NOT the server startup directory. The result uses `/` as the portable separator. Returns `unsupported` when the two paths cannot be expressed relatively (e.g. cross-drive on Windows).",
            read_only(),
            PathRelativeRequest {
                path: String::new(),
                base_dir: String::new(),
            },
        ),
        // --- filesystem (W2) ---
        tool::<FsStatRequest, FsStatResult>(
            "fs_stat",
            "Stat a path: kind (file/directory/symlink/other), size, readonly, RFC3339 timestamps, and symlink target. follow_symlinks=false (default) stats the symlink entry itself and reports that entry path as absolute_path; true follows the target and reports its canonical path.",
            read_only(),
            FsStatRequest {
                path: String::new(),
                base_dir: None,
                follow_symlinks: false,
            },
        ),
        tool::<FsListCall, FsListResult>(
            "fs_list",
            "List directory entries. When recursive, descends up to optional max_depth. follow_symlinks=false (default) returns symlink entries without descending; true follows contained targets, while workspace mode omits links whose targets are outside the capability. `limit` and an explicit output byte budget are independent constraints; the stricter one wins. Omitted `output` uses the 65,536-byte safe default; explicit complete removes that budget. `next_cursor` resumes a stable snapshot when more entries remain. In workspace mode, respect_gitignore reads only .ignore/.gitignore files at the list root and traversed descendants; it does not use ancestor, global, or .git/info/exclude rules. include_hidden controls dotfile filtering. Uses Rust APIs, never grep/find/dir or Git. Use `output`: {\"mode\":\"bounded\",\"max_bytes\":65536} only when the caller wants a byte budget.",
            read_only(),
            FsListCall {
                path: String::new(),
                base_dir: None,
                recursive: false,
                max_depth: None,
                limit: None,
                cursor: None,
                include_hidden: false,
                respect_gitignore: false,
                follow_symlinks: false,
                output: None,
            },
        ),
        tool::<FsReadTextCall, FsReadTextResult>(
            "fs_read_text",
            "Read a UTF-8 text file. Omitted `output` uses the 65,536-byte safe default; explicit complete removes that budget. `format=raw` preserves source text, while `format=numbered` prefixes each line with an absolute right-aligned line number and tab (cat -n style). Bounded windows preserve UTF-8 boundaries and return a preimage-bound resume token whose offset always remains in raw source-byte space. `known_sha256` performs a stateless conditional read: a match returns `not_modified=true`, sha256, total_lines, and no content body. Invalid UTF-8 or an invalid SHA is a typed input error.",
            read_only(),
            FsReadTextCall {
                path: String::new(),
                base_dir: None,
                start_line: None,
                end_line: None,
                include_sha256: false,
                known_sha256: None,
                format: tk_fs::TextReadFormat::Raw,
                resume: None,
                output: None,
            },
        ),
        tool::<ArtifactReadCall, ArtifactReadResult>(
            "artifact_read",
            "Read bytes from a server-owned process-output artifact. The caller must present the opaque artifact id and read_capability returned by the producing invocation; owner is audit metadata, not authorization. Filesystem paths are never accepted. Omitted `output` uses the 65,536-byte safe default; explicit complete removes that budget. An explicit length and output budget are independent constraints; the stricter one wins.",
            read_only(),
            ArtifactReadCall {
                id: String::new(),
                read_capability: String::new(),
                offset: None,
                length: None,
                output: None,
            },
        ),
        tool::<ArtifactCleanupCall, ArtifactCleanupResult>(
            "artifact_cleanup_preview",
            "List expired artifact cleanup candidates without moving, quarantining, or purging records or objects.",
            read_only(),
            ArtifactCleanupCall {},
        ),
        tool::<ArtifactCleanupCall, ArtifactCleanupResult>(
            "artifact_cleanup",
            "Execute artifact retention cleanup: quarantine expired active records and purge completed quarantine entries. Use artifact_cleanup_preview for a read-only inspection.",
            mutating_destructive(),
            ArtifactCleanupCall {},
        ),
        tool::<FsReadBytesCall, FsReadBytesResult>(
            "fs_read_bytes",
            "Read a file as base64 bytes. Omitted `output` uses the 65,536-byte safe default; explicit complete removes that budget. Explicit `length` and an output byte budget are independent constraints; the stricter one wins. Bounded results carry a preimage-bound byte resume. `known_sha256` performs a stateless conditional read: a match returns `not_modified=true`, sha256, total_bytes, and no base64 body. No binary inference.",
            read_only(),
            FsReadBytesCall {
                path: String::new(),
                base_dir: None,
                offset: None,
                length: None,
                include_sha256: false,
                known_sha256: None,
                resume: None,
                output: None,
            },
        ),
        tool::<FsSearchCall, FsSearchResult>(
            "fs_search",
            "Search file contents line-by-line with a regex (or literal) pattern. include_hidden, root-local respect_gitignore, include_globs, exclude_globs, and file_extensions filter candidate paths before scanning. file_extensions accepts simple (`ts`, `.ts`) or compound (`d.ts`, `.d.ts`) suffixes. Globs use `/`-separated paths relative to the search root; extension matching is case-sensitive on every platform. `limit` and a canonical-JSON item byte budget are independent constraints. Omitted `output` uses the 65,536-byte safe default; explicit complete removes that budget. A query-bound cursor resumes when more matches remain. Set `group_by_line=true` to return one item per matching source line with every occurrence in `occurrences[]`; the default remains one item per occurrence. Uses Rust regex/ignore/globset APIs, never grep/findstr/Select-String.",
            read_only(),
            FsSearchCall {
                path: String::new(),
                pattern: String::new(),
                literal: false,
                case_sensitive: false,
                include_hidden: false,
                respect_gitignore: false,
                include_globs: Vec::new(),
                exclude_globs: Vec::new(),
                file_extensions: Vec::new(),
                group_by_line: false,
                limit: None,
                cursor: None,
                output: None,
            },
        ),
        tool::<FsGlobCall, FsGlobResult>(
            "fs_glob",
            "Match paths under `path` against one or more glob patterns (`/` as separator). include_files/include_dirs control which kinds are returned. `limit` and an explicit canonical-JSON item byte budget are independent constraints; omitted `output` uses the 65,536-byte safe default and explicit complete removes it. A query-bound cursor resumes when more matches remain. Uses Rust `globset`, never find/Get-ChildItem. Use `output`: {\"mode\":\"bounded\",\"max_bytes\":65536} only when the caller wants a byte budget.",
            read_only(),
            FsGlobCall {
                path: String::new(),
                patterns: Vec::new(),
                include_files: true,
                include_dirs: true,
                limit: None,
                cursor: None,
                output: None,
            },
        ),
        tool::<FsHashRequest, FsHashResult>(
            "fs_hash",
            "Compute the SHA-256 digest of a file. MVP only promises sha256.",
            read_only(),
            FsHashRequest {
                path: String::new(),
                base_dir: None,
                algorithm: "sha256".to_string(),
            },
        ),
        tool::<FsMkdirRequest, FsMkdirResult>(
            "fs_mkdir",
            "Create a directory. recursive=true (default) creates parents. An existing directory returns created=false (not an error).",
            mutating_additive(),
            FsMkdirRequest {
                path: String::new(),
                base_dir: None,
                recursive: true,
            },
        ),
        tool::<FsWriteTextRequest, FsWriteTextResult>(
            "fs_write_text",
            "Write UTF-8 text to a file via temp-file + atomic replace (same directory). mode=create fails `already_exists` if the file exists; mode=overwrite replaces. expected_sha256 guards against stale content. newline_mode normalizes line endings (raw default = no transformation). create_parents makes missing ancestors.",
            mutating_destructive(),
            FsWriteTextRequest {
                path: String::new(),
                content: String::new(),
                base_dir: None,
                mode: xuanling_toolkit::fs::WriteMode::Overwrite,
                create_parents: true,
                expected_sha256: None,
                newline_mode: xuanling_toolkit::fs::NewlineMode::Raw,
            },
        ),
        tool::<FsReplaceTextRequest, FsReplaceTextResult>(
            "fs_replace_text",
            "Replace text within a file via temp-file + atomic replace. zero matches -> `not_found`; multiple matches with replace_all=false -> `conflict`. expected_sha256 provides optimistic concurrency. Reports replacement count and before/after sha256.",
            mutating_destructive(),
            FsReplaceTextRequest {
                path: String::new(),
                old: String::new(),
                new: String::new(),
                replace_all: false,
                base_dir: None,
                expected_sha256: None,
            },
        ),
        tool::<FsPatchRequest, FsPatchResult>(
            "fs_patch",
            "Apply a strict single-file unified diff (ADR 0013 v2). expected_preimage_sha256 guards against stale content (conflict, zero writes). A malformed or non-applicable diff writes NOTHING and returns a typed error; hunk context must match the file exactly. `content`/`replacement` are NOT accepted — use fs_write_text for whole-file creation.",
            mutating_destructive(),
            FsPatchRequest {
                path: String::new(),
                expected_preimage_sha256: String::new(),
                unified_diff: String::new(),
                base_dir: None,
            },
        ),
        tool::<FsEditPreviewCall, FsEditResult>(
            "fs_edit_preview",
            "Preview a precise old->new text replacement without writing. By default the match must be UNIQUE; multiple matches return line/column locations. expected_sha256 detects a stale preimage. include_diff defaults to true; false omits only the unified-diff response projection and preserves hashes and replacement facts.",
            read_only(),
            FsEditPreviewCall {
                path: String::new(),
                old: String::new(),
                new: String::new(),
                replace_all: false,
                base_dir: None,
                expected_sha256: None,
                include_diff: true,
            },
        ),
        tool::<FsEditApplyCall, FsEditResult>(
            "fs_edit",
            "Apply a precise old->new text replacement (ADR 0027 §8.2). By default the match must be UNIQUE; multiple matches return their line/column locations WITHOUT writing (conflict). expected_sha256 guards against stale content. reversible=true registers a ChangeSet so the apply can be rolled back via change_rollback. include_diff defaults to true; false omits only the unified-diff response projection and does not change matching, hashes, writes, or rollback state.",
            mutating_destructive(),
            FsEditApplyCall {
                path: String::new(),
                old: String::new(),
                new: String::new(),
                replace_all: false,
                base_dir: None,
                expected_sha256: None,
                reversible: false,
                include_diff: true,
            },
        ),
        tool::<ChangeOpSchema, ChangeOpResult>(
            "change_rollback",
            "Roll back a reversible ChangeSet (from fs_edit/patch with reversible=true). Re-reads the file: if it still matches what the change wrote, the pre-change content is restored (rolled_back); if the file changed in the meantime, the user's content is PRESERVED and the state is rollback_conflict (ADR 0013, plan §8.1).",
            mutating_destructive(),
            ChangeOpSchema {
                change_id: String::new(),
            },
        ),
        tool::<ChangeOpSchema, ChangeOpResult>(
            "change_commit",
            "Finalize a reversible ChangeSet (state -> committed). Does not re-read the file; it only records that the change is final.",
            mutating_destructive(),
            ChangeOpSchema {
                change_id: String::new(),
            },
        ),
        tool::<FsCopyRequest, FsCopyResult>(
            "fs_copy",
            "Copy a file or directory tree. overwrite must be true to replace an existing destination. recursive=true (default) required for directories. Uses Rust APIs, never cp/copy.",
            mutating_destructive(),
            FsCopyRequest {
                from: String::new(),
                to: String::new(),
                base_dir: None,
                overwrite: false,
                recursive: true,
            },
        ),
        tool::<FsMoveRequest, FsMoveResult>(
            "fs_move",
            "Move/rename a file or directory. Tries atomic rename first; on cross-device failure falls back to copy+delete and reports fallback_copy_delete=true. overwrite must be true to replace an existing destination.",
            mutating_destructive(),
            FsMoveRequest {
                from: String::new(),
                to: String::new(),
                base_dir: None,
                overwrite: false,
            },
        ),
        tool::<FsRemoveRequest, FsRemoveResult>(
            "fs_remove",
            "Remove a file, directory, or final symlink entry without following that symlink. recursive defaults to FALSE: a non-empty directory is refused (invalid_input) unless the caller explicitly passes recursive=true. missing_ok returns removed=false with kind=missing instead of `not_found` when the path is absent. Successful kind values are file/directory/symlink/other. No policy/approval.",
            mutating_destructive(),
            FsRemoveRequest {
                path: String::new(),
                base_dir: None,
                recursive: false,
                missing_ok: false,
            },
        ),
        // --- process / project (W3) ---
        tool::<ProcessWhichRequest, ProcessWhichResult>(
            "process_which",
            "Resolve a bare program name against PATH and PATHEXT (Windows). Returns candidate paths, the selected path, and PATHEXT facts. Windows env-var keys are matched case-insensitively; no version probe is run.",
            read_only(),
            ProcessWhichRequest {
                program: String::new(),
                include_patext_facts: false,
            },
        ),
        tool::<ProcessRunCall, ProcessRunResult>(
            "process_run",
            "Run a child process using direct argv (program + args[] + cwd + env). No shell; an optional timeout_hint_ms is an MCP soft deadline that follows the normal cancellation and descendant cleanup path. Without the hint there is no server-side timeout. MCP cancellation terminates the complete descendant process tree. Before returning after direct-child exit, residual descendants in the containment unit are also terminated. stdout/stderr capture mode is caller-selected (inline/file/inherit/null; stdout=inherit is rejected in stdio MCP mode). A nonzero exit is a successful call with success=false, NOT an error. Does not split or translate shell command strings. inherit_env=false (default) seeds a minimal non-secret allowlist (PATH/HOME/TEMP/locale; SystemRoot/USERPROFILE on Windows): child tools read your user config (git/cargo/npm/ssh) but do NOT inherit tokens/keys; pass inherit_env=true to match your login shell or add vars via env/remove_env. deterministic=true omits duration_ms so identical invocations return byte-identical results. Omitted output uses a 65,536-byte per-stream preview and spills overflow to per-invocation artifacts; explicit complete opts into full inline streams.",
            mutating_open_world(),
            ProcessRunCall {
                program: String::new(),
                args: Vec::new(),
                cwd: None,
                env: std::collections::BTreeMap::new(),
                remove_env: Vec::new(),
                inherit_env: false,
                deterministic: false,
                timeout_hint_ms: None,
                stdin: None,
                stdout: ProcessStreamMode::Inline,
                stderr: ProcessStreamMode::Inline,
                output: None,
            },
        ),
        tool::<ProjectDetectRequest, ProjectDetectResult>(
            "project_detect",
            "Detect the project ecosystem(s) by marker files (Cargo.toml, package.json+lockfile, pubspec.yaml, gradlew*, go.mod, pyproject.toml…). Returns ecosystems, candidate toolchains, and the markers found. Does NOT execute any build script.",
            read_only(),
            ProjectDetectRequest {
                path: String::new(),
                base_dir: None,
            },
        ),
        tool::<ProjectCommandRequest, ProjectCommandResult>(
            "project_command",
            "Resolve a project action (check/test/build/format_check/format_apply/lint/run) into deterministic program, args, cwd, reason, and ecosystem WITHOUT executing. Resolution prefers an explicit target, then an exact same-name user script, then a proven non-mutating ecosystem convention; otherwise it returns typed unsupported. `check` never falls back to `build`, and format_check never selects a formatting command that writes source files. Package manager/toolchain selection is deterministic by lockfile, with no PATH-order guess.",
            read_only(),
            ProjectCommandRequest {
                project_path: String::new(),
                action: ProjectAction::Check,
                target: None,
                extra_args: Vec::new(),
                base_dir: None,
            },
        ),
        tool::<ProjectRunCall, ProjectRunResult>(
            "project_run",
            "Resolve and run a project action via process_run (one resolver and one process lifecycle). Exact same-name user scripts take priority over ecosystem conventions; `check` never falls back to `build`, and unsupported mappings spawn nothing. The result reports program, args, cwd, reason, ecosystem, and action alongside process terminal facts. Same cancellation and direct-argv semantics as process_run, including optional timeout_hint_ms. inherit_env=false (default) uses the minimal non-secret environment; spawn errors report that policy and suggest explicit inherit_env=true without exposing environment values. Omitted output uses a 65,536-byte per-stream preview and spills overflow to per-invocation artifacts; explicit complete opts into full inline streams.",
            mutating_open_world(),
            ProjectRunCall {
                project_path: String::new(),
                action: ProjectAction::Check,
                target: None,
                extra_args: Vec::new(),
                base_dir: None,
                inherit_env: false,
                deterministic: false,
                timeout_hint_ms: None,
                stdout: ProcessStreamMode::Inline,
                stderr: ProcessStreamMode::Inline,
                output: None,
            },
        ),
        tool::<ProcessPipelineCall, ProcessPipelineResult>(
            "process_pipeline",
            "Run a shell-free pipeline (ADR 0027 §9.1). Provide either explicit `stages` ({program,args,env,remove_env,inherit_env,cwd}) or `pipeline_shlex`, a restricted notation with whitespace, quotes, backslash escapes, and `|`; never provide both. The parser does not execute a shell: `$`, backticks, and quoted metacharacters remain literal, while redirection and control operators are rejected. Explicit stages remain the portable contract and allow per-stage env/cwd. A stage's stdout is piped to the next stage's stdin. Reports each stage's exit status; spawn failures carry details.stage_index. An optional timeout_hint_ms is an MCP soft deadline; without it there is no server-side timeout. deterministic=true omits duration_ms so identical invocations return byte-identical results. Omitted output uses a 65,536-byte per-stream preview and spills overflow to per-invocation artifacts; explicit complete opts into full inline streams.",
            mutating_open_world(),
            ProcessPipelineCall {
                stages: None,
                pipeline_shlex: None,
                stdin: None,
                stdout: ProcessStreamMode::Inline,
                deterministic: false,
                timeout_hint_ms: None,
                output: None,
            },
        ),
        tool::<SessionOpenRequest, SessionOpenResult>(
            "session_open",
            "Open a server-owned process session bound to a cwd/env (ADR 0027 §9.2). Returns an opaque session_id; the caller cannot forge or escape it. session_exec runs foreground argv commands in this session; session_close terminates active process trees. Detached/background work is not retained after session_exec returns. inherit_env=false (default) bases the session on the minimal non-secret allowlist (PATH/HOME/TEMP/locale); inherit_env=true captures the full environment at open time; `env` adds explicit overrides.",
            mutating_open_world(),
            SessionOpenRequest {
                cwd: None,
                env: std::collections::BTreeMap::new(),
                inherit_env: false,
            },
        ),
        tool::<SessionExecCall, ProcessRunResult>(
            "session_exec",
            "Run a foreground direct-argv command inside a session (the session's cwd/env apply; request env overrides). NO shell. An optional timeout_hint_ms is an MCP soft deadline; without it there is no server-side timeout. Cancellation and session_close terminate the contained process tree; descendants left after the direct child exits are cleaned up before this call returns. The env policy follows session_open: a session opened with inherit_env=false uses the minimal non-secret allowlist plus explicit env. deterministic=true omits duration_ms so identical invocations return byte-identical results. Omitted output uses a 65,536-byte per-stream preview and spills overflow to per-invocation artifacts; explicit complete opts into full inline streams.",
            mutating_open_world(),
            SessionExecCall {
                session_id: String::new(),
                program: String::new(),
                args: Vec::new(),
                stdin: None,
                stdout: ProcessStreamMode::Inline,
                stderr: ProcessStreamMode::Inline,
                env: std::collections::BTreeMap::new(),
                deterministic: false,
                timeout_hint_ms: None,
                output: None,
            },
        ),
        tool::<SessionCloseRequest, SessionCloseResult>(
            "session_close",
            "Close a session: terminate every active contained process tree and remove the handle. Cleanup failures are returned and leave the closing handle available for retry; an already-exited tree is not an error.",
            mutating_destructive(),
            SessionCloseRequest {
                session_id: String::new(),
            },
        ),
        // --- memory v2 (proposal/review, plan §5) ---
        tool::<tk_memory::CandidateCreateRequest, tk_memory::ProposalView>(
            "memory_candidate_create",
            "Submit a pending create proposal for a memory record (fact/preference/procedure/solution/summary). Nothing is stored until memory_review approves it; the same idempotency_key with the same payload replays the existing proposal, with a different payload it conflicts. Caller provides proposal/record/idempotency/proposer ids and the exact scope; the server never attests a human reviewed anything.",
            mutating_additive(),
            tk_memory::CandidateCreateRequest {
                proposal_id: String::new(),
                idempotency_key: String::new(),
                proposer_id: String::new(),
                namespace: String::new(),
                scope: tk_memory::MemoryScope::Global,
                payload: tk_memory::MemoryPayload {
                    kind: tk_memory::MemoryKind::Fact,
                    title: None,
                    content: String::new(),
                    summary: None,
                    tags: Vec::new(),
                    applicability: Default::default(),
                    pinned: false,
                },
            },
        ),
        tool::<tk_memory::CandidateReplaceRequest, tk_memory::ProposalView>(
            "memory_candidate_replace",
            "Submit a pending replace proposal carrying a full replacement payload and a target record revision CAS. Replace never moves the record's namespace, scope, or id; approval that observes a stale target revision conflicts without writing.",
            mutating_additive(),
            tk_memory::CandidateReplaceRequest {
                proposal_id: String::new(),
                idempotency_key: String::new(),
                proposer_id: String::new(),
                namespace: String::new(),
                scope: tk_memory::MemoryScope::Global,
                target_record_id: String::new(),
                target_revision: 1,
                payload: tk_memory::MemoryPayload {
                    kind: tk_memory::MemoryKind::Fact,
                    title: None,
                    content: String::new(),
                    summary: None,
                    tags: Vec::new(),
                    applicability: Default::default(),
                    pinned: false,
                },
            },
        ),
        tool::<tk_memory::CandidateArchiveRequest, tk_memory::ProposalView>(
            "memory_candidate_archive",
            "Submit a pending archive proposal. Archive only flips the head status; history versions are preserved and there is no physical delete or restore API.",
            mutating_additive(),
            tk_memory::CandidateArchiveRequest {
                proposal_id: String::new(),
                idempotency_key: String::new(),
                proposer_id: String::new(),
                namespace: String::new(),
                scope: tk_memory::MemoryScope::Global,
                target_record_id: String::new(),
                target_revision: 1,
            },
        ),
        tool::<tk_memory::CandidateGetRequest, tk_memory::ProposalView>(
            "memory_candidate_get",
            "Read one proposal by id in the exact scope (no ancestor expansion). Includes payload and, once terminal, the review record.",
            read_only(),
            tk_memory::CandidateGetRequest {
                namespace: String::new(),
                scope: tk_memory::MemoryScope::Global,
                proposal_id: String::new(),
            },
        ),
        tool::<tk_memory::CandidateListRequest, tk_memory::CandidateListResult>(
            "memory_candidate_list",
            "List proposals in the exact scope with optional status/operation filters and query-bound stable pagination (cursor belongs to this query only).",
            read_only(),
            tk_memory::CandidateListRequest {
                namespace: String::new(),
                scope: tk_memory::MemoryScope::Global,
                status: None,
                operation: None,
                limit: None,
                cursor: None,
            },
        ),
        tool::<tk_memory::ReviewRequest, tk_memory::ProposalView>(
            "memory_review",
            "Decide a pending proposal terminally (approve|reject) with a proposal-revision CAS (expected_proposal_revision=1). Approval atomically applies the proposal (immutable record version + head CAS + active FTS projection + review row) or conflicts with zero partial writes. reviewer_id and comment are caller-attested; the server does not verify a human performed the review.",
            review_terminal(),
            tk_memory::ReviewRequest {
                idempotency_key: String::new(),
                reviewer_id: String::new(),
                namespace: String::new(),
                scope: tk_memory::MemoryScope::Global,
                proposal_id: String::new(),
                expected_proposal_revision: 1,
                decision: tk_memory::ReviewDecision::Approve,
                comment: None,
            },
        ),
        tool::<tk_memory::RecordGetRequest, tk_memory::MemoryRecordView>(
            "memory_get",
            "Read a record's current version or an immutable historical revision by id in the exact scope, including archived history.",
            read_only(),
            tk_memory::RecordGetRequest {
                namespace: String::new(),
                scope: tk_memory::MemoryScope::Global,
                record_id: String::new(),
                revision: None,
            },
        ),
        tool::<tk_memory::SearchRequestV2, tk_memory::SearchResultV2>(
            "memory_search",
            "Lexical recall over active records only. scope_mode=exact reads just the given scope; ancestors walks workspace -> project -> global and never crosses sibling projects. candidate_limit >= limit > 0. Historical and pending rows are never searchable; results contain no volatile fields.",
            read_only(),
            tk_memory::SearchRequestV2 {
                namespace: String::new(),
                scope: tk_memory::MemoryScope::Global,
                scope_mode: tk_memory::ScopeMode::Exact,
                query: String::new(),
                applicability: None,
                candidate_limit: 10,
                limit: 5,
            },
        ),
        tool::<tk_memory::FeedbackEventRequest, tk_memory::FeedbackEventResult>(
            "memory_feedback",
            "Append a helpful/unhelpful event bound to one record revision (append-only, idempotent by idempotency_key). Search never writes last-used and reads are stable.",
            mutating_additive(),
            tk_memory::FeedbackEventRequest {
                event_id: String::new(),
                idempotency_key: String::new(),
                record_id: String::new(),
                revision: 1,
                feedback: tk_memory::FeedbackValue::Helpful,
            },
        ),
    ]
}

/// Construct a `Tool` with a generated input schema from a sample request DTO
/// (`I`), a generated output schema from the result DTO (`R`), and host-facing
/// `annotations` (ADR 0027 §5.3, §7). The sample value is only used for schema
/// generation, not dispatch.
fn tool<I, R>(
    name: &'static str,
    description: &'static str,
    annotations: ToolAnnotations,
    _input_sample: I,
) -> Tool
where
    I: schemars::JsonSchema + 'static,
    R: schemars::JsonSchema + 'static,
{
    Tool::new(name, description, Arc::new(JsonObject::new()))
        .with_input_schema::<I>()
        .with_output_schema::<R>()
        .with_annotations(annotations)
}

/// Public MCP output selector (ADR 0027 §2). It deliberately lives in the MCP
/// crate: toolkit request DTOs retain their raw API, while only the public host
/// contract exposes this tagged union.
#[derive(Clone, Debug, schemars::JsonSchema, serde::Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
enum OutputRequest {
    Bounded { max_bytes: u64 },
    Complete,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactCleanupCall {}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FsEditPreviewCall {
    path: String,
    old: String,
    new: String,
    #[serde(default)]
    replace_all: bool,
    #[serde(default)]
    base_dir: Option<String>,
    #[serde(default)]
    expected_sha256: Option<String>,
    #[serde(default = "default_true")]
    include_diff: bool,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FsEditApplyCall {
    path: String,
    old: String,
    new: String,
    #[serde(default)]
    replace_all: bool,
    #[serde(default)]
    base_dir: Option<String>,
    #[serde(default)]
    expected_sha256: Option<String>,
    #[serde(default)]
    reversible: bool,
    #[serde(default = "default_true")]
    include_diff: bool,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FsListCall {
    path: String,
    #[serde(default)]
    base_dir: Option<String>,
    #[serde(default)]
    recursive: bool,
    #[serde(default)]
    max_depth: Option<u32>,
    #[serde(default)]
    limit: Option<u64>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    include_hidden: bool,
    #[serde(default)]
    respect_gitignore: bool,
    #[serde(default)]
    follow_symlinks: bool,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FsReadTextCall {
    path: String,
    #[serde(default)]
    base_dir: Option<String>,
    #[serde(default)]
    start_line: Option<u32>,
    #[serde(default)]
    end_line: Option<u32>,
    #[serde(default)]
    include_sha256: bool,
    #[serde(default)]
    known_sha256: Option<String>,
    #[serde(default)]
    format: tk_fs::TextReadFormat,
    #[serde(default)]
    resume: Option<tk_fs::TextResume>,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FsReadBytesCall {
    path: String,
    #[serde(default)]
    base_dir: Option<String>,
    #[serde(default)]
    offset: Option<u64>,
    #[serde(default)]
    length: Option<u64>,
    #[serde(default)]
    include_sha256: bool,
    #[serde(default)]
    known_sha256: Option<String>,
    #[serde(default)]
    resume: Option<tk_fs::ByteResume>,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FsSearchCall {
    path: String,
    pattern: String,
    #[serde(default)]
    literal: bool,
    #[serde(default)]
    case_sensitive: bool,
    /// Include hidden path components. Defaults to false.
    #[serde(default)]
    include_hidden: bool,
    /// Apply `.ignore` and `.gitignore` rules at or below `path` only.
    #[serde(default)]
    respect_gitignore: bool,
    /// Optional `/`-separated path globs relative to the search root.
    #[serde(default)]
    include_globs: Vec<String>,
    /// Relative path globs excluded after include matching.
    #[serde(default)]
    exclude_globs: Vec<String>,
    /// Exact extension suffixes; `rs`/`.rs` and `d.ts`/`.d.ts` are equivalent.
    #[serde(default)]
    file_extensions: Vec<String>,
    /// Return one item per matching source line and preserve every occurrence
    /// in the item's `occurrences` array. Defaults to occurrence-oriented rows.
    #[serde(default)]
    group_by_line: bool,
    #[serde(default)]
    limit: Option<u64>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct FsGlobCall {
    path: String,
    patterns: Vec<String>,
    #[serde(default = "default_true")]
    include_files: bool,
    #[serde(default = "default_true")]
    include_dirs: bool,
    #[serde(default)]
    limit: Option<u64>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessRunCall {
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    remove_env: Vec<String>,
    #[serde(default)]
    inherit_env: bool,
    #[serde(default)]
    deterministic: bool,
    /// Optional MCP-only soft deadline. Expiry follows the normal cancellation
    /// and process-tree cleanup path; the toolkit request remains deadline-free.
    #[serde(default)]
    timeout_hint_ms: Option<u64>,
    #[serde(default)]
    stdin: Option<String>,
    #[serde(default)]
    stdout: ProcessStreamMode,
    #[serde(default)]
    stderr: ProcessStreamMode,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectRunCall {
    project_path: String,
    action: ProjectAction,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    extra_args: Vec<String>,
    #[serde(default)]
    base_dir: Option<String>,
    #[serde(default)]
    inherit_env: bool,
    #[serde(default)]
    deterministic: bool,
    /// Optional MCP-only soft deadline; expiry uses normal cancellation cleanup.
    #[serde(default)]
    timeout_hint_ms: Option<u64>,
    #[serde(default)]
    stdout: ProcessStreamMode,
    #[serde(default)]
    stderr: ProcessStreamMode,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactReadCall {
    id: String,
    read_capability: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    offset: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    length: Option<u64>,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ProcessPipelineCall {
    #[serde(default)]
    stages: Option<Vec<tk_process::PipelineStage>>,
    #[serde(default)]
    pipeline_shlex: Option<String>,
    #[serde(default)]
    stdin: Option<String>,
    #[serde(default)]
    stdout: ProcessStreamMode,
    #[serde(default)]
    deterministic: bool,
    /// Optional MCP-only soft deadline; expiry uses normal cancellation cleanup.
    #[serde(default)]
    timeout_hint_ms: Option<u64>,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionExecCall {
    session_id: String,
    program: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    stdin: Option<String>,
    #[serde(default)]
    stdout: ProcessStreamMode,
    #[serde(default)]
    stderr: ProcessStreamMode,
    #[serde(default)]
    env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    deterministic: bool,
    /// Optional MCP-only soft deadline; expiry uses normal cancellation cleanup.
    #[serde(default)]
    timeout_hint_ms: Option<u64>,
    #[serde(default)]
    #[schemars(with = "OutputRequest")]
    #[allow(dead_code)]
    output: Option<OutputRequest>,
}

// --- annotation presets (ADR 0027 §11) -------------------------------------
// `annotations` are host approval hints, NOT server-side authorization (ADR
// 0027 §8). Hosts must still gate mutating/destructive tools through their own
// approval/sandbox path.

/// Read-only, non-destructive, idempotent, closed-world.
fn read_only() -> ToolAnnotations {
    ToolAnnotations::new()
        .read_only(true)
        .destructive(false)
        .idempotent(true)
        .open_world(false)
}

fn default_true() -> bool {
    true
}

/// Mutating, destructive, non-idempotent, closed-world
/// (write/replace/copy/move/remove/update/delete/compact).
fn mutating_destructive() -> ToolAnnotations {
    ToolAnnotations::new()
        .read_only(false)
        .destructive(true)
        .idempotent(false)
        .open_world(false)
}

/// Mutating but additive (non-destructive) and idempotent (`mkdir`).
fn mutating_additive() -> ToolAnnotations {
    ToolAnnotations::new()
        .read_only(false)
        .destructive(false)
        .idempotent(true)
        .open_world(false)
}

/// Mutating, terminal-decision and idempotent: the decision happens once and
/// replays return the recorded terminal state (`memory_review`).
fn review_terminal() -> ToolAnnotations {
    ToolAnnotations::new()
        .read_only(false)
        .destructive(true)
        .idempotent(true)
        .open_world(false)
}

/// Mutating, destructive, non-idempotent, open-world (process_run, project_run).
fn mutating_open_world() -> ToolAnnotations {
    ToolAnnotations::new()
        .read_only(false)
        .destructive(true)
        .idempotent(false)
        .open_world(true)
}

/// Adapter that bridges rmcp's `CancellationToken` (from `RequestContext.ct`)
/// onto the toolkit's runtime-agnostic [`Cancellation`] trait. Without this,
/// `dispatch` dropped the `RequestContext` and built a `NoCancellation`
/// context, so MCP `notifications/cancelled` never reached `process_run` /
/// traversals and the direct child kept running (review P1).
struct RmcpCancellation {
    token: CancellationToken,
    deadline_expired: Option<Arc<AtomicBool>>,
}

impl Cancellation for RmcpCancellation {
    #[inline]
    fn is_cancelled(&self) -> bool {
        self.token.is_cancelled()
            || self
                .deadline_expired
                .as_ref()
                .is_some_and(|expired| expired.load(Ordering::Acquire))
    }
}

/// Per-dispatch cancellation scope. A timeout hint is deliberately an MCP
/// concern: the toolkit remains free of server deadlines, while this scope
/// cancels through the same token that user cancellation already uses.
struct DispatchCancellation {
    user_token: CancellationToken,
    effective_token: CancellationToken,
    deadline_expired: Option<Arc<AtomicBool>>,
    timeout_hint_ms: Option<u64>,
    timer: Option<tokio::task::JoinHandle<()>>,
}

impl DispatchCancellation {
    fn new(user_token: CancellationToken, timeout_hint_ms: Option<u64>) -> Self {
        let Some(timeout_hint_ms) = timeout_hint_ms else {
            return Self {
                effective_token: user_token.clone(),
                user_token,
                deadline_expired: None,
                timeout_hint_ms: None,
                timer: None,
            };
        };

        let effective_token = user_token.child_token();
        let deadline_expired = Arc::new(AtomicBool::new(false));
        let timer_expired = Arc::clone(&deadline_expired);
        let timer_token = effective_token.clone();
        let timer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(timeout_hint_ms)).await;
            if !timer_token.is_cancelled() {
                timer_expired.store(true, Ordering::Release);
                timer_token.cancel();
            }
        });

        Self {
            user_token,
            effective_token,
            deadline_expired: Some(deadline_expired),
            timeout_hint_ms: Some(timeout_hint_ms),
            timer: Some(timer),
        }
    }

    fn handle(&self) -> Arc<dyn Cancellation> {
        Arc::new(RmcpCancellation {
            token: self.effective_token.clone(),
            deadline_expired: self.deadline_expired.clone(),
        })
    }

    #[allow(clippy::result_large_err)]
    fn map_result<T>(
        &self,
        result: Result<T, xuanling_toolkit::ToolError>,
    ) -> Result<T, xuanling_toolkit::ToolError> {
        let Err(mut error) = result else {
            return result;
        };
        let deadline_triggered = self
            .deadline_expired
            .as_ref()
            .is_some_and(|expired| expired.load(Ordering::Acquire));
        if error.code == xuanling_toolkit::ToolErrorCode::Cancelled
            && deadline_triggered
            && !self.user_token.is_cancelled()
        {
            error.code = xuanling_toolkit::ToolErrorCode::DeadlineExceeded;
            error.message = "soft timeout hint expired; operation cancelled".to_string();
            error.details = serde_json::json!({
                "reason": "soft_timeout",
                "timeout_hint_ms": self.timeout_hint_ms,
            });
        }
        Err(error)
    }
}

impl Drop for DispatchCancellation {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            timer.abort();
        }
    }
}

const TIMEOUT_HINT_TOOLS: &[&str] = &[
    "process_run",
    "project_run",
    "process_pipeline",
    "session_exec",
];

#[allow(clippy::result_large_err)]
fn parse_timeout_hint(
    name: &str,
    arguments: &Value,
) -> Result<Option<u64>, xuanling_toolkit::ToolError> {
    if !TIMEOUT_HINT_TOOLS.contains(&name) {
        return Ok(None);
    }
    let Some(value) = arguments.get("timeout_hint_ms") else {
        return Ok(None);
    };
    let Some(timeout_hint_ms) = value.as_u64() else {
        return Err(xuanling_toolkit::ToolError::new(
            xuanling_toolkit::ToolErrorCode::InvalidInput,
            "process.timeout_hint",
            "timeout_hint_ms must be a positive unsigned integer",
        ));
    };
    if timeout_hint_ms == 0 {
        return Err(xuanling_toolkit::ToolError::new(
            xuanling_toolkit::ToolErrorCode::InvalidInput,
            "process.timeout_hint",
            "timeout_hint_ms must be greater than zero",
        ));
    }
    Ok(Some(timeout_hint_ms))
}

/// Dispatch a `tools/call` to the matching toolkit operation.
///
/// The cancellation token on `rmcp_ctx.ct` is threaded into the toolkit
/// `InvocationContext` so long-running tools (`process_run`, `project_run`,
/// recursive fs traversals) observe MCP `notifications/cancelled`.
pub async fn dispatch(
    name: &str,
    arguments: &Value,
    rmcp_ctx: &RequestContext<RoleServer>,
    memory: Option<&xuanling_memory::MemoryStore>,
    path_context: &PathContext,
    filesystem_scope: &FilesystemScope,
    default_namespace: Option<&str>,
) -> Result<CallToolResult, McpError> {
    let timeout_hint_ms = match parse_timeout_hint(name, arguments) {
        Ok(value) => value,
        Err(error) => return run::<Value>(Err(error)),
    };
    let cancellation = DispatchCancellation::new(rmcp_ctx.ct.clone(), timeout_hint_ms);
    let mut tk_ctx = InvocationContext::new(path_context.clone())
        .with_cancellation(cancellation.handle())
        .with_filesystem_scope(filesystem_scope.clone());
    if let Some(ns) = default_namespace {
        tk_ctx = tk_ctx.with_default_namespace(ns);
    }
    // For namespace-bearing memory tools, inject the CLI `--default-namespace`
    // when the caller omits `namespace`, so the documented flag actually takes
    // effect (review P1 round 2: previously the flag was parsed but never
    // consulted, so omitting namespace returned -32602).
    let ns_args = args_with_default_namespace(arguments, default_namespace);
    let output_mode = parse_output_for_call(name, arguments)?;

    match name {
        "system_info" => {
            let _req: SystemInfoRequest = decode(arguments)?;
            run(tk_system::info(&tk_ctx))
        }
        "path_resolve" => {
            let req: PathResolveRequest = decode(arguments)?;
            run(tk_path::resolve(&tk_ctx, &req))
        }
        "path_relative" => {
            let req: PathRelativeRequest = decode(arguments)?;
            run(tk_path::relative(&tk_ctx, &req))
        }
        // --- filesystem (W2) ---
        "fs_stat" => run(tk_fs::fs_stat(
            &tk_ctx,
            &decode::<FsStatRequest>(arguments)?,
        )),
        "fs_list" => {
            let call = decode::<FsListCall>(arguments)?;
            run(tk_fs::fs_list(
                &tk_ctx,
                &FsListRequest {
                    path: call.path,
                    base_dir: call.base_dir,
                    recursive: call.recursive,
                    max_depth: call.max_depth,
                    limit: call.limit,
                    cursor: call.cursor,
                    include_hidden: call.include_hidden,
                    respect_gitignore: call.respect_gitignore,
                    follow_symlinks: call.follow_symlinks,
                    max_output_bytes: output_mode.max_bytes(),
                },
            ))
        }
        "fs_read_text" => {
            let call = decode::<FsReadTextCall>(arguments)?;
            run(tk_fs::read_text(
                &tk_ctx,
                &FsReadTextRequest {
                    path: call.path,
                    base_dir: call.base_dir,
                    start_line: call.start_line,
                    end_line: call.end_line,
                    include_sha256: call.include_sha256,
                    known_sha256: call.known_sha256,
                    format: call.format,
                    max_bytes: output_mode.max_bytes_for_text(),
                    resume: call.resume,
                },
            ))
        }
        "artifact_read" => {
            let call = decode::<ArtifactReadCall>(arguments)?;
            let length = output_mode.cap_optional_window(call.length);
            run(tk_process::artifact_read(&ArtifactReadRequest {
                id: call.id,
                read_capability: call.read_capability,
                offset: call.offset,
                length,
            }))
        }
        "artifact_cleanup_preview" => {
            let _: ArtifactCleanupCall = decode(arguments)?;
            run(tk_process::artifact_cleanup(&ArtifactCleanupRequest {
                dry_run: true,
            }))
        }
        "artifact_cleanup" => {
            let _: ArtifactCleanupCall = decode(arguments)?;
            run(tk_process::artifact_cleanup(&ArtifactCleanupRequest {
                dry_run: false,
            }))
        }
        "fs_read_bytes" => {
            let call = decode::<FsReadBytesCall>(arguments)?;
            let length = output_mode.cap_optional_window(call.length);
            run(tk_fs::read_bytes(
                &tk_ctx,
                &FsReadBytesRequest {
                    path: call.path,
                    base_dir: call.base_dir,
                    offset: call.offset,
                    length,
                    include_sha256: call.include_sha256,
                    known_sha256: call.known_sha256,
                    resume: call.resume,
                },
            ))
        }
        "fs_search" => {
            // A caller can combine an item limit with the public byte budget;
            // the stricter constraint wins. Omission uses the v3 safe default.
            let call = decode::<FsSearchCall>(arguments)?;
            let req = FsSearchRequest {
                path: call.path,
                pattern: call.pattern,
                literal: call.literal,
                case_sensitive: call.case_sensitive,
                limit: call.limit,
                cursor: call.cursor,
                max_output_bytes: output_mode.max_bytes(),
            };
            let options = FsSearchOptions {
                include_hidden: call.include_hidden,
                respect_gitignore: call.respect_gitignore,
                include_globs: call.include_globs,
                exclude_globs: call.exclude_globs,
                file_extensions: call.file_extensions,
                group_by_line: call.group_by_line,
            };
            run(tk_fs::search_with_options(&tk_ctx, &req, &options))
        }
        "fs_glob" => {
            let call = decode::<FsGlobCall>(arguments)?;
            let req = FsGlobRequest {
                path: call.path,
                patterns: call.patterns,
                include_files: call.include_files,
                include_dirs: call.include_dirs,
                limit: call.limit,
                cursor: call.cursor,
                max_output_bytes: output_mode.max_bytes(),
            };
            run(tk_fs::glob(&tk_ctx, &req))
        }
        "fs_hash" => run(tk_fs::fs_hash(
            &tk_ctx,
            &decode::<FsHashRequest>(arguments)?,
        )),
        "fs_mkdir" => run(tk_fs::fs_mkdir(
            &tk_ctx,
            &decode::<FsMkdirRequest>(arguments)?,
        )),
        "fs_write_text" => run(tk_fs::fs_write_text(
            &tk_ctx,
            &decode::<FsWriteTextRequest>(arguments)?,
        )),
        "fs_replace_text" => run(tk_fs::fs_replace_text(
            &tk_ctx,
            &decode::<FsReplaceTextRequest>(arguments)?,
        )),
        "fs_patch" => run(tk_fs::fs_patch(
            &tk_ctx,
            &decode::<FsPatchRequest>(arguments)?,
        )),
        "fs_edit_preview" => {
            let call = decode::<FsEditPreviewCall>(arguments)?;
            run(tk_fs::fs_edit(
                &tk_ctx,
                &FsEditRequest {
                    path: call.path,
                    old: call.old,
                    new: call.new,
                    replace_all: call.replace_all,
                    base_dir: call.base_dir,
                    expected_sha256: call.expected_sha256,
                    dry_run: true,
                    reversible: false,
                    include_diff: call.include_diff,
                },
            ))
        }
        "fs_edit" => {
            let call = decode::<FsEditApplyCall>(arguments)?;
            run(tk_fs::fs_edit(
                &tk_ctx,
                &FsEditRequest {
                    path: call.path,
                    old: call.old,
                    new: call.new,
                    replace_all: call.replace_all,
                    base_dir: call.base_dir,
                    expected_sha256: call.expected_sha256,
                    dry_run: false,
                    reversible: call.reversible,
                    include_diff: call.include_diff,
                },
            ))
        }
        "change_rollback" => {
            let req = decode::<ChangeOpSchema>(arguments)?;
            run_async(
                async move {
                    let state = tk_fs::changeset_rollback_with_context(&tk_ctx, &req.change_id)?;
                    Ok(ChangeOpResult {
                        change_id: req.change_id,
                        state: state.as_str().to_string(),
                    })
                },
                &cancellation,
            )
            .await
        }
        "change_commit" => {
            let req = decode::<ChangeOpSchema>(arguments)?;
            run_async(
                async move {
                    let state = tk_fs::changeset_commit_with_context(&tk_ctx, &req.change_id)?;
                    Ok(ChangeOpResult {
                        change_id: req.change_id,
                        state: state.as_str().to_string(),
                    })
                },
                &cancellation,
            )
            .await
        }
        "fs_copy" => run(tk_fs::fs_copy(
            &tk_ctx,
            &decode::<FsCopyRequest>(arguments)?,
        )),
        "fs_move" => run(tk_fs::fs_move(
            &tk_ctx,
            &decode::<FsMoveRequest>(arguments)?,
        )),
        "fs_remove" => run(tk_fs::fs_remove(
            &tk_ctx,
            &decode::<FsRemoveRequest>(arguments)?,
        )),
        // --- process / project (W3) ---
        "process_which" => run(tk_process::process_which(&decode::<ProcessWhichRequest>(
            arguments,
        )?)),
        "process_run" => {
            // ADR 0027 §7.1: translate `output` into a per-stream
            // `preview_max_bytes` (bounded -> tee preview + complete artifact).
            let call = decode::<ProcessRunCall>(arguments)?;
            debug_assert_eq!(call.timeout_hint_ms, timeout_hint_ms);
            let req = ProcessRunRequest {
                program: call.program,
                args: call.args,
                cwd: call.cwd,
                env: call.env,
                remove_env: call.remove_env,
                inherit_env: call.inherit_env,
                deterministic: call.deterministic,
                stdin: call.stdin,
                stdout: call.stdout,
                stderr: call.stderr,
                preview_max_bytes: output_mode.preview_max_bytes_for_process(),
            };
            run_async(tk_process::process_run(&tk_ctx, &req), &cancellation).await
        }
        "project_detect" => run(tk_process::project_detect(
            &tk_ctx,
            &decode::<ProjectDetectRequest>(arguments)?,
        )),
        "project_command" => run(tk_process::project_command(
            &tk_ctx,
            &decode::<ProjectCommandRequest>(arguments)?,
        )),
        "project_run" => {
            let call = decode::<ProjectRunCall>(arguments)?;
            debug_assert_eq!(call.timeout_hint_ms, timeout_hint_ms);
            let req = ProjectRunRequest {
                project_path: call.project_path,
                action: call.action,
                target: call.target,
                extra_args: call.extra_args,
                base_dir: call.base_dir,
                inherit_env: call.inherit_env,
                deterministic: call.deterministic,
                stdout: call.stdout,
                stderr: call.stderr,
                preview_max_bytes: output_mode.preview_max_bytes_for_process(),
            };
            run_async(tk_process::project_run(&tk_ctx, &req), &cancellation).await
        }
        "process_pipeline" => {
            let call = decode::<ProcessPipelineCall>(arguments)?;
            debug_assert_eq!(call.timeout_hint_ms, timeout_hint_ms);
            let stages = match (call.stages, call.pipeline_shlex) {
                (Some(stages), None) if !stages.is_empty() => Ok(stages),
                (None, Some(notation)) => tk_process::parse_pipeline_shlex(&notation),
                (Some(_), Some(_)) => Err(xuanling_toolkit::ToolError::new(
                    xuanling_toolkit::ToolErrorCode::InvalidInput,
                    "process.pipeline.parse",
                    "provide exactly one of stages or pipeline_shlex",
                )),
                (Some(_), None) | (None, None) => Err(xuanling_toolkit::ToolError::new(
                    xuanling_toolkit::ToolErrorCode::InvalidInput,
                    "process.pipeline.parse",
                    "provide a non-empty stages array or pipeline_shlex",
                )),
            };
            let stages = match stages {
                Ok(stages) => stages,
                Err(error) => return run::<ProcessPipelineResult>(Err(error)),
            };
            run_async(
                tk_process::process_pipeline(
                    &tk_ctx,
                    &ProcessPipelineRequest {
                        stages,
                        stdin: call.stdin,
                        stdout: call.stdout,
                        preview_max_bytes: output_mode.preview_max_bytes_for_process(),
                        deterministic: call.deterministic,
                    },
                ),
                &cancellation,
            )
            .await
        }
        "session_open" => run(tk_process::session_open(
            &tk_ctx,
            &decode::<SessionOpenRequest>(arguments)?,
        )),
        "session_exec" => {
            let call = decode::<SessionExecCall>(arguments)?;
            debug_assert_eq!(call.timeout_hint_ms, timeout_hint_ms);
            run_async(
                tk_process::session_exec(
                    &tk_ctx,
                    &SessionExecRequest {
                        session_id: call.session_id,
                        program: call.program,
                        args: call.args,
                        stdin: call.stdin,
                        stdout: call.stdout,
                        stderr: call.stderr,
                        env: call.env,
                        deterministic: call.deterministic,
                        preview_max_bytes: output_mode.preview_max_bytes_for_process(),
                    },
                ),
                &cancellation,
            )
            .await
        }
        "session_close" => run(tk_process::session_close(
            &tk_ctx,
            &decode::<SessionCloseRequest>(arguments)?,
        )),
        // --- memory v2 (proposal/review; errors serialize directly, C-08) ---
        "memory_candidate_create" => {
            let store = require_memory(memory)?;
            let req = decode(&ns_args)?;
            run_memory_async(async { store.candidate_create(&req).await }).await
        }
        "memory_candidate_replace" => {
            let store = require_memory(memory)?;
            let req = decode(&ns_args)?;
            run_memory_async(async { store.candidate_replace(&req).await }).await
        }
        "memory_candidate_archive" => {
            let store = require_memory(memory)?;
            let req = decode(&ns_args)?;
            run_memory_async(async { store.candidate_archive(&req).await }).await
        }
        "memory_candidate_get" => {
            let store = require_memory(memory)?;
            let req = decode(&ns_args)?;
            run_memory_async(async { store.candidate_get(&req).await }).await
        }
        "memory_candidate_list" => {
            let store = require_memory(memory)?;
            let req = decode(&ns_args)?;
            run_memory_async(async { store.candidate_list(&req).await }).await
        }
        "memory_review" => {
            let store = require_memory(memory)?;
            let req = decode(&ns_args)?;
            run_memory_async(async { store.review(&req).await }).await
        }
        "memory_get" => {
            let store = require_memory(memory)?;
            let req = decode(&ns_args)?;
            run_memory_async(async { store.record_get(&req).await }).await
        }
        "memory_search" => {
            let store = require_memory(memory)?;
            let req = decode(&ns_args)?;
            run_memory_async(async { store.search_v2(&req).await }).await
        }
        "memory_feedback" => {
            let store = require_memory(memory)?;
            let req = decode(arguments)?;
            run_memory_async(async { store.feedback_event(&req).await }).await
        }
        other => Err(McpError::invalid_params(
            format!("unknown tool: {other}"),
            None,
        )),
    }
}

/// Schema + dispatch DTO for `change_rollback` / `change_commit`.
#[derive(schemars::JsonSchema, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ChangeOpSchema {
    change_id: String,
}

#[derive(schemars::JsonSchema, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ChangeOpResult {
    change_id: String,
    state: String,
}

/// Run a `xuanling-memory` operation and map its result to a structured
/// `CallToolResult`, preserving the memory domain error code verbatim (C-08):
/// the memory crate owns its error boundary; MCP does not translate codes.
fn run_memory<T: serde::Serialize>(
    result: Result<T, tk_memory::ToolError>,
) -> Result<CallToolResult, McpError> {
    match result {
        Ok(value) => {
            let json = serde_json::to_value(&value).expect("memory result serializes");
            Ok(CallToolResult::structured(json))
        }
        Err(memory_err) => {
            let payload = serde_json::to_value(&memory_err).unwrap_or(Value::Null);
            let mut result = CallToolResult::structured_error(payload.clone());
            result.content = vec![
                ContentBlock::text(memory_err.to_string()),
                ContentBlock::text(payload.to_string()),
            ];
            Ok(result)
        }
    }
}

/// Async variant of [`run_memory`] for store operations that are themselves
/// async (all memory v2 operations are).
async fn run_memory_async<T, F>(future: F) -> Result<CallToolResult, McpError>
where
    T: serde::Serialize,
    F: std::future::Future<Output = Result<T, tk_memory::ToolError>>,
{
    run_memory(future.await)
}

/// Return the memory store, or a tool-level error if none was configured.
fn require_memory(
    memory: Option<&xuanling_memory::MemoryStore>,
) -> Result<&xuanling_memory::MemoryStore, McpError> {
    memory.ok_or_else(|| {
        McpError::internal_error(
            "memory store not configured (start with --memory-db)".to_string(),
            None,
        )
    })
}

/// Run a toolkit operation and map its result to a structured `CallToolResult`.
/// `Ok(_)` success -> structured content (`is_error=false`); `Err(tool_error)`
/// domain failure -> structured error content (`is_error=true`, caller-visible).
fn run<T: serde::Serialize>(
    result: Result<T, xuanling_toolkit::ToolError>,
) -> Result<CallToolResult, McpError> {
    match result {
        Ok(value) => {
            let json = serde_json::to_value(&value).expect("toolkit result serializes");
            Ok(CallToolResult::structured(json))
        }
        Err(tool_err) => {
            let payload = serde_json::to_value(&tool_err).unwrap_or(Value::Null);
            // Domain error: isError=true with the stable structured payload in
            // BOTH `content` (human-readable text + JSON text) and
            // `structuredContent` (machine-readable `code`/`operation`/`path`/
            // `raw_os_error`) so agents can branch on `code` without scraping
            // message text (plan §5; review P1).
            let mut result = CallToolResult::structured_error(payload.clone());
            result.content = vec![
                ContentBlock::text(tool_err.to_string()),
                ContentBlock::text(payload.to_string()),
            ];
            Ok(result)
        }
    }
}

/// Async variant of [`run`] for toolkit operations that are themselves async
/// (e.g. `process_run`, `project_run`).
async fn run_async<T, F>(
    future: F,
    cancellation: &DispatchCancellation,
) -> Result<CallToolResult, McpError>
where
    T: serde::Serialize,
    F: std::future::Future<Output = Result<T, xuanling_toolkit::ToolError>>,
{
    run(cancellation.map_result(future.await))
}

/// Return the call arguments with the CLI `--default-namespace` injected when
/// the caller omitted `namespace`. Only namespace-bearing tools use the result;
/// the rest decode `arguments` unchanged. Returns a borrowed value when no
/// injection is needed (no default, or namespace already present).
fn args_with_default_namespace<'a>(
    args: &'a Value,
    default_namespace: Option<&str>,
) -> std::borrow::Cow<'a, Value> {
    use std::borrow::Cow;
    if let Some(ns) = default_namespace
        && let Value::Object(map) = args
        && !map.contains_key("namespace")
    {
        let mut m = map.clone();
        m.insert("namespace".to_string(), Value::String(ns.to_string()));
        Cow::Owned(Value::Object(m))
    } else {
        Cow::Borrowed(args)
    }
}

/// Tools whose result is a window/preview over potentially unbounded content
/// and therefore accept the ADR 0027 §2 `output` request field. Other tools do
/// not accept `output`; if a client sends it, the toolkit DTO's
/// `deny_unknown_fields` rejects it as an unknown field.
const OUTPUT_CAPABLE: &[&str] = &[
    "fs_list",
    "fs_read_text",
    "fs_read_bytes",
    "fs_search",
    "fs_glob",
    "artifact_read",
    "process_run",
    "project_run",
    "process_pipeline",
    "session_exec",
];

const DEFAULT_OUTPUT_MAX_BYTES: u64 = 65_536;

/// Parsed ADR 0027 §2 `output` request field.
#[derive(Clone, Copy, Debug)]
enum OutputMode {
    /// Explicit bounded window.
    Bounded { max_bytes: u64 },
    /// Explicit complete (full) return.
    Complete,
}

impl From<OutputRequest> for OutputMode {
    fn from(value: OutputRequest) -> Self {
        match value {
            OutputRequest::Bounded { max_bytes } => Self::Bounded { max_bytes },
            OutputRequest::Complete => Self::Complete,
        }
    }
}

impl OutputMode {
    /// Resolve a public output selection to an optional byte budget. `None`
    /// means the caller explicitly requested complete output.
    fn max_bytes(self) -> Option<u64> {
        match self {
            OutputMode::Bounded { max_bytes } => Some(max_bytes),
            OutputMode::Complete => None,
        }
    }

    /// Resolve to a toolkit `max_bytes`: `None` means a full read.
    fn max_bytes_for_text(self) -> Option<u64> {
        self.max_bytes()
    }

    /// Resolve to a per-stream `preview_max_bytes` for `process_run`/
    /// `project_run` (ADR 0027 §7.1). The MCP parser maps omitted output to the
    /// v3 safe budget; explicit complete alone preserves full-inline behavior.
    fn preview_max_bytes_for_process(self) -> Option<u64> {
        self.max_bytes()
    }

    /// Combine a tool-specific byte window with the public output budget. Both
    /// are caller constraints; when both are present the stricter one wins.
    fn cap_optional_window(self, requested: Option<u64>) -> Option<u64> {
        match (requested, self.max_bytes()) {
            (Some(requested), Some(output)) => Some(requested.min(output)),
            (Some(requested), None) => Some(requested),
            (None, Some(output)) => Some(output),
            (None, None) => None,
        }
    }
}

/// Validate + parse the ADR 0027 §2 `output` request field. The public call
/// DTO exposes this field in its schema; the toolkit remains independent of
/// MCP-specific output selection.
/// Semantics:
/// - field omitted -> conservative 64 KiB bounded output;
/// - explicit `null` -> `invalid_input` (no magic-null; ADR 0027 §2);
/// - `{"mode":"complete"}` -> `OutputMode::Complete`;
/// - `{"mode":"bounded","max_bytes":N}` -> `OutputMode::Bounded`.
fn parse_output_for_call(name: &str, args: &Value) -> Result<OutputMode, McpError> {
    if !OUTPUT_CAPABLE.contains(&name) {
        return Ok(OutputMode::Complete);
    }
    let Some(map) = args.as_object() else {
        return Ok(OutputMode::Bounded {
            max_bytes: DEFAULT_OUTPUT_MAX_BYTES,
        });
    };
    if !map.contains_key("output") {
        return Ok(OutputMode::Bounded {
            max_bytes: DEFAULT_OUTPUT_MAX_BYTES,
        });
    }
    let output = &map["output"];
    if output.is_null() {
        return Err(McpError::invalid_params(
            "invalid request arguments: `output` must not be null. \
             Use {\"mode\":\"bounded\",\"max_bytes\":N} or {\"mode\":\"complete\"}, \
             or omit `output` for the 64 KiB bounded default (contract v3)."
                .to_string(),
            None,
        ));
    }
    let mode = parse_output_mode(output)?;
    let decoded: OutputRequest = serde_json::from_value(output.clone()).map_err(|error| {
        McpError::invalid_params(
            format!("invalid request arguments: `output`: {error}"),
            None,
        )
    })?;
    let decoded_mode: OutputMode = decoded.into();
    debug_assert!(matches!(
        (&mode, &decoded_mode),
        (OutputMode::Complete, OutputMode::Complete)
            | (OutputMode::Bounded { .. }, OutputMode::Bounded { .. })
    ));
    Ok(decoded_mode)
}

/// Parse the shape of an `output` request value (ADR 0027 §2). `max_bytes=0` is
/// a legal metadata-only window.
fn parse_output_mode(v: &Value) -> Result<OutputMode, McpError> {
    let Some(obj) = v.as_object() else {
        return Err(McpError::invalid_params(
            "invalid request arguments: `output` must be an object".to_string(),
            None,
        ));
    };
    match obj.get("mode").and_then(|m| m.as_str()) {
        Some("complete") => Ok(OutputMode::Complete),
        Some("bounded") => match obj.get("max_bytes").and_then(|b| b.as_u64()) {
            Some(max_bytes) => Ok(OutputMode::Bounded { max_bytes }),
            None => Err(McpError::invalid_params(
                "invalid request arguments: `output.mode=\"bounded\" requires \
                 a non-negative integer `max_bytes` (ADR 0027 §2)"
                    .to_string(),
                None,
            )),
        },
        other => Err(McpError::invalid_params(
            format!(
                "invalid request arguments: `output.mode` must be \"bounded\" or \
                 \"complete\", got {other:?} (ADR 0027 §2)"
            ),
            None,
        )),
    }
}

/// Strict decode of the request arguments into a typed DTO. Unknown fields are
/// rejected (plan §6) so a model misspelling a field is not silently ignored.
fn decode<T: serde::de::DeserializeOwned>(args: &Value) -> Result<T, McpError> {
    serde_json::from_value(args.clone())
        .map_err(|e| McpError::invalid_params(format!("invalid request arguments: {e}"), None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use xuanling_toolkit::{ToolError, ToolErrorCode};

    #[tokio::test]
    async fn deadline_scope_maps_only_expired_cancellation() {
        let user_token = CancellationToken::new();
        let scope = DispatchCancellation::new(user_token, Some(1));
        tokio::time::sleep(Duration::from_millis(10)).await;
        let error = scope
            .map_result::<()>(Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "process.run",
                "operation cancelled",
            )))
            .expect_err("expired cancellation must remain an error");
        assert_eq!(error.code, ToolErrorCode::DeadlineExceeded);
        assert_eq!(error.details["reason"], serde_json::json!("soft_timeout"));
    }

    #[tokio::test]
    async fn user_cancellation_is_not_relabelled_as_deadline() {
        let user_token = CancellationToken::new();
        let scope = DispatchCancellation::new(user_token.clone(), Some(10_000));
        user_token.cancel();
        let error = scope
            .map_result::<()>(Err(ToolError::new(
                ToolErrorCode::Cancelled,
                "process.run",
                "operation cancelled",
            )))
            .expect_err("user cancellation must remain an error");
        assert_eq!(error.code, ToolErrorCode::Cancelled);
    }
}
