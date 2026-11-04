# @xuanling-rs/harness-bridge

Launcher for the result-only XuanLing harness bridge. The bridge is a plain
stdio MCP server; this package resolves the native `harness-bridge` executable
and starts it without a shell.

The npm distribution includes native packages for macOS Apple Silicon,
Linux x64 (glibc 2.35+) and Windows x64. The launcher installs the matching
platform package automatically. The bridge remains experimental; publishing
these packages does not imply acceptance of every worker or controller host.

## Usage

```sh
npx @xuanling-rs/harness-bridge@0.10.2 --config /absolute/path/to/bridge-config.json
```

From a checkout, build the binary first:

```sh
cargo build -p xuanling-harness-bridge
node npm/packages/harness-bridge/bin/harness-bridge.js --config /absolute/path/to/bridge-config.json
```

The binary speaks MCP over stdio. stdout carries protocol framing only; put
diagnostics on stderr (`HARNESS_BRIDGE_LOG`, default `warn`).

## Binary resolution order

1. `HARNESS_BRIDGE_BIN` (absolute path, or relative to the current directory).
2. An installed platform package `@xuanling-rs/harness-bridge-<target>` with a
   `harnessBridgeBinary`/`xuanlingBinary` manifest entry.
3. A local Cargo build in the current checkout: `target/release` before
   `target/debug` (also honors `CARGO_TARGET_DIR`).
4. `harness-bridge` on `PATH`.

If none exists the launcher fails with an actionable message instead of
silently running a different binary.

## Scope

The bridge runs one configured native worker and returns its final answer and
terminal status. It is not a scheduler, job database or process dashboard. See
the crate documentation:

- `crates/xuanling-harness-bridge/README.md`
- `crates/xuanling-harness-bridge/SECURITY.md`
- `crates/xuanling-harness-bridge/RELEASE-BOUNDARY.md`

The Rust crate is not published to crates.io. Native executables do not carry
Developer ID or Authenticode signatures. Codex workers use `--ephemeral` and
Claude workers use `--no-session-persistence`. DSH and ZCode worker execution
currently returns `NATIVE_SESSION_PERSISTENCE_UNSUPPORTED`; DSH may still act
as a controller. The separate local DSH integration package is not part of
this npm release.

## Maintainer publishing

`.github/workflows/harness-bridge-npm.yml` builds the four release packages on
native runners. Tag pushes build artifacts without uploading to npm. The
first upload uses npm's browser-authenticated CLI flow. For future releases,
configure a GitHub Actions trusted publisher on **all four** npm packages:
owner `umbrella22`, repository `xuanling`, workflow `harness-bridge-npm.yml`,
environment `npmjs`. Then dispatch that workflow at the release tag with
`publish: true` to publish with provenance. Platform packages are uploaded
before the launcher, using the `platform-<target>` tags.

## License

MIT
