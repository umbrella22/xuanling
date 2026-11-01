# Release boundary

This crate is **not published, signed or released** by the current plan. It
exists as a workspace member (`xuanling-harness-bridge`, binary
`harness-bridge`) for implementation and verification. No crates.io package, npm
package, GitHub release, installer, binary artifact, signing step, attestation
or marketplace entry is part of this plan.

## Not included

| Capability | Status |
| --- | --- |
| Daemon, background service or Web UI | Not implemented; not planned here |
| SQLite, WAL, checkpointing or any runtime database | Not implemented and forbidden by the boundary guard |
| JSON/event-file/periodic-progress task store | Not implemented; in-memory state only |
| Notification replay or background model wake-up | Not implemented; MCP tool responses are the delivery channel |
| Automatic continuation, retry or re-dispatch | Not implemented; the controller decides |
| Global scheduler, cross-instance queue or cross-instance coordination | Not implemented; limits and deduplication are per bridge process |
| User-data migration, schema migration, backup/restore | Not applicable; no product data or runtime store exists |
| Approval proxying, interactive steering or worker message queue | Not implemented; a worker that needs input yields `NEEDS_INPUT` (when recognized) or a native failure |
| Process logs, raw stdout/stderr, thinking text or tool-call timeline | Not returned and not persisted |
| Publishing, signing, installers or release artifacts | Outside this plan's authorization |

## What the bridge returns

The bridge returns the worker's **final answer and status only**: a typed
`FinalResult` containing the native terminal status, the bounded (and possibly
redacted) final answer, output-completeness and delivery diagnostics, exit code,
cleanup evidence and an optional Markdown report path. It also returns minimal
control metadata needed to submit, wait and cancel a job.

It does not evaluate the answer, verify claims such as "tests passed", decide
that work is accepted, or derive the next task. `completed` means the worker's
native run succeeded and produced a final answer; it is not controller
acceptance.

## Version and compatibility

- The crate version follows the workspace version and is a development
  placeholder, not a published compatibility promise.
- The controller-facing contract is the four-tool MCP surface described in
  [`README.md`](README.md). There is no compatibility guarantee for the retired
  pre-plan five/ten-tool surface, any SQLite schema or any old bridge file.
- The optional Markdown result carries `format_version: 1` in its header. That
  version describes the file layout only; the file is never used as a job
  database or an instruction source.
- No release claim may be made while live worker/controller and native-platform
  gates from the plan are unexecuted or failing. Current evidence status is
  recorded in the plan and must be checked before any release statement.
