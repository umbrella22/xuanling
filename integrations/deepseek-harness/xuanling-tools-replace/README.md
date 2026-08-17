# xuanling-dsh-tools-replace

English | [Simplified Chinese](README-ZH.md)

Replacement DeepSeek Harness bundle for the complete XuanLing catalog. It
disables the three model-facing native filesystem rows and exposes XuanLing as
the filesystem layer while retaining shell, web, LSP, approval, PTY, jobs, and
orchestration integrations.

```sh
dsh plugin --profile replace add xuanling-dsh-tools-replace@0.2.2
```

The exact `xuanling-mcp@0.2.2` runtime is installed in the profile and started
through its verified JS launcher. No global npm package is used.

This variant removes native `read_image`, read-before-edit observation guards,
and editor cards from the model-facing filesystem surface. XuanLing SHA-256
preconditions and strict patch contracts apply instead. Use this package only
when that tradeoff is intentional, and do not combine it with another
XuanLing tool bundle in the same profile.

Node.js 22.14 or newer is required. Licensed under the MIT License.
