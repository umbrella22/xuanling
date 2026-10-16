# Blueprint validation boundaries

Blueprint validation separates deterministic regression, isolated real-host journeys,
provider execution, and complete acceptance. A successful subset proves only its
named contracts. The existing [verification runner](scripts/verify.mjs) writes
checkout-bound JSON reports; the [acceptance contract](test/acceptance/CONTRACT.md)
defines the full evidence matrix.

## Package-local setup

Run dependency installation separately in the plugin and test harness. Each package
has its own lockfile; neither command creates a repository-wide Node workspace.
The plugin declares Node >=22.14.0; CI uses Node 24 for TypeScript transformation.

```sh
pnpm --dir integrations/deepseek-harness/xuanling-blueprint install --frozen-lockfile
pnpm --dir test/blueprint install --frozen-lockfile
pnpm --dir test/blueprint exec playwright install --with-deps msedge
pnpm --dir integrations/deepseek-harness/xuanling-blueprint run format:check
pnpm --dir integrations/deepseek-harness/xuanling-blueprint run typecheck
pnpm --dir integrations/deepseek-harness/xuanling-blueprint run lint
pnpm --dir integrations/deepseek-harness/xuanling-blueprint run build
pnpm --dir integrations/deepseek-harness/xuanling-blueprint test
```

`test` discovers every `test/**/*.test.mjs` file, including runner calibration and
live-journey fixtures. Hydrated UI fixtures use the harness Playwright and real
Edge with synthetic data, so Edge installation is required before the full test
command. These fixtures do not exercise a real DSH profile or provider journey.
Build must finish before verification suites importing `lib` start. Freeze source,
CI configuration, manifests, and built artifacts before collecting evidence.

## Verification layers

Run the following commands from this plugin directory. `REPORT_DIR` denotes a
fresh absolute directory outside repository `docs/` and `key/`; acceptance rejects
evidence paths containing those components. A shell variable named `REPORT_DIR`
may be set to that directory before invoking these examples.

```sh
node scripts/verify.mjs --suite foundation --plan-id dsh-blueprint-takeover-v1 --report-dir "$REPORT_DIR"
node scripts/verify.mjs --suite critical --scope all --repeat 3 --plan-id dsh-blueprint-takeover-v1 --report-dir "$REPORT_DIR"
```

| Layer / suite | Prerequisites and actual work | Evidence boundary |
| --- | --- | --- |
| Deterministic: `foundation`, `definition`, `resources`, `runtime`, `api`, `portability`, `security`, `recovery`, `critical` | Installed dependencies and built `lib`; local fixtures and isolated filesystem state. `api`, `security`, `recovery`, `critical` take `--scope all`. | No provider credential or interactive browser required. `critical` requires three consecutive passes for acceptance. |
| `red-oracles` | Exact expected error codes from deliberately failing cases. | Runner calibration; `expected-red` cannot satisfy a normal acceptance gate. |
| `platform` | Actual current OS, built `lib`, writable temporary directory. | Filesystem/restore checks and authentic OS identity; one OS cannot prove another. |
| `host` | Real DSH CLI from `test/blueprint`, npm/public registry access, built plugin, Playwright and system Microsoft Edge (`msedge` channel). Packs and installs into a fresh web profile, boots DSH, exercises gateway/agents/tools and browser canvas. | Real integration with a 15-minute child deadline; no provider secret required. It is not a lightweight deterministic suite. |
| `browser` | Same real probe prerequisites as `host`; fresh screenshot and nested tools report. | Real pointer/keyboard, save/CAS, run, refresh and isolation assertions; 20-minute child deadline. |
| `performance` | Same probe; frozen `darwin/arm64`, real Edge, 200-node/300-edge/20-resource fixture. | Actual load <=2000 ms and p95 <=100 ms over 20 trusted interactions; 20-minute child deadline. Generic Linux CI is outside this measurement contract. |
| `package` | Built plugin, real CLI, public npm registry access. New web and headless profiles each pack/install/boot/ping/disable/uninstall; source/runtime sentinels must survive. | Fresh PL1–PL7 lifecycle receipts and tarball hashes; up to 20 minutes per mode, run sequentially. No browser is required by the lifecycle collector itself. |
| `live` | Explicit real provider configuration and built plugin/harness. Default adapter requires `BP_LIVE_PROVIDER_KEY`, `BP_LIVE_PROVIDER_BASE_URL`, `BP_LIVE_PROVIDER_MODEL`; built-in provider selection has separate configuration validation. | Actual scoped Agent nonce output and downstream forwarding. HTTPS non-loopback endpoint required by the default adapter; no placeholder credentials. |
| `acceptance` | Explicit complete manifest, raw report SHA256 values, matching plan and source/artifact fingerprints. | All 20 fixed gates: 15 suites, three real OS receipts, two lifecycle receipts. No historical-directory scan or inferred evidence. |

Deadlines above are failure bounds, not measured run durations. Registry latency,
profile initialization and browser availability determine actual integration time.
The probe and lifecycle collector provision `pnpm@11.27.1` in fresh temporary tool
homes. A local package tarball does not make these installation journeys offline;
preinstalled repository dependencies alone do not remove registry access.

The current probe checks DSH CLI output `0.2.1-alpha.2`, while the performance
validator checks `0.2.1-alpha.1` and package dependencies select `0.2.1-alpha.3`.
These are conflicting verification prerequisites pending a real-host validation
and version-contract decision. Deterministic CI success cannot resolve that gap.

## Reports and unavailable environments

Every suite invocation records case results, consecutive clean count, timing,
environment and before/after source/artifact fingerprints in its existing report.
Any source or artifact change invalidates associated acceptance evidence. Concurrent
builds or edits during collection can produce `EVIDENCE_STALE`.

`VerificationNotRunError` produces `status: not-run`, `passed: false`, clean count
zero and exit code 1. Missing live configuration yields
`LIVE_CONFIGURATION_MISSING`; this is an unavailable-environment receipt, never a
provider pass. A keyless regression must assert that exact result and fingerprint
stability; accepting arbitrary nonzero exits could hide import or runner failures.
Browser/probe prerequisite failures currently surface as failed gates, so their
exit codes must not be relabeled as successful skips.

Normal verification defaults write under `docs/validation/blueprint/current/`.
Explicit `--report-dir` routing is necessary when collecting reports for the
acceptance evaluator, which rejects `docs/` evidence paths. Preserve the original
JSON bytes when hashing or transferring reports, plus referenced lifecycle
artifacts and browser screenshots/nested reports for provenance inspection.

```sh
node scripts/verify.mjs --suite acceptance --plan-id dsh-blueprint-takeover-v1 --report-dir "$REPORT_DIR" --evidence-manifest "$REPORT_DIR/manifest.json"
```

The [manifest helper](test/acceptance/manifest.example.mjs) creates all required
entries as `not-run`. Only fresh real receipts replace those entries. macOS,
Linux and Windows receipts must share the same source and artifact fingerprints;
separate CI builds are not automatically compatible. See the
[complete manifest and behavior receipt contract](test/acceptance/CONTRACT.md)
for case IDs, schemas, minimum repeats, and failure precedence.

CI artifacts containing deterministic/platform reports and the keyless oracle
prove those individual gates. Full acceptance additionally requires fresh browser,
performance, lifecycle and real-provider evidence with the fixed matrix intact.

## Manual packed lifecycle CI

The [dsh-blueprint-package workflow](../../../.github/workflows/dsh-blueprint-package.yml)
runs only through `workflow_dispatch`. Its Ubuntu and macOS jobs install each
package's frozen dependencies, build once, then invoke the existing `package`
suite with a 60-minute job bound. No provider credentials or browser installation
are needed. Failures remain job failures; neither mode uses `continue-on-error`.

Reports reside under `runner.temp`, outside the checkout. Artifact upload selects
only the package report, fresh web/headless lifecycle receipts and packed `.tgz`
files. Launcher homes, installed dependency trees and isolated runtime/profile
contents are excluded. The workflow grants only `contents: read` and does not
publish, push or access repository secrets.

Windows packed lifecycle remains unverified and is excluded from this workflow.
The collector currently launches `node_modules/.bin/dsh` and `npm` directly;
Windows command-shim execution requires separate validation. The macOS/Linux jobs
also build separately, so their green results do not automatically form the
single-artifact fingerprint required by complete cross-platform acceptance.
