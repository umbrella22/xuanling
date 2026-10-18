# XuanLing Test Assets

English | [简体中文](README-ZH.md)

This directory holds repository-only verification assets. Maintainers and CI use them from a
checkout; no npm package or integration bundle ships or imports this tree. The inventory matches
repository release `0.6.1`.

## Layout

| Path | Purpose |
| --- | --- |
| `deepseek-harness/` | DSH integration verifiers. `scripts/verify-deepseek-bridge.mjs` checks the stdio bridge against a built binary. |
| `host-integration/` | DSH and ZCode host-adapter fixtures and verifiers: result projection, result-cost accounting, Skill routing, the conversational installer, and filesystem replacement. |
| `release/` | Release-contract fixtures and the ZCode marketplace target-repository template, used by the [npm release automation](../npm/README.md) tests. |
| `blueprint/` | Private pnpm workspace with the DSH Blueprint probe, capability collectors, probe plugin, and fixtures. |

## Deterministic gates

Run from the repository root. The npm gates need Rust 1.98, Node.js 22.14+, npm 11.5.1+, and
`git`; the crate-boundary test runs `cargo metadata`, so a Rust toolchain must be on `PATH`. No
build step is required.

```sh
npm --prefix npm run check
npm --prefix npm run check:docs
npm --prefix npm test
```

`npm test` runs `node --test test/*.test.mjs` inside `npm/`. Those tests import fixtures and
verifiers from this directory and freeze the expected behavior. `check:docs` validates repository
Markdown: relative links, balanced code fences, table shape, and references to existing documents.

Fixtures are frozen inputs. A behavior change requires an explicit fixture review; never
regenerate a fixture just to make a test pass.

Rust crate gates (`cargo fmt`, `cargo check`, `cargo clippy`, and the crate test suites) are
listed in the [root README](../README.md); they are not driven from this directory.

### DSH bridge against a real binary

The bridge verifier is not part of `npm test`. It starts the binary with a temporary workspace and
Memory database, checks the wire contract (public names, schemas, argument forwarding), and exits
non-zero on any drift:

```sh
cargo build --locked --release -p xuanling-mcp

node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp

node test/deepseek-harness/scripts/verify-deepseek-bridge.mjs \
  --binary target/release/xuanling-mcp \
  --tool-profile memory
```

## Host integration

These fixture verifiers run as part of `npm test`; each file also exposes a standalone CLI entry
point.

| Path | Checks |
| --- | --- |
| `host-integration/verify-result-projection.mjs` | The model-visible projection has exactly one structured value, and code mode preserves `structuredContent`. |
| `host-integration/verify-result-cost-report.mjs` | Wire, model-visible, structured, UI, and provider-usage layers stay separate; missing or ambiguous usage is rejected. |
| `host-integration/verify-skill-routing.mjs` | DSH and ZCode share one frozen Skill-routing case set. |
| `host-integration/verify-dsh-conversational-install.mjs` | Installer transcript contract: valid install, cancel, rollback, migration, headless no-op, and no side effect before confirmation. |

Fixtures live under `host-integration/fixtures/`. Manual verifiers that need real artifacts or
installed profiles are not part of `npm test`; they work in temporary directories and print JSON
to stdout:

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

`host-integration/mock-openai-dsh-lazy.mjs` is a local OpenAI-compatible mock server used to drive
a real DSH profile for lazy tool-catalog checks.

## Blueprint harness

`blueprint/` is a private pnpm workspace (`@xuanling-rs/blueprint-test-harness`) with its own
lockfile and workspace policy. It provides the host probe (`capabilities/probe.mjs`), the canvas,
lifecycle, TeamStage, conversation, and Comfy collectors, the probe plugin, and fixtures. Only the
optional [Blueprint plugin](../integrations/deepseek-harness/xuanling-blueprint/README.md) and its
test suites consume it.

Setup and the plugin's own test suite, from the repository root:

```sh
pnpm --dir integrations/deepseek-harness/xuanling-blueprint install --frozen-lockfile
pnpm --dir test/blueprint install --frozen-lockfile
pnpm --dir test/blueprint exec playwright install --with-deps msedge

pnpm --dir integrations/deepseek-harness/xuanling-blueprint run build
pnpm --dir integrations/deepseek-harness/xuanling-blueprint test
```

Suite-level verification runs from the Blueprint package directory:

```sh
cd integrations/deepseek-harness/xuanling-blueprint

node scripts/verify.mjs --suite foundation --report-dir /tmp/bp-reports
node scripts/verify.mjs --suite critical --scope all --repeat 3 --report-dir /tmp/bp-reports
```

Local-fixture suites (installed dependencies plus the built `lib/`): `foundation`,
`red-oracles` (the expected-failure calibration suite), `definition`, `resources`, `runtime`,
`api`, `portability`, `security`, `recovery`, `critical`, and `platform` on the current OS.
Real-environment journeys: `host`, `browser`, `performance`, `live`, and `package`. They need
the harness install, Playwright with the Edge channel, a DSH CLI from `test/blueprint`, and, where
applicable, provider credentials or registry access. `acceptance` aggregates an explicit evidence
manifest rather than running the other suites. See
[CI-VALIDATION.md](../integrations/deepseek-harness/xuanling-blueprint/CI-VALIDATION.md) for each
suite's prerequisites and evidence boundary.

## Evidence and history

- Blueprint suites write JSON reports under `docs/validation/blueprint/current/` by default.
  `docs/` is local only: it is not tracked and not part of a public checkout. Pass an explicit
  `--report-dir` when collecting evidence to keep.
- Archives under `docs/validation/blueprint/archives/` keep manifests of original paths and
  hashes, but they prove the checkout they were collected from, not the current one.
- `test/blueprint/node_modules` and `test/blueprint/reports` are local workspace state and are
  already gitignored.
- A passing report is local evidence for the commands and checkout it recorded. Re-run the gates
  for the current checkout instead of citing an older run.
