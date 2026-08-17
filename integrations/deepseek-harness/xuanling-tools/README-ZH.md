# xuanling-dsh-tools

[English](README.md) | 简体中文

这是完整 XuanLing MCP catalog 的增量式 DeepSeek Harness bundle。它保留全部 Harness
原生工具，并以 `mcp__xuanling__` 前缀增加 XuanLing 工具。

```sh
dsh plugin --profile full add @xuanling-rs/xuanling-dsh-tools@0.2.3
```

精确版本的 `@xuanling-rs/xuanling-mcp@0.2.3` runtime 会安装在 profile 内，并通过带校验的 JS launcher
启动；不需要也不会使用全局 npm package。只有文件系统 capability root 与 DSH 工作目录不同时，
才需要设置 `XUANLING_WORKSPACE_ROOT`。

该包会与 DSH 原生文件、进程和项目工具产生能力重叠。日常配置建议使用目录更小的
`@xuanling-rs/xuanling-dsh-memory`。不要在同一 profile 内安装多个 XuanLing 工具 bundle。

要求 Node.js 22.14 或更高版本。使用 MIT License。
