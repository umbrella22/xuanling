# xuanling-dsh-memory

English | [Simplified Chinese](README-ZH.md)

**Recommended DeepSeek Harness bundle for XuanLing Memory v2: nine
proposal-first memory tools, added next to DSH's native tools.** Package
`@xuanling-rs/xuanling-dsh-memory@0.8.0`.

## What it is

Adds XuanLing's complete Memory v2 lifecycle to a DeepSeek Harness (DSH)
profile: `memory_search` and `memory_get` for recall, five
`memory_candidate_*` tools for pending proposals, `memory_review` for the
explicit approve/reject decision, and `memory_feedback`. Writes stay pending
until a review activates or rejects them, and the server never claims that a
human performed that review. Native DSH tools stay enabled; no filesystem,
process, artifact, or session tools are added.

## Why use it

- **Use it** for durable, cross-project recall that cannot silently rewrite
  canonical memory, with the smallest recommended tool surface.
- **Use `xuanling-dsh-tools`** when you also need XuanLing filesystem,
  process, project, artifact, or session tools.
- **Use `xuanling-dsh-tools-replace`** only for XuanLing semantics behind
  DSH's native text file tools.
- Pair it with `xuanling-dsh-skills` for the proposal-first workflow and a
  host approval gate. Install exactly one XuanLing runtime bundle per profile;
  see the [bundle guide](../README.md).

## Requirements

- DSH with the shipped `web` or `headless` profile.
- Node.js 22.14 or newer.
- A DSH build that provides `@deepseek-ai/dsh-mcp-client` from the
  `0.2.1-rc.2` capability channel.
- macOS ARM64, Linux x64 with glibc 2.35+, or Windows x64 with MSVC.

## Install

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-memory@0.8.0
```

Use `--profile headless` for the headless profile. A custom new profile name
starts from the base bundle only and is not a runnable Web or Headless app.
The command installs `@xuanling-rs/xuanling-mcp@0.8.0` inside the profile; no
global npm package or `npx` is needed.

## Quickstart

1. Verify the package, then restart the profile and refresh DSH:

   ```sh
   dsh plugin --profile web list
   dsh --profile web --dump-config
   ```

2. Ask the model to search `mcp_catalog__xuanling` for `memory_search` and
   activate that exact raw name. It appears as
   `mcp__xuanling__memory_search` on the next request.

3. Call it with a narrow read-only query. Do not create or review a candidate
   just to verify an install.

## Configuration

- No environment variable is required; this bundle adds no filesystem tools
  and does not use `XUANLING_WORKSPACE_ROOT`.
- Store: the shared default `~/.xuanling/memory.db`, opened lazily on the
  first valid Memory call. Startup and catalog discovery do not create it.
- Scopes are global, project (`project_id`), or workspace
  (`project_id` + `workspace_id`); ancestor scopes are walked only when asked.
- `memory_review` requires an explicit user decision naming the proposal; an
  unreviewed candidate is a valid end state.
- Model-facing flow: only `mcp_catalog__xuanling` is visible initially; search
  it and activate one exact raw name per call.
- Tool-call budget: 120 seconds. Public tool names are `mcp__xuanling__*`.

## Limits and safety

- **Memory only.** No file or process tools, and no filesystem capability.
- **Shared store.** `~/.xuanling/memory.db` is used by other XuanLing
  deployments too; never put secrets or private user content in it.
- **Proposal-first is a state machine, not a human attestation.**
  `reviewer_id` is caller-attested; the Skills bundle adds the DSH approval
  gate.
- **No startup side effects.** The database is neither created nor migrated
  until the first valid Memory call.

## Troubleshooting

- **Only `mcp_catalog__xuanling` is visible.** Expected. Search it and
  activate exact raw names, one per call.
- **An activated tool does not appear.** Use the raw name without the
  `mcp__xuanling__` prefix; activations do not survive a restart.
- **A candidate never becomes active.** It is awaiting review; call
  `memory_review` only on an explicit user decision.
- **Startup fails.** Check Node.js 22.14+, platform support, and reinstall the
  exact `0.8.0` version. Remove any other XuanLing runtime bundle.

## Links

- [XuanLing for DeepSeek Harness: bundle guide and runtime configuration](../README.md)
- [XuanLing Blueprint: visual workflow editor and durable runs](../xuanling-blueprint/README.md)
- [XuanLing MCP server project](../../../README.md)
- [npm package](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-memory)
- [Issues](https://github.com/umbrella22/xuanling/issues)
