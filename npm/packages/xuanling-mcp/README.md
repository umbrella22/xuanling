# XuanLing MCP

English | [Simplified Chinese](README-ZH.md)

`@xuanling-rs/xuanling-mcp` is a cross-platform local Model Context Protocol server for
coding agents. It exposes 42 typed tools over stdio for filesystem work,
process execution, project discovery, artifacts, sessions, and proposal-first
SQLite memory.

## Install

The launcher requires Node.js 18.17 or newer.

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.2.6
xuanling-mcp --version
```

MCP clients can also pin the version with `npx`:

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "@xuanling-rs/xuanling-mcp@0.2.6",
        "--workspace-root",
        "/absolute/path/to/project",
        "--tool-profile",
        "core",
        "--tool-profile",
        "fs",
        "--tool-profile",
        "memory"
      ]
    }
  }
}
```

Pinning the version keeps the discovered MCP contract stable for an active
project. A global or project-local installation avoids the package resolution
step when the host starts the server frequently.

## Supported Platforms

| Operating system | Architecture | Runtime requirement |
| --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | native binary |
| Linux | `x64` | glibc 2.35 or newer |
| Windows | `x64` | MSVC runtime |

Unsupported OS, CPU, and libc combinations fail with an explicit error. The
package does not compile Rust, run a `postinstall` script, or download
executables. The launcher validates package metadata and the selected native
binary's SHA-256 before startup.

## Tool Profiles

The default catalog exposes all 42 tools. Repeat `--tool-profile` to combine
smaller groups:

| Profile | Tools | Capability family |
| --- | ---: | --- |
| `core` | 3 | system and portable path inspection |
| `fs` | 16 | filesystem read, search, preview, and mutation |
| `process` | 5 | direct processes and project detection/execution |
| `memory` | 9 | Memory v2 proposal, review, recall, and feedback |
| `advanced` | 9 | artifacts, ChangeSets, pipelines, and sessions |
| `all` | 42 | complete catalog and default selection |

## Filesystem Capabilities

- `--workspace-root <PATH>` is repeatable and grants read/write/delete access
  plus child-process working-directory admission inside the root.
- `--read-root <PATH>` is repeatable and grants read/list/search/hash access
  while rejecting writes, deletion, and child-process working directories.
- With neither flag, XuanLing filesystem access is unrestricted. With only
  `--read-root`, the deployment is read-only.

Mutating tools support SHA-256 preimage checks. Window-capable tools support
explicit byte budgets and return typed cursors or resume tokens instead of
silently truncating results.

The pathname capability is not an OS sandbox for child programs. Tool
approval and hostile process isolation belong to the MCP host and execution
environment.

## Memory v2

Create, replace, and archive calls produce pending proposals. Only an explicit
`memory_review` decision can atomically advance an immutable canonical record.
Strict `global`, `project`, and `workspace` scopes prevent sibling-project
recall.

Recall uses deterministic SQLite FTS5 query planning and stable lexical
reranking. It does not require or download an embedding model. The default
database is `~/.xuanling/memory.db`; use `--memory-db <PATH>` to override it.

## Server Options

```text
--base-dir <PATH>                  Relative-path resolution context
--workspace-root <PATH>            Repeatable read/write capability root
--read-root <PATH>                 Repeatable read-only capability root
--memory-db <PATH>                 Shared SQLite memory database
--default-namespace <VALUE>        Default memory namespace
--sqlite-busy-timeout-ms <NUMBER>  SQLite busy timeout (default: 5000)
--tool-profile <PROFILE>           Repeatable tool group; default: all
--compat-lenient-object-params     Opt-in compatibility for affected hosts
```

## Source and Documentation

- Source: <https://github.com/umbrella22/xuanling>
- Integration guide: <https://github.com/umbrella22/xuanling/blob/main/docs/guides/xuanling-mcp-integration.md>
- DeepSeek Harness integration: <https://github.com/umbrella22/xuanling/tree/main/integrations/deepseek-harness>
- Issues: <https://github.com/umbrella22/xuanling/issues>

Licensed under the [MIT License](LICENSE).
