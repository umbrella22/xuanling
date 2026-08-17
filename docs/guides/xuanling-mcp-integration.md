# XuanLing MCP Integration Guide

This guide describes how an MCP host (ZCode, Claude Code, or any MCP client) runs and
consumes the XuanLing MCP server from this repository. It documents **current checkout
behavior**; the Memory v2 target contract is tracked separately in
[ADR 0001](../adr/0001-memory-v2-proposal-review.md) and the
[architecture notes](../architecture/memory-v2-architecture.md).

## Running the server

```sh
# From source
cargo build --locked --release -p xuanling-mcp
./target/release/xuanling-mcp --workspace-root /absolute/path/to/project

# Or via npm
npm install --global @xuanling-rs/xuanling-mcp
xuanling-mcp --workspace-root /absolute/path/to/project
```

The server speaks MCP over stdio. Diagnostics go to stderr; stdout carries only MCP
framing.

## Command-line flags

| Flag | Meaning |
| --- | --- |
| `--workspace-root <PATH>` (repeatable) | Filesystem **write roots**: read/write/delete and child-process cwd are admitted inside them. |
| `--read-root <PATH>` (repeatable) | Additional **read-only roots**: read/list/search/hash are admitted; writes, deletion, and process cwd are rejected with `outside_capability`. |
| `--base-dir <PATH>` | Default resolution context for relative tool paths (not a sandbox). |
| `--memory-db <PATH>` | SQLite database for the memory tools (default `~/.xuanling/memory.db`). |
| `--default-namespace <VALUE>` | Convenience namespace used when a memory request omits one. |
| `--sqlite-busy-timeout-ms <MILLISECONDS>` | SQLite busy timeout (default 5000). |
| `--tool-profile <PROFILE>` (repeatable) | Restrict discovery/dispatch to tool groups: `core`, `fs`, `process`, `memory`, `advanced`. Omitting the flag exposes the full catalog. |

With neither `--workspace-root` nor `--read-root`, the server is unrestricted. With only
`--read-root`, it is a read-only deployment.

## Result mapping

| Outcome | MCP expression |
| --- | --- |
| success | `isError=false` + structured content |
| domain failure (missing file, conflict, …) | `isError=true` + structured JSON (`code`/`operation`/`path`/`raw_os_error`) |
| protocol failure (unknown tool, bad args) | JSON-RPC error `-32602` listing the expected fields |
| process nonzero exit | `isError=false`, `success=false` |

A `-32602` naming expected fields means the strict schema rejected an unknown key — read
the `expected one of ...` list and resend with the correct field names.

## Bounded output and determinism

Window-capable tools (`fs_list`, `fs_search`, `fs_glob`, `fs_read_text`, `fs_read_bytes`,
process tools) accept an `output` selector — an **object**
`{"mode":"bounded","max_bytes":N}` or `{"mode":"complete"}`; omitted means **complete**
(no byte budget). Truncated results carry a typed `next_cursor` / resume token, never a
silent cut. Every `fs_read_text`/`fs_read_bytes` result carries `sha256` for cheap
re-verification.

`fs_list`/`fs_search`/`fs_glob` embed no timestamps; process tools accept
`deterministic=true` to omit `duration_ms` so identical invocations return byte-identical
results (prompt-cache friendly).

## ZCode compatibility shim

Some hosts (confirmed for ZCode) stringify tool arguments whose schema is a
`$ref` into `$defs` — `output`, `scope`, `payload`, `stdout`/`stderr` fail
schema validation while inline-typed object parameters (e.g. `process_run.env`)
pass. The server accepts these stringified objects ONLY when started with
`--compat-lenient-object-params` (default off; also published in initialize
`_meta` as `xuanling.compat.lenient_object_params`). The shim coerces a
JSON-object string for exactly the parameters whose schema resolves to an
object; string-typed parameters are never coerced. Hosts that serialize
objects correctly should NOT enable it.

## DeepSeek Harness integration

DeepSeek Harness ships a first-party MCP client bridge
(`@deepseek-ai/dsh-mcp-client`); the repository provides ready-made dsh bundles
under [integrations/deepseek-harness](../../integrations/deepseek-harness/) that
mount this server as native `mcp__xuanling__<tool>` tools — including a
replace variant that retires the built-in `tool-fs`/`tool-fs-search`/
`tool-str-replace-editor` rows so XuanLing becomes the model-facing filesystem
layer. The bridge passes input schemas through verbatim (`$defs`/`$ref` reach
the tool registry untouched), but a real DeepSeek model can still stringify
object parameters behind `$ref`. The recommended `xuanling-memory` bundle
therefore projects discovery schemas into DSH's supported vocabulary before
the first-party bridge registers them; `tools/call` arguments remain unchanged
and the ZCode shim above is NOT used on this path. See the integration README
for install variants and the name-mapping table. Repository acceptance uses
[`verify-deepseek-bridge.mjs`](../../test/deepseek-harness/scripts/verify-deepseek-bridge.mjs)
for live wire-contract checks.

## Process execution semantics

`process_run`/`process_pipeline`/`session_exec` take explicit argv (`program` + `args[]`);
**no shell is ever invoked** — shell metacharacters arrive at the child verbatim. By
default the child environment is a minimal non-secret allowlist (PATH/HOME/TEMP/locale);
pass `inherit_env=true` to match the login shell. Cancellation terminates the whole
descendant process tree.

## Memory tools (current release)

The current release ships the Memory v2 proposal/review surface: candidate create,
replace, archive, get and list; terminal review; record get/search; and append-only
feedback. Canonical records become active only after an approving review with the
proposal-revision CAS. Recall remains lexical (dual FTS5: unicode61 + trigram,
RRF-merged), so it works for CJK without downloading an embedding model. See
[ADR 0001](../adr/0001-memory-v2-proposal-review.md) for the ownership and lifecycle
contract.

## Repository verification commands

```sh
cargo fmt -p xuanling-toolkit -p xuanling-mcp -- --check
cargo check -p xuanling-toolkit -p xuanling-mcp --all-targets
cargo clippy -p xuanling-toolkit -p xuanling-mcp --all-targets -- -D warnings
cargo test -p xuanling-toolkit --features test-fixtures --test contract
cargo test -p xuanling-mcp --test protocol
cargo test -p xuanling-mcp --test golden
npm --prefix npm run check
npm --prefix npm test
node npm/scripts/smoke-mcp.mjs --binary target/release/xuanling-mcp
```

## Responsibility boundary

The server enforces a pathname-based filesystem capability and bounded output. It is
**not** a child-process sandbox: a process launched via the process tools can still open
other paths or use the network through its own argv/scripts/libs. Approval policy is the
host's job.
