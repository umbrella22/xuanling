---
name: xuanling-mcp-tools
description: Use the XuanLing MCP server's typed tools for cross-platform filesystem search/read/list/write, direct-argv process execution (no shell dialect), project ecosystem detection, proposal/review shared lexical memory, and long-lived sessions. Prefer these over grep/findstr/Select-String or hand-rolled shell when the result must be identical across Linux/macOS/Windows, when output must be bounded with a resumable cursor, or when a cross-session memory store is needed.
---

# XuanLing MCP Tools

A local stdio MCP server exposing a fixed catalog of typed tools that behave identically on Linux, macOS, and
Windows. No `grep`/`findstr`/`Select-String` translation — the same `tools/call` payload returns the
same structured result on every OS.

The server is contributed by the `xuanling-mcp` plugin. Tools appear as
`mcp__plugin_xuanling-mcp_xuanling__<tool>` (e.g. `...__system_info`,
`...__fs_search`). The filesystem capability boundary is the current project
(`--workspace-root ${CLAUDE_PROJECT_DIR}`); relative paths resolve under it.
The stable packaged Skill path is `skills/xuanling-mcp-tools/SKILL.md`; do not
reference a versioned plugin-cache directory. Hosts may also expose the short
routing policy through MCP `initialize.instructions` before loading this file.

## When to use these vs. shell

- **Cross-OS identical results** — `fs_search` returns the same JSON everywhere; no shell retry.
- **Explicit bounds** — pass `output: {"mode":"bounded","max_bytes":N}` to cap a result; truncated
  results carry a typed `next_cursor` / resume token, never a silent cut. Omitted `output` means
  **complete** (no byte budget) — bounded is opt-in, not the default.
- **Direct argv, no shell** — `process_run` passes exact args; there is no shell layer, no command
  string splitting, no metacharacter translation.
- **Shared lexical memory** — SQLite-backed FTS recall (unicode61 + trigram, RRF-merged) works
  without an embedding model; Chinese/mixed text needs no download. Cross-project, cross-client.

## Tool groups

### Filesystem
`fs_stat` `fs_list` `fs_read_text` `fs_read_bytes` `fs_search` `fs_glob` `fs_hash` `fs_mkdir`
`fs_write_text` `fs_replace_text` `fs_patch` `fs_edit` `fs_copy` `fs_move` `fs_remove`

Prefer the host's native Read/Edit tools for routine small edits and ordinary reads so their
read-before-edit observation and UI remain active. Choose XuanLing for cross-OS structured
results, complete pagination, explicit output budgets, or hash/CAS-protected writes.

To replace an existing file, obtain its hash with `fs_read_text` or `fs_hash`, then call
`fs_write_text` with `mode: "overwrite"` and `expected_sha256`. Use `mode: "create"` only for a
new path; never turn an overwrite conflict into a create call.

For multiple hunks in the same file, use `fs_patch` in a single atomic call with
`expected_preimage_sha256`. Do not split the operation into independently committed edits or
invent another batch tool.

Schema gotchas learned from live use:
- **`fs_search`**: the search term goes in `pattern`; `literal` is a **boolean** (treat `pattern`
  as literal text, not regex) — there is **no `query` field**, and passing a string to `literal`
  is rejected with `expected a boolean`. Example:
  `{ path: "docs", pattern: "XuanLing", literal: true, limit: 5 }` searches file contents under
  `docs` and returns `line`/`column`/`match`/`line_text` plus `next_cursor` when `has_more`.
  The default counts each regex occurrence. Set `group_by_line: true` when the agent needs one
  result per source line; that result keeps the first occurrence fields for compatibility and adds
  `occurrences[]` with every `{ column, match }` on the line. In grouped mode `limit` and the
  cursor position count lines, and `group_by_line` is part of the cursor-bound query.
- **`fs_search.file_extensions`**: values are exact simple or compound suffixes. Pass `d.ts` and
  `d.mts` directly (or simple values such as `java` and `.c`); never reduce a compound suffix to
  its last `ts` or `mts` segment, which would broaden the search.
- **`fs_glob`**: uses `patterns` (**array, plural**), not `pattern`. Options `include_files` /
  `include_dirs` are booleans. `*.mjs` matches top level only; use `**/*.mjs` to recurse.
- **`fs_read_text`**: returns `sha256`, `total_bytes`, `total_lines`, `newline_style`, `truncated`.
  Omit `start_line`/`end_line` to read whole (complete by default); `start_line`/`end_line` are
  1-based and inclusive. See **Using fs_read_text well** below for when to prefer it over the
  host's native Read.
- **`fs_list`**: returns `entries[]` + `returned_item_bytes` + `has_more` + `next_cursor`.
- `fs_edit` is precise old→new (ADR 0027 §8.2); `fs_patch` applies a strict unified diff
  (ADR 0013 v2) with `expected_preimage_sha256`. A non-unique `fs_edit`/`fs_patch` match is a
  typed conflict: the server returns every line/column location and performs **zero writes**;
  never guess a location or fall back to a broad replacement. Both support reversible ChangeSets
  → `change_commit` / `change_rollback`.

### Process / Project
`process_which` `process_run` `project_detect` `project_command` `project_run` `process_pipeline`

- **`process_run`**: `{ program, args[], cwd, env, stdin, stdout, stderr, timeout_hint_ms }`.
  Direct argv — **no shell**. `timeout_hint_ms` is an optional MCP soft deadline; it follows
  the normal cancellation and descendant cleanup path, while omitting it preserves the
  toolkit's no-default-deadline contract. Nonzero exit is a *successful* call
  (`isError=false`, `success=false`), not an error.
- **`process_pipeline`**: provide either explicit argv `stages` (ADR 0027 §9.1) or the
  convenience `pipeline_shlex` string, never both. Each explicit stage is `{ program, args, cwd }`.
  `pipeline_shlex` supports whitespace, quotes, backslash escapes, and `|`; it is parsed into
  argv stages without a shell, so `$`, backticks, redirection, and control operators are not
  executed. Use it for concise pipes, or explicit stages when per-stage env/cwd matters:
  `pipeline_shlex: "sort -u | wc -l", stdin: "<input text>"`.
- **`project_detect`**: **requires `path`** (e.g. `"."`). Returns `ecosystems`, `markers`,
  `toolchains`.
- **`project_command`**: resolves a project action (`check`/`test`/`build`/`format_check`/
  `format_apply`/`lint`/...) for the detected ecosystem into an argv; `project_run` executes it.

### Session
`session_open` `session_exec` `session_close` — a server-owned process session bound to a cwd/env
(ADR 0027 §9.2); later `session_exec` revalidates the cwd.

### Memory (proposal/review v2)
`memory_candidate_create` `memory_candidate_replace` `memory_candidate_archive`
`memory_candidate_get` `memory_candidate_list` `memory_review` `memory_get` `memory_search`
`memory_feedback`

- Records are typed (`fact`/`preference`/`procedure`/`solution`/`summary`), namespaced, and
  immutable once stored: mutations are **proposals**, and only `memory_review` (with the
  proposal-revision CAS) can approve/reject one. `memory_candidate_replace`/`_archive` target a
  record revision with CAS.
- Every candidate call needs an `idempotency_key` (same key + same payload replays the original
  result; same key + different payload is `conflict`).
- `memory_search`: dual FTS5 (unicode61 + trigram) merge via RRF; `trigram` covers CJK/partial.
- `memory_search` returns full active `MemoryRecordView` values in ranked items, not a lightweight
  manifest. Keep the first scoped query small; use `memory_get` for an exact current record.
- Shared DB at `~/.xuanling/memory.db` by default — a fact written in one project is retrievable
  in another, scoped by `namespace` and `scope` (`{"type":"global"}` / `"project"` /
  `"workspace"`).
- Maintenance: `xuanling-mcp memory export|import|rebuild-index` (JSONL v1 with SHA-256 trailer;
  import only into an EMPTY database).

#### L1/L2 single-write routing

For a project-local must-see convention needed in every session, write only the host file memory
(L1). Make zero XuanLing write and do not create a candidate for the same content.

For a cross-project, team-level, or shared fact that the user wants retained in XuanLing L2, call
`memory_search` first. If it is absent or has no match, call `memory_candidate_create` to create a
pending candidate; only a later explicit user decision may call `memory_review`.

At task begin or after a topic switch, follow an explicit L1 memory pointer with one scoped
`memory_search`. It is a pull trigger, not an instruction to search on every turn.

If recall has no match or the store is unavailable during ordinary work, continue the main task
and make zero canonical write. Do not synthesize a record or approve a pending candidate as a
fallback.

### Artifact
`artifact_read` `artifact_cleanup` — read a byte window from a server-owned process-output
artifact by **`id`** + `read_capability` (issued when process output is truncated), with
`offset`/`length`. There is **no `path` field** — artifacts are capability-protected, not files.

### Path
`path_resolve` `path_relative` — resolution-context helpers (base_dir or workspace root).

### Change / System
`change_commit` `change_rollback` (reversible ChangeSets from `fs_edit`/`fs_patch`) and
`system_info` (deterministic OS/arch/family/pointer-width/cwd plus `xuanling_version` and
`mcp_contract_version`). Use those two fields to verify that the running server matches the Skill
generation; the MCP `initialize.serverInfo.version` remains the handshake authority.

### Search only dirty or untracked files

XuanLing's filesystem core does not invoke Git, but a host can compose the tools when a task is
scoped to the current worktree delta:

1. Use direct-argv `process_run` for `git diff --name-only`, `git diff --cached --name-only`, and
   `git ls-files --others --exclude-standard`.
2. Deduplicate the returned repository-relative paths. Preserve spaces and do not build a shell
   command; use Git's `-z` form plus a NUL-aware host parser when arbitrary filenames, including
   newlines, are in scope.
3. Pass the resulting paths as `fs_search.include_globs` (and set `path` to the repository root).
   Keep the search regex, extension filters, and `group_by_line` choice unchanged across pages so
   the returned cursor remains valid.

## Using fs_read_text well (vs the host's native Read)

- Quick look at a small file you have not read yet: prefer the host's native Read (line numbers,
  per-session read dedup). `fs_read_text` is stateless and re-reads on every call.
- Prefer `fs_read_text` when:
  - you want to bound the result: pass `output: {"mode":"bounded","max_bytes":N}` and page
    through with the returned resume token, or use `start_line`/`end_line` for 1-based ranges.
  - you must verify the file did not change between reads: every result carries `sha256` — if
    the hash equals your previous read, skip the re-read (hash-based verification survives host
    restarts, unlike per-session dedup).
  - the file is not UTF-8: a typed `invalid_utf8` error tells you to switch to `fs_read_bytes`
    instead of guessing.
  - you need exact byte/line counts and the newline style before writing
    (`fs_write_text` `newline_mode`).
- The `output` selector of any window-capable tool is a tagged union OBJECT:
  `{"mode":"bounded","max_bytes":N}` or `{"mode":"complete"}`; omitted -> complete.
  It is not a number and not a bare string — a malformed `output` is the most common `-32602`.

## Determinism & model cache

- `fs_list`/`fs_search`/`fs_glob` return entries in a stable sort order and embed no timestamps:
  re-running the same request on an unchanged tree yields byte-identical JSON, which is friendly
  to host prompt caching. The `tools/list` catalog is likewise static but is transported in
  eight-tool pages; hosts must drain its opaque `nextCursor`. Initialize metadata exposes the
  complete filtered `xuanling.tool_count` and `xuanling.catalog_sha256` definition digest.
- Process results are the exception: by default `process_run`/`project_run`/`session_exec`/
  `process_pipeline` include `duration_ms`, and truncated results embed artifact ids — both vary
  per call. Pass `deterministic: true` to omit `duration_ms` so identical invocations return
  byte-identical results (truncated results still embed per-invocation artifact refs).
- Prefer re-verification by `sha256` (cheap, deterministic) over re-reading unchanged content.

## Result mapping

| Outcome | MCP expression |
| --- | --- |
| success | `isError=false` + structured content |
| domain failure (missing file, conflict) | `isError=true` + structured JSON (`code`/`operation`/`path`/`raw_os_error`) |
| protocol failure (unknown tool, bad args) | JSON-RPC error `-32602` with the expected field list |
| process nonzero exit | `isError=false`, `success=false` |

A `-32602` naming the expected fields is the server's strict schema rejecting an unknown key —
read the `expected one of ...` list it returns and resend with the correct field names.

## Long-running work

`process_run` and its project/pipeline/session variants have no default server-side timeout, but
accept an optional MCP-only `timeout_hint_ms`. A hint is a soft deadline, not a guarantee: expiry
uses the normal cancellation path and returns typed `deadline_exceeded`; user cancellation remains
`cancelled`. For long jobs (builds, installations, test suites), use the host's native
background/job mechanism when the host owns the lifecycle. Do not fabricate timeout loops or
`sh -c` wrappers, and do not claim a synchronous call can outlast the host's own deadline.

## Responsibility boundaries

The server enforces a pathname-based filesystem capability (workspace root) and bounded output.
It is **not** a child-process sandbox: a process launched via `process_run`/`pipeline`/`session`/
`project_run` can still open other paths or use the network through its own argv/scripts/libs.
Approval policy is the host's job, not the server's.
