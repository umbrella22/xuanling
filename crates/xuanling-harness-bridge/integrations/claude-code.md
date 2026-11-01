# Claude Code as controller

`verified: false — configuration syntax only; live host journey not executed (W3)`

Claude Code is a controller here: it mounts the bridge as one project-scoped MCP
server. A worker is a separately configured CLI selected by
`harness_submit.adapter` (for example `claude`). Build the bridge first with
`cargo build -p xuanling-harness-bridge`.

## MCP server entry

Claude Code reads project-scoped MCP servers from `.mcp.json` at the project
root:

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
- The user-scoped configuration managed by `claude mcp add` is host-version
  dependent and is not verified here.
- Tool names follow the host's `mcp__<server>__<tool>` convention; confirm the
  exact names in the tool list.

## Minimal journey

1. `harness_health` with `{}`. Keep `instance_id`.
2. `harness_submit`:
   ```json
   {
     "instance_id": "<instance_id from health>",
     "request_id": "claude-journey-1",
     "adapter": "claude",
     "workspace_id": "default",
     "prompt": "Reply with exactly: OK",
     "save_result": false
   }
   ```
3. `harness_wait` with `{"job_id": "<job_id>"}` or a bounded
   `{"job_id": "<job_id>", "wait_ms": 30000}` window. Repeat the call while the
   response is `pending`; a wait-window end does not stop the worker.
4. Inspect the final `status`, `worker_final_output`, `output_complete` and
   `cleanup`.

Claude's own account/credential availability is a worker-side prerequisite. The
bridge does not read Claude credentials, approve prompts, or bypass
`permission_mode`.
