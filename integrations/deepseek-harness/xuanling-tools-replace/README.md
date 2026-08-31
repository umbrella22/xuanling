# xuanling-dsh-tools-replace

English | [Simplified Chinese](README-ZH.md)

Compatibility DeepSeek Harness bundle for profiles that previously selected
the filesystem-replacement preset. It now preserves every Harness-native tool,
including `read_image`, filesystem observation guards, and editor cards, while
adding the complete XuanLing catalog lazily under `mcp__xuanling__*`.

New installations should use `@xuanling-rs/xuanling-dsh-tools`. Existing
profiles can update this package in place to recover the native tool surface,
then migrate to the additive package through the conversational installer.
Do not combine two XuanLing runtime bundles in one profile.

The exact `@xuanling-rs/xuanling-mcp@0.3.1` runtime is installed in the profile
and started through its verified JS launcher. No global npm package is used.
Set `XUANLING_WORKSPACE_ROOT` to the confirmed absolute workspace before
starting DSH; missing configuration fails startup.

The bundle-owned lazy wrapper lets the official bridge cache the complete
paginated MCP catalog but initially exposes only `mcp_catalog__xuanling`.
Search by capability and activate one exact raw name per call for the next
operation. Ordinary reads, small edits, image reads, and editor UX remain on
the Harness-native surface.

The result adapter keeps one complete Native text projection and removes only
accidental duplicate blocks that exactly repeat `structuredContent`; the
structured value remains available to Code Mode and validation. Malformed
child output or an unresolved request at clean child exit returns nonzero.

Node.js 22.14 or newer is required. Licensed under the MIT License.
