# xuanling-dsh-tools

[English](README.md) | 简体中文

这是完整 XuanLing MCP catalog 的增量式 DeepSeek Harness bundle。它保留全部 Harness
原生工具，并以 `mcp__xuanling__` 前缀增加 XuanLing 工具。

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-tools@0.2.10
```

该命令会扩展 DSH 内置的 Web profile。内置 Headless profile 应使用 `--profile headless`。
未知 profile 名称只包含 base bundle，本身不会提供可运行的 Web 或 Headless 应用。

精确版本的 `@xuanling-rs/xuanling-mcp@0.2.10` runtime 会安装在 profile 内，并通过带校验的 JS launcher
启动；不需要也不会使用全局 npm package。只有文件系统 capability root 与 DSH 工作目录不同时，
才需要设置 `XUANLING_WORKSPACE_ROOT`。

Bridge 会缓存 MCP 分页中的全部定义，但起初只暴露 `mcp_catalog__xuanling`。应按名称或描述检索并
激活精确 raw name；选中的定义会在下一次模型请求中作为 `mcp__xuanling__*` 工具出现。不要预先
激活完整目录。

该 bundle 的 result adapter 会保留完整 Native 文本投影，只删除与 `structuredContent` 完全重复的
意外文本块。

Adapter 只接受子进程 JSON object frame。输出 malformed 或子进程正常退出时仍有未结算 request 会以非零状态
结束；Host 终止信号会被转发，子进程未在 500 ms grace 内退出时会被强制终止。

该包会与 DSH 原生文件、进程和项目工具产生能力重叠。日常配置建议使用目录更小的
`@xuanling-rs/xuanling-dsh-memory`。不要在同一 profile 内安装多个 XuanLing 工具 bundle。

要求 Node.js 22.14 或更高版本。使用 MIT License。
