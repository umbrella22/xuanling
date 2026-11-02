# Security boundary

This document describes the security behavior implemented by
`xuanling-harness-bridge` (package `xuanling-harness-bridge`, binary
`harness-bridge`). It is a description of the current code, not a claim that the
bridge is a sandbox or a complete security product. The contract source is
`docs/plans/harness-bridge-development-plan.md` (C-01/C-03/C-10/C-18/C-20).

## Trust boundary

- The configuration file is **trusted input**. It names absolute executables,
  workspace roots, a results directory and environment-variable names. A party
  that can edit the config can already choose which local program the bridge
  runs.
- Task text, `task_file` contents, worker stdout/stderr and the worker's final
  answer are **untrusted data**. The bridge never executes, evaluates or parses
  the final answer as instructions, configuration or a task queue.
- Worker processes are **not sandboxed by the bridge**. They inherit the bridge
  user's OS permissions and whatever environment names the bridge forwards.
  CLI-native options (Codex `-s`, Claude permission modes, DSH `headless`
  profile, ZCode `--mode`) are configuration choices, not a bridge-enforced
  sandbox. The bridge does not proxy approvals.
- The bridge is a local stdio MCP server. It opens no TCP listener, provides no
  remote authentication layer and exposes exactly four tools. The controller
  host is responsible for deciding who may launch and talk to the bridge.

## Fixed argv, no PATH guessing

- Each adapter builds an explicit argument vector from trusted configuration.
  The bridge never invokes a shell, never interpolates task text into a command
  string and never splits a command line.
- `program`, `runner`, `script`, workspace roots and `results_dir` must be
  absolute paths. Adapter executables/scripts are checked to be regular files at
  startup. There is no fallback PATH search when a configured path is missing or
  invalid.
- Task input reaches the worker as frozen bytes over stdin, except ZCode, whose
  verified CLI contract passes the prompt as an explicit `--prompt` argument.
- The bridge injects no consumption budget (`--max-budget-usd` is absent) and no
  default task deadline.

## Environment allowlist

The fixed Codex argv includes `--ephemeral` and the fixed Claude argv includes
`--no-session-persistence`. An adapter without a verified native session
suppression rejects with `NATIVE_SESSION_PERSISTENCE_UNSUPPORTED` before job
acceptance and again during command planning. This currently prevents DSH
and ZCode worker execution. Optional final Markdown does not enable native
sessions. Authentication, product caches and task file writes are separate
from this transcript policy; the bridge does not prohibit all worker IO.

The child environment is cleared and rebuilt from names, never from a captured
environment map. Values are read at spawn time and only when they are valid
UTF-8.

Baseline names forwarded to every worker:

```text
PATH HOME USER LOGNAME LANG LC_ALL LC_CTYPE TERM TMPDIR TMP TEMP
SYSTEMROOT WINDIR PATHEXT COMSPEC APPDATA LOCALAPPDATA PROGRAMDATA
PROGRAMFILES PROGRAMFILES(X86) USERPROFILE HOMEDRIVE HOMEPATH
```

`env_allowlist` adds names from trusted configuration. `secret_env` names are
used only to build the redactor; they are not automatically forwarded. List a
provider key in both arrays only when the worker needs it and the bridge should
redact it from worker text.

The bridge does not forward arbitrary environment variables, does not log
environment values and does not include them in tool results.

## No credential-file access

- The bridge opens: its explicit `--config` file, the selected `task_file`, and
  (for `save_result`) files it creates in `results_dir`. It does not open harness
  profiles, `~/.codex`, `~/.claude`, keychains, credential stores or provider
  configuration.
- Provider credentials and worker account state belong to the worker CLI. A
  worker may read its own configuration; that is outside the bridge's file-access
  boundary and is not changed by the bridge.
- The bridge configuration must contain secret **names**, not secret values. A
  secret value placed in the config file is not protected by the bridge's
  redactor.

## Redaction

The redactor is applied to the extracted final answer and to adapter failure
messages before they are returned, logged or written to Markdown.

- Values of variables named by `secret_env` are replaced when they are at least
  8 characters long. Longer values are replaced first so an overlapping shorter
  value cannot mask part of a longer one.
- Well-known token shapes are replaced regardless of configuration:
  `Bearer <token>` (16+ token characters), `sk-...` (16+ characters), and
  `api_key` / `access_token` / `client_secret` assignments (16+ characters).
- The replacement marker is `[REDACTED]`. The result carries `redacted: true`
  when at least one replacement occurred.
- Redaction is best-effort pattern matching, not a formal secret detector. Short
  configured values (under 8 characters) are not replaced by value. Do not put
  secrets in prompts, task files or the config, and do not treat `redacted:
  true` as a proof that no sensitive material remains.

The bridge never logs worker stdout/stderr, raw environment values or the
original secret value. Failure diagnostics are bounded and pass through the
redactor; OS error strings may contain file paths, which is intentional and
necessary for diagnosis.

## `task_file` containment

- The selected workspace root is canonicalized at configuration load.
- A relative `task_file` is joined to that root. The result is canonicalized
  (resolving symlinks) and must satisfy `canonical.starts_with(workspace_root)`.
  An escape returns `PATH_OUTSIDE_ROOT`.
- The target must be a regular file and must fit `max_prompt_bytes`; otherwise
  it fails with `TASK_READ_FAILED`. It is read once and frozen for the job, so a
  later file change cannot alter the accepted task.
- Canonical root containment is a path check, not an OS sandbox. The worker
  itself may read or write other paths according to its native permissions.

## Bounded protocol, final-answer and diagnostic buffers

| Limit | Default | Behavior when exceeded |
| --- | --- | --- |
| Config file | 1 MiB (fixed) | `CONFIG_INVALID`; the file is not parsed |
| `max_prompt_bytes` | 1 MiB | Prompt rejected; task file rejected with `TASK_READ_FAILED` |
| `max_protocol_line_bytes` | 4 MiB | Oversized line is discarded, parsing continues; delivery carries `STREAM_INCOMPLETE` |
| `max_protocol_bytes` | 8 MiB | Whole-stream JSON budget (Claude/ZCode); exceeded buffer marks the stream incomplete |
| `max_final_bytes` | 1 MiB | Final answer is truncated at a UTF-8 boundary; `output_complete: false` and `delivery_error: RESULT_TOO_LARGE` |
| `max_diagnostic_bytes` | 8 KiB | stderr tail and adapter failure text are truncated; raw stderr is not returned |

Limits are positive integers validated at startup. Reaching a result/protocol
limit does not terminate a healthy worker; the collector continues draining and
still tries to recognize the native terminal state. A truncated or incomplete
answer is never presented as complete.

## Report path rules

- `results_dir` must be absolute and must already exist. It is canonicalized at
  startup and re-checked at publication with `symlink_metadata`; a path that
  resolves to a regular file, a symlink or a missing directory is refused.
- The filename is `<job_id>.md`. The bridge-generated job id contains only ASCII
  alphanumerics, `.`, `-` and `_`, and is re-validated before use.
- A temporary file `.<job_id>.<uuid>.tmp` is created with `create_new` in the
  same directory, written, flushed and `sync_all`-ed. Publication uses
  `hard_link(temp, final)`, which fails rather than overwrites an existing path,
  followed by removal of the temporary file and a best-effort directory sync on
  Unix.
- A pre-existing file, an unsupported hard-link filesystem, a symlinked
  directory, a full disk or a permission error yields
  `report_error: "REPORT_WRITE_FAILED"`. The bridge does not fall back to
  rename-overwrite, does not scan or delete unrelated files and does not re-run
  the worker.
- The Markdown body is worker data. It is never parsed as instructions and is
  not used to reconstruct jobs after a restart.

## Cleanup confirmation

- Sending a termination signal is not proof that descendants are gone. After
  terminating a containment unit, the bridge polls the OS containment handle
  every 20 ms for up to 2 s.
- `cleanup.confirmed` is true only when the containment unit reports no live
  process. Otherwise the result carries `CLEANUP_UNCONFIRMED` (or
  `cleanup.confirmed: false`) and the instance's active-job slot remains
  occupied; the bridge does not falsely report capacity as released.
- `harness_cancel` is idempotent. The first terminal result is immutable; a
  later cancel may retry cleanup but cannot rewrite an already published report
  or change the worker's recorded outcome.
- On a bridge crash, the bridge makes no promise that Unix orphan processes or
  Windows Job Object descendants disappear, and it never scans or takes over
  PIDs from an earlier instance. The controller must verify external side
  effects independently.

## Secret-free errors and logs

- MCP stdout carries protocol framing only. Tracing output goes to stderr and
  uses the stderr writer; it does not include worker output, task text or
  environment values.
- Tool-facing domain errors contain a stable code and a bounded message.
  Worker-derived failure text passes through the redactor before settlement;
  validation and OS error text is bounded but not secret-scanned. The bridge
  does not return raw stdout/stderr, whole environment maps or process listings.
- The four-tool surface is enforced by the CI boundary check
  (`scripts/harness-bridge/check-bridge-boundary.py`): no event/status/list tool,
  no process-log tool and no database/lease/event-file dependency in the bridge's
  normal dependency closure.
