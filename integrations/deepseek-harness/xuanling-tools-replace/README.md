# xuanling-dsh-tools-replace

English | [Simplified Chinese](README-ZH.md)

Opt-in DeepSeek Harness filesystem replacement backed by XuanLing MCP. The
bundle disables the native `tool-fs` row and registers `read`, `write`, `edit`,
`read_image`, `file_hash`, and `edit_batch`. Text operations use XuanLing's
cross-platform path, UTF-8, exact-match, SHA-256 CAS, atomic replacement, batch
preflight, and recovery contracts. `read_image` remains the Harness-native
implementation.

The facade does not replace `ctx.fs`. It uses that service to resolve targets,
bind successful XuanLing reads and mutations to the current Harness
`FsVersion`, emit `fs/observed`, and preserve native read/diff cards. Mutations
return `ask` from `tools/pre-execute`; ToolRuntime delegates that decision to
the mounted ApprovalService and fails closed when approval is unavailable.

`read` records the complete body and SHA-256 for exact edits in the same
session. `file_hash` records only a byte fingerprint: it permits a guarded
whole-file `write`, but does not authorize `edit` or `edit_batch`. A formatter
or other external writer invalidates the next CAS; reread or rehash before
continuing. The facade never exposes raw XuanLing mutation names that could
bypass these host policies.

The profile-local `@xuanling-rs/xuanling-mcp@0.4.0` launcher is wrapped by the
bundle result adapter. Set `XUANLING_WORKSPACE_ROOT` to the confirmed absolute
workspace before DSH starts. The facade fails startup when the root, official
MCP bridge, native image tool, or required XuanLing definitions are missing.

Do not combine this package with `@xuanling-rs/xuanling-dsh-tools`; the additive
bundle is still the default for profiles that want Harness-native text tools.
Removing or disabling this package restores the original `tool-fs` row when
the profile patch is recomposed.

Node.js 22.14 or newer is required. Licensed under the MIT License.
