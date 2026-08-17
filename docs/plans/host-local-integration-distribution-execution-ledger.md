# Host 本地集成与分发执行账本

```yaml
schema_version: 1
plan_id: "host-local-integration-distribution-20260817"
updated_at: "2026-08-17T17:38:00+08:00"
plan_status: "executing"
checkout:
  revision: "e5b782d65173658676ba920ead3785fa789d2233"
  branch: "main"
  status_sha256: "5c4bd15917b0dadaac5e1eb2dc5e338abb56142c562671f82855d3e4c637e63a"
  status_entry_count: 19
  relevant_diff_sha256: "ec1051cd2eee82d5174d11dc2ec18d4f94c63870f7933c3bb920985b31a99652"
  relevant_untracked_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  notes:
    - "Existing MIT migration overlaps Cargo/npm/DSH/ZCode release files; preserve and work with it."
    - "User-owned untracked AGENTS.md and plan.md are outside this plan and must remain untouched."
    - "W0.3 removed only the broad docs/* ignore; 23 attributable docs files are now visible to Git."
    - "The 45-entry pre-W0 set was classified as 34 tracked MIT migration entries, 9 untracked MIT files, and 2 user-owned untracked files."
    - "Current relevant_untracked_sha256 excludes user-owned AGENTS.md/plan.md and this ledger to avoid self-referential fingerprints; the plan remains included."
    - "The previous d7b415f6... release candidate is stale after the user-authorized C-04 trust-contract change; no replacement candidate exists until the implementation is committed."
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
  canonical_main_remote_has_branch: true
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
  local_projection_status: "stale after release-manifest schema v2 and releaseTrust contract change"
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
current_wave: "W4"
current_work_package: "W4.3"
wave_state: "implemented_unverified"
clean_acceptance_count: 0
last_completed_action: "User authorized C-04 amendment: publisher certificates are optional; local red/green rebuilt explicit releaseTrust, mandatory npm provenance, ZCode OIDC attestation, and manual no-tag preflight."
next_action: "Commit and push the release-trust contract change, then manually dispatch npm-publish.yml from main and require validate-release, npm-prerequisites, and zcode-prerequisites to pass while every side-effect job is skipped."
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
  - "GitHub run 32010247812 job 95328077988: 94/96 Node tests; two synthetic evaluation tests failed because /private/tmp is not writable on ubuntu-latest."
  - "GitHub run 32010247767 job 95328077927: Windows toolkit contract failed 11/113 while Linux/macOS passed; Rust capability changes are forbidden in this distribution plan."
  - "GitHub run 32010817052 job 95329784351: Windows native staging reached npm pack and failed with spawn npm ENOENT."
  - "GitHub run 32011470354 job 95331763667: npm.cmd was found but Node 24 direct exec rejected the batch shim with spawn EINVAL."
  - "Expected contract red: release trust API absent, workflow still required release-signing certificates, no workflow_dispatch preflight/attestation, and ZCode release manifest remained schema v1."
not_run_commands:
  - "No GitHub manual preflight yet; repository-scoped NPM_BOOTSTRAP_TOKEN presence is known but its authentication has not been exercised."
  - "No release tag, npm publish, direct promotion, or ZCode/DSH live install; W4 external evidence is stale until push/preflight."
  - "No Rust build/test in W4 because Rust source and MCP/Memory semantics are unchanged; W6 still requires the final Rust gates."
blockers:
  - id: "B-04"
    scope: "W5"
    condition: "npmjs Environment and repository-scoped NPM_BOOTSTRAP_TOKEN metadata exist, but token authentication and first-publish ownership remain unverified"
    release: "Pass the no-tag GitHub preflight, then use the token only for the immutable first release; configure package-level Trusted Publishing and revoke/remove the bootstrap token afterward."
  - id: "B-07"
    scope: "W6"
    condition: "xuanling-portability run 32010247767 fails 11 Windows capability contracts; ten report candidate_resolution_failed/ERROR_INVALID_FUNCTION and one reports Windows symlink-parent error-code drift"
    release: "Open a separately authorized Rust portability work package; do not skip the Windows contracts or mix a capability semantic change into this distribution plan."
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
  - command: "source commit/push and GitHub API readback"
    result: "Committed 105 attributed files as 523b1327... and pushed canonical origin/main; AGENTS.md and plan.md remain untracked and excluded. GitHub API reports the exact commit."
    recorded_at: "2026-08-17T16:24:00+08:00"
  - command: "GitHub run 32010247812 failed-job log; TMPDIR=/tmp focused test; npm full/check/docs/actionlint/diff"
    result: "Confirmed CI-only EACCES at /private/tmp on Ubuntu. Runner/tests now derive the evidence root from node:os.tmpdir(); TMPDIR=/tmp focused suite 30/30 and full Node 96/96 pass; manifest/docs/workflow/diff pass; DB remains fab4413b..."
    recorded_at: "2026-08-17T16:31:00+08:00"
  - command: "GitHub run 32010247767 Windows failed-job log and capability source trace"
    result: "Portability red is current for the unchanged Rust tree: Windows toolkit contract 102 pass/11 fail while Linux/macOS pass. Ten failures report candidate_resolution_failed with ERROR_INVALID_FUNCTION during contained mutation/entry operations; symlink/parent traversal reports not_found instead of outside_capability. No Rust/test weakening was made because this plan forbids Rust semantics changes."
    recorded_at: "2026-08-17T16:37:00+08:00"
  - command: "GitHub runs 32010817052 and 32011470354 Windows failed-job logs"
    result: "First Windows native stage failed at npm pack with spawn npm ENOENT; the narrow npm.cmd mapping then failed under Node 24 with spawn EINVAL. Both failures were retained and replaced by direct node.exe + discovered npm-cli.js argv execution."
    recorded_at: "2026-08-17T16:46:00+08:00"
  - command: "node release contract; npm full/check/docs; actionlint; git diff --check on d7b415f6..."
    result: "Final local distribution gates pass: release contracts 9/9, full Node 97/97, manifest contract, 59 Markdown files, workflow lint, and whitespace check."
    recorded_at: "2026-08-17T16:48:00+08:00"
  - command: "GitHub run 32012128449 and remote main API readback"
    result: "Run success on d7b415f6...: launcher/metadata plus Linux, Darwin ARM64, and Windows x64 native build, MCP smoke, notices, package verification, local tarball install, and installed launcher smoke all passed. Remote main equals d7b415f6...."
    recorded_at: "2026-08-17T16:54:00+08:00"
  - command: "GitHub Environment/target APIs and npm view five public names"
    result: "Only zcode-packer exists; its XL_PUBLISH_TOKEN name and exact ZCODE_REPOSITORY variable are present without reading the secret value. Target main remains bootstrap commit 54a21771... with exactly LICENSE/README.md/README-ZH.md and no tags. All five public package names at 0.2.1 remain E404; npmjs, release-signing, package Trusted Publishing, and signing metadata remain unavailable."
    recorded_at: "2026-08-17T16:54:00+08:00"
  - command: "GitHub Environment/secret-name/variable metadata APIs; npm whoami; check-release-prerequisites.mjs"
    result: "W5.4 was revalidated fail-closed without reading secret values: zcode-packer is the only Environment and has the exact XL_PUBLISH_TOKEN/ZCODE_REPOSITORY metadata; no repository-level Actions secrets or variables exist; npm whoami returns E401; all five package names remain missing and the release prerequisite script exits 1 because NPM_BOOTSTRAP_TOKEN is absent."
    recorded_at: "2026-08-17T17:04:00+08:00"
  - command: "release trust focused red/green; npm full/check/docs; actionlint; git diff --check"
    result: "User-authorized C-04 amendment is locally deterministic: the correct red exposed missing releaseTrust API, mandatory certificate gate, missing preflight/attestation, and schema v1; implementation then passed focused 24/24, full Node 98/98, package check, 59 Markdown files, actionlint, and whitespace. releaseTrust separates required-at-publish npm provenance from explicit publisherSigning=not-provided; missing metadata still fails closed."
    recorded_at: "2026-08-17T17:38:00+08:00"
  - command: "GitHub Environment and repository-secret name APIs"
    result: "npmjs and zcode-packer Environments now exist. Repository secret metadata contains NPM_BOOTSTRAP_TOKEN; no secret value was read, copied, or hashed. Authentication remains a GitHub-runner preflight gate."
    recorded_at: "2026-08-17T17:38:00+08:00"
  - command: "final default DB, DSH checkout, source status, and source/target tag audit"
    result: "DB remains fab4413b... with no holder/WAL/SHM; DSH remains 47f94385.../89b2a20a... with its exact two user files; source has only user AGENTS.md/plan.md untracked; source and target have no tags. B-06 is a stable incident, not an active blocker."
    recorded_at: "2026-08-17T16:55:00+08:00"
  - fact: "Pre-W1 DSH tool bundles fell back to PATH xuanling-mcp and the ZCode source carried only Darwin ARM64 plus two divergent MCP launch contracts."
    source: "pre-W1 captured package manifests, cordis patches, plugin.json, .mcp.json, and red contract tests"
stop_conditions:
  - "Unknown overlap with the existing MIT migration or user-owned untracked files"
  - "Any Rust/MCP/Memory/default-DB or DSH upstream mutation"
  - "Any external write before W5 exact authorization"
  - "Any secret content read, copied, hashed, logged, or persisted"
  - "Any missing/ambiguous releaseTrust state, fake/ad-hoc publisher-signing claim, provenance bypass, attestation bypass, or AV bypass"
```

## Evidence Log

W0 已完成：dirty set 已归属，`docs/*` 的过宽 ignore 已移除，23 个 attributable docs 文件可被 Git
发现；Node、文档、diff 与 DSH 基线 current。原默认 Memory DB 基线随后因计划外 host 活动发生
漂移，作为 B-06 incident保留；W5前后快照均为 `fab4413b...` 且无 holder/sidecar，因此它当前不是
活动 blocker，但后续 live动作仍须即时复核。

W3 complete：源码只保留 runtime template；生成器从已验证 core tarballs 构造三平台单插件，
两次生成 tree/archive 字节相同，verifier 对精确文件树、package metadata、native hash、immutable
source 与 secret-shaped 文件 fail closed；Darwin launcher 使用临时 DB 完成真实 MCP smoke。完整 Node
集的 3 个剩余失败均是 W4 的预期入口红合同，已在计划中明确为 staged gate。

W4 的 C-06 direct-promotion实现仍保留，但用户授权修改 C-04 后，旧 W4 complete证据已 stale。
新合同把 npm provenance、explicit release trust和 ZCode OIDC attestation设为强制，把平台发布者
证书签名降为可选。正确红色和本地 98/98 green均已取得；只有 push后的 Actions/preflight evidence
仍待重建，因此 W4当前为 `implemented_unverified`。

Pre-release README已重建为真实 0.2.1 trust合同：明确 publisher unsigned、npm provenance、source-bound
SHA和 GitHub-attested ZCode archive。旧 source candidate `d7b415f6...` 与 run `32012128449`只能作为
历史 portability/package smoke，不再是当前 release candidate。目标仓库仍停在 bootstrap commit
`54a21771...`，无 source/target tag、registry item或 promotion tree。

W5.1-W5.2 的 target identity/bootstrap facts仍 current；W5.3及以后需绑定新的 source candidate。
`npmjs`和 `zcode-packer` Environments均已存在，repository secret metadata包含一次性
`NPM_BOOTSTRAP_TOKEN`，但只有 manual GitHub preflight能证明 token认证与 target permission同时成立。
此外 W6 portability已有独立真实红色，当前分发计划禁止用 Rust修改或跳测化解。

```text
EXECUTION_STATUS: HANDOFF_REQUIRED
PLAN_ID: host-local-integration-distribution-20260817
CHECKOUT_FINGERPRINT: revision e5b782d65173658676ba920ead3785fa789d2233; status 5c4bd159...; relevant diff ec1051cd...; relevant untracked e3b0c442...
CURRENT_WAVE: W4
CURRENT_WORK_PACKAGE: W4.3
WAVE_STATE: implemented_unverified
CONTRACTS_PROVEN: C-01/C-02 profile-local DSH bundles; C-03 deterministic ZCode projection/target bootstrap; amended C-04 explicit releaseTrust + npm provenance + OIDC attestation locally; C-05 ordered idempotent release; C-06 direct promotion; C-08 preservation
EVIDENCE_ADDED: correct release-trust red; focused 24/24; full Node 98/98; npm check; 59 docs; actionlint; diff check; npmjs/zcode-packer and repository secret-name metadata without reading values
FAILED_GATES: xuanling-portability 32010247767 Windows toolkit contract 102 pass/11 fail; historical npm runs 32010247812, 32010817052, and 32011470354 remain retained but are resolved by green run 32012128449
NOT_RUN_GATES: GitHub manual preflight; tag CI provenance/attestation; npm publish/reconciliation; ZCode direct promotion; clean DSH installs/model calls; ZCode install/restart; W6 final parity and regression
BLOCKERS: B-04 bootstrap token authentication/first-publish ownership unverified until no-tag preflight; B-07 Windows capability portability requires a separately authorized Rust work package
NEXT_EXACT_ACTION: commit/push the amended trust contract, then manually dispatch npm-publish.yml from main and require only the three preflight jobs to pass
LEDGER_PATH: docs/plans/host-local-integration-distribution-execution-ledger.md
```
