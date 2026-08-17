# xuanling-dsh-tools-replace

[English](README.md) | 简体中文

这是完整 XuanLing catalog 的替换式 DeepSeek Harness bundle。它会停用三个模型可见的原生
文件系统工具行，让 XuanLing 成为文件系统层，同时保留 shell、web、LSP、审批、PTY、任务与
编排集成。

```sh
dsh plugin --profile replace add xuanling-dsh-tools-replace@0.2.1
```

精确版本的 `xuanling-mcp@0.2.1` runtime 会安装在 profile 内，并通过带校验的 JS launcher
启动；不会使用全局 npm package。

该变体会从模型可见的文件系统表面移除原生 `read_image`、先读后改 observation guard 和 editor
card，改用 XuanLing SHA-256 前置条件与严格 patch 合同。只有明确接受这一取舍时才应使用，且
不要与另一个 XuanLing 工具 bundle 安装在同一 profile。

要求 Node.js 22.14 或更高版本。使用 MIT License。
