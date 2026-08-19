# Host 本地集成与分发执行账本

```yaml
schema_version: 1
plan_id: "host-local-integration-distribution-20260817"
updated_at: "2026-08-17T19:23:18+08:00"
plan_status: "executing"
checkout:
  revision: "d7d3efb91191ca8f80969abfd90e49fdb2047aaf"
  branch: "main"
  status_sha256: "ae65d65fc481092bcd1e693e0e97c0af63fe699a6f3d263017647e0ff68e7675"
  status_entry_count: 2
  relevant_diff_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  relevant_untracked_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  notes:
    - "Existing MIT migration overlaps Cargo/npm/DSH/ZCode release files; preserve and work with it."
    - "User-owned untracked AGENTS.md and plan.md are outside this plan and must remain untouched."
    - "W0.3 removed only the broad docs/* ignore; 23 attributable docs files are now visible to Git."
    - "The 45-entry pre-W0 set was classified as 34 tracked MIT migration entries, 9 untracked MIT files, and 2 user-owned untracked files."
    - "Current relevant_untracked_sha256 excludes user-owned AGENTS.md/plan.md and this ledger to avoid self-referential fingerprints; the plan remains included."
    - "The previous d7b415f6... release candidate is stale; a239a04... is the exact pushed and manually preflighted 0.2.1 release source."
    - "Current relevant_diff_sha256 excludes this self-referential ledger; relevant_untracked_sha256 excludes AGENTS.md/plan.md, leaving both relevant sets empty after d61e762...."
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
  current_sha256: "45c359aa6f18542f8eca08eca84cbec6f0766a0735a2677da919ee2f5e2dab0c"
  incident: "Main DB changed again outside the recorded W5 release window; mtime is 2026-08-17T18:26:10+08:00 and no holder or WAL/SHM remained at the 2026-08-17T18:45:20+08:00 snapshot. Treat this as an unrelated isolation incident and do not restore or mutate the user DB."
  w4_isolation_window: "af6dbad... before npm 95/95 and still identical after final npm 96/96; sidecars absent"
release:
  version: "0.2.2"
  source_commit: "d61e7622e1108e8020f3189460b7f03ce6ed08a1"
  source_tag: "xuanling-mcp-v0.2.2"
  release_run: 32020739545
  release_run_attempt: 3
  release_run_conclusion: "failure"
  release_failure: "Attempt 3 used the newly replaced repository bootstrap secret. npm accepted its write authorization but rejected the first native publish with EOTP because the token did not effectively bypass 2FA; zero registry items were published and ZCode promotion was skipped."
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
  failed_source_tag: "xuanling-mcp-v0.2.1"
  failed_source_commit: "a239a04e354e2877c49ddb409b529bcdf74ebad7"
  failed_release_run: 32017795111
  missing_public_package_names:
    - "xuanling-mcp"
    - "xuanling-dsh-memory"
    - "xuanling-dsh-skills"
    - "xuanling-dsh-tools"
    - "xuanling-dsh-tools-replace"
  missing_registry_items:
    - "xuanling-mcp@0.2.2-darwin-arm64"
    - "xuanling-mcp@0.2.2-linux-x64-gnu"
    - "xuanling-mcp@0.2.2-win32-x64-msvc"
    - "xuanling-mcp@0.2.2"
    - "xuanling-dsh-memory@0.2.2"
    - "xuanling-dsh-skills@0.2.2"
    - "xuanling-dsh-tools@0.2.2"
    - "xuanling-dsh-tools-replace@0.2.2"
completed_waves:
  - "W0"
  - "W1"
  - "W2"
  - "W3"
  - "W4"
current_wave: "W5"
current_work_package: "W5.5"
wave_state: "deterministic_green"
clean_acceptance_count: 0
last_completed_action: "Ran release attempt 3 with the replaced repository token: all prerequisite/build/smoke/assembly/attestation/materialization gates passed and npm advanced from E403 to EOTP, proving write authorization while showing that Bypass 2FA is not effective; all eight items remain absent and promotion was skipped."
next_action: "Generate a new granular npm token with package/scopes Read and write, All Packages, and Bypass two-factor authentication explicitly enabled in the final token summary; replace repository NPM_BOOTSTRAP_TOKEN, then rerun 32020739545 and reconcile all eight registry items plus the ZCode target tag/tree."
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
  - "Cargo.toml"
  - "Cargo.lock"
  - "README.md"
  - "README-ZH.md"
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
  - "GitHub tag run 32017795111 job 95352471779: downloaded ZCode marketplace payload_sha256 differed because actions/upload-artifact does not preserve executable modes; failure occurred in pre-publish reverify, so zero npm items were published and promotion was skipped."
  - "GitHub tag run 32020739545 job 95361218225: first npm publish xuanling-mcp@0.2.2-darwin-arm64 returned E403 'You may not perform that action with these credentials' after npm whoami and provenance generation; all eight registry items remain missing and ZCode promotion was skipped."
  - "GitHub run 32020739545 attempt 2 job 95366930103: repository-scoped bootstrap secret authenticated, but the same first native publish returned E403; all eight registry items remain missing and ZCode promotion was skipped."
  - "GitHub run 32020739545 attempt 3 job 95371195310: replacement repository token reached package write authorization but first native publish returned EOTP requiring an authenticator code; all eight registry items remain missing and ZCode promotion was skipped."
not_run_commands:
  - "The immutable 0.2.2 release tag exists and its build/attestation path passed, but npm publish/reconciliation, direct promotion, and ZCode/DSH live installs have not succeeded; failed immutable 0.2.1 tag is retained."
  - "No full Rust test in this W4.7 repair because Rust semantics are unchanged; locked xuanling-mcp cargo check passed and W6 still requires the final Rust gates."
blockers:
  - id: "B-09"
    scope: "W5"
    condition: "Attempt 3 proved the replacement repository NPM_BOOTSTRAP_TOKEN authenticates and has package write authorization, but npm rejects xuanling-mcp@0.2.2-darwin-arm64 with EOTP. The token's Bypass two-factor authentication setting is not effective for publishing."
    release: "Generate another granular token and verify its final website summary explicitly shows package/scopes Read and write, All Packages, and Bypass 2FA enabled; replace the repository secret and rerun 32020739545. Remove the bootstrap secret only after all eight items reconcile and Trusted Publishing is configured."
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
  - command: "Git Data API exact-object push and remote main readback"
    result: "Uploaded the 18 committed blobs, reproduced exact tree 964c8872... and exact commit a239a04..., then advanced remote main without force from e5b782d...; user-owned AGENTS.md/plan.md remained untracked."
    recorded_at: "2026-08-17T17:53:00+08:00"
  - command: "GitHub workflow_dispatch run 32017485221 plus source/target tag and npm registry audit"
    result: "Run passed on exact a239a04...: validate-release, npm-prerequisites including authenticated npm whoami, and zcode-prerequisites including permissions.push=true all succeeded; all six build/publish/promotion jobs were skipped. Source/target tags remain absent and all five public names remain E404."
    recorded_at: "2026-08-17T17:55:00+08:00"
  - command: "GitHub tag run 32017795111, failed publish-job log, and immediate registry reconciliation"
    result: "All three native builds, MCP smokes, release-set assembly and OIDC attestation passed. Publish job failed before configuring npm authentication because the downloaded directory artifact lost executable modes and payload_sha256 changed; promotion was skipped and every public package remained E404. Immutable source tag xuanling-mcp-v0.2.1 remains at a239a04...."
    recorded_at: "2026-08-17T18:05:00+08:00"
  - command: "artifact transport red/green; npm full/check/docs; actionlint; locked cargo check; git diff --check"
    result: "Correct red first failed on the missing materializer after a fixture-import false red was repaired. The implementation transports only pack+archive, validates archive schema/digests/regular canonical paths, restores modes, reruns the strict verifier, and rejects tamper/extra files. Full Node 98/98, package check at 0.2.2, 59 Markdown files, actionlint, cargo check --locked -p xuanling-mcp, and whitespace all pass."
    recorded_at: "2026-08-17T18:21:52+08:00"
  - command: "Git Data API exact-object push and GitHub workflow_dispatch run 32020294499"
    result: "Remote main advanced without force to exact commit d61e762.../tree ef5f3593.... The 0.2.2 preflight passed validate-release, authenticated npm bootstrap prerequisites, and exact ZCode push permission; all six side-effect jobs were skipped."
    recorded_at: "2026-08-17T18:29:13+08:00"
  - command: "GitHub tag run 32020739545, failed publish log, eight-item npm registry reconciliation, and target repository readback"
    result: "Exact 0.2.2 tag at d61e762... built and smoked all three native targets, packed four DSH bundles, assembled/attested the ZCode archive, and successfully materialized it across jobs. The first publish generated provenance but npm returned E403; all eight exact registry items remain E404, target main remains 54a21771..., and no target 0.2.2 tag exists."
    recorded_at: "2026-08-17T18:45:20+08:00"
  - command: "gh secret list at repository and npmjs Environment scopes"
    result: "NPM_BOOTSTRAP_TOKEN metadata exists at both scopes. No value was read, copied, hashed, or logged. Because publish and prerequisite jobs declare environment npmjs, the Environment secret shadows the repository secret; rerunning unchanged would not test the repository credential."
    recorded_at: "2026-08-17T18:45:20+08:00"
  - command: "default Memory DB SHA-256/stat/sidecar/lsof snapshot"
    result: "Unrelated incident: main DB is now 45c359aa... with mtime 2026-08-17T18:26:10+08:00; no WAL/SHM or holder exists. No DB write or recovery was attempted."
    recorded_at: "2026-08-17T18:45:20+08:00"
  - command: "GitHub run 32020739545 attempt 2 after removing npmjs Environment NPM_BOOTSTRAP_TOKEN; failed log; eight-item registry, target, and DB reconciliation"
    result: "The repository secret was the only remaining NPM_BOOTSTRAP_TOKEN and passed npm whoami. All three native build/smoke/staging jobs, DSH bundles, release assembly, OIDC attestation, and cross-job ZCode materialization passed. The first publish still returned E403 after emitting provenance; all eight exact registry items remain E404, target main/tag are unchanged, and default DB remains 45c359aa... without sidecars or holder."
    recorded_at: "2026-08-17T19:06:29+08:00"
  - command: "GitHub run 32020739545 attempt 3 with replacement token; failed log; eight-item registry, target, and DB reconciliation"
    result: "All prerequisite/build/smoke/staging jobs, DSH bundles, release assembly, OIDC attestation, and ZCode materialization passed. The first publish changed from E403 to explicit EOTP requiring a one-time authenticator code, proving write permission but disproving effective Bypass 2FA. All eight registry items remain E404, target remains on bootstrap main without a 0.2.2 tag, and default DB remains 45c359aa... without sidecars or holder."
    recorded_at: "2026-08-17T19:23:18+08:00"
  - command: "final default DB, DSH checkout, source status, and source/target tag audit"
    result: "DB remains fab4413b... with no holder/WAL/SHM; DSH remains 47f94385.../89b2a20a... with its exact two user files; source has only user AGENTS.md/plan.md untracked; source and target have no tags. B-06 is a stable incident, not an active blocker."
    recorded_at: "2026-08-17T16:55:00+08:00"
  - fact: "Pre-W1 DSH tool bundles fell back to PATH xuanling-mcp and the ZCode source carried only Darwin ARM64 plus two divergent MCP launch contracts."
    source: "pre-W1 captured package manifests, cordis patches, plugin.json, .mcp.json, and red contract tests"
stop_conditions:
  - "Unknown overlap with the existing MIT migration or user-owned untracked files"
  - "Any Rust/MCP/Memory/default-DB or DSH upstream mutation"
  - "Any external write outside the exact W5 authorization"
  - "Any secret content read, copied, hashed, logged, or persisted"
  - "Any missing/ambiguous releaseTrust state, fake/ad-hoc publisher-signing claim, provenance bypass, attestation bypass, or AV bypass"
```

## Evidence Log

W0 已完成：dirty set 已归属，`docs/*` 的过宽 ignore 已移除，23 个 attributable docs 文件可被 Git
发现；Node、文档、diff 与 DSH 基线 current。原默认 Memory DB 基线随后因计划外 host 活动发生
漂移；最新快照为 `45c359aa...`，mtime `2026-08-17T18:26:10+08:00`，且无 holder/sidecar。该变化
作为用户数据隔离 incident 保留，不归因于本计划，也不对用户 DB 做恢复或写入；后续 live 动作仍须
即时复核。

W3 complete：源码只保留 runtime template；生成器从已验证 core tarballs 构造三平台单插件，
两次生成 tree/archive 字节相同，verifier 对精确文件树、package metadata、native hash、immutable
source 与 secret-shaped 文件 fail closed；Darwin launcher 使用临时 DB 完成真实 MCP smoke。完整 Node
集的 3 个剩余失败均是 W4 的预期入口红合同，已在计划中明确为 staged gate。

W4 complete：首次 W4 preflight run `32017485221`通过，但真实 tag run `32017795111`
暴露 directory artifact跨 job后 executable mode丢失，严格 payload hash在任何 npm publish前正确
拒绝。修复不放宽 mode合同：artifact只传 pack + attested archive，下游先校验并 materialize archive，
恢复 canonical mode后复用原 verifier。0.2.2本地 Node 98/98、docs、actionlint、locked cargo check与
diff gate全部通过；exact source `d61e762...`已推送，manual preflight run `32020294499`三个 prerequisite
jobs通过且全部副作用 jobs skipped。

Pre-release README与所有 package/template已提升到 0.2.2 trust合同：明确 publisher unsigned、npm
provenance、source-bound SHA和 GitHub-attested ZCode archive。失败的 0.2.1 source tag保持指向
`a239a04...`，未产生 registry item。目标仓库仍停在 bootstrap commit `54a21771...`，无 target tag、
registry item或 promotion tree；当前 0.2.2 source candidate为 `d61e762...`。

W5.1-W5.4 complete：target identity/bootstrap、0.2.2 source push与 credential gate均绑定当前事实。
0.2.2 tag run `32020739545` 的三平台 build/smoke、四个 DSH bundle、release assembly、OIDC attestation
与跨 job ZCode materialization均通过；首个 `xuanling-mcp@0.2.2-darwin-arm64` publish 在生成 provenance
后返回 npm E403。八个 registry item仍全部缺失，target仍为 bootstrap commit且无 0.2.2 tag。

`npmjs` Environment中的同名 `NPM_BOOTSTRAP_TOKEN`已删除，attempt 2明确使用 repository secret。
Attempt 3替换 token后，真实 publish从 E403推进到明确的 EOTP：package write权限已生效，但 token
没有有效绕过发布 2FA。B-09现只剩 Granular Access Token的 `Bypass two-factor authentication`设置。
必须在 npm网站生成 token并核对最终 summary明确显示 Read and write、All Packages、Bypass 2FA启用，
然后再次运行同一 idempotent release；发布成功并配置 Trusted Publishing后才删除 bootstrap secret。
此外 W6 portability已有独立真实红色，当前分发计划禁止用 Rust修改或跳测化解。

```text
EXECUTION_STATUS: HANDOFF_REQUIRED
PLAN_ID: host-local-integration-distribution-20260817
CHECKOUT_FINGERPRINT: revision d7d3efb91191ca8f80969abfd90e49fdb2047aaf; status baseline ae65d65f... with only user AGENTS.md/plan.md, plus this ledger-only continuation
CURRENT_WAVE: W5
CURRENT_WORK_PACKAGE: W5.5
WAVE_STATE: deterministic_green
CONTRACTS_PROVEN: C-01/C-02 profile-local DSH bundles; C-03 deterministic ZCode projection/target bootstrap; C-04 explicit releaseTrust + mandatory npm provenance + OIDC attestation pipeline; C-05 ordered idempotent release; C-06 direct promotion permission; C-08 preservation; cross-job ZCode artifact mode restoration and authenticated 0.2.2 preflight
EVIDENCE_ADDED: run 32020739545 attempt 3 replacement token changed first publish failure from E403 to explicit EOTP; all build/smoke/DSH/attestation/materialization gates green; eight registry items absent; target and Memory DB unchanged
FAILED_GATES: run 32020739545 attempts 1-2 first publish E403 and attempt 3 EOTP, all with zero registry items; run 32017795111 historical artifact mode-loss incident; xuanling-portability 32010247767 Windows toolkit contract 102 pass/11 fail
NOT_RUN_GATES: successful npm publish/reconciliation; ZCode direct promotion; clean DSH installs/model calls; ZCode install/restart; W6 final parity and regression
BLOCKERS: B-09 replacement repository token has write permission but npm returns EOTP because Bypass 2FA is not effective; B-07 Windows capability portability requires a separately authorized Rust work package
NEXT_EXACT_ACTION: create a granular npm token whose final summary explicitly shows Read and write, All Packages, and Bypass 2FA enabled; replace repository NPM_BOOTSTRAP_TOKEN, then rerun 32020739545
LEDGER_PATH: docs/plans/host-local-integration-distribution-execution-ledger.md
```

## 2026-08-18 后续发布事实 reconciliation

本节只追加后来发生的外部事实，不重写上述 `0.2.2` EOTP、artifact transport 或 Memory DB
incident 的历史证据，也不把旧计划的未完成 Wave 追记为 `complete`。

- 后续 source tag `xuanling-mcp-v0.2.3` 解析到 commit
  `eec429d009481e193295678b9aa244d44c5d52a2`。GitHub Actions run `32041239940` 的
  `publish ordered npm release set` job 使用 OIDC Trusted Publishing 成功发布并对账八个 scoped
  immutable npm items；因此旧账本的 bootstrap token、E403/EOTP 与 registry-absence blocker 已被
  `0.2.3` 发布事实 supersede，但其失败记录仍保留为历史证据。
- 同一 run 的 `directly promote verified ZCode marketplace` job 成功；目标仓库
  `umbrella22/xuanling-zcode-marketplace` 的 `main` 与 tag `xuanling-mcp-v0.2.3` 当前均指向
  commit `20ffab546f470cf516a03a33d5b16be916c9390b`，tree
  `c822eb7c6c4ef32d5f62e805dd4c347d69fe5d74`。
- 这次 reconciliation 不证明旧计划未完成的 DSH clean profile、ZCode clean install/restart、真实
  model route 或最终 host parity。当前本机只读基线显示 ZCode 3.7.7 build 3.7.7.4926 已缓存
  marketplace `xuanling-mcp@0.2.3`。
- Windows portability 仍是独立 release gate：run `32094516238` 在同一后续 source revision
  `9a08f33a2582e4a6c61d0eceb3bfb6f3657ef13f` 上为 Linux/macOS green、Windows toolkit contract
  `102 passed / 11 failed`。不得用 `0.2.3` 已发布的事实将该缺口标为已解决。
- 新的 canonical 执行状态由
  `host-result-projection-agent-efficiency-execution-ledger.md` 维护；本旧账本不再作为后续版本的
  `next_action` 来源。
