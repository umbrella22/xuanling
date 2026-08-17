# XuanLing ZCode Marketplace

[English](README.md) | 简体中文

本仓库是 XuanLing MCP 的不可变 ZCode 分发面。在 ZCode 中将
`umbrella22/xuanling-zcode-marketplace` 添加为 GitHub marketplace source，然后通过
ZCode 插件管理器安装 `xuanling-mcp`。

canonical `umbrella22/xuanling` tag workflow 直接执行每次 promotion。它会核对 source
tag/commit、npm package 签名与哈希、marketplace archive digest 和生成 tree digest，全部通过后
以一次原子 push 更新 `main` 并创建对应的不可变 `xuanling-mcp-v<version>` tag。本仓库不包含
release workflow 或构建流水线。

插件为自包含分发，不依赖全局 npm 安装，安装期间也不会下载 binary。支持 macOS ARM64、
Linux x64 glibc 2.35 或更高版本，以及 Windows x64。

运行配置和安全边界见插件内置 README。XuanLing 使用 MIT License。
