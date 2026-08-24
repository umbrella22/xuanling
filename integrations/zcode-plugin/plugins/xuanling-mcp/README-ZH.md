# XuanLing MCP for ZCode

[English](README.md) | 简体中文

发行版 `xuanling-mcp` 0.2.8 是自包含的 ZCode 集成。插件携带经过验证的 Node.js launcher，
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
| `mcp-result-adapter.mjs` | ZCode 模型侧 result projection |
| `bin/node_modules` | 发布时生成的 launcher 与三个原生 package alias |
| `LICENSE` | MIT License |
| `skills/xuanling-mcp-tools/SKILL.md` | 工具用法、Memory proposal/review、输出与进程指导 |

Launcher 会选择当前平台 package，校验 metadata 与 SHA-256，然后启动原生 MCP Server。
不支持的 OS、CPU 或 libc 组合会在执行前明确失败。默认 catalog 暴露全部 tool profile。
Memory 默认使用 `~/.xuanling/memory.db`；需要隔离数据库时，可以重述 launch contract 并提供
显式 `--memory-db`。

ZCode 会把 `structuredContent` 追加到模型可见的工具结果。Result adapter 只移除与该值完全相同
的 JSON 文本块，保留人类可读文本和非文本块；structured value 本身仍供 ZCode 校验及结构化消费方使用。

Adapter 只接受子进程 JSON object frame。输出 malformed 或子进程正常退出时仍有未结算的 `tools/call` 会以
非零状态结束，且不会转发无效 frame。Host 终止信号会被转发，子进程未在 500 ms grace 内退出时会被强制终止。

## Agent 工作流

内置 Skill 对普通小型工作优先使用 ZCode 原生 Read/Edit；精确跨平台检索、显式预算、完整分页、
hash/CAS overwrite 与同文件多 hunk 原子 patch 使用 XuanLing。`d.ts`、`d.mts` 等复合后缀会直接
传入。相同 argv 的短验证使用 `deterministic: true`，长任务保留在 ZCode 后台 job 能力上。

Memory 采用 L1/L2 单写。每会话必见的项目局部事实留在 Host 文件 Memory；跨项目共享事实通过
XuanLing pending candidate 保存。显式 L1 指针只在任务开始或主题切换时触发一次 scoped
`memory_search`。Search 返回完整 active record，而非轻量 manifest；review 始终要求用户对具体
proposal 作出显式决定。

## 安全边界

`--workspace-root` 约束 XuanLing 文件工具打开的路径，但不是进程 sandbox。工具审批仍由
ZCode 负责；可能执行恶意代码时，子进程隔离需要 OS sandbox 或 container。XuanLing 0.2.8
不带发布者证书签名；npm provenance、绑定 source commit 的 native hash 与 GitHub attested
marketplace archive 可以降低分发风险，但不能保证所有安全软件对新 binary 给出相同判断。
