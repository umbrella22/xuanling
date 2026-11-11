# Changelog

All notable release changes are recorded here. XuanLing uses immutable release
tags and publishes the launcher, native packages, DeepSeek Harness bundles, and
ZCode projection from the same source commit.

## 0.11.2 - 2026-11-11

### Changed

- Refresh the Rust dependency graph: `rmcp` 3.9, `tokio` 1.54, `uuid` 1.29,
  `schemars` 1.2.3, `serde_json` 1.0.154 and the ICU/wasm stack; upgrade
  `cap-std` to 4.0.3 and `base64` to 0.23.1.
- Replace `fs4` with the standard library file-lock API (`File::lock` /
  `try_lock`), removing a dev dependency.
- Replace rmcp's deprecated `ServerInfo` alias with `ServerConfig` in both MCP
  servers. Tool names and descriptions are unchanged.

### Fixed

- Regenerate the `tools/list` schema snapshot. Required keys now match fields
  that were already always serialized (`not_modified`, `truncated`,
  `before_sha256`, `selected`, memory proposal `tags`/`applicability`/`pinned`,
  system `cwd`). No tool output or runtime behavior changed.

### Compatibility and limits

- No product behavior change; this is a dependency-maintenance release.
- MCP tool names, descriptions and wire payloads are unchanged. The regenerated
  schema only adds required keys for fields that were already present.
- Definition schema remains v2 and the conversation canvas is unchanged.
- The release publishes the nine npm items, DSH bundles and Blueprint plugin
  from one verified commit.

## 0.11.1 - 2026-11-11

### Changed

- Rebuild the conversation Blueprint view around a read-only runtime canvas: compact node
  readouts with kind rails and state chips, a single-line run ribbon with a DSH-native
  28 px selector, a `版本` revision chip, a status-filtered legend and a populated minimap.
- Multi-attempt nodes open an explicit popover picker; the separate attempts column is gone.
  Frozen runs keep the archify seven-color kind palette, traversed edges and the optional
  TeamStage card.
- Align the conversation accent with the host interactive blue
  (`--dsw-alias-state-business-primary`) and the run picker with DSH's model/workspace picker
  grammar: 28 px, transparent, content width, hover-only fill, state dot.
- Add `requiredCapabilities` (`repository-read` / `command-exec`) for Agent tasks. Preflight
  blocks admission when a node declares a capability but resolves no business tool, and marks
  bound coverage as unverified. The Inspector shows declared capabilities; clipboard and
  advanced JSON preserve them.

### Added

- Attempt diagnostics carry an `output` digest (type, bytes, SHA-256) derived from the
  authoritative outcome; the diagnostics panel shows it without storing raw output.
- Run reports expose per-step `acceptance` beside the scheduler state in the wire codec,
  Markdown table and report UI, so a scheduled step is not mistaken for a delivered one.
- Add `examples/repository-implementation`, a strict implementation-report schema that rejects
  placeholders, missing receipts or unknown fields, plus delivery-gate guidance.

### Fixed

- Render a populated minimap for read-only runs by replaying measured content dimensions
  without pinning node wrappers, which previously stalled the automatic Fit.
- Keep exactly one live status node per seat state, including unbound sessions, and restore
  the selected/run accent to the host's interactive blue.

### Compatibility and limits

- Definition schema remains v2; `requiredCapabilities` is optional and additive. Existing
  definitions remain valid and require no migration.
- New diagnostics and report fields are optional; legacy records read without migration.
- Model availability is still not validated before execution: `model-route-declared` remains
  an info check until the Host exposes an authoritative model catalog.
- The strict report schema constrains structure, not business truth. Branching on a report
  field still needs a human decision node or a future boolean-extraction graph primitive.
- The release publishes the nine npm items, DSH bundles and Blueprint plugin from one verified
  commit.
- Release `0.11.1` supersedes an incomplete `0.11.0` publish attempt: only the
  `xuanling-mcp-darwin-arm64` platform alias reached the registry, and no launcher, DSH
  bundle or Blueprint package was published at `0.11.0`. The `0.11.0` tag remains as
  release-audit evidence but is not a user-facing release.

## 0.10.2 - 2026-11-04

### Changed

- Merge the Blueprint library cascade and blueprint picker into one searchable,
  workspace-grouped selector; choosing an asset from another library switches
  the library, refreshes the catalog and loads it in one step.
- Move Blueprint share/reuse into a modal dialog with export, template and
  Agent-document sections, and move blueprint renaming into a small dialog from
  the document identity header and the overflow menu.
- Add filterable, grouped option lists to the shared select control with SVG
  chevrons, check marks and empty-result messaging. Replace raw file inputs with
  choose-file controls that show the selected file name.
- Collapse the Blueprint desktop toolbar into one macOS window-drag band and
  restyle the authoring dialogs, document identity, diagnostics, resource add
  control and checkboxes.
- Converge injected style sheets to the running build instead of skipping an
  existing sheet, so plugin hot updates pick up new rules without a page reload.

### Fixed

- Keep the embedded conversation editor's toolbar out of the native window-drag
  region and preserve undo/redo, save state and narrow layouts in the new
  single-row toolbar.

### Compatibility and limits

- Blueprint definition schema remains v2; no data migration is required.
- The release publishes the existing npm items, DSH bundles and Blueprint plugin
  from one verified commit. The harness-bridge release boundary is unchanged.

## 0.10.1 - 2026-11-02

### Changed

- Give the Blueprint desktop toolbar a dedicated window-drag area, group the
  library/workspace and plan/run controls, and move secondary details out of the
  crowded top row. Show run status only when a real Run exists; keep selection,
  busy navigation and narrow layouts usable.
- Publish the experimental Harness Bridge launcher with macOS Apple Silicon,
  Linux x64 glibc and Windows x64 native packages from one source commit.
- Disable native worker transcript persistence for Codex and Claude. Reject
  DSH/ZCode worker execution until a verified suppression mode is available;
  DSH remains usable as a controller.
- Include the local DSH Harness Bridge provider/tool integration in the source
  checkout. It remains private and is not an additional public npm bundle.

### Compatibility and limits

- Blueprint definition schema remains v2; no data migration is required.
- Bridge publication proves distribution and protocol smoke only. Deferred
  live-provider and controller-host acceptance is not implied. Initial Bridge
  uploads use browser-authenticated CLI publishing; npm OIDC configuration is
  a separate maintainer step for all four packages.

## 0.10.0 - 2026-11-01

### Added

- Keep the macOS desktop client's window chrome strip above the Blueprint
  toolbar and make that toolbar row a window-drag surface: dragging a blank run
  moves the DSH window while every control stays clickable. A plain browser tab
  keeps the compact toolbar without the extra strip.
- Refine the Blueprint panel chrome: one-row library cascade, status chips with
  semantic state beads, concentric toolbar capsules, inspector disclosure and
  dialog grammar, theme-correct React Flow controls, minimap and attribution,
  and readable placeholders in light and dark themes.
- Add the result-only harness bridge source and its CI gates: a stdio MCP host
  surface that submits work to a worker harness and returns only its final
  result and terminal status.

### Fixed

- Resolve Blueprint state colours through the published DSH alert and warning
  tokens, so failed, waiting and dirty states follow the active theme instead of
  hard-coded fallbacks.
- Verify process-group ownership before a long-lived child joins a containment
  unit, and expose that check for hosts that manage the child themselves.

### Compatibility and limits

- The harness bridge is source-only in this release. Its npm packages stay
  unpublished until the plan's live worker, host and native-platform gates
  close; `crates/xuanling-harness-bridge/RELEASE-BOUNDARY.md` remains
  "not published".
- Definition schema remains v2 and this release requires no data migration.
  Blueprint desktop dragging needs a DSH macOS client that publishes
  `--dsh-frame-top-clearance`; browser documents keep the previous layout.
- Real provider, live worker and Windows/Linux native acceptance for the bridge
  remain deferred.

## 0.9.0 - 2026-10-27

### Added

- Browse profile-global and registered workspace Blueprint libraries from a
  cascading selector. Discovery checks each workspace's `.xuanling` directory
  without creating it. Global definitions can be edited and saved without an
  execution target; running requires a selected workspace.
- Create, reference and edit Blueprint plans inside a conversation before a Run
  exists. Saved plans retain their asset identity and revision, and Run progress
  is reconciled from durable records after refresh or restart.
- Share the current workflow ZIP or extract a parameterized template containing
  its package files. Template preparation records bounded project evidence and
  required inputs; startup rejects stale, missing or invalid preparation facts.
- Coordinate business-tool writes by the real project root across Runs,
  processes and custom runtime directories. Durable write intents, pre-tool
  conflict checks and explicit recovery protect unresolved workspace effects.

### Fixed

- Resolve Agent and Skill catalogs in the caller's DSH scope, including globally
  installed filesystem skills. Selecting the global library clears project
  context and isolates library storage by profile.
- Preserve library and workspace selection through Run inspection, cancellation,
  decisions, archive/restore and recovery. Correct native RPC argument handling
  and actual panel routing for library selection and refresh.
- Preserve template file bytes and digests, enforce storage containment and
  writer locking, and make retries compare the complete package contents.

### Compatibility and limits

- Definition schema remains v2. New Run records use schema 3; valid older
  records remain readable and upgrade on write. Downgrading a runtime over new
  records is not supported; retain a pre-upgrade data backup for rollback.
- Workspace write coordination is advisory. Business tools are conservatively
  serialized; arbitrary external writers and per-tool checks inside TeamStage
  are outside the current guarantee.
- Template adaptation provides explicit parameters and bounded file evidence.
  Automatic semantic generalization and role/Agent/Skill/model matching remain
  incomplete. Large-library pagination and the complete native desktop journey
  also remain outside this release's verified scope.
- Real provider acceptance, including the DeepSeek connectivity retest, remains
  deferred. Deterministic, package and browser checks do not establish provider
  acceptance or completion of the broader Blueprint implementation plan.

## 0.8.1 - 2026-10-23

### Changed

- Reissue the managed Blueprint workflow release under a new immutable version
  after the interrupted 0.8.0 rollout. This release includes the managed node
  conversations, pinned child Blueprint composition, permission-preset handling,
  portable child closure and Team session fixes described in 0.8.0.
- Synchronize the Cargo workspace, npm launcher and native variants, five DSH
  packages, ZCode plugins, runtime version reports and installation examples to
  0.8.1. Runtime behavior and Blueprint definition schema v2 are unchanged from
  0.8.0.

## 0.8.0 - 2026-10-22

### Added

- Managed Blueprint Agent nodes accept human clarification in their original
  Attempt Session. Ordinary replies leave the node open; `structured_output`
  explicitly completes it. New editor nodes and generation examples use managed
  interaction; existing v2 nodes without the field retain one-shot behavior.
- `blueprintCall` invokes a saved child at an exact revision with explicit input
  and output ports. Parent Runs track child results, cancellation and recovery.
  The editor includes child/revision selection, generated ports, preview,
  interface diffs, explicit pin updates, and undo/redo. Frozen runtime views
  provide child navigation, parent breadcrumbs and original node conversations.
- Portable Blueprint exports include the complete pinned child closure. Imports
  validate that closure before publishing the parent and preserve same-name
  workflows in the destination library. The migration Skill documents manual
  managed-node and composition upgrades, compatibility and rollback.

### Fixed

- Conversation workflow changes and Run startup follow the calling DSH permission
  preset: Full access skips human confirmation, Auto uses the native reviewer,
  and ordinary review modes retain Host approval. An isolated `approval=never`
  setting does not imply Full access.
- Native authoring tools declare the definition parameter as an object and
  distinguish it from serialized resource text, preventing ambiguous model
  guidance that caused repeated validation of double-encoded definitions.
- Blueprint child Sessions establish their one-shot identity before Agent
  publication, preventing the native Team profile from installing an unrelated
  Lead context and failing the node with `TEAM_NOT_MEMBER`.

### Compatibility

- Definition schema remains v2. Older plugins reject the new `interaction` and
  `blueprintCall` fields; preserve a separate original copy before upgrading.
  Runtime graphs remain frozen, graph-defined aggregation remains in place,
  and model output budgets continue to follow DSH.

## 0.7.0 - 2026-10-22

### Breaking

- Blueprint definitions now use schema v2. Definitions saved by the published
  `0.6.1` Blueprint package (schema v1, including `toolCall`, `scriptCall`,
  `subflow` and `iteration` nodes) are rejected with
  `blueprint/definition-invalid` and cannot be opened or run without migration.
  All XuanLing packages share the `0.7.0` release version. There is no automatic
  migration; use the migration Skill to prepare and validate a separate copy,
  or keep `0.6.1` for the original workflows.

### Added

- The `xuanling-blueprint-migrate` Skill ships in the DSH skills bundle. It guides
  schema v1-to-v2 and legacy profile-storage upgrades, preserves the original
  package and Run history, validates resources and inputs, and records rollback
  steps. Removed execution semantics require an explicit redesign rather than
  only changing the schema version.
- `workflow_report` returns an execution report instead of the raw snapshot:
  what ran (state, duration, model route per step), which step failed, why, and
  what to change next time. It carries stable codes, fixed guidance and the
  bounded operator recovery note; raw evidence, outputs and provider text are
  never included.
- `resolveRecovery` lets a person move a `recovery_required` Run to `failed` or
  `succeeded` with a required note, guarded by `expectedSeq`. The note is the
  audit record; the unknown effect is never replayed. The conversation
  Blueprint view offers the same decision for Runs created in its workspace.
  TeamStage recoveries are still rejected and need manual Team cleanup.
- The Blueprint sidebar shows revision history with a structural diff and a
  CAS-guarded restore (`restoreDefinitionRevision`), a Run report with
  localized guidance, recovery actions, and per-node resource provenance with
  the binding digests frozen by the latest Run. The structural diff also warns
  when only packaged resource files differ, because restoring then reverts
  those files too.

### Changed

- DSH development and harness dependencies are aligned to `0.2.1-rc.2`; the
  public runtime peer floor is `>=0.2.1-alpha.5`, with prereleases included in
  compatibility checks.
- Blueprint output token limits follow the selected model's DSH/Provider
  configuration. Blueprint adds no separate model output budget.
- Conversation tools and conversation Blueprint views follow the calling
  session's registered DSH workspace instead of always using the Host default.
  This includes Run history pagination, archive/restore and recovery for
  conversation-created Runs; calls the Host cannot attribute fall back to the
  Host default workspace. The sidebar editor still uses the Host default; an
  explicit `workspaceRoot` still pins every call.

### Fixed

- Standalone Runs without a source conversation explain why node chat history
  is unavailable and disable the chat button before interaction. Node outputs
  and Run reports remain available; conversation-created Runs retain native
  chat navigation.

## 0.6.1 - 2026-10-15

### Changed

- Blueprint node and group layout now measures rendered geometry before collision,
  fit and visibility decisions, with stable group headers and runtime canvas sizing.
- Node inspectors expose bindings by capability, port visibility switches guard new
  connections while protecting existing edges, and resources are grouped with safe
  Agent/Skill/MCP details and editable advanced JSON.
- Blueprint source and tests are managed with Vite+ Oxfmt/Oxlint; the release keeps
  the DSH `0.2.1-alpha.3` dependency tuple and the validated pnpm lockfile.

### Fixed

- Post-format review removed stale geometry/oracle assumptions and dead compatibility
  helpers without changing the runtime execution or resource safety contracts.
- Invalid advanced resource JSON remains editable without crashing the resource
  dialog; release verification accepts the exact formatting script contract.

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
