---
name: xuanling-file-workflow
description: Guides DeepSeek Harness agents in choosing between harness-native file tools and a visible XuanLing mcp__xuanling__fs_ family. Use when both families are available and file work needs sha256/CAS guards, strict patches, complete pagination, explicit byte budgets, compound-suffix search, or deterministic repeated validation.
---

# XuanLing File Workflow

This workspace exposes two file-tool families. Pick one deliberately for each
operation; both are first-class, and neither is a fallback for the other.
Apply this workflow only when the named `mcp__xuanling__fs_*` tools are
visible. A memory-only bundle does not provide file or process tools; keep
using the native family there instead of inferring unavailable tools.

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

1. Prefer the native file tools for routine small edits and ordinary reads:
   their observation policy and editor cards are part of the harness UX, and
   they avoid extra ceremony for one-line changes.
2. Choose the XuanLing family when the operation needs what only it provides:
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
     file. To replace an existing file, obtain its hash with
     `mcp__xuanling__fs_read_text` (`include_sha256: true`) or
     `mcp__xuanling__fs_hash`, then pass both `mode: "overwrite"` and the
     returned `expected_sha256`. Never omit `mode` for a whole-file write.
3. Do not use the shell tools (bash, pwsh, terminals) for any file operation
   this skill covers; the two file families are sufficient, and shell output
   is not portable evidence.
4. Read what you need, then act. Avoid re-reading a file you just verified by
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
- The `output` selector of any window-capable tool is a tagged object such as
  `{"mode":"bounded","max_bytes":65536}` — never a number or a bare string.

## Verification

For repeated validation with the same argv through `mcp__xuanling__process_run`,
`mcp__xuanling__project_run`, or `mcp__xuanling__process_pipeline`, pass
`deterministic: true`. This omits volatile duration fields so results can be
byte-stable; it does not cache or skip command execution.

For a long build, test suite, or watch process that may exceed the MCP call
deadline, use the Harness-native background/job mechanism. Do not fabricate
timeouts, sleep loops, or shell wrappers around a synchronous XuanLing call.

## Failure handling

- `XUANLING_FS_OVERWRITE_REQUIRES_SHA256` means the DSH policy stopped an
  unsafe whole-file replacement before MCP dispatch. Read or hash the file,
  reconstruct the intended content from that current version, and retry with
  `expected_sha256`. Do not switch to `mode: "create"` for an existing file.
- Treat every typed tool error as information: a duplicate-match error means
  supply more context or an explicit replace-all decision; a conflict means
  the file changed under you, so re-read and rebuild the edit.
- You must not silently fall back to the other family when a tool fails.
  Surface the error, correct the request, and retry within the same family;
  switching families because of a failure needs a stated reason.
- The XuanLing server enforces a workspace root. Paths outside it are denied
  by design; fix the path instead of escalating.
