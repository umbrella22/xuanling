# xuanling-dsh-tools

[English](README.md) | 简体中文

**完整 XuanLing MCP catalog 的增量式 DeepSeek Harness bundle：在 DSH 原生工具
之外增加全部 43 个带类型工具。** Package：
`@xuanling-rs/xuanling-dsh-tools@0.6.1`。

## 这是什么

以 `mcp__xuanling__` 前缀提供完整 catalog，同时保留全部 Harness 原生工具：

- **Core（3）：** `system_info`、`path_resolve`、`path_relative`。
- **Filesystem（17）：** `fs_stat`、`fs_list`、`fs_read_text`、
  `fs_read_bytes`、`fs_search`、`fs_glob`、`fs_hash`、`fs_mkdir`、
  `fs_write_text`、`fs_replace_text`、`fs_patch`、`fs_edit_preview`、
  `fs_edit`、`fs_edit_batch`、`fs_copy`、`fs_move`、`fs_remove`。
- **Process and project（5）：** `process_run`、`process_which`、
  `project_detect`、`project_command`、`project_run`。
- **Memory v2（9）与 Advanced（9）：** 完整 Memory 生命周期，以及 artifact、
  ChangeSet、pipeline 和 session。

Server 使用默认的 `all` catalog；本 bundle 没有更小的 profile 开关。

## 为什么用它

- **适合**：需要 XuanLing 文件系统族、直接进程执行、项目探测/执行、artifact、
  ChangeSet、pipeline 或 session。
- **只需要 Memory**：改用 `xuanling-dsh-memory`，那是更精简的推荐日常配置。
- **只想要原生命名下的 XuanLing 文件语义**：改用
  `xuanling-dsh-tools-replace`。
- 每个 profile 只装一个 XuanLing runtime bundle；详见
  [bundle 指南](../README-ZH.md)。

## 环境要求

- 已安装 DSH，并使用内置的 `web` 或 `headless` profile。
- Node.js 22.14 或更高版本。
- DSH 在 `0.2.1-rc.2` 能力频道上提供 `@deepseek-ai/dsh-mcp-client`。
- 在启动 DSH 的环境中把 `XUANLING_WORKSPACE_ROOT` 设为已确认的绝对 workspace
  路径；缺失时启动失败。
- macOS ARM64、glibc 2.35+ 的 Linux x64，或带 MSVC runtime 的 Windows x64。

## 安装

```sh
export XUANLING_WORKSPACE_ROOT=/absolute/path/to/project
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-tools@0.6.1
dsh --profile web --dump-config
```

请让启动 DSH 的每个进程都能看到该变量。内置 headless profile 使用
`--profile headless`；自定义的新 profile 名称只会从 base bundle 起步。该命令会
把 `@xuanling-rs/xuanling-mcp@0.6.1` 装进 profile；不需要全局 package 或 `npx`。

## 快速开始

1. 重启该 profile，然后刷新 DSH。
2. 让模型检索 `mcp_catalog__xuanling` 中的 `system_info` 并激活它；调用
   `mcp__xuanling__system_info`，确认 `xuanling_version` 为 `0.6.1`。
3. 再激活一个文件系统工具，例如 `fs_stat`，读取 `XUANLING_WORKSPACE_ROOT` 内的
   路径。根目录之外的路径会被有意拒绝。

## 配置

- `XUANLING_WORKSPACE_ROOT` 必填且必须是绝对路径，是文件系统 capability root；
  DSH 进程工作目录永远不是授权来源。
- Memory 族使用共享默认库 `~/.xuanling/memory.db`，在第一次有效 Memory 调用时
  才延迟打开。
- 模型起初只能看到 `mcp_catalog__xuanling`。检索它，每次调用只激活一个精确
  raw name，下一次请求才会出现对应工具；不要预先激活整个 catalog。
- 单次工具调用预算 120 秒。长构建和 watch 进程应交给 Harness 后台 job。
- 进程工具以显式 program + argv 运行且不经过 shell，默认使用最小环境
  （`inherit_env: false`）。
- server name 固定为 `xuanling`；模型可见工具名是 `mcp__xuanling__*`。

## 限制与安全边界

- **能力重叠确实存在。** 原生工具与 XuanLing 工具在文件、进程和项目操作上高度
  重叠；每次操作要有意识地选一族。
- **文件系统受限。** XuanLing 文件系统工具在 `XUANLING_WORKSPACE_ROOT` 下执行
  pathname capability；越界路径会被拒绝。
- **进程执行不是沙箱。** 不可信代码仍需宿主审批和 OS sandbox；默认使用最小
  环境。
- **共享存储。** `~/.xuanling/memory.db` 与其他 XuanLing 部署共享；不要在其中
  保存 secret 或用户私密内容。
- **Lazy 激活有成本。** 每个新工具都要多一步激活和一轮模型请求，激活集合不会跨
  重启保留。
- **平台限制。** 不支持的 OS、CPU 或 libc 组合会由 launcher 明确报错。

## 排错

- **启动因缺少 `XUANLING_WORKSPACE_ROOT` 失败。** 在 DSH 进程的环境中 export
  已确认的绝对路径后重启。
- **只看到 `mcp_catalog__xuanling`。** 正常。检索并激活精确 raw name；激活时
  不要带 `mcp__xuanling__` 前缀。
- **工具调用触到 120 秒预算。** 把长任务移到 Harness 后台 job，再用后续调用
  继续。
- **`inherit_env: false` 下找不到程序。** 只有明确可接受继承登录环境时才用
  `inherit_env: true` 重试。
- **launcher 或版本不一致。** 重装精确的 `0.6.1` 版本；不要在同一个 profile 内
  混用版本，并移除其他 XuanLing runtime bundle。

## 链接

- [XuanLing for DeepSeek Harness：bundle 指南与运行配置](../README-ZH.md)
- [XuanLing Blueprint：可视化工作流编辑器与可持久运行](../xuanling-blueprint/README-ZH.md)
- [XuanLing MCP server 项目](../../../README-ZH.md)
- [npm package](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-tools)
- [Issues](https://github.com/umbrella22/xuanling/issues)
