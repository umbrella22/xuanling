---
name: xuanling-mcp-replacement
description: Use when the opt-in xuanling-mcp-replace ZCode plugin is enabled and any project file must be read, created, overwritten, replaced, patched, or batch-edited. Route file work through XuanLing MCP, require current lowercase SHA-256 preconditions for existing-file mutations, preserve diff output, and handle formatter or concurrent-writer conflicts without falling back to native ZCode file tools.
---

# XuanLing MCP Replacement

Treat XuanLing as the filesystem backend while this plugin is enabled. Do not invoke ZCode native
`Read`, `Write`, `Edit`, `ApplyPatch`, or `MultiEdit`; the plugin hook deliberately denies them.
ZCode 3.10.2 qualifies this plugin's MCP tools as
`mcp__plugin_xuanling-mcp-replace_xuanling__<tool>`. The shorter names below are logical tool
suffixes; invoke the exact qualified name present in the current tool catalog.

## File workflow

1. Resolve uncertain paths with `path_resolve`, `fs_list`, `fs_glob`, or `fs_search`.
2. Read existing UTF-8 text with `fs_read_text`. Use `mode: "complete"` when the complete body is
   needed. Use `fs_hash` only when a fingerprint, rather than semantic observation, is sufficient.
3. Carry the current lowercase 64-hex SHA into the mutation. Never reuse a hash after any external
   writer, formatter, failed conflict, or intervening command could have changed the file.
4. Keep `include_diff: true` on `fs_edit` and `fs_edit_batch`. Inspect returned hashes,
   replacement counts, and diff before continuing.
5. After running a formatter, read or hash every next target again before creating another edit.

Use `fs_edit` for one exact old-to-new replacement. Use `fs_edit_batch` for ordered edits in one or
more files: every `files[]` member requires `expected_sha256`, and each later edit observes the
previous edit's in-memory result. Do not split a batch merely to bypass a conflict.

Use `fs_write_text` with `mode: "overwrite"` only with `expected_sha256`. Use `mode: "create"`
without a hash only for a path expected not to exist; do not turn an overwrite conflict into a
create request. Use `fs_replace_text` only with `expected_sha256`.

Keep `fs_patch` as a compatibility path for an already-available strict unified diff. Pass
`expected_preimage_sha256`; do not invent a diff for ordinary multi-edit work, and do not pass a
`reversible` parameter to `fs_patch`.

## Conflicts and recovery

Treat `conflict`, zero/multiple-match errors, and stale hashes as stop-and-reread signals. Never
guess a location or replay automatically. For high-risk `fs_edit` or `fs_edit_batch`, request
`reversible: true`, then call `change_commit` after review or `change_rollback` while every file
still matches its recorded after hash.

If a batch reports `recovery_failed`, inspect only its path states and hashes. Do not assume either
the before or after version won, do not log file bodies, and do not continue editing those paths
until their current contents have been read again.

## Plugin boundary

Keep the additive `xuanling-mcp` plugin disabled while this replacement plugin is enabled. The hook
blocks execution but cannot hide native tool names. It also cannot guarantee a native ZCode diff
card or native image rendering; do not describe those host capabilities as available. Disabling
this plugin removes the replacement hook and restores native tool execution.
