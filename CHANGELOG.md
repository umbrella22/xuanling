# Changelog

All notable release changes are recorded here. XuanLing uses immutable release
tags and publishes the launcher, native packages, DeepSeek Harness bundles, and
ZCode projection from the same source commit.

## 0.3.1 - 2026-08-31

This patch release repairs the DeepSeek Harness integration shipped in `0.3.0`.
The generic MCP contract remains `3`, the persisted Memory contract remains `2`,
and no database migration is required.

### Fixed

- All three DSH runtime bundles now mount a bundle-owned lazy projection around
  the official MCP bridge. A fresh model turn initially sees only
  `mcp_catalog__xuanling`; an exact catalog activation then registers one
  `mcp__xuanling__<raw>` tool without dropping DSH-native tools.
- Lazy activations survive official-bridge generation replacement, preserve
  every frozen XuanLing tool name without normalization or truncation, and are
  explicitly removed during bundle teardown.
- The SQLite FTS5/trigram capability probe now uses the connection-local
  `temp` schema. Opening an existing Memory v2 database for a read-only runtime
  smoke no longer creates and drops a table in the durable main database.

### Upgrade Notes

- `0.3.0` remains immutable but did not satisfy the required DSH lazy-runtime
  acceptance. DSH users should install the exact `0.3.1` runtime and Skills
  packages together, restart the selected profile, then discover and activate
  the required XuanLing tool through `mcp_catalog__xuanling`.
- ZCode and direct MCP users should upgrade the launcher and matching native
  package together so every host resolves the same repaired source commit.

## 0.3.0 - 2026-08-31

This is a breaking generic MCP contract upgrade. The generic contract version
is now `3`; the persisted Memory contract remains `2` and requires no database
migration.

### Breaking Changes

- Omitting `output` now applies a 65,536-byte safe budget. Callers that require
  an unbounded result must explicitly send `{"mode":"complete"}`.
- `project_run` no longer maps `check` to `build`. Resolution now prefers an
  exact same-name project script, then a proven ecosystem convention, and
  otherwise returns typed `unsupported` without spawning a fallback command.
- `format_check` no longer selects known source-mutating commands such as
  `go fmt`.

### Added

- `fs_read_text(format="numbered")` renders minimum-width-six, absolute
  1-based line numbers followed by a tab. Resume offsets remain absolute raw
  file byte offsets.
- `fs_read_text` and `fs_read_bytes` accept `known_sha256` and return
  metadata-only `not_modified` results when content is unchanged.
- `fs_edit` and `fs_edit_preview` accept `include_diff`; it defaults to `true`.
  DSH and ZCode keep tool diff output enabled until each host has independently
  verified native diff visibility.
- `project_run` reports the resolved program, arguments, ecosystem, action, and
  reason. Minimal-environment spawn failures now include non-secret remediation
  for explicitly opting into `inherit_env: true`.

### Host Integrations

- DeepSeek Harness and ZCode ship the same v3 bounded-read, numbered-read,
  conditional-read, project-resolution, environment, SHA, and diff-visibility
  guidance.
- The historical DSH replacement bundle now preserves native filesystem tools,
  `read_image`, read-before-edit observation, and editor UI. New full-catalog
  installs should use the additive tools bundle.
- DSH runtime rows have package-specific identities, full-tools bundles require
  an explicit workspace root, and the Memory-only bundle carries no filesystem
  capability root.
- Conversational DSH installation verifies launcher, native package, resolved
  binary, server version, and MCP contract coherence before reporting success.

### Upgrade Notes

- Upgrade the launcher, matching native package, DSH bundles, and ZCode plugin
  as one `0.3.0` release set, then restart the host.
- Clients that relied on omitted `output` returning complete data must add the
  explicit complete selector or consume the returned continuation.
- A SHA precondition proves integrity and concurrent-version identity; it does
  not replace semantic review of the returned diff.
