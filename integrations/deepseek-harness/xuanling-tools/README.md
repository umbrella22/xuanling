# xuanling-dsh-tools

English | [Simplified Chinese](README-ZH.md)

**Additive DeepSeek Harness bundle for the complete XuanLing MCP catalog: all
43 typed tools, added next to DSH's native tools.** Package
`@xuanling-rs/xuanling-dsh-tools@0.7.0`.

## What it is

Adds the full catalog under the `mcp__xuanling__` prefix while keeping every
native Harness tool:

- **Core (3):** `system_info`, `path_resolve`, `path_relative`.
- **Filesystem (17):** `fs_stat`, `fs_list`, `fs_read_text`, `fs_read_bytes`,
  `fs_search`, `fs_glob`, `fs_hash`, `fs_mkdir`, `fs_write_text`,
  `fs_replace_text`, `fs_patch`, `fs_edit_preview`, `fs_edit`, `fs_edit_batch`,
  `fs_copy`, `fs_move`, `fs_remove`.
- **Process and project (5):** `process_run`, `process_which`,
  `project_detect`, `project_command`, `project_run`.
- **Memory v2 (9) and Advanced (9):** the full Memory lifecycle, plus artifacts,
  ChangeSets, pipelines, and sessions.

The server runs its default `all` catalog; this bundle has no smaller profile
switch.

## Why use it

- **Use it** when you need the XuanLing filesystem family, direct processes,
  project detection/execution, artifacts, ChangeSets, pipelines, or sessions.
- **Use `xuanling-dsh-memory`** for the smaller recommended Memory-only setup.
- **Use `xuanling-dsh-tools-replace`** for XuanLing semantics under native
  `read`/`write`/`edit` names.
- Install exactly one XuanLing runtime bundle per profile; see the
  [bundle guide](../README.md).

## Requirements

- DSH with the shipped `web` or `headless` profile.
- Node.js 22.14 or newer.
- A DSH build that provides `@deepseek-ai/dsh-mcp-client` from the
  `0.2.1-rc.2` capability channel.
- `XUANLING_WORKSPACE_ROOT` set to the confirmed absolute workspace in the
  environment that launches DSH; startup fails when it is missing.
- macOS ARM64, Linux x64 with glibc 2.35+, or Windows x64 with MSVC.

## Install

```sh
export XUANLING_WORKSPACE_ROOT=/absolute/path/to/project
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-tools@0.7.0
dsh --profile web --dump-config
```

Keep the variable in the environment of every process that starts DSH. Use
`--profile headless` for the headless profile; a custom new profile name starts
from the base bundle only. The profile gets
`@xuanling-rs/xuanling-mcp@0.7.0`; no global package or `npx` is needed.

## Quickstart

1. Restart the profile and refresh DSH.
2. Ask the model to search `mcp_catalog__xuanling` for `system_info` and
   activate it; call `mcp__xuanling__system_info` and check that
   `xuanling_version` is `0.7.0`.
3. Activate one filesystem tool, for example `fs_stat`, and read a path inside
   `XUANLING_WORKSPACE_ROOT`. Paths outside the root are denied by design.

## Configuration

- `XUANLING_WORKSPACE_ROOT` is required, absolute, and is the filesystem
  capability root; the DSH process working directory is never authorization.
- The Memory family uses the shared default `~/.xuanling/memory.db`, opened
  lazily on the first valid Memory call.
- Only `mcp_catalog__xuanling` is visible initially. Search it and activate one
  exact raw name per call; the tool appears on the next request. Do not
  activate the whole catalog speculatively.
- Tool-call budget: 120 seconds. Long builds and watch processes belong to
  Harness background jobs.
- Process tools run explicit program + argv without a shell and use a minimal
  environment by default (`inherit_env: false`).
- The server name is fixed to `xuanling`; public names are `mcp__xuanling__*`.

## Limits and safety

- **Capability overlap is real.** Native and XuanLing tools cover similar file,
  process, and project work; pick one family per operation deliberately.
- **Filesystem confinement.** XuanLing filesystem tools enforce pathname
  capabilities under `XUANLING_WORKSPACE_ROOT`; escaping paths are denied.
- **Process execution is not a sandbox.** Untrusted code still needs host
  approval and an OS sandbox; minimal environments are the default.
- **Shared store.** `~/.xuanling/memory.db` is shared with other XuanLing
  deployments; never put secrets or private user content in it.
- **Lazy activation has a cost.** Each new tool costs an activation step and an
  extra model turn, and activation sets do not survive a restart.
- **Platform limits.** Unsupported OS, CPU, or libc combinations fail with an
  explicit launcher error.

## Troubleshooting

- **Startup fails with a missing `XUANLING_WORKSPACE_ROOT`.** Export the
  confirmed absolute path in the environment of the DSH process, then restart.
- **Only `mcp_catalog__xuanling` is visible.** Expected. Search and activate
  exact raw names; use the name without the `mcp__xuanling__` prefix.
- **A tool call hits the 120-second budget.** Move the long work to a Harness
  background job and resume with a follow-up call.
- **A program is not found with `inherit_env: false`.** Retry with
  `inherit_env: true` only when inheriting the login environment is acceptable.
- **Launcher or version mismatch.** Reinstall the exact `0.7.0` version; do not
  mix versions in one profile, and remove any other XuanLing runtime bundle.

## Links

- [XuanLing for DeepSeek Harness: bundle guide and runtime configuration](../README.md)
- [XuanLing Blueprint: visual workflow editor and durable runs](../xuanling-blueprint/README.md)
- [XuanLing MCP server project](../../../README.md)
- [npm package](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-tools)
- [Issues](https://github.com/umbrella22/xuanling/issues)
