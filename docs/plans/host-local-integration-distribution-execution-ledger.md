# Host 本地集成与分发执行账本

```yaml
schema_version: 1
plan_id: "host-local-integration-distribution-20260817"
updated_at: "2026-08-17T16:06:25+08:00"
plan_status: "executing"
checkout:
  revision: "c68ecfb01132f1daf9cdb0cf3e4572d42d987b4f"
  branch: "main"
  status_sha256: "6fd708c54e561bb7aee3f97dd93c9300010f98162d6a6c97d4079d9783a66032"
  status_entry_count: 110
  relevant_diff_sha256: "998542099d56163aa5b5c0ef07133c4dd47d998429fa1ab63543e32ca6bc1686"
  relevant_untracked_sha256: "16574361cb83be4be165dc1cf2523b68209bf502c586ee846e81f14f5e542531"
  notes:
    - "Existing MIT migration overlaps Cargo/npm/DSH/ZCode release files; preserve and work with it."
    - "User-owned untracked AGENTS.md and plan.md are outside this plan and must remain untouched."
    - "W0.3 removed only the broad docs/* ignore; 23 attributable docs files are now visible to Git."
    - "The 45-entry pre-W0 set was classified as 34 tracked MIT migration entries, 9 untracked MIT files, and 2 user-owned untracked files."
    - "Current relevant_untracked_sha256 excludes user-owned AGENTS.md/plan.md and this ledger to avoid self-referential fingerprints; the plan remains included."
external_checkouts:
  deepseek_harness:
    path: "../deepseek-harness"
    revision: "47f943859bef60e4160492346772ded9b24f765a"
    branch: "master"
    status_sha256: "89b2a20a38d35a43db781e2255f5165d2ddbd77e3c7c17f2a410c7c68f627585"
    relevant_untracked_sha256: "9cfb98c151f745fcf47e6f4df05e26db1dcf1a59d42efc50ae2d832f1a844fd8"
    note: "Preserve two pre-existing untracked XuanLing comparison tests."
  zcode:
    app_path: "/Applications/ZCode.app"
    version: "3.7.7"
    build: "3.7.7.4926"
    current_marketplace: "xuanling-local directory source"
  zcode_packer_environment:
    name: "zcode-packer"
    token_secret_name: "XL_PUBLISH_TOKEN"
    repository_variable_name: "ZCODE_REPOSITORY"
    repository_variable_value: "umbrella22/xuanling-zcode-marketplace"
    secret_value_read: false
default_memory_db:
  path: "/Users/ikaros/.xuanling/memory.db"
  original_baseline_sha256: "898697478aa1d9f5d26e76c35fef228e631bda932c801e8fb557096b638c4f70"
  current_sha256: "fab4413b503b050a758b26d85cf01db543ae410ada479a724b570b15d1181355"
  incident: "Main DB changed again outside the recorded W4 window; no holder or WAL/SHM remained at the 2026-08-17T16:06:25+08:00 W5 snapshot."
  w4_isolation_window: "af6dbad... before npm 95/95 and still identical after final npm 96/96; sidecars absent"
release:
  version: "0.2.1"
  source_commit: null
  canonical_main_remote_has_branch: false
  npm_items: []
  zcode_target_repository: "umbrella22/xuanling-zcode-marketplace"
  zcode_target_repository_exists: true
  zcode_target_repository_has_branch: true
  zcode_target_default_branch_setting: "main"
  zcode_target_bootstrap_commit: "54a21771cc5c97f2f6f1371686fde2d4c557c683"
  zcode_archive_sha256: null
  target_tree_sha256: null
  local_projection_archive_sha256: "e1916a98c7a696fa79b63b1a3b34814954ea90492f5eece3f06baab2ccc62dd7"
  local_projection_tree_sha256: "188f2adec14b17ebec08dde45c051dc8e5322ee828ec057ad0faaba261e93782"
  local_projection_is_release_candidate: false
  missing_public_package_names:
    - "xuanling-mcp"
    - "xuanling-dsh-memory"
    - "xuanling-dsh-skills"
    - "xuanling-dsh-tools"
    - "xuanling-dsh-tools-replace"
completed_waves:
  - "W0"
  - "W1"
  - "W2"
  - "W3"
  - "W4"
current_wave: "W5"
current_work_package: "W5.3"
wave_state: "implemented_unverified"
clean_acceptance_count: 0
last_completed_action: "Bootstrapped target main at 54a21771... with exactly LICENSE and the two README files; remote API readback and DB isolation checks passed."
next_action: "Stage the attributed XuanLing change set excluding AGENTS.md and plan.md, inspect the index, commit it, and push source main."
required_gates:
  - "W0 contract/dirty/docs tracking baseline"
  - "W1 correct distribution red contracts"
  - "W2 four self-contained DSH package tarballs"
  - "W3 deterministic cross-platform ZCode marketplace projection"
  - "W4 publisher-signing and idempotent direct-promotion pipeline"
  - "W5 independently authorized live npm/GitHub/DSH/ZCode acceptance"
  - "W6 final Rust/npm/docs/release reconciliation"
changed_files:
  - ".gitignore"
  - ".github/workflows/npm-publish.yml"
  - "integrations/deepseek-harness/**"
  - "integrations/zcode-plugin/**"
  - "npm/packages/xuanling-mcp/**"
  - "npm/scripts/**"
  - "npm/test/**"
  - "npm/README.md"
  - "npm/README-ZH.md"
  - "test/release/**"
  - "docs/plans/README.md"
  - "docs/plans/host-local-integration-distribution-development-plan.md"
  - "docs/plans/host-local-integration-distribution-execution-ledger.md"
failed_commands:
  - "Expected negative: strict release-set verification rejects the unsigned W3 fixture at darwin-arm64."
  - "Expected external preflight block: all five public package names are E404 and NPM_BOOTSTRAP_TOKEN is absent."
not_run_commands:
  - "No protected-runner Developer ID or Authenticode signing; required in W5."
  - "No npm publish, target bootstrap, source push/tag, direct promotion, or ZCode/DSH live install."
  - "No Rust build/test in W4 because Rust source and MCP/Memory semantics are unchanged; W6 still requires the final Rust gates."
blockers:
  - id: "B-01"
    scope: "W5"
    condition: "origin has no remote branch/default branch"
    release: "Create and verify canonical main branch before release tag."
  - id: "B-03"
    scope: "W5"
    condition: "macOS Developer ID and Windows Authenticode availability are unknown"
    release: "Metadata-only preflight followed by publisher-sign verification on protected release runners."
  - id: "B-04"
    scope: "W5"
    condition: "npm package ownership/bootstrap and Trusted Publishing are not configured for first release"
    release: "Configure the minimum first-publish credential and package-level trusted publishers without exposing secret values."
  - id: "B-05"
    scope: "W5"
    condition: "source main push and target bootstrap authorization is now present; release tag/npm publish/host install remain separate gates"
    release: "Use the configured source/target scope only; stop before any unconfigured external action."
  - id: "B-06"
    scope: "W5"
    condition: "default Memory DB main hash changed again outside the W4 window; W5 baseline is now fab4413b..."
    release: "Keep the 16:06:25 no-holder/no-sidecar baseline as the W5 before snapshot and verify the same hash after repository writes."
evidence:
  - command: "git status --short --branch; git rev-parse HEAD; git branch --show-current"
    result: "main at c68ecfb01132f1daf9cdb0cf3e4572d42d987b4f with the attributable MIT migration and user untracked files"
    recorded_at: "2026-08-17T12:08:08+08:00"
  - command: "Git status/relevant diff/relevant untracked SHA-256 fingerprints"
    result: "status 18a703fe..., diff 5a6c16c2..., untracked e205dd04..., 45 status entries"
    recorded_at: "2026-08-17T12:08:08+08:00"
  - command: "npm --prefix npm run check"
    result: "pass: version and main package contract for 0.2.1"
    recorded_at: "2026-08-17T12:11:00+08:00"
  - command: "npm --prefix npm test"
    result: "79/79 pass, zero fail/skip/todo; this is the pre-W1 baseline"
    recorded_at: "2026-08-17T12:11:00+08:00"
  - command: "npm --prefix npm run check:docs"
    result: "pass: 47 Markdown files checked; docs remains ignored by Git"
    recorded_at: "2026-08-17T12:11:00+08:00"
  - command: "git diff --check"
    result: "pass with a pre-existing CRLF normalization warning for the vendored notices file"
    recorded_at: "2026-08-17T12:11:00+08:00"
  - command: "npm view for xuanling-mcp and four xuanling-dsh packages at 0.2.1"
    result: "all five public names returned E404; network request itself succeeded"
    recorded_at: "2026-08-17T12:09:00+08:00"
  - command: "gh repo view umbrella22/xuanling-zcode-marketplace"
    result: "repository not found; target is not yet created"
    recorded_at: "2026-08-17T12:07:00+08:00"
  - command: "git ls-remote --heads origin"
    result: "empty; canonical GitHub repository currently has no remote branch"
    recorded_at: "2026-08-17T12:10:00+08:00"
  - command: "DSH revision/status and current package-install documentation inspection"
    result: "47f94385...; profile-local pnpm node_modules contract confirmed; two untracked comparison tests preserved"
    recorded_at: "2026-08-17T12:05:00+08:00"
  - command: "ZCode Info.plist, official plugin page, built-in diagnosing-plugins Skill, and app.asar contract inspection"
    result: "ZCode 3.7.7; web docs list npm but installed contract rejects npm/pip; plugin sync archive default is 50 MiB and remote source entries are not mirrored inline"
    recorded_at: "2026-08-17T12:06:00+08:00"
  - command: "git status --porcelain=v1 -z --untracked-files=all; git rev-parse HEAD; DSH revision/status"
    result: "W0 entry revalidated at c68ecfb...; pre-change source status 18a703fe... with 45 classified entries; DSH remains 47f94385... / 89b2a20a... with exactly two preserved untracked tests"
    recorded_at: "2026-08-17T13:00:00+08:00"
  - command: "git check-ignore -v docs/plans/host-local-integration-distribution-development-plan.md before and after removing .gitignore docs/*"
    result: "expected red was .gitignore:4 docs/*; after removing only that rule check-ignore exits 1 and 23 attributable docs files are visible"
    recorded_at: "2026-08-17T13:04:00+08:00"
  - command: "npm --prefix npm run check; npm --prefix npm test; npm --prefix npm run check:docs; git diff --check"
    result: "W0 gates pass: package check OK, 79/79 Node tests, 49 Markdown files, and no whitespace error; existing vendored CRLF warning remains"
    recorded_at: "2026-08-17T13:05:00+08:00"
  - command: "npm view five public packages at 0.2.1; git ls-remote --heads origin; gh repo view target"
    result: "all five npm items remain E404; origin still has no remote branch; target repository now exists but has no default branch"
    recorded_at: "2026-08-17T13:03:00+08:00"
  - command: "metadata-only prerequisite presence check and default Memory DB pre/post SHA-256"
    result: "npm bootstrap, publisher-signing, and GitHub App variables are missing in the execution environment; no values were read; default DB stayed 89869747... before/after W0"
    recorded_at: "2026-08-17T13:05:00+08:00"
  - command: "focused W1 Node tests plus npm full test with dot reporter"
    result: "W1 correct red: 88 total, 80 pass and 8 expected failures; DSH 2 red, launcher 1 red, ZCode 2 red, release 3 red; synthetic fixture and every pre-W1 test pass"
    recorded_at: "2026-08-17T13:10:00+08:00"
  - command: "node --test npm/test/deepseek-harness-skills.test.mjs; npm --prefix npm run check:docs; git diff --check"
    result: "Skills purity 6/6 green, docs 49 files green, diff clean apart from the existing vendored CRLF warning"
    recorded_at: "2026-08-17T13:10:00+08:00"
  - command: "node --test DSH bundle, Skills, schema projection, package, and target focused suites"
    result: "W2 green: 21/21 DSH/adapter and 8/8 launcher/target tests; profile-local launcher executes with PATH empty"
    recorded_at: "2026-08-17T13:20:00+08:00"
  - command: "pack-dsh-bundles.mjs and verify-dsh-release-set.mjs at version 0.2.1"
    result: "four exact tarballs verified; memory 7783 bytes, skills 6751, tools 2970, replace 3295; package manifests record current sha512 integrity"
    recorded_at: "2026-08-17T13:20:00+08:00"
  - command: "npm full dot reporter; docs; wording scan; diff; DSH/default DB fingerprints"
    result: "84 pass / only 5 expected W3-W4 red; 57 Markdown files green; no DSH global/PATH wording; DSH 89b2a20a... and DB 89869747... unchanged"
    recorded_at: "2026-08-17T13:21:00+08:00"
  - command: "ZCode source contracts; synthetic core release staging; stage-zcode-marketplace twice; verify-zcode-marketplace; cmp archives"
    result: "W3 deterministic green: tree c77faadc96ab0c18f91e2ca308de53d4b00a2d9a673cac71879b26ea538aec01 and archive a6b2c722cd82daa5fac593bf0fabed642343546d1d10a750cdbcdc3ea717f12b match across both runs; exact three-target package/hash projection verified"
    recorded_at: "2026-08-17T13:43:00+08:00"
  - command: "smoke-mcp.mjs against generated ZCode Darwin launcher with explicit temporary --memory-db"
    result: "pass: initialize, 39 tools, system_info; generated launcher resolved the real Darwin package without global npm or PATH fallback"
    recorded_at: "2026-08-17T13:43:00+08:00"
  - command: "node --test npm/test/zcode-plugin-contract.test.mjs; npm check/docs/diff; npm full dot reporter; DSH/default DB fingerprints"
    result: "ZCode 9/9 including deterministic and fail-closed negative fixtures; package/docs/diff green; full suite 87 pass with exactly 3 W4 entry reds; DSH revision/status unchanged and default DB main hash remains 89869747..."
    recorded_at: "2026-08-17T13:51:00+08:00"
  - command: "npm --prefix npm run check:docs; mandatory-wave field audit; durable-doc leak scan; trailing-whitespace scan; git diff --check"
    result: "plan authoring green: 49 Markdown files checked, W0-W6 each include all mandatory fields, no conversation/secret/local absolute-path leak, no trailing whitespace, and diff check clean apart from one pre-existing CRLF normalization warning"
    recorded_at: "2026-08-17T12:20:00+08:00"
  - command: "node --test npm/test/release-distribution-contract.test.mjs; actionlint source and target workflows"
    result: "8/8 release contracts and actionlint pass; source/target GitHub App permissions are separately scoped and both are verified before publish"
    recorded_at: "2026-08-17T14:40:00+08:00"
  - command: "pack-dsh-bundles.mjs twice; verify-dsh-release-set.mjs twice; diff -rq"
    result: "four exact sourceCommit-bearing DSH tarballs pass both times and the two output trees are byte-identical"
    recorded_at: "2026-08-17T14:48:00+08:00"
  - command: "strict verify-release-set.mjs against the unsigned W3 core fixture"
    result: "expected fail-closed result: darwin-arm64 release signature metadata is missing"
    recorded_at: "2026-08-17T14:49:00+08:00"
  - command: "stage-zcode-marketplace.mjs and verify-zcode-marketplace.mjs twice after pre-release README freeze; diff/cmp"
    result: "current local projection is deterministic: tree 188f2adec14b17ebec08dde45c051dc8e5322ee828ec057ad0faaba261e93782; archive e1916a98c7a696fa79b63b1a3b34814954ea90492f5eece3f06baab2ccc62dd7"
    recorded_at: "2026-08-17T14:58:00+08:00"
  - command: "npm --prefix npm test; npm run check/check:docs; actionlint; git diff --check"
    result: "Previous W4 local gates pass: 96/96 Node tests, manifest contract, 59 Markdown files, source/target workflow syntax, and whitespace; App/dispatch assertions are now stale because C-06 changed."
    recorded_at: "2026-08-17T15:08:00+08:00"
  - command: "npm prerequisite, origin heads, target repo, DSH, credential-presence-only, and DB isolation preflights"
    result: "five npm names remain E404; origin has no heads; target exists but is empty; all named W5 credentials are missing; DSH revision/status unchanged; no secret value read"
    recorded_at: "2026-08-17T15:01:00+08:00"
  - command: "default DB main-file hash, lsof/stat attribution, npm isolation window, sidecar check"
    result: "incident: original 89869747... main hash changed externally to af6dbadc...; no holder or WAL/SHM remained; af6dbadc... stayed identical through the W4 95/95 and final 96/96 gates"
    recorded_at: "2026-08-17T15:08:00+08:00"
  - command: "current source/DSH fingerprints"
    result: "checkout 2fbeb952... from status 2691c6a4..., diff ddc47a8d..., untracked b4463551...; DSH status remains 89b2a20a... with two preserved untracked tests"
    recorded_at: "2026-08-17T15:05:00+08:00"
  - command: "GitHub Environment metadata and target repository API preflight"
    result: "Environment zcode-packer exists; XL_PUBLISH_TOKEN secret metadata and ZCODE_REPOSITORY variable metadata are present; variable equals umbrella22/xuanling-zcode-marketplace; secret value was not read. Target repository exists, is empty, has no default branch, and current user has ADMIN."
    recorded_at: "2026-08-17T15:55:00+08:00"
  - command: "node --test npm/test/release-distribution-contract.test.mjs; npm --prefix npm test; npm --prefix npm run check; npm --prefix npm run check:docs; actionlint .github/workflows/*.yml; git diff --check"
    result: "Direct-promotion W4 rebuild green: release contracts 8/8, full Node 96/96, manifest/docs/workflow/diff gates pass; target template has exactly README.md, README-ZH.md, LICENSE; App/dispatch runtime references are absent."
    recorded_at: "2026-08-17T16:04:00+08:00"
  - command: "GitHub source/target API, Environment metadata, source/DSH fingerprints, and default DB isolation snapshot"
    result: "source and target identities exact with interactive push/admin; target default-branch setting is main but no refs exist; zcode-packer metadata exact without reading secret; DSH remains 47f94385.../89b2a20a...; DB is fab4413b... with no holder/WAL/SHM."
    recorded_at: "2026-08-17T16:06:25+08:00"
  - command: "target bootstrap commit/push and GitHub API readback"
    result: "Created target root commit 54a21771... on main; remote root contains exactly LICENSE, README-ZH.md, README.md; no xuanling-mcp-v tag exists; default DB remained fab4413b... with no holder/WAL/SHM."
    recorded_at: "2026-08-17T16:12:00+08:00"
  - fact: "Pre-W1 DSH tool bundles fell back to PATH xuanling-mcp and the ZCode source carried only Darwin ARM64 plus two divergent MCP launch contracts."
    source: "pre-W1 captured package manifests, cordis patches, plugin.json, .mcp.json, and red contract tests"
stop_conditions:
  - "Unknown overlap with the existing MIT migration or user-owned untracked files"
  - "Any Rust/MCP/Memory/default-DB or DSH upstream mutation"
  - "Any external write before W5 exact authorization"
  - "Any secret content read, copied, hashed, logged, or persisted"
  - "Any attempt to replace publisher signing with ad-hoc signing, AV bypass, or unsigned release"
```

## Evidence Log

W0 已完成：dirty set 已归属，`docs/*` 的过宽 ignore 已移除，23 个 attributable docs 文件可被 Git
发现；Node、文档、diff 与 DSH 基线 current。原默认 Memory DB 基线随后因计划外 host 活动发生
漂移，已作为 B-06 incident保留；W4 使用新基线重建了隔离窗口，W5仍必须再次即时快照。

W3 complete：源码只保留 runtime template；生成器从已验证 core tarballs 构造三平台单插件，
两次生成 tree/archive 字节相同，verifier 对精确文件树、package metadata、native hash、immutable
source 与 secret-shaped 文件 fail closed；Darwin launcher 使用临时 DB 完成真实 MCP smoke。完整 Node
集的 3 个剩余失败均是 W4 的预期入口红合同，已在计划中明确为 staged gate。

W4 local scope已按新 C-06 重建并再次 complete：workflow在 build/publish前通过 `zcode-packer`
验证 exact source/target identity、secret presence、authenticated access、`permissions.push=true`和
target default branch；八个 npm item完整对账后，source job checkout target，验证 immutable artifact，
并用 atomic push提交 main/tag。promotion helper移到 `npm/scripts`，target bootstrap template只保留
双语 README 与 LICENSE。旧 GitHub App/repository_dispatch evidence仅作为 stale history保留。真实签名
与发布尚未执行。

Pre-release README已在 W4冻结：npm双语文档描述八项发布/恢复链，ZCode integration只保留 agent
安装后的 marketplace、Node、runtime和安全信息。该变化使旧 W3 digest stale；当前两次生成的
tree/archive为 `188f2adec14b17ebec08dde45c051dc8e5322ee828ec057ad0faaba261e93782` /
`e1916a98c7a696fa79b63b1a3b34814954ea90492f5eece3f06baab2ccc62dd7`。这些仍是 dirty checkout的
local projection，不是可发布 artifact；真实 source commit、签名和 registry integrity留给 W5。

```text
EXECUTION_STATUS: BLOCKED
PLAN_ID: host-local-integration-distribution-20260817
CHECKOUT_FINGERPRINT: 2fbeb952969fe04045148e47319330a5eaa3ce6141f100807e1e4684b3688525
CURRENT_WAVE: W5
CURRENT_WORK_PACKAGE: W5.1
WAVE_STATE: not_started
CONTRACTS_PROVEN: C-01/C-02 profile-local DSH distribution; C-03 deterministic cross-platform ZCode projection; C-04 signing-before-hash pipeline local contract; C-05 eight-item idempotent release; C-08 preservation
EVIDENCE_ADDED: zcode-packer environment metadata and target ADMIN fact; previous W4 evidence marked stale; deterministic DSH/ZCode outputs; strict unsigned rejection; pre-release README freeze; DB incident and restored isolation window
FAILED_GATES: none in W4 local scope; W5 external prerequisites are blocked, not synthetic failures
NOT_RUN_GATES: direct-push red/green contracts; protected-runner publisher signing; canonical push/tag; npm publication/reconciliation; target bootstrap/direct promotion; DSH/ZCode/three-platform live acceptance; W6 Rust/final gates
BLOCKERS: B-01 through B-04 and B-06; source/target write authorization is present, but origin/target branches, npm bootstrap, publisher signing and fresh DB window remain unresolved
NEXT_EXACT_ACTION: add direct-push contract tests for zcode-packer and remove stale App/dispatch assumptions before editing the release workflow
LEDGER_PATH: docs/plans/host-local-integration-distribution-execution-ledger.md
```
