# xuanling-dsh-memory

[English](README.md) | 简体中文

这是推荐使用的 XuanLing Memory v2 DeepSeek Harness bundle。它会增加完整的九工具提案、
评审、召回、归档和反馈 profile，同时保留全部 Harness 原生工具。

```sh
dsh plugin --profile demo add xuanling-dsh-memory@0.2.2
```

Bundle 会在所选 profile 内安装 `xuanling-mcp@0.2.2`，并从该 profile 解析 schema adapter
和 JS launcher。Launcher 会在启动前校验当前平台的原生 package；不需要全局 package，也
不会在安装时下载 binary。

可以同时安装 `xuanling-dsh-skills@0.2.2`，获得 proposal-first Memory 工作流和严格整文件
覆盖 policy。不要在同一 profile 中组合多个 XuanLing 工具 bundle，因为它们都会注册
`xuanling-tools` 行。

要求 Node.js 22.14 或更高版本。支持 macOS ARM64、Linux x64 glibc 2.35+ 与 Windows x64
MSVC。使用 MIT License。
