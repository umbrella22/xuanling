# xuanling-dsh-memory

[English](README.md) | 简体中文

**XuanLing Memory v2 在 DeepSeek Harness 上的推荐 bundle：在 DSH 原生工具之外
增加九个 proposal-first 记忆工具。** Package：`@xuanling-rs/xuanling-dsh-memory@0.9.0`。

## 这是什么

为 DeepSeek Harness（DSH）profile 增加 XuanLing 完整的 Memory v2 生命周期：
`memory_search` 与 `memory_get` 用于召回，五个 `memory_candidate_*` 工具用于待审
提案，`memory_review` 用于显式批准或拒绝，以及 `memory_feedback`。写入会一直处于
pending，直到 review 激活或拒绝；server 不会声称这次评审由真人完成。Harness 原生
工具保持启用，不增加文件系统、进程、artifact 或 session 工具。

## 为什么用它

- **适合**：需要跨项目、可持久召回、又不会悄悄改写 canonical memory 的能力，同时
  希望日常工具面尽量精简。
- **需要 XuanLing 文件系统、进程、项目、artifact 或 session 工具**：改用
  `xuanling-dsh-tools`。
- **只想要 DSH 原生文本文件工具跑在 XuanLing 语义上**：改用
  `xuanling-dsh-tools-replace`。
- 搭配 `xuanling-dsh-skills` 可获得 proposal-first 工作流和宿主用户审批。每个
  profile 只能装一个 XuanLing runtime bundle，详见
  [bundle 指南](../README-ZH.md)。

## 环境要求

- 已安装 DSH，并使用内置的 `web` 或 `headless` profile。
- Node.js 22.14 或更高版本。
- DSH 在 `0.2.1-rc.2` 能力频道上提供 `@deepseek-ai/dsh-mcp-client`。
- macOS ARM64、glibc 2.35+ 的 Linux x64，或带 MSVC runtime 的 Windows x64。

## 安装

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-memory@0.9.0
```

内置 headless profile 使用 `--profile headless`。自定义的新 profile 名称只会从
base bundle 起步，本身不是可运行的 Web 或 Headless 应用。该命令会把
`@xuanling-rs/xuanling-mcp@0.9.0` 装进该 profile；不需要全局 npm package 或
`npx`。

## 快速开始

1. 确认 package，然后重启该 profile 并刷新 DSH：

   ```sh
   dsh plugin --profile web list
   dsh --profile web --dump-config
   ```

2. 让模型检索 `mcp_catalog__xuanling` 中的 `memory_search`，并只激活这个精确
   raw name。下一次请求时它会以 `mcp__xuanling__memory_search` 出现。

3. 用一条范围很窄的只读查询调用它。不要为了验证安装去创建或评审候选提案。

## 配置

- 不需要环境变量；该 bundle 不增加文件系统工具，也不使用
  `XUANLING_WORKSPACE_ROOT`。
- 存储：共享默认库 `~/.xuanling/memory.db`，在第一次有效 Memory 调用时才延迟
  打开；启动和 catalog 发现都不会创建它。
- scope 分为 global、project（`project_id`）或 workspace（`project_id` +
  `workspace_id`）；只有明确要求时才沿祖先 scope 检索。
- `memory_review` 需要用户指名提案的显式决定；未评审的候选提案是合法终态。
- 模型可见面：起初只有 `mcp_catalog__xuanling`；检索它，每次调用只激活一个精确
  raw name。
- 单次工具调用预算 120 秒。模型可见工具名是 `mcp__xuanling__*`。

## 限制与安全边界

- **只有 Memory。** 没有文件或进程工具，也没有文件系统 capability。
- **共享存储。** `~/.xuanling/memory.db` 也被其他 XuanLing 部署使用；不要把
  secret 或用户私密内容写进去。
- **Proposal-first 是状态机，不是真人证明。** `reviewer_id` 由调用方自报；DSH
  审批门由 Skills bundle 提供。
- **启动无副作用。** 数据库在第一次有效 Memory 调用前既不会创建也不会迁移。

## 排错

- **只看到 `mcp_catalog__xuanling`。** 正常。检索它并激活精确 raw name，每次
  一个。
- **激活后工具没出现。** 使用不带 `mcp__xuanling__` 前缀的精确 raw name；激活
  不会跨重启保留。
- **候选提案一直未生效。** 它在等待评审；只有用户显式决定后才调用
  `memory_review`。
- **启动失败。** 检查 Node.js 22.14+、平台支持，并重装精确的 `0.9.0` 版本；
  移除其他 XuanLing runtime bundle。

## 链接

- [XuanLing for DeepSeek Harness：bundle 指南与运行配置](../README-ZH.md)
- [XuanLing Blueprint：可视化工作流编辑器与可持久运行](../xuanling-blueprint/README-ZH.md)
- [XuanLing MCP server 项目](../../../README-ZH.md)
- [npm package](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-memory)
- [Issues](https://github.com/umbrella22/xuanling/issues)
