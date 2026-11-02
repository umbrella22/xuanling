# xuanling-harness-bridge

`xuanling-harness-bridge` (binary `harness-bridge`) is a result-only MCP bridge.
A controller harness submits one task; the bridge runs one configured native
worker CLI with a fixed argv, extracts that worker's final answer and native
terminal status, and returns it in an ordinary MCP tool response. The controller
decides whether to accept the answer, continue, re-dispatch or stop.

The bridge is not a scheduler, a job database or a process dashboard. It keeps
no SQLite database, no event file, no progress log and no lease/heartbeat. Its
in-memory job table, request deduplication and active-job limit are scoped to one
bridge process. See
[`docs/plans/harness-bridge-development-plan.md`](../../docs/plans/harness-bridge-development-plan.md)
for the full contract and current evidence status.

> Status: experimental. The npm distribution provides the launcher and native
> binaries; the Rust crate remains unpublished on crates.io, and binaries have
> no platform publisher signatures. The examples in [`integrations/`](integrations/)
> are configuration syntax, not verified live host journeys. See the
> [release boundary](RELEASE-BOUNDARY.md) for the acceptance limits.

## Build and run

```sh
cargo build -p xuanling-harness-bridge
./target/debug/harness-bridge --config /absolute/path/to/bridge-config.json
```

On Windows the binary is `target/debug/harness-bridge.exe`. The binary speaks MCP
over stdio: stdout carries MCP framing only. Diagnostics go to stderr;
`HARNESS_BRIDGE_LOG` sets the tracing filter (default `warn`).

`--config` is optional. Without it the instance starts with no adapters and
still answers `harness_health`; every `harness_submit` then fails with
`ADAPTER_UNAVAILABLE`.

## Configuration

The configuration file is trusted input. It names executables, workspace roots
and environment-variable **names**; it must not contain secret values. All
`program`, `runner`, `script`, `workspaces` and `results_dir` paths are absolute.
The bridge validates them at startup and uses the resolved paths; it never
guesses a `PATH` entry for a worker.

### Example configuration

The repository ships [`config.example.json`](config.example.json); replace every
absolute path (and keep only the adapters you actually use).

```json
{
  "max_active_jobs": 1,
  "max_retained_jobs": 512,
  "max_final_bytes": 1048576,
  "max_diagnostic_bytes": 8192,
  "max_protocol_line_bytes": 4194304,
  "max_protocol_bytes": 8388608,
  "max_prompt_bytes": 1048576,
  "results_dir": "/absolute/path/to/bridge-results",
  "workspaces": {
    "default": "/absolute/path/to/workspace"
  },
  "env_allowlist": [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"
  ],
  "secret_env": [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE"
  ],
  "adapters": {
    "codex": {
      "program": "/absolute/path/to/codex",
      "version": "0.165.0",
      "sandbox": "read-only",
      "skip_git_repo_check": true
    },
    "claude": {
      "program": "/absolute/path/to/claude",
      "version": "2.1.311",
      "permission_mode": "manual",
      "allowed_tools": []
    },
    "dsh": {
      "program": "/absolute/path/to/dsh",
      "version": "0.2.1",
      "profile": "headless"
    },
    "zcode": {
      "runner": "/absolute/path/to/node",
      "script": "/absolute/path/to/zcode.cjs",
      "version": "0.17.0",
      "mode": "plan"
    }
  }
}
```

Field notes:

- `workspaces` maps a controller-visible `workspace_id` to an absolute
  directory. `task_file` paths resolve under the selected root and cannot escape
  it.
- `results_dir` is required only for `save_result: true`. It must be an absolute
  directory; the bridge canonicalizes it at startup and re-checks that the
  resolved path is a real directory when publishing a report.
- `max_protocol_line_bytes` bounds one native NDJSON event. Keep it above
  `max_final_bytes` (the default is 4 MiB vs 1 MiB) so an oversized final answer
  is reported as `RESULT_TOO_LARGE` rather than mistaken for a broken stream.
- `env_allowlist` adds environment-variable names to a fixed baseline allowlist.
  The bridge forwards names, never values, and reads values at spawn time. List a
  provider key here only when the worker needs it in its environment.
- `secret_env` names variables whose **values** the redactor removes from the
  final answer and failure diagnostics. To forward and redact the same key, list
  it in both arrays. The bridge does not read credential files or keychains.
- The ZCode worker requires both `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`. The ZCode CLI resolver fails with
  `无法定位 CLI ZCode Built-in Provider Config` when they are absent, and the
  bridge clears the child environment, so both names must be present in the
  bridge process environment **and** in `env_allowlist`.
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` normally points at
  `~/.zcode/v2/provider_config.json`, a credentials-bearing file. The bridge
  forwards the name and value only; it never opens or parses that file — the
  ZCode CLI reads it.
- `permission_mode` for Claude must be one of `acceptEdits`, `auto`, `manual`,
  `dontAsk`, `plan`; `bypassPermissions` is refused.
- `sandbox` for Codex must be `read-only`, `workspace-write` or
  `danger-full-access`; `read-only` is the default.
- `profile` for DSH must be `headless`.
- `mode` for ZCode must be one of `build`, `edit`, `plan`, `guarded`; `yolo` is
  refused because it bypasses approvals.
- Unknown fields are rejected (`deny_unknown_fields`). The config file is
  limited to 1 MiB.

## MCP tools

The public surface is exactly four tools. There is no status/list/events tool and
no worker-side reply/approve/continue tool.

| Tool | Parameters | Result |
| --- | --- | --- |
| `harness_health` | none (`{}`) | `instance_id`, `bridge_version`, `contract_version`, adapter diagnostics (`configured`, `compatible`, `version`, `non_interactive`, `needs_input`), limits, and capability flags |
| `harness_submit` | `instance_id`, `request_id`, `adapter`, `workspace_id`, exactly one of `prompt` or `task_file`, optional `save_result` (default `false`), optional `deadline_at` (RFC3339, future) | `job_id`, `instance_id`, `status`, `accepted: true`, `reused` |
| `harness_wait` | `job_id`, optional `wait_ms` | `state` (`pending` or `final`), `job_id`, `status`, `elapsed_ms` (this wait call's duration) for pending, and `result` (`FinalResult`) for final |
| `harness_cancel` | `job_id` | `job_id`, `cancelled`, `result` (`FinalResult`) |

A `FinalResult` carries `job_id`, `instance_id`, `request_id`, `harness`,
`adapter_version`, `status`, `worker_final_output`, `output_complete`,
`redacted`, `exit_code`, `error`, `delivery_error`, `cleanup`
(`confirmed`/`detail`), `report_path`, `report_error`, `started_at` and
`finished_at`.

`harness_wait` waits for the job's terminal result. `wait_ms` bounds that single
tool call only; when the window ends the response is a minimal `pending`, the
job keeps running, and the controller may call `harness_wait` again. Cancelling
or ending the wait RPC never stops the worker. Only `harness_cancel` (or an
explicit `deadline_at`, bridge shutdown, or the native terminal state) ends a
job.

Domain failures are returned as structured tool errors with a stable `code` and
a safe `message` (`INVALID_REQUEST`, `INSTANCE_CHANGED`, `REQUEST_CONFLICT`,
`BUSY`, `MEMORY_CAPACITY`, `PATH_OUTSIDE_ROOT`, `TASK_READ_FAILED`,
`ADAPTER_UNAVAILABLE`, `INCOMPATIBLE_CLI`, `AUTH_REQUIRED`, `RATE_LIMIT`,
`WORKER_FAILED`, `NEEDS_INPUT`, `STREAM_INCOMPLETE`, `SPAWN_FAILED`,
`CLEANUP_UNCONFIRMED`, `JOB_NOT_FOUND`, `JOB_CONTEXT_LOST`, `RESULT_TOO_LARGE`,
`REPORT_WRITE_FAILED`, `CONFIG_INVALID`, `DEADLINE_EXCEEDED`, `INTERRUPTED`).
Unknown tools and malformed arguments are MCP `-32602` protocol errors.

### Terminal statuses

| Status | Meaning |
| --- | --- |
| `completed` | The worker produced a native success terminal event, a non-empty final answer and a consistent exit status |
| `failed` | A native failure, spawn failure, execution failure, or a stream that could not be classified as success; inspect `error` and `output_complete` |
| `cancelled` | `harness_cancel` settled the job before completion |
| `timed_out` | Only an explicit `deadline_at` was reached |
| `needs_input` | The adapter recognized a native request for approval or input; the bridge does not answer it |
| `interrupted` | Bridge shutdown or an internal supervisor termination |

`JOB_CONTEXT_LOST` and `INSTANCE_CHANGED` are errors, not statuses: a job or
request from an earlier bridge process is not recoverable, and the bridge does
not replay it.

## Task freezing, instance-scoped deduplication and limits

- `prompt` or `task_file` is read and frozen when the job is accepted. Changing
  the source file afterwards does not change the accepted job. The same
  `request_id` with the same payload reuses the original job and frozen bytes;
  changing any execution parameter returns `REQUEST_CONFLICT`.
- `task_file` is canonicalized under the configured workspace root, must be a
  regular file, and must stay inside that root. Escapes fail with
  `PATH_OUTSIDE_ROOT`.
- `instance_id` is generated when the bridge starts and cannot be reused.
  Submitting with an older instance id returns `INSTANCE_CHANGED`.
- `max_active_jobs` defaults to `1`. A second concurrent submit returns `BUSY`;
  the bridge queues nothing. `max_retained_jobs` defaults to `512`; at capacity
  new submissions fail with `MEMORY_CAPACITY`, and retained deduplication
  records are not evicted.
- Deduplication, active-job accounting and the final-result cache are
  process-local. There is no cross-instance lock, global scheduler or
  cross-restart recovery.

## No default deadline and no consumption budget

- There is no default task deadline. A job runs until its native terminal state,
  an explicit `deadline_at`, `harness_cancel`, or bridge shutdown.
- `wait_ms` limits one wait RPC; it is not a task timeout.
- The bridge injects no `--max-budget-usd` or token/amount budget. Cleanup,
  drain and wait constants are internal bounds, not task limits.
- `harness_health` reports `default_deadline_at: null` and
  `consumption_budget: null` to make this explicit.

## Optional Markdown result (`save_result`)

`save_result` defaults to `false`; in that mode the bridge performs no
task-related file write. When `save_result: true` and `results_dir` is
configured, the bridge waits until the job is terminal and then publishes one
file:

- Path: `<results_dir>/<job_id>.md`; the job id is validated as a safe file name
  and an existing file is never overwritten.
- Header: `format_version: 1`, job/adapter/status fields, timestamps,
  `exit_code`, `output_complete`, `redacted`, `cleanup_confirmed` and
  `report_is_data: true`.
- Body: the worker's final answer plus, when applicable, a short failure and
  delivery diagnostic.
- Publication is atomic: write a temporary file with `create_new`, flush/sync,
  then `hard_link` to the final name and remove the temporary file. A write or
  publish failure sets `report_error: "REPORT_WRITE_FAILED"` without changing
  the worker's status or re-running the task.
- The Markdown is result data. The bridge never parses its body as instructions,
  a task queue or a recovery index. Running tasks produce no Markdown, no
  progress file and no event log.

## Native worker sessions

Native worker session/transcript persistence is disabled independently of
`save_result`. Codex receives `--ephemeral`; Claude Code receives
`--no-session-persistence`. Neither flag is configurable through a task.
`harness_health.adapters[].native_session_persistence_disabled` describes
this policy for each invocation. DSH and ZCode currently report false and
reject task submission with `NATIVE_SESSION_PERSISTENCE_UNSUPPORTED` before
acceptance/spawn, because no verified suppression exists in their current
adapter invocation. Their protocol collectors remain available for fixtures.

The policy covers native sessions/transcripts. Worker authentication,
product caches and legitimate task source/output writes retain their native
behavior. The policy does not claim zero disk writes. Older native captures
below predate this policy and do not prove its live behavior.

The local [DSH adapter](../../integrations/deepseek-harness/xuanling-harness/README.md)
provides a standard one-shot subagent provider and blocking `harness_run`
tool for Blueprint tool bindings. It adds no runtime store or scheduler.

## Verified CLI versions and current evidence

Adapter contracts were written against these captured versions in this
checkout:

| Worker | Captured version | Minimum accepted | Evidence in this checkout |
| --- | --- | --- | --- |
| Codex | `codex-cli 0.165.0-alpha.1.2` | `0.160.0` | Captured success and failure event streams |
| Claude Code | `2.1.311` | `2.1.0` | Captured auth-failure result only |
| DSH | `0.2.1` | `0.2.0` | Captured missing-credential turn only |
| ZCode | `0.17.0` | `0.17.0` | Captured business-error stderr; live success verified with a personal BigModel coding-plan API-key provider |

Historical Codex and ZCode captures show successful runs before the native
session policy above. They are not fresh acceptance of the current invocation.
The historical ZCode route needs both
provider-config variables above forwarded, and the headless CLI must resolve a
**personal API-key provider** for the BigModel coding plan (for example
`api=anthropic-messages`, `baseUrl=https://open.bigmodel.cn/api/anthropic`,
model `GLM-5.3-Flash`). The account-provider `defaultModelSelection`
(`account:bigmodel-individual-coding-plan`) is not resolved by the headless
path and falls back to the first personal provider. The bridge does not select
or override the model/provider. Current DSH and ZCode launches are blocked by
the native session policy. Claude live execution is not included in the
current acceptance. Controller-host journeys (Codex, Claude Code, DSH, ZCode,
Trae) are W3 work and have not been executed; the files under
[`integrations/`](integrations/) are configuration syntax only.

## Limitations

- **No restart recovery.** Jobs, request records and final results live in
  memory. A new bridge process cannot serve an old `job_id` or `request_id`
  (`JOB_CONTEXT_LOST` / `INSTANCE_CHANGED`) and never re-runs them.
- **No cross-instance deduplication.** Two bridge processes can run the same
  `request_id`; coordination across instances is the controller's job.
- **No process logs.** The bridge returns the final answer and a bounded failure
  diagnostic only. It does not expose stdout/stderr streams, thinking, token
  deltas, tool-call timelines, phase events or periodic progress.
- **No approval proxying or steering.** The bridge cannot approve a worker
  prompt, answer a question, send a follow-up message or change the worker's
  model/permission policy mid-run. A worker that needs input yields
  `NEEDS_INPUT` (when the adapter recognizes it) or a native failure; native
  permission modes govern the worker.
- **Worker final answers are not verified facts.** `completed` means the native
  run succeeded and a final answer was extracted. Claims inside that answer
  (for example "tests passed") are the worker's statements; the bridge does not
  verify them, and task completion is not controller acceptance.
- No daemon, Web UI, background wake-up claim, notification replay, automatic
  continuation or global scheduler.
- The bridge does not sandbox worker processes. They run with the bridge user's
  OS permissions; CLI-native sandbox/permission options are the only additional
  confinement, and they are supplied by trusted configuration.

## Related documents

- [`SECURITY.md`](SECURITY.md): argv, environment, redaction, path, buffer,
  report and trust-boundary rules.
- [`RELEASE-BOUNDARY.md`](RELEASE-BOUNDARY.md): what this crate deliberately does
  not ship or claim.
- [`integrations/`](integrations/): controller-host MCP entry examples
  (unverified configuration syntax).
