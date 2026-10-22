# xuanling-dsh-skills

[English](README.md) | 简体中文

**为 DeepSeek Harness 提供三个按需 XuanLing 工作流 Skill 和严格 XuanLing
overwrite policy。** 不注册 MCP server，也不带 binary。Package：
`@xuanling-rs/xuanling-dsh-skills@0.7.0`。

## 这是什么

为 DSH profile 增加工作流指引和宿主护栏：

- `xuanling-memory-workflow`：把项目局部事实写入 DSH 文件 Memory（L1），把共享
  事实写入 XuanLing Memory（L2），只激活下一步所需的 Memory 操作，并保持
  proposal/review 边界清晰。
- `xuanling-file-workflow`：在 Harness 原生工具与 XuanLing 文件系统族之间路由：
  SHA-256/CAS 守卫、严格 patch、原子 `fs_edit_batch`、有界输出、分页和确定性
  重复验证。
- `xuanling-blueprint-migrate`：协助升级已保存的蓝图包，检查备份、执行语义、完整
  资源、格式校验和目标环境绑定，保留原始蓝图与 Run 历史。
- 一个宿主 policy：拒绝缺少 `expected_sha256` 的既有文件覆盖，并在 XuanLing
  Memory review 前要求一次性的 DSH 用户审批。

## 为什么用它

- **适合**：已经运行 XuanLing runtime bundle，希望模型有章法地路由文件与 Memory
  操作，并获得宿主护栏。
- **不要单独安装。** 它不增加工具，必须搭配恰好一个 runtime bundle（Memory、
  完整 tools 或 replacement）。preset 选择与取舍见
  [bundle 指南](../README-ZH.md)。
- 它的 policy 负责在 DSH 边界落实 Memory review 确认和覆盖前取 hash 的规则。

## 环境要求

- 已安装 DSH，并使用内置的 `web` 或 `headless` profile。
- Node.js 22.14 或更高版本。
- DSH 在 `0.2.1-rc.2` 能力频道上提供 `@deepseek-ai/dsh-skill-filesystem`。
- 同一 profile 中恰好一个 XuanLing runtime bundle。

## 安装

与选定的 runtime bundle 一起安装：

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-memory@0.7.0 \
  @xuanling-rs/xuanling-dsh-skills@0.7.0
```

完整 catalog 版本把 `xuanling-dsh-memory` 换成 `xuanling-dsh-tools@0.7.0`。
内置 headless profile 使用 `--profile headless`；自定义的新 profile 名称只会从
base bundle 起步。不需要全局 package。

## 快速开始

1. 确认只有一个 runtime row 和一个 `xuanling-skills` provider，然后重启：

   ```sh
   dsh plugin --profile web list
   dsh --profile web --dump-config
   ```

2. 让模型加载 `xuanling-memory-workflow`（Memory bundle）、
   `xuanling-file-workflow`（完整 tools bundle）或 `xuanling-blueprint-migrate`
   （蓝图升级，见下文）。这些 Skill 都按需加载，不会注入每一轮请求。

3. 验证一条护栏：使用完整 tools bundle 时，通过
   `mcp__xuanling__fs_write_text` 对既有文件做不带 `expected_sha256` 的覆盖，
   应在 dispatch 前被拒绝并返回
   `[XUANLING_FS_OVERWRITE_REQUIRES_SHA256]`。

## 升级蓝图定义

[蓝图迁移 Skill](skills/xuanling-blueprint-migrate/SKILL.md) 随 `0.7.0` 发布，旧版
`0.6.1` 包不包含它。把 skills bundle 安装到运行目标 Blueprint 版本的 profile，
然后重启该 profile：

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-skills@0.7.0
```

在 DSH 对话中可以这样使用：

```text
加载 xuanling-blueprint-migrate，把 <原始蓝图包路径> 中的 Rust review 蓝图升级到
当前 profile 的 Blueprint 格式。在 <目标工作区> 保存独立副本，保留原件和 Run 历史，
校验资源与代表性输入，给出差异、缺失绑定和回退路径，先不要启动 Run。
```

Skill 使用目标 Blueprint 插件提供的创建、校验工具和已有文件工具；skills bundle 自身
不增加这些能力。它覆盖 v1 → v2 和旧 profile 存储布局，不向运行时加入自动迁移。
已移除的执行语义需要明确重设计，不能统一靠修改版本号解决。保存成功、运行前检查和
真实运行结果会分别报告。其他支持文件系统 Skill 的 agent 可安装完整的
`xuanling-blueprint-migrate/` 目录（包括 `references/`），再用
`$xuanling-blueprint-migrate` 调用。

## 配置

- 正常使用不需要环境变量。`XUANLING_DSH_SKILLS_ROOT` 只是 Skill 内容根目录的
  开发用覆盖项。
- Skill 内容是静态的，文件监听已关闭；更新需要重装。
- policy 没有开关，只检查两个公开工具名：`mcp__xuanling__fs_write_text`（拒绝
  不安全覆盖）和 `mcp__xuanling__memory_review`（要求一次性审批），其余调用
  原样放行。
- create mode 和携带 hash 的覆盖会原样进入 MCP server，由 server 负责 schema
  校验、CAS 和实际写入。

## 限制与安全边界

- 没有 MCP 工具、binary、workspace 或数据库；单独安装不改变任何能力。
- policy 是宿主前置条件，不是安全边界：不替代 canonical 校验、文件系统 path
  capability、CAS 或宿主审批系统。
- review 门强制一次 DSH 内的用户决定；server 侧 `reviewer_id` 仍由调用方自报。
- SHA-256 只证明完整性和并发版本一致，不证明编辑语义；接受 XuanLing 编辑前
  仍应查看返回的 diff。
- Memory review 只有在一次性审批通过后才执行；拒绝、取消或审批通道不可用都会
  按设计 fail closed。

## 排错

- **Skill 没有出现。** 重启 profile，确认 `--dump-config` 中有
  `xuanling-skills` provider，并重装精确的 `0.7.0` 版本。
- **overwrite 护栏不触发。** 检查精确的公开工具名；replacement bundle 暴露的是
  `write`，因此该护栏在那里不适用。
- **覆盖被拒绝。** 用 `fs_read_text` 加 `include_sha256: true` 读取，或取
  `fs_hash`，然后用返回的 hash 重试。
- **Memory review 被拦截。** 审批通道不可用或审批未通过；请在交互环境中
  重试，审批失败时按设计 fail closed。

## 链接

- [XuanLing for DeepSeek Harness：bundle 指南与运行配置](../README-ZH.md)
- [XuanLing Blueprint：可视化工作流编辑器与可持久运行](../xuanling-blueprint/README-ZH.md)
- [XuanLing MCP server 项目](../../../README-ZH.md)
- [npm package](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-skills)
- [Issues](https://github.com/umbrella22/xuanling/issues)
