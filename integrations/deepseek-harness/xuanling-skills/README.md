# xuanling-dsh-skills

English | [Simplified Chinese](README-ZH.md)

DeepSeek Harness bundle containing two on-demand XuanLing workflow Skills and
the strict whole-file overwrite policy. It registers no MCP server and has no
dependency on `@xuanling-rs/xuanling-mcp`.

```sh
dsh plugin --profile demo add @xuanling-rs/xuanling-dsh-skills@0.2.3
```

Use it with exactly one XuanLing tool bundle. `xuanling-file-workflow` routes
between Harness-native and XuanLing file tools. `xuanling-memory-workflow`
keeps proposal creation and user-authorized review in separate turns. The
policy rejects an existing-file overwrite without `expected_sha256` before
MCP dispatch.

Node.js 22.14 or newer is required. Licensed under the MIT License.
