# xuanling-dsh-tools-replace

[English](README.md) | 简体中文

这是为历史 filesystem-replacement preset 保留的 DeepSeek Harness 兼容 bundle。它现在会保留
全部 Harness 原生工具，包括 `read_image`、文件 observation guard 和 editor card，同时把完整
XuanLing catalog 以 `mcp__xuanling__*` 名称按需增加。

新安装应使用 `@xuanling-rs/xuanling-dsh-tools`。现有 profile 可以原地更新本包以恢复原生工具面，
再通过问答式安装器迁移到 additive package。一个 profile 内不得组合两个 XuanLing runtime bundle。

精确版本的 `@xuanling-rs/xuanling-mcp@0.3.1` runtime 会安装在 profile 内，并通过带校验的 JS
launcher 启动；不会使用全局 npm package。启动 DSH 前必须把 `XUANLING_WORKSPACE_ROOT` 设置为
已确认的绝对 workspace，缺失时启动失败。

Bundle 自带的 lazy wrapper 会让官方 bridge 缓存完整分页 MCP 目录，但起初只暴露
`mcp_catalog__xuanling`。按能力搜索，并在每次调用中只激活一个下一步所需的精确 raw name。
普通读取、小编辑、图片读取和 editor UX 继续使用 Harness 原生工具面。

Result adapter 保留一个完整 Native 文本投影，只删除与 `structuredContent` 完全重复的意外文本块；
structured value 仍供 Code Mode 与校验使用。子进程输出 malformed 或正常退出时仍有未结算 request
会返回非零状态。

要求 Node.js 22.14 或更高版本。使用 MIT License。
