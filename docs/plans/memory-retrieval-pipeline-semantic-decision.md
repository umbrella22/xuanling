# Memory Retrieval Semantic Trigger 决策

> 结论：`not_triggered`。
> 证据日期：2026-08-16。
> 证据 revision：`48182b1b316f22831235cb75129a2fb430b9b39e` 加执行账本记录的
> 未提交 Memory Retrieval change set。
> 决策合同：[RFC 0003](../adr/0003-memory-retrieval-pipeline-rfc.md)。
> 执行证据：[Memory Retrieval Pipeline 执行账本](memory-retrieval-pipeline-execution-ledger.md)。

## 决策

当前词法检索已经通过冻结 corpus、恢复/并发/性能、release MCP 和三个真实 DSH session 的
验收。RFC 0003 要求 semantic/paraphrase slice 至少出现 3 条 critical top-5 miss，才继续评估
真实 embedder。当前用于 semantic-equivalent 检查的 `english_multi_term` slice 有 8 条 critical
query，top-5 miss 为 0，因此 semantic trigger 未成立。

本结论不下载模型，不选择 embedding runtime，不接受资源预算，也不改变默认构建、Memory schema、
MCP catalog 或 Skill。`memory_search` 继续只执行确定性词法检索。

## Trigger 证据

| 条件 | 结果 | 当前证据 | 决策影响 |
| --- | --- | --- | --- |
| 1. scope/visibility、QueryPlan 与 deterministic rerank 全部通过 | `satisfied` | 40-query after report 的 aggregate 与 critical Recall@5 均为 1.0，visibility violation 为 0；恢复、并发和三轮性能 gate 已通过 | 允许评估第二项 |
| 2. semantic/paraphrase slice 至少 3 条 critical top-5 miss | `not_satisfied` | `english_multi_term` 8 条 query 的 Recall@1、Recall@5、MRR@5、nDCG@5 均为 1.0；critical top-5 miss 为 0 | 直接确定 `not_triggered` |
| 3. 固定离线 embedder 使 aggregate Recall@5 提升至少 0.05 | `not_evaluated_not_required` | 第二项未满足；当前 aggregate Recall@5 已为 1.0 | 不下载实验模型，不把缺少模型实验记为 blocker |
| 4. 模型资源数据完整且用户接受预算 | `not_evaluated_not_required` | 没有被触发的模型候选或安装动作 | 不请求资源授权，不定义生产预算 |
| 5. 来源、license、checksum、平台和删除/升级路径确定 | `not_evaluated_not_required` | 没有被触发的模型候选 | 不创建模型交付合同 |

五项条件是合取关系。第二项为 false 后，第三至第五项不构成缺失证据，也不能把结论升级为
`blocked_unresolved` 或 `followup_required`。

## 证据摘要

- Frozen corpus：`retrieval-corpus-v1`，SHA-256
  `70b15f5ef901a29fa8a66a0c3d2b2705d6c1f860f91bd2dce153ef9c8338968d`；48 active、
  12 non-searchable distractor、40 query。
- After report：SHA-256
  `e99c1c3301def8fd8ea95f32565d7d58d6b1a2490a398e44a6a5d4566667da8d`；aggregate
  Recall@1/5、MRR@5、nDCG@5 与 critical Recall@5 均为 1.0；4 条 no-match 均为空；搜索前后
  canonical table counts 相同。
- Performance：10k visible active 加 20k invisible distractor 的最终三轮测量中，after p95 为
  32.960-33.348 ms，低于同轮 baseline 的 2 倍；rebuild、RSS 和 startup gate 全部通过。
- Live：DeepSeek-V4-Pro、reasoning effort `max` 的三个独立 DSH session 都只调用 `skill` 与
  `memory_search`，固定重排查询 `results independently filesystem verification` 将 `r-en-01`
  排在第 1；三个 trial 的 canonical/projection 快照均未变化。
- Public surface：release verifier 保持 42 个工具、Memory contract v2 和既有 `memory_search`
  schema；默认 catalog 没有 semantic、embed 或 hybrid 工具。

## 适用边界

`not_triggered` 只绑定当前 revision、`retrieval-corpus-v1`、当前标签和已记录的三个 DSH session。
它不形成通用自然语言召回 SLA，也不证明所有项目都不需要向量能力。现有 corpus 的
`english_multi_term` 是本轮计划冻结的 semantic-equivalent slice，不是覆盖开放域同义改写的
完整 benchmark。

以下任一变化要求创建新版本 corpus 并重新运行 RFC 0003 trigger：

- 新的真实失败样本形成至少 3 条 critical semantic/paraphrase top-5 miss；
- namespace、scope、applicability 或 QueryPlan 行为变化使当前报告 stale；
- `memory_search` DTO、projection schema、MCP catalog 或默认依赖边界变化；
- corpus 标签、metric 算法或 relevant record 集合变化。

只有重新评测满足第二项后，才选择固定版本的离线 embedder，并为模型来源、checksum、license、
磁盘、冷启动、query latency、rebuild、RSS、取消/恢复和删除/升级另立实施计划。

## 复算入口

```sh
cargo test -p xuanling-memory --test retrieval_eval \
  after_report_meets_thresholds_and_is_byte_identical_across_three_runs -- --exact --nocapture
cargo test -p xuanling-mcp --test protocol default_catalog_has_no_semantic_tool
node npm/scripts/verify-mcp-contract.mjs --binary target/release/xuanling-mcp
node test/deepseek-harness/evaluation/memory-retrieval/verify-transcripts.mjs \
  --root /private/tmp/xuanling-dsh-memory-eval.memory-retrieval-live-w5-1 --trials 3
```

最后一条命令依赖当前机器保留的 W5 evidence root；执行账本保存 session ID、usage、canonical
digest 和边界指纹，作为 evidence root 被清理后的 durable handoff。
