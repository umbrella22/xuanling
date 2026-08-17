# XuanLing MCP npm Distribution

English | [Simplified Chinese](README-ZH.md)

This directory contains the npm distribution and release automation for
XuanLing MCP 0.2.3. A complete release contains eight immutable npm items: one
stable Node.js launcher, three native variants published under platform-specific
prerelease versions, and four DeepSeek Harness bundles. The same verified core
artifacts produce the ZCode marketplace archive.

## Package Set

| Installed alias | Published version | Platform |
| --- | --- | --- |
| `@xuanling-rs/xuanling-mcp` | `0.2.3` | Stable Node.js launcher |
| `@xuanling-rs/xuanling-mcp-darwin-arm64` | `0.2.3-darwin-arm64` | macOS Apple Silicon |
| `@xuanling-rs/xuanling-mcp-linux-x64-gnu` | `0.2.3-linux-x64-gnu` | Linux x64, glibc 2.35 or newer |
| `@xuanling-rs/xuanling-mcp-win32-x64-msvc` | `0.2.3-win32-x64-msvc` | Windows x64 MSVC |

The launcher and native variants are published under the `@xuanling-rs` npm
organization. The stable package declares unscoped installation aliases as
optional dependencies, and npm selects the compatible
variant through `os`, `cpu`, and `libc` metadata. Intel macOS, ARM Linux,
glibc 2.34 and older, musl Linux, and ARM Windows are not published by this
release.

DeepSeek Harness installs these public bundles directly into a profile:

| Package | Purpose |
| --- | --- |
| `@xuanling-rs/xuanling-dsh-memory@0.2.3` | Complete Memory v2 profile with DSH schema projection |
| `@xuanling-rs/xuanling-dsh-skills@0.2.3` | File and Memory workflow Skills plus strict overwrite policy |
| `@xuanling-rs/xuanling-dsh-tools@0.2.3` | Additive full XuanLing catalog |
| `@xuanling-rs/xuanling-dsh-tools-replace@0.2.3` | Full catalog with model-facing native filesystem rows disabled |

The three tool bundles depend on the exact stable `@xuanling-rs/xuanling-mcp` version in the
same DSH profile. The Skills bundle contains no MCP runtime.

## Installation

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.2.3
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
        "@xuanling-rs/xuanling-mcp@0.2.3",
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
- Every native package records an explicit release-trust state, requires npm
  provenance at publication, and binds its binary SHA-256 to the source commit.
  The ZCode marketplace archive also receives a GitHub OIDC build-provenance
  attestation before promotion.
- XuanLing 0.2.3 does not claim a Developer ID or Authenticode publisher
  signature. Those signatures may be added in a later release, but their
  absence does not change the MCP protocol or package integrity contract.
- Every native package contains the XuanLing MIT license and generated
  third-party notices.
- The launcher package includes matching English and Simplified Chinese
  READMEs.

## Local Validation

Run all commands from the repository root:

```sh
npm --prefix npm run check
npm --prefix npm run check:docs
npm --prefix npm test

node npm/scripts/pack-dsh-bundles.mjs \
  --out npm/dist/dsh \
  --commit "$(git rev-parse HEAD)"
node npm/scripts/verify-dsh-release-set.mjs \
  --root npm/dist/dsh \
  --version 0.2.3 \
  --commit "$(git rev-parse HEAD)"

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
3. `verify-release-set.mjs` and `verify-dsh-release-set.mjs` to observe all
   eight npm items from the same commit.
4. The generated ZCode tree and archive to pass exact file, release-trust
   metadata, package hash, source commit, deterministic digest, and GitHub
   artifact-attestation checks.
5. The release commit to be present on `origin/main`. The GitHub
   `zcode-packer` Environment must define `ZCODE_REPOSITORY` as
   `umbrella22/xuanling-zcode-marketplace` and provide `XL_PUBLISH_TOKEN` with
   authenticated push permission to that repository. Its default branch must
   be `main`.
6. A manual run of the workflow from `main` to verify npm package visibility
   and ZCode target permission without creating a tag.
7. A stable tag named `xuanling-mcp-v<version>` to trigger
   [npm-publish.yml](../.github/workflows/npm-publish.yml).

The publish workflow publishes three native versions, the stable launcher, and
the four DSH bundles in that order. It then reconciles all eight registry
integrities before checking out `umbrella22/xuanling-zcode-marketplace` with
the Environment credential. The verified ZCode tree is committed and `main`
plus `xuanling-mcp-v<version>` are pushed atomically. A matching existing tag
is an idempotent no-op; any integrity or tree mismatch is a hard failure. Local
`npm publish` is not part of the release path.

### Trusted Publishing

All eight package names already exist and the release workflow uses npm Trusted
Publishing through the `npmjs` GitHub environment. No long-lived npm token or
bootstrap secret is required. Configure package-level Trusted Publishing for
each scoped package with:

```text
GitHub owner: umbrella22
Repository: xuanling
Workflow: npm-publish.yml
Environment: npmjs
Allowed action: npm publish
```

Rerun a failed publish job without changing the tag, commit, or artifacts. The
idempotent publisher skips every item whose matching integrity already exists.

## Failure Recovery

- A build failure before any package is published requires a fix, a version
  increment, and a new tag. Do not move a release tag that already produced an
  npm version.
- If publication stops after a subset reaches npm, preserve the tag and
  artifacts, correct the external prerequisite, and rerun. Matching items are
  skipped and publication resumes at the first missing item.
- If registry reconciliation succeeds but ZCode promotion fails, correct the
  `zcode-packer` token or target repository configuration and rerun the
  promotion path against the same source run and artifact digest.
- An integrity mismatch for an existing version is a hard failure; published
  versions are immutable.
- If an installed launcher reports a missing optional dependency, reinstall
  the pinned version. The launcher never downloads or compiles the native
  binary itself.

`publish-idempotent.mjs` targets npmjs by default. Registry emulation tests may
pass `--registry http://127.0.0.1:4873`; the production workflow endpoint does
not change.
