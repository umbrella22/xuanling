# xuanling-dsh-tools

English | [Simplified Chinese](README-ZH.md)

Additive DeepSeek Harness bundle for the complete XuanLing MCP catalog. It
keeps all Harness-native tools enabled and adds XuanLing tools under the
`mcp__xuanling__` prefix.

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-tools@0.2.4
```

This command augments DSH's shipped Web profile. Use `--profile headless` for
the shipped Headless profile. Unknown profile names start with the base bundle
only and do not provide a runnable Web or Headless application by themselves.

The exact `@xuanling-rs/xuanling-mcp@0.2.4` runtime is installed in the profile and started
through its verified JS launcher. A global npm package is neither required nor
used. Set `XUANLING_WORKSPACE_ROOT` only when the filesystem capability root
must differ from the DSH working directory.

The bundle's result adapter preserves the complete Native text projection and
removes only accidental duplicate text blocks that exactly repeat
`structuredContent`.

The adapter accepts only JSON object frames from the child. Malformed output or
an unresolved request at clean child exit returns a nonzero status; host
termination is forwarded and force-terminated after a 500 ms grace when needed.

This package overlaps with native file, process, and project tools. Prefer
`@xuanling-rs/xuanling-dsh-memory` for the smaller daily tool surface. Do not install this
package with another XuanLing tool bundle in the same profile.

Node.js 22.14 or newer is required. Licensed under the MIT License.
