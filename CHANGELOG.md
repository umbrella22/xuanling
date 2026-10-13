# Changelog

All notable release changes are recorded here. XuanLing uses immutable release
tags and publishes the launcher, native packages, DeepSeek Harness bundles, and
ZCode projection from the same source commit.

## 0.6.0 - 2026-10-14

### Added

- Blueprint libraries can create durable definitions from an empty library.
  New drafts receive Host-assigned IDs on first save, with idempotent creation
  and revision checks. Native Agents can use `blueprint_describe`,
  `blueprint_validate`, `blueprint_create` and `blueprint_preflight` to prepare
  complete definitions and declared resource files before explicit execution.
- Agent, Skill and MCP selectors show current DSH resources first, followed by
  blueprint resources. Host Agent presets retain structured composition, Skills
  capture their complete directories, and MCP bindings retain exact tool identities.
- Ordinary Agent tasks can select a provider, model and optional reasoning effort
  in the Inspector. Explicit selection overrides the DSH default; each Attempt
  freezes the final route and resources before dispatch and records safe diagnostics.
- Custom Host resources travel in portable ZIPs: Agent presets and MCP definitions
  use typed artifacts, and Skills include their supporting files. Only verified
  official DSH builtins omit resource bodies. Credentials and machine-specific
  values become destination binding requirements; import validates artifacts
  without activating plugins or connecting MCP servers, and re-export preserves
  those requirements.

### Changed

- Canvas editing adds drag-to-create nodes, collapsible library/Inspector panes,
  proportional corner resizing and clearer resource labels. Inspector port rows
  and resource/model controls support the save, check, run and inspect workflow.
- Advanced node JSON, resource JSON and Run inputs use a JSON editor with syntax
  highlighting, error locations, indentation, formatting and independent undo/redo.
  Formatting does not save or run. Blueprint deletion requires confirmation and
  preserves existing Run history without cancelling active Runs.
- Source input/output ports are checked during preflight; generated downstream
  values remain subject to runtime type validation. Unsupported TeamStage Agent
  preset resources are rejected before execution.
- The bilingual Blueprint README now starts with installation and practical
  canvas/native-Agent steps, including resource selection, model routing, results
  and complete ZIP migration. Legacy downgrade export is no longer offered.
- Cargo, the npm launcher/native aliases, all five DSH packages and both ZCode
  plugin manifests use the same `0.6.0` release version.

### Fixed

- Ordinary conversations without a linked blueprint show a neutral empty view.
  Switching views does not turn that empty state into a stale failure; switching
  sessions does not display the previous session's error. Real read/offline
  failures remain distinct, retain confirmed bound snapshots and support refresh.
- Portable Host artifacts reject credential-bearing URL variants and API key
  aliases while preserving ordinary non-secret configuration. Imported artifacts
  retain complete binding requirements when exported again.
- JSON editor keyboard bindings support indentation, undo/redo and focus escape
  without losing ordinary typing or IME input.
- Blueprint ping and typed capability errors report the release version, with
  the release version check also guarding the runtime constant against drift.

### Runtime and Upgrade Notes

- Native `blueprint_preflight` and `blueprint_start` accept `input` as a JSON value.
  Model-facing callers using the former `inputJson` string argument must migrate;
  browser RPC continues to use JSON text. Creation and inspection do not start Runs.
- DSH support still follows the latest official capability channel. TeamStage
  remains optional, requires an explicitly enabled native Team profile and source
  Lead, and retains its separate member/model contract. Ordinary Agent acceptance
  does not establish TeamStage or other-platform/provider acceptance.
- The generic MCP contract remains `3`, the persisted Memory contract remains `2`,
  and this release does not add a Memory database migration. Existing RunRecord
  legacy reads and backup/restore remain supported; unknown external effects
  require reviewed recovery rather than automatic replay.

## 0.5.2 - 2026-10-13

### Changed

- The Blueprint/TeamStage package is a first-class npm release item at
  `@xuanling-rs/xuanling-dsh-blueprint@0.5.2`, while its GitHub Release tarball
  and digest manifest remain available for offline or audited installation.
- Blueprint and its isolated verification harness are managed by
  `pnpm@11.28.5` with immutable `pnpm-lock.yaml` installs in CI. The former
  npm lockfiles are no longer part of the package or test surface.
- The npm publish workflow builds, verifies, publishes, and reconciles all
  nine registry items through the `npmjs` Trusted Publisher environment.

### Runtime and Upgrade Notes

- DSH support follows the latest official capability tuple only. Upstream
  breaking changes are allowed and accepted; older DSH runtimes, compatibility
  shims, downgrades, and old-profile migrations remain unsupported.
- The previously occupied `0.5.1` Blueprint npm version is immutable. This
  release uses `0.5.2` so the registry bytes and release receipt cannot drift.

## 0.5.1 - 2026-10-12

### Added

- An optional native DSH Blueprint plugin with typed graph editing, frozen
  resources, durable Runs and Attempts, scoped Agents, structured output,
  human decisions, cancellation and recovery.
- Optional `agentTask.teamStage` execution through DSH Agent Teams, with one
  native task, exact Lead/member bindings, task CAS, member evidence and
  physical artifact verification before settling the original Attempt.
- Read-only conversation views and native member navigation that preserve
  DSH's composer, drafts, streaming and approval interface across refresh and
  same-profile restart.
- A Blueprint tarball and file-digest manifest distributed as GitHub Release
  assets. The existing eight npm items and ZCode projection share version 0.5.1.
- The release workflow builds the Blueprint artifact before package tests, so
  packed-peer checks run against the current build.

### Runtime and Upgrade Notes

- DSH support follows the latest official channel providing the required
  capabilities. Every upgrade and acceptance run resolves the current exact
  package/profile tuple. Breaking upstream changes are supported; older DSH
  runtimes, compatibility shims, downgrades and old-profile migrations are not.
- Blueprint does not add a private default execution deadline. Explicit caller
  budgets and native DSH provider/tool cancellation policies still apply.
- Unknown external effects require recovery rather than automatic replay.
  Cancellation drains the full stage member set and preserves unrelated tasks.
- The generic MCP contract remains 3 and the persisted Memory contract remains
  2. XuanLing RunRecord legacy reads and backup/restore remain supported.
- Real TeamStage acceptance covers macOS/native Edge/GLM single-member
  execution. Installed multi-member/fork/cancellation/direct/PTC checks use
  deterministic models; they do not establish real provider or browser
  acceptance on other platforms.

## 0.3.2 - 2026-08-31

This patch release hardens Memory startup after the `0.3.1` live-host
acceptance. The generic MCP contract remains `3`, the persisted Memory
contract remains `2`, and no database migration is required.

### Fixed

- The stdio server now defers default Memory database path resolution and
  SQLite opening until the first valid Memory tool call. `initialize`,
  `tools/list`, filesystem/process tools, and malformed Memory requests do not
  create, migrate, or checkpoint the user's database.
- Concurrent first Memory calls share one lazy open attempt. Successful stores
  and typed open failures are cached for the server lifetime, preserving
  deterministic diagnostics without repeated migrations or retries.

### Upgrade Notes

- `0.3.1` remains immutable. Install the exact `0.3.2` launcher and matching
  DSH/Skills packages together, then restart the selected host profile.
- Maintenance commands (`memory export`, `memory import`, and
  `memory rebuild-index`) remain explicitly eager because opening their target
  database is the requested operation.

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
