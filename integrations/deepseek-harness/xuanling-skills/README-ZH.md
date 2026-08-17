# xuanling-dsh-skills

[English](README.md) | 简体中文

该 DeepSeek Harness bundle 包含两个按需 XuanLing 工作流 Skill 和严格整文件覆盖 policy。
它不注册 MCP server，也不依赖 `@xuanling-rs/xuanling-mcp`。

```sh
dsh plugin --profile demo add @xuanling-rs/xuanling-dsh-skills@0.2.3
```

请与且仅与一个 XuanLing 工具 bundle 组合使用。`xuanling-file-workflow` 在 Harness 原生文件
工具和 XuanLing 文件工具之间路由；`xuanling-memory-workflow` 将 proposal 创建和经用户授权的
review 分隔到不同轮次。Policy 会在 MCP dispatch 前拒绝缺少 `expected_sha256` 的既有文件覆盖。

要求 Node.js 22.14 或更高版本。使用 MIT License。
