# 仓库边界与出处

> 状态:当前事实文档。描述本仓库是什么、不是什么;上游历史只作为出处记录。

## 本仓库是什么

XuanLing 是一个跨平台(macOS/Linux/Windows)的本地 stdio MCP server 及其 npm 发行层:

| 组件 | 职责 |
| --- | --- |
| `crates/xuanling-toolkit` | 文件系统、进程(direct argv,无 shell)、项目生态检测、会话、artifact 与共享词法记忆的库实现。 |
| `crates/xuanling-mcp` | MCP server 二进制与库,基于 rmcp SDK 暴露类型化工具目录。 |
| `npm/` | Node launcher(`xuanling-mcp`)与各平台原生包(darwin-arm64、linux-x64-gnu、win32-x64-msvc)。 |
| `.github/workflows` | CI:可移植性 gate、npm 合同/发行校验、npm publish。 |

设计要点:同一条 `tools/call` 在三个平台返回相同的结构化结果;窗口型工具省略 `output`
即返回完整结果,显式 `{"mode":"bounded","max_bytes":N}` 才按字节预算截断并携带类型化
cursor/resume token;进程执行使用显式 argv,不经过任何 shell 方言。

## 出处

本仓库从 `umbrella22/xuanling` monorepo 摘离(基线 revision
`b554bb7bad651c4d6f0c9e5a2c590f4f36d0ac9c`)。monorepo 不再维护,本仓库是以下内容的
canonical home:toolkit、MCP server、npm 发行层。摘离时的审计修复(deterministic 补全、
rustdoc 断链、schema 契约、上游 URL 断链)已包含在初始提交 `47f1cff` 中。

## 不是什么(边界外)

- 上游 monorepo 的产品面(gateway、coder runtime、团队/供应商架构等)不属于本仓库;
  其文档已随 2026-08-14 的 docs 重建移除(清单见
  [plans/memory-v2-extraction-w01-removal-manifest.txt](plans/memory-v2-extraction-w01-removal-manifest.txt))。
- 源码注释中出现的 `ADR 00xx` / `plan §x` 字样是上游实现时内联记录的行为合同出处
  (工具描述属于线协议可见文本,由 snapshot 测试固定);它们不是指向本仓库文档树的链接。
- CodeGraph、LSP、真实 embedding 模型与 npm 发布流程不在当前 Memory v2 计划范围内,
  见 [adr/0001-memory-v2-proposal-review.md](adr/0001-memory-v2-proposal-review.md)。
