# XuanLing MCP for ZCode

English | [简体中文](README-ZH.md)

XuanLing MCP is a local, self-contained tool server that gives ZCode's coding agent typed filesystem, process, project, memory and session tools. The same call returns the same structured result on macOS, Linux and Windows, and all data stays on your machine. Current release: 0.8.1.

## Why use it

- **Same result on every OS.** One typed call returns one structured answer; no grep/findstr/Select-String translation.
- **Bounded, resumable output.** Omitting the output budget returns at most 65,536 bytes with a cursor or resume token instead of a silent truncation; request the complete result explicitly when you need it.
- **Edits with real preconditions.** Whole-file writes and exact edits can require the SHA-256 of the content you read, so a file changed by someone else produces a conflict instead of an overwrite.
- **Consistent, atomic multi-file edits.** Ordered batches preflight every file and hash before the first write; risky edits can be recorded as reversible change sets.
- **Memory that asks before it remembers.** Search and read work immediately; changes become proposals that only an explicit review turns into canonical records. Storage is local SQLite full-text search, with no embedding model download and no network access.
- **Direct processes, no shell.** Programs run with explicit argv, so quoting and metacharacters never change meaning between platforms.

Who it's for: ZCode users and teams working in cross-platform repositories, agent-heavy editing sessions, or projects where a small amount of durable, reviewable memory is useful. If you want XuanLing to replace ZCode's native file tools instead of sitting beside them, use the [replacement variant](../xuanling-mcp-replace/README.md).

## Install from the ZCode marketplace

1. Add `umbrella22/xuanling-zcode-marketplace` as a GitHub marketplace source in ZCode.
2. Install and enable the `xuanling-mcp` plugin (version 0.8.1) from ZCode's plugin manager.
3. Make sure Node.js 18.17 or newer is available on `PATH`.

The plugin is self-contained: it ships matching macOS ARM64, Linux x64 (glibc 2.35 or newer) and Windows x64 runtimes. It does not require a global npm installation, and installation does not download a binary.

Validated on ZCode 3.10.2, where its tools appear as `mcp__plugin_xuanling-mcp_xuanling__<tool>`. Install and enable only one XuanLing variant at a time.

## Two variants: choose one

| Plugin | What it does | Choose it when |
| --- | --- | --- |
| `xuanling-mcp` (additive, default — this document) | Adds XuanLing tools next to ZCode's native tools. | You want native Read/Edit and their UI, and call XuanLing for cross-platform results, bounded output, hash-protected edits, processes or memory. |
| [`xuanling-mcp-replace`](../xuanling-mcp-replace/README.md) (opt-in) | Blocks ZCode's native Read/Write/Edit/ApplyPatch/MultiEdit and requires SHA-256 preconditions on XuanLing mutations. | You want every file mutation to go through one enforced contract and are willing to give up native file-tool conveniences. |

Installing the replacement variant requires disabling or uninstalling this one first; disabling the replacement restores ZCode's native file tools.

## What's included and how it works

The plugin bundles one local MCP server with the complete XuanLing catalog of 43 typed tools: filesystem inspection, search and mutation; direct-argv processes and pipelines; project detection and script execution; proposal-reviewed memory; sessions; and process-output artifacts. It also bundles a Skill that teaches the agent when to keep using ZCode's native tools and when to reach for XuanLing.

A typical session:

1. Find and read with bounded output, then keep the returned SHA-256.
2. Write or edit with that hash as the precondition, and review the returned diff.
3. If a formatter or another writer touched the file, read or hash it again before the next mutation.
4. Let project tools run the repository's own check/test/build scripts; long-running work stays on ZCode's background jobs.

Memory follows a proposal-first flow: project-local facts that every session needs stay in ZCode's own file memory, while facts shared across projects are proposed to XuanLing and only become canonical after an explicit review. The default database is `~/.xuanling/memory.db`; recall is local and lexical.

## Safety, trust and host limits

- XuanLing filesystem tools are limited to the current project directory. This is a path capability, not a process sandbox: processes you launch can still reach other paths, and ZCode remains responsible for tool approval and OS-level isolation.
- This additive variant installs no host-side interception policy. SHA-256 preconditions are opt-in, and the server does not rewrite your tool arguments; request the protection you want explicitly.
- Memory is stored locally; the plugin needs no API key, account or external service.
- Release artifacts come from the immutable XuanLing release pipeline: the launcher selects the matching platform package and verifies its SHA-256 before execution. XuanLing 0.8.1 is not signed with a platform publisher certificate; npm provenance, source-bound hashes and the attested marketplace archive reduce distribution risk instead.
- ZCode 3.10.2 is the validated host for the tool names and limits described here. Newer ZCode versions may change host tool naming or presentation; confirm against the current tool catalog.

## Links

- [XuanLing ZCode marketplace](https://github.com/umbrella22/xuanling-zcode-marketplace)
- [XuanLing source repository](https://github.com/umbrella22/xuanling)
- [XuanLing MCP server documentation](https://github.com/umbrella22/xuanling/blob/main/npm/packages/xuanling-mcp/README.md)
- [Replacement variant for ZCode](../xuanling-mcp-replace/README.md)
- [MIT License](LICENSE)
