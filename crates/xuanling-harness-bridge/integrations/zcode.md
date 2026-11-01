# ZCode as controller

`verified: false — configuration syntax only; live host journey not executed (W3)`

ZCode is a controller here: it mounts the bridge as one MCP server in the
project. A worker is selected by `harness_submit.adapter` (for example `zcode`
for a nested ZCode CLI run). Build the bridge first with
`cargo build -p xuanling-harness-bridge`.

## MCP server entry

ZCode project MCP configuration uses the standard `mcpServers` object in
`.mcp.json` (the same file shape used by ZCode plugin bundles):

```json
{
  "mcpServers": {
    "harness-bridge": {
      "command": "/absolute/path/to/harness-bridge",
      "args": [
        "--config",
        "/absolute/path/to/bridge-config.json"
      ]
    }
  }
}
```

- Mount point: `<project-root>/.mcp.json`.
- Plugin-packaged MCP servers may be displayed with a plugin prefix; confirm the
  exact four tool names in ZCode's current tool list. The repository's XuanLing
  plugin documentation records ZCode 3.10.2 as a validated host for that
  plugin's naming, not for this bridge.
- The bridge itself is a plain stdio MCP server; no ZCode marketplace entry is
  published by the bridge plan.

## Required ZCode provider-config environment

The installed `zcode.cjs` requires **both** variables:

- `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
- `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`

The CLI resolver throws `无法定位 CLI ZCode Built-in Provider Config` when they
are missing. The bridge clears the child environment, so these names must exist
in the bridge process environment *and* be listed in the bridge config. The
ZCode host normally exports both; `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` points
at `~/.zcode/v2/provider_config.json`, a credentials-bearing file.

```json
{
  "env_allowlist": [
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"
  ],
  "secret_env": [
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"
  ]
}
```

The bridge forwards the names and values only. It never opens, reads or parses
the provider-config file; the ZCode CLI resolves and reads it. `secret_env` is
listed here so the path values are redacted if they appear in worker text.

Provider selection is owned by the ZCode CLI configuration; the bridge does not
override it. The headless CLI does not resolve the account-provider
`defaultModelSelection` (`account:bigmodel-individual-coding-plan`) and falls
back to the first personal provider. For the BigModel coding plan, configure a
**personal API-key provider** in the ZCode model settings:

- API type: `anthropic-messages`
- Base URL: `https://open.bigmodel.cn/api/anthropic`
- Model: `GLM-5.3-Flash` (select it as the default)
- API key: the BigModel coding-plan key (the bridge never reads it)

With both provider-config variables forwarded and that personal provider
selected, the bridge's `live_zcode` success test passed on 2026-10-28 with final
answer `OK`, `output_complete=true` and `cleanup.confirmed=true`. The controller
host journey (mounting the bridge inside ZCode) is still W3 work and is not
claimed by this worker-adapter evidence.

## Minimal journey

1. `harness_health` with `{}`. Keep `instance_id`.
2. `harness_submit`:
   ```json
   {
     "instance_id": "<instance_id from health>",
     "request_id": "zcode-journey-1",
     "adapter": "zcode",
     "workspace_id": "default",
     "prompt": "Reply with exactly: OK",
     "save_result": false
   }
   ```
3. `harness_wait` with `{"job_id": "<job_id>"}` or a bounded window such as
   `{"job_id": "<job_id>", "wait_ms": 30000}`. A wait-window end only stops that
   RPC; call `harness_wait` again for the same job.
4. Inspect `status`, `worker_final_output`, `output_complete` and `cleanup`.

ZCode's worker mode is explicit in the bridge config (`build`, `edit`, `plan` or
`guarded`); `yolo` is refused. The bridge does not proxy ZCode approvals or
continue a worker that needs input. The two provider-config variables above are
a worker-environment prerequisite; forwarding them does not imply that the
account has usable balance.
