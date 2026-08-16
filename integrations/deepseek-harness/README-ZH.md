# XuanLing for DeepSeek Harness

[English](README.md) | 简体中文

该集成通过 DeepSeek Harness 官方 `@deepseek-ai/dsh-mcp-client` bridge 挂载
`xuanling-mcp`。XuanLing 工具会以 `mcp__xuanling__<tool>` 命名的 Harness 原生工具
出现；Host 专用 schema projection、工作流 Skill 和 overwrite policy 保持在 Rust MCP
合同之外。

## 推荐配置

先安装 XuanLing binary：

```sh
npm install --global xuanling-mcp@0.2.1
xuanling-mcp --version
```

将 Memory 与 Skills bundle 安装进目标 DSH profile：

```sh
dsh plugin --profile demo add /path/to/xuanling/integrations/deepseek-harness/xuanling-memory
dsh plugin --profile demo add /path/to/xuanling/integrations/deepseek-harness/xuanling-skills
dsh --profile demo --dump-config
dsh --profile demo
```

推荐组合会增加完整的 Memory v2 九工具生命周期，保留全部 Harness 原生工具，加载两个按需
工作流 Skill，并在 MCP dispatch 前拒绝不安全的 XuanLing 整文件覆盖。

## Bundle

| Bundle | 行为 | 适用场景 |
| --- | --- | --- |
| `xuanling-memory` | 增加带 DSH schema projection 的完整 Memory v2 九工具 profile；保留全部 Harness 原生工具 | 推荐日常配置 |
| `xuanling-skills` | 增加隔离的文件与 Memory 工作流 Skill 以及严格 overwrite policy；不挂载 MCP 工具 | 与任意 XuanLing 工具 bundle 组合 |
| `xuanling-tools` | 增加完整 XuanLing catalog，并保留 Harness 原生工具 | 使用 Artifact、Project、Filesystem、Process 与 Advanced 工具 |
| `xuanling-tools-replace` | 增加完整 catalog，并停用三个模型可见的原生文件系统工具行 | 受控完整目录替换 |

Memory bundle 会暴露完整生命周期。Search、get、candidate create/replace/archive、review 与
feedback 共同构成一个合同；只暴露两个只读工具会向模型隐藏必要的状态转换。

Replace bundle 仍保留 shell、web、LSP、审批、后台任务、PTY 与编排集成。替换 Harness 原生
文件工具后，其 read-before-edit observation guard 和专用 UI card 会消失；XuanLing 提供
SHA-256 前置条件和严格 patch，但 Host 体验并不相同。

## 运行配置

Bundle 表达式在 DSH 启动时解析以下设置：

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| `XUANLING_MCP_BIN` | `PATH` 中的 `xuanling-mcp` | 绝对 launcher/binary 路径或命令名 |
| `XUANLING_WORKSPACE_ROOT` | DSH 进程工作目录 | XuanLing 文件系统 capability root |
| `XUANLING_DSH_SCHEMA_ADAPTER` | 已安装的 `xuanling-memory/schema-adapter.mjs` | 仅源码 checkout overlay 需要 |
| MCP tool profile | 推荐 bundle 固定为 `memory` | 服务端工具发现与调用分发选择 |
| Tool-call timeout | 120 秒 | Harness MCP bridge 的调用预算 |

Server name 固定为 `xuanling`；修改它会重命名全部模型可见工具。Skills bundle 不需要 binary、
workspace 或 database 配置，它会从已安装 package 解析 Skill 内容与 policy 代码。

生产 Memory bundle 使用 XuanLing 共享默认数据库 `~/.xuanling/memory.db`。需要隔离存储的 Host
可以重述 bridge row，并提供显式 `--memory-db` 路径。

## 源码 Checkout Overlay

从 DeepSeek Harness 源码 checkout 直接运行时，设置 schema adapter 路径并应用 bundle patch：

```sh
export XUANLING_MCP_BIN=/absolute/path/to/xuanling-mcp
export XUANLING_DSH_SCHEMA_ADAPTER=/absolute/path/to/xuanling/integrations/deepseek-harness/xuanling-memory/schema-adapter.mjs
export XUANLING_WORKSPACE_ROOT=/absolute/path/to/project

pnpm dsh web \
  --patch /absolute/path/to/xuanling/integrations/deepseek-harness/xuanling-memory/cordis.patch.yml
```

完整 catalog 变体使用各自 patch：

```sh
pnpm dsh web \
  --patch /absolute/path/to/xuanling/integrations/deepseek-harness/xuanling-tools/cordis.patch.yml

pnpm dsh web \
  --patch /absolute/path/to/xuanling/integrations/deepseek-harness/xuanling-tools-replace/cordis.patch.yml
```

已安装 bundle 会解析自身 dependency 与 adapter 路径，不依赖 DSH 的启动目录。

## Schema Projection

DeepSeek Harness 支持的 JSON Schema 词汇比 canonical MCP catalog 更窄。推荐 Memory bundle
将 `schema-adapter.mjs` 放在官方 bridge 与 `xuanling-mcp` 之间：

1. 只投影 `tools/list` 的 input schema。
2. 解析本地 `$ref` 并内联 `$defs`。
3. 使用 DSH 模型词汇表达受支持的 nullable union 与 tagged object。
4. 不支持、循环、歧义或有损结构会令启动失败。
5. `tools/call` 参数保持逐字透传，并继续由 canonical Rust schema 校验。

Adapter 不创建第二份 Memory protocol，也不会在工具选择后改写模型参数。

## 工作流 Skill

`xuanling-skills` 挂载隔离的静态 Skill provider，并提供两个按需 Skill：

- `xuanling-file-workflow`：普通读取和小编辑优先 Harness 原生工具；需要 hash/CAS 保护、显式
  byte budget、续读、严格 unified diff 或完整分页时选择 XuanLing 工具。
- `xuanling-memory-workflow`：提案前先检索，所有 candidate 保持 pending，只有用户显式决策
  指定 proposal 后才调用 `memory_review`。

严格 overwrite policy 会拒绝缺少非空 `expected_sha256` 的
`mcp__xuanling__fs_write_text` overwrite 请求。Create mode 与携带 hash 的 overwrite 会原样
进入 MCP Server。该 policy 同时作用于 Native 与 Code Mode dispatch。

## 安全边界

- XuanLing 对文件工具实施 pathname capability；process/session/pipeline 工具启动的进程仍需
  Harness 审批，并在可能执行恶意代码时使用 OS sandbox。
- DSH 专用 schema projection 和 policy 不会弱化 canonical MCP 校验。
- 官方 bridge 同时服务 Native 与 Code Mode consumer，因此 MCP result 可能同时携带 text 与
  structured representation；本集成会保留两种表示。
