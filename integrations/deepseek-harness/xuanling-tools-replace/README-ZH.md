# xuanling-dsh-tools-replace

[English](README.md) | 简体中文

**显式启用的 DeepSeek Harness 文件系统 replacement：用 XuanLing 的 SHA-256 守卫
文件操作支撑 DSH 原生 `read`/`write`/`edit` 接口，同时保留宿主审批、
observation、图片与 diff 行为。** Package：
`@xuanling-rs/xuanling-dsh-tools-replace@0.9.0`。

## 这是什么

禁用 DSH 原生 `tool-fs` 插件，改为注册六个同名工具：

- `read`：通过 XuanLing 读取 UTF-8 文本，并为同一 session 的编辑保存完整正文与
  SHA-256 preimage。
- `write`：创建或替换文件；替换既有文件需要同一 session 内的 `read` 或
  `file_hash`。
- `edit` 与 `edit_batch`：使用同一 session 的读取 preimage 做精确替换（单文件或
  有序多文件）；batch 支持整请求预检与 `dry_run`。
- `file_hash`：只记录字节指纹，允许带保护的整文件 write，但不能授权 `edit` 或
  `edit_batch`。
- `read_image`：仍使用 Harness 原生实现。

读取与写入绑定到宿主文件系统版本，因此 read/diff card 和 observation 规则
继续工作。

## 为什么用它

- **适合**：沿用 DSH 现有提示词与 card，同时获得 XuanLing 的精确编辑、SHA-256
  CAS、原子替换、批量预检和恢复合同。
- **适合**：迁移已经选过历史 replacement package 的 profile。
- **新安装不要从这里开始。** 优先使用推荐的 Memory preset 或完整增量式 tools
  bundle；详见 [bundle 指南](../README-ZH.md)。
- 不要与 `xuanling-dsh-tools` 或 `xuanling-dsh-memory` 组合；该 preset 不提供
  任何 XuanLing Memory 工具。

## 环境要求

- 已安装 DSH，并使用内置的 `web` 或 `headless` profile。
- Node.js 22.14 或更高版本。
- DSH 在 `0.2.1-rc.2` 能力频道上提供 `@deepseek-ai/dsh-mcp-client` 与
  `@deepseek-ai/dsh-tool-fs`。
- 把 `XUANLING_WORKSPACE_ROOT` 设为已确认的绝对 workspace；缺少 root、官方 MCP
  bridge、原生图片工具或必需 XuanLing definition 时，facade 拒绝启动。
- macOS ARM64、glibc 2.35+ 的 Linux x64，或带 MSVC runtime 的 Windows x64。

## 安装

```sh
export XUANLING_WORKSPACE_ROOT=/absolute/path/to/project
dsh plugin --profile web remove @xuanling-rs/xuanling-dsh-memory @xuanling-rs/xuanling-dsh-tools
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-tools-replace@0.9.0
dsh --profile web --dump-config
```

dump 中应看到原生 `tool-fs` row 被禁用，以及一个 `xuanling-tools-replace` row；
如果没有那些 package，可省略 `remove` 参数。内置 headless profile 使用
`--profile headless`；自定义的新 profile 名称只会从 base bundle 起步。

## 快速开始

1. 重启该 profile，然后刷新 DSH。
2. 对 `XUANLING_WORKSPACE_ROOT` 内的一个文本文件调用 `read`，应出现原生 read
   card。
3. 对同一文件调用 `edit`；mutation 需要审批，并应出现原生 diff card。
4. 可选：先以 `dry_run: true` 调用 `edit_batch`；整个请求会在任何文件改动前
   完成预检。

## 配置

- `XUANLING_WORKSPACE_ROOT` 必填且必须是绝对路径，是目标 root；DSH 进程工作
  目录不是授权来源。
- observation 按 session 隔离。对既有文件执行 `write` 需要同一 session 内的
  `read` 或 `file_hash`；`edit` 与 `edit_batch` 需要 `read`，只有指纹不够。
- `read` 用 `offset` 与 `limit` 分页（每次默认 2000 行）；完整正文仍会保留供
  编辑使用。
- Mutation 需要宿主审批；审批被拒绝、取消或不可用时会 fail closed。
- formatter 或其他外部 writer 会让下一次 CAS 失效；继续前重新读取或重新取 hash。
- 单次工具调用预算 120 秒。server name 固定为 `xuanling`，原始 XuanLing
  mutation 名称不会暴露。

## 限制与安全边界

- **只有六个工具。** 这是文件系统 facade，不是完整 catalog：没有 `fs_search`、
  `fs_glob`、`fs_copy`、`fs_move`、`fs_remove`，也没有进程、项目、artifact、
  session 或 Memory 工具。
- **必须审批。** 非交互 profile 或缺少审批通道时会按设计 fail closed。
- **hash 不是读取。** `file_hash` 允许带保护的整文件 `write`，但不能授权
  `edit` 或 `edit_batch`。
- **外部 writer 赢得竞态。** XuanLing CAS 与宿主版本绑定会拒绝过期编辑；重新
  读取或取 hash 后重建改动。
- **不改变沙箱边界。** pathname capability 在 workspace root 下生效，但其他
  工具与进程不受影响；不可信代码仍需宿主审批和 OS sandbox。

## 排错

- **启动因 workspace root 失败。** 在 DSH 进程的环境中 export 已确认的绝对
  路径；非绝对路径会报 `[XUANLING_FACADE_INVALID_ROOT]`。
- **启动提示缺少 XuanLing definition。** runtime 不完整或版本不匹配；重装精确的
  `0.9.0` 版本后重启。
- **`[XUANLING_FACADE_NOT_OBSERVED]`。** 在同一 session 内先读取文件；整文件
  write 也可以先取 `file_hash`。
- **`file_hash` 成功但 `edit` 被拒绝。** 正常，先读取文件；编辑有歧义时让
  `old_string` 唯一，或在外部改动后重新读取。
- **Mutation 被拒绝或卡在审批。** 审批被拒绝、取消或不可用；请在交互式 profile
  中重试。
- **报告多个 runtime bundle 冲突。** 移除其他 XuanLing runtime package 后重启。

## 链接

- [XuanLing for DeepSeek Harness：bundle 指南与运行配置](../README-ZH.md)
- [XuanLing Blueprint：可视化工作流编辑器与可持久运行](../xuanling-blueprint/README-ZH.md)
- [XuanLing MCP server 项目](../../../README-ZH.md)
- [npm package](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-tools-replace)
- [Issues](https://github.com/umbrella22/xuanling/issues)
