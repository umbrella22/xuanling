---
name: xuanling-dsh-install
description: Installs, migrates, or verifies the XuanLing integration in a DeepSeek Harness (DSH) web or headless profile after the user provides the XuanLing repository URL. Use for repository URL or GitHub URL requests that ask DSH to install XuanLing conversationally, with explicit profile, preset, version, confirmation, rollback, restart, and tool-call verification.
---

# XuanLing DSH conversational installer

Use this workflow when a user asks DSH to install the XuanLing integration from
`https://github.com/umbrella22/xuanling`. This is not a native DSH URL
installer. The model reads this repository-owned Skill, asks the user for the
required choices, and invokes the normal public DSH plugin CLI.

The repository URL is an instruction source, never an executable package
source. Do not clone the repository, run repository scripts, or install a Git,
file, link, directory, or tarball spec. Every installed package must come from
the public npm registry under the fixed `@xuanling-rs` names below.

## Frozen contract

The following marked JSON is the machine-checked installer contract. Follow it
as normative data; the prose below explains how to execute it.

<!-- xuanling-dsh-installer-contract:start -->
```json
{
  "schema_version": 1,
  "canonical_repository": "https://github.com/umbrella22/xuanling",
  "skill_path": ".agents/skills/xuanling-dsh-install/SKILL.md",
  "model_orchestrated": true,
  "profiles": [
    {
      "id": "web",
      "recommended": true
    },
    {
      "id": "headless",
      "recommended": false
    }
  ],
  "presets": {
    "recommended": {
      "add": [
        "@xuanling-rs/xuanling-dsh-memory",
        "@xuanling-rs/xuanling-dsh-skills"
      ],
      "remove": [
        "@xuanling-rs/xuanling-dsh-tools",
        "@xuanling-rs/xuanling-dsh-tools-replace"
      ]
    },
    "full-additive": {
      "add": [
        "@xuanling-rs/xuanling-dsh-tools",
        "@xuanling-rs/xuanling-dsh-skills"
      ],
      "remove": [
        "@xuanling-rs/xuanling-dsh-memory",
        "@xuanling-rs/xuanling-dsh-tools-replace"
      ]
    },
    "filesystem-replacement": {
      "add": [
        "@xuanling-rs/xuanling-dsh-tools-replace",
        "@xuanling-rs/xuanling-dsh-skills"
      ],
      "remove": [
        "@xuanling-rs/xuanling-dsh-memory",
        "@xuanling-rs/xuanling-dsh-tools"
      ]
    }
  },
  "questions": [
    {
      "id": "xuanling_target_profile",
      "options": [
        "web",
        "headless"
      ],
      "recommended": "web"
    },
    {
      "id": "xuanling_install_preset",
      "options": [
        "recommended",
        "full-additive",
        "filesystem-replacement"
      ],
      "recommended": "recommended"
    },
    {
      "id": "xuanling_install_confirm",
      "options": [
        "proceed",
        "cancel"
      ],
      "recommended": "proceed"
    }
  ],
  "version_resolution": {
    "registry": "https://registry.npmjs.org",
    "resolve_once": true,
    "stable_semver_only": true,
    "exact_mutation_specs": true
  },
  "mutation": {
    "cli": "dsh plugin",
    "snapshot_before_mutation": true,
    "rollback_via_cli": true,
    "manual_profile_edits": false
  },
  "verification": [
    "plugin_list",
    "dump_config",
    "cold_start_web",
    "restart_handoff",
    "tool_discovery",
    "harmless_tool_call"
  ]
}
```
<!-- xuanling-dsh-installer-contract:end -->

## Safety boundary

Before doing anything, confirm that `dsh --version`, `node --version`,
`npm --version`, and `pnpm --version` are available. A missing prerequisite is
`host_prerequisite_missing`; report it and stop without changing a profile.

Keep these invariants for the entire run:

- The only target profiles are the shipped `web` and `headless` profiles.
- The package names come only from the contract block. Never derive a package
  name from URL text, a query parameter, or free-form user input.
- Resolve the registry version once per run, freeze it, and use exact stable
  specs for every apply command. Never use an omitted version, `@latest`, a
  semver range, or another floating spec in a mutation.
- Use `dsh plugin --profile <profile>` for every dependency mutation and for
  rollback. Never edit a profile's `package.json`, lockfile,
  `dsh.profile.bundles`, `node_modules`, or Cordis patch files by hand.
- Do not use `npm install --global`, an install-time shell pipeline, or remote
  code. Do not change DSH itself.
- Do not write, import, export, rebuild, clean, or migrate the user's default
  XuanLing Memory database. Runtime smoke calls must be harmless and read-only.
- Preserve any already-running DSH process until a separate cold-start probe
  succeeds. Stop only the exact probe process you started, never every process
  matching a name.

## Step 1: ask for the profile

Use `ask_user_question` with one single-select question. Use stable id
`xuanling_target_profile`, put the recommended option first, and use these
labels and descriptions:

1. `web (Recommended)` - install into the shipped browser profile.
2. `headless` - install into the shipped one-task command profile.

Normalize those labels to `web` or `headless`. Do not silently choose a
profile, accept custom text, accept multiple selections, or create a new
profile name. If the question is skipped, aborted, cancelled, or returns
anything else, stop as `cancelled_before_side_effect` with zero commands that
can mutate a profile.

## Step 2: ask for the preset

Use a second single-select `ask_user_question` with stable id
`xuanling_install_preset`. Put these choices in this order:

1. `Memory + Skills (Recommended)` -> normalized id `recommended`. It adds
   proposal-first Memory tools plus the two routing Skills and keeps DSH's
   native file tools.
2. `Full tools + Skills` -> normalized id `full-additive`. It adds the full
   XuanLing catalog plus Skills while retaining DSH's native file tools.
3. `Replace native filesystem tools + Skills` -> normalized id
   `filesystem-replacement`. It adds the full catalog and Skills, and the
   bundle disables DSH's three model-facing native filesystem rows to avoid a
   duplicate file-tool surface.

The three runtime packages all mount the same `xuanling-tools` bundle id and
are mutually exclusive. The Skills package is a separate provider and is part
of every preset. Unknown, custom, multiple, skipped, or cancelled answers stop
as `cancelled_before_side_effect` before registry or profile mutation.

## Step 3: resolve and freeze one registry version

Build the fixed query set from the launcher plus the selected preset's two
`add` package names. Query each package exactly once in this run with the
equivalent direct argv:

```text
npm view <fixed-package-name> dist-tags version --json --registry https://registry.npmjs.org
```

For all three responses, require `dist-tags.latest` and `version` to be the
same plain stable `major.minor.patch` value, with no prerelease or build
suffix. Freeze that value as `resolved_version`; do not query again after
confirmation. An unavailable registry, E404, authentication error, timeout,
rate limit, malformed response, non-stable version, or disagreement stops
before profile mutation as `registry_version_unavailable` or
`release_set_incoherent`. Never fall back to a floating install.

## Step 4: inventory without changing the profile

Locate the selected profile under the active DSH home. If its `package.json`
does not exist, record `profile_absent` and an empty related dependency set.
Do not run `dsh plugin list` yet because DSH initializes a missing profile on
first plugin command.

For an existing profile, use read-only file inspection to record:

- the profile manifest hash;
- exact dependency specs for all four XuanLing DSH package names;
- the current `dsh.profile.bundles` rows;
- the effective configuration from
  `dsh --profile <profile> --dump-config` when that command is read-only for
  the existing profile.

Do not edit any of those files. At most one of the three runtime package names
may be present. If two are present, record the conflict rather than guessing
which one wins. Preserve every previous exact spec for rollback.

Treat `dsh plugin list` as a post-confirmation command: its reconciliation can
write bundle rows even though pnpm's `list` operation is read-only. This keeps
profile initialization and reconciliation inside the user's final consent.

## Step 5: show the exact plan and ask for final confirmation

Build the plan only from the frozen selection and inventory. Show all of the
following in the text of one final single-select question:

- selected profile and preset;
- exact `resolved_version`;
- current matching and conflicting package specs;
- each exact spec that will be removed;
- each exact `package@resolved_version` that will be ensured;
- whether this is an already-matched verification-only run;
- for `filesystem-replacement`, the three native filesystem rows it disables;
- that plugin changes require a DSH restart before new tools are visible.

Use stable id `xuanling_install_confirm`, with `Proceed (Recommended)` first
and `Cancel` second. This installer confirmation is separate from any host
permission prompt. Custom, missing, skipped, aborted, or `Cancel` answers stop
as `cancelled_before_side_effect`; no profile command may have run.

Immediately before the first mutation, re-read the profile manifest. If an
existing manifest's hash changed since inventory, stop as `stale_snapshot` and
repeat inventory plus final confirmation. Do not apply a stale plan.

## Step 6: converge or verify

After `Proceed`, run `dsh plugin --profile <profile> list` and re-read the
manifest/config. If the exact target specs are already present, conflicting
runtime packages are absent, and the effective rows are correct, perform no
add or remove. Continue to verification and finish as `verified_noop` only if
all gates pass.

Otherwise, mutate in this order:

1. Remove only conflicting runtime package names shown in the confirmed plan
   with `dsh plugin --profile <profile> remove <package-name> ...`.
2. Add or update both selected packages together with
   `dsh plugin --profile <profile> add <package@resolved_version> ...`.
3. Re-read the manifest and effective config. Require the two exact target
   specs, no conflicting runtime package, one `xuanling-tools` runtime row,
   and one `xuanling-skills` provider.

Do not continue after a nonzero exit, timeout, cancellation, manifest drift,
or unexpected package/config state. Move immediately to rollback.

## Rollback

The before snapshot, not the intended target, is the rollback authority. Read
the current graph again, then use only `dsh plugin` commands:

1. Remove each related XuanLing package now present that was absent from the
   snapshot.
2. Add every missing or changed previous `package@exact-previous-version`
   spec from the snapshot. A rollback spec intentionally uses the previous
   version, not `resolved_version`.
3. Run `dsh plugin --profile <profile> list`, read the manifest, and run
   `dsh --profile <profile> --dump-config`.
4. Compare related dependency specs and effective XuanLing rows with the
   before snapshot. Do not require unrelated profile bytes to change or stay
   unchanged.

If semantic equality is restored, report `rolled_back` with the failed apply
argv and successful recovery argv. If any recovery command or comparison
fails, report `rollback_failed`, list the current related specs and the exact
remaining recovery argv, and stop. Never continue into cold-start validation
after rollback.

## Step 7: verify composition and runtime

For a converged or already-matched state:

1. Run `dsh plugin --profile <profile> list`; require both selected packages
   at `resolved_version`.
2. Run `dsh --profile <profile> --dump-config`; require exactly one
   `xuanling-tools` runtime row and one `xuanling-skills` provider, with no
   conflicting XuanLing runtime package. A config dump is necessary but is not
   proof that a model can call a tool.
3. For `web`, keep any current server alive and start a separate bounded probe
   with direct argv `dsh --profile web --no-open --port 0`. Wait for its
   temporary URL, record its exact PID/session, and terminate only that probe.
   Probe failure leaves the old server running and ends as
   `runtime_unverified`.
4. For `headless`, the deterministic pre-restart gate is the composed config.
   The next isolated headless invocation is the runtime gate; do not use Web
   flags for it or start a billable task without the user's existing request.
5. Explain that a profile process started before the plugin change still has
   the old graph. Restart the selected profile explicitly, preserving its
   session when the host supports resume. Do not claim the tools are active
   before that restart.
6. After restart, require discovery of the expected `mcp__xuanling__*` tools.
   For the recommended preset, call `mcp__xuanling__memory_search` with a
   narrow read-only query or another visible read-only Memory call. For either
   full-tool preset, prefer `mcp__xuanling__system_info`. Never create or
   review a Memory candidate as an installation smoke test.

Use `installed_verified` only after package, config, cold/bounded start,
restart, discovery, and harmless call evidence all pass. If the profile graph
is installed but restart cannot happen in the current session, report
`installed_restart_required` with the exact remaining steps; do not relabel it
as verified.

## Failure reporting

Keep reports bounded and redact credentials, environment dumps, provider raw
responses, and unrelated profile content. Include the source URL/ref, DSH
version, normalized answers, frozen version, related before/current specs,
direct argv with no secret values, exit codes, terminal status, and the next
exact recovery or restart action.

Use these terminal names consistently: `installer_source_unavailable`,
`host_prerequisite_missing`, `cancelled_before_side_effect`,
`registry_version_unavailable`, `release_set_incoherent`, `stale_snapshot`,
`verified_noop`, `installed_restart_required`, `installed_verified`,
`rolled_back`, `rollback_failed`, and `runtime_unverified`.
