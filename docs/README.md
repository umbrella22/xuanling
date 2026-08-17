# XuanLing 文档索引

本目录只描述当前 detached workspace(本仓库)的边界、决策与集成合同。2026-08-14 之前
从上游 monorepo 复制来的 99 个废弃文档已整体移除,逐文件 SHA-256 清单见
[plans/memory-v2-extraction-w01-removal-manifest.txt](plans/memory-v2-extraction-w01-removal-manifest.txt)。

## 当前文档集

| 路径 | 内容 |
| --- | --- |
| [repository-boundary.md](repository-boundary.md) | 仓库边界与出处:本仓库是什么、不是什么。 |
| [adr/0001-memory-v2-proposal-review.md](adr/0001-memory-v2-proposal-review.md) | Memory v2 决策:proposal/review、不可变版本、scope、JSONL 维护合同。 |
| [adr/0002-filesystem-tool-safety-and-efficiency-rfc.md](adr/0002-filesystem-tool-safety-and-efficiency-rfc.md) | Proposed RFC:文件 overwrite 前置条件、多 hunk 修改与输出效率边界。 |
| [adr/0003-memory-retrieval-pipeline-rfc.md](adr/0003-memory-retrieval-pipeline-rfc.md) | Accepted：Memory 词法检索已实现，Semantic trigger 未触发。 |
| [architecture/memory-v2-architecture.md](architecture/memory-v2-architecture.md) | Memory v2 当前架构（schema、流程、检索、故障语义）。 |
| [guides/xuanling-mcp-integration.md](guides/xuanling-mcp-integration.md) | MCP host 集成指南:CLI、capability、结果映射、工具目录。 |
| [plans/README.md](plans/README.md) | 实施计划与执行账本索引。 |
| [plans/memory-retrieval-pipeline-semantic-decision.md](plans/memory-retrieval-pipeline-semantic-decision.md) | Memory Retrieval semantic trigger 的证据与 `not_triggered` 结论。 |

## 维护规则

- 文档只描述当前 checkout 可验证的事实,或明确标注状态的目标合同(ADR/architecture)。
- 不引入上游 monorepo 的阶段、checklist、review 文档;历史出处统一记录在
  [repository-boundary.md](repository-boundary.md)。
- 链接、占位符与 legacy 引用由 `npm --prefix npm run check:docs` 校验。
