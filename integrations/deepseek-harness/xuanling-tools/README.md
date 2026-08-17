# xuanling-dsh-tools

English | [Simplified Chinese](README-ZH.md)

Additive DeepSeek Harness bundle for the complete XuanLing MCP catalog. It
keeps all Harness-native tools enabled and adds XuanLing tools under the
`mcp__xuanling__` prefix.

```sh
dsh plugin --profile full add @xuanling-rs/xuanling-dsh-tools@0.2.3
```

The exact `@xuanling-rs/xuanling-mcp@0.2.3` runtime is installed in the profile and started
through its verified JS launcher. A global npm package is neither required nor
used. Set `XUANLING_WORKSPACE_ROOT` only when the filesystem capability root
must differ from the DSH working directory.

This package overlaps with native file, process, and project tools. Prefer
`@xuanling-rs/xuanling-dsh-memory` for the smaller daily tool surface. Do not install this
package with another XuanLing tool bundle in the same profile.

Node.js 22.14 or newer is required. Licensed under the MIT License.
