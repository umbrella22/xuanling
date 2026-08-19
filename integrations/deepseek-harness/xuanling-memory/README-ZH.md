# xuanling-dsh-memory

[English](README.md) | 简体中文

这是推荐使用的 XuanLing Memory v2 DeepSeek Harness bundle。它会增加完整的九工具提案、
评审、召回、归档和反馈 profile，同时保留全部 Harness 原生工具。

```sh
dsh plugin --profile demo add @xuanling-rs/xuanling-dsh-memory@0.2.4
```

Bundle 会在所选 profile 内安装 `@xuanling-rs/xuanling-mcp@0.2.4`，并从该 profile 解析 schema adapter
和 JS launcher。Launcher 会在启动前校验当前平台的原生 package；不需要全局 package，也
不会在安装时下载 binary。

Result adapter 还会执行 DSH projection 合同：只将与 `structuredContent` 完全重复的文本块收敛为
一个完整文本块，同时保留 structured value 供 Code Mode 与输出校验使用。

Schema adapter 会校验子进程 JSONL frame 与 request 结算。malformed frame 或子进程正常退出时仍有未结算的
`tools/list`/`tools/call` 会以非零状态结束；子进程忽略 Host 终止信号时，500 ms grace 后会被强制终止。

可以同时安装 `@xuanling-rs/xuanling-dsh-skills@0.2.4`，获得 proposal-first Memory 工作流和严格整文件
覆盖 policy。不要在同一 profile 中组合多个 XuanLing 工具 bundle，因为它们都会注册
`xuanling-tools` 行。

要求 Node.js 22.14 或更高版本。支持 macOS ARM64、Linux x64 glibc 2.35+ 与 Windows x64
MSVC。使用 MIT License。
