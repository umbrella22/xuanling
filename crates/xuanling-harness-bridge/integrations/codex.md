# Codex as controller

`verified: false — configuration syntax only; live host journey not executed (W3)`

Codex CLI is a controller here: it mounts the bridge as one MCP server through
its user configuration. A worker is a separately configured CLI selected by
`harness_submit.adapter` (for example `codex` for a nested Codex run). Build the
bridge first with `cargo build -p xuanling-harness-bridge`.

## MCP server entry

Codex configuration is TOML. Add one server entry to the user config:

```toml
# ~/.codex/config.toml
[mcp_servers.harness_bridge]
command = "/absolute/path/to/harness-bridge"
args = [
  "--config",
  "/absolute/path/to/bridge-config.json"
]
```

- Mount point: `~/.codex/config.toml`.
- The project-local `.codex/config.toml` form is Codex-version dependent and is
  not verified here; use the user-level file above for the first journey.
- Tool names should appear as `mcp__harness_bridge__<tool>`; confirm the exact
  names in the host tool list because display naming is host-owned.

## Minimal journey

1. `harness_health` with `{}`. Keep `instance_id` for this bridge process.
2. `harness_submit`:
   ```json
   {
     "instance_id": "<instance_id from health>",
     "request_id": "codex-journey-1",
     "adapter": "codex",
     "workspace_id": "default",
     "prompt": "Reply with exactly: OK",
     "save_result": false
   }
   ```
   Keep the returned `job_id`.
3. `harness_wait` with `{"job_id": "<job_id>"}`. If the host limits one tool
   call, call it again with a `wait_ms` window such as `30000` and repeat until
   `state` is `final`. Ending one wait does not stop the worker.
4. Inspect `result.worker_final_output`, `result.status`,
   `result.output_complete` and `result.cleanup`.

There is no default task deadline or budget. The bridge does not approve Codex
prompts or continue a worker that needs input.
