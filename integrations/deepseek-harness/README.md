# XuanLing for DeepSeek Harness

English | [Simplified Chinese](README-ZH.md)

This integration mounts `xuanling-mcp` through a bundle-owned lazy wrapper
around DeepSeek Harness's official `@deepseek-ai/dsh-mcp-client` bridge. The
official bridge caches the complete XuanLing catalog, while the wrapper
initially registers only `mcp_catalog__xuanling`; exact activations then appear
as native Harness tools named `mcp__xuanling__<tool>`. Host-specific lazy
projection, schema projection, workflow Skills, and overwrite policy remain
outside the Rust MCP contract.

## Recommended Setup

Install the Memory and Skills bundles into DSH's shipped `web` profile:

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-memory@0.3.1 \
  @xuanling-rs/xuanling-dsh-skills@0.3.1
dsh --profile web --dump-config
dsh web
```

Use `--profile headless` instead when extending DSH's shipped headless
profile. A new arbitrary profile name is not a drop-in replacement: current
DSH initializes unknown profiles with `@deepseek-ai/dsh-base` only, without a
Web or Headless application bundle.

The Memory bundle installs the exact `@xuanling-rs/xuanling-mcp@0.3.1` launcher and native
optional dependency inside the profile. No global npm package, `npx`, or
install-time binary download is used.

The recommended combination adds the complete nine-tool Memory v2 lifecycle,
retains all Harness-native tools, and loads two on-demand workflow Skills. The
Memory Skill is active in this profile; the File Skill applies only when a
separate tools bundle makes the XuanLing fs family visible.

## Bundles

| Bundle | Behavior | Use case |
| --- | --- | --- |
| `@xuanling-rs/xuanling-dsh-memory` | Caches the complete nine-tool Memory v2 profile with DSH schema projection and activates exact tools lazily; retains every native Harness tool | Recommended daily configuration |
| `@xuanling-rs/xuanling-dsh-skills` | Adds isolated file and Memory workflow Skills plus strict overwrite policy; mounts no MCP tools | Combine with any XuanLing tool bundle |
| `@xuanling-rs/xuanling-dsh-tools` | Caches the complete XuanLing catalog, projects exact activations, and retains native Harness tools | Access artifact, project, filesystem, process, and advanced tools |
| `@xuanling-rs/xuanling-dsh-tools-replace` | Compatibility alias that restores native rows and lazily adds the complete catalog | Migrate historical replacement profiles to the additive bundle |

The Memory bundle deliberately exposes the complete lifecycle. Search, get,
candidate creation/replacement/archive, review, and feedback form one contract;
a read-only two-tool subset would hide required state transitions from the
model.

The historical replacement bundle now preserves every Harness-native row,
including `read_image`, read-before-edit observation guards, and editor cards.
It remains only as a migration-compatible alias; new full-catalog installs use
the additive bundle. Shell, web, LSP, approval, background job, PTY, and
orchestration integrations remain separate host capabilities.

## Runtime Configuration

Bundle expressions resolve these values when DSH starts:

| Setting | Default | Purpose |
| --- | --- | --- |
| MCP runtime | Profile-local `@xuanling-rs/xuanling-mcp@0.3.1` | Verified JS launcher and native optional dependency |
| `XUANLING_WORKSPACE_ROOT` | Required for full-tools bundles; unused by Memory-only | Explicit XuanLing filesystem capability root |
| Schema adapter | Installed `xuanling-dsh-memory/schema-adapter.mjs` | Projects discovery schemas for DSH |
| Result adapter | Installed bundle-local `mcp-result-adapter.mjs` (memory is composed into the schema adapter) | Removes only duplicate equivalent text blocks |
| MCP tool profile | `memory` in the recommended bundle | Server-side discovery and dispatch selection |
| DSH tool exposure | Bundle-owned lazy wrapper | Complete Host cache with one initial `mcp_catalog__xuanling` search/activation tool |
| Tool-call timeout | 120 seconds | Budget applied by the Harness MCP bridge |

The server name is fixed to `xuanling`; changing it renames every model-facing
tool. The Skills bundle has no binary, workspace, or database setting. It
resolves Skill content and policy code from its installed package.

The production Memory bundle uses XuanLing's shared default database at
`~/.xuanling/memory.db`. Hosts that require a separate store can restate the
bridge row with an explicit `--memory-db` path.

## Lazy Tool Projection

Every bundle drains standard MCP `tools/list` pagination into a complete Host
cache. It does not stop at the first page and does not ask the server to mutate
its static catalog. The model initially receives one compact
`mcp_catalog__xuanling` schema. That bundle-owned Host control searches raw
names and descriptions and optionally activates one exact raw name per call as
an ordinary `mcp__xuanling__*` tool for later model requests.

Exact identity matching is case-sensitive and never trims or rewrites the raw
name. Reconnect and `tools/list_changed` refresh the complete cache and
re-project activated names that still exist.
The activation set belongs to the live DSH plugin instance: sessions sharing
that instance share activations, while HMR, plugin disposal, or Host restart
clears them. MCP pagination only bounds transport; DSH lazy projection is the
layer that reduces initial model schema cost.

## Schema Projection

DeepSeek Harness supports a narrower JSON Schema vocabulary than the canonical
MCP catalog. The recommended Memory bundle places `schema-adapter.mjs` between
the official bridge and `xuanling-mcp`; the lazy wrapper captures only the
already-projected definitions:

1. Only `tools/list` input schemas are projected.
2. Local `$ref` values are resolved and `$defs` are inlined.
3. Supported nullable unions and tagged objects are expressed in DSH's model
   vocabulary.
4. Unsupported, circular, ambiguous, or lossy constructs fail startup.
5. `tools/call` arguments pass through unchanged and remain subject to the
   canonical Rust schema.

The adapter does not create a second Memory protocol and never rewrites model
arguments after tool selection.

## Result Projection

The MCP wire contract intentionally retains both `content` and
`structuredContent`. DSH uses text blocks once for Native model rendering and
keeps the structured value for Code Mode and output validation. The integration
adapter removes only accidental duplicate text blocks that are an exact JSON
representation of the same structured value; it never replaces the single
complete text projection with a marker.

The adapter accepts only JSON object frames from the child process. Malformed
stdout, a non-object frame, or a clean exit with an unresolved request produces
a nonzero adapter exit and no invalid frame. Host termination is forwarded to
the child; a 500 ms grace is followed by forced termination when the child does
not exit.

## Workflow Skills

`xuanling-skills` mounts an isolated static Skill provider with two on-demand
Skills:

- `xuanling-file-workflow` applies only when XuanLing fs tools are visible. It
  uses `mcp_catalog__xuanling` to activate an exact missing tool, prefers
  Harness-native tools for ordinary reads and small edits, then selects
  XuanLing for hash/CAS protection, exact compound-suffix search, explicit byte
  budgets, complete pagination, and one atomic `fs_patch` for same-file
  multi-hunk edits. Repeated short validations with the same argv use
  `deterministic: true`; long jobs use the Harness background/job surface.
- `xuanling-memory-workflow` uses a single-write L1/L2 split: project-local,
  every-session facts stay in host file memory; cross-project shared facts use
  XuanLing. It activates only the next required memory operation. An explicit
  L1 pointer triggers one scoped pull at task start or a
  topic switch, not every turn. `memory_search` returns full active records,
  not a lightweight manifest. New candidates remain pending, and
  `memory_review` requires an explicit user decision for that proposal.

For the generic MCP v3 contract, the file workflow treats omitted `output` as
a bounded 65,536-byte request, uses absolute numbered reads and
`known_sha256` conditional re-reads, and keeps `include_diff: true` until a DSH
native XuanLing diff projection is independently verified. SHA remains a
concurrency/integrity precondition rather than semantic edit validation.
`project_run(check)` follows the exact project script and never substitutes a
build; minimal process environments remain the default and failures include a
non-secret `inherit_env: true` remediation.

The strict overwrite policy rejects
`mcp__xuanling__fs_write_text` overwrite requests without a non-empty
`expected_sha256`. Create mode and hash-bearing overwrites continue to the MCP
server unchanged. The policy applies to Native and Code Mode dispatch.

## Security Boundary

- XuanLing enforces pathname capabilities for filesystem tools; processes
  launched by process/session/pipeline tools still require Harness approval
  and an OS sandbox when hostile execution is possible.
- DSH-specific schema projection and policy do not weaken canonical MCP
  validation.
- MCP results retain both text and structured representations. The integration
  adapter de-duplicates repeated identical text projections at the DSH boundary
  while preserving the structured value for Code Mode and validation.
