# XuanLing for DeepSeek Harness

English | [Simplified Chinese](README-ZH.md)

This integration mounts `xuanling-mcp` through DeepSeek Harness's official
`@deepseek-ai/dsh-mcp-client` bridge. XuanLing tools appear as native Harness
tools named `mcp__xuanling__<tool>`, while host-specific schema projection,
workflow Skills, and overwrite policy remain outside the Rust MCP contract.

## Recommended Setup

Install the Memory and Skills bundles into DSH's shipped `web` profile:

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-memory@0.2.5 \
  @xuanling-rs/xuanling-dsh-skills@0.2.5
dsh --profile web --dump-config
dsh web
```

Use `--profile headless` instead when extending DSH's shipped headless
profile. A new arbitrary profile name is not a drop-in replacement: current
DSH initializes unknown profiles with `@deepseek-ai/dsh-base` only, without a
Web or Headless application bundle.

The Memory bundle installs the exact `@xuanling-rs/xuanling-mcp@0.2.5` launcher and native
optional dependency inside the profile. No global npm package, `npx`, or
install-time binary download is used.

The recommended combination adds the complete nine-tool Memory v2 lifecycle,
retains all Harness-native tools, and loads two on-demand workflow Skills. The
Memory Skill is active in this profile; the File Skill applies only when a
separate tools bundle makes the XuanLing fs family visible.

## Bundles

| Bundle | Behavior | Use case |
| --- | --- | --- |
| `@xuanling-rs/xuanling-dsh-memory` | Adds the complete nine-tool Memory v2 profile with DSH schema projection; retains every native Harness tool | Recommended daily configuration |
| `@xuanling-rs/xuanling-dsh-skills` | Adds isolated file and Memory workflow Skills plus strict overwrite policy; mounts no MCP tools | Combine with any XuanLing tool bundle |
| `@xuanling-rs/xuanling-dsh-tools` | Adds the complete XuanLing catalog and retains native Harness tools | Access artifact, project, filesystem, process, and advanced tools |
| `@xuanling-rs/xuanling-dsh-tools-replace` | Adds the complete catalog and disables the three model-facing native filesystem rows | Controlled full-catalog replacement |

The Memory bundle deliberately exposes the complete lifecycle. Search, get,
candidate creation/replacement/archive, review, and feedback form one contract;
a read-only two-tool subset would hide required state transitions from the
model.

The replacement bundle leaves shell, web, LSP, approval, background job, PTY,
and orchestration integrations enabled. Replacing Harness-native filesystem
tools removes their read-before-edit observation guard and specialized UI
cards; XuanLing supplies SHA-256 preconditions and strict patching, but the
host experience is not identical.

## Runtime Configuration

Bundle expressions resolve these values when DSH starts:

| Setting | Default | Purpose |
| --- | --- | --- |
| MCP runtime | Profile-local `@xuanling-rs/xuanling-mcp@0.2.5` | Verified JS launcher and native optional dependency |
| `XUANLING_WORKSPACE_ROOT` | DSH process working directory | XuanLing filesystem capability root |
| Schema adapter | Installed `xuanling-dsh-memory/schema-adapter.mjs` | Projects discovery schemas for DSH |
| Result adapter | Installed bundle-local `mcp-result-adapter.mjs` (memory is composed into the schema adapter) | Removes only duplicate equivalent text blocks |
| MCP tool profile | `memory` in the recommended bundle | Server-side discovery and dispatch selection |
| Tool-call timeout | 120 seconds | Budget applied by the Harness MCP bridge |

The server name is fixed to `xuanling`; changing it renames every model-facing
tool. The Skills bundle has no binary, workspace, or database setting. It
resolves Skill content and policy code from its installed package.

The production Memory bundle uses XuanLing's shared default database at
`~/.xuanling/memory.db`. Hosts that require a separate store can restate the
bridge row with an explicit `--memory-db` path.

## Schema Projection

DeepSeek Harness supports a narrower JSON Schema vocabulary than the canonical
MCP catalog. The recommended Memory bundle places `schema-adapter.mjs` between
the official bridge and `xuanling-mcp`:

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
  prefers Harness-native tools for ordinary reads and small edits, then selects
  XuanLing for hash/CAS protection, exact compound-suffix search, explicit byte
  budgets, complete pagination, and one atomic `fs_patch` for same-file
  multi-hunk edits. Repeated short validations with the same argv use
  `deterministic: true`; long jobs use the Harness background/job surface.
- `xuanling-memory-workflow` uses a single-write L1/L2 split: project-local,
  every-session facts stay in host file memory; cross-project shared facts use
  XuanLing. An explicit L1 pointer triggers one scoped pull at task start or a
  topic switch, not every turn. `memory_search` returns full active records,
  not a lightweight manifest. New candidates remain pending, and
  `memory_review` requires an explicit user decision for that proposal.

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
