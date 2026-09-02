# 面向 ZCode 的 XuanLing MCP 替换插件

这是 XuanLing ZCode 插件的显式启用替换版本。它启动与 `xuanling-mcp` 相同的跨平台 MCP v3
服务，并通过 `PreToolUse` 策略阻止 ZCode 原生 `Read`、`Write`、`Edit`、`ApplyPatch` 和
`MultiEdit` 路径。XuanLing 的覆盖、替换、编辑、批量和 patch 调用必须携带 64 位小写
SHA-256 前置条件。

ZCode 3.10.2 使用 `mcp__plugin_xuanling-mcp-replace_xuanling__` 前缀暴露本插件的 MCP
工具；下文的 `fs_hash` 等名称表示该宿主限定工具名的后缀。

同一时间只安装并启用一个 XuanLing 变体。启用 `xuanling-mcp-replace` 前先禁用或卸载
`xuanling-mcp`；禁用本插件会移除 hook，并恢复 ZCode 原生文件工具。additive
`xuanling-mcp` 仍是默认选择。

## 运行时

从 [`umbrella22/xuanling-zcode-marketplace`](https://github.com/umbrella22/xuanling-zcode-marketplace)
安装 `xuanling-mcp-replace`。发行包自带匹配的原生运行时，不依赖全局 npm；ZCode 需要提供
Node.js 18.17 或更新版本。

## 强制工作流

1. 用 `fs_read_text` 读取现有 UTF-8 文本；不需要理解正文时可用 `fs_hash` 取得指纹。
2. 覆盖、替换和编辑时把当前哈希传入 `expected_sha256`，批量请求中的每个文件都必须传；
   patch 使用 `expected_preimage_sha256`。
3. 编辑调用保持 `include_diff=true`。格式化器或其他 writer 改写文件后，先重新读取或取哈希，
   再构造下一次 mutation。

只有 `mode=create` 的 `fs_write_text` 可以不传哈希。hook 只验证 CAS 参数存在且格式正确；
路径、UTF-8、匹配和当前内容检查仍由 XuanLing 权威执行。

## 宿主能力边界

hook 会拒绝执行原生工具，但不能从 ZCode 工具列表隐藏其名称。`include_diff=true` 会保留 MCP
diff 数据，但不保证显示 ZCode 原生 diff card。replacement 模式会阻止原生 `Read`，因此也不提供
宿主原生图片渲染。这些是宿主能力限制，不属于插件已经解决的能力。
