# @xuanling-rs/xuanling-dsh-blueprint

## 安装

0.5.0插件通过GitHub Release tarball分发。在运行所需能力最新官方频道的明确DSH profile中安装：

```sh
dsh plugin --profile web add https://github.com/umbrella22/xuanling/releases/download/xuanling-mcp-v0.5.0/xuanling-rs-xuanling-dsh-blueprint-0.5.0.tgz
```

安装后重启该profile。TeamStage还需要显式启用原生Agent Teams profile。
发行资产包含`blueprint.pack.json`，记录source commit与每个打包文件的SHA-256。
本发行版没有发布Blueprint的npm package名称。

[English](README.md)

DeepSeek Harness 蓝图插件：编辑 typed agent 图，结合持久运行状态、资源快照、人工审批、取消与恢复执行。

## 运行合同

每个蓝图由 `blueprint.json` 与 `lib/` 组成，后者保存 agent 指令、脚本和包内资源。
共享 Skill 使用配置根目录的逻辑引用，根目录可以指向项目或用户的 `.agents/skills`。
不要求软链，不提供用户版本锁定：每次新 Attempt 捕获所绑定共享 Skill 的最新完整目录，包括配套文件；同一 Attempt 及其恢复使用这些冻结字节。
Run 接纳时冻结图与包内资源，导出时物化声明的完整资源闭包，不修改共享 Skill。

React Flow（`@xyflow/react`）画布提供参考 ComfyUI 的图编辑交互：右键菜单、节点搜索、typed 连线、
剪贴板、展示分组、布局工具和撤销重做。DSH sidebar 将编辑连接到已配置定义、Host 校验、保存和 Run 检查。
执行仍遵循 DSH typed graph 与权限合同；插件不内嵌 ComfyUI，也不提供其模型/媒体工作流领域功能。

宿主通过 DSH 公共 registry 创建 scoped Agent，成功输出进入下游端口。
每次 Attempt 在创建 Agent 前捕获一次宿主当前默认模型，通过公共 Agent options 传递 provider、model 和可选 reasoning；新 Attempt 读取新选择。
宿主未提供默认模型服务时保留公共 request routing 扩展路径，不能从凭据猜模型，也不添加蓝图模型版本锁定。
scoped 工具调用、人工决策与取消遵循宿主策略和正式执行路径。
Run 在 storage domain 中记录命令接纳、Attempt 与终态，外部副作用不确定时进入 reconciliation，不能盲目重放。
JSON 与 SQLite 是分别验收的持久化目标。

### 运行接纳、工具与输出验收

**检查**先保存文档，再按其 `documentRevision` 与捕获的输入 JSON 请求只读 `preflightRun`。
报告列出 `block`、`warning`、`info`、`pass` 检查项；阻止项使新 Run 不可启动。
语义编辑、输入变化或切换蓝图会使报告失效，旧异步响应不能覆盖当前绑定。
**运行**沿保存 → preflight → start → inspect 执行；Host 仍独立重检接纳，报告不是执行授权 token。
缺 API 的 profile 明确返回 `blueprint/capability-unavailable`，不能静默跳过检查。
preflight 不保证 MCP 可达或最终 Host approval。

工具限制施加于真实 Agent scope，并由 monotonic guard 约束。
有效业务工具为 Host 当前可见工具与声明的 `toolsetRefs` 绑定 union、可选 `toolAllowlist` 的交集。
未声明 toolsets 表示无业务工具权限；节点不能扩大 Host deny/approval，Host 保留最终裁决权。
`run_code` 仅为 transport，不是业务授权；`structured_output` 仅在本 Attempt 的 schema attachment scope 可用，不能作为通用业务权限。

`outputSchemaRef` 使用 Run 冻结的包内 schema，复用 DSH 严格受支持的 object-root JSON Schema 子集；未知 keyword 和外部 `$ref` 拒绝。
仅 authoritative `structured_output` 工具结果可作为结构化捕获，assistant 文字中的 JSON 不构成验收。
通过 schema 的对象进入 JSON 端口，其 JSON 序列化进入 string 端口；结果与诊断以原子方式持久提交。
缺失或无效捕获使 Attempt 失败，不向下游提供无效输出；schema 通过不代表业务质量合格。

### 原生 TeamStage

TeamStage为可选能力，蓝图通过 `agentTask.teamStage`显式启用；普通`agentTask`继续使用scoped Agent路径。
当前graph最多一个TeamStage aggregate，一个stage对应一个原生Team task。
DSH Agent Teams profile需要显式启用，插件不会自动挂载；缺少Team能力或准确Lead身份时typed拒绝。

stage声明`task`、`members`与`requiredChecks`，每个成员引用agent资源并选择`fresh`或`fork` context；
节点还必须声明`outputSchemaRef`。成员共享原生task，使用DSH公共工具协作。
宿主在authoritative structured capture、required成员agreement、schema/digest、physical artifact provenance和
原生task completed全部验收后，原子结算原graph Attempt，并把输出送入原下游端口。

会话蓝图视图显示Lead、Run、task revision、成员状态和输出验收证据；原生成员会话通过持久Session ID定位同一Run/Attempt。
查看、切换和刷新均只读；输入、草稿、模型流与审批由DSH原生界面承担。
取消派生该stage绑定的完整成员集合，准确drain并以expected revision更新task。
外部副作用不确定时进入`recovery_required`；重启检查不会重新派发模型、工具或成员。

DSH运行时只支持提供所需能力的最新官方频道。每次升级与验收重新解析当前精确package/profile tuple，
允许破坏性DSH适配，不维护旧运行时兼容、shim、降级或旧profile迁移。
XuanLing自有RunRecord的legacy read和backup/restore合同继续有效。
当前真实外部验收覆盖macOS/native Edge/真实GLM单成员，另有真实安装runtime中的确定性
multi/fork/cancellation/direct/PTC与实际JSON/SQLite存储测试；其他平台、真实provider与真实多成员/fork需单独验收。

### 自动控制流

`condition` 配置为 `{inputPort,trueBranch,falseBranch}`：输入端口必须声明 `boolean`，两个分支必须不同且均已声明。
实际 boolean 自动选择唯一分支，不等待人工批准，不将字符串或 truthy 值强制转换；未选择路径跳过。
旧 condition 缺配置仍可读取，但 preflight 阻止新 Run。

`join` 省略策略时默认为 `all`，仅等待成功的已选择父节点并绑定其 data 输出，忽略 skipped 父节点的缺失输出。
无已选择父节点时 join 为 skipped，已选择路径失败不能算成功。
旧 `join=any` 定义仍可读取，但不能启动新 Run。

### 持久 Attempt 诊断

检查展示白名单事实：输入类型/字节数/SHA 摘要、资源 digest、本次捕获的 provider/model/reasoning、有效工具名、静态拒绝/验收 code 与恢复提示。
旧 record 无这些事实时明确显示 **unavailable**，不编造或推断。
新增诊断不包含 raw prompt、资源正文、工具参数、绝对 root 或 provider error；既有显式 `outputJson` 用户结果保持原语义。
digest 不等于输入内容或匿名化；检查与恢复提示不能隐式重放 Attempt。

## 原生语言与工作区

蓝图面板跟随 DSH **设置 → 通用设置 → 语言**（**Settings → General → Language**），支持中文（`zh`）与英文（`en`）。
DSH 保存语言偏好；没有可用的已注册偏好时，由宿主解析浏览器/系统语言。插件不提供独立语言选择器或偏好存储。
缺词沿宿主逐 key 的 fallback 链解析：`zh` 回退到 `en`，其他语言包声明最终到达 `en` 的回退链；宿主仍无法解析时显示 key 本身。

切换语言更新控件、无障碍标签、自动生成的节点标题与状态文案，不替换编辑器或 Inspector 输入缓冲。
蓝图名称、资源/Prompt 内容、输入输出 JSON 与 Agent 输出不被翻译，也不据此设置 Agent 执行语言。
ID、`kind` 值、资源引用、端口名和分支名原样保留。
视口、选择、撤销重做历史、未保存编辑和绑定的 Run 独立于展示语言；画布使用宿主明暗主题。

### 工具栏与面板

顶部图标按钮分为历史与保存、平移/选择、运行与工具三组。
每个图标保留 40×40 点击区和本地化无障碍名称；鼠标悬停或键盘聚焦时显示名称、快捷键及禁用原因。
已配置蓝图的选择器始终位于顶部。

宿主侧栏使用 DSH 自带的控制，蓝图节点库和 Inspector 持续显示在工作区中。
选择器、文本框、JSON 输入区和按钮使用 DSH 的字体、中性表面、边框和明暗主题；
表单采用 12px 圆角，紧凑按钮与图标采用 8px 圆角，运行按钮使用宿主主按钮样式。
悬停、按下、键盘焦点和禁用状态提供一致反馈；选择器继续支持原生键盘操作。

低频操作收在**更多**菜单中：

| 分组 | 操作 |
| --- | --- |
| 文件 | 导入 ZIP、导出 ZIP、导出不含 `lib/` 的旧格式 JSON |
| 视图 | 动效和 minimap 开关 |
| 工具 | 运行前检查、刷新已配置蓝图、快捷键帮助 |

在画布或对象上右键打开适用的操作。节点颜色收在**外观**子菜单，对齐与分布收在**布局**子菜单；
菜单项保留名称和快捷键提示。右方向键或 Enter 打开子菜单，左方向键或第一次 Escape 返回父项，
第二次 Escape 关闭菜单并恢复发起控件的焦点；Tab 或点击外部也可关闭。
固定/取消固定、折叠/展开的文案跟随当前选择；禁用操作仍遵循既有约束。

Inspector 中的**运行前检查**和**持久运行**默认折叠，点击或用键盘激活标题即可展开。
折叠摘要仍显示检查/Run 状态和警示，包括等待输入与恢复状态。
折叠保留输入 JSON、选择、绑定 Run、草稿、撤销历史和视口；取消图标位于顶部，不随运行区折叠。

### 节点目录与搜索

节点库可创建六类节点。搜索同时匹配中文和英文别名、当前语言的标题/描述以及稳定 `kind` 字符串，不受展示语言限制。
每项显示图标和可见节点名称，鼠标悬停或键盘聚焦时显示说明；搜索与添加继续使用同一目录。

| Kind | 英文标签 | 中文标签 |
| --- | --- | --- |
| `input` | Input | 输入 |
| `agentTask` | Agent task | 智能体任务 |
| `humanDecision` | Approval | 人工决策 |
| `condition` | Condition | 条件 |
| `join` | Join (all) | 汇合（全部） |
| `output` | Output | 输出 |

其他导入类型显示原始 kind 字符串；导入类型不等于增加执行器支持。搜索不重命名节点或引用。

### 画布交互与快捷键

工具栏可切换**平移**与**选择**模式：平移模式拖动空白画布，选择模式拖出框选区域。
Shift 也可启用框选，Ctrl/⌘ 将节点加入多选。两种模式均可按住 Space 或用鼠标中键拖动平移。
纵向滚轮缩放，横向滚轮平移，Ctrl 滚轮或捏合缩放；minimap 和缩放控件仍可使用。
React Flow 提供触控导航，实体触控设备行为需要单独验证。

在画布、节点、边或分组 header 上右键，可打开对应目标及当前选择的菜单。
菜单限制在工作区内；方向键、Home/End、Enter 选择命令，Escape 或点击外部关闭并恢复焦点。
缺少选择、成员 pinned、编辑锁或 Host 操作忙碌时，对应命令禁用。
快捷键仅在画布适用；文本框、原生控件与 IME 输入保留正常行为。

双击空白、画布聚焦时按 Tab，或使用画布菜单的搜索，在该位置添加节点。
拖线到空白处释放会打开兼容节点搜索，候选匹配已声明的数据类型、连线种类与方向；创建并连接合为一次撤销。
Escape 或关闭搜索不改变图。双击节点标题可重命名展示标题。
输入文字筛选结果，方向键与 Home/End 选择候选，Enter 添加。

| 快捷键 | 操作 |
| --- | --- |
| Ctrl/⌘ C、X、V | 复制、剪切、粘贴选择 |
| Ctrl/⌘ Shift V | 在同一蓝图内带入连线粘贴 |
| Alt 拖动节点或选择 | 预览克隆，提交为一次撤销 |
| Ctrl/⌘ A；Delete / Backspace | 选择全部节点；删除选中节点/边 |
| 方向键 | 将选中的未 pinned 节点移动 10 个图坐标单位 |
| Ctrl/⌘ Z；Ctrl/⌘ Shift Z 或 Y | 撤销；重做 |
| Ctrl/⌘ G | 为选中节点创建分组 |
| Tab；双击空白 | 打开节点搜索 |
| Space；鼠标中键拖动 | 临时平移；松开 Space 或失焦结束 |
| F 或 `.`；Shift F | 适配全图；适配选择 |
| P；C 或 Alt C | 切换 pinned；切换折叠 |
| H；V | 锁定图编辑与导入；解锁（仍可导航视口） |
| M 或 Alt Shift M | 切换 minimap |
| `+` / `=` / `-`；Alt `+` / `=` / `-` | 放大/缩小 |
| Ctrl/⌘ S；Ctrl/⌘ O | 保存；打开包导入 |
| Ctrl/⌘ Enter；Ctrl/⌘ Alt Enter | 沿接纳流程运行；取消绑定的 Run |
| R | 刷新已配置蓝图目录 |
| Escape | 取消活动手势或浮层；清除画布选择 |

**更多 → 工具 → 快捷键帮助**列出常用组合。重复 keydown 不会重复运行、剪切或其他一次性命令。
拖动、分组移动、缩放节点尺寸和转接点拖动在有效释放时仅提交一次；Escape、pointer cancel 或在工作区外释放取消预览，不增加历史。

### 剪贴板与连线编辑

复制、剪切、粘贴使用浏览器剪贴板 API。剪切只有在写入成功且编辑器、文档、选择仍匹配时才删除原选择。
取消、编辑或切换蓝图后，迟到的剪贴板结果不能修改新图。
接口不可用或权限拒绝会报告失败，不静默退化为丢失内容的复制。

片段包含选中节点声明、内部连线、展示信息及直接引用的资源声明；粘贴生成新的节点/分组 ID 并重映射端点。
片段不包含 `lib/` 字节、Run 输入/输出或诊断。引用的资源 ID 必须已在目标中存在且声明完全相同。
跨蓝图仅可复用相同的共享 Skill 或 MCP 声明；相同包内相对路径不代表同一资源。
无资源引用的节点可以跨蓝图复制。带入连线粘贴要求同一蓝图且原来源端口仍有效；普通粘贴仅使用内部连线。
无效片段或资源冲突保留原图与历史。

连线使用类型匹配的已声明 data 端口，或已声明 control handle/branch。节点或连线拖到画布边缘附近时自动平移视口。
拖动现有边的重接锚点可修改端点；开始重接时按住 Shift 可复制连线，保留原边及其转接点。
无效、重复或取消的重接不删除原连线，也不增加历史。
节点/边菜单的断开命令一次删除选中边或选中节点的关联边，支持一次撤销。

Alt 点击边或使用边菜单可添加展示转接点。拖动点调整可见路径；右键或 Delete/Backspace 删除聚焦点，方向键将点移动 10 个图坐标单位。
Escape 取消点拖动。转接点属于完整逻辑连线，不创建执行节点或悬空未连边。

### 结构化 Inspector 与高级 JSON

Inspector 可编辑输入输出端口及既有 `agentRef`、`skillRefs`、`toolsetRefs`、`outputSchemaRef` 绑定，
并表达可选 `toolAllowlist`、boolean condition 端口/分支与默认 all 的 join 策略；旧 `join=any` 显示为不可用。
高级 JSON 提供输入输出映射与既有节点选项，例如 `branches`、`budget`、`join`、`subflowRef`。
单字段编辑保留未修改字段；JSON 格式错误时保留输入和编辑器前值。
本地编辑反馈不代表 Host 校验通过；**保存**仍受 Host 的 strict schema 与文档 revision 检查约束。

只允许编辑既有 schema 字段。当前节点 schema 没有独立的节点 `name` 或 `prompt` 字段；蓝图级名称与资源中的指令/Prompt 保持为用户内容。
资源绑定是声明，不是执行连线；**可用性尚未检查**不证明 Skill 可读，也不证明 MCP 工具对 AgentTask 可达或获准使用。

### 节点展示、分组与布局

节点菜单可重命名展示标题、折叠详情/端口文案、固定位置与尺寸，并选择 default、blue、green、amber、red、purple 色调。
选中且可移动的节点显示 resize 控件，尺寸不能小于内容所需的最小空间。
折叠保留全部已声明 handle 及其布局占位。这些字段属于展示；重命名不创建 graph `name` 字段，也不修改节点 ID。
pinned 节点仍可选择、复制、删除，但不能移动或调整尺寸。

多选节点可创建可视分组。双击分组 header 重命名，拖动 header 移动成员，分组菜单可复制、适配视图或解除分组。
包含 pinned 成员的分组拖动整次拒绝。成员记录在 `presentation.groups`；空标题使用本地化展示标题，不保存翻译文案。
创建或解除分组不重定位、不重新 parent 成员；分组不改变执行顺序，不是 subflow 或 TeamStage。

节点菜单可将两个及以上可移动选中节点按边缘或横纵中心对齐，将三个及以上沿横轴或纵轴分布。
需要节点范围的命令使用实际测量尺寸。展示编辑与复合布局操作支持撤销重做、保存和重载。
节点标题/折叠/pinned/尺寸/颜色及边转接点改变文档/布局 revision，不改变执行语义。
转接点按 `(kind, from, to)` 保存，不依赖临时 editor edge ID。

### 视口偏好与工作流文件

每个已配置蓝图分别保存本地界面偏好：视口 `{x,y,zoom}`、平移/选择模式、minimap、动效与编辑锁。
切换蓝图或重载恢复保存的数值视口，不按显示的 CSS transform 舍入。
偏好记录缺失或无效时使用默认值并适配已加载图。
视口导航与界面偏好不将文档标为未保存、不写其草稿、不追加撤销历史。
旧文档的迟到回调不能覆盖另一蓝图的偏好，切走后再切回也受保护。
**保存**通过 Host 文档 revision 校验持久化 graph/presentation；本地视口偏好独立保存。

**导出蓝图包**下载 Host 的 portable ZIP，包含声明的资源闭包；未保存编辑先保存，过期文档结果拒绝。
**导出旧版定义**下载供旧 Reader 使用的定义 JSON，仅剥离新增节点展示字段和边转接点，保留坐标、分组、graph、resources 和 metadata。
该 JSON 不包含资源文件字节，不能代替 portable ZIP。

**导入蓝图包**通过原生文件选择器选择 ZIP，再选择已配置的空蓝图 ID，明确确认目标后应用。
目标与 archive 身份必须一致；导入不创建配置根、不覆盖非空包、不静默重绑共享 Skill。
Host 校验身份、archive 完整性与可移植性，UI 随后加载已接纳定义。
无效 archive 或非空目标拒绝。编辑锁定或工作区忙碌时，导入入口与应用禁用；关闭和 Escape 仍可用。

严格 `schemaVersion: 1` Reader 接受旧定义，并校验可选展示字段、有限正尺寸、已知颜色 token 及节点/边引用。
旧 Reader 会拒绝新增字段。回退插件前显式导出旧版定义并保留原包；兼容路径不静默丢弃保存文档中的字段。

### Run revision 与动效

Run 详情显示 `runId` 和 `definitionRevision`。
节点文案与动效使用同一 raw Attempt 投影：序号有效时最大 Attempt 序号优先，相同序号采用后出现的记录。
没有匹配 Attempt 时显示**未运行**；最新记录状态未知或该节点出现无效序号时显示**未知状态**。翻译文案不决定执行或运动。

只有绑定 Run 身份匹配、`definitionRevision` 等于保存的 `semanticRevision`，且编辑图仍具有已保存执行语义时，Attempt 状态才装饰画布。
语义不匹配时隐藏旧投影，Run 详情、输出和错误码仍可检查。
仅展示变更与切换语言保留上述匹配；重连检查已有持久 Run，不重放 start 或 decision 命令。

匹配的运行中 Run 为 preparing/running 节点提供仅改变 opacity 的强调。
有证明的边上，单光点沿实际渲染路径从 source 到 target 移动，包括展示转接点。
data 路径要求已声明端口类型匹配、来源 running/succeeded、目标 preparing/running。
control 路径要求来源 succeeded、目标处于活动状态；condition 分支还要求 Attempt 的真实 boolean `outputJson.value` 与匹配配置。
未知 condition 或人工决策分支保持静态。hover 或键盘 focus 高亮该节点与直接相连邻居，独立于动效开关。

文档隐藏、系统减少动态效果、用户关闭动效、连接 stale/disconnected、Run 语义不匹配以及未知/等待/终态 Run 均停止持续效果。
可用的 raw 状态与关联高亮仍静态显示。原生 CSS/SVG 动效不改变节点/handle 几何或图事实，不逐帧写编辑器或更新 React。

## 安装候选包

```sh
dsh plugin --profile <isolated-profile> add <candidate.tgz>
```

Cordis、Typert 和 Zod peers 由宿主提供。当前 checkout 以官方 `@deepseek-ai/dsh` 0.2.1-alpha.2、Node 24 为目标，不支持已废弃 alpha.1 activation、drain 或 mailbox API。
候选安装必须显式指定隔离 profile，不接触用户默认 profile。
打包、安装、web/headless 启停与重启分别需要当前产物证据，不能从一次安装成功外推。
此流程不包含 publish 或 push。

## 验证与证据

运行合同由
[`dsh-blueprint-runtime-contracts-v1`](../../../docs/plans/dsh-blueprint-runtime-contracts-development-plan.md)
及其[执行账本](../../../docs/plans/dsh-blueprint-runtime-contracts-execution-ledger.md)记录。
真实 provider、MCP、浏览器、持久化/重启与 packed lifecycle 必须分别取得当前产物证据；fixture 通过不代表最终集成验收完成。
已验收的平台证据仅限 macOS；Linux/Windows 在运行合同专项仍是未验收的 conditional 目标，不解除旧接管计划的跨平台 blocker。


接管验证 suite 使用 `dsh-blueprint-takeover-v1`。报告仅适用于记录的源码与构建产物指纹；相关变更需要新证据。

原生语言/工作区验收由独立的
[`dsh-blueprint-i18n-workspace-v1`](../../../docs/plans/dsh-blueprint-i18n-workspace-development-plan.md)
及其[执行账本](../../../docs/plans/dsh-blueprint-i18n-workspace-execution-ledger.md)记录。
该验收要求真实安装的 DSH Settings `zh`/`en` 切换、明暗界面检查、保存重载，以及未提交输入、视口、选择、历史和 Run 绑定的保留。
fixture 翻译函数、静态渲染或单独截图不能证明原生生命周期或状态保留；本范围的证据不代表接管计划的 provider 或平台门禁完成。

在插件目录运行：

```sh
npm run typecheck
npm run lint
npm run build
node --experimental-transform-types --test test/takeover/acceptance.test.mjs test/live/journey.test.mjs
node scripts/verify.mjs --plan-id dsh-blueprint-takeover-v1 --report-dir <fresh-evidence-dir> --suite critical --scope all --repeat 3
node scripts/verify.mjs --plan-id dsh-blueprint-takeover-v1 --report-dir <fresh-evidence-dir> --suite live
node scripts/verify.mjs --plan-id dsh-blueprint-takeover-v1 --report-dir <fresh-evidence-dir> --suite acceptance --evidence-manifest <explicit-manifest.json>
```

suite 包括 foundation、definition、resources、runtime、host、api、portability、security、recovery、critical、
browser、performance、platform、live 与 package。API/security/recovery/critical 最终证据使用 `--scope all`。
`red-oracles` 只校准 expected-red 分类，不是产品成功证据。

报告绑定 plan ID、源码与构建产物指纹，并检查运行前后稳定性。
acceptance manifest 显式列出报告路径与 SHA256，不扫描历史目录补齐缺项。
失败、过期、空结果、篡改、缩小 scope 或不足 repeat 的证据不能通过。

live suite 需要 `BP_LIVE_PROVIDER_KEY`、`BP_LIVE_PROVIDER_BASE_URL`、`BP_LIVE_PROVIDER_MODEL`，
可选 `BP_LIVE_PROVIDER_PROTOCOL`。它启动隔离 DSH 宿主，通过正式蓝图 Run 和 scoped Agent 调用真实模型，
验证下游节点收到实际 nonce 输出。仅 import、替身 provider、hostProbe 都不能满足此门禁。
缺少配置产生 typed `not-run`，报告 `passed=false`，退出非零。
凭据只通过内存/环境注入，不进入 patch、报告或截图；provider/协议能否使用必须由真实 Run 确认。

CI 验证确定性门禁并记录当前 runner 的真实 OS。keyless live 检查只接受精确的配置缺失 `not-run` 报告，
普通失败不能被非零退出掩盖。所有 fresh CI 报告均上传。
CI job 成功不代表真实 provider、安装生命周期、交互浏览器或三平台验收通过。

## 执行与交互边界

显式 `agentTask.teamStage` 通过可选 DSH 原生 Team profile 执行，将原 Attempt 绑定 source Lead、一个 native task 与声明成员。
成功要求本次 completed turn、authoritative structured capture、不可变 artifact 与原子 acceptance；成员 `inactive`、任务 `completed` 单独不能结算成功。
取消只 drain 精确 owned child；未知效果进入 `recovery_required`。writeScopes 是冲突提示，嵌套 Team 不受支持。
真实 provider 与浏览器验收分别记录，确定性 model fixture 不能替代。

Blueprint 不提供缺省 stage、Agent 或 script 总 deadline。DSH provider 的 request/stream idle、Tools signal 和 Team disposal 配置分别控制对应操作。
显式宿主 deadline 保留 typed diagnostic；collector 的观察超时不会改变 Run 状态。
可执行 `toolCall`、`scriptCall`、`subflow`、`iteration`、`join-any` 节点、ODAI 治理、Rust/ZCode 集成与发布仍 deferred。
导入的 unsupported 节点可读取，但新 Run 的 preflight 以 `node-executor-unavailable` 阻止。

画布提供图编辑、展示与只读 Run 状态。
ComfyUI 模型/媒体/mask/gallery、widget 转输入、执行 bypass/mute、Run Branch 与 subgraph 转换需要独立领域或执行合同，本交互不提供这些能力。

浏览器交互和动效证据不证明 provider 输出、MCP 策略、packed web/headless 生命周期或持久化/恢复行为；这些运行合同需要独立证据。
平台证据仅限 macOS；Linux/Windows、实体触控设备与系统剪贴板集成需要各自验证。
浏览器剪贴板仍受权限与 secure context 限制。缺运行依赖或凭据保持 `not-run`，画布功能不等于插件整体验收完成。
