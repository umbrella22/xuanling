# Release boundary

The bridge is distributed experimentally through
`@xuanling-rs/harness-bridge` and its three native npm packages. Distribution
follows the workspace release version; each package records its source commit
and the native packages include dependency notices. The initial npm upload
uses browser-authenticated CLI publishing. GitHub Actions Trusted Publishing
is available after a maintainer configures all four package identities.

The Rust crate is not published to crates.io. Native binaries have no Developer
ID or Authenticode signatures. Public package availability is a distribution
claim; it does not close the development plan's live-worker, controller-host or
full native acceptance gates. Those gates retain their own evidence status.

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
| Platform publisher signing, installers or marketplace entry | Not provided by this npm distribution |

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

- The crate and npm versions follow the workspace version. The bridge is
  experimental; pin an exact version when configuring a controller.
- The controller-facing contract is the four-tool MCP surface described in
  [`README.md`](README.md). There is no compatibility guarantee for the retired
  pre-plan five/ten-tool surface, any SQLite schema or any old bridge file.
- The optional Markdown result carries `format_version: 1` in its header. That
  version describes the file layout only; the file is never used as a job
  database or an instruction source.
- Package build, registry and clean-consumer evidence must be recorded for the
  exact release commit. Unexecuted live worker/controller gates must remain
  explicit and cannot be inferred from package publication or synthetic tests.
