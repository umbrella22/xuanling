# XuanLing for DeepSeek Harness

[English](README.md) | 简体中文

XuanLing for DeepSeek Harness 把 XuanLing 的提案优先 Memory 与类型化工具目录加入 DSH profile，
同时保留 DSH 的原生工具、审批流程和界面。

## 这是什么

XuanLing 是面向编码 Agent 的本地 MCP Server：通过 stdio 暴露 43 个类型化工具，包括 17 个带
SHA-256 前置条件的文件系统工具、一套九工具的提案优先 Memory v2 生命周期、进程与项目执行、
Artifact，以及长时间运行的 Session。

本仓库把它打包成四个 bundle 和一个可选 Blueprint 插件，供 DeepSeek Harness 使用。运行期
bundle 通过 DSH 官方 MCP bridge 把 XuanLing Server 挂进一个 DSH profile，并保留全部原生工具。
模型起初只看到 `mcp_catalog__xuanling`，任务需要时才激活精确的 XuanLing 工具，因此初始 schema
很小。package 从公开 npm registry 安装进 profile，不需要全局安装，也不会在安装时下载 binary。

它适合需要“审阅通过之前不会成为规范记录”的 Memory、受 SHA-256 保护的文件编辑，以及
XuanLing 的进程、项目、Artifact 与 Session 工具，同时不想放弃 DSH 原生工具的场景。

## 我该装哪个 bundle？

| Bundle | 增加的能力 | 适用场景 |
| --- | --- | --- |
| `@xuanling-rs/xuanling-dsh-memory` | 完整九工具 Memory v2 profile；保留全部 DSH 原生工具 | 需要日常可用的持久 Memory。**推荐默认**，搭配 Skills bundle |
| `@xuanling-rs/xuanling-dsh-skills` | 两个工作流 Skill 与严格覆盖策略；不挂载 MCP Server | 需要工作流 Skill 与严格覆盖策略；搭配一个运行期 bundle |
| `@xuanling-rs/xuanling-dsh-tools` | 完整 43 工具目录，含全部 17 个文件系统工具；保留原生工具 | 需要 XuanLing 的文件系统、进程、项目、Artifact 或 Session 工具 |
| `@xuanling-rs/xuanling-dsh-tools-replace` | 用 `read`、`write`、`edit`、`file_hash`、`edit_batch` 和原生 `read_image` 替换 DSH 文本文件工具 | 希望由 XuanLing 接管 DSH 自带的文件系统工具 |
| `@xuanling-rs/xuanling-dsh-blueprint` | 独立插件：可视化图编辑器、持久 Run、可选 TeamStage | 需要可视化、可复用的 Agent 工作流 |

每个 profile 只能安装 `memory`、`tools`、`tools-replace` 之一：三者都会挂载名为 `xuanling`
的 Server，互斥。`skills` 搭配其中任意一个运行期 bundle 安装；`blueprint` 独立。

### 可选：Blueprint

[Blueprint](xuanling-blueprint/README-ZH.md) 给 DSH 增加可视化图编辑器和持久 Run：连接 Input、
Agent task、Approval、Condition、Join 与 Output 节点，绑定 DSH 现有 Agent、Skill 与 MCP 工具，
并查看 DSH 记录的 Attempt。Run 会冻结定义与资源，不会重放无法确认的结果；可选的 TeamStage
把一个 Agent task 作为原生 DSH Agent Teams 阶段执行。

![蓝图画布上的 Rust 多 Agent 代码审查工作流](xuanling-blueprint/assets/readme/rust-review-blueprint.png)

*DSH Web profile 中已保存的 Rust 审查工作流。截图使用中文界面。*

## 环境要求

- DeepSeek Harness，使用内置的 `web` 或 `headless` profile。自定义 profile 名称只从基础
  bundle 初始化，不包含 Web 或 Headless 应用。
- `dsh` 与 `pnpm` 在 PATH 中；`dsh plugin` 会调用 pnpm。所有 bundle 均声明 Node.js 22.14+。
- 能访问公开 npm registry。package 安装进 profile，不做全局安装。
- 支持的原生平台：macOS Apple Silicon（`arm64`）、glibc 2.35+ 的 Linux `x64`、
  Windows `x64` MSVC。其他组合会以明确的 launcher 错误失败。
- Blueprint 的 Agent task 工作流需要 DSH 中已配置模型 provider；Input → Output 图不需要模型。

## 安装

`dsh plugin` 会把参数转发给所选 profile 中的 pnpm，并从公开 npm registry 安装。请把 `web`
换成你使用的 profile。

### Memory + Skills（推荐）

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-memory@0.8.1 \
  @xuanling-rs/xuanling-dsh-skills@0.8.1
dsh --profile web --dump-config
dsh web
```

`--dump-config` 会打印组合后的 profile，可确认两个 package 都已存在。使用
`--profile headless` 安装进内置 headless profile。

### 完整工具目录

`XUANLING_WORKSPACE_ROOT` 必须是启动 DSH 环境中的绝对路径。缺失时 bundle 启动失败，绝不会
回退到 DSH 的工作目录。

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-tools@0.8.1 \
  @xuanling-rs/xuanling-dsh-skills@0.8.1
export XUANLING_WORKSPACE_ROOT=/absolute/path/to/project
dsh web
```

### 文件系统替换

同样需要工作区根目录。该 bundle 会禁用原生 `tool-fs` 行；不要在同一 profile 中再加入
`xuanling-dsh-tools`。

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-tools-replace@0.8.1 \
  @xuanling-rs/xuanling-dsh-skills@0.8.1
export XUANLING_WORKSPACE_ROOT=/absolute/path/to/project
dsh web
```

### Blueprint（可选）

```sh
pnpm add --save-exact @xuanling-rs/xuanling-dsh-blueprint@0.8.1
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-blueprint@0.8.1
```

TeamStage 还需要单独启用原生 Agent Teams profile。

## 快速开始

1. **重启 profile 并刷新 DSH 页面。** 正在运行的进程会保留启动时加载的插件图；若所选 bundle
   需要，先设置 `XUANLING_WORKSPACE_ROOT`。
2. **试用 Memory。** 让模型用 XuanLing Memory 搜索一个主题：模型会通过
   `mcp_catalog__xuanling` 激活 `memory_search`，再调用 `mcp__xuanling__memory_search`。
   Memory 写入都是提案，只有 `memory_review` 接受后才会成为规范记录，审阅还需经过 DSH 审批。
   使用完整目录 bundle 时可激活 `system_info` 做快速验证；替换式 bundle 会直接暴露六个文件
   工具。
3. **打开 Blueprint**（若已安装）：在 DSH 侧栏打开 **玄灵蓝图**，按
   [第一个工作流](xuanling-blueprint/README-ZH.md)操作。

## 使用与配置

### 设置

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `XUANLING_WORKSPACE_ROOT` | `tools` 与 `tools-replace` 必填 | 绝对文件系统能力根目录；缺失时启动失败 |
| Memory 数据库 | `~/.xuanling/memory.db` | XuanLing 共享默认值，在第一次有效 Memory 调用时打开。传入 `--memory-db <PATH>` 可隔离 |
| MCP Server 名称 | `xuanling` | 固定值；会重命名 `mcp_catalog__xuanling` 与所有 `mcp__xuanling__*` 工具 |
| 工具调用超时 | 120 秒 | 由 DSH MCP bridge 施加的预算 |

### Profile

安装到承载当前 DSH 界面的 profile。`web` 与 `headless` 是内置 profile，各自维护独立的
package 集合。用 `dsh plugin --profile <profile> list` 查看已安装插件，用
`dsh plugin --profile <profile> remove <package>` 移除；变更后重启。

所选 runtime bundle 会把 `@xuanling-rs/xuanling-mcp@0.8.1` 安装到 profile 内，
并从该 profile 的依赖中解析运行时。

### Memory、文件与 Skill

Memory v2 是提案优先的：`memory_search` 与 `memory_get` 读取 active 记录，
`memory_candidate_*` 工具提出变更，`memory_review` 接受或拒绝提案。只有审阅被接受后才会写入
规范记录，审阅需经过 DSH 审批。数据库在第一次有效 Memory 调用时才打开；详见
[memory bundle](xuanling-memory/README-ZH.md)。

`tools` bundle 增加全部 17 个 `fs_*` 工具，支持 SHA-256 前置条件、分页读取与搜索、有界输出。
替换式 bundle 以 `read`、`write`、`edit`、`read_image`、`file_hash`、`edit_batch` 暴露文件
工具，带同 Session observation 与 DSH 审批。详见 [tools](xuanling-tools/README-ZH.md) 与
[tools-replace](xuanling-tools-replace/README-ZH.md)。

`xuanling-skills` 增加 `xuanling-memory-workflow`（项目局部事实写入 DSH 文件 Memory，跨项目
事实写入 XuanLing）、`xuanling-file-workflow`（在原生与 XuanLing 文件工具之间路由）、
`xuanling-blueprint-migrate`（辅助升级蓝图，自 `0.7.0` 起提供），以及
严格覆盖策略：缺少 `expected_sha256` 的 `fs_write_text` 覆盖会被拒绝。详见
[skills bundle](xuanling-skills/README-ZH.md)。

## 工作方式

官方 `@deepseek-ai/dsh-mcp-client` bridge 会缓存完整 XuanLing 目录，而 bundle 自带的 wrapper
起初只注册 `mcp_catalog__xuanling`；激活精确 raw name 后，后续模型请求会看到
`mcp__xuanling__<name>`。这样初始 schema 很小，同时不改变 canonical MCP 合同。schema
projection、result projection、Skills 策略与替换 facade 的细节见[各 bundle README](#相关链接)。

## 兼容性与限制

### DSH 运行时频道

- 各 bundle 以 DSH `next` 频道的 `0.2.1-rc.2` 为开发和测试基线。
- 公开运行时 peer 下限是 `@deepseek-ai/dsh-* >=0.2.1-alpha.5`，预发布版本也参与范围比较。
- `0.8.1` 面向上述能力频道，旧版 `0.6.1` package 声明的是更早的 DSH 范围。请安装声明范围
  与自身 profile 匹配的版本，并让同一 profile 中所有 `@deepseek-ai/dsh-*` package 保持在同一
  频道。DSH 可能停用不兼容插件而不是启动它。

### 限制

- 每个 profile 只能安装 `memory`、`tools`、`tools-replace` 之一；`skills` 是它们共同的
  搭配项。
- 这些 bundle 不替换 DSH 的 shell、web、LSP、后台任务、PTY 或编排能力；`tools-replace`
  只禁用原生文本文件工具。
- Memory bundle 只暴露九个 Memory 工具；文件系统、进程、项目、Artifact 或 Session 工具请用
  `tools`。
- MCP bridge 的单次工具调用上限为 120 秒；更久的任务请使用 DSH 后台 job。

### 安全边界

- XuanLing 对文件系统工具实施 pathname capability。它启动的进程仍需要 DSH 审批；存在恶意
  执行风险时还需要 OS sandbox。
- 替换式修改与 Memory 审阅都经过 DSH 审批；审批不可用时 fail closed。
- schema projection 与策略不会削弱 canonical MCP 校验；`system_info` 不暴露环境变量或
  secret。

## 排错

| 现象 | 处理方式 |
| --- | --- |
| 新工具或 Blueprint 面板不出现 | 重启 profile 并刷新 DSH 页面；正在运行的进程会保留旧的插件图 |
| 启动失败并提示 `XUANLING_WORKSPACE_ROOT is required ...` | 在启动 DSH 的环境中设置绝对路径后重启 |
| profile 报告 XuanLing runtime 冲突 | 用 `dsh plugin --profile web remove <package>` 移除多余 package，只保留一个运行期 bundle 后重启 |
| 找不到 `mcp_catalog__xuanling` | 没有安装运行期 bundle；单独的 `skills` 不挂载 MCP Server |
| `mcp__xuanling__fs_write_text` 被拒绝 | 严格覆盖策略要求覆盖已存在文件时提供 `expected_sha256`；先读取 hash 或改用 create mode |
| 替换式 `edit` 报 observation 错误 | 同一 Session 内先读取该文件，再重试 |
| 不存在 `~/.xuanling/memory.db` | 正常现象；数据库在第一次有效 Memory 调用时创建 |
| DSH 升级后插件被停用 | DSH 频道不匹配；请安装面向该 profile 频道的版本 |
| 工具调用超时 | bridge 预算为 120 秒；拆分任务或改用 DSH 后台 job |

## 相关链接

- 仓库：[umbrella22/xuanling](https://github.com/umbrella22/xuanling) ·
  [Issues](https://github.com/umbrella22/xuanling/issues) ·
  [Releases](https://github.com/umbrella22/xuanling/releases)
- XuanLing MCP Server：[仓库 README](../../README-ZH.md) ·
  [npm package README](../../npm/packages/xuanling-mcp/README-ZH.md)
- Bundle README：[memory](xuanling-memory/README-ZH.md) ·
  [skills](xuanling-skills/README-ZH.md) · [tools](xuanling-tools/README-ZH.md) ·
  [tools-replace](xuanling-tools-replace/README-ZH.md)
- [Blueprint 指南](xuanling-blueprint/README-ZH.md) ·
  [示例工作流](xuanling-blueprint/examples/code-review/blueprint.json)
- npm：[memory](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-memory) ·
  [skills](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-skills) ·
  [tools](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-tools) ·
  [tools-replace](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-tools-replace) ·
  [blueprint](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-blueprint)
- [Changelog](../../CHANGELOG.md) · [License](../../LICENSE)（MIT）·
  [安装 Skill](../../.agents/skills/xuanling-dsh-install/SKILL.md)
- 从 DSH 对话安装：把仓库 URL 粘进对话，按[安装 Skill](../../.agents/skills/xuanling-dsh-install/SKILL.md)
  的提示选择 profile、preset 并确认；流程见[仓库 README](../../README-ZH.md)。
