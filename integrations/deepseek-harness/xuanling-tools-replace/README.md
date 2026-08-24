# xuanling-dsh-tools-replace

English | [Simplified Chinese](README-ZH.md)

Replacement DeepSeek Harness bundle for the complete XuanLing catalog. It
disables the three model-facing native filesystem rows and exposes XuanLing as
the filesystem layer while retaining shell, web, LSP, approval, PTY, jobs, and
orchestration integrations.

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-tools-replace@0.2.7
```

This command augments DSH's shipped Web profile. Use `--profile headless` for
the shipped Headless profile. Unknown profile names start with the base bundle
only and do not provide a runnable Web or Headless application by themselves.

The exact `@xuanling-rs/xuanling-mcp@0.2.7` runtime is installed in the profile and started
through its verified JS launcher. No global npm package is used.

Its result adapter keeps one complete Native text projection and removes only
accidental duplicate blocks that exactly repeat `structuredContent`; the
structured value remains available to Code Mode and validation.

The adapter accepts only JSON object frames from the child. Malformed output or
an unresolved request at clean child exit returns a nonzero status; host
termination is forwarded and force-terminated after a 500 ms grace when needed.

This variant removes native `read_image`, read-before-edit observation guards,
and editor cards from the model-facing filesystem surface. XuanLing SHA-256
preconditions and strict patch contracts apply instead. Use this package only
when that tradeoff is intentional, and do not combine it with another
XuanLing tool bundle in the same profile.

Node.js 22.14 or newer is required. Licensed under the MIT License.
