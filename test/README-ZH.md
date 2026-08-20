# XuanLing 测试资产

[English](README.md) | 简体中文

本目录只包含仓库内合同 fixture 与发布验证资产。Integration bundle 和
`xuanling-mcp` npm package 在运行时不会导入本目录。

## 保留的测试

| 路径 | 用途 |
| --- | --- |
| `deepseek-harness/scripts/verify-deepseek-bridge.mjs` | 使用已构建的 XuanLing binary 验证 stdio bridge、隔离 workspace、隔离 Memory database 和指定工具 profile。 |
| `host-integration/fixtures/result-projection` | 固定的 ZCode 与 DSH 结果投影输入。 |
| `host-integration/fixtures/result-cost` | wire、模型可见文本、structured、UI 与 provider usage 分层计量的封闭 fixture。 |
| `host-integration/fixtures/skill-routing` | DSH 与 ZCode 共用的 Skill 路由用例。 |
| `host-integration/verify-*.mjs` | 当前宿主效率计划使用的投影、成本、路由和真实 binary 确定性 verifier。 |
| `release` | 仓库 promotion 与不可变发布 fixture。 |

历史 filesystem A/B/C evaluation、独立 Memory retrieval evaluation、宿主 dogfooding workspace、
database snapshot、报告及其 live-only overlay 已在对应验收 Wave 关闭后移除。其结论保留在相关
ADR 与执行账本中，不再作为当前回归门禁。

## 确定性门禁

运行完整 Node 合同测试：

```sh
npm --prefix npm test
```

使用已构建 binary 验证 DSH bridge。Verifier 会创建临时 workspace 与 database，并在结束后清理：

```sh
node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp

node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp \
  --tool-profile memory
```

npm tests 同时调用 host-integration verifier。其 fixture 保持静态，行为变化必须显式审核 fixture。
