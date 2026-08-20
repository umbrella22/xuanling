# XuanLing Test Assets

English | [Simplified Chinese](README-ZH.md)

This directory contains repository-only contract fixtures and release
verification assets. Integration bundles and the `xuanling-mcp` npm package do
not import this tree at runtime.

## Retained Suites

| Path | Purpose |
| --- | --- |
| `deepseek-harness/scripts/verify-deepseek-bridge.mjs` | Verifies the stdio bridge, isolated workspace, isolated Memory database, and selected tool profile against a built XuanLing binary. |
| `host-integration/fixtures/result-projection` | Frozen ZCode and DSH result-projection inputs. |
| `host-integration/fixtures/result-cost` | Closed fixtures for wire, model-visible, structured, UI, and provider-usage accounting. |
| `host-integration/fixtures/skill-routing` | Shared DSH and ZCode Skill-routing cases. |
| `host-integration/verify-*.mjs` | Deterministic projection, cost, routing, and real-binary verifiers used by the current host-efficiency plan. |
| `release` | Repository-promotion and immutable-release fixtures. |

Historical filesystem A/B/C evaluation, the standalone Memory retrieval
evaluation, host dogfooding workspaces, database snapshots, reports, and their
live-only overlays were removed after their acceptance waves closed. Their
conclusions remain in the corresponding ADR and execution ledgers; they are
not current regression gates.

## Deterministic Gates

Run the complete Node contract suite:

```sh
npm --prefix npm test
```

Verify the DSH bridge against a built binary. The verifier creates temporary
workspace and database roots and removes them after the run:

```sh
node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp

node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp \
  --tool-profile memory
```

Host-integration verifiers are also exercised by the npm tests. Their fixtures
remain static so a behavior change requires an explicit fixture review.
