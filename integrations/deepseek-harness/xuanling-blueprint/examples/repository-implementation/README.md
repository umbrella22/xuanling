# 仓库实施模板（严格交付合同）

这个目录不是可直接运行的蓝图，而是一份**实施节点的输出合同**。它解决的是
BP-02：调度成功（Attempt/Run `succeeded`）不等于业务交付成功。宽泛的
`{text: string}` schema 会让 `{"text":"placeholder"}` 通过验收。

## 合同

`lib/schemas/implementation-report.json` 要求：

- `outcome`：`delivered` / `blocked` / `partial`，必填；
- `checkout`：被验证的 checkout 标识，必填；
- `commands`：每条命令与实际退出码，必填（可为空数组，但字段必须存在）；
- `receipts`：可复核的收据引用，必填；
- `blockers`：阻塞原因，必填（交付时为空数组）；
- `artifacts`、`summary`：可选；
- 所有对象 `additionalProperties: false`，多余字段会被拒绝。

占位符 `{"text":"placeholder"}`、缺少收据或退出码的输出都会在
`structured_output` 捕获阶段被拒绝，Attempt 进入 `output-invalid`，不会以
“成功但没交付”结束。

## 接线

1. 把 schema 作为蓝图资源：`{ "implementationReport": { "kind": "schema", "path": "lib/schemas/implementation-report.json" } }`。
2. 实施节点声明：`outputSchemaRef: "implementationReport"`、`outputs: { "report": "json" }`、
   `toolsetRefs: [...]`、`requiredCapabilities: ["repository-read", "command-exec"]`。
3. 运行前检查会阻止“声明了能力但没有解析到任何业务工具”的节点
   （`required-capability-unbound`）。已绑定工具是否真的能读写仓库仍是
   `capability-coverage-unverified`，需要人工确认。

## 交付门禁

schema 只能约束**结构**，不能判断 `outcome: "delivered"` 是否真实。要让
`blocked` 不进入交付，请在实施节点后接一个 `humanDecision`（或由运行输入提供
布尔条件）再进入输出节点；当前插件没有“从结构化报告字段提取布尔值”的图元，
因此不能仅靠 schema 自动分支。运行报告会同时显示调度状态与每步
`acceptance`，便于区分“已调度”和“已验收”。
