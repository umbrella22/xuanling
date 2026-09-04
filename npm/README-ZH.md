# XuanLing MCP npm 分发

[English](README.md) | 简体中文

本目录维护 XuanLing MCP 0.4.0 的 npm 分发与发布自动化。完整发行版包含八个不可变 npm
item：一个稳定的 Node.js 启动器、三个使用平台 prerelease 版本的原生变体，以及四个
DeepSeek Harness bundle。同一组经过验证的 core artifact 还会生成 ZCode marketplace archive。

## Package 集合

| 安装别名 | 发布版本 | 平台 |
| --- | --- | --- |
| `@xuanling-rs/xuanling-mcp` | `0.4.0` | 稳定 Node.js 启动器 |
| `@xuanling-rs/xuanling-mcp-darwin-arm64` | `0.4.0-darwin-arm64` | macOS Apple Silicon |
| `@xuanling-rs/xuanling-mcp-linux-x64-gnu` | `0.4.0-linux-x64-gnu` | Linux x64，glibc 2.35 或更高版本 |
| `@xuanling-rs/xuanling-mcp-win32-x64-msvc` | `0.4.0-win32-x64-msvc` | Windows x64 MSVC |

启动器与原生变体都发布在 `@xuanling-rs` npm organization 下。稳定 package 通过 optional
dependency 的 npm alias 引用原生变体，npm 根据 `os`、`cpu` 和 `libc` metadata 选择兼容版本。本发行版
不发布 Intel macOS、ARM Linux、glibc 2.34 及更早版本、musl Linux 或 ARM Windows。

DeepSeek Harness 会把以下公开 bundle 直接安装到指定 profile：

| Package | 作用 |
| --- | --- |
| `@xuanling-rs/xuanling-dsh-memory@0.4.0` | 带 DSH schema projection 的完整 Memory v2 profile |
| `@xuanling-rs/xuanling-dsh-skills@0.4.0` | 文件与 Memory 工作流 Skill 以及严格 overwrite policy |
| `@xuanling-rs/xuanling-dsh-tools@0.4.0` | 增量挂载完整 XuanLing catalog |
| `@xuanling-rs/xuanling-dsh-tools-replace@0.4.0` | 显式启用的同名文件系统 replacement facade，提供 XuanLing CAS/batch 与宿主原生投影 |

三个工具 bundle 在同一 DSH profile 内精确依赖稳定版 `@xuanling-rs/xuanling-mcp`。Skills bundle 不包含
MCP runtime。

## 安装

```sh
npm install --global @xuanling-rs/xuanling-mcp@0.4.0
xuanling-mcp --workspace-root /absolute/path/to/project
```

MCP Host 也可以通过 `npx` 固定同一发行版本：

```json
{
  "mcpServers": {
    "xuanling": {
      "command": "npx",
      "args": [
        "-y",
        "@xuanling-rs/xuanling-mcp@0.4.0",
        "--workspace-root",
        "/absolute/path/to/project"
      ]
    }
  }
}
```

完整 capability 合同见 [MCP 集成指南](../docs/guides/xuanling-mcp-integration.md)。

## 分发保证

- 安装过程不运行 `postinstall`，不编译 Rust，也不从远程 URL 下载二进制文件。
- 启动器解析原生 optional dependency，校验平台 metadata 与 SHA-256，并透传 argv、stdio、
  signal 和退出状态。
- Linux artifact 固定在 `ubuntu-22.04` 构建，以保持 glibc 2.35 基线。
- 每个原生 package 都记录显式 release-trust 状态，发布时强制生成 npm provenance，并用
  source commit 与 binary SHA-256 绑定构建结果。ZCode marketplace archive 在 promotion 前还会
  生成 GitHub OIDC build-provenance attestation。
- XuanLing 0.4.0 不声明 Developer ID 或 Authenticode 发布者签名。后续版本可以增加这些签名，
  但缺少平台发布者证书不改变 MCP 协议或 package 完整性合同。
- 每个原生 package 都包含 XuanLing MIT 许可证和生成的第三方 notices。
- 启动器 package 同时包含相互匹配的英文与简体中文 README。

## 本地验证

所有命令都从仓库根目录执行：

```sh
npm --prefix npm run check
npm --prefix npm run check:docs
npm --prefix npm test

node npm/scripts/pack-dsh-bundles.mjs \
  --out npm/dist/dsh \
  --commit "$(git rev-parse HEAD)"
node npm/scripts/verify-dsh-release-set.mjs \
  --root npm/dist/dsh \
  --version 0.4.0 \
  --commit "$(git rev-parse HEAD)"

node npm/scripts/generate-third-party-licenses.mjs \
  --target aarch64-apple-darwin \
  --output /tmp/xuanling-third-party.txt
cargo build --locked --release --target aarch64-apple-darwin -p xuanling-mcp
node npm/scripts/smoke-mcp.mjs \
  --binary target/aarch64-apple-darwin/release/xuanling-mcp
```

完整本机 tarball 路径如下：

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

CI 在三个支持平台分别构建并验证启动器与原生 tarball。安装后的 launcher 必须通过 MCP
`initialize`、遍历分页 `tools/list` 得到的完整 42 工具目录，以及 `system_info` smoke。

## 发布

根 `Cargo.toml` 的 workspace version 是规范发行版本。发布前必须满足：

1. npm metadata、测试、Node syntax check 与 `git diff --check` 全部通过。
2. 三个平台的 locked release binary、第三方 notices、package metadata、tarball 内容和
   integrity 检查全部通过。
3. `verify-release-set.mjs` 与 `verify-dsh-release-set.mjs` 观察到来自同一 commit 的八个
   npm item。
4. 生成的 ZCode tree/archive 通过精确文件、release-trust metadata、package hash、source commit、
   确定性 digest 与 GitHub artifact attestation 校验。
5. release commit 已进入 `origin/main`；GitHub `zcode-packer` Environment 中的
   `ZCODE_REPOSITORY` 必须为 `umbrella22/xuanling-zcode-marketplace`，并提供对该仓库具有
   authenticated push 权限的 `XL_PUBLISH_TOKEN`；target 默认分支必须为 `main`。
6. 先从 `main` 手动运行 workflow，在不创建 tag 的情况下验证 npm package 可见性与 ZCode
   target 权限。
7. 创建稳定 tag `xuanling-mcp-v<version>`，触发
   [npm-publish.yml](../.github/workflows/npm-publish.yml)。

发布 workflow 按顺序发布三个原生版本、稳定 launcher 和四个 DSH bundle。八项 registry
integrity 全部对账后，workflow 使用 Environment credential checkout
`umbrella22/xuanling-zcode-marketplace`，提交经过验证的 ZCode tree，并以一次原子 push 更新
`main` 与 `xuanling-mcp-v<version>`。已存在且 tree 相同的 tag 会幂等跳过；任何 integrity 或
tree 冲突都会硬失败。本地执行 `npm publish` 不属于正式发布路径。

### Trusted Publishing

八个 package 名称都已经存在，正式 workflow 通过 `npmjs` GitHub environment 使用 npm Trusted
Publishing 发布。不需要长期 npm token 或 bootstrap secret。请为八个 scoped package 逐个配置
package-level Trusted Publishing：

```text
GitHub owner: umbrella22
Repository: xuanling
Workflow: npm-publish.yml
Environment: npmjs
Allowed action: npm publish
```

保持 tag、commit 和 artifact 不变，重跑失败的 publish job。幂等发布器会跳过所有 integrity
已匹配的 item。

## 失败恢复

- 任何 package 发布前发生构建失败时，修复问题、升级版本并创建新 tag。已经产生 npm 版本的
  release tag 不得移动。
- 发布在部分 item 已进入 npm 后停止时，保留 tag 与 artifact，修复外部前置条件后重跑；已匹配
  item 会跳过，并从首个缺失 item 恢复。
- Registry 对账成功但 ZCode promotion 失败时，修复 `zcode-packer` token 或目标仓库配置，
  使用同一 source run 和 artifact digest 重跑 promotion 路径。
- 已存在版本的 integrity 不同属于硬失败；已发布版本不可变。
- 已安装 launcher 报告 optional dependency 缺失时，重新安装固定版本。launcher 不会自行
  下载或编译原生 binary。

`publish-idempotent.mjs` 默认指向 npmjs。Registry 模拟测试可以传入
`--registry http://127.0.0.1:4873`，生产 workflow endpoint 不会改变。
