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
source. A temporary checkout may be used only to locate and load the bounded
installation documents; it must never be executed or passed to a package
manager. Do not run repository scripts or install a Git, file, link,
directory, or tarball spec. Every installed package must come from the public
npm registry under the fixed `@xuanling-rs` names below.

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
  "source_acquisition": {
    "method": "temporary_git_checkout",
    "repository": "https://github.com/umbrella22/xuanling.git",
    "allowed_document_paths": [
      "README.md",
      "README-ZH.md",
      ".agents/skills/xuanling-dsh-install/SKILL.md",
      "integrations/deepseek-harness/README.md",
      "integrations/deepseek-harness/README-ZH.md"
    ],
    "require_root_readme": true,
    "require_installer_skill": true,
    "path_discovery": {
      "methods_allowed": [
        "tracked_path_listing",
        "path_only_content_locator"
      ],
      "model_visible_output": "relative_paths_only",
      "non_document_content_exposure": false
    },
    "pin_immutable_ref": true,
    "execute_repository_code": false,
    "install_from_checkout": false,
    "cleanup_before_questions": true
  },
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

## Acquire the instruction source

If the linked repository is not already the active workspace, DSH may obtain
the fixed official repository into a new temporary directory. This checkout is
an instruction cache, not an installation source or a profile mutation.

Keep the source boundary narrow:

- Accept only the canonical repository URL, optionally followed by a
  lowercase 40-character commit under `/tree/` or `/commit/`. For an immutable
  URL, check out that exact commit; for the canonical URL, record the resolved
  commit from the default branch.
- Use only `https://github.com/umbrella22/xuanling.git` as the Git remote. The
  checkout destination must not exist before this run. Never overwrite, reuse,
  or clean an existing directory.
- Path discovery may list tracked paths or run a content locator only when the
  locator emits relative path names and never matching lines or file bodies.
  A locator process may inspect bytes to find candidate paths, but bytes from
  non-document files must not be printed, summarized, parsed, or otherwise
  exposed to the model.
- Load model-visible content only from `README.md`, `README-ZH.md`,
  `.agents/skills/xuanling-dsh-install/SKILL.md`, and the English or Chinese
  `integrations/deepseek-harness/README` guide. At least one root README and
  the installer Skill are required. Do not interpret source files or
  manifests, and do not run hooks, scripts, binaries, package-manager
  commands, or code from the checkout.
- After both documents are in model context, verify that the destination is
  the exact directory created by this run, remove that directory, and confirm
  it is absent before asking `xuanling_target_profile`. If checkout or cleanup
  fails, stop as `installer_source_unavailable` without running any profile
  command.
- Record the requested ref, resolved commit, source-only status, and successful
  cleanup in redacted evidence. A checkout must never appear in a `dsh plugin`
  add command.

## Safety boundary

Before asking installation questions or changing a profile, confirm that
`dsh --version`, `node --version`, `npm --version`, and `pnpm --version` are
available. A missing prerequisite is `host_prerequisite_missing`; report it
and stop without changing a profile.

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
   the complete proposal-first Memory catalog behind DSH lazy projection plus
   the two routing Skills, and keeps DSH's native file tools.
2. `Full tools + Skills` -> normalized id `full-additive`. It adds the full
   XuanLing catalog behind DSH lazy projection plus Skills while retaining
   DSH's native file tools.
3. `Legacy replacement compatibility + Skills` -> normalized id
   `filesystem-replacement`. It updates profiles that already selected the
   historical package, but now preserves all DSH-native filesystem rows. For a
   new full-catalog install, recommend `full-additive` instead.

Every runtime bundle mounts its own `lazy-mcp-client.mjs` wrapper around the
official bridge. The official bridge still fetches and caches every MCP
`tools/list` page, while the wrapper initially registers only
`mcp_catalog__xuanling` and registers one exact `mcp__xuanling__*` definition
after each activation. Do not replace this with an unverified
`toolExposure: lazy` option: released DSH bridge schemas do not own that field.
This is a bundle-owned Host projection policy, not a server profile or
`list_changed` behavior.

The three runtime packages use distinct row ids (`xuanling-memory`,
`xuanling-tools`, and `xuanling-tools-replace`) so inventory can report an
explicit `runtime_bundle_conflict`; they remain mutually exclusive by preset.
The Skills package is a separate provider and is part of every preset. Unknown,
custom, multiple, skipped, or cancelled answers stop
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
  the existing profile;
- the launcher version, installed native package version and resolved native
  binary path when present. A mismatch is repair evidence, never a no-op.

Do not edit any of those files. At most one of the three runtime package names
may be present. If two are present, record the conflict rather than guessing
which one wins. Preserve every previous exact spec for rollback.

Treat `dsh plugin list` as a post-confirmation command: its reconciliation can
write bundle rows even though pnpm's `list` operation is read-only. This keeps
profile initialization and reconciliation inside the user's final consent.

## Step 5: show the exact plan and ask for final confirmation

Build the plan only from the frozen selection and inventory. Classify it as
exactly one operation: `install` when no related package exists;
`verified_noop` when package, row, launcher, native, and runtime identity
already match; `update` when the same preset is wholly below the frozen
version; `downgrade` when it is wholly above; otherwise `repair` (including
package-topology changes, mixed versions, runtime conflicts, and identity
mismatch). Show all of the following in one final single-select question:

- selected profile and preset;
- operation mode and exact from/to version delta;
- exact `resolved_version` and the matching `CHANGELOG.md` release heading;
- current matching and conflicting package specs;
- each exact spec that will be removed;
- each exact `package@resolved_version` that will be ensured;
- whether this is an already-matched verification-only run;
- for `filesystem-replacement`, that this is a legacy compatibility package
  which now preserves native `read_image`, observation guards, and editor UI;
- that the runtime initially exposes `mcp_catalog__xuanling` and activates
  exact XuanLing tools on demand;
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
   specs, no conflicting runtime package, the selected package-specific
   runtime row, and one `xuanling-skills` provider.

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
2. Run `dsh --profile <profile> --dump-config`; require exactly one selected
   package-specific XuanLing runtime row and one `xuanling-skills` provider,
   with no conflicting runtime package. A config dump is necessary but is not
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
6. After restart, require discovery of `mcp_catalog__xuanling`. Record and
   compare the frozen manifest/lock version, launcher version, native package
   version and resolved binary path. Use the catalog to search and activate
   exactly one harmless raw name. For the recommended
   preset, activate `memory_search`, then call
   `mcp__xuanling__memory_search` with a narrow read-only query. For either
   full-tool preset, activate `system_info`, then call
   `mcp__xuanling__system_info`. Require the activated definition to appear
   before calling it. Its reported version and MCP contract version must agree
   with the frozen release and expected contract. Any launcher/native/path/
   `system_info` mismatch is `runtime_version_incoherent`: roll back a changed
   graph, or classify an unchanged graph as `repair`; never report verified.
   Never create or review a Memory candidate as an installation smoke test.

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

Do not claim that DSH release age caused a stale native package unless a
controlled Host transcript proves the mechanism. Without that evidence record
release-age causality as `UNVERIFIED_RISK`; package/runtime mismatch itself is
still a confirmed repair condition.

Use these terminal names consistently: `installer_source_unavailable`,
`host_prerequisite_missing`, `cancelled_before_side_effect`,
`registry_version_unavailable`, `release_set_incoherent`, `stale_snapshot`,
`verified_noop`, `installed_restart_required`, `installed_verified`,
`rolled_back`, `rollback_failed`, and `runtime_unverified`.
