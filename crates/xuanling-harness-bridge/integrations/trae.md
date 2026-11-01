# Trae as controller (controller-only)

`verified: false — configuration syntax only; live host journey not executed (W3)`

Trae CN is **controller-only**. It has no bridge worker adapter: the installed
`marscode` / `trae-cn` executables are IDE launchers, and the
`modules/ai-agent/bin/agent-tool-host` entry point is not a non-interactive task
runner (see plan appendix A.5). Do not configure `adapter: "trae"`; only
`codex`, `claude`, `dsh` and `zcode` are worker adapters.

Build the bridge first with `cargo build -p xuanling-harness-bridge`.

## MCP server entry

The exact Trae MCP settings file path is not verified in this checkout. Mount the
bridge through Trae's MCP settings UI (or its current MCP configuration file if
the host exposes one) using the standard local-stdio entry shape:

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

- Mount point: Trae's MCP settings UI / host configuration file. The exact file
  location is **unknown and unverified** here; do not treat the JSON above as a
  confirmed Trae path.
- Tool naming is host-owned; confirm that `harness_health`, `harness_submit`,
  `harness_wait` and `harness_cancel` appear after the host connects.
- This is controller mounting only. Trae does not run as a worker, so any
  journey needs one of the four configured worker adapters.

## Minimal journey

1. `harness_health` with `{}`. Keep `instance_id`.
2. `harness_submit` with a configured worker adapter, for example:
   ```json
   {
     "instance_id": "<instance_id from health>",
     "request_id": "trae-journey-1",
     "adapter": "codex",
     "workspace_id": "default",
     "prompt": "Reply with exactly: OK",
     "save_result": false
   }
   ```
3. `harness_wait` with `{"job_id": "<job_id>"}`, or a bounded
   `wait_ms` window repeated until `state` is `final`.
4. Inspect `status`, `worker_final_output`, `output_complete` and `cleanup`.

If Trae cannot keep a long MCP tool call open, use a `wait_ms` window and call
`harness_wait` again; the worker keeps running between calls.
