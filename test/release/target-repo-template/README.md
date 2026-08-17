# XuanLing ZCode Marketplace

English | [Simplified Chinese](README-ZH.md)

This repository is the immutable ZCode distribution surface for XuanLing MCP.
Add `umbrella22/xuanling-zcode-marketplace` as a GitHub marketplace source in
ZCode, then install the `xuanling-mcp` plugin through ZCode's plugin manager.

The canonical `umbrella22/xuanling` tag workflow promotes each release directly.
It verifies the source tag and commit, npm package signatures and hashes, the
marketplace archive digest, and the generated tree digest before atomically
updating `main` and creating the matching immutable
`xuanling-mcp-v<version>` tag. This repository contains no release workflow or
build pipeline.

The plugin is self-contained. It does not require a global npm installation and
does not download binaries during installation. Supported targets are macOS
ARM64, Linux x64 glibc 2.35 or newer, and Windows x64.

See the plugin's bundled README for runtime configuration and security
boundaries. XuanLing is licensed under the MIT License.
