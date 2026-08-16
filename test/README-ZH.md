# XuanLing 测试资产

[English](README.md) | 简体中文

该目录保存仅供仓库验收使用的 fixture、probe、evaluation overlay 与报告。安装 integration
bundle 或 `xuanling-mcp` npm package 时不需要这些文件。

## DeepSeek Harness

`deepseek-harness` 验证
[`integrations/deepseek-harness`](../integrations/deepseek-harness/) 发布的 Host 专用 bundle。
运行时 bundle 只从 `integrations` 读取 adapter、policy 与 Skill，不会导入该测试目录。

| 路径 | 作用 |
| --- | --- |
| `deepseek-harness/scripts/verify-deepseek-bridge.mjs` | 针对 XuanLing binary 的真实 stdio 合同检查。 |
| `deepseek-harness/live-test` | 对 workspace 与 Memory database 执行 fail-closed 隔离的 overlay。 |
| `deepseek-harness/evaluation/fixtures` | 固定 hash 的文件系统工作负载与外部 oracle。 |
| `deepseek-harness/evaluation/overlays` | 冻结的 A/B/C 工具目录变体与共享隔离策略。 |
| `deepseek-harness/evaluation/scripts` | Catalog 检查、直接 probe、live runner、analyzer 与报告 verifier。 |
| `deepseek-harness/evaluation/memory-retrieval` | 预置数据的召回工作负载、runner、transcript verifier 与 SQLite oracle。 |
| `deepseek-harness/evaluation/*.md` | 与记录 revision 和 evidence root 绑定的历史验收报告。 |

文件系统 fixture 是不可变测试输入。其中嵌套的 `README.md` 属于工作负载，必须与
`manifest.json` 保持逐字节 hash 兼容。

## 确定性门禁

npm 测试会验证 DSH bundle 合同、冻结 fixture、analyzer、dry-run gate 与 Memory 召回评估，
不会启动计费模型会话：

```sh
npm --prefix npm test
```

使用隔离的临时 workspace 与 Memory database，针对已构建 binary 验证 MCP bridge：

```sh
node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp

node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp \
  --tool-profile memory
```

## DeepSeek Harness Checkout Probe

TypeScript probe 从 `--dsh-root` 指定的 Harness checkout 解析 package；XuanLing 不 vendoring
这些 dependency。

```sh
XUANLING_DSH_CHECKOUT=/absolute/path/to/deepseek-harness
XUANLING_MCP_BINARY=/absolute/path/to/xuanling-mcp

TSX_TSCONFIG_PATH="$XUANLING_DSH_CHECKOUT/tsconfig.json" \
  "$XUANLING_DSH_CHECKOUT/node_modules/.bin/tsx" \
  test/deepseek-harness/evaluation/scripts/inspect-catalog.ts \
  --dsh-root "$XUANLING_DSH_CHECKOUT" \
  --binary "$XUANLING_MCP_BINARY" \
  --arms A,B,C

TSX_TSCONFIG_PATH="$XUANLING_DSH_CHECKOUT/tsconfig.json" \
  "$XUANLING_DSH_CHECKOUT/node_modules/.bin/tsx" \
  test/deepseek-harness/evaluation/scripts/probe-filesystem-tools.ts \
  --dsh-root "$XUANLING_DSH_CHECKOUT" \
  --binary "$XUANLING_MCP_BINARY"
```

文件系统与 Memory live runner 在缺少 `--allow-billable-live` 时会拒绝启动模型会话。它们的
dry-run 模式只验证路径、冻结 route、trial 数量与隔离输入，不联系 provider。真实运行还要求
唯一 run ID、隔离 workspace 与 database，以及一个显式 credential source。

