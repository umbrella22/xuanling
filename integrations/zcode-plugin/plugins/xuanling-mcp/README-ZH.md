# XuanLing MCP for ZCode

[English](README.md) | 简体中文

本目录是自包含 `xuanling-mcp` 0.2.1 插件的 canonical ZCode marketplace source。
安装副本由 ZCode 管理；仓库发布脚本不会直接修改 ZCode plugin cache。

## 运行路径

插件通过两条等价启动路径暴露同一个 XuanLing MCP Server：

- `.zcode-plugin/plugin.json` 是 canonical marketplace manifest。它启动随插件分发的原生
  binary，并将当前项目作为 `--workspace-root` 传入。
- `.mcp.json` 是 Node.js launcher compatibility mirror。它应用相同的 workspace
  capability 和 ZCode 专用 object parameter 兼容模式。

两条路径都相对 plugin root 解析文件，并使用同一 `xuanling-mcp` 版本。
`npm/test/zcode-plugin-contract.test.mjs` 验证 manifest 与仓库 package 版本保持一致。

## 包含组件

| 路径 | 作用 |
| --- | --- |
| `.zcode-plugin/plugin.json` | Canonical ZCode plugin 与 inline MCP Server manifest |
| `.mcp.json` | Compatibility launcher 配置 |
| `bin/node_modules/xuanling-mcp` | Node.js launcher runtime |
| `bin/node_modules/xuanling-mcp-darwin-arm64` | 随包原生 binary、许可证与第三方 notices |
| `skills/xuanling-mcp-tools/SKILL.md` | 工具用法、Memory proposal/review、输出与进程指导 |
| `scripts/sync-binary.mjs` | 从已验证 npm staging 重建自包含 runtime |

Vendored runtime 不保留 package-manager lock metadata 与 dependency README。两条启动路径都
不会使用这些文件；plugin 级英文和简体中文 README 是用户文档入口。许可证与第三方 notices
继续保留在 runtime payload 中。

## 更新 Runtime

同步插件前先生成并验证 npm staging tree：

```sh
node integrations/zcode-plugin/plugins/xuanling-mcp/scripts/sync-binary.mjs \
  --source /absolute/path/to/verified/node_modules
```

脚本根据自身位置推导仓库与 plugin root，只替换 `bin/node_modules`，随后裁剪非运行时的
package-manager 与 README 文件。它不会安装或更新用户的 ZCode cache。

## 验证

```sh
node --test npm/test/zcode-plugin-contract.test.mjs
```

合同测试验证版本一致性、manifest parity、workspace capability 参数、Memory v2 Skill 术语和
清理后的 vendored payload。

## 安全边界

`--workspace-root` 约束 XuanLing 文件工具打开的路径，但不是进程 sandbox。工具审批仍由
ZCode 负责；可能执行恶意代码时，子进程隔离需要 OS sandbox 或 container。
