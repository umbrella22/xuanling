# XuanLing

[English](README.md) · [CHANGELOG](CHANGELOG.md) · MIT

面向编码 Agent 的本地执行与记忆层。

XuanLing 是一个运行在编码 Agent 旁边的 Rust 工具运行时：提供类型化 MCP Server、
DeepSeek Harness bundles，以及可选的图形化工作流编辑器。所有内容都在本机运行：MCP Server 使用
stdio，原生二进制通过 npm 安装且安装时不编译、不远程下载，Memory 数据保存在本地 SQLite
数据库中。

仓库围绕同一套内核提供四个使用面：

| 你想做什么 | 使用 | 从这里开始 |
| --- | --- | --- |
| 给任意 MCP Host 提供文件系统、进程、Artifact 与记忆工具 | XuanLing MCP Server（43 个类型化工具） | [安装](#xuanling-mcp-server) · [包说明](npm/packages/xuanling-mcp/README-ZH.md) |
| 在 DeepSeek Harness（DSH）中使用 XuanLing | 四个带 lazy 工具投影的 DSH bundle | [DSH 集成](integrations/deepseek-harness/README-ZH.md) |
| 在 DSH 中构建并运行可视化智能体工作流 | Blueprint：持久 Run 与可选 TeamStage | [Blueprint 说明](integrations/deepseek-harness/xuanling-blueprint/README-ZH.md) |
| 在 ZCode 中使用 XuanLing | 增量式或文件系统替换式 marketplace 插件 | [ZCode 插件](integrations/zcode-plugin/plugins/xuanling-mcp/README-ZH.md) |

![蓝图画布上的 Rust 多 Agent 代码审查工作流](integrations/deepseek-harness/xuanling-blueprint/assets/readme/rust-review-blueprint.png)

*DeepSeek Harness 中的可选 Blueprint 编辑器。图中的工作流并行运行四个专门审查 Agent，汇合结果
后再写出综合报告。该流程是已保存的示例，不是内置模板。*

## 核心能力

- **43 个类型化工具**，覆盖文件系统、进程执行、项目探测、Artifact、长生命周期 Session 和
  proposal-first 的 Memory v2。
- **显式能力边界下的文件系统安全。** 可重复的 `--workspace-root` 与 `--read-root`、
  SHA-256 preimage 校验、类型化输出预算和可续读结果。
- **Proposal-first 记忆。** 候选写入保持 pending，只有显式审阅通过具体 revision 后才会推进
  规范记录；规范记录不可变，并按 global、project、workspace 隔离。
- **直接进程执行。** 使用 program + argv，不隐式启动 shell，取消操作作用于完整后代进程树。
- **可选工具 profile。** 每个 MCP Host 只暴露实际需要的能力族；未指定时默认 `all`。
- **可验证的原生分发。** npm 安装平台启动器和匹配的原生二进制，不执行 `postinstall`
  编译、不远程下载，并在启动前校验 SHA-256。

## XuanLing MCP Server

MCP Server 通过 stdio 暴露完整目录，可与任意 MCP Client 配合使用。

### 安装

启动器要求 Node.js 18.17 或更高版本，并会为当前平台安装匹配的原生包。

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.8.0
xuanling-mcp --version
```

MCP Client 也可以通过 `npx` 固定同一版本，无需全局安装：

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "@xuanling-rs/xuanling-mcp@0.8.0",
        "--workspace-root",
        "/absolute/path/to/project",
        "--tool-profile",
        "core",
        "--tool-profile",
        "fs",
        "--tool-profile",
        "memory"
      ]
    }
  }
}
```

固定 package 版本可保证活动项目发现的 MCP schema 保持稳定；全局或项目内安装也能省去每次启动
时的 package 解析过程。

### 支持平台

| 操作系统 | 架构 | 运行时要求 |
| --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | 原生二进制 |
| Linux | `x64` | glibc 2.35 或更高版本 |
| Windows | `x64` | MSVC runtime |

不支持的 OS、CPU 或 libc 组合会返回明确的启动器错误。启动器会在启动服务器前校验 package
metadata 与原生二进制的 SHA-256。

### 工具 Profile

默认 catalog 包含全部 43 个工具。重复使用 `--tool-profile` 可以组合多个更小的工具组：

| Profile | 工具数 | 能力族 |
| --- | ---: | --- |
| `core` | 3 | 系统信息与可移植路径检查 |
| `fs` | 17 | 文件读取、搜索、预览与修改 |
| `process` | 5 | 直接进程执行与项目探测/执行 |
| `memory` | 9 | Memory v2 提案、审阅、召回与反馈 |
| `advanced` | 9 | Artifact、ChangeSet、Pipeline 与 Session |
| `all` | 43 | 完整 catalog；未提供 profile 时的默认值 |

`all` 与其他 profile 同时出现时优先生效。工具发现与调用分发使用同一份选择，因此被隐藏的
工具无法通过名称绕过 profile 调用。

### 文件系统安全

未提供任何能力 flag 时，XuanLing 的文件系统访问不受限制。生产 Host 应至少声明一个 root：

- `--workspace-root <PATH>` 可重复，允许读取、写入、删除，并允许在该 root 内设置子进程
  工作目录。
- `--read-root <PATH>` 可重复，只允许读取、列出、搜索和计算 hash；拒绝写入、删除和设置
  子进程工作目录。
- 仅提供 `--read-root` 会形成只读部署。

修改类工具支持显式 preimage 校验：整文件覆盖和精确编辑使用 `expected_sha256`，
`fs_patch` 使用 `expected_preimage_sha256`。文件在读取后发生变化时，工具会在写入前返回
conflict。支持窗口输出的工具接受显式 selector（例如
`{"mode":"bounded","max_bytes":65536}`）；被截断的读取和搜索会返回类型化 cursor 或 resume
token，不会静默丢弃剩余结果。

文件系统能力只约束 XuanLing 自身打开的路径，不是任意子进程的 OS sandbox。工具审批和恶意
进程隔离仍由 MCP Host 及其执行环境负责。

### Memory v2

Memory 将提案与规范记录分离：

1. `memory_search` 和 `memory_get` 读取 active 记录。
2. `memory_candidate_create`、`memory_candidate_replace` 或 `memory_candidate_archive`
   创建 pending proposal。
3. `memory_review` 接受或拒绝指定 proposal revision；只有接受审阅才会原子推进规范记录的
   head。
4. 不可变版本、终态审阅和 append-only feedback 保留审计与确定性恢复所需的历史。

Scope 使用严格 tagged value 表示 `global`、`project` 和 `workspace`。只有调用方明确请求时
才执行 workspace → project → global 的祖先检索；检索永远不会跨 sibling project。召回基于
SQLite FTS5 执行确定性词法查询计划、多通道融合、可见性过滤和稳定重排。默认发行版不要求或
下载 embedding 模型，召回过程也不会访问网络。

默认数据库路径为 `~/.xuanling/memory.db`，可使用 `--memory-db <PATH>` 覆盖。stdio server
只在第一次有效 Memory 调用时打开数据库；启动、发现、非 Memory 工具和格式错误的 Memory 请求
不会创建或迁移数据库。

规范数据可以导出、导入空数据库，并用于重建派生搜索 projection：

```sh
xuanling-mcp --memory-db /path/to/memory.db memory export --output backup.jsonl
xuanling-mcp --memory-db /path/to/empty.db memory import --input backup.jsonl
xuanling-mcp --memory-db /path/to/memory.db memory rebuild-index
```

导出命令写入带 count 和 SHA-256 trailer 的版本化 JSONL。导入命令会先校验完整数据流，再执行
单次事务写入；`rebuild-index` 永远不会修改 canonical row。

## DeepSeek Harness

[DSH 集成](integrations/deepseek-harness/README-ZH.md) 把 XuanLing 工具加入 DeepSeek Harness
profile。四个 bundle 对应不同取舍：

| Bundle | 增加的能力 | 适用场景 |
| --- | --- | --- |
| `xuanling-dsh-memory` | 完整九工具 Memory v2 生命周期与 lazy schema projection | 推荐的日常配置 |
| `xuanling-dsh-skills` | 文件与 Memory 工作流 Skill，以及严格覆盖策略 | 搭配恰好一个工具 bundle |
| `xuanling-dsh-tools` | 完整 XuanLing 目录，保留原生工具并 lazy 激活 | 需要 Artifact、项目、文件系统与进程工具 |
| `xuanling-dsh-tools-replace` | 同名文件系统 facade，使用 XuanLing CAS/批处理语义 | 希望 XuanLing 替换 DSH 原生文本文件工具 |

推荐从 `xuanling-dsh-memory` 加 `xuanling-dsh-skills` 开始。可选的
[Blueprint 插件](integrations/deepseek-harness/xuanling-blueprint/README-ZH.md) 增加图形编辑器、
持久 Run 与可选原生 Agent Teams 阶段，需要单独安装。

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-memory@0.8.0 \
  @xuanling-rs/xuanling-dsh-skills@0.8.0
```

把 `web` 换成实际使用的 profile。内置 `headless` profile 用法相同；新建的自定义 profile 只包含
基础 bundle，不会自动包含 Web 或 Headless 应用。

### 复制仓库链接，问答式安装

<!-- xuanling-dsh-conversational-install:start -->
把 `https://github.com/umbrella22/xuanling` 复制到 DeepSeek Harness（DSH）
对话中，并让它安装 XuanLing DSH 集成。DSH 会读取仓库内的
[安装 Skill](.agents/skills/xuanling-dsh-install/SKILL.md)，依次询问 profile 和 preset，
展示冻结后的精确 npm 版本及 package 变更供最终确认，然后只通过 `dsh plugin` 安装并验证。

这是模型编排流程：DSH 本身不会把任意 URL 直接安装。需要时，Agent 会把固定仓库 ref
取得到一个新临时 checkout，并在第一个问题前删除该 checkout。路径发现可以列出 tracked path，
或运行只把路径名输出给模型的 locator；源码和 manifest 正文不能进入模型上下文。可加载的内容
仅限 allowlisted 根 README、安装 Skill，以及可选的 DSH 集成指南。Agent 不会执行仓库代码或从
checkout 安装；profile package 仍只来自公开 npm registry。交互式问答或仓库访问不可用时，
仍可使用下方的手动集成指南。
<!-- xuanling-dsh-conversational-install:end -->

这些 bundle 使用 Host 侧 lazy projection：完整 MCP 目录会被缓存，但模型最初只看到
`mcp_catalog__xuanling`，再按需激活精确工具名。这样降低了初始 schema 成本，同时不改变
Server 合同。Bundle 选择与运行配置见
[DSH 集成说明](integrations/deepseek-harness/README-ZH.md)。

## Blueprint

[Blueprint](integrations/deepseek-harness/xuanling-blueprint/README-ZH.md) 是可选的 DSH 插件，
用于可视化工作流。把输入、智能体任务、人工决策、条件、汇合（全部）和输出节点连接成图，绑定
DSH 现有 Agent、Skill 和 MCP 工具，并为每个智能体任务选择模型。Run 会冻结定义与包内资源，
在每次外部副作用之前记录 intent；无法确认的结果保留为 `recovery_required`，不会自动重放。
工作流可以导出/导入为可移植 ZIP 包；可选的 TeamStage 模式可把一个智能体任务作为原生 DSH
Agent Teams 阶段执行。

## ZCode

[ZCode 插件](integrations/zcode-plugin/plugins/xuanling-mcp/README-ZH.md) 通过
`umbrella22/xuanling-zcode-marketplace` marketplace 提供同样经过验证的原生运行时。增量式
`xuanling-mcp` 插件保留 ZCode 原生文件工具；可选的 `xuanling-mcp-replace` 插件用 XuanLing
的 hash 前置条件编辑路径替换它们。同一时间只能安装一个变体。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `crates/xuanling-toolkit` | 跨平台文件系统、进程、项目、Session 与 Artifact 实现。 |
| `crates/xuanling-memory` | Memory v2 生命周期、SQLite 持久化、词法召回与 JSONL 维护。 |
| `crates/xuanling-mcp` | stdio MCP Server、类型化 Handler、Profile 与 Protocol 合同。 |
| `integrations/deepseek-harness` | DSH 集成 bundle 与可选 Blueprint 插件。 |
| `integrations/zcode-plugin` | ZCode marketplace 插件。 |
| `npm` | Node 启动器、原生 package staging、完整性校验与发布自动化。 |
| `test` | 仅供仓库使用的合同 fixture、probe 与发布验证资产。 |
| `.agents/skills/xuanling-dsh-install` | 问答式安装流程使用的 DSH 安装 Skill。 |

计划、验收证据与事件记录保存在开发机的 `docs/` 下，不进入 tracked tree，也不属于公开 checkout。

## 版本与兼容性

当前仓库版本是 `0.8.0`。已发布的 npm 版本与本仓库当前修订可能面向不同的 DSH 频道：安装前请查看
[CHANGELOG.md](CHANGELOG.md)、[Releases](https://github.com/umbrella22/xuanling/releases) 以及
对应集成 README 中该版本的确切频道与 peer 下限。DSH 会在安装时校验 profile 的运行时；不兼容的
插件版本会被禁用，而不会被启动。

## 开发

仓库开发环境要求 Rust 1.98、Node.js 22.14 或更高版本，以及 npm 11.5.1 或更高版本。

```sh
cargo fmt -p xuanling-toolkit -p xuanling-memory -p xuanling-mcp -- --check
cargo check -p xuanling-toolkit -p xuanling-memory -p xuanling-mcp --all-targets
cargo clippy -p xuanling-toolkit -p xuanling-memory -p xuanling-mcp --all-targets -- -D warnings

cargo test -p xuanling-toolkit --features test-fixtures --test contract
cargo test -p xuanling-memory --test contract
cargo test -p xuanling-mcp --test protocol
cargo test -p xuanling-mcp --test golden

npm --prefix npm run check
npm --prefix npm run check:docs
npm --prefix npm test
```

npm package 组装与发布流程见 [npm/README-ZH.md](npm/README-ZH.md)；测试资产清单见
[test/README-ZH.md](test/README-ZH.md)。

## 许可证

本项目采用 [MIT License](LICENSE)。
