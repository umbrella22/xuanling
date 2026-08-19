# Independent GLM Dogfooding Handoff

## Scope

This protocol covers the W4.4 independent evaluation of the XuanLing file and Memory workflows on
DeepSeek Harness and ZCode. The tested XuanLing source is paired with DeepSeek Harness revision
`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`. The evaluation observes normal host behavior and does not
provide an expected tool route.

## Isolation

- Use a fresh temporary project copy for every task.
- Use a profile-local DSH installation or a local ZCode marketplace candidate. Do not resolve a
  global XuanLing package or a source checkout through `PATH`.
- Set an absolute temporary Memory database path for every run. Do not use the default user Memory
  database.
- Preserve the raw session/model transcript, tool-call sequence, final workspace tree, and a before/
  after SQLite snapshot for each task.
- Do not include credentials, raw provider responses, or private prompt material in the returned
  evidence.

## Frozen Tasks

### File workflow

Create a fresh copy of `test/deepseek-harness/evaluation/fixtures/fs-workload` and execute the task
in its `task.md`. The task requires inspection, structured edits, a compound-extension search, and a
final checksum change. Complete it with the tools exposed by the selected host. The workspace must
contain only the task's permitted changes when the task ends.

Run the task once with the host's normal file-tool surface and once with the staged XuanLing file
bundle when the host supports both profiles. Keep the prompts and fixture bytes identical.

### Memory workflow

Run the following cases in fresh project/profile pairs. Each case receives the same short fact text
and the same namespace/scope configuration; the fact text is supplied at runtime and is not part of
the expected-route oracle.

1. A project-local convention that must be visible in every session.
2. A cross-project team convention that is absent from the isolated Memory database.
3. A project file containing an explicit pointer to a shared Memory namespace, followed by a topic
   switch that makes the pointer relevant.
4. A recall request against an unavailable or empty shared store while the main task remains
   executable.

Stop each case at its natural review boundary. No automatic approval or rejection is part of this
   evaluation.

## Installation Inputs

The maintainer supplies the profile-local DSH bundle or the local ZCode marketplace archive for the
candidate under test. The candidate must be installed from that supplied path, with the candidate
version and source tree recorded in the transcript header. The host must expose the selected bundle's
normal Skill files without editing them during a task.

## Evidence Returned Per Task

```text
host:
host_version:
candidate_version:
source_revision:
profile_or_marketplace:
workspace_path:
memory_db_path:
session_id:
tool_call_sequence:
provider_usage_fields_present:
final_response:
workspace_snapshot_sha256:
memory_before_sha256:
memory_after_sha256:
canonical_memory_counts_before:
canonical_memory_counts_after:
errors_and_retries:
```

The evaluation record must distinguish a host setup failure, a typed tool error followed by a valid
retry, an oracle failure, and an incomplete transcript. The evaluator independently compares the
workspace and SQLite snapshots with the frozen task contract after the handoff.

## Route and Oracle Confidentiality

The handoff does not disclose the expected tool family, call ordering, candidate status, or final
oracle verdict. Those values remain in the maintainer-side verifier and are compared only after the
raw evidence is received.
