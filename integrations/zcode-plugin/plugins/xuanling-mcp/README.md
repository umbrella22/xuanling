# XuanLing MCP for ZCode

English | [Simplified Chinese](README-ZH.md)

The released `xuanling-mcp` 0.2.7 plugin is a self-contained ZCode integration.
It carries the verified Node.js launcher and native packages for macOS ARM64,
Linux x64 glibc, and Windows x64. It does not require a global npm installation
and does not download an executable during installation.

## Installation

Add `umbrella22/xuanling-zcode-marketplace` as a GitHub marketplace source in
ZCode, then install `xuanling-mcp` through ZCode's plugin manager. The runtime
requires Node.js 18.17 or newer on `PATH`.

## Runtime Paths

`.mcp.json` is the only launch contract. The plugin manifest references that
file, which starts the profile-local Node.js launcher through
`${ZCODE_PLUGIN_ROOT}` and passes `${ZCODE_PROJECT_DIR}` as the filesystem
capability root. The launcher selects the current platform package and verifies
its SHA-256 before executing it.

## Included Components

| Path | Purpose |
| --- | --- |
| `.zcode-plugin/plugin.json` | Plugin metadata and `.mcp.json` component reference |
| `.mcp.json` | Sole MCP launch configuration |
| `mcp-result-adapter.mjs` | ZCode model-facing result projection |
| `bin/node_modules` | Release-generated launcher and three native package aliases |
| `LICENSE` | MIT license |
| `skills/xuanling-mcp-tools/SKILL.md` | Tool usage, Memory proposal/review, output, and process guidance |

The launcher selects the current platform package, validates its metadata and
SHA-256, and starts the native MCP server. Unsupported OS, CPU, or libc
combinations fail before execution. The default catalog exposes all tool
profiles. Memory uses `~/.xuanling/memory.db` unless the launch contract is
restated with an explicit `--memory-db`.

ZCode appends `structuredContent` to the model-facing tool result. The result
adapter removes only the text block that is an exact JSON representation of
that same value, preserving human-readable and non-text blocks. The structured
value itself remains available to ZCode validation and structured consumers.

The adapter accepts only JSON object frames from the child. Malformed output or
an unresolved `tools/call` at clean child exit returns a nonzero status without
forwarding the invalid frame. Host termination is forwarded and force-terminated
after a 500 ms grace when the child does not exit.

## Agent Workflow

The bundled Skill prefers ZCode's native Read/Edit path for routine small work
and uses XuanLing for exact cross-platform search, explicit budgets, complete
pagination, hash/CAS overwrite, and atomic same-file multi-hunk patches.
Compound suffixes such as `d.ts` and `d.mts` are passed directly. Repeated
short validations with identical argv use `deterministic: true`; long jobs stay
on ZCode's background/job surface.

Memory uses a single-write L1/L2 split. Project-local facts that must appear in
every session stay in host file memory; cross-project shared facts use XuanLing
pending candidates. An explicit L1 pointer triggers one scoped
`memory_search` at task start or a topic switch. Search returns full active
records rather than a lightweight manifest, and review always requires an
explicit user decision for the concrete proposal.

## Security Boundary

`--workspace-root` constrains paths opened by XuanLing filesystem tools. It is
not a process sandbox. ZCode remains responsible for tool approval, and child
process isolation requires an OS sandbox or container when hostile execution
is possible. XuanLing 0.2.7 is not publisher-signed; npm provenance, the
source-bound native hashes, and the GitHub-attested marketplace archive reduce
distribution risk. They do not guarantee that every security product will
classify a new binary the same way.
