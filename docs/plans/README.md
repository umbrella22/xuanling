# 实施计划索引

| 条目 | 内容 |
| --- | --- |
| [memory-v2-extraction-development-plan.md](memory-v2-extraction-development-plan.md) | Memory v2 抽离与重构实施计划(W0-W9，含 MCP dogfooding、真实默认 DB 隔离与重新授权 gate)。 |
| [memory-v2-extraction-execution-ledger.md](memory-v2-extraction-execution-ledger.md) | 执行账本:中断后的 canonical handoff。 |
| [memory-v2-extraction-w01-removal-manifest.txt](memory-v2-extraction-w01-removal-manifest.txt) | W0.1 删除的 99 个上游文档逐文件 SHA-256 清单。 |
| [deepseek-harness-skills-filesystem-evaluation-development-plan.md](deepseek-harness-skills-filesystem-evaluation-development-plan.md) | DSH 专用 Skills、文件工具 A/B/C、真实模型/cache/直接探针与 Web 试用实施计划。 |
| [deepseek-harness-skills-filesystem-evaluation-execution-ledger.md](deepseek-harness-skills-filesystem-evaluation-execution-ledger.md) | DSH Skills 与文件工具评估的 canonical 执行账本。 |
| [filesystem-safety-stage1-development-plan.md](filesystem-safety-stage1-development-plan.md) | RFC 0002 Stage 1：DSH strict overwrite policy 实施计划。 |
| [filesystem-safety-stage1-execution-ledger.md](filesystem-safety-stage1-execution-ledger.md) | RFC 0002 Stage 1 的中断恢复账本。 |
| [filesystem-safety-rfc-completion-development-plan.md](filesystem-safety-rfc-completion-development-plan.md) | RFC 0002 Stage 2 current-policy 证据刷新与 Stage 3 条件决策计划。 |
| [filesystem-safety-rfc-completion-execution-ledger.md](filesystem-safety-rfc-completion-execution-ledger.md) | RFC 0002 完成计划的 canonical 执行账本。 |
| [memory-retrieval-pipeline-development-plan.md](memory-retrieval-pipeline-development-plan.md) | RFC 0003：Memory 词法召回质量、可见候选、重排、真实验收与向量触发决策实施计划。 |
| [memory-retrieval-pipeline-execution-ledger.md](memory-retrieval-pipeline-execution-ledger.md) | RFC 0003 实施的 canonical 中断恢复账本。 |
| [memory-retrieval-pipeline-semantic-decision.md](memory-retrieval-pipeline-semantic-decision.md) | RFC 0003 semantic trigger 的五项证据与 `not_triggered` 决策。 |
| [host-local-integration-distribution-development-plan.md](host-local-integration-distribution-development-plan.md) | DSH profile-local npm packages、单一跨平台 ZCode marketplace、release trust/provenance/attestation 与跨仓库 promotion 实施计划。 |
| [host-local-integration-distribution-execution-ledger.md](host-local-integration-distribution-execution-ledger.md) | Host 本地集成与分发计划的 canonical 中断恢复账本。 |
| [host-result-projection-agent-efficiency-development-plan.md](host-result-projection-agent-efficiency-development-plan.md) | `0.2.4` ZCode/DSH 结果投影、Agent 工具路由、L1/L2 Memory 读取策略、成本测量与发布验收实施计划。 |
| [host-result-projection-agent-efficiency-execution-ledger.md](host-result-projection-agent-efficiency-execution-ledger.md) | 宿主结果投影与 Agent 使用效率优化的 canonical 中断恢复账本。 |

## 恢复顺序

按仓库根 `AGENTS.md` 的长任务协议:重读指令/计划/账本 → `git status --short` 与
`git rev-parse HEAD` → 校验 checkout fingerprint → 定位首个未 complete 的 Wave 与
work package → 只执行账本 `next_action` → 定向 gate → 更新账本。
