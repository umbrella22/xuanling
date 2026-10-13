# 玄灵蓝图

[English](README.md) · `@xuanling-rs/xuanling-dsh-blueprint`

在 DeepSeek Harness（DSH）中，把输入、智能体任务、人工决策和输出连接为可重复执行的工作流。
在画布上编辑流程，选择 DSH 已有的 Agent、Skill 和 MCP 工具，为每个智能体任务指定模型，
运行后查看各节点的结果。DSH 提供模型、原生会话和工具权限；蓝图提供画布、保存的定义、
资源快照和持久运行记录。

## 安装

把已发布包安装到与 DSH 浏览器页面相同的 profile：

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-blueprint@0.6.0
```

安装后重启该 profile，再刷新 DSH 页面。使用自定义 profile 时替换 `web`；新建的自定义
profile 不会自动包含 Web 应用。DSH 使用提供所需能力的最新官方频道。
TeamStage 还需要显式启用原生 Agent Teams profile，普通智能体任务不需要它。

## 两个入口

| 入口 | 用途 |
| --- | --- |
| 侧栏 **玄灵蓝图** | 创建和编辑图、选择资源、保存、检查、运行、查看结果。 |
| 原生对话中的 **蓝图** 视图 | 只读查看与该对话关联的冻结图和节点 Attempt。 |

普通对话显示“当前对话未关联蓝图，暂无实时蓝图可显示。”是正常空态。
从该对话中显式启动蓝图后，才会建立运行关联；侧栏启动的 Run 不会自动关联当前聊天。
连接离线或读取失败另有加载和失败状态。界面语言与明暗主题跟随 DSH 设置。

## 第一个工作流

先在 DSH 中配置可用模型。打开 **玄灵蓝图**，选择已有蓝图，或点击 **新建**并填写名称。
空蓝图库会自动打开新草稿。创建和保存蓝图都不会启动运行。

1. 从节点库把 **输入**、**智能体任务**和 **输出**拖到画布。
   双击空白画布也可打开节点搜索。
2. 逐个选择节点，在右侧 **检查器 / Inspector** 配置以下端口。
   移除不用的默认端口，修改后点击 **应用端口**。

   | 节点 | 输入端口 | 输出端口 |
   | --- | --- | --- |
   | 输入 | 无 | `request: string` |
   | 智能体任务 | `input: string` | `result: string` |
   | 输出 | `value: string` | 无 |

3. 连接 `输入.request → 智能体任务.input` 和 `智能体任务.result → 输出.value`。
   数据连线两端的类型必须一致。
4. 选中智能体任务，在 **Agent 绑定**中选择 DSH 已有的 Agent preset。
   选择器先列出 DSH 资源，再追加蓝图资源；按需选择 **技能绑定**和 **工具集绑定**。
5. 在 **模型路由**中保留 **DSH 默认**，或选择 **指定模型**，填写已配置的 Provider、
   模型和可选推理强度，再点击 **应用节点选项**。显式选择优先于默认值。
   每个新 Attempt 捕获自己的模型和资源，切换 DSH 默认模型不会改变已创建的 Attempt。
6. 点击 **保存**，展开 **持久运行**，填写合法的输入 JSON，例如：

   ```json
   {"request":"请把这段文字写成简短中文摘要：项目新增了可复用的代码审查工作流。"}
   ```

7. 打开 **更多操作 → 工具 → 检查并保存**，展开 **运行前检查**，处理全部 `block`。
   编辑图或修改输入后，旧检查会过期，需要重新检查。
8. 点击 **运行**，在 **持久运行**中展开节点 Attempt，查看输出、错误码和诊断。
   运行按钮也会先保存和检查。取得 Run ID 表示已接纳，`succeeded` 才是最终成功状态。

想先练习不调用模型的流程，可直接连接 `输入.request → 输出.value`，保留上述 string 端口
和输入 JSON；输出会保留所给文字。确认这条路径可运行后，再加入智能体任务。

没有声明工具集时，Agent 没有业务工具权限；选择的工具仍服从 DSH 拒绝和审批规则。
运行前检查不证明 MCP 已连通或已获得审批。纯文本任务可不选 **输出模式绑定**；
绑定 Schema 后，输出须通过 DSH 的结构化捕获验收，普通回复里的 JSON 不能代替它。

## 让原生 Agent 创建蓝图

在 DSH 根对话中，可直接要求 Agent 创建并保存完整流程：

```text
先调用 blueprint_describe 获取当前 schema 和 AgentTask 示例。
创建“输入 → 智能体任务 → 输出”的文本摘要蓝图，明确声明 Agent 资源并提供指令文件。
用 blueprint_validate 校验 definition 和 files，再用稳定的 requestId 调用
blueprint_create 保存。返回 blueprintId 和 documentRevision，先不要启动运行。
```

查看保存的图后，提供实际文本，再要求 Agent 对该版本调用 `blueprint_preflight`，
通过后只调用一次 `blueprint_start`。两个工具的 `input` 都是 JSON 值，
例如 `{"request":"待摘要的实际文本"}`。后续用 `blueprint_inspect` 查看结果；
打开或刷新视图不会再次运行。输入只供给已有节点，不会新增 Agent。

`blueprint_describe` 直接提供当前 schema 和创建示例，无需另行下载文档。
`blueprint_create` 会同时保存定义和声明的文本资源文件；画布中的资源表单只声明引用，
不会创建包内 Agent、Skill 或 Schema 的文件正文。

## 分享与迁移

在 **更多操作 → 文件**中导出或导入完整 ZIP：

- **导出 ZIP 包**先保存编辑，再打包声明的资源。自定义 DSH Agent preset、Skill 完整目录
  和 MCP 定义都会随包导出。只有已证明来自 DSH 官方内置的资源不导出正文，保留逻辑引用。
  来源未知也必须尝试物化；不能安全打包时，导出明确失败。
- 凭据和机器专属配置不进入包，转为目标环境的 `requiredBindings`。
  运行前配置目标模型、资源根和精确 MCP 工具；导入后再导出仍保留绑定要求。
- **导入 ZIP 包**需要已配置的空目标，目标 ID 与包内蓝图 ID 一致。
  导入不会覆盖非空目标、激活包内插件、连接 MCP，也不包含 Run 历史。

## 结果与排错

| 现象 | 操作 |
| --- | --- |
| 侧栏没有蓝图入口 | 确认当前 profile，重启后刷新页面。 |
| 对话未关联蓝图 | 正常空态；使用侧栏，或从该对话显式启动蓝图。 |
| 检查有 `block`、缺少资源或模型 | 查看运行前检查，补齐依赖后重新检查。 |
| 检查为 `stale` | 保存当前图和输入，再运行检查。 |
| `waiting_input` | 在侧栏的持久运行区选择 **批准**或 **拒绝**。 |
| 离线或读取失败 | 恢复连接，刷新或重连，查看已确认的持久运行事实。 |
| `recovery_required` | 保留 Run ID，由 Host 运维者核对外部效果后再决定后续运行。 |

**取消运行**发出取消请求，结果以持久状态为准。页面重载和查看不会重放模型或工具调用。
**删除蓝图**需要确认，保留既有 Run，也不会取消正在执行的 Run。

TeamStage 是可选能力，需要另行准备 `agentTask.teamStage` 定义、包内 Markdown Agent
资源、原生 Team 能力和来源 Lead 对话；画布分组不会创建 Team，成员使用独立的模型合同。
节点库支持输入、智能体任务、人工决策、条件、汇合（全部）和输出。
其他导入类型可能可读取但没有执行器，运行前检查会阻止执行；不提供旧格式降级导出。

更多安装配置见
[DSH 集成说明](https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/README-ZH.md)。
[代码审查定义](https://github.com/umbrella22/xuanling/blob/main/integrations/deepseek-harness/xuanling-blueprint/examples/code-review/blueprint.json)
可作为格式参考，使用前须准备资源文件和 Host 绑定。
