# XuanLing MCP npm Distribution

English | [Simplified Chinese](README-ZH.md)

This directory contains the npm packaging and release automation for XuanLing
MCP 0.7.0. A complete release is nine immutable npm items published from one
verified commit: the stable Node.js launcher, three platform-specific native
variants, four DeepSeek Harness bundles, and the optional Blueprint/TeamStage
plugin. The same verified core artifacts also produce the ZCode marketplace
archive.

## Release Contents

### Launcher and native variants

| Package | Published version | Platform |
| --- | --- | --- |
| `@xuanling-rs/xuanling-mcp` | `0.7.0` | Stable Node.js launcher |
| `@xuanling-rs/xuanling-mcp-darwin-arm64` | `0.7.0-darwin-arm64` | macOS Apple Silicon |
| `@xuanling-rs/xuanling-mcp-linux-x64-gnu` | `0.7.0-linux-x64-gnu` | Linux x64, glibc 2.35 or newer |
| `@xuanling-rs/xuanling-mcp-win32-x64-msvc` | `0.7.0-win32-x64-msvc` | Windows x64 MSVC |

The launcher and native variants are published under the `@xuanling-rs` npm
organization. The stable package declares the native variants as aliased
optional dependencies, and npm selects the compatible variant through `os`,
`cpu`, and `libc` metadata. Intel macOS, ARM Linux, glibc 2.34 or older,
musl Linux, and ARM Windows are not part of this release.

### DeepSeek Harness bundles

DeepSeek Harness installs these public bundles directly into a profile:

| Package | Purpose |
| --- | --- |
| `@xuanling-rs/xuanling-dsh-memory@0.7.0` | Complete Memory v2 profile with DSH schema projection |
| `@xuanling-rs/xuanling-dsh-skills@0.7.0` | File and Memory workflow Skills plus strict overwrite policy |
| `@xuanling-rs/xuanling-dsh-tools@0.7.0` | Additive full XuanLing catalog |
| `@xuanling-rs/xuanling-dsh-tools-replace@0.7.0` | Opt-in same-name filesystem replacement facade with XuanLing CAS/batch and native host projections |

The Memory, Tools, and Tools-replace bundles depend on the exact stable
`@xuanling-rs/xuanling-mcp` version in the same DSH profile. The Skills bundle
contains no MCP runtime.

### Optional Blueprint plugin

The [Blueprint/TeamStage plugin](../integrations/deepseek-harness/xuanling-blueprint/README.md)
is built from the release commit, published as
`@xuanling-rs/xuanling-dsh-blueprint`, and also shipped as a GitHub Release
tarball with `blueprint.pack.json`.

## Release Requirements

Release automation runs on Node.js 22.14 or newer with npm 11.5.1 or newer.
The DSH and Blueprint package flows use the repository-pinned pnpm 11.28.5, and
native builds require Rust 1.98.

## Install Paths

Global installation:

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.7.0
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
        "@xuanling-rs/xuanling-mcp@0.7.0",
        "--workspace-root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

Tool profiles, filesystem boundaries, and server options are documented in the
[launcher package README](packages/xuanling-mcp/README.md). The user-facing
capability contract is documented in the [repository README](../README.md).

Install the optional Blueprint and TeamStage plugin with the repository's
pnpm-managed package flow:

```sh
pnpm add --save-exact @xuanling-rs/xuanling-dsh-blueprint@0.7.0
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-blueprint@0.7.0
```

Restart the selected DSH profile after installation. TeamStage also requires the
native Agent Teams profile to be enabled explicitly.

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
- XuanLing 0.7.0 does not claim a Developer ID or Authenticode publisher
  signature. These signatures may be added in a later release; their absence
  does not change the MCP protocol or package integrity contract.
- Every native package contains the XuanLing MIT license and generated
  third-party notices.
- The launcher package includes matching English and Simplified Chinese
  READMEs.

## Local Validation

### Repository checks

Run all commands from the repository root:

```sh
npm --prefix npm run check
npm --prefix npm run check:docs
npm --prefix npm test

pnpm --dir integrations/deepseek-harness/xuanling-blueprint install --frozen-lockfile
pnpm --dir test/blueprint install --frozen-lockfile
pnpm --dir integrations/deepseek-harness/xuanling-blueprint run typecheck
pnpm --dir integrations/deepseek-harness/xuanling-blueprint run lint
pnpm --dir integrations/deepseek-harness/xuanling-blueprint run build
pnpm --dir integrations/deepseek-harness/xuanling-blueprint test

node npm/scripts/pack-dsh-bundles.mjs \
  --out npm/dist/dsh \
  --commit "$(git rev-parse HEAD)"
node npm/scripts/verify-dsh-release-set.mjs \
  --root npm/dist/dsh \
  --version 0.7.0 \
  --commit "$(git rev-parse HEAD)"

node npm/scripts/generate-third-party-licenses.mjs \
  --target aarch64-apple-darwin \
  --output /tmp/xuanling-third-party.txt
cargo build --locked --release --target aarch64-apple-darwin -p xuanling-mcp
node npm/scripts/smoke-mcp.mjs \
  --binary target/aarch64-apple-darwin/release/xuanling-mcp
```

### Local tarballs

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

### CI coverage

CI builds the launcher tarball once and the native tarball independently for
each of the three supported targets. Each installed launcher must pass MCP
`initialize`, the complete 43-tool catalog across paginated `tools/list`, and
`system_info` smoke tests.

## Publishing

The root `Cargo.toml` workspace version is the canonical release version. A
release requires all of the following before the tag is created:

1. npm metadata, tests, Node syntax checks, and `git diff --check` to pass.
2. Locked release binaries, third-party notices, package metadata, tarball
   contents, and integrity checks to pass on all three platforms.
3. `verify-release-set.mjs`, `verify-dsh-release-set.mjs`, and
   `verify-blueprint-release.mjs` to observe all nine npm items from the same
   commit.
4. The generated ZCode tree and archive to pass exact file, release-trust
   metadata, package hash, source commit, deterministic digest, and GitHub
   artifact-attestation checks.
5. The release commit to be present on `origin/main`. The GitHub
   `zcode-packer` Environment must define `ZCODE_REPOSITORY` as
   `umbrella22/xuanling-zcode-marketplace` and provide `XL_PUBLISH_TOKEN` with
   authenticated push permission to that repository. Its default branch must be
   `main`.
6. A manual run of the workflow from `main` to verify npm package visibility
   and ZCode target permission without creating a tag. Use the default
   `preflight` mode for the prerequisite check, or `candidate` for a complete
   no-publish release build.
7. A stable tag named `xuanling-mcp-v<version>` to trigger
   [npm-publish.yml](../.github/workflows/npm-publish.yml).

### Publish order

The workflow publishes three native versions, the stable launcher, the four DSH
bundles, and Blueprint in that order, then reconciles all nine registry
integrities. The promotion job revalidates the same release set, checks out
`umbrella22/xuanling-zcode-marketplace` with the Environment credential,
commits the verified ZCode tree, and pushes `main` plus
`xuanling-mcp-v<version>` atomically. A matching existing tag is an idempotent
no-op; any integrity or tree mismatch is a hard failure. Local `npm publish` is
not part of the release path.

### Trusted Publishing

All nine package names already exist, and the release workflow uses npm Trusted
Publishing through the `npmjs` GitHub environment. No long-lived npm token or
bootstrap secret is required. Configure package-level Trusted Publishing for
each scoped package, including Blueprint, with:

```text
GitHub owner: umbrella22
Repository: xuanling
Workflow: npm-publish.yml
Environment: npmjs
Allowed action: npm publish
```

To rerun a failed publish job, keep the tag, commit, and artifacts unchanged.
The idempotent publisher skips every item whose matching integrity already
exists.

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
- If an installed launcher reports a missing optional dependency, reinstall the
  pinned version. The launcher never downloads or compiles the native binary
  itself.

`publish-idempotent.mjs` targets npmjs by default. Registry emulation tests may
pass `--registry http://127.0.0.1:4873`; the production workflow endpoint does
not change.

## Links

- [Repository README](../README.md)
- [Blueprint/TeamStage plugin README](../integrations/deepseek-harness/xuanling-blueprint/README.md)
- [Publish workflow](../.github/workflows/npm-publish.yml)
- [Changelog](../CHANGELOG.md)
