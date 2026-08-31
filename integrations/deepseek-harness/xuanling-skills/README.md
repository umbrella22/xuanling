# xuanling-dsh-skills

English | [Simplified Chinese](README-ZH.md)

DeepSeek Harness bundle containing two on-demand XuanLing workflow Skills and
the strict whole-file overwrite policy. It registers no MCP server and has no
dependency on `@xuanling-rs/xuanling-mcp`.

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-skills@0.3.0
```

This command augments DSH's shipped Web profile. Use `--profile headless` for
the shipped Headless profile. Unknown profile names start with the base bundle
only and do not provide a runnable Web or Headless application by themselves.

Use it with exactly one XuanLing tool bundle. `xuanling-file-workflow` uses
`mcp_catalog__xuanling` to activate an exact missing XuanLing file tool, then
routes between it and Harness-native tools; it also covers CAS overwrite,
compound suffixes, atomic multi-hunk
patches, deterministic repeated validation, and host background jobs. Its v3
request policy uses the omitted 65,536-byte output budget, numbered reads,
conditional `known_sha256` reads, exact project scripts, and minimal-environment
diagnostics. It keeps `include_diff: true` because DSH-native diff visibility
for XuanLing edits is not yet proven; SHA is not semantic edit validation.
`xuanling-memory-workflow` activates only the next required memory operation,
keeps project-local L1 facts separate from shared XuanLing L2 facts, uses
explicit pointer-driven pull recall, and preserves the
proposal/review boundary. The policy rejects an existing-file overwrite
without `expected_sha256` before MCP dispatch and returns a Host `ask` gate for
the exact `mcp__xuanling__memory_review` tool. DSH dispatches only an
`allowed-once` outcome; rejection, cancellation, unavailable approval, or a
call without an agent fails closed.

Node.js 22.14 or newer is required. Licensed under the MIT License.
