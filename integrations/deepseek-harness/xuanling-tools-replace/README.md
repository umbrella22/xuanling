# xuanling-dsh-tools-replace

English | [Simplified Chinese](README-ZH.md)

**Opt-in DeepSeek Harness filesystem replacement: DSH's native
`read`/`write`/`edit` surface backed by XuanLing's SHA-256-guarded file
operations, with host approval, observation, image, and diff behavior
preserved.** Package `@xuanling-rs/xuanling-dsh-tools-replace@0.9.0`.

## What it is

Disables the native `tool-fs` plugin and registers six same-name tools:

- `read` reads UTF-8 text through XuanLing and records the full body plus
  SHA-256 preimage for same-session edits.
- `write` creates or replaces a file; replacing an existing file requires a
  same-session `read` or `file_hash`.
- `edit` and `edit_batch` apply exact replacements, single or ordered
  multi-file; the batch supports whole-request preflight and `dry_run`.
- `file_hash` records a byte fingerprint only; it enables a guarded whole-file
  write but not `edit` or `edit_batch`.
- `read_image` remains the native Harness implementation.

Reads and writes stay bound to the host filesystem version, so read/diff
cards and observation rules keep working.

## Why use it

- **Use it** for XuanLing's exact edits, SHA-256 CAS, atomic replacement, batch
  preflight, and recovery under DSH's existing prompts and cards, including
  migrations from the historical replacement package.
- **Do not start here for a new installation.** Prefer the recommended Memory
  preset or the full additive tools bundle; see the
  [bundle guide](../README.md).
- Do not combine it with `xuanling-dsh-tools` or `xuanling-dsh-memory`. This
  preset adds no XuanLing Memory tools.

## Requirements

- DSH with the shipped `web` or `headless` profile; Node.js 22.14 or newer.
- A DSH build that provides `@deepseek-ai/dsh-mcp-client` and
  `@deepseek-ai/dsh-tool-fs` from the `0.2.1-rc.2` capability channel.
- `XUANLING_WORKSPACE_ROOT` set to the confirmed absolute workspace; the facade
  fails startup when the root, bridge, native image tool, or required XuanLing
  definitions are missing.
- macOS ARM64, Linux x64 with glibc 2.35+, or Windows x64 with MSVC.

## Install

```sh
export XUANLING_WORKSPACE_ROOT=/absolute/path/to/project
dsh plugin --profile web remove @xuanling-rs/xuanling-dsh-memory @xuanling-rs/xuanling-dsh-tools
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-tools-replace@0.9.0
dsh --profile web --dump-config
```

The dump should show native `tool-fs` disabled and one `xuanling-tools-replace`
row; drop `remove` if those packages are absent. Use `--profile headless` for
the headless profile; a custom new profile name starts from the base bundle.

## Quickstart

1. Restart the profile and refresh DSH.
2. Call `read` on a text file inside `XUANLING_WORKSPACE_ROOT`; expect a native
   read card. Then call `edit` on it: the mutation requires approval and renders
   a native diff card.
3. Optionally call `edit_batch` with `dry_run: true` first; the whole request
   is validated before any file changes.

## Configuration

- `XUANLING_WORKSPACE_ROOT` is required, absolute, and is the target root; the
  DSH process working directory is not an authorization source.
- Observation is session-scoped. `write` on an existing file needs a
  same-session `read` or `file_hash`; `edit` and `edit_batch` need a
  same-session `read` — a fingerprint alone is not enough. A formatter or other
  external writer invalidates the next CAS; reread or rehash before continuing.
- `read` pages with `offset` and `limit` (default 2000 lines per call); the full
  body is retained for edits.
- Mutations require host approval; a rejected, cancelled, or unavailable
  approval fails closed.
- Tool-call budget: 120 seconds. Server name is fixed to `xuanling`, and raw
  XuanLing mutation names are never exposed.

## Limits and safety

- **Six tools only.** This is a filesystem facade, not the full catalog: no
  `fs_search`, `fs_glob`, `fs_copy`, `fs_move`, `fs_remove`, and no process,
  project, artifact, session, or Memory tools.
- **Approval is required.** A non-interactive profile or a missing approval
  channel fails closed by design.
- **A hash is not a read.** `file_hash` permits a guarded whole-file `write` but
  cannot authorize `edit` or `edit_batch`.
- **No sandbox change.** Pathname capabilities apply under the workspace root,
  but other tools and processes are unaffected; untrusted execution still needs
  host approval and an OS sandbox.

## Troubleshooting

- **Startup fails on the workspace root.** Export the confirmed absolute path
  in the environment of the DSH process; a non-absolute value reports
  `[XUANLING_FACADE_INVALID_ROOT]`.
- **Startup mentions a missing XuanLing definition.** The runtime is incomplete
  or mismatched; reinstall the exact `0.9.0` versions and restart.
- **`[XUANLING_FACADE_NOT_OBSERVED]` or a rejected edit.** Read the file first
  (or take `file_hash` for a whole-file write) in the same session; for an
  ambiguous edit, make `old_string` unique or re-read after an external change.
- **A mutation was rejected or blocked on approval.** Approval was denied,
  cancelled, or unavailable; retry from an interactive profile.
- **A conflict is reported for multiple runtime bundles.** Remove the other
  XuanLing runtime packages and restart.

## Links

- [XuanLing for DeepSeek Harness: bundle guide and runtime configuration](../README.md)
- [XuanLing Blueprint: visual workflow editor and durable runs](../xuanling-blueprint/README.md)
- [XuanLing MCP server project](../../../README.md)
- [npm package](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-tools-replace)
- [Issues](https://github.com/umbrella22/xuanling/issues)
