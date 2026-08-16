# XuanLing MCP for ZCode

English | [Simplified Chinese](README-ZH.md)

This directory is the canonical ZCode marketplace source for the self-contained
`xuanling-mcp` 0.2.1 plugin. The installed copy is managed by ZCode; repository
release scripts never edit the ZCode plugin cache directly.

## Runtime Paths

The plugin exposes one XuanLing MCP server through two equivalent launch paths:

- `.zcode-plugin/plugin.json` is the canonical marketplace manifest. It starts
  the bundled native binary and passes the current project as
  `--workspace-root`.
- `.mcp.json` is the Node.js launcher compatibility mirror. It applies the same
  workspace capability and the ZCode-specific object-parameter compatibility
  mode.

Both paths resolve files relative to the plugin root and use the same
`xuanling-mcp` version. `npm/test/zcode-plugin-contract.test.mjs` verifies that
the manifests and repository package versions remain aligned.

## Included Components

| Path | Purpose |
| --- | --- |
| `.zcode-plugin/plugin.json` | Canonical ZCode plugin and inline MCP server manifest |
| `.mcp.json` | Compatibility launcher configuration |
| `bin/node_modules/xuanling-mcp` | Node.js launcher runtime |
| `bin/node_modules/xuanling-mcp-darwin-arm64` | Bundled native binary, licenses, and third-party notices |
| `skills/xuanling-mcp-tools/SKILL.md` | Tool usage, Memory proposal/review, output, and process guidance |
| `scripts/sync-binary.mjs` | Rebuilds the self-contained runtime from verified npm staging |

The vendored runtime excludes package-manager lock metadata and dependency
READMEs. Those files are not used by either launch path; the plugin-level
English and Simplified Chinese READMEs are the user-facing documentation.
License and third-party notice files remain in the runtime payload.

## Updating the Runtime

Create and verify the npm staging tree before synchronizing the plugin:

```sh
node integrations/zcode-plugin/plugins/xuanling-mcp/scripts/sync-binary.mjs \
  --source /absolute/path/to/verified/node_modules
```

The script derives the repository and plugin roots from its own location,
replaces only `bin/node_modules`, and prunes non-runtime package-manager and
README files. It does not install or update the user's ZCode cache.

## Verification

```sh
node --test npm/test/zcode-plugin-contract.test.mjs
```

The contract verifies version alignment, manifest parity, workspace capability
arguments, Memory v2 Skill terminology, and the cleaned vendored payload.

## Security Boundary

`--workspace-root` constrains paths opened by XuanLing filesystem tools. It is
not a process sandbox. ZCode remains responsible for tool approval, and child
process isolation requires an OS sandbox or container when hostile execution
is possible.
