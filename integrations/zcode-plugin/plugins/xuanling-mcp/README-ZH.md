# XuanLing MCP for ZCode

[English](README.md) | 简体中文

发行版 `xuanling-mcp` 0.2.1 是自包含的 ZCode 集成。插件携带经过验证的 Node.js launcher，
以及 macOS ARM64、Linux x64 glibc 和 Windows x64 原生 package。它不依赖全局 npm 安装，
安装期间也不会下载可执行文件。

## 安装

在 ZCode 中将 `umbrella22/xuanling-zcode-marketplace` 添加为 GitHub marketplace source，
然后通过 ZCode 插件管理器安装 `xuanling-mcp`。运行时要求 `PATH` 中存在 Node.js 18.17 或
更高版本。

## 运行路径

`.mcp.json` 是唯一启动合同。Plugin manifest 只引用该文件；它通过
`${ZCODE_PLUGIN_ROOT}` 启动随插件分发的 Node.js launcher，并把
`${ZCODE_PROJECT_DIR}` 作为文件系统 capability root。Launcher 会选择当前平台 package，
校验 SHA-256 后才执行原生 binary。

## 包含组件

| 路径 | 作用 |
| --- | --- |
| `.zcode-plugin/plugin.json` | Plugin metadata 与 `.mcp.json` component 引用 |
| `.mcp.json` | 唯一 MCP 启动配置 |
| `bin/node_modules` | 发布时生成的 launcher 与三个原生 package alias |
| `LICENSE` | MIT License |
| `skills/xuanling-mcp-tools/SKILL.md` | 工具用法、Memory proposal/review、输出与进程指导 |

Launcher 会选择当前平台 package，校验 metadata 与 SHA-256，然后启动原生 MCP Server。
不支持的 OS、CPU 或 libc 组合会在执行前明确失败。默认 catalog 暴露全部 tool profile。
Memory 默认使用 `~/.xuanling/memory.db`；需要隔离数据库时，可以重述 launch contract 并提供
显式 `--memory-db`。

## 安全边界

`--workspace-root` 约束 XuanLing 文件工具打开的路径，但不是进程 sandbox。工具审批仍由
ZCode 负责；可能执行恶意代码时，子进程隔离需要 OS sandbox 或 container。XuanLing 0.2.1
不带发布者证书签名；npm provenance、绑定 source commit 的 native hash 与 GitHub attested
marketplace archive 可以降低分发风险，但不能保证所有安全软件对新 binary 给出相同判断。
