# XuanLing MCP

English | [Simplified Chinese](README-ZH.md)

XuanLing MCP is a cross-platform, local Model Context Protocol server for
coding agents. It exposes 42 typed tools over stdio for filesystem work,
process execution, project discovery, durable memory, artifacts, and
long-running sessions.

The server is designed for hosts that need deterministic schemas, structured
failures, explicit filesystem capabilities, and memory writes that cannot
silently become canonical state.

## Highlights

- **Typed filesystem operations** with strict edits, SHA-256 preconditions,
  paginated search, resumable reads, and explicit output budgets.
- **Proposal-first Memory v2** with immutable record versions, explicit
  review, project/workspace scope isolation, and deterministic lexical recall.
- **Direct process execution** using program + argv without an implicit shell,
  with cancellation applied to the descendant process tree.
- **Selective tool profiles** so each host can expose only the capability
  families it needs.
- **Native npm distribution** for macOS, Linux, and Windows with no
  `postinstall` compilation or remote binary download.
- **Stable MCP contracts** backed by protocol, golden, persistence, restart,
  and cross-platform test suites.

## Installation

The npm launcher requires Node.js 18.17 or newer and installs the matching
native binary for the current platform.

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.2.7
xuanling-mcp --version
```

An MCP client can pin the same version without a global installation:

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "@xuanling-rs/xuanling-mcp@0.2.7",
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

Pinning the package version keeps the discovered MCP schema stable for an
active project. A global or project-local installation avoids the package
resolution step when the host starts the server frequently.

### Supported platforms

| Operating system | Architecture | Runtime requirement |
| --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | native binary |
| Linux | `x64` | glibc 2.35 or newer |
| Windows | `x64` | MSVC runtime |

Unsupported OS, CPU, and libc combinations fail with an explicit launcher
error. The package does not compile Rust or download executables during
installation. The launcher validates package metadata and the native binary's
SHA-256 before starting the server.

### Build from source

Source builds require Rust 1.97.

```sh
cargo build --locked --release -p xuanling-mcp
./target/release/xuanling-mcp --workspace-root /absolute/path/to/project
```

## Tool Profiles

The default catalog contains all 42 tools. Repeat `--tool-profile` to combine
smaller, stable groups:

| Profile | Tools | Capability family |
| --- | ---: | --- |
| `core` | 3 | system and portable path inspection |
| `fs` | 16 | filesystem read, search, preview, and mutation |
| `process` | 5 | direct processes and project detection/execution |
| `memory` | 9 | Memory v2 proposal, review, recall, and feedback |
| `advanced` | 9 | artifacts, ChangeSets, pipelines, and sessions |
| `all` | 42 | complete catalog; also the default when no profile is supplied |

`all` takes precedence when combined with another profile. Discovery and
dispatch use the same selection, so a hidden tool cannot be called by name.

## Filesystem Safety

Filesystem access is unrestricted when neither capability flag is supplied.
Production host configurations should declare at least one root:

- `--workspace-root <PATH>` is repeatable and grants read/write/delete access
  plus child-process working-directory admission inside the root.
- `--read-root <PATH>` is repeatable and grants read/list/search/hash access
  while rejecting writes, deletion, and child-process working directories.
- Supplying only `--read-root` creates a read-only deployment.

Mutating tools support explicit preimage checks. Use `expected_sha256` for
whole-file replacement and exact edits, or
`expected_preimage_sha256` for `fs_patch`. A conflict is reported before the
write when the file changed after it was read.

Window-capable tools accept an explicit output selector such as
`{"mode":"bounded","max_bytes":65536}`. Truncated reads and searches return a
typed cursor or resume token; they do not silently discard the remaining
result.

The filesystem capability controls paths opened by XuanLing. It is not an OS
sandbox for arbitrary child programs: host approval and process isolation
remain responsibilities of the MCP host and its execution environment.

## Memory v2

Memory v2 separates proposals from canonical records:

1. `memory_search` and `memory_get` inspect active records.
2. `memory_candidate_create`, `memory_candidate_replace`, or
   `memory_candidate_archive` creates a pending proposal.
3. `memory_review` accepts or rejects a specific proposal revision. Only an
   accepted review atomically advances the canonical record head.
4. Immutable versions, terminal reviews, and append-only feedback retain the
   history needed for audit and deterministic recovery.

Scopes use strict tagged values for `global`, `project`, and `workspace`.
Ancestor search follows workspace -> project -> global only when requested;
sibling projects are never searched.

Recall uses a deterministic lexical query plan over SQLite FTS5 (`unicode61`
and trigram), multi-channel fusion, visibility filtering, and stable reranking.
The default release does not require or download an embedding model and does
not perform network access for recall.

The default database is `~/.xuanling/memory.db`. Override it with
`--memory-db <PATH>` and optionally provide `--default-namespace <VALUE>`.
Memory initialization failure does not disable non-memory tools; memory calls
return a structured unavailable error instead.

### Maintenance

Canonical data can be exported, imported into an empty database, and used to
rebuild the derived search projection:

```sh
xuanling-mcp --memory-db /path/to/memory.db memory export --output backup.jsonl
xuanling-mcp --memory-db /path/to/empty.db memory import --input backup.jsonl
xuanling-mcp --memory-db /path/to/memory.db memory rebuild-index
```

Export writes a versioned JSONL stream with counts and a SHA-256 trailer.
Import validates the complete stream before one transactional write, and
`rebuild-index` never changes canonical rows.

## DeepSeek Harness

### Conversational install from the repository URL

<!-- xuanling-dsh-conversational-install:start -->
Copy `https://github.com/umbrella22/xuanling` into a DeepSeek Harness (DSH)
chat and ask it to install the XuanLing DSH integration. DSH will read the
repository-owned
[installer Skill](.agents/skills/xuanling-dsh-install/SKILL.md), ask which
profile and preset to use, show the exact frozen npm version and package
changes for confirmation, then install and verify them through `dsh plugin`.

This is a model-orchestrated workflow: DSH itself does not install arbitrary
URLs. When needed, the agent obtains the fixed repository ref in a new
temporary checkout, uses it only for bounded document discovery, and removes
the checkout before asking the first question. Path discovery may list tracked
paths or run a locator whose model-visible output is path names only; source
and manifest bodies never enter model context. The only loaded content is an
allowlisted root README, the installer Skill, and optionally the DSH
integration guide. The agent never executes repository code or installs from
the checkout; profile packages still come only from the public npm registry.
The manual integration guide below remains the fallback when interactive
questions or repository access are unavailable.
<!-- xuanling-dsh-conversational-install:end -->

[`integrations/deepseek-harness`](integrations/deepseek-harness/) contains
host-specific bundles for additive Memory tools, additive or replacement
filesystem tools, schema projection, strict overwrite policy, and two
on-demand workflow Skills. The integration remains outside the Rust tool
contracts, allowing DeepSeek Harness-specific routing and policy to evolve
without changing the MCP catalog for other hosts.

See the
[DeepSeek Harness integration guide](integrations/deepseek-harness/README.md)
for bundle selection, installation, and runtime configuration.

## Repository Layout

| Path | Purpose |
| --- | --- |
| `crates/xuanling-toolkit` | Cross-platform filesystem, process, project, session, and artifact implementation. |
| `crates/xuanling-memory` | Memory v2 lifecycle, SQLite persistence, lexical retrieval, and JSONL maintenance. |
| `crates/xuanling-mcp` | stdio MCP server, typed handlers, profiles, and protocol contracts. |
| `integrations` | Installable host-specific adapters, policy, and Skills. |
| `npm` | Node launcher, native package staging, integrity checks, and release automation. |
| `test` | Repository-only fixtures, probes, evaluation overlays, and acceptance reports. |
| `docs` | Accepted decisions, architecture, integration contracts, and execution records. |

The current documentation index is available at
[`docs/README.md`](docs/README.md). Repository provenance and the detached
workspace boundary are recorded in
[`docs/repository-boundary.md`](docs/repository-boundary.md).

## Development

Repository development requires Rust 1.97, Node.js 22.14 or newer, and npm
11.5.1 or newer.

```sh
cargo fmt -p xuanling-toolkit -p xuanling-memory -p xuanling-mcp -- --check
cargo check -p xuanling-toolkit -p xuanling-memory -p xuanling-mcp --all-targets
cargo clippy -p xuanling-toolkit -p xuanling-memory -p xuanling-mcp --all-targets -- -D warnings

cargo test -p xuanling-toolkit --features test-fixtures --test contract
cargo test -p xuanling-memory --test contract
cargo test -p xuanling-mcp --test protocol
cargo test -p xuanling-mcp --test golden

npm --prefix npm run check
npm --prefix npm run check:docs
npm --prefix npm test
```

The complete host contract and error mapping are documented in the
[MCP integration guide](docs/guides/xuanling-mcp-integration.md). npm package
assembly and publishing are documented in [`npm/README.md`](npm/README.md).

## License

Licensed under the [MIT License](LICENSE).
