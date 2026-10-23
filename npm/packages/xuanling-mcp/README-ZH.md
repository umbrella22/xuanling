# XuanLing MCP

[English](README.md) | 简体中文

`@xuanling-rs/xuanling-mcp` 是面向编码 Agent 的本地跨平台 Model Context Protocol
（MCP）服务器。它通过 stdio 提供 43 个类型化工具，覆盖文件系统操作、进程与项目执行、
Artifact、Session 和 proposal-first 的 Memory v2，并提供确定性 schema、结构化失败和显式
文件系统边界。

## 这是什么、为什么用它

XuanLing 让 MCP Host 获得一个本地、可预测的统一工具面，而不必为每个平台维护一套脚本。
它的主要特点：

- **43 个类型化工具，可按 profile 组合。** Host 可以暴露完整 catalog，也可以只暴露需要
  的工具族；未暴露的工具无法按名称调用。
- **文件操作带显式安全前置条件。** 修改类工具支持 SHA-256 preimage 校验；支持窗口输出
  的读取和搜索返回类型化 cursor，而不是静默截断；路径访问由显式 capability root 控制。
- **proposal-first 的 Memory v2。** Memory 写入先停留在 pending proposal，只有显式
  `memory_review` 决策才会推进不可变 canonical record，Agent 无法静默改写持久化 Memory。
- **直接的进程与项目执行。** 命令以 program + argv 形式运行，不经过隐式 shell；取消操作
  会作用于整个子进程树。
- **原生 npm 分发。** 安装过程不运行 `postinstall`、不编译 Rust、不从远程 URL 下载
  binary；启动器会校验平台 package metadata 和原生 binary 的 SHA-256。

**该用哪个？** 当 MCP Host 可以直接启动 stdio 服务器时，使用
`@xuanling-rs/xuanling-mcp`。使用 DeepSeek Harness 时，请安装对应 bundle：推荐用
`@xuanling-rs/xuanling-dsh-memory` 获得 Memory v2 profile；需要增量挂载完整 catalog 用
`@xuanling-rs/xuanling-dsh-tools`；需要替换 DSH 文件系统工具用
`@xuanling-rs/xuanling-dsh-tools-replace`。`@xuanling-rs/xuanling-dsh-skills` 只增加
工作流 Skill，不挂载 MCP 工具。[DeepSeek Harness 集成 README](https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/README-ZH.md)
说明了 bundle 的选择与安装。

## 环境要求

- Node.js 18.17 或更高版本。
- 支持 stdio 的 MCP Host。
- 受支持平台之一：

| 操作系统 | 架构 | 运行时要求 |
| --- | --- | --- |
| macOS | Apple Silicon（`arm64`） | 原生二进制 |
| Linux | `x64` | glibc 2.35 或更高版本 |
| Windows | `x64` | MSVC runtime |

不需要 Rust 工具链或编译器。不支持的 OS、CPU 或 libc 组合会由启动器返回明确错误。

## 安装

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.8.1
xuanling-mcp --version
```

频繁启动服务器时，全局安装或项目内安装可以省去 package 解析步骤。偏好按需执行的 Host
可以使用[快速开始](#快速开始)中的固定版本 `npx` 配置。

固定精确版本可以让活动项目发现的 MCP 合同保持稳定。已发布的 npm 版本不可变。

## 快速开始

把服务器加入 MCP Client 配置：

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "@xuanling-rs/xuanling-mcp@0.8.1",
        "--workspace-root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

重启 Host，让它启动服务器并完成 MCP `initialize`。初始化 metadata 会发布所选 catalog
的 `xuanling.tool_count` 和模型可见定义的 `xuanling.catalog_sha256`。重复添加
`--tool-profile` 可以让服务器只暴露 Host 需要的工具族；见[工具 Profile](#工具-profile)。

## 使用与配置

### 工具 Profile

默认 catalog 暴露全部 43 个工具。重复使用 `--tool-profile` 可以组合较小的工具组：

| Profile | 工具数 | 能力族 |
| --- | ---: | --- |
| `core` | 3 | 系统信息与可移植路径检查 |
| `fs` | 17 | 文件读取、搜索、预览与修改 |
| `process` | 5 | 直接进程执行与项目探测/执行 |
| `memory` | 9 | Memory v2 提案、评审、召回与反馈 |
| `advanced` | 9 | Artifact、ChangeSet、Pipeline 与 Session |
| `all` | 43 | 完整 catalog 和默认选择 |

`all` 与其他 profile 同时出现时优先。发现与调用使用同一份选择，未暴露的工具无法按名称
调用。修改 profile 后需要重启服务器进程。

### 文件系统边界

- `--workspace-root <PATH>` 可重复，允许读取、写入、删除，并允许在该 root 内设置子进程
  工作目录。
- `--read-root <PATH>` 可重复，只允许读取、列出、搜索和计算 hash；拒绝写入、删除和设置
  子进程工作目录。
- 两个 flag 都未提供时，XuanLing 文件系统访问不受限制。仅提供 `--read-root` 时为只读
  部署。
- 在配置了 capability root 的部署中，`--base-dir` 默认取第一个 `--workspace-root`；
  `--base-dir` 只是相对路径解析上下文，不是 sandbox。

修改类工具支持 SHA-256 preimage 校验。支持窗口输出的工具可以设置显式 byte budget，并返回
类型化 cursor 或 resume token，不会静默截断结果。

路径能力不是子进程的 OS sandbox。工具审批和恶意进程隔离由 MCP Host 与执行环境负责。

### Memory v2

Memory v2 把提案（proposal）与 canonical record 分开：

1. `memory_search` 与 `memory_get` 检查 active record。
2. `memory_candidate_create`、`memory_candidate_replace` 和
   `memory_candidate_archive` 产生 pending proposal。
3. `memory_review` 接受或拒绝特定 proposal revision；只有 review 被接受才会原子推进
   canonical record head。
4. 不可变版本、终态 review 和 append-only feedback 保留审计与恢复所需的历史。

`global`、`project` 和 `workspace` scope 严格执行；sibling project 之间不会互相
召回。召回使用 SQLite FTS5 上的确定性词法查询计划，不要求也不下载 embedding 模型。默认
数据库为 `~/.xuanling/memory.db`；可用 `--memory-db <PATH>` 覆盖。服务器在第一次有效
Memory 工具调用时才惰性打开数据库，因此启动、discovery 和非 Memory 工具不会创建或迁移它。

canonical 数据可以导出、导入空数据库，并用于重建派生搜索投影：

```sh
xuanling-mcp --memory-db /path/to/memory.db memory export --output backup.jsonl
xuanling-mcp --memory-db /path/to/empty.db memory import --input backup.jsonl
xuanling-mcp --memory-db /path/to/memory.db memory rebuild-index
```

导出会写入带版本的 JSONL；导入会先完整校验，再以单个事务写入；`rebuild-index` 不会改变
canonical row。

### 服务器选项

```text
--base-dir <PATH>                  相对工具路径的解析上下文（不是 sandbox）
--workspace-root <PATH>            可重复的读写删除 capability root
--read-root <PATH>                 可重复的只读 capability root
--memory-db <PATH>                 共享 SQLite Memory 数据库（默认：~/.xuanling/memory.db）
--default-namespace <VALUE>        Memory 请求省略 namespace 时使用的默认值
--sqlite-busy-timeout-ms <NUMBER>  SQLite busy timeout（默认 5000）
--tool-profile <PROFILE>           可重复工具组；默认 all
--compat-lenient-object-params     面向会把 object 参数转成字符串的 Host 的可选兼容模式
```

`xuanling-mcp memory export|import|rebuild-index` 是维护子命令，不会启动 stdio 服务器
会话。

## 工作原理

- npm package 是 Node.js 启动器：解析平台原生 package，校验版本 metadata 与 binary
  SHA-256，然后把 argv、stdio、signal 和退出状态透传给原生服务器。
- 原生服务器只通过 stdin/stdout 承载 MCP，不监听网络端口，也不发起远程调用。
- 工具 catalog 在服务器进程生命周期内保持不变。`tools/list` 使用不透明 cursor 分页，
  Host 必须持续跟随 `nextCursor` 直到其消失。
- Memory 是本地 SQLite 数据库，惰性打开；召回过程不访问网络。

## 兼容性与限制

- 受支持的 npm 目标为 macOS Apple Silicon、glibc 2.35 或更高版本的 Linux x64，以及
  Windows x64 MSVC。Intel macOS、ARM Linux、glibc 2.34 及更早版本、musl Linux 和
  ARM Windows 不在发布范围内。
- 支持的 MCP 协议版本为 `2024-11-05`、`2025-03-26`、`2025-06-18` 和
  `2025-11-25`。
- 0.8.1 的原生 binary 没有 Developer ID 或 Authenticode 签名；package 完整性合同由
  npm provenance 和启动器的 SHA-256 校验保证。
- 文件系统 capability 不是 XuanLing 工具所启动进程的 OS sandbox。
- catalog 在服务器进程内不变，服务器不会声明 `tools.listChanged`。修改 profile 或
  catalog 配置后需要重启服务器。
- Memory 在每个服务器进程中使用单个本地 SQLite 数据库，需要可写的数据库路径，或可解析的
  `HOME`/`USERPROFILE`。
- 服务器只使用 stdio transport，不提供 HTTP 或远程模式。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `Unsupported platform: <os>/<arch>` | 该目标未发布。请使用 macOS Apple Silicon、glibc 2.35 或更高版本的 Linux x64，或 Windows x64。 |
| `Unsupported Linux libc` 或 `Unsupported Linux glibc` | XuanLing 只发布 glibc 构建，并要求 glibc 2.35 或更高版本。 |
| `Missing optional dependency` 或 `Native binary checksum mismatch` | 重新安装固定版本，例如 `npm install --global @xuanling-rs/xuanling-mcp@0.8.1`。已发布的 npm 版本不可变。 |
| Memory 工具报告 `memory store unavailable` 或 `cannot resolve the default memory DB path` | 传入可写的 `--memory-db <PATH>`，或设置 `HOME`/`USERPROFILE` 以便解析默认的 `~/.xuanling/memory.db`。非 Memory 工具仍可正常使用。 |
| Host 看到的工具比预期少 | 当前启用了 `--tool-profile` 选择。组合多个 profile 或使用 `--tool-profile all`，然后重启服务器进程。 |
| Host 在 `initialize` 前退出 | 检查 Node.js 版本（18.17 或更高）以及 Host 的 stdio 启动配置。 |

## 链接

- 源码：<https://github.com/umbrella22/xuanling>
- 产品文档：<https://github.com/umbrella22/xuanling/blob/main/README-ZH.md>
- DeepSeek Harness 集成：<https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/README-ZH.md>
- Changelog：<https://github.com/umbrella22/xuanling/blob/main/CHANGELOG.md>
- Issues：<https://github.com/umbrella22/xuanling/issues>
- npm package：<https://www.npmjs.com/package/@xuanling-rs/xuanling-mcp>

本项目采用 [MIT License](LICENSE)。
