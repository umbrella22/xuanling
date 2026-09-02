# XuanLing MCP Replacement for ZCode

This is the opt-in replacement variant of the XuanLing ZCode plugin. It starts the same
cross-platform MCP v3 server as `xuanling-mcp`, then adds a `PreToolUse` policy that blocks ZCode's
native `Read`, `Write`, `Edit`, `ApplyPatch`, and `MultiEdit` paths. XuanLing overwrite, replace,
edit, batch, and patch calls must carry a lowercase SHA-256 precondition.

ZCode 3.10.2 exposes this plugin's MCP tools with the
`mcp__plugin_xuanling-mcp-replace_xuanling__` prefix. Workflow names such as `fs_hash` below refer
to the suffix of that host-qualified tool name.

Install only one XuanLing variant at a time. Disable or uninstall `xuanling-mcp` before enabling
`xuanling-mcp-replace`; disabling this plugin removes its hook and restores ZCode's native file
tools. The additive `xuanling-mcp` plugin remains the default choice.

## Runtime

Install `xuanling-mcp-replace` from the
[`umbrella22/xuanling-zcode-marketplace`](https://github.com/umbrella22/xuanling-zcode-marketplace)
marketplace. The release contains its matching native runtime and does not require a global npm
installation. ZCode must provide Node.js 18.17 or newer.

## Enforced workflow

1. Read existing UTF-8 text with `fs_read_text`, or obtain a fingerprint with `fs_hash` when a
   semantic read is not required.
2. Pass the current hash to `expected_sha256` for overwrite, replace, edit, and every batch file;
   pass it as `expected_preimage_sha256` for patch.
3. Keep `include_diff=true` on edit calls. If a formatter or other writer changes a file, read or
   hash it again before constructing the next mutation.

`fs_write_text` with `mode=create` is the sole mutation that may omit a hash. The hook checks that
the precondition is present and well formed; XuanLing performs the authoritative path, UTF-8,
matching, and current-content checks.

## Host capability limits

The hook denies execution but does not hide native tool names from ZCode's tool list. MCP diff
data remains available with `include_diff=true`, but a native ZCode diff card is not guaranteed.
Because native `Read` is blocked, host-native image rendering is also unavailable in replacement
mode. These are host capability limits, not replacement guarantees.
