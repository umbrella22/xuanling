# XuanLing MCP npm 分发

[English](README.md) | 简体中文

本目录维护 `xuanling-mcp` 0.2.1 的 npm 分发与发布自动化。一个稳定的 Node.js 启动器和
三个使用平台 prerelease 版本的原生变体共同组成完整发行版。

## Package 集合

| 安装别名 | 发布版本 | 平台 |
| --- | --- | --- |
| `xuanling-mcp` | `0.2.1` | 稳定 Node.js 启动器 |
| `xuanling-mcp-darwin-arm64` | `0.2.1-darwin-arm64` | macOS Apple Silicon |
| `xuanling-mcp-linux-x64-gnu` | `0.2.1-linux-x64-gnu` | Linux x64，glibc 2.35 或更高版本 |
| `xuanling-mcp-win32-x64-msvc` | `0.2.1-win32-x64-msvc` | Windows x64 MSVC |

四个变体都使用 npm package 名 `xuanling-mcp`。稳定 package 通过 optional dependency 的
npm alias 引用原生变体，npm 根据 `os`、`cpu` 和 `libc` metadata 选择兼容版本。本发行版
不发布 Intel macOS、ARM Linux、glibc 2.34 及更早版本、musl Linux 或 ARM Windows。

## 安装

```sh
npm install --global xuanling-mcp@0.2.1
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
        "xuanling-mcp@0.2.1",
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
- 每个原生 package 都包含双许可证文件和生成的第三方 notices。
- 启动器 package 同时包含相互匹配的英文与简体中文 README。

## 本地验证

所有命令都从仓库根目录执行：

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
`initialize`、包含 42 个工具的 `tools/list` 和 `system_info` smoke。

## 发布

根 `Cargo.toml` 的 workspace version 是规范发行版本。发布前必须满足：

1. npm metadata、测试、Node syntax check 与 `git diff --check` 全部通过。
2. 三个平台的 locked release binary、第三方 notices、package metadata、tarball 内容和
   integrity 检查全部通过。
3. `verify-release-set.mjs` 观察到一个 launcher 和三个来自同一 commit 的原生 package。
4. release commit 已进入 `origin/main`。
5. 创建稳定 tag `xuanling-mcp-v<version>`，触发
   [npm-publish.yml](../.github/workflows/npm-publish.yml)。

发布 workflow 先上传原生变体，最后上传稳定 launcher。它拒绝使用不同 integrity 覆盖已有
版本。本地执行 `npm publish` 不属于正式发布路径。

### 首次发布

新 package 名出现前，npm 无法绑定 Trusted Publisher。仅首次发布需要在 GitHub `npmjs`
environment 中配置短期 `NPM_BOOTSTRAP_TOKEN`，workflow 使用它发布第一个原生变体。package
出现在 npm 后，使用以下信息配置 Trusted Publishing：

```text
GitHub owner: umbrella22
Repository: xuanling
Workflow: npm-publish.yml
Environment: npmjs
Allowed action: npm publish
```

保持 tag、commit 和 artifact 不变，重跑失败的 publish job。幂等发布器会跳过 integrity 已匹配
的变体。OIDC 发布成功后删除 bootstrap secret，并撤销短期 token。

## 失败恢复

- 任何 package 发布前发生构建失败时，修复问题、升级版本并创建新 tag。已经产生 npm 版本的
  release tag 不得移动。
- bootstrap 成功但 OIDC 失败时，绑定 Trusted Publisher 后使用同一 artifact 重跑同一 job。
- 已存在版本的 integrity 不同属于硬失败；已发布版本不可变。
- 已安装 launcher 报告 optional dependency 缺失时，重新安装固定版本。launcher 不会自行
  下载或编译原生 binary。

`publish-idempotent.mjs` 默认指向 npmjs。Registry 模拟测试可以传入
`--registry http://127.0.0.1:4873`，生产 workflow endpoint 不会改变。
