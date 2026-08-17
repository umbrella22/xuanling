# XuanLing MCP for ZCode

English | [Simplified Chinese](README-ZH.md)

The released `xuanling-mcp` 0.2.3 plugin is a self-contained ZCode integration.
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
| `bin/node_modules` | Release-generated launcher and three native package aliases |
| `LICENSE` | MIT license |
| `skills/xuanling-mcp-tools/SKILL.md` | Tool usage, Memory proposal/review, output, and process guidance |

The launcher selects the current platform package, validates its metadata and
SHA-256, and starts the native MCP server. Unsupported OS, CPU, or libc
combinations fail before execution. The default catalog exposes all tool
profiles. Memory uses `~/.xuanling/memory.db` unless the launch contract is
restated with an explicit `--memory-db`.

## Security Boundary

`--workspace-root` constrains paths opened by XuanLing filesystem tools. It is
not a process sandbox. ZCode remains responsible for tool approval, and child
process isolation requires an OS sandbox or container when hostile execution
is possible. XuanLing 0.2.3 is not publisher-signed; npm provenance, the
source-bound native hashes, and the GitHub-attested marketplace archive reduce
distribution risk. They do not guarantee that every security product will
classify a new binary the same way.
