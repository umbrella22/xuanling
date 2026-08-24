# XuanLing for DeepSeek Harness

[English](README.md) | 简体中文

该集成通过 DeepSeek Harness 官方 `@deepseek-ai/dsh-mcp-client` bridge 挂载
`xuanling-mcp`。XuanLing 工具会以 `mcp__xuanling__<tool>` 命名的 Harness 原生工具
出现；Host 专用 schema projection、工作流 Skill 和 overwrite policy 保持在 Rust MCP
合同之外。

## 推荐配置

将 Memory 与 Skills bundle 安装进 DSH 内置的 `web` profile：

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-memory@0.2.7 \
  @xuanling-rs/xuanling-dsh-skills@0.2.7
dsh --profile web --dump-config
dsh web
```

需要扩展 DSH 内置的 Headless 应用时，将 `--profile web` 改为 `--profile headless`。任意新 profile 名称并非
等价替换：当前 DSH 对未知名称只初始化 `@deepseek-ai/dsh-base`，不会自动加入 Web 或
Headless 应用 bundle。

Memory bundle 会在 profile 内安装精确版本的 `@xuanling-rs/xuanling-mcp@0.2.7` launcher 和原生 optional
dependency；不需要全局 npm package、`npx` 或安装时下载 binary。

推荐组合会增加完整的 Memory v2 九工具生命周期，保留全部 Harness 原生工具，并加载两个按需
工作流 Skill。该 profile 会使用 Memory Skill；只有另一个 tools bundle 让 XuanLing fs 工具可见
时，File Skill 才会应用。

## Bundle

| Bundle | 行为 | 适用场景 |
| --- | --- | --- |
| `@xuanling-rs/xuanling-dsh-memory` | 增加带 DSH schema projection 的完整 Memory v2 九工具 profile；保留全部 Harness 原生工具 | 推荐日常配置 |
| `@xuanling-rs/xuanling-dsh-skills` | 增加隔离的文件与 Memory 工作流 Skill 以及严格 overwrite policy；不挂载 MCP 工具 | 与任意 XuanLing 工具 bundle 组合 |
| `@xuanling-rs/xuanling-dsh-tools` | 增加完整 XuanLing catalog，并保留 Harness 原生工具 | 使用 Artifact、Project、Filesystem、Process 与 Advanced 工具 |
| `@xuanling-rs/xuanling-dsh-tools-replace` | 增加完整 catalog，并停用三个模型可见的原生文件系统工具行 | 受控完整目录替换 |

Memory bundle 会暴露完整生命周期。Search、get、candidate create/replace/archive、review 与
feedback 共同构成一个合同；只暴露两个只读工具会向模型隐藏必要的状态转换。

Replace bundle 仍保留 shell、web、LSP、审批、后台任务、PTY 与编排集成。替换 Harness 原生
文件工具后，其 read-before-edit observation guard 和专用 UI card 会消失；XuanLing 提供
SHA-256 前置条件和严格 patch，但 Host 体验并不相同。

## 运行配置

Bundle 表达式在 DSH 启动时解析以下设置：

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| MCP runtime | Profile 内的 `@xuanling-rs/xuanling-mcp@0.2.7` | 经过校验的 JS launcher 与原生 optional dependency |
| `XUANLING_WORKSPACE_ROOT` | DSH 进程工作目录 | XuanLing 文件系统 capability root |
| Schema adapter | 已安装的 `xuanling-dsh-memory/schema-adapter.mjs` | 为 DSH 投影 discovery schema |
| Result adapter | 各 bundle 内置的 `mcp-result-adapter.mjs`（memory 由 schema adapter 组合） | 只删除等价的重复文本块 |
| MCP tool profile | 推荐 bundle 固定为 `memory` | 服务端工具发现与调用分发选择 |
| Tool-call timeout | 120 秒 | Harness MCP bridge 的调用预算 |

Server name 固定为 `xuanling`；修改它会重命名全部模型可见工具。Skills bundle 不需要 binary、
workspace 或 database 配置，它会从已安装 package 解析 Skill 内容与 policy 代码。

生产 Memory bundle 使用 XuanLing 共享默认数据库 `~/.xuanling/memory.db`。需要隔离存储的 Host
可以重述 bridge row，并提供显式 `--memory-db` 路径。

## Schema Projection

DeepSeek Harness 支持的 JSON Schema 词汇比 canonical MCP catalog 更窄。推荐 Memory bundle
将 `schema-adapter.mjs` 放在官方 bridge 与 `xuanling-mcp` 之间：

1. 只投影 `tools/list` 的 input schema。
2. 解析本地 `$ref` 并内联 `$defs`。
3. 使用 DSH 模型词汇表达受支持的 nullable union 与 tagged object。
4. 不支持、循环、歧义或有损结构会令启动失败。
5. `tools/call` 参数保持逐字透传，并继续由 canonical Rust schema 校验。

Adapter 不创建第二份 Memory protocol，也不会在工具选择后改写模型参数。

## Result Projection

MCP wire 合同会有意保留 `content` 与 `structuredContent` 两种表示。DSH 使用文本块进行一次
Native 模型渲染，同时保留 structured value 供 Code Mode 与输出校验使用。集成 adapter 只会在
边界处删除“与同一 structured value 完全相同”的意外重复文本块；不会把唯一的完整文本投影替换
成 marker，因此 Native 上下文保持无损。

Adapter 只接受子进程 stdout 中的 JSON object。malformed stdout、非 object frame 或子进程正常退出时仍有
未结算 request 都会令 adapter 以非零状态退出，且不会转发无效 frame。Host 终止信号会先转发给子进程；
子进程在 500 ms grace 内未退出时会被强制终止。

## 工作流 Skill

`xuanling-skills` 挂载隔离的静态 Skill provider，并提供两个按需 Skill：

- `xuanling-file-workflow`：仅在 XuanLing fs 工具可见时应用。普通读取和小编辑优先 Harness
  原生工具；hash/CAS、复合后缀精确检索、显式 byte budget、完整分页，以及同文件多 hunk 的
  单次原子 `fs_patch` 使用 XuanLing。相同 argv 的短验证使用 `deterministic: true`，长任务使用
  Harness 后台 job。
- `xuanling-memory-workflow`：采用 L1/L2 单写。项目局部、每会话必见的事实只写 Host 文件
  Memory；跨项目共享事实进入 XuanLing。显式 L1 指针只在任务开始或主题切换时触发一次 scoped
  pull，而非每轮检索。`memory_search` 返回完整 active record，不是轻量 manifest。所有新
  candidate 保持 pending，只有用户显式指定 proposal 后才调用 `memory_review`。

严格 overwrite policy 会拒绝缺少非空 `expected_sha256` 的
`mcp__xuanling__fs_write_text` overwrite 请求。Create mode 与携带 hash 的 overwrite 会原样
进入 MCP Server。该 policy 同时作用于 Native 与 Code Mode dispatch。

## 安全边界

- XuanLing 对文件工具实施 pathname capability；process/session/pipeline 工具启动的进程仍需
  Harness 审批，并在可能执行恶意代码时使用 OS sandbox。
- DSH 专用 schema projection 和 policy 不会弱化 canonical MCP 校验。
- MCP result 会保留 text 与 structured 两种表示。集成 adapter 会在 DSH 边界去除重复的相同文本
  投影，同时保留 structured value 供 Code Mode 与校验使用。
