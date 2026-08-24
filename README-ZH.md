# XuanLing MCP

[English](README.md) | 简体中文

XuanLing MCP 是面向编码 Agent 的跨平台本地 Model Context Protocol
服务器。它通过 stdio 提供 42 个类型化工具，覆盖文件系统操作、进程执行、项目探测、
持久化记忆、Artifact 与长生命周期会话。

该服务器适用于需要确定性 schema、结构化失败、显式文件系统能力边界，以及禁止记忆写入
静默进入规范状态的 MCP Host。

## 核心能力

- **类型化文件系统操作**：提供严格编辑、SHA-256 前置条件、分页搜索、可续读内容和显式
  输出预算。
- **Proposal-first Memory v2**：提供不可变记录版本、显式评审、project/workspace scope
  隔离和确定性词法召回。
- **直接进程执行**：使用 program + argv，不隐式启动 shell；取消操作作用于完整后代
  进程树。
- **可选工具 Profile**：每个 Host 只需暴露实际使用的能力族。
- **原生 npm 分发**：支持 macOS、Linux 和 Windows；安装时不编译 Rust、不运行
  `postinstall`，也不远程下载二进制文件。
- **稳定 MCP 合同**：由 protocol、golden、持久化、重启和跨平台测试套件验证。

## 安装

npm 启动器要求 Node.js 18.17 或更高版本，并为当前平台安装匹配的原生二进制包。

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.2.8
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
        "@xuanling-rs/xuanling-mcp@0.2.8",
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

固定 package 版本可保证活动项目发现的 MCP schema 保持稳定。对于频繁启动的服务器，
全局安装或项目内安装可以省去每次启动时的 package 解析过程。

### 支持平台

| 操作系统 | 架构 | 运行时要求 |
| --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | 原生二进制 |
| Linux | `x64` | glibc 2.35 或更高版本 |
| Windows | `x64` | MSVC runtime |

不支持的 OS、CPU 或 libc 组合会返回明确的启动器错误。安装过程不会编译 Rust 或下载
可执行文件。启动器会在启动服务器前校验 package metadata 和原生二进制文件的 SHA-256。

### 从源码构建

源码构建要求 Rust 1.97。

```sh
cargo build --locked --release -p xuanling-mcp
./target/release/xuanling-mcp --workspace-root /absolute/path/to/project
```

## 工具 Profile

默认 catalog 包含全部 42 个工具。重复使用 `--tool-profile` 可以组合多个规模更小且稳定的
工具组：

| Profile | 工具数 | 能力族 |
| --- | ---: | --- |
| `core` | 3 | 系统信息与可移植路径检查 |
| `fs` | 16 | 文件读取、搜索、预览与修改 |
| `process` | 5 | 直接进程执行与项目探测/执行 |
| `memory` | 9 | Memory v2 提案、评审、召回与反馈 |
| `advanced` | 9 | Artifact、ChangeSet、Pipeline 与 Session |
| `all` | 42 | 完整 catalog；未提供 profile 时的默认值 |

`all` 与其他 profile 同时出现时优先生效。工具发现和调用分发使用同一份选择，因此被隐藏的
工具无法通过名称绕过 profile 调用。

## 文件系统安全

未提供任何能力 flag 时，文件系统访问不受限制。生产 Host 配置应声明至少一个 root：

- `--workspace-root <PATH>` 可重复，允许读取、写入、删除，并允许在该 root 内设置子进程
  工作目录。
- `--read-root <PATH>` 可重复，只允许读取、列出、搜索和计算 hash；拒绝写入、删除和设置
  子进程工作目录。
- 仅提供 `--read-root` 会形成只读部署。

修改类工具支持显式 preimage 校验。整文件覆盖和精确编辑使用 `expected_sha256`，
`fs_patch` 使用 `expected_preimage_sha256`。文件在读取后发生变化时，工具会在写入前返回
conflict。

支持窗口输出的工具接受显式 selector，例如
`{"mode":"bounded","max_bytes":65536}`。被截断的读取和搜索会返回类型化 cursor 或
resume token，不会静默丢弃剩余结果。

文件系统能力只约束 XuanLing 自身打开的路径，不是任意子进程的 OS sandbox。工具审批和
恶意进程隔离仍由 MCP Host 及其执行环境负责。

## Memory v2

Memory v2 将提案与规范记录分离：

1. `memory_search` 和 `memory_get` 读取 active 记录。
2. `memory_candidate_create`、`memory_candidate_replace` 或
   `memory_candidate_archive` 创建 pending proposal。
3. `memory_review` 接受或拒绝指定 proposal revision。只有接受评审才会原子推进规范记录的
   head。
4. 不可变版本、终态评审和 append-only feedback 保留审计与确定性恢复所需的历史。

Scope 使用严格 tagged value 表示 `global`、`project` 和 `workspace`。只有调用方明确请求时
才执行 workspace -> project -> global 的祖先检索；检索永远不会跨 sibling project。

召回基于 SQLite FTS5（`unicode61` 与 trigram）执行确定性词法查询计划、多通道融合、
可见性过滤和稳定重排。默认发行版不要求或下载 embedding 模型，召回过程也不会访问网络。

默认数据库路径为 `~/.xuanling/memory.db`。使用 `--memory-db <PATH>` 可以覆盖该路径，
`--default-namespace <VALUE>` 可以设置默认 namespace。Memory 初始化失败不会禁用其他工具；
Memory 调用会返回结构化 unavailable 错误。

### 维护命令

规范数据可以导出、导入空数据库，并用于重建派生搜索 projection：

```sh
xuanling-mcp --memory-db /path/to/memory.db memory export --output backup.jsonl
xuanling-mcp --memory-db /path/to/empty.db memory import --input backup.jsonl
xuanling-mcp --memory-db /path/to/memory.db memory rebuild-index
```

导出命令写入带 count 和 SHA-256 trailer 的版本化 JSONL。导入命令会先校验完整数据流，再执行
单次事务写入；`rebuild-index` 永远不会修改 canonical row。

## DeepSeek Harness

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

[`integrations/deepseek-harness`](integrations/deepseek-harness/) 提供 Host 专用 bundle，
包括增量 Memory 工具、增量或替换式文件工具、schema projection、严格覆盖策略和两个按需加载的
工作流 Skill。该集成位于 Rust 工具合同之外，因此 DeepSeek Harness 专用路由和策略可以独立
演进，不会改变其他 Host 使用的 MCP catalog。

Bundle 选择、安装和运行配置见
[DeepSeek Harness 集成指南](integrations/deepseek-harness/README-ZH.md)。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `crates/xuanling-toolkit` | 跨平台文件系统、进程、项目、Session 与 Artifact 实现。 |
| `crates/xuanling-memory` | Memory v2 生命周期、SQLite 持久化、词法召回与 JSONL 维护。 |
| `crates/xuanling-mcp` | stdio MCP Server、类型化 Handler、Profile 与 Protocol 合同。 |
| `integrations` | 可安装的 Host 专用 Adapter、Policy 与 Skill。 |
| `npm` | Node 启动器、原生 package staging、完整性校验与发布自动化。 |
| `test` | 仅供仓库验收使用的 fixture、probe、evaluation overlay 与报告。 |
| `docs` | 已接受决策、架构、集成合同与执行记录。 |

当前文档索引见 [`docs/README.md`](docs/README.md)。仓库出处和 detached workspace 边界记录在
[`docs/repository-boundary.md`](docs/repository-boundary.md)。

## 开发

仓库开发环境要求 Rust 1.97、Node.js 22.14 或更高版本，以及 npm 11.5.1 或更高版本。

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

完整 Host 合同和错误映射见
[MCP 集成指南](docs/guides/xuanling-mcp-integration.md)。npm package 组装与发布流程见
[`npm/README-ZH.md`](npm/README-ZH.md)。

## 许可证

本项目采用 [MIT License](LICENSE)。
