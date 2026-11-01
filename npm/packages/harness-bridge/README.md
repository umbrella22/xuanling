# @xuanling-rs/harness-bridge

Launcher for the result-only XuanLing harness bridge. The bridge is a plain
stdio MCP server; this package resolves the native `harness-bridge` executable
and starts it without a shell.

> Status: local workspace packaging only. This package and its platform binary
> packages are **not published** yet. Use the local Cargo build for now.

## Usage

```sh
npx @xuanling-rs/harness-bridge --config /absolute/path/to/bridge-config.json
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

The crate is not published, signed or released by the current plan. Platform
binary packages are future release work; this launcher intentionally has no
`optionalDependencies` until those packages exist.

## License

MIT
