# XuanLing

[简体中文](README-ZH.md) · [CHANGELOG](CHANGELOG.md) · MIT

Local-first execution and memory for coding agents.

XuanLing is a Rust tool runtime that runs beside your coding agent. It provides a typed MCP server,
DeepSeek Harness bundles, and an optional visual workflow editor. Everything runs on your machine:
the MCP server speaks stdio, the native binaries are installed from npm without compiling or
downloading at install time, and Memory data stays in a local SQLite database.

The repository ships four surfaces around the same core:

| You want to | Use | Start here |
| --- | --- | --- |
| Give any MCP host filesystem, process, artifact and memory tools | XuanLing MCP server (43 typed tools) | [Install](#xuanling-mcp-server) · [Package README](npm/packages/xuanling-mcp/README.md) |
| Use XuanLing from DeepSeek Harness (DSH) | Four DSH bundles with lazy tool projection | [DSH integration](integrations/deepseek-harness/README.md) |
| Build and run visual agent workflows inside DSH | Blueprint, with durable Runs and optional TeamStage | [Blueprint README](integrations/deepseek-harness/xuanling-blueprint/README.md) |
| Use XuanLing from ZCode | Additive or filesystem-replacement marketplace plugins | [ZCode plugins](integrations/zcode-plugin/plugins/xuanling-mcp/README.md) |

![A four-specialist Rust review workflow on the Blueprint canvas](integrations/deepseek-harness/xuanling-blueprint/assets/readme/rust-review-blueprint.png)

*The optional Blueprint editor inside DeepSeek Harness. The workflow runs four specialist Agent
reviews in parallel, joins their results, and writes a synthesized report. The graph is a saved
example, not a bundled template.*

## Highlights

- **43 typed tools** for filesystem work, process execution, project discovery, artifacts,
  long-running sessions, and proposal-first Memory v2.
- **Filesystem safety by explicit capability.** Repeatable `--workspace-root` and `--read-root`
  flags, SHA-256 preimage checks, typed output budgets, and resumable reads.
- **Proposal-first memory.** Candidate writes stay pending until an explicit review accepts a
  concrete revision. Canonical records are immutable and scoped to global, project, or workspace.
- **Direct process execution.** Program plus argv, no implicit shell, with cancellation applied to
  the descendant process tree.
- **Selective tool profiles.** Each MCP host exposes only the capability families it needs; `all`
  remains the default.
- **Verified native distribution.** npm installs a platform launcher and matching native binary
  with no `postinstall` compilation, no remote binary download, and SHA-256 validation at startup.

## XuanLing MCP server

The MCP server exposes the complete catalog over stdio and works with any MCP client.

### Install

The launcher requires Node.js 18.17 or newer and installs the matching native package for the
current platform.

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.9.0
xuanling-mcp --version
```

An MCP client can pin the same version without a global install:

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "@xuanling-rs/xuanling-mcp@0.9.0",
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

Pinning the package version keeps the discovered MCP schema stable for an active project. A global
or project-local install also avoids the package resolution step on every server start.

### Supported platforms

| Operating system | Architecture | Runtime requirement |
| --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | native binary |
| Linux | `x64` | glibc 2.35 or newer |
| Windows | `x64` | MSVC runtime |

Unsupported OS, CPU, and libc combinations fail with an explicit launcher error. The launcher
validates package metadata and the native binary's SHA-256 before starting the server.

### Tool profiles

The default catalog exposes all 43 tools. Repeat `--tool-profile` to combine smaller groups:

| Profile | Tools | Capability family |
| --- | ---: | --- |
| `core` | 3 | system and portable path inspection |
| `fs` | 17 | filesystem read, search, preview, and mutation |
| `process` | 5 | direct processes and project detection/execution |
| `memory` | 9 | Memory v2 proposal, review, recall, and feedback |
| `advanced` | 9 | artifacts, ChangeSets, pipelines, and sessions |
| `all` | 43 | complete catalog; the default when no profile is supplied |

`all` takes precedence when combined with another profile. Discovery and dispatch use the same
selection, so a hidden tool cannot be called by name.

### Filesystem safety

XuanLing filesystem access is unrestricted when neither capability flag is supplied. Production
hosts should declare at least one root:

- `--workspace-root <PATH>` is repeatable and grants read/write/delete access plus child-process
  working-directory admission inside the root.
- `--read-root <PATH>` is repeatable and grants read/list/search/hash access while rejecting
  writes, deletion, and child-process working directories.
- Supplying only `--read-root` creates a read-only deployment.

Mutating tools support explicit preimage checks. Use `expected_sha256` for whole-file replacement
and exact edits, or `expected_preimage_sha256` for `fs_patch`. A conflict is reported before the
write when the file changed after it was read. Window-capable tools accept an explicit output
selector such as `{"mode":"bounded","max_bytes":65536}`; truncated reads and searches return a typed
cursor or resume token instead of silently discarding the remaining result.

The filesystem capability controls paths opened by XuanLing. It is not an OS sandbox for arbitrary
child programs: host approval and process isolation remain responsibilities of the MCP host and its
execution environment.

### Memory v2

Memory separates proposals from canonical records:

1. `memory_search` and `memory_get` inspect active records.
2. `memory_candidate_create`, `memory_candidate_replace`, or `memory_candidate_archive` creates
   a pending proposal.
3. `memory_review` accepts or rejects a specific proposal revision. Only an accepted review
   atomically advances the canonical record head.
4. Immutable versions, terminal reviews, and append-only feedback retain the history needed for
   audit and deterministic recovery.

Scopes use strict tagged values for `global`, `project`, and `workspace`. Ancestor search follows
workspace → project → global only when requested; sibling projects are never searched. Recall uses
a deterministic lexical query plan over SQLite FTS5, multi-channel fusion, visibility filtering,
and stable reranking. The default release does not require or download an embedding model and does
not perform network access for recall.

The default database is `~/.xuanling/memory.db`; override it with `--memory-db <PATH>`. The stdio
server opens the database only on the first valid Memory call, so startup, discovery, non-memory
tools, and malformed Memory requests do not create or migrate it.

Canonical data can be exported, imported into an empty database, and used to rebuild the derived
search projection:

```sh
xuanling-mcp --memory-db /path/to/memory.db memory export --output backup.jsonl
xuanling-mcp --memory-db /path/to/empty.db memory import --input backup.jsonl
xuanling-mcp --memory-db /path/to/memory.db memory rebuild-index
```

Export writes a versioned JSONL stream with counts and a SHA-256 trailer. Import validates the
complete stream before one transactional write, and `rebuild-index` never changes canonical rows.

## DeepSeek Harness

The [DSH integration](integrations/deepseek-harness/README.md) adds XuanLing tools to DeepSeek
Harness profiles. Four bundles cover different tradeoffs:

| Bundle | What it adds | Use when |
| --- | --- | --- |
| `xuanling-dsh-memory` | Complete nine-tool Memory v2 lifecycle with lazy schema projection | Recommended daily configuration |
| `xuanling-dsh-skills` | File and Memory workflow Skills plus strict overwrite policy | Combined with exactly one tool bundle |
| `xuanling-dsh-tools` | Complete XuanLing catalog with lazy activation and native tools retained | You need artifacts, projects, filesystem, and process tools |
| `xuanling-dsh-tools-replace` | Same-name filesystem facade backed by XuanLing CAS/batch semantics | You want XuanLing to replace DSH's native text file tools |

The recommended starting point is `xuanling-dsh-memory` plus `xuanling-dsh-skills`. The optional
[Blueprint plugin](integrations/deepseek-harness/xuanling-blueprint/README.md) adds a visual graph
editor, durable Runs, and optional native Agent Teams stages; it is installed separately.

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-memory@0.9.0 \
  @xuanling-rs/xuanling-dsh-skills@0.9.0
```

Replace `web` with the profile you use. The shipped `headless` profile works the same way; a new
custom profile contains only the base bundle and does not include a Web or Headless application.

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

The bundles use Host-side lazy projection: the complete MCP catalog is cached, but the model
initially sees only `mcp_catalog__xuanling` and activates exact tool names on demand. This lowers
initial schema cost without changing the server contract. See the
[DSH integration guide](integrations/deepseek-harness/README.md) for bundle selection and runtime
configuration.

## Blueprint

[Blueprint](integrations/deepseek-harness/xuanling-blueprint/README.md) is an optional DSH plugin
for visual workflows. Build a graph of Input, Agent task, Approval, Condition, Join (all), and
Output nodes; bind existing DSH Agents, Skills, and MCP tools; choose a model per Agent task. A Run
freezes the definition and package resources, records an intent before every external effect, and
keeps unknown outcomes in `recovery_required` instead of replaying them. Workflows can be exported
and imported as portable ZIP packages, and an optional TeamStage mode runs one Agent task as a
native DSH Agent Teams stage.

## ZCode

The [ZCode plugins](integrations/zcode-plugin/plugins/xuanling-mcp/README.md) ship the same verified
native runtime through the `umbrella22/xuanling-zcode-marketplace` marketplace. The additive
`xuanling-mcp` plugin keeps ZCode's native file tools; the opt-in `xuanling-mcp-replace` plugin
replaces them with XuanLing's hash-preconditioned edit path. Install only one variant at a time.

## Repository layout

| Path | Purpose |
| --- | --- |
| `crates/xuanling-toolkit` | Cross-platform filesystem, process, project, session, and artifact implementation. |
| `crates/xuanling-memory` | Memory v2 lifecycle, SQLite persistence, lexical retrieval, and JSONL maintenance. |
| `crates/xuanling-mcp` | stdio MCP server, typed handlers, profiles, and protocol contracts. |
| `integrations/deepseek-harness` | DSH integration bundles and the optional Blueprint plugin. |
| `integrations/zcode-plugin` | ZCode marketplace plugins. |
| `npm` | Node launcher, native package staging, integrity checks, and release automation. |
| `test` | Repository-only contract fixtures, probes, and release verification assets. |
| `.agents/skills/xuanling-dsh-install` | Model-driven DSH installer Skill used by the conversational flow. |

Plans, acceptance evidence, and incident records are kept outside the tracked tree under `docs/`
on the development machine; they are not part of a public checkout.

## Version and compatibility

The current repository release is `0.9.0`. Published npm versions and this repository revision can
target different DSH channels: check [CHANGELOG.md](CHANGELOG.md),
[Releases](https://github.com/umbrella22/xuanling/releases), and each integration README for the
exact channel and peer floor of the version you install. A DSH plugin installed into a profile is
validated against that profile's runtime; incompatible plugin versions are disabled rather than
started.

## Development

Repository development requires Rust 1.98, Node.js 22.14 or newer, and npm 11.5.1 or newer.

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

Package assembly and publishing are documented in [npm/README.md](npm/README.md); the test asset
inventory is in [test/README.md](test/README.md).

## License

MIT
