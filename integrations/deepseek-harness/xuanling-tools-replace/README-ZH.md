# xuanling-dsh-tools-replace

[English](README.md) | 简体中文

这是显式启用的 DeepSeek Harness 文件系统 replacement bundle。它会禁用原生 `tool-fs` 行，并注册
`read`、`write`、`edit`、`read_image`、`file_hash` 与 `edit_batch`。文本操作由 XuanLing 提供跨平台
路径、UTF-8、精确匹配、SHA-256 CAS、原子替换、批量预检和恢复合同；`read_image` 仍使用 Harness
原生实现。

Facade 不替换 `ctx.fs`。它通过该服务解析目标，把成功的 XuanLing 读取与写入绑定到当前 Harness
`FsVersion`，发送 `fs/observed`，并保留原生 read/diff card。Mutation 在 `tools/pre-execute` 返回
`ask`；ToolRuntime 将请求交给已挂载的 ApprovalService，审批通道不可用时会关闭执行。

`read` 会保存完整正文与 SHA-256，供同一 session 的精确编辑使用。`file_hash` 只保存字节指纹：它可以
支持带保护的整文件 `write`，但不能授权 `edit` 或 `edit_batch`。Formatter 或其他外部 writer 会让下一次
CAS 冲突；继续前必须重新读取或取 hash。Facade 不暴露任何可绕过这些宿主策略的原始 XuanLing
mutation 名称。

Profile 内的 `@xuanling-rs/xuanling-mcp@0.4.0` launcher 由 bundle 自带 result adapter 包装。启动 DSH
前必须把 `XUANLING_WORKSPACE_ROOT` 设为已确认的绝对 workspace。缺少 root、官方 MCP bridge、原生
图片工具或必需的 XuanLing definition 时，facade 会拒绝启动。

不要与 `@xuanling-rs/xuanling-dsh-tools` 同时启用；需要 Harness 原生文本工具的 profile 仍默认使用
additive bundle。移除或禁用本包并重新组合 profile patch 后，原生 `tool-fs` 行恢复。

要求 Node.js 22.14 或更高版本。使用 MIT License。
