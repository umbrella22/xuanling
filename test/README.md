# XuanLing Test Assets

English | [Simplified Chinese](README-ZH.md)

This directory contains repository-only fixtures, probes, evaluation overlays,
and acceptance reports. None of these files are required when installing an
integration bundle or the `xuanling-mcp` npm package.

## DeepSeek Harness

`deepseek-harness` validates the host-specific bundles published from
[`integrations/deepseek-harness`](../integrations/deepseek-harness/). Runtime
bundles read their adapters, policies, and Skills only from `integrations`;
they do not import this test tree.

| Path | Purpose |
| --- | --- |
| `deepseek-harness/scripts/verify-deepseek-bridge.mjs` | Live stdio contract checks against a XuanLing binary. |
| `deepseek-harness/live-test` | Fail-closed workspace and Memory database isolation overlay. |
| `deepseek-harness/evaluation/fixtures` | Hash-pinned filesystem workload and external oracle. |
| `deepseek-harness/evaluation/overlays` | Frozen A/B/C tool-catalog variants and shared isolation policy. |
| `deepseek-harness/evaluation/scripts` | Catalog inspection, direct probes, live runner, analyzer, and report verifiers. |
| `deepseek-harness/evaluation/memory-retrieval` | Seeded retrieval workload, runner, transcript verifier, and SQLite oracle. |
| `deepseek-harness/evaluation/*.md` | Historical acceptance reports tied to their recorded revisions and evidence roots. |

The filesystem fixture is an immutable test input. Its nested `README.md` is
part of the workload and must remain byte-for-byte hash compatible with
`manifest.json`.

## Deterministic Gates

The npm suite exercises the DSH bundle contracts, frozen fixtures, analyzers,
dry-run gates, and Memory retrieval evaluation without starting a billable
model session:

```sh
npm --prefix npm test
```

Verify the MCP bridge against a built binary with an isolated temporary
workspace and Memory database:

```sh
node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp

node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp \
  --tool-profile memory
```

## DeepSeek Harness Checkout Probes

The TypeScript probes resolve Harness packages from the checkout supplied by
`--dsh-root`; XuanLing does not vendor those dependencies.

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

The filesystem and Memory live runners refuse to start a model session unless
`--allow-billable-live` is present. Their dry-run modes validate paths, frozen
routes, trial counts, and isolation inputs without contacting the provider.
Live runs require a unique run ID, an isolated workspace and database, and one
explicit credential source.

