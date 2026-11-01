# DSH as controller

`verified: false — configuration syntax only; live host journey not executed (W3)`

DeepSeek Harness (DSH) is a controller here. DSH does not use an `mcpServers`
JSON file; it mounts MCP servers as `@deepseek-ai/dsh-mcp-client` rows in the
selected Cordis profile. A worker is selected by `harness_submit.adapter` (for
example `dsh`). Build the bridge first with
`cargo build -p xuanling-harness-bridge`.

## MCP server entry

Persistent profile patch:

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
# Default DSH_HOME is ~/.dsh; for `dsh web` the profile is usually `web`.
- insert:
    - id: harness-bridge
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: harness_bridge
        transport: stdio
        command: /absolute/path/to/harness-bridge
        args:
          - '--config'
          - /absolute/path/to/bridge-config.json
        # Optional: DSH's own tools/call timeout defaults to 60 s. Raise it if
        # the controller should hold one long harness_wait, or use wait_ms below
        # and call harness_wait again. This is a host RPC timeout, not a bridge
        # task deadline.
        toolCallTimeoutMs: 3600000
```

- Mount point: `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (default
  `~/.dsh/profiles/<profile>/cordis.patch.yml`). Merge the `insert` row into the
  existing patch layer; do not replace unrelated user configuration.
- One-shot launch alternative: pass a patch file with `dsh --patch <file>`; the
  persistent profile file is the normal mount point.
- DSH exposes the tools as `mcp__harness_bridge__<tool>`.

## Minimal journey

1. `harness_health` with `{}`. Keep `instance_id`.
2. `harness_submit`:
   ```json
   {
     "instance_id": "<instance_id from health>",
     "request_id": "dsh-journey-1",
     "adapter": "dsh",
     "workspace_id": "default",
     "prompt": "Reply with exactly: OK",
     "save_result": false
   }
   ```
3. `harness_wait` with `{"job_id": "<job_id>"}`. Under the default 60-second DSH
   tool-call timeout, prefer `{"job_id": "<job_id>", "wait_ms": 30000}` and repeat
   while the result is `pending`.
4. Inspect `status`, `worker_final_output`, `output_complete` and `cleanup`.

DSH's `dsh-mcp-client` reconnect behavior is host configuration; it does not
make bridge jobs durable. A new bridge process still loses old jobs
(`JOB_CONTEXT_LOST`).
