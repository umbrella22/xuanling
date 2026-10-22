# XuanLing 测试资产

[English](README.md) | 简体中文

本目录只存放仅供仓库使用的验证资产。维护者与 CI 在 checkout 中使用它们；任何 npm package
或集成 bundle 都不会发布或导入本目录。本清单对应当前仓库版本 `0.7.0`。

## 目录结构

| 路径 | 用途 |
| --- | --- |
| `deepseek-harness/` | DSH 集成 verifier。`scripts/verify-deepseek-bridge.mjs` 使用已构建的二进制检查 stdio bridge。 |
| `host-integration/` | DSH 与 ZCode Host 适配器的 fixture 与 verifier：结果投影、结果成本计量、Skill 路由、对话式安装器与文件系统替换。 |
| `release/` | 发布合同 fixture 与 ZCode marketplace 目标仓库模板，供 [npm 发布自动化](../npm/README-ZH.md)的测试使用。 |
| `blueprint/` | 私有 pnpm workspace，包含 DSH Blueprint 探针、能力采集器、probe 插件与 fixture。 |

## 确定性门禁

从仓库根执行。npm 门禁需要 Rust 1.98、Node.js 22.14+、npm 11.5.1+ 与 `git`；crate 边界
测试会执行 `cargo metadata`，因此 `PATH` 上必须有 Rust 工具链。不需要构建步骤。

```sh
npm --prefix npm run check
npm --prefix npm run check:docs
npm --prefix npm test
```

`npm test` 在 `npm/` 内运行 `node --test test/*.test.mjs`。这些测试导入本目录的 fixture 与
verifier，并冻结预期行为。`check:docs` 校验仓库 Markdown：相对链接、代码围栏是否配对、表格
结构，以及引用的文档路径是否存在。

fixture 是固定输入。行为变化必须显式审核 fixture；禁止为了让测试通过而重新生成 fixture。

Rust crate 门禁（`cargo fmt`、`cargo check`、`cargo clippy` 与 crate 测试套件）见
[根 README](../README-ZH.md)，不由本目录驱动。

### 使用真实二进制的 DSH bridge 检查

bridge verifier 不属于 `npm test`。它会用临时 workspace 与 Memory 数据库启动二进制，检查
wire 合同（公开名称、schema、参数透传）；任何漂移都会以非零状态退出：

```sh
cargo build --locked --release -p xuanling-mcp

node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp

node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp \
  --tool-profile memory
```

## Host 集成

以下 fixture verifier 已由 `npm test` 执行；每个文件同时提供独立 CLI 入口。

| 路径 | 检查内容 |
| --- | --- |
| `host-integration/verify-result-projection.mjs` | 模型可见投影中只有一个结构化值，且 code mode 保留 `structuredContent`。 |
| `host-integration/verify-result-cost-report.mjs` | wire、模型可见文本、structured、UI、provider usage 各层保持独立；缺失或歧义的 usage 会被拒绝。 |
| `host-integration/verify-skill-routing.mjs` | DSH 与 ZCode 共用同一套冻结的 Skill 路由用例。 |
| `host-integration/verify-dsh-conversational-install.mjs` | 安装器 transcript 合同：正常安装、取消、回滚、迁移、headless 空操作，以及确认前不得产生副作用。 |

fixture 位于 `host-integration/fixtures/`。需要真实产物或已安装 profile 的手动 verifier 不属于
`npm test`；它们在临时目录中工作，并把 JSON 打印到 stdout：

```sh
node test/host-integration/verify-adapter-real-binary.mjs --binary <path-to-xuanling-mcp>

node test/host-integration/verify-deepseek-filesystem-facade.mjs \
  --dsh-root <dsh-checkout> --xuanling-mcp-bin <xuanling-mcp>

node test/host-integration/verify-dsh-lazy-runtime.mjs \
  --profile-root <dsh-profile> --bundle <bundle> \
  --expected-version <version> --workspace-root <dir>

node test/host-integration/verify-zcode-filesystem-replacement.mjs \
  --zcode-cli <zcode-cli> --plugin-root <plugin-root> --expected-version <version>
```

`host-integration/mock-openai-dsh-lazy.mjs` 是本地 OpenAI 兼容 mock server，用于驱动真实 DSH
profile 做 lazy tool-catalog 检查。

## Blueprint harness

`blueprint/` 是私有 pnpm workspace（`@xuanling-rs/blueprint-test-harness`），有自己的
lockfile 与 workspace 策略。它提供 Host 探针（`capabilities/probe.mjs`）、canvas、lifecycle、
TeamStage、conversation 与 Comfy 采集器、probe 插件以及 fixture。只有可选的
[Blueprint 插件](../integrations/deepseek-harness/xuanling-blueprint/README-ZH.md)及其测试套件
使用它。

从仓库根安装并运行插件自身的测试套件：

```sh
pnpm --dir integrations/deepseek-harness/xuanling-blueprint install --frozen-lockfile
pnpm --dir test/blueprint install --frozen-lockfile
pnpm --dir test/blueprint exec playwright install --with-deps msedge

pnpm --dir integrations/deepseek-harness/xuanling-blueprint run build
pnpm --dir integrations/deepseek-harness/xuanling-blueprint test
```

suite 级验证在 Blueprint package 目录执行：

```sh
cd integrations/deepseek-harness/xuanling-blueprint

node scripts/verify.mjs --suite foundation --report-dir /tmp/bp-reports
node scripts/verify.mjs --suite critical --scope all --repeat 3 --report-dir /tmp/bp-reports
```

本地 fixture suite（需要已安装依赖与已构建的 `lib/`）：`foundation`、`red-oracles`（预期
失败的校准套件）、`definition`、`resources`、`runtime`、`api`、`portability`、
`security`、`recovery`、`critical`，以及在当前 OS 上运行的 `platform`。真实环境 journey：
`host`、`browser`、`performance`、`live`、`package`。它们需要 harness 安装、带 Edge
channel 的 Playwright、来自 `test/blueprint` 的 DSH CLI，以及按需的 provider 凭据或 registry
访问。`acceptance` 按显式证据 manifest 汇总判定，不会自动运行其他 suite。各 suite 的前置条件
与证据边界见 [CI-VALIDATION.md](../integrations/deepseek-harness/xuanling-blueprint/CI-VALIDATION.md)。

## 证据与历史边界

- Blueprint suite 默认把 JSON 报告写入 `docs/validation/blueprint/current/`。`docs/` 只存在
  于本机：不进入 tracked tree，也不属于公开 checkout。需要保留证据时显式传入
  `--report-dir`。
- `docs/validation/blueprint/archives/` 下的归档保存了原始路径与哈希的 manifest，但它们只能
  证明采集时的 checkout，不能证明当前 checkout。
- `test/blueprint/node_modules` 与 `test/blueprint/reports` 属于本机 workspace 状态，已被
  git 忽略。
- 通过的报告只是针对其所记录命令与 checkout 的本地证据。请对当前 checkout 重新运行门禁，
  不要引用旧的运行结果。
