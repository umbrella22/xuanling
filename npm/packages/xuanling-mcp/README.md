# XuanLing MCP

English | [Simplified Chinese](README-ZH.md)

`@xuanling-rs/xuanling-mcp` is a local, cross-platform Model Context Protocol
(MCP) server for coding agents. It exposes 43 typed tools over stdio for
filesystem work, process and project execution, artifacts, sessions, and
proposal-first Memory v2, with deterministic schemas, structured failures, and
explicit filesystem boundaries.

## What and Why

XuanLing gives an MCP host one local, predictable tool surface instead of a
collection of OS-specific scripts. Its main properties are:

- **43 typed tools with combinable profiles.** A host can expose the complete
  catalog or only the families it needs, and a hidden tool cannot be called by
  name.
- **Filesystem work with explicit safety preconditions.** Mutations support
  SHA-256 preimage checks, window-capable reads and searches return typed
  cursors instead of silently truncating, and path access is controlled by
  explicit capability roots.
- **Proposal-first Memory v2.** Memory writes stay pending until an explicit
  `memory_review` decision advances an immutable canonical record, so an agent
  cannot silently rewrite persistent memory.
- **Direct process and project execution.** Commands run as program + argv
  without an implicit shell, and cancellation applies to the descendant process
  tree.
- **Native npm distribution.** Installation runs no `postinstall`, compiles no
  Rust, and downloads no binary from a remote URL; the launcher verifies the
  platform package metadata and the native binary's SHA-256.

**Which package do I need?** Use `@xuanling-rs/xuanling-mcp` when an MCP host can
launch a stdio server directly. For DeepSeek Harness, install a bundle instead:
`@xuanling-rs/xuanling-dsh-memory` for the recommended Memory v2 profile,
`@xuanling-rs/xuanling-dsh-tools` for the additive full catalog, or
`@xuanling-rs/xuanling-dsh-tools-replace` to replace DSH filesystem tools.
`@xuanling-rs/xuanling-dsh-skills` adds workflow Skills and no MCP tools. The
[DeepSeek Harness integration README](https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/README.md)
covers bundle selection and setup.

## Requirements

- Node.js 18.17 or newer.
- An MCP host that can start a stdio server.
- One of the supported platforms:

| Operating system | Architecture | Runtime requirement |
| --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | native binary |
| Linux | `x64` | glibc 2.35 or newer |
| Windows | `x64` | MSVC runtime |

No Rust toolchain or compiler is required. Unsupported OS, CPU, or libc
combinations fail with an explicit launcher error.

## Install

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.7.0
xuanling-mcp --version
```

A global or project-local installation avoids the package resolution step when
the host starts the server frequently. Hosts that prefer on-demand execution can
use the pinned `npx` configuration in [Quickstart](#quickstart).

Pinning the exact version keeps the discovered MCP contract stable for an
active project. Published npm versions are immutable.

## Quickstart

Add the server to the MCP client configuration:

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "@xuanling-rs/xuanling-mcp@0.7.0",
        "--workspace-root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Restart the host so it launches the server and completes MCP `initialize`.
Initialization metadata publishes `xuanling.tool_count` for the selected catalog
and `xuanling.catalog_sha256` for the model-visible definitions. Add repeatable
`--tool-profile` entries to expose only the families the host needs; see
[Tool profiles](#tool-profiles).

## Usage and Configuration

### Tool profiles

The default catalog contains all 43 tools. Repeat `--tool-profile` to combine
smaller groups:

| Profile | Tools | Capability family |
| --- | ---: | --- |
| `core` | 3 | system and portable path inspection |
| `fs` | 17 | filesystem read, search, preview, and mutation |
| `process` | 5 | direct processes and project detection/execution |
| `memory` | 9 | Memory v2 proposal, review, recall, and feedback |
| `advanced` | 9 | artifacts, ChangeSets, pipelines, and sessions |
| `all` | 43 | complete catalog and default selection |

`all` takes precedence when combined with another profile. Discovery and
dispatch use the same selection, so a hidden tool cannot be called by name.
Changing profiles requires restarting the server process.

### Filesystem boundaries

- `--workspace-root <PATH>` is repeatable and grants read/write/delete access
  plus child-process working-directory admission inside the root.
- `--read-root <PATH>` is repeatable and grants read/list/search/hash access
  while rejecting writes, deletion, and child-process working directories.
- With neither flag, XuanLing filesystem access is unrestricted. Supplying only
  `--read-root` creates a read-only deployment.
- In a contained deployment, `--base-dir` defaults to the first
  `--workspace-root`; `--base-dir` is a relative-path context, not a sandbox.

Mutating tools support SHA-256 preimage checks. Window-capable tools accept
explicit byte budgets and return typed cursors or resume tokens instead of
silently truncating results.

The pathname capability is not an OS sandbox for child programs. Tool approval
and hostile process isolation belong to the MCP host and execution environment.

### Memory v2

Memory v2 separates proposals from canonical records:

1. `memory_search` and `memory_get` inspect active records.
2. `memory_candidate_create`, `memory_candidate_replace`, and
   `memory_candidate_archive` produce pending proposals.
3. `memory_review` accepts or rejects a specific proposal revision. Only an
   accepted review atomically advances the canonical record head.
4. Immutable versions, terminal reviews, and append-only feedback keep the
   history needed for audit and recovery.

`global`, `project`, and `workspace` scopes are strict; sibling projects are
never searched. Recall uses a deterministic lexical query plan over SQLite FTS5
and does not require or download an embedding model. The default database is
`~/.xuanling/memory.db`; override it with `--memory-db <PATH>`. The server opens
the database lazily on the first valid Memory tool call, so startup, discovery,
and non-memory tools never create or migrate it.

Canonical data can be exported, imported into an empty database, and used to
rebuild the derived search projection:

```sh
xuanling-mcp --memory-db /path/to/memory.db memory export --output backup.jsonl
xuanling-mcp --memory-db /path/to/empty.db memory import --input backup.jsonl
xuanling-mcp --memory-db /path/to/memory.db memory rebuild-index
```

Export writes a versioned JSONL stream, import validates the complete stream
before one transactional write, and `rebuild-index` never changes canonical
rows.

### Server options

```text
--base-dir <PATH>                  Base directory for relative tool paths (not a sandbox)
--workspace-root <PATH>            Repeatable read/write/delete capability root
--read-root <PATH>                 Repeatable read-only capability root
--memory-db <PATH>                 Shared SQLite memory database (default: ~/.xuanling/memory.db)
--default-namespace <VALUE>        Namespace used when a memory request omits one
--sqlite-busy-timeout-ms <NUMBER>  SQLite busy timeout (default: 5000)
--tool-profile <PROFILE>           Repeatable tool group; default: all
--compat-lenient-object-params     Opt-in compatibility for hosts that stringify object parameters
```

`xuanling-mcp memory export|import|rebuild-index` are maintenance subcommands;
they do not start a stdio server session.

## How it works

- The npm package is a Node.js launcher. It resolves the platform-specific
  native package, validates its version metadata and binary SHA-256, then
  forwards argv, stdio, signals, and exit status to the native server.
- The native server speaks MCP over stdin/stdout only. It opens no network
  listener and makes no remote calls.
- The tool catalog is static for the lifetime of the server process.
  `tools/list` is paginated with opaque cursors, and the host must follow
  `nextCursor` until it is absent.
- Memory is a local SQLite database. It is opened lazily, and recall performs no
  network access.

## Compatibility and limits

- Supported npm targets are macOS Apple Silicon, Linux x64 with glibc 2.35 or
  newer, and Windows x64 MSVC. Intel macOS, ARM Linux, glibc 2.34 or older,
  musl Linux, and ARM Windows are not published.
- Supported MCP protocol revisions are `2024-11-05`, `2025-03-26`,
  `2025-06-18`, and `2025-11-25`.
- The native binaries in 0.7.0 are not Developer ID or Authenticode signed.
  npm provenance and the launcher's SHA-256 check provide the package integrity
  contract.
- The filesystem capability is not an OS sandbox for processes started by
  XuanLing tools.
- The catalog does not change during a server process, and the server does not
  advertise `tools.listChanged`. Restart the server to change profiles or
  catalog configuration.
- Memory is a single local SQLite database per server process. It requires a
  writable database path or a resolvable `HOME`/`USERPROFILE`.
- The server uses stdio transport only; there is no HTTP or remote mode.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Unsupported platform: <os>/<arch>` | The target is not published. Use macOS Apple Silicon, Linux x64 with glibc 2.35 or newer, or Windows x64. |
| `Unsupported Linux libc` or `Unsupported Linux glibc` | XuanLing publishes a glibc build only and requires glibc 2.35 or newer. |
| `Missing optional dependency` or `Native binary checksum mismatch` | Reinstall the pinned version, for example `npm install --global @xuanling-rs/xuanling-mcp@0.7.0`. Published npm versions are immutable. |
| Memory tools report `memory store unavailable` or `cannot resolve the default memory DB path` | Pass an explicit writable `--memory-db <PATH>`, or set `HOME`/`USERPROFILE` so the default `~/.xuanling/memory.db` can be resolved. Non-memory tools keep working. |
| The host sees fewer tools than expected | A `--tool-profile` selection is active. Combine profiles or use `--tool-profile all`, then restart the server process. |
| The host exits before `initialize` | Check the Node.js version (18.17 or newer) and the host's stdio launch configuration. |

## Links

- Source: <https://github.com/umbrella22/xuanling>
- Product documentation: <https://github.com/umbrella22/xuanling/blob/main/README.md>
- DeepSeek Harness integration: <https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/README.md>
- Changelog: <https://github.com/umbrella22/xuanling/blob/main/CHANGELOG.md>
- Issues: <https://github.com/umbrella22/xuanling/issues>
- npm package: <https://www.npmjs.com/package/@xuanling-rs/xuanling-mcp>

Licensed under the [MIT License](LICENSE).
