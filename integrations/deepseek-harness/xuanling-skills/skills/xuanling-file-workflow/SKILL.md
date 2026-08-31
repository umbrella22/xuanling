---
name: xuanling-file-workflow
description: Guides DeepSeek Harness agents in activating and choosing between harness-native file tools and the XuanLing mcp__xuanling__fs_ family. Use when mcp_catalog__xuanling or XuanLing file tools are visible and file work needs sha256/CAS guards, strict patches, complete pagination, explicit byte budgets, compound-suffix search, or deterministic repeated validation.
---

# XuanLing File Workflow

This workspace exposes two file-tool families. Pick one deliberately for each
operation; both are first-class, and neither is a fallback for the other.
Apply this workflow when the named `mcp__xuanling__fs_*` tools or
`mcp_catalog__xuanling` are visible. With the lazy DSH projection, search the
catalog and pass only the exact raw names needed for the operation in
`activate`; use the resulting `mcp__xuanling__*` definitions on the next model
request. A memory-only bundle does not provide file or process tools. An empty
catalog search is evidence to keep using the native family, not permission to
infer unavailable tools.
The stable package-relative path is
`skills/xuanling-file-workflow/SKILL.md`; do not cite a versioned DSH plugin
cache path. The MCP server may also provide the short routing policy through
`initialize.instructions` before this Skill is loaded.

## Families

- **Native file tools** (`read`, `write`, `edit`, `grep`, `glob`, ...): deeply
  integrated with the harness. They carry the read-before-edit observation
  guard, native diff/read UI cards, and the workspace sandbox policy.
- **XuanLing tools** (`mcp__xuanling__fs_*`, for example
  `mcp__xuanling__fs_read_text`, `mcp__xuanling__fs_edit`,
  `mcp__xuanling__fs_search`): typed cross-platform filesystem tools with
  sha256 preimage guards, explicit byte budgets, strict patches, and
  resumable pagination. Results are structured JSON, identical on every OS.

## Routing rules

1. If the selected XuanLing tool is not visible and
   `mcp_catalog__xuanling` is, search by capability and activate the exact raw
   name (for example `fs_search` or `fs_patch`). Do not activate a whole family
   speculatively.
2. Prefer the native file tools for routine small edits and ordinary reads:
   their observation policy and editor cards are part of the harness UX, and
   they avoid extra ceremony for one-line changes.
3. Choose the XuanLing family when the operation needs what only it provides:
   - **Hash/CAS-protected writes**: verify the file is unchanged since your
     last read with `expected_sha256` / `expected_preimage_sha256` before
     replacing or patching it.
   - **Explicit output limits**: request a bounded result with an `output`
     byte budget (`max_bytes`) and continue later through the returned
     cursor or resume token instead of truncating silently.
   - **Strict edits**: apply a verified unified diff with
     `mcp__xuanling__fs_patch` (preimage-hash guarded), or a unique-match
     replacement with `mcp__xuanling__fs_edit` / `mcp__xuanling__fs_replace_text`.
     For one file with multiple hunks, prefer `mcp__xuanling__fs_patch` in a
     single atomic call with the full preimage hash; do not split the change
     into independently committed edits or invent another batch tool.
   - **Full pagination**: list or search with a bounded window and page
     through every remaining entry with the typed cursor.
   - **Whole-file creation or replacement**: use `mode: "create"` for a new
     file. For a replacement derived from the current content, read that content
     with `mcp__xuanling__fs_read_text` (`include_sha256: true`) and use the SHA
     returned by the same read. When the complete replacement comes from an
     independently authoritative source and only needs concurrent-change
     protection, `mcp__xuanling__fs_hash` supplies a fingerprint-only CAS
     precondition; it does not mean the content was read or understood. Pass
     both `mode: "overwrite"` and `expected_sha256`. Never omit `mode`.
4. Do not use the shell tools (bash, pwsh, terminals) for any file operation
   this skill covers; the two file families are sufficient, and shell output
   is not portable evidence.
5. Read what you need, then act. Avoid re-reading a file you just verified by
   sha256; avoid issuing the same search twice without consuming the cursor.

## Schema gotchas that bite in practice

- `mcp__xuanling__fs_search` takes the search term in `pattern`; `literal` is
  a boolean, not a string. There is no `query` field.
- `mcp__xuanling__fs_glob` takes `patterns` (plural array); `*.mjs` matches
  one level only, use `**/*.mjs` to recurse.
- `mcp__xuanling__fs_search.file_extensions` uses exact simple or compound
  suffixes. Pass `d.ts` and `d.mts` directly (and simple values such as
  `java` or `.c`); never reduce a compound suffix to its last `ts` or `mts`
  segment, which would broaden the search.
- `mcp__xuanling__fs_search` returns one item per occurrence by default. Pass
  `group_by_line: true` for one item per source line; every occurrence then
  appears in that item's `occurrences[]`, and both `limit` and the cursor count
  matching lines. The grouping flag is query-bound and must stay unchanged when
  paging.
- The `output` selector of any window-capable tool is a tagged object such as
  `{"mode":"bounded","max_bytes":65536}` — never a number or a bare string.

## MCP v3 request contract

With MCP contract v3, omitting `output` selects the bounded 65,536-byte
default and preserves a typed continuation when more data exists. Request the
entire result only with the explicit `{"mode":"complete"}` selector; omission
is no longer an unbounded opt-in.

For source inspection, call `fs_read_text` with `format: "numbered"` to obtain
absolute 1-based line numbers aligned for stable citations. A `TextResume`
offset always remains in raw-file byte space even though the rendered prefixes
consume the output budget; never calculate a resume offset from numbered text.

For repeated reads, send the prior `known_sha256` to both `fs_read_text` and
`fs_read_bytes`. An unchanged response has `not_modified: true`, keeps
`sha256`, and returns `total_lines` for text or `total_bytes` for bytes without
replaying the body; a changed file returns its new body and hash normally.

Until a DSH native diff card for XuanLing edits is independently verified,
keep `include_diff: true` and do not pass `include_diff: false`. The server's
tool diff remains the model-visible semantic review channel; this requirement
does not claim that the current host has an unpublished request hook.

A SHA precondition proves integrity and concurrent-version identity, not edit
semantic correctness. A unique-match edit can still uniquely hit the wrong
location, so inspect the returned diff before accepting the change; never
describe before/after hashes as a substitute for that review.

For `project_run`, resolver priority is the exact same-name user script, then a
proven non-mutating ecosystem convention, then typed `unsupported`. A `check`
action never falls back to `build`; on a pre-v3 runtime, use direct-argv
`process_run` for the literal package script instead of relying on the old
project resolver.

`process_run` and `project_run` retain the minimal environment with
`inherit_env: false` by default. If the program cannot be found, read the
non-secret remediation and retry with `inherit_env: true` only when inheriting
the login environment is explicitly acceptable; diagnostics must not reveal
secret or environment values.

`mcp__xuanling__system_info` includes `xuanling_version` and
`mcp_contract_version`; use them to detect a stale server/Skill pairing before
relying on a newly documented field. The handshake `serverInfo.version` is the
authoritative release identity.

## Verification

For repeated validation with the same argv through `mcp__xuanling__process_run`,
`mcp__xuanling__project_run`, or `mcp__xuanling__process_pipeline`, pass
`deterministic: true`. This omits volatile duration fields so results can be
byte-stable; it does not cache or skip command execution.

For a bounded synchronous validation, the process/project/pipeline/session tools
accept an optional `timeout_hint_ms` soft deadline. Expiry follows process-tree
cancellation and returns typed `deadline_exceeded`; user cancellation remains
`cancelled`. For a long build, test suite, or watch process whose lifecycle should
outlive one MCP call, use the Harness-native background/job mechanism. Do not
fabricate timeout loops, sleep loops, or shell wrappers around a synchronous call.

## Failure handling

- `XUANLING_FS_OVERWRITE_REQUIRES_SHA256` means the DSH policy stopped an
  unsafe whole-file replacement before MCP dispatch. Read or hash the file,
  reconstruct the intended content from that current version, and retry with
  `expected_sha256`. Do not switch to `mode: "create"` for an existing file.
- Treat every typed tool error as information: a duplicate-match error means
  supply more context or an explicit replace-all decision; a conflict means
  the file changed under you, so re-read and rebuild the edit. When an edit has
  multiple matches, the server returns their locations and performs zero writes;
  never guess a location.
- You must not silently fall back to the other family when a tool fails.
  Surface the error, correct the request, and retry within the same family;
  switching families because of a failure needs a stated reason.
- The XuanLing server enforces a workspace root. Paths outside it are denied
  by design; fix the path instead of escalating.

When a task is limited to dirty or untracked files, keep Git discovery separate
from filesystem search: use direct-argv Git commands to collect unstaged,
staged, and untracked repository-relative paths, deduplicate them, then pass
those paths as `include_globs` to `mcp__xuanling__fs_search`. Do not construct a
shell pipeline or change the search options while consuming its cursor.
