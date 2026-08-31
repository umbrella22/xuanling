# XuanLing MCP

[English](README.md) | 简体中文

`@xuanling-rs/xuanling-mcp` 是面向编码 Agent 的跨平台本地 Model Context Protocol 服务器。它通过
stdio 提供 42 个类型化工具，覆盖文件系统操作、进程执行、项目探测、Artifact、Session 和
proposal-first SQLite Memory。

## 安装

启动器要求 Node.js 18.17 或更高版本。

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.3.2
xuanling-mcp --version
```

MCP Client 也可以使用 `npx` 固定版本：

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "@xuanling-rs/xuanling-mcp@0.3.2",
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

固定版本可以保持活动项目发现的 MCP 合同稳定。频繁启动服务器时，全局安装或项目内安装可以
省去 package 解析过程。

## 支持平台

| 操作系统 | 架构 | 运行时要求 |
| --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | 原生二进制 |
| Linux | `x64` | glibc 2.35 或更高版本 |
| Windows | `x64` | MSVC runtime |

不支持的 OS、CPU 或 libc 组合会返回明确错误。安装过程不编译 Rust、不运行 `postinstall`，
也不下载可执行文件。启动器会在启动前校验 package metadata 和所选原生 binary 的 SHA-256。

## 工具 Profile

默认 catalog 暴露全部 42 个工具。重复使用 `--tool-profile` 可以组合多个较小的工具组：

| Profile | 工具数 | 能力族 |
| --- | ---: | --- |
| `core` | 3 | 系统信息与可移植路径检查 |
| `fs` | 16 | 文件读取、搜索、预览与修改 |
| `process` | 5 | 直接进程执行与项目探测/执行 |
| `memory` | 9 | Memory v2 提案、评审、召回与反馈 |
| `advanced` | 9 | Artifact、ChangeSet、Pipeline 与 Session |
| `all` | 42 | 完整 catalog 和默认选择 |

## 文件系统能力

- `--workspace-root <PATH>` 可重复，允许读取、写入、删除，并允许在该 root 内设置子进程
  工作目录。
- `--read-root <PATH>` 可重复，只允许读取、列出、搜索和计算 hash；拒绝写入、删除和设置
  子进程工作目录。
- 两个 flag 都未提供时，XuanLing 文件系统访问不受限制。仅提供 `--read-root` 时为只读部署。

修改类工具支持 SHA-256 preimage 校验。支持窗口输出的工具可以设置显式 byte budget，并返回
类型化 cursor 或 resume token，不会静默截断结果。

路径能力不是子进程的 OS sandbox。工具审批和恶意进程隔离由 MCP Host 与执行环境负责。

## Memory v2

Create、replace 和 archive 调用只产生 pending proposal。只有显式 `memory_review` 决策才能
原子推进不可变的 canonical record。严格的 `global`、`project` 和 `workspace` scope 防止
sibling project 之间发生召回泄漏。

召回使用确定性 SQLite FTS5 query plan 和稳定词法重排，不要求或下载 embedding 模型。默认
数据库路径为 `~/.xuanling/memory.db`；使用 `--memory-db <PATH>` 可以覆盖该路径。

## Server 选项

```text
--base-dir <PATH>                  相对路径解析上下文
--workspace-root <PATH>            可重复的读写 capability root
--read-root <PATH>                 可重复的只读 capability root
--memory-db <PATH>                 共享 SQLite Memory 数据库
--default-namespace <VALUE>        默认 Memory namespace
--sqlite-busy-timeout-ms <NUMBER>  SQLite busy timeout（默认 5000）
--tool-profile <PROFILE>           可重复工具组；默认 all
--compat-lenient-object-params     受影响 Host 的可选兼容模式
```

## 源码与文档

- 源码：<https://github.com/umbrella22/xuanling>
- 集成指南：<https://github.com/umbrella22/xuanling/blob/main/docs/guides/xuanling-mcp-integration.md>
- DeepSeek Harness 集成：<https://github.com/umbrella22/xuanling/tree/main/integrations/deepseek-harness>
- Issues：<https://github.com/umbrella22/xuanling/issues>

本项目采用 [MIT License](LICENSE)。
