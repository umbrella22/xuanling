# 面向 ZCode 的 XuanLing MCP

[English](README.md) | 简体中文

XuanLing MCP 是一个本地、自包含的工具服务器，为 ZCode 的编码 Agent 提供类型化的文件系统、进程、项目、Memory 与会话工具。同一次调用在 macOS、Linux 和 Windows 上返回相同的结构化结果，数据不离开本机。当前版本：0.9.0。

## 为什么选择它

- **跨平台结果一致。** 一次类型化调用返回一份结构化结果，不需要 grep/findstr/Select-String 的方言翻译。
- **有界输出，可续读。** 省略输出预算时最多返回 65,536 字节，并带游标或续读令牌，而不是静默截断；需要完整结果时显式请求。
- **编辑带真实前置条件。** 整文件写入和精确编辑可以要求提供你读取内容对应的 SHA-256；文件被他人修改时返回冲突，而不是直接覆盖。
- **一致、原子化的多文件编辑。** 有序批次会在首次写入前预检全部文件与哈希；高风险编辑可记录为可回滚的变更集。
- **先提案后记忆。** 搜索和读取可直接使用；修改先成为提案，只有显式评审才转为规范记录。存储使用本地 SQLite 全文检索，不下载 embedding 模型，也不访问网络。
- **直接进程，不经过 shell。** 程序以显式 argv 运行，引号和元字符在不同平台不会改变含义。

适合谁：在跨平台仓库中工作的 ZCode 用户和团队、编辑操作密集的会话，或需要少量持久且可评审记忆的项目。若希望 XuanLing 取代 ZCode 原生文件工具而非与它们并存，请使用[替换版](../xuanling-mcp-replace/README-ZH.md)。

## 从 ZCode marketplace 安装

1. 在 ZCode 中将 `umbrella22/xuanling-zcode-marketplace` 添加为 GitHub marketplace source。
2. 在 ZCode 插件管理器中安装并启用 `xuanling-mcp` 插件（版本 0.9.0）。
3. 确认 `PATH` 中存在 Node.js 18.17 或更高版本。

插件为自包含分发：内置匹配的 macOS ARM64、Linux x64（glibc 2.35 或更高）与 Windows x64 运行时。不依赖全局 npm 安装，安装期间也不会下载二进制文件。

已在 ZCode 3.10.2 上验证，工具以 `mcp__plugin_xuanling-mcp_xuanling__<tool>` 出现。同一时间只安装并启用一个 XuanLing 变体。

## 两个变体，二选一

| 插件 | 作用 | 适合场景 |
| --- | --- | --- |
| `xuanling-mcp`（additive，默认，即本文） | 在 ZCode 原生工具旁增加 XuanLing 工具。 | 想保留原生 Read/Edit 及其界面，同时在跨平台结果、有界输出、哈希保护编辑、进程或 Memory 上使用 XuanLing。 |
| [`xuanling-mcp-replace`](../xuanling-mcp-replace/README-ZH.md)（可选，需显式启用） | 阻止 ZCode 原生 Read/Write/Edit/ApplyPatch/MultiEdit，并要求 XuanLing 修改操作携带 SHA-256 前置条件。 | 希望所有文件修改都经过同一套强制约定，并接受放弃原生文件工具的便利界面。 |

安装替换版前需要先禁用或卸载本插件；禁用替换版会移除其拦截策略并恢复 ZCode 原生文件工具。

## 包含内容与工作流

插件内置一个本地 MCP 服务器，提供完整的 XuanLing 工具目录，共 43 个类型化工具：文件系统检查、搜索与修改；显式 argv 进程与管道；项目探测与脚本执行；提案评审式 Memory；会话；以及进程输出 Artifact。插件还内置一份 Skill，指导 Agent 何时继续使用 ZCode 原生工具、何时改用 XuanLing。

典型会话：

1. 用有界输出查找和读取，并保留返回的 SHA-256。
2. 以该哈希作为前置条件写入或编辑，并检查返回的差异（diff）。
3. 若格式化器或其他外部写入方改动过文件，先重新读取或取哈希，再执行下一次修改。
4. 项目自带的 check/test/build 脚本交给项目工具运行；长任务留在 ZCode 的后台任务中。

Memory 采用先提案流程：每个会话都需要的项目局部事实留在 ZCode 自身的文件 Memory 中；跨项目共享事实先提交给 XuanLing，只有显式评审后才成为规范记录。默认数据库为 `~/.xuanling/memory.db`，召回在本地以词法方式完成。

## 安全边界与宿主限制

- XuanLing 文件工具限定在当前项目目录内。这是路径能力，不是进程沙箱：你启动的进程仍可能访问其他路径，工具审批与 OS 级隔离仍由 ZCode 负责。
- 该 additive 变体不安装宿主侧的拦截策略。SHA-256 前置条件需要调用方主动提供，服务器不会改写工具参数；需要保护时请显式传入。
- Memory 存储在本地；插件不需要 API key、账号或外部服务。
- 发布物来自不可变的 XuanLing 发布流水线：启动器选择匹配的平台原生包，并在执行前校验其 SHA-256。XuanLing 0.9.0 不带平台发布者证书签名；npm provenance、绑定源码的哈希与带证明的 marketplace 归档包可降低分发风险。
- ZCode 3.10.2 是本文工具名与限制的验证宿主。更新的 ZCode 版本可能改变宿主工具命名或呈现方式，请以当前工具目录为准。

## 链接

- [XuanLing ZCode marketplace](https://github.com/umbrella22/xuanling-zcode-marketplace)
- [XuanLing 源码仓库](https://github.com/umbrella22/xuanling)
- [MCP 集成指南](https://github.com/umbrella22/xuanling/blob/main/npm/packages/xuanling-mcp/README-ZH.md)
- [ZCode 替换版](../xuanling-mcp-replace/README-ZH.md)
- [MIT License](LICENSE)
