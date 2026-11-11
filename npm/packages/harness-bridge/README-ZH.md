# @xuanling-rs/harness-bridge

XuanLing 结果桥的启动包。bridge 本身是普通 stdio MCP server；该 npm 包只负责
解析原生 `harness-bridge` 可执行文件并通过无 shell 的方式启动。

npm 发行版包含 macOS Apple Silicon、Linux x64（glibc 2.35+）和 Windows x64
平台包，启动器自动安装匹配的二进制。Bridge 仍处于实验阶段；包已发布不等于所有
worker、控制端和真实依赖场景均已通过验收。

## 使用

```sh
npx @xuanling-rs/harness-bridge@0.11.2 --config /absolute/path/to/bridge-config.json
```

在仓库中先构建：

```sh
cargo build -p xuanling-harness-bridge
node npm/packages/harness-bridge/bin/harness-bridge.js --config /absolute/path/to/bridge-config.json
```

stdout 只承载 MCP framing；诊断走 stderr（`HARNESS_BRIDGE_LOG`，默认 `warn`）。

## 二进制解析顺序

1. `HARNESS_BRIDGE_BIN`（绝对路径，或相对当前目录）。
2. 已安装的平台包 `@xuanling-rs/harness-bridge-<target>`，且 manifest 带
   `harnessBridgeBinary`/`xuanlingBinary` 元数据。
3. 当前 checkout 的本地 Cargo 构建：优先 `target/release`，其次
   `target/debug`（也支持 `CARGO_TARGET_DIR`）。
4. `PATH` 中的 `harness-bridge`。

找不到时直接报错，不会静默执行别的二进制。

## 边界

bridge 只运行一个已配置的原生 worker 并返回最终回答与终态，不是调度器、任务
数据库或进程面板。Rust crate 未发布到 crates.io，原生可执行文件没有 Developer ID
或 Authenticode 签名。Codex worker 固定使用 `--ephemeral`，Claude worker 固定
使用 `--no-session-persistence`。DSH、ZCode worker 当前返回
`NATIVE_SESSION_PERSISTENCE_UNSUPPORTED`；DSH 仍可作为控制端。单独的本地 DSH
适配插件不包含在此次 npm 发行版中。

## 维护者发布

`.github/workflows/harness-bridge-npm.yml` 在三个原生 runner 上构建四个发布包。
推送版本 tag 仅生成产物，首次发布使用 npm CLI 的浏览器认证。后续自动发布需在
**全部四个** npm 包上配置 GitHub Actions Trusted Publisher：owner 为
`umbrella22`，repository 为 `xuanling`，workflow 为 `harness-bridge-npm.yml`，
environment 为 `npmjs`。配置完成后，在对应 release tag 手动运行工作流并设置
`publish: true`，即可带 provenance 发布。平台包先于启动器上传，使用
`platform-<target>` 标签。

## License

MIT
