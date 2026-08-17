# xuanling-dsh-memory

English | [Simplified Chinese](README-ZH.md)

Recommended DeepSeek Harness bundle for XuanLing Memory v2. It adds the full
nine-tool proposal, review, recall, archival, and feedback profile while
retaining every Harness-native tool.

```sh
dsh plugin --profile demo add xuanling-dsh-memory@0.2.1
```

The bundle installs `xuanling-mcp@0.2.1` inside the selected profile. Its
schema adapter and JS launcher are resolved from that profile, and the launcher
verifies the selected native package before startup. No global package or
install-time binary download is required.

Use `xuanling-dsh-skills@0.2.1` alongside this bundle for the proposal-first
Memory workflow and strict whole-file overwrite policy. Do not combine this
bundle with another XuanLing tool bundle in the same profile because both
register the `xuanling-tools` row.

Node.js 22.14 or newer is required. Supported native targets are macOS ARM64,
Linux x64 glibc 2.35+, and Windows x64 MSVC. Licensed under the MIT License.
