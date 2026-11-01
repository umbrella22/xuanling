# @xuanling-rs/harness-bridge

XuanLing 结果桥的启动包。bridge 本身是普通 stdio MCP server；该 npm 包只负责
解析原生 `harness-bridge` 可执行文件并通过无 shell 的方式启动。

> 状态：仅本地 workspace 打包，尚未发布。当前请使用本地 Cargo 构建。平台二进制
> 包属于后续发布工作。

## 使用

```sh
npx @xuanling-rs/harness-bridge --config /absolute/path/to/bridge-config.json
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
数据库或进程面板。详见 crate 文档。crate 当前不发布、不签名；平台二进制包是
后续发布工作，因此在平台包存在前本启动包不声明 `optionalDependencies`。

## License

MIT
