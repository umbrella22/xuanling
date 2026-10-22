# XuanLing MCP Replacement for ZCode

English | [简体中文](README-ZH.md)

XuanLing MCP Replacement turns XuanLing into the single file backend for ZCode's coding agent. It deliberately blocks ZCode's native file tools and requires a current SHA-256 precondition for every existing-file mutation, so file changes are explicit, reviewable and protected against concurrent edits. Current release: 0.7.0.

## Why use it

- **No silent bypass.** Native Read/Write/Edit/ApplyPatch/MultiEdit are denied before execution; file work has to go through XuanLing.
- **Every existing-file mutation carries a hash.** Overwrites, replacements, edits, batches and patches fail unless they present the SHA-256 (or preimage hash) of the content they expected.
- **Same behaviour on every OS.** One typed contract for paths, UTF-8, exact matching and atomic replacement across macOS, Linux and Windows.
- **Reviewable results.** Edits return diffs you can inspect, and risky edits can be made reversible.
- **Clear failure handling.** Conflicts, zero or multiple matches and stale hashes are stop signals; a failed batch reports per-file recovery state instead of guessing.

Who it's for: teams and repositories where file integrity matters more than native file-tool conveniences — agent-heavy editing, shared codebases, audited changes, or enforcing one filesystem contract. It is not the right choice if you need ZCode's native image rendering or a guaranteed native diff card.

## Install from the ZCode marketplace

1. Add `umbrella22/xuanling-zcode-marketplace` as a GitHub marketplace source in ZCode.
2. Disable or uninstall the additive `xuanling-mcp` plugin; only one XuanLing variant may be enabled at a time.
3. Install and enable the `xuanling-mcp-replace` plugin (version 0.7.0).
4. Make sure Node.js 18.17 or newer is available on `PATH`.

The plugin is self-contained: it ships matching macOS ARM64, Linux x64 (glibc 2.35 or newer) and Windows x64 runtimes. It does not require a global npm installation, and installation does not download a binary.

Validated on ZCode 3.10.2, where its tools appear as `mcp__plugin_xuanling-mcp-replace_xuanling__<tool>`; short names such as `fs_edit` refer to the suffix of that qualified name. Disabling or uninstalling this plugin removes its interception policy and restores ZCode's native file tools.

## Two variants: choose one

| Plugin | What it does | Choose it when |
| --- | --- | --- |
| [`xuanling-mcp`](../xuanling-mcp/README.md) (additive, default) | Adds XuanLing tools next to ZCode's native tools. | You want native Read/Edit and their UI, and call XuanLing only for cross-platform results, bounded output, hashed edits, processes or memory. |
| `xuanling-mcp-replace` (opt-in — this document) | Blocks ZCode's native Read/Write/Edit/ApplyPatch/MultiEdit and requires SHA-256 preconditions on XuanLing mutations. | You want every file mutation to go through one enforced contract and are willing to give up native file-tool conveniences. |

## What's included and how it works

The plugin bundles the same local XuanLing MCP server as the additive variant, with the complete catalog of 43 typed tools: filesystem inspection, search and mutation; direct-argv processes and pipelines; project detection and script execution; proposal-reviewed memory; sessions; and process-output artifacts. On top of that it installs an interception policy that denies native file tools, enforces the required preconditions on XuanLing mutations, and includes a Skill that tells the agent to treat XuanLing as the filesystem backend.

Required workflow:

1. Read existing UTF-8 text with `fs_read_text` (request the complete body when needed), or take a fingerprint with `fs_hash` when a semantic read is not required.
2. Pass the current lowercase 64-character SHA: `expected_sha256` for `fs_write_text` overwrite, `fs_replace_text`, `fs_edit` and every file in `fs_edit_batch`; `expected_preimage_sha256` for `fs_patch`.
3. Keep `include_diff=true` on edits and inspect the returned diff before continuing.
4. After a formatter or any external writer, read or hash the file again before the next mutation.
5. Treat conflicts, zero or multiple matches and stale hashes as stop-and-reread signals. For risky edits, request `reversible: true`, then use `change_commit` after review or `change_rollback` while the files still match.

Only `fs_write_text` with `mode=create` may omit a hash, and only for a path expected not to exist. The interception policy checks that the precondition is present and well formed; path, UTF-8, match and current-content checks remain authoritative in XuanLing.

Memory, process, project and session tools work as in the additive variant. Memory follows a proposal-first flow and stores data locally at `~/.xuanling/memory.db` by default; recall is local and lexical.

## Safety, trust and host limits

- The interception policy denies execution before it happens, but it cannot hide native tool names from ZCode's tool list.
- A native ZCode diff card is not guaranteed; MCP diff data remains available through `include_diff=true`. Because native Read is blocked, ZCode's native image rendering is unavailable in replacement mode.
- XuanLing filesystem tools are limited to the current project directory. This is a path capability, not a process sandbox: processes you launch can still reach other paths, and ZCode remains responsible for tool approval and OS-level isolation.
- Release artifacts come from the immutable XuanLing release pipeline: the launcher selects the matching platform package and verifies its SHA-256 before execution. XuanLing 0.7.0 is not signed with a platform publisher certificate; npm provenance, source-bound hashes and the attested marketplace archive reduce distribution risk instead.
- ZCode 3.10.2 is the validated host for the tool names and limits described here. Newer ZCode versions may change host tool naming or presentation; confirm against the current tool catalog.

## Links

- [XuanLing ZCode marketplace](https://github.com/umbrella22/xuanling-zcode-marketplace)
- [XuanLing source repository](https://github.com/umbrella22/xuanling)
- [XuanLing MCP server documentation](https://github.com/umbrella22/xuanling/blob/main/npm/packages/xuanling-mcp/README.md)
- [Additive variant for ZCode](../xuanling-mcp/README.md)
- [MIT License](LICENSE)
