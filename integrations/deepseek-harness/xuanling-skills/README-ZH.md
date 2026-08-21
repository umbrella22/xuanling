# xuanling-dsh-skills

[English](README.md) | 简体中文

该 DeepSeek Harness bundle 包含两个按需 XuanLing 工作流 Skill 和严格整文件覆盖 policy。
它不注册 MCP server，也不依赖 `@xuanling-rs/xuanling-mcp`。

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-skills@0.2.6
```

该命令会扩展 DSH 内置的 Web profile。内置 Headless profile 应使用 `--profile headless`。
未知 profile 名称只包含 base bundle，本身不会提供可运行的 Web 或 Headless 应用。

请与且仅与一个 XuanLing 工具 bundle 组合使用。只有 fs 工具族可见时，
`xuanling-file-workflow` 才在 Harness 原生与 XuanLing 文件工具之间路由，并覆盖 CAS overwrite、
复合后缀、原子多 hunk patch、确定性重复验证和 Host 后台任务。`xuanling-memory-workflow` 将项目
局部 L1 事实与共享 XuanLing L2 事实分开，按显式指针 pull recall，并保持 proposal/review 边界。
Policy 会在 MCP dispatch 前拒绝缺少 `expected_sha256` 的既有文件覆盖。

要求 Node.js 22.14 或更高版本。使用 MIT License。
