# 面向 ZCode 的 XuanLing MCP 替换插件

[English](README.md) | 简体中文

XuanLing MCP 替换插件让 XuanLing 成为 ZCode 编码 Agent 唯一的文件后端。它主动阻止 ZCode 原生的文件工具，并要求针对既有文件的每次修改都携带当前 SHA-256 前置条件，使文件变更显式、可评审，并能抵御并发编辑。当前版本：0.7.0。

## 为什么选择它

- **无法静默绕过。** 原生 Read/Write/Edit/ApplyPatch/MultiEdit 在执行前即被拒绝，文件操作必须经过 XuanLing。
- **每次既有文件修改都带哈希。** 覆盖、替换、编辑、批次与 patch 必须携带其预期内容的 SHA-256（或 preimage 哈希），否则失败。
- **跨平台行为一致。** 路径、UTF-8、精确匹配与原子替换由同一套类型化约定处理，在 macOS、Linux 和 Windows 上一致。
- **结果可评审。** 编辑返回可检查的 diff，高风险编辑可设为可回滚。
- **失败语义清晰。** 冲突、零匹配或多匹配、过期哈希都是停止信号；批次失败会报告每个文件的恢复状态，而不是猜测继续。

适合谁：把文件完整性置于原生文件工具便利性之上的团队和仓库——编辑操作密集、多人共享代码库、需要审计的修改，或希望统一文件系统约定。若你需要 ZCode 原生图片渲染或稳定的原生 diff 卡片，本变体不是合适选择。

## 从 ZCode marketplace 安装

1. 在 ZCode 中将 `umbrella22/xuanling-zcode-marketplace` 添加为 GitHub marketplace source。
2. 禁用或卸载 additive 的 `xuanling-mcp` 插件；同一时间只允许启用一个 XuanLing 变体。
3. 安装并启用 `xuanling-mcp-replace` 插件（版本 0.7.0）。
4. 确认 `PATH` 中存在 Node.js 18.17 或更高版本。

插件为自包含分发：内置匹配的 macOS ARM64、Linux x64（glibc 2.35 或更高）与 Windows x64 运行时。不依赖全局 npm 安装，安装期间也不会下载二进制文件。

已在 ZCode 3.10.2 上验证，工具以 `mcp__plugin_xuanling-mcp-replace_xuanling__<tool>` 出现；`fs_edit` 等短名称表示该限定名的后缀。禁用或卸载本插件会移除拦截策略，并恢复 ZCode 原生文件工具。

## 两个变体，二选一

| 插件 | 作用 | 适合场景 |
| --- | --- | --- |
| [`xuanling-mcp`](../xuanling-mcp/README-ZH.md)（additive，默认） | 在 ZCode 原生工具旁增加 XuanLing 工具。 | 想保留原生 Read/Edit 及其界面，只在跨平台结果、有界输出、哈希编辑、进程或 Memory 上使用 XuanLing。 |
| `xuanling-mcp-replace`（可选，需显式启用，即本文） | 阻止 ZCode 原生 Read/Write/Edit/ApplyPatch/MultiEdit，并要求 XuanLing 修改操作携带 SHA-256 前置条件。 | 希望所有文件修改都经过同一套强制约定，并接受放弃原生文件工具的便利界面。 |

## 包含内容与工作流

插件内置与 additive 变体相同的本地 XuanLing MCP 服务器，提供完整工具目录，共 43 个类型化工具：文件系统检查、搜索与修改；显式 argv 进程与管道；项目探测与脚本执行；提案评审式 Memory；会话；以及进程输出 Artifact。在此基础上，它还安装一层拦截策略，拒绝原生文件工具、强制 XuanLing 修改操作携带前置条件，并内置一份 Skill 指导 Agent 把 XuanLing 当作文件系统后端。

强制工作流：

1. 用 `fs_read_text` 读取既有 UTF-8 文本（需要完整正文时显式请求完整输出）；不需要理解正文时可用 `fs_hash` 取得指纹。
2. 传入当前的小写 64 字符 SHA-256：覆盖已有文件、`fs_replace_text`、`fs_edit` 以及 `fs_edit_batch` 中的每个文件使用 `expected_sha256`；`fs_patch` 使用 `expected_preimage_sha256`。
3. 编辑时保持 `include_diff=true`，并在继续前检查返回的差异（diff）。
4. 格式化器或任何外部写入方改动过文件后，先重新读取或取哈希，再执行下一次修改。
5. 把冲突、零匹配或多匹配、过期哈希视为停止并重读的信号。高风险编辑可传 `reversible: true`，评审后用 `change_commit` 提交，或在文件仍匹配时用 `change_rollback` 回滚。

只有 `mode=create` 的 `fs_write_text` 可以省略哈希，且仅用于预期不存在的新路径。拦截策略只校验前置条件是否存在且格式正确；路径、UTF-8、匹配与当前内容检查仍由 XuanLing 权威执行。

Memory、进程、项目与会话工具与 additive 变体一致。Memory 采用先提案流程，默认存储在本机 `~/.xuanling/memory.db`；召回在本地以词法方式完成。

## 安全边界与宿主限制

- 拦截策略会在原生工具执行前拒绝它们，但无法从 ZCode 的工具列表中隐藏这些名称。
- 不保证出现 ZCode 原生差异卡片；MCP 返回的差异数据仍可通过 `include_diff=true` 获取。由于原生 Read 被阻止，替换模式也不提供 ZCode 原生图片渲染。
- XuanLing 文件工具限定在当前项目目录内。这是路径能力，不是进程沙箱：你启动的进程仍可能访问其他路径，工具审批与 OS 级隔离仍由 ZCode 负责。
- 发布物来自不可变的 XuanLing 发布流水线：启动器选择匹配的平台原生包，并在执行前校验其 SHA-256。XuanLing 0.7.0 不带平台发布者证书签名；npm provenance、绑定源码的哈希与带证明的 marketplace 归档包可降低分发风险。
- ZCode 3.10.2 是本文工具名与限制的验证宿主。更新的 ZCode 版本可能改变宿主工具命名或呈现方式，请以当前工具目录为准。

## 链接

- [XuanLing ZCode marketplace](https://github.com/umbrella22/xuanling-zcode-marketplace)
- [XuanLing 源码仓库](https://github.com/umbrella22/xuanling)
- [MCP 集成指南](https://github.com/umbrella22/xuanling/blob/main/npm/packages/xuanling-mcp/README-ZH.md)
- [ZCode additive 变体](../xuanling-mcp/README-ZH.md)
- [MIT License](LICENSE)
