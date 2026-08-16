# XuanLing MCP npm Distribution

English | [Simplified Chinese](README-ZH.md)

This directory contains the npm distribution and release automation for
`xuanling-mcp` 0.2.1. The release consists of one stable Node.js launcher and
three native variants published under platform-specific prerelease versions.

## Package Set

| Installed alias | Published version | Platform |
| --- | --- | --- |
| `xuanling-mcp` | `0.2.1` | Stable Node.js launcher |
| `xuanling-mcp-darwin-arm64` | `0.2.1-darwin-arm64` | macOS Apple Silicon |
| `xuanling-mcp-linux-x64-gnu` | `0.2.1-linux-x64-gnu` | Linux x64, glibc 2.35 or newer |
| `xuanling-mcp-win32-x64-msvc` | `0.2.1-win32-x64-msvc` | Windows x64 MSVC |

All four variants use the npm package name `xuanling-mcp`. The stable package
declares npm aliases as optional dependencies, and npm selects the compatible
variant through `os`, `cpu`, and `libc` metadata. Intel macOS, ARM Linux,
glibc 2.34 and older, musl Linux, and ARM Windows are not published by this
release.

## Installation

```sh
npm install --global xuanling-mcp@0.2.1
xuanling-mcp --workspace-root /absolute/path/to/project
```

An MCP host can pin the same release through `npx`:

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "xuanling-mcp@0.2.1",
        "--workspace-root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

The capability contract is documented in the
[MCP integration guide](../docs/guides/xuanling-mcp-integration.md).

## Distribution Guarantees

- Installation runs no `postinstall` script and does not compile Rust or
  download a binary from a remote URL.
- The launcher resolves a native optional dependency, validates its platform
  metadata and SHA-256, and forwards argv, stdio, signals, and exit status.
- Linux artifacts are built on `ubuntu-22.04` to preserve the glibc 2.35
  baseline.
- Every native package contains dual-license files and generated third-party
  notices.
- The launcher package includes matching English and Simplified Chinese
  READMEs.

## Local Validation

Run all commands from the repository root:

```sh
npm --prefix npm run check
npm --prefix npm run check:docs
npm --prefix npm test

node npm/scripts/generate-third-party-licenses.mjs \
  --target aarch64-apple-darwin \
  --output /tmp/xuanling-third-party.txt
cargo build --locked --release --target aarch64-apple-darwin -p xuanling-mcp
node npm/scripts/smoke-mcp.mjs \
  --binary target/aarch64-apple-darwin/release/xuanling-mcp
```

The complete local tarball path is:

```sh
STAGE_ROOT="$(mktemp -d)"

node npm/scripts/stage-main.mjs \
  --out "$STAGE_ROOT/main" \
  --commit "$(git rev-parse HEAD)"
node npm/scripts/verify-package.mjs --main "$STAGE_ROOT/main"
node npm/scripts/pack-package.mjs \
  --package "$STAGE_ROOT/main" \
  --out "$STAGE_ROOT/main-pack" \
  --label main \
  --kind main

node npm/scripts/stage-platform.mjs \
  --target darwin-arm64 \
  --binary target/aarch64-apple-darwin/release/xuanling-mcp \
  --notices /tmp/xuanling-third-party.txt \
  --out "$STAGE_ROOT/darwin-arm64" \
  --commit "$(git rev-parse HEAD)"
```

CI builds and verifies the launcher and native tarballs independently on all
three supported platforms. Each installed launcher must pass MCP
`initialize`, a 42-tool `tools/list`, and `system_info` smoke tests.

## Publishing

The root `Cargo.toml` workspace version is the canonical release version. A
release requires:

1. npm metadata, tests, Node syntax checks, and `git diff --check` to pass.
2. Locked release binaries, third-party notices, package metadata, tarball
   contents, and integrity checks to pass on all three platforms.
3. `verify-release-set.mjs` to observe one launcher and three native packages
   built from the same commit.
4. The release commit to be present on `origin/main`.
5. A stable tag named `xuanling-mcp-v<version>` to trigger
   [npm-publish.yml](../.github/workflows/npm-publish.yml).

The publish workflow uploads native variants first and the stable launcher
last. It refuses to overwrite an existing version with different integrity.
Local `npm publish` is not part of the release path.

### First publication

npm cannot bind a Trusted Publisher before a new package name exists. For the
first publication only, configure a short-lived `NPM_BOOTSTRAP_TOKEN` in the
GitHub `npmjs` environment. The workflow uses it for the first native variant.
After the package appears on npm, configure Trusted Publishing with:

```text
GitHub owner: umbrella22
Repository: xuanling
Workflow: npm-publish.yml
Environment: npmjs
Allowed action: npm publish
```

Rerun the failed publish job without changing the tag, commit, or artifacts.
The idempotent publisher skips a variant whose matching integrity already
exists. Remove the bootstrap secret and revoke the short-lived token after the
OIDC publication succeeds.

## Failure Recovery

- A build failure before any package is published requires a fix, a version
  increment, and a new tag. Do not move a release tag that already produced an
  npm version.
- If bootstrap succeeds and OIDC fails, bind the Trusted Publisher and rerun
  the same job with the same artifacts.
- An integrity mismatch for an existing version is a hard failure; published
  versions are immutable.
- If an installed launcher reports a missing optional dependency, reinstall
  the pinned version. The launcher never downloads or compiles the native
  binary itself.

`publish-idempotent.mjs` targets npmjs by default. Registry emulation tests may
pass `--registry http://127.0.0.1:4873`; the production workflow endpoint does
not change.
