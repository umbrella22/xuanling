# xuanling-dsh-memory

English | [Simplified Chinese](README-ZH.md)

Recommended DeepSeek Harness bundle for XuanLing Memory v2. It adds the full
nine-tool proposal, review, recall, archival, and feedback profile while
retaining every Harness-native tool.

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-memory@0.2.6
```

This command augments DSH's shipped Web profile. Use `--profile headless` for
the shipped Headless profile. Unknown profile names start with the base bundle
only and do not provide a runnable Web or Headless application by themselves.

The bundle installs `@xuanling-rs/xuanling-mcp@0.2.6` inside the selected profile. Its
schema adapter and JS launcher are resolved from that profile, and the launcher
verifies the selected native package before startup. No global package or
install-time binary download is required.

The result adapter also applies the DSH projection contract: repeated text
blocks that exactly duplicate `structuredContent` are reduced to one complete
text block, while the structured value remains available to Code Mode and
output validation.

The schema adapter validates child JSONL frames and request settlement. A
malformed frame or an unresolved `tools/list`/`tools/call` at clean child exit
returns a nonzero status; a child ignoring host termination is force-terminated
after a 500 ms grace.

Use `@xuanling-rs/xuanling-dsh-skills@0.2.6` alongside this bundle for the proposal-first
Memory workflow and strict whole-file overwrite policy. Do not combine this
bundle with another XuanLing tool bundle in the same profile because both
register the `xuanling-tools` row.

Node.js 22.14 or newer is required. Supported native targets are macOS ARM64,
Linux x64 glibc 2.35+, and Windows x64 MSVC. Licensed under the MIT License.
