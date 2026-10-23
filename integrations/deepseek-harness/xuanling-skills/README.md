# xuanling-dsh-skills

English | [Simplified Chinese](README-ZH.md)

**Three on-demand XuanLing workflow Skills and the strict XuanLing overwrite
policy for DeepSeek Harness.** Registers no MCP server and ships no binary.
Package `@xuanling-rs/xuanling-dsh-skills@0.8.1`.

## What it is

Adds workflow guidance and host guardrails to a DSH profile:

- `xuanling-memory-workflow` routes project-local facts to DSH file memory
  (L1) and shared facts to XuanLing Memory (L2), activates only the next
  Memory operation, and keeps the proposal/review boundary explicit.
- `xuanling-file-workflow` routes file work between native Harness tools and
  the XuanLing filesystem family: SHA-256/CAS guards, strict patches, atomic
  `fs_edit_batch`, bounded output, pagination, and deterministic validation.
- `xuanling-blueprint-migrate` guides an inspected upgrade of saved Blueprint
  packages: backup, semantic review, complete resources, validation and
  destination bindings. It preserves the original and Run history.
- A host policy denies an existing-file overwrite without `expected_sha256`
  and asks for one-time DSH approval before a XuanLing Memory review.

## Why use it

- **Use it** when you already run a XuanLing runtime bundle and want the model
  to route file and Memory work deliberately, with host guardrails.
- **Do not install it alone.** It adds no tools and needs exactly one runtime
  bundle (Memory, full tools, or replacement). The [bundle guide](../README.md)
  covers the presets and their trade-offs.
- Its policy is what enforces the memory review confirmation and the
  hash-before-overwrite rule at the DSH boundary.

## Requirements

- DSH with the shipped `web` or `headless` profile.
- Node.js 22.14 or newer.
- A DSH build that provides `@deepseek-ai/dsh-skill-filesystem` from the
  `0.2.1-rc.2` capability channel.
- Exactly one XuanLing runtime bundle in the same profile.

## Install

Install it together with the runtime bundle you selected:

```sh
dsh plugin --profile web add \
  @xuanling-rs/xuanling-dsh-memory@0.8.1 \
  @xuanling-rs/xuanling-dsh-skills@0.8.1
```

Replace `xuanling-dsh-memory` with `xuanling-dsh-tools@0.8.1` for the full
catalog. Use `--profile headless` for the headless profile; a custom new
profile name starts from the base bundle only. No global package is needed.

## Quickstart

1. Confirm one runtime row and one `xuanling-skills` provider, then restart:

   ```sh
   dsh plugin --profile web list
   dsh --profile web --dump-config
   ```

2. Ask the model to load `xuanling-memory-workflow` (Memory bundle),
   `xuanling-file-workflow` (full tools bundle), or `xuanling-blueprint-migrate`
   (Blueprint upgrades; see below). Skills are on demand and are not injected
   into every request.

3. Test a guardrail: with the full tools bundle, overwrite a file through
   `mcp__xuanling__fs_write_text` without `expected_sha256`. It should be
   rejected before dispatch with
   `[XUANLING_FS_OVERWRITE_REQUIRES_SHA256]`.

## Upgrade Blueprint definitions

The [Blueprint migration Skill](skills/xuanling-blueprint-migrate/SKILL.md)
was introduced in `0.7.0` and is included in `0.8.1`; the earlier `0.6.1` package does not include it. Install
the skills bundle into the profile that runs the target Blueprint version,
then restart the profile:

```sh
dsh plugin --profile web add @xuanling-rs/xuanling-dsh-skills@0.8.1
```

Ask the DSH Agent:

```text
Load xuanling-blueprint-migrate and upgrade the Rust review Blueprint at
<source package path> to this profile's current Blueprint schema. Save an
independent copy in <destination workspace>, preserve the original and Run
history, and validate its resources and representative input. Show the diff,
binding gaps and rollback path. Do not start a Run yet.
```

The Skill uses the target Blueprint plugin's authoring/validation tools and
available file tools; the skills bundle itself adds neither. It covers v1-to-v2
and legacy profile storage, without adding automatic migration to the runtime.
Unsupported execution semantics require a reviewed redesign; changing the
version number alone is not a general migration. A saved copy and successful
preflight are reported separately from live execution. In another agent that
supports filesystem Skills, install the complete `xuanling-blueprint-migrate/`
directory, including `references/`, and invoke `$xuanling-blueprint-migrate`.

## Configuration

- No environment variable is required in normal use. `XUANLING_DSH_SKILLS_ROOT`
  is a development-only override for the Skill content root.
- Skill content is static and file watching is disabled; reinstall to update.
- The policy has no switch and inspects only two public names:
  `mcp__xuanling__fs_write_text` (deny an unsafe overwrite) and
  `mcp__xuanling__memory_review` (ask for one-time approval). Everything else
  delegates unchanged.
- Create mode and hash-bearing overwrites pass through to the MCP server,
  which owns schema validation, CAS, and the write.

## Limits and safety

- No MCP tools, binary, workspace, or database; installing it alone changes no
  capability.
- The policy is a host precondition, not a security boundary: it does not
  replace canonical validation, filesystem path capabilities, CAS, or the host
  approval system.
- The review gate enforces a DSH user decision; server-side `reviewer_id`
  remains caller-attested.
- SHA-256 proves integrity and concurrent-version identity, not edit
  semantics; review the returned diff before accepting a XuanLing edit.
- A Memory review runs only after a one-time approval; rejection, cancellation,
  or an unavailable channel fails closed.

## Troubleshooting

- **Skills do not appear.** Restart, confirm the `xuanling-skills` provider
  in `--dump-config`, and reinstall the exact `0.8.1` version.
- **The overwrite guard does not fire.** Check the exact public name; the
  replacement bundle exposes `write` instead, so the guard does not apply
  there.
- **An overwrite was denied.** Read with `fs_read_text` and
  `include_sha256: true`, or take `fs_hash`, then retry with the hash.
- **A Memory review was blocked.** The approval channel was unavailable or
  approval was not granted; retry interactively — the gate intentionally fails
  closed.

## Links

- [XuanLing for DeepSeek Harness: bundle guide and runtime configuration](../README.md)
- [XuanLing Blueprint: visual workflow editor and durable runs](../xuanling-blueprint/README.md)
- [XuanLing MCP server project](../../../README.md)
- [npm package](https://www.npmjs.com/package/@xuanling-rs/xuanling-dsh-skills)
- [Issues](https://github.com/umbrella22/xuanling/issues)
