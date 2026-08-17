# DeepSeek Harness 专用 Skills 与文件工具评估执行账本

> 本文件是 `deepseek-harness-skills-filesystem-evaluation-development-plan.md` 的 canonical handoff。
> W0-W7 完成；候选报告保持 `candidate_not_applied`，隔离 Web 服务留存供用户试用。

```yaml
schema_version: 1
plan_id: "deepseek-harness-skills-fs-eval-20260815"
updated_at: "2026-08-16T00:55:00Z"
plan_status: "complete"
checkout:
  revision: "47f1cff156896cd3006258b6e4519a4bb2bc3f6a"
  branch: "main"
  status_sha256: "afde7a15b0f568812bf01dd6be99fff8ceb3aec6abf2f8a63e69c00b237b31f2"
  status_entry_count: 152
  relevant_diff_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  relevant_untracked_sha256: "8a1e05fdd6336a0bbe51f2222ea9b8f7f095276a18be6f47856c602e9d399e6e"
  fingerprint_scope: "W7 final checkout; hashes computed with the exact commands below"
  fingerprint_commands:
    status: "git status --short --untracked-files=all | shasum -a 256"
    relevant_diff: "git diff -- docs/plans integrations npm/test | shasum -a 256"
    relevant_untracked: "git ls-files --others --exclude-standard -- docs/plans integrations | shasum -a 256"
  authoring_baseline:
    status_sha256: "7741fc50a5b2382a2a9c456770754629eda3e5fe8184b74ae42e550ec6ea054e"
    relevant_untracked_sha256: "9715f8a5d1031beda51edf41fbb039c02967f7ee7dc096575eb0613e2a1aae37"
    drift_vs_w0: "only docs/plans/README.md + this plan + this ledger; fully attributable, no unattributed change"
  execution_baseline:
    status_sha256: "18730741466701a7a4dd69b57fd6ed1cfa03de5ec8a714f9c2c86fb812f7f892"
    status_entry_count: 120
    relevant_untracked_sha256: "2847b5a1aa97fb42f907bd01bbfe798769125ffac9c64d87c3c3cd45d473e8f4"
authoring_validation:
  plan_sha256: "7030df60e8c9312cf0e537602b14c850fcc5c387b532ece0faa3f81d641d4cbe"
  plans_index_sha256: "4ced9518e1815c50d1085f1146232a05b15ac7dbdd324317b2157a1d07e74e62"
  docs_check: "passed: check-docs OK, 17 markdown files"
  placeholder_scan: "passed: no unresolved plan placeholders"
  trailing_whitespace_scan: "passed"
  markdown_fence_check: "passed: 16 fences"
  diff_check: "passed"
dsh_checkout:
  path: "/Volumes/project_home/github/deepseek-harness"
  revision: "47f943859bef60e4160492346772ded9b24f765a"
  branch: "master"
  status: "exactly the two pre-existing untracked files; no tracked drift"
  untracked_sha256:
    packages/core/tools/tests/xuanling-compare-measure.spec.ts: "bf7d401c40ef094b44940103c1a1a65b3fd6b0185a2633b1fce69a6712441500"
    packages/mcp/mcp-client/tests/xuanling-live.spec.ts: "b711b25aab008536ca70f9809331b0355fe891cc846f1d05350e129c23e0507f"
current_wave: "W7"
current_work_package: "W7.3-fingerprints-live-handoff"
wave_state: "complete"
clean_acceptance_count:
  A: 3
  B: 3
  C: 3
last_completed_action: "W7.3 rechecked both checkout fingerprints, the Rust catalog snapshot, the default Memory DB, the isolated Web database, HTTP 200, and the live listener after all W6/W7 gates passed."
next_action: "No execution work remains. Keep http://127.0.0.1:57960 running for user trial; any production-default change requires a separate authorized plan."
required_gates:
  - "W0 checkout and default-data fingerprints"
  - "W1 correct red contracts"
  - "W2 Skill validation and DSH discovery/load"
  - "W3 exact A/B/C catalog and fs schema projection"
  - "W4 fixture/oracle/direct probes/analyzer"
  - "W5 A/B/C three valid live trials plus cold/warm usage (accepted at codex-fs-w5-final-20260815-1725)"
  - "W6 Web file and two-turn Memory acceptance"
  - "W7 npm/docs/bridge/diff/fingerprint/live-health final gates"
changed_files:
  - "docs/plans/deepseek-harness-skills-filesystem-evaluation-development-plan.md"
  - "docs/plans/deepseek-harness-skills-filesystem-evaluation-execution-ledger.md"
  - "docs/plans/README.md"
  - "npm/test/deepseek-harness-skills.test.mjs (new, W1)"
  - "npm/test/deepseek-filesystem-evaluation.test.mjs (new, W1)"
  - "npm/test/deepseek-schema-projection.test.mjs (extended with fs16 lock, W1)"
  - "test/deepseek-harness/evaluation/fixtures/fs-workload/** (new fixture, W1)"
  - "npm/test/deepseek-harness-skills.test.mjs (adjusted in W2: whenToUse -> description trigger, per-skill agents/openai.yaml)"
  - "integrations/deepseek-harness/xuanling-skills/** (new bundle, W2)"
  - "integrations/deepseek-harness/README.md (skills section, W2)"
  - "test/deepseek-harness/scripts/verify-deepseek-bridge.mjs (fs16 exact-set + projection, W3)"
  - "test/deepseek-harness/evaluation/overlays/{common,A,B,C}/cordis.patch.yml (W3)"
  - "test/deepseek-harness/evaluation/config/settings.template.yaml (W3)"
  - "test/deepseek-harness/evaluation/scripts/inspect-catalog.ts + package.json (W3)"
  - "test/deepseek-harness/evaluation/scripts/{create-fixture,verify-filesystem-fixture,analyze-filesystem-evaluation,run-filesystem-evaluation}.mjs (W4)"
  - "test/deepseek-harness/evaluation/scripts/probe-filesystem-tools.ts (W4)"
  - "npm/test/deepseek-filesystem-evaluation.test.mjs (parser contract updates W3)"
  - "test/deepseek-harness/evaluation/scripts/verify-report.mjs (new, W6.1)"
  - "test/deepseek-harness/evaluation/filesystem-tools-report.md (new, W6.1)"
failed_commands:
  - "node test/deepseek-harness/evaluation/scripts/verify-filesystem-fixture.mjs --all /private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-20260815-1650 (exit 0 but only total=9: old verifier ignored cache shared-workspace; not sufficient for required all-trial independent oracle)"
  - "node test/deepseek-harness/evaluation/scripts/verify-report.mjs ...codex-fs-w5-final-20260815-1725 (exit 1 after W6 created web/: prior report verifier recursively admitted web/workspace as a sixteenth raw fixture; corrected with a dedicated red/green regression and exact analyzer-label scoping)"
not_run_commands: []
blockers: []
w5_final_verification:
  recorded_at: "2026-08-15T18:03:24Z"
  evidence_root: "/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725"
  xuanling_status_sha256: "afde7a15b0f568812bf01dd6be99fff8ceb3aec6abf2f8a63e69c00b237b31f2"
  xuanling_status_entry_count: 152
  relevant_diff_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  relevant_untracked_sha256: "8a1e05fdd6336a0bbe51f2222ea9b8f7f095276a18be6f47856c602e9d399e6e"
  dsh_status_sha256: "39d1f6c63477d3faf9beb23e6eda9bf80c8f231418e1f019bb1730fbe2a1bdc1"
  default_memory_db_sha256: "c828b6ed632ccd21864cc6c48b8d15a2dd969ff433b73be39f0c9fad47a4e6aa"
  default_memory_wal: "absent"
  default_memory_shm: "absent"
  runner: "15/15 complete; every session had exactly one log and a passing in-run oracle"
  strict_analyzer: "v7 --verify passed; exact frozen deepseek-official/deepseek-v4-pro/max route; cache_read_share=0.9156"
  independent_oracle: "15/15 passed, including all six retained cold/warm workspace snapshots"
  report_verifier: "passed after exact analyzer-label workspace scoping; candidate_not_applied"
  repository_tests: "npm --prefix npm test: 56/56 passed"
  docs_check: "npm --prefix npm run check:docs: 18 markdown files checked"
  diff_check: "git diff --check passed"
live_service:
  observed_port: 57960
  observed_state: "isolated candidate service running; HTTP 200; file Skill/oracle and two-turn Memory acceptance passed; browser UI kept open"
  final_service:
    url: "http://127.0.0.1:57960"
    parent_pid: 62609
    server_pid: 62615
    root: "/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725/web"
    dsh_home: "/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725/web/dsh"
    workspace: "/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725/web/workspace"
    memory_db: "/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725/web/memory.db"
    file_session_id: "session-0868a696-620c-4d9e-b62d-911b044f9a7c"
    memory_session_id: "session-096385fd-fbb4-4d26-9183-ad64c4504972"
    patches:
      - "xuanling-memory/cordis.patch.yml"
      - "xuanling-skills/cordis.patch.yml"
      - "live-test/cordis.patch.yml"
```

## Evidence log

### Plan authoring baseline（2026-08-15）

- XuanLing 和 DSH checkout 已只读调查。
- 已确认 XuanLing `fs` profile 为 16 tools、Memory 为 9 tools、full snapshot 为 42 tools。
- 已确认 DSH Skill provider 的 `customSkillDirs` 和 global/scoped catalog 合并语义。
- 已确认 DSH 原生文件工具的观察/sandbox/UI 责任及 token/session evidence 字段。
- 已确认当前 3080 为 Memory-only 隔离服务；未停止或修改。
- 未创建 Skill、修改 adapter、创建 A/B/C overlay、fixture/runner、模型 session 或评估结论。

### Plan authoring validation（2026-08-15T07:46:20Z）

- `npm --prefix npm run check:docs`：通过，17 个 Markdown 文件。
- placeholder scan：通过，无未替换计划占位符。
- trailing-whitespace scan：通过。
- Markdown fence parity：通过，共 16 个围栏。
- `git diff --check`：通过。
- 这些结果只证明计划文档可交付；W0-W7 仍全部未开始。

### Wave 0 execution baseline（2026-08-15T07:53:32Z）

- XuanLing checkout：revision `47f1cff156896cd3006258b6e4519a4bb2bc3f6a`（main，未变）。
  - 全量 status（120 条）SHA-256 `18730741466701a7a4dd69b57fd6ed1cfa03de5ec8a714f9c2c86fb812f7f892`；相对 authoring baseline `7741fc50…` 的唯一漂移是 `docs/plans/README.md`、本计划、本账本三个文件，可完全归因。
  - 任务相关 tracked diff（`git diff -- docs/plans integrations npm/test`）仍为空串哈希 `e3b0c442…`。
  - 任务相关 untracked 清单（`git ls-files --others --exclude-standard -- docs/plans integrations`）SHA-256 `2847b5a1aa97fb42f907bd01bbfe798769125ffac9c64d87c3c3cd45d473e8f4`；完整清单以本指纹命令可随时重放。
- Canonical snapshot：`tools-list.json` fs=16、memory=9、all=42；文件 SHA-256 `1ee881e3a5644cae1249b1fdeccfcfe78a8c5762510eb33c5455f3cb38c6d020`（207129 bytes）。这是 W3/W7 的 Rust 无漂移基线。
- DSH checkout：revision `47f943859bef60e4160492346772ded9b24f765a`（master，未变）；status 恰好两个既有 untracked 文件，hashes：`xuanling-compare-measure.spec.ts` = `bf7d401c40ef094b44940103c1a1a65b3fd6b0185a2633b1fce69a6712441500`，`xuanling-live.spec.ts` = `b711b25aab008536ca70f9809331b0355fe891cc846f1d05350e129c23e0507f`。
- 默认 Memory DB（只记录，未创建/未写）：`~/.xuanling/memory.db` SHA-256 `810cb27d9fd2fc8d1b4c868c3fcd63c1371e74d58c7244c74f50deab3ff1a716`（155648 B），`-wal` 230752 B，`-shm` 32768 B。该 DB 与宿主 xuanling 插件共享，宿主活动导致 WAL/SHM 漂移属预期；只要评估自动化永不指向它即不构成 incident。
- DSH settings 安全字段（未读取任何 secret 值）：`provider=deepseek-official`、`model=deepseek-v4-pro`、`reasoningEffort=max`、`permission.defaultPreset=danger-full-access`（禁止用于 benchmark；W3 必须 pin `workspace-write`）。
- 3080 listener 身份：node PID 65817（parent 65799）`node --import tsx/esm apps/cli/src/bin.ts web --patch …/xuanling-memory/cordis.patch.yml --patch …/live-test/cordis.patch.yml` → child node 65840 `schema-adapter.mjs --binary …/target/debug/xuanling-mcp -- --workspace-root /private/tmp/xuanling-dsh-live.VQcF3e/workspace --tool-profile memory --memory-db /private/tmp/xuanling-dsh-live.VQcF3e/memory.db` → `xuanling-mcp` PID 65841。Memory-only 隔离服务，未触碰。
- W0 三条 required 命令全部执行并记录；本 Wave 唯一写入是本账本。W0 Exit gate 满足：dirty/untracked/重叠 diff/DSH hashes、default DB 主+WAL+SHM、settings 安全字段、listener identity 均落账，next_action 唯一指向 W1.1。

### Wave 1 execution（2026-08-15T08:09:31Z）——正确红测试与冻结 fixture

- DSH 侧补充事实（只读调查，支撑 W1 合同）：skill provider 行形状来自 `apps/cli/config/agent-presets/cordis/agent.cordis.yml`（`skill-filesystem` 行 + `customSkillDirs`）；`providerName` 必须全局唯一（web preset 已注册 `filesystem`）；`vendor/include/src/index.ts:204` 证明 root include 的 `baseUrl` 锚定 profile 目录，bundle/`--patch` 层共享该锚——因此 skills 目录解析必须走 `XUANLING_DSH_SKILLS_ROOT ?? createRequire(baseUrl).resolve('xuanling-dsh-skills/package.json')` 自解析模式（与 xuanling-memory 的 adapter 解析同构）。shell 行 id 确认为 `tool-bash`/`tool-pwsh`。
- **重要事实修正（计划 §W1 红表）**：`projectInputSchemaForDsh` 对 16 个 fs schema 的实测结果是 **全部可投影**（`ALL_PROJECT`）。计划预期的 "unsupported/uncovered per tool" 红因不存在；`UNVERIFIED_RISK`（fs schema 单元级投影）就此在单元层面解决，剩余风险只在真实模型/PTC 层（W5 验证）。因此 C-05 的正确红改为：verifier fs16 扩展缺失 + A/B/C overlay 缺失；fs16 投影测试作为回归锁立即绿。
- 新增 `npm/test/deepseek-harness-skills.test.mjs`（6 测试）：**6/6 正确红**，红因全部是 "skills bundle file missing: … (W2 creates the xuanling-skills bundle)"，无 parser/fixture 崩溃。
- 扩展 `npm/test/deepseek-schema-projection.test.mjs`（+1 fs16 锁定测试）：Memory 旧测 3 项保持绿，fs16 锁绿（见上）。fs_read_bytes 的 `output` 投影为 oneOf 双 const-tagged object 分支（`bounded`/`complete`），`max_bytes` 的 uint64/minimum=0 约束进入 description——已按实际形状断言。
- 新增 `npm/test/deepseek-filesystem-evaluation.test.mjs`（11 测试）：**8 正确红**（common/A/B/C overlay、live runner、analyzer、inspect-catalog/probe/batch-runner、verifier `EXACT_FS_PROFILE_TOOLS` 扩展，红因全部是 "… missing: <path>"）+ 3 绿基础设施（fixture hash-pin、oracle raw-red/solved-green、snapshot fs16）。一个 wrong failure（`createHash` 误从 `node:fs` 导入的 SyntaxError）在定稿前修复，不计证据。
- 冻结 fixture `evaluation/fixtures/fs-workload/`：`task.md`（冻结 prompt，要求搜索/读取/精改/建文件/核对五类操作且禁 shell）、`files/` 5 文件初始树、`manifest.json`（5 文件 sha256 + task hash + untouched 两个只读文件 + allowed_new=RELEASE.md）、`oracle.mjs`（独立判定器：workspace 精确文件集、untouched 哈希、config 语义、精确短语替换+连字符近形词保护、RELEASE.md 结构与 Notes count 联动、protocol 校验翻转）、`solved.patch`（标准解）。实测：raw→exit 1 且 8 项失败；solved→exit 0 pass。
- 既有 `deepseek-harness-bundle.test.mjs` 8/8 绿（未受影响）。三条 W1 required 命令全部按计划执行并得到上述分布；无网络、无默认 DB、无模型调用。
- W1 Exit gate 满足：每合同有正确红（C-01..C-03 skills 红；C-04 overlay 红；C-05 verifier-fs16 红+fs16 锁；C-06 runner/oracle；C-07 analyzer 红；C-08 probe 红）；Memory 旧测绿；next_action=W2.1。

### Wave 2 execution（2026-08-15T08:2xZ）——两个 DSH 专用 Skill

- Entry gate：`/Users/ikaros/.codex/skills/.system/skill-creator/SKILL.md`（22KB 全文）与 `references/openai_yaml.md` 已完整读取；`scripts/init_skill.py`、`quick_validate.py` 存在。
- **验证器事实**：`quick_validate.py` frontmatter 白名单 = `{name, description, license, allowed-tools, metadata}`，**不含 `whenToUse`**；系统 python3 无 PyYAML——用一次性 `/private/tmp/xlw1-venv`（venv + pip install pyyaml）运行验证，不污染用户环境。据此把 W1 测试的 whenToUse 断言改为 description 触发断言（W2 Allowed files 授权），触发信息按 Codex 惯例全部写进 description。
- W2.1：`init_skill.py xuanling-file-workflow --path …/xuanling-skills/skills --interface ×3` 与同法 `xuanling-memory-workflow`，各生成 SKILL.md + agents/openai.yaml（default_prompt 含 `$<name>`）。
- W2.2 `xuanling-file-workflow`（SKILL.md sha256 `dd0864ef…`，3160 字符正文）：family 路由（常规小编辑优先原生；sha256/CAS、byte budget/续读、fs_patch/ChangeSet、完整分页选 XuanLing）、schema gotchas、禁止 shell、禁止静默换族、typed error 处理。
- W2.3 `xuanling-memory-workflow`（sha256 `d5e3077b…`）：search/get 先行、candidate pending + proposal id/revision 回报、终态 awaiting review、显式用户决策才 `memory_review`、永不自称人工评审、失败跳过写入、同 idempotency key + 同 payload 重试、scope tagged object 参考。修正两处：description 内 `: ` 破坏 YAML（改破折号）、"never describe yourself" 措辞对齐合同正则。
- W2.4 bundle：`package.json`（name `xuanling-dsh-skills`、version 0.2.1、deps `@deepseek-ai/dsh-skill-filesystem ^0.1.0-rc.5`、files 精确 6 项、dsh.bundle.patch）+ `cordis.patch.yml`（sha256 `1224fb0a…`；唯一 insert 行 id `xuanling-skills`，providerName `xuanling-dsh-skills`、includeDefaultRoots false、watch false、customSkillDirs 走 `XUANLING_DSH_SKILLS_ROOT ?? createRequire(baseUrl).resolve('xuanling-dsh-skills/package.json')` 自解析）。
- 验证：quick_validate ×2 = "Skill is valid!"；`node --test deepseek-harness-skills.test.mjs` 6/6 绿；`deepseek-harness-bundle.test.mjs` 8/8 保持绿；**discovery/load 实证**——/tmp 一次性 tsx 探针（DSSH checkout + TSX_TSCONFIG_PATH）挂真实 provider：`catalog: ["xuanling-file-workflow","xuanling-memory-workflow"]`，两个 body 均可 `ctx.skills.get` 加载且含路由/评审门标记，exit 0；`pnpm dsh --profile headless --patch …/xuanling-skills/cordis.patch.yml --dump-config` exit 0，输出含独立 `# == …/xuanling-skills/cordis.patch.yml` 层与完整 provider 行；`npm pack --dry-run` 恰好 6 个声明文件（4.2kB tarball，无多余产物）。
- W2 Exit gate 满足：validation/static/discover/load 全绿、正文 <500 行、per-skill openai.yaml 与触发一致、全部普通测试无模型无网络、next_action=W3.1。

### Wave 3 execution（2026-08-15）——fs16 verifier 扩展与 A/B/C 隔离组合

- W3.1：`verify-deepseek-bridge.mjs` 新增 `EXACT_FS_PROFILE_TOOLS`（16 工具精确集合）与 fs-profile 投影检查（含 output 选择器 bounded/complete tagged 变体校验）。一次 wrong failure（`find()` 只取首个 mode 分支漏判 complete）修复后：**fs profile 9/9 PASS，memory profile 回归 9/9 PASS**。schema-adapter/schema-projection 无需改动（W1 已证 fs16 全可投影）。
- W3.2-W3.5 overlays：`common`（disable `tool-bash`/`tool-pwsh` + `session-persistence-jsonl` config 覆盖 `compression: 'none'`、`packChunks: false`）；`A` = `[]`（原生不动、无 bridge）；`B` = disable 三原生 fs 行 + fail-closed bridge insert（`--tool-profile fs`、每个 `!!js` 参数缺 env 即 `node:assert').fail(`、`failOnStartupError: true`、无 `--memory-db`）；`C` = 仅 bridge insert。
- W3.6：`evaluation/config/settings.template.yaml`（provider/model/effort/permission=workspace-write，无 secret；API key 走 `DEEPSEEK_API_KEY` env 由 runner 透传）；session 隔离经每 trial 独立 `DSH_HOME`（root=dshHomePath('sessions')）。
- `inspect-catalog.ts`（DSH tsx 运行，yaml 经 dshRoot createRequire 解析；evaluation/scripts/package.json 提供 ESM 上下文）：**17/17 pass**——A 无 bridge 且原生 fs 全启用；B 原生 fs 全禁用、活体 `tools/list` 恰好 fs16、`memory_search` 隐藏 dispatch 被服务端拒绝（unknown tool）；C 两族并存；三 arm shell 全禁用、skills provider 隔离挂载、bridge 参数 fail-closed。注：直接经 adapter 探测的目录名为服务端原名（`mcp__xuanling__` 前缀由 DSH bridge 添加，由 verifier 名形检查与 W5/W6 真实会话证明）。
- 测试分布：`deepseek-filesystem-evaluation.test.mjs` overlay/verifier 断言转绿（parser 扩展顶层 config 覆盖行）；`deepseek-harness-bundle.test.mjs` 8/8、`deepseek-schema-projection.test.mjs` 4/4 保持绿；canonical snapshot sha256 `1ee881e3…` 复核不变（Rust 无漂移）。
- W3 Exit gate 满足：fs16/Memory9 绿 + snapshot 不变；A/B/C discovery+dispatch exact（组合 dump + 活体 wire + 隐藏 dispatch 负向）；shell 关、workspace-write（模板+runner env）；fail-closed 负向绿；next_action=W4.1。

### Wave 4 execution（2026-08-15）——fixture/oracle/探针/analyzer/runner

- W4.1 `create-fixture.mjs`：源树 manifest 哈希校验 → 复制 → 复制后逐文件复核；实测两次生成 `diff -r` 完全一致；`verify-filesystem-fixture.mjs --workspace`（单工作区）与 `--all <root>`（递归所有 `workspace/` 目录）批处理 oracle——raw fixture exit 1（8 项失败复现）。
- W4.4 `analyze-filesystem-evaluation.mjs`：解析 raw JSONL（common overlay 已固定无压缩），deep-collect token-meter 四字段（缺失=partial→`"unknown"`，不补零）；`--verify` 对 incomplete/route 违规 exit 1；cache_read_share 仅在完整 usage 上计算。合成日志测试（W1 合同）绿：`usage === "unknown"`。
- W4.5 `run-filesystem-evaluation.mjs`：门序为 (1) 无 `--allow-billable-live` 且非 dry-run → 启动前拒绝（实测 <40ms、消息含 flag 名）；(2) `--dry-run` 输出 redacted 计划（frozen route、fixture/task hash、逐 arm argv 与 env **名**、各 patch sha256），不 spawn dsh（problems=[]）；(3) live 前置：`XUANLING_DSH_RUN_ID` 安全格式 + 目标根不存在 + `DEEPSEEK_API_KEY` 存在，否则拒。live 路径按 `quality/<arm>/trial-N` 与 `cache/<arm>/pair-N/{cold,warm}`（共享同一 workspace 路径，会话间重物化 fixture）执行；每 trial 独立 `DSH_HOME`、TERM→grace→KILL 进程组超时、oracle verdict.json、session.jsonl 拷贝、meta.json（redacted argv + 各组件 sha256）。一个 wrong failure（dry-run 被 billable 门拦截）已修——dry-run 是安全检查模式。
- W4.3 `probe-filesystem-tools.ts`：**XuanLing 电池 7/7 observed**（duplicate-match conflict 且零写入、stale `expected_sha256` conflict、fs_patch preimage conflict、search over-cap cursor 续读、bounded read `next_resume` 续读、invalid UTF-8 typed + bytes 成功、outside workspace `outside_capability`）。**Native 电池 3 项 harness_error**：cordis Context + fs-local + fs-observation-policy + tool-fs 组装成功、工具可执行，但 `ctx.tools.execute` 以 "tool execution arguments must be losslessly JSON-serializable" 拒绝本 harness 的调用（调用约定/owner 上下文待查，非 DSH 源码修改问题）——按计划单独分类，不计为工具失败也不伪造通过；native 守卫证据改由 W5 A/C 真实 transcript 或下一轮 harness 约定调查补齐。探针中途两个 wrong failure（`resume`→`next_resume` 字段名、mcpSession 共享 iterable 竞态改单分发器）修复后达最终结果。
- 最终回归：`npm --prefix npm test` **45/45 全绿**；`git diff --check` clean；snapshot `1ee881e3…` 不变；DSH checkout 仍恰好 2 个 untracked（无漂移）；默认 DB 主文件哈希变化（`810cb27d…`→`0c75e35b…`）为宿主 xuanling 插件共享活动所致（本会话 MCP 服务在用），评估自动化从未指向它。
- W4 Exit gate（review 修复轮后重建）：fixture 两次一致；raw 红/solved 绿；探针 XuanLing 7/7 + native Guard-1 `FS_NOT_OBSERVED` 真实 observed、Guard-2/3 精确归因 harness_error（exit 1 如实，不伪造）；analyzer fail-closed（--verify 覆盖损坏行/oracle/usage/trial 数/配对）；runner 采集完整性非零退出；普通测试无模型无网络。

### Wave 4 review-fix round（外部 review 后，8 项 7×P1+1×P2）

- 事实更正前先把账本退回 `implemented_unverified`（gate 失败协议），修复后回升 `deterministic_green`。
- P1-1：runner 改为 `<dshRoot>/node_modules/.bin/tsx <dshRoot>/apps/cli/src/bin.ts …`（cwd=trial.workspace；fixture 无 package.json，`pnpm dsh` 必然 ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND）。
- P1-2：超时改为 TERM 到点后再启动 10s grace KILL timer；close/error 时清两个 timer。原实现等于每个 trial 10 秒必被 SIGKILL。
- P1-6：spawn error / signal / 非零退出 / 0 或 >1 个 session / header cwd 不匹配 / header 不可解析 → `incomplete`，runner exit 1；oracle 失败保持"有效模型失败"不阻断退出码；全部 session log 拷贝 + `sessionHeader` 校验身份。
- P1-3：analyzer `complete` 收紧为 `turn/end`/`session.end`（step/end 不再算完整）；usage 合同改为 DSH canonical `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`（`uncachedInputTokens` 是错名）；`--verify` 现在覆盖：损坏行、无 turn/end、route 违规、oracle 缺失/失败、usage unknown、quality trial 缺失（--arms/--quality-runs）、cold/warm 配对缺失、零日志。
- P1-4：native probe 改用 `ToolExecutionInput {callId,name,arguments,signal}` + `file_path/old_string/new_string`——**Guard-1 `FS_NOT_OBSERVED` 从 harness_error 变为真实 observed**（"edit requires reading …"）。Guard-2/3 的正向路径经源码核实按 `input.agent.session` + agent 属性键控，裸 harness 不可达（DSH 文档明示设计意图），保留为精确归因的 harness_error，证据面移交 W5 A/C transcripts；probe exit 含 harness_error 即非零（不再假绿）。
- P1-5：common overlay 新增 12 个禁用行（tool-jobs、tool-subagent-control/list-agents/subagent/subagent-fork/report、workflow-worker-thread、tool-workflow、tool-ralph、code-runtime，加原 bash/pwsh）；subagent registry 三行保留（无模型面入口，禁用可能破坏 sibling inject）。inspect-catalog 新增 bypass 检查——**dump 实证含嵌套行 code-runtime 在内全部 disable 生效，20/20 pass**；evaluation test 断言同步。
- P1-7：DB 漂移（现已第三次：`810cb27d→0c75e35b→29908431→d05e27a4`）从"预期"更正为 C-10 incident 记入 blockers；W5 前后各一次哈希快照为解除窗口。
- P2-8：SKILL.md 撤回 `change_commit/change_rollback` 承诺（advanced profile，不在 fs16）；README 同步并标注真实模型段落为 Memory-era 历史证据。
- 附加：probe/inspect 的 MCP 会话改为 detached + 进程组 TERM→300ms→KILL（adapter 不再泄漏 xuanling-mcp 子进程）。
- 重建验证：npm test **45/45**；探针 **8 observed / 0 mismatch / 2 attributed harness_error（exit 1）**；inspect-catalog **20/20**（含 bypass；此计数有误，次轮复核为 21 项）；dry-run problems=[]；`git diff --check` clean；check:docs OK；DSH checkout 仍恰好 2 untracked；snapshot 未动。

### Wave 4 second review-fix round（第二轮 review，6 项 + 证据过期）

- 账本先行退回 `implemented_unverified`；修复后回升 `deterministic_green`。stale 证据更正：inspect 实为 **21 项**、probe 上一轮以 exit 1 结束、默认 DB 哈希为 `edaf39ba…`（incident 链第 4 跳后保持）。
- **analyzer v3**：usage 改为逐事件容器提取——每事件定位 usage 容器（≥2 个 usage 键的对象），恰一个则取、多于一个记 `usage_ambiguous_events` 并判 `unknown`（重复投影不再可能假绿累加）；complete 收紧为 canonical `turn/end` 且**最后一个 turn 级事件必须是 turn/end**（`session.end` 非 canonical，已移除；turn/end 后再 turn/start 判不完整）；route 校验改为封闭 deny 名单（`run_code/terminal/jobs/subagent*/workflow/ralph/…`）+ 非 fs 的 `mcp__xuanling__*` + 观测到的 `model`/`reasoningEffort` 与冻结 route 比对 + session header `cwd` 缺失即违规。reviewer 复现场景（重复 usage、step/end-only、损坏行、oracle pass:false）实测 `--verify` 全部列出并 exit 1。
- **runner**：child env 改为显式 allowlist（PATH/HOME/TMPDIR/LANG/LC_ALL/TERM + 评估变量 + DEEPSEEK_API_KEY），父进程其余环境与无关 credential 不再进入 DSH；session header `cwd` 缺失/为空 → incomplete（fail-closed）；dry-run 的 argv 改为与 live 完全一致的 tsx 形态（启动 oracle 不再漂移）。
- **probe 补齐 C-08 全路径**：新增 glob 超量分页（40 文件 limit 15 → has_more+cursor 续读）与 teardown 残留检查（pgrep 探针进程 + temp root 删除）；native Guard-2/3 改由 **DSH 自身 fs spec 套件当场运行驱动**（tool-fs tools+integration+observation-policy，`pnpm exec vitest run`，NO_COLOR/CI 纯文本解析，要求 3 套件全过）——假 agent 形状两轮未收敛（sandbox 读 agent 属性），按设计不可达的直连路径不再猜测。最终 **11/11 observed、exit 0**：xuanling 8（duplicate/CAS/patch/search/glob/bounded/UTF-8/越界/残留）+ native 3（Guard-1 活体 `FS_NOT_OBSERVED` + Guard-2/3 by DSH 129 tests）。
- README `str_replace_editor` 行标注 `change_commit/change_rollback` 属 full/advanced profile。
- 最终回归：npm test **45/45**；inspect-catalog **21/21**；dry-run problems=[] 且 argv 为真实 tsx 路径；`git diff --check` clean；check:docs OK（18 文件）；DSH checkout 恰好 2 untracked；DB `edaf39ba…` 保持 incident。
- W4 Exit gate（两轮 review 后）：探针覆盖计划要求的全部适用路径且无 mismatch/harness_error；analyzer/runner fail-closed；W5 仅由 C-10 DB-incident 窗口 gate。

### Wave 4 third review-fix round（第三轮独立复核）

- 复核先把新证据视为 stale，并建立 4 组正确红：raw hidden dispatch 名称、partial/conflicting usage、unexpected trial/cold-warm prefix、invalid runner counts。旧实现分别 false-green，红因无 fixture 或工具故障。
- **C-04 dispatch 更正**：`inspect-catalog.ts` 直连 adapter/server 时改用 raw `memory_search`；旧的 `mcp__xuanling__memory_search` 会在任何 profile 下因错误前缀失败，不能证明 fs dispatch 隔离。活体返回 canonical `unknown tool: memory_search`，B/C 两臂均通过，catalog 仍为 **21/21**。
- **analyzer v6**：usage 语义从“至少一个样本”收紧为“每个 completed step 恰有一份一致的 canonical sample”；同 step 的 chunk/message 可重复但必须归一后相等，partial/conflict/orphan 均为 `unknown`。`--verify` 要求 exact trial 集合，并用首个 request header、初始 user message 与 cwd 的 SHA-256 验证每个 cold/warm pair 的请求前缀相同。
- **runner 与 secret 边界**：runner 拒绝 NaN、负数、重复/空 arm 和零工作量；dry-run 同时检查真实 DSH tsx/bin 入口。inspect/probe 的 DSH、adapter、MCP 与 vitest 子进程使用 PATH/HOME/TMPDIR/LANG/LC_ALL/TERM 白名单，不再继承父进程中的无关 credential。
- **默认 DB incident 根因关闭**：Rust `fs` profile 仍会打开 `MemoryStore`；旧 inspect/probe/B/C 没有全部传 `--memory-db`。所有自动化入口现均显式使用 evidence-local/temp DB。定向、catalog、bridge、probe、全量 npm 和 dry-run 前后默认 DB 均保持 `c828b6ed632ccd21864cc6c48b8d15a2dd969ff433b73be39f0c9fad47a4e6aa`，且无 WAL/SHM；旧“未知宿主写入”归因撤销。
- 重建验证：targeted **18/18**；npm **52/52**；bridge **9/9**；probe **12/12 observed**；inspect **21/21**；check-docs **18 files**；`git diff --check` clean；dry-run `problems=[]`；DSH checkout 仍恰好两个 pinned untracked。W4 Exit gate 满足并标记 `complete`。

### Wave 4 fourth review-fix round（真实模型 smoke 暴露的 route/config false-green）

- 失败证据根保留且不得复用/删除：`/private/tmp/xuanling-dsh-fs-eval.codex-fs-20260815-162436`、`/private/tmp/xuanling-dsh-fs-eval.codex-fs-smoke-20260815-162754`、`/private/tmp/xuanling-dsh-fs-eval.codex-fs-smoke2-20260815-162934`、`/private/tmp/xuanling-dsh-fs-eval.codex-fs-smoke3-20260815-163119`。
- 可完整采集但被 analyzer 正确拒绝的根：`/private/tmp/xuanling-dsh-fs-eval.codex-fs-smoke4-20260815-163337`。runner exit 0、session=1、oracle PASS；canonical route 实为 `deepseek-v4-flash/high`，不是冻结的 `deepseek-v4-pro/max`；调用 17 次 native fs、2 次 `todo_write`、0 次 `skill`；usage 为 input 7404、output 4735、cacheRead 55168、cacheWrite 0；默认 DB 未变化。
- `CONFIRMED`：`settings.template.yaml` 把 route 写成未注册的顶层键；DSH 当前 checkout 由 `agent-default-model` settings namespace 拥有默认路由，旧模板被静默忽略。runner/oracle 成功因此只能证明任务完成，不能证明冻结模型合同。
- `CONFIRMED`：analyzer 把 `todo_write` 与 shell/process/delegation bypass 放进同一 deny 集合。DSH 将其投影为 `todo/write` 的日志化计划状态；它应单独计量为 control call，不应使文件工具路由无效。`goal_write` 等可改变评估控制面的入口继续拒绝。
- 正确红：`node --test --test-name-pattern='folds canonical usage|evaluation launchers isolate' npm/test/deepseek-filesystem-evaluation.test.mjs` = **0/2**；失败分别命中上述两个生产合同，无 fixture/tool 故障。
- 账本先行退回 `W4 / W4.4-W4.5-review-fix / implemented_unverified`。修复后必须重建定向、全量 npm、catalog、bridge、probe、docs、diff、dry-run 与 fresh A live smoke，旧 smoke 不得作为绿色证据复用。
- 修复：route 改入 `agent-default-model` namespace；`todo_write` 改为独立 `tool_calls.control`（trial 与 arm aggregate），不参与 route bypass；`goal_write`、shell、process、delegation、workflow 与未知工具继续 fail-closed。
- 确定性重建：`npm --prefix npm test` **53/53**；fs/memory bridge 各 **9/9**；inspect-catalog **21/21**；probe **12/12 observed**；check-docs **18 files**；`git diff --check` clean；dry-run `problems=[]`；默认 DB 仍为 `c828b6ed…` 且无 WAL/SHM；DSH checkout 仍只有两个 pinned untracked。
- fresh live 根：`/private/tmp/xuanling-dsh-fs-eval.codex-fs-pro-smoke-20260815-1649`。runner exit 0、session=1、oracle PASS、analyzer v6 `--verify` exit 0、独立 batch oracle 1/1。canonical route=`deepseek-official/deepseek-v4-pro/max`；native fs=16、skill=1、control=2、shell/denied/other=0；usage input=8199、output=4779、cacheRead=67456、cacheWrite=0，cache read share=0.8916。
- secret gate：`meta.json` 的 `secret_redactions=0`；第一次全根扫描因跟随递归 symlink 命中 `ENAMETOOLONG`（wrong verification command），改用 `lstat` 跳过 521 个 symlink 后扫描 19 个 regular files，provider credential occurrence=0。
- W4 Exit gate 满足并重新标记 `complete`；W5 仅可使用新的证据根，不得复用 smoke 根。

### Wave 5 initial execution（15-trial live matrix；prefix gate 正确阻断）

- 新根：`/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-20260815-1650`，A/B/C 各 quality=3、cache cold/warm=1，总计 15 个独立 DSH_HOME 与 session。
- runner：15/15 exit 0、unique session、0 incomplete、15/15 oracle PASS。独立 `verify-filesystem-fixture.mjs --all` 复验 9 个 quality workspace，9/9 PASS。
- analyzer v6：所有 trial 解析完整、usage known、route valid；A native fs=67/XuanLing=0/skill=5，B XuanLing fs=97/native=0/skill=5，C native=76/XuanLing=6/skill=5；shell/denied/other=0；全局 cache read share=0.9091。
- 但 `--verify` 正确 exit 1：A/B/C 三组 cold/warm prefix mismatch。取证显示每组 `request/header` SHA-256 完全相等；仅 `user/message[].id`（36-char 随机 MessageId）不同。DSH `packages/llm/llm/src/message.ts` 把 id 定义为稳定持久化 identity，`packages/llm/llm-deepseek/src/serialize.ts` 的 provider wire 仅序列化 role/content，忽略 id/source。因此当前 analyzer 将 persistence metadata 错作 provider prefix，不能用该红色建立 cache 结论。
- 账本退回 `W5 / W5.2-prefix-fingerprint-fix / implemented_unverified`。不删除或重跑原始 billable evidence；先修离线 projection，再用同一不可变 raw root 重算真实 provider-facing prefix。

### Wave 5 second review-fix round（cache temporal-state oracle coverage）

- analyzer v7：初始 `user/message` 由 durable id/source/full record 改投影为 DeepSeek wire 的 `role + flattened text`；不支持的初始 block 仍令 fingerprint 为 unknown。红测证明仅不同 generated id 的 cold/warm 应通过，model-facing content 改变仍拒绝。旧 root v7 reanalysis `--verify` 通过，三组 cold/warm prefix 均稳定。
- `CONFIRMED`：batch oracle 的注释和扫描规则只认 `workspace/`，而 runner 为同 cwd cache pair 使用 `cache/<arm>/pair-<n>/<cold|warm>/shared-workspace`。旧 `--all` 输出 9/9，只覆盖 quality，违反计划的“independently rerun all”。
- 正确红：batch verifier fixture 含 1 quality + 2 cache `workspace-snapshot`，旧实现 total=1（预期 3）；synthetic runner cache pair 不保留 snapshot。两个失败均命中生产 artifact 合同。
- 修复：runner 在每个 cache-cold/cache-warm DSH session 结束后、下一次共享 cwd 重物化前复制 `workspace-snapshot`，copy 失败使采集 incomplete；`meta.json`/`run-summary.json` 记录 snapshot。batch verifier 识别 `workspace` 和 `workspace-snapshot`，对 cache snapshot 标签保留 cold/warm identity。定向红测 3/3 转绿。
- 旧 `codex-fs-w5-20260815-1650` 没有时间点快照，不能通过新 required oracle。根据计划“修改后计数归零重跑”，W5 必须以新根完整重跑 15 trial；旧根保留为发现证据，不作为最终绿色凭据。

### Wave 5 final live acceptance and Wave 6.1 report（2026-08-15T18:03:24Z）

- 新 W5 根：`/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725`。runner 对 A/B/C 各执行 quality=3 与 cache-pairs=1，共 15 个独立 session，15/15 complete、15/15 in-run oracle pass、无 collection problem。
- 当前轮独立重跑 `analyze-filesystem-evaluation.mjs --verify --arms A,B,C --quality-runs 3 --cache-pairs 1`：通过。每个 trial 路由均为 `deepseek-official/deepseek-v4-pro/max`；A/B/C 聚合均为 complete=5、oracle=5、route=5、usage=5。文件调用分别为 A native=84/XuanLing=0，B native=0/XuanLing=101，C native=76/XuanLing=1；全局 `cache_read_share=0.9156`。
- 当前轮独立重跑 `verify-filesystem-fixture.mjs --all <root>`：15/15 passed，其中九个 quality workspace 和六个 immutable cold/warm snapshot 均被重新判定。
- W6.1 先补齐计划已声明但缺失的 `verify-report.mjs`。红测正确失败于 verifier 缺失；绿色测试证明缺 v1 manifest 时 verifier fail-closed。`filesystem-tools-report.md` 的机器证据块由 verifier 重新执行 analyzer、batch oracle、runner metadata 和 route/usage/tool-call 对账，结果为 `verified=true`、`decision_status=candidate_not_applied`。该 verifier 对 profile 枚举和 evidence reference 做完整性校验，不把任何固定赢家写入代码。
- 候选建议只来自本根：保留 DSH native fs + `xuanling-memory`，将 XuanLing fs16 作为需要 CAS/严格 patch/byte continuation/完整分页的 opt-in profile；C 不设为默认，因为本 workload 中 77 次文件调用仅 1 次使用 XuanLing。该建议尚未应用，且 W6 Web 仍是 required gate。
- Secret scan：313 个普通文件、跳过 7,815 个 symlink、0 provider credential occurrence；15 个 `meta.json` 的 `secret_redactions=0`。默认 `~/.xuanling/memory.db` 仍为 `c828b6ed...a4e6aa`，无 WAL/SHM；DSH 仍恰好两个 pinned untracked。
- W6 Allowed files 补入 report verifier 与其唯一 fail-closed 测试，因为原计划的 W6 验证命令已引用该脚本但 Allowed files 没有包含它。修正不改变 Rust、DSH checkout、默认 bundle、fixture、prompt、route、permission 或 raw W5 evidence。

### Wave 6.2 isolated Web startup（2026-08-15T18:12:29Z）

- `web/` 子树创建在 W5 final evidence root 下：独立 `DSH_HOME`、`settings.yaml`、fixture workspace、`memory.db` 和日志均落在 `/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725/web/`。`create-fixture.mjs` 复核了 5 个源文件与冻结 task hash 后物化 workspace。
- 无模型的 `--dump-config` 检查通过：`xuanling-tools`、`xuanling-skills`、`tool-fs`、`tool-fs-search`、`tool-str-replace-editor`、session persistence 和 `--memory-db` 均在组合树中。第一次启动将 `--host/--port` 放在 `--patch` 前，CLI 正确拒绝 `--patch` 为 Web 应用未知参数；修正为所有 launcher patch 在应用参数前后，未改变任何配置文件。
- Web 使用 port `0` 取得 `http://127.0.0.1:57960`。父 PID 62609、HTTP server PID 62615；`curl` 返回 HTTP 200，Browser 显示“新会话”与工作区选择界面。临时 DB 主/WAL/SHM SHA-256 分别为 `f1c1d714...fdfebdcf`、`993b26ea...88dff3d5`、`3ed12835...f9c47297`；默认 DB 仍为 `c828b6ed...a4e6aa` 且无 WAL/SHM。
- Browser UI 随后显示“添加一个 API Key 开始使用”。当前 terminal 的 `DEEPSEEK_API_KEY` 未设置。没有读取、复制或输出任何用户 credential，也没有发送模型消息，因此 W6.3/W6.4 保持 not-run。

### Wave 6.1 report verifier scope repair（2026-08-15T18:15:27Z）

- W6 依计划把 `web/` 建在 W5 final root 下后，report verifier 的旧实现向 batch oracle 传递整个 root。batch oracle 因而扫描到尚未修改的 `web/workspace`，报告 `total=16, passed=15, failed=1`。该 false-red 证明 report verifier 的人口边界错误；W5 的 `quality/`、`cache/` raw session、snapshot 和 report manifest 均未被改写。
- 先新增 `the report verifier scopes the W5 oracle to analyzer trials, not later Web workspaces` 红测，旧实现正确失败。verifier 随后改为由 strict analyzer 的 15 个已验证 label 派生 workspace：quality 读取同 trial 的 `workspace`，cache 读取同 trial 的 `workspace-snapshot`，并检查路径仍位于 evidence root 且不重复。它不再递归寻找任意同名目录。
- 定向 2/2 测试、`node --check` 与实根 report verifier 均通过；实根仍输出 `verified=true`、`trials=15`、`cache_read_share=0.9156`、`candidate_not_applied`。这次修改只影响 W6.1 report gate，不影响 W5 live 数据或 Web 服务。
- 最终无模型回归：`npm --prefix npm test` 56/56、`npm --prefix npm run check:docs` 18 个 Markdown、`git diff --check`、report verifier 和 Web HTTP 200 全部通过。DSH checkout 仍是两个 pinned untracked，默认 DB 仍为 `c828b6ed...a4e6aa` 且无 WAL/SHM。

### Wave 6.3 file Skill and UI acceptance（2026-08-16T00:42:06Z）

- 配置完成后 Browser 回到可发送状态，但 DSH workspace registry 仍只含
  `/Volumes/project_home/github/xuanling`。在任何模型请求前，经 Host
  `workspace.create` API 注册隔离 fixture 路径并从 UI 选择；新 blank session 的
  `session.list.cwd` 精确等于 `web/workspace`。这避免了 Native 文件工具写入仓库根目录，
  XuanLing MCP capability root 也保持同一隔离路径。
- 文件 session：`session-0868a696-620c-4d9e-b62d-911b044f9a7c`，route 为
  `deepseek-official/deepseek-v4-pro/max`、`workspace-write`。模型首先调用 Skill
  `xuanling-file-workflow`，明确按 Skill 选择 Native 文件族。原始 JSONL 中的文件调用为
  `read` 8、`edit` 5、`write` 1、`glob` 1；另有 Skill 1、todo control 2；shell、terminal、
  subagent、workflow、XuanLing fs 均为 0。
- UI 显示 Skill、Read/Edit/Write/Glob、任务状态和四个可点击产物；Memory MCP 会话的工具行
  则显示完整 `Tool call mcp__xuanling__...` 名称并可展开结构化 IN/OUT，二者可读且可区分。
- 独立执行
  `node test/deepseek-harness/evaluation/scripts/verify-filesystem-fixture.mjs --workspace <web/workspace>`
  返回 `oracle_exit=0`、`pass=true`、`failures=[]`。模型自报未参与 oracle 判定。

### Wave 6.4 two-turn Memory acceptance（2026-08-16T00:45:51Z）

- Memory session：`session-096385fd-fbb4-4d26-9183-ad64c4504972`。第一回合调用
  `xuanling-memory-workflow`，随后执行 exact/ancestors 两次 `memory_search` 和一次
  `memory_candidate_create`；没有 `memory_review`。proposal
  `proc-dsh-eval-fixture-oracle-before-self-report-0001` 以 `pending/revision 1` 结束；当场 SQLite
  复核 review/head/version 均为 0。
- 第二个明确用户回合针对该 proposal 和 revision 1 下达 approve，session 只执行一次
  `memory_review`。CAS 后 proposal=`approved/revision 2`、review 的
  `expected_proposal_revision=1`、`applied_record_revision=1`；active head、immutable version、
  Unicode FTS、trigram FTS 各一行。没有创建第二个 candidate，也没有第二次 review。
- review 后第一条多关键词 query
  `fixture oracle filesystem evaluation self-report` 返回空；第二条标题 query
  `Verify DSH filesystem results independently` 命中 revision 1 active record，reasons 同时含
  `fts_unicode61` 与 `fts_trigram`。因此生命周期合同通过，但召回对 query 组合/分词敏感是
  当前已确认限制；本计划不扩张到向量或重排实现。
- 隔离 credential 文件只核验权限 `0600` 和位置，未读取或回显内容。临时 DB 最终为
  proposal/review/active head/version/unicode FTS/trigram FTS 各一；默认 DB 从 W5 到 W7 始终为
  `c828b6ed632ccd21864cc6c48b8d15a2dd969ff433b73be39f0c9fad47a4e6aa`，无 WAL/SHM。

### Wave 7 final regression and handoff（2026-08-16T00:50:57Z）

- Required commands：`npm --prefix npm run check` 通过（version/package 0.2.1）；
  `npm --prefix npm test` 56/56；`npm --prefix npm run check:docs` 18 files；Memory/fs
  bridge verifier 各 9/9；report verifier 为 `verified=true`、`trials=15`、
  `cache_read_share=0.9156`、`candidate_not_applied`；`git diff --check` clean。报告与账本写入后
  又重跑 npm 56/56、docs、report verifier 和 diff gate，均通过。
- XuanLing revision `47f1cff156896cd3006258b6e4519a4bb2bc3f6a`、branch `main`；完整 status
  152 项，SHA-256 `afde7a15b0f568812bf01dd6be99fff8ceb3aec6abf2f8a63e69c00b237b31f2`；
  任务相关 tracked diff 仍为空串哈希 `e3b0c442...`，相关 untracked path 清单哈希
  `8a1e05fdd6336a0bbe51f2222ea9b8f7f095276a18be6f47856c602e9d399e6e`。Rust catalog
  snapshot 仍为 `1ee881e3a5644cae1249b1fdeccfcfe78a8c5762510eb33c5455f3cb38c6d020`。
- DSH revision `47f943859bef60e4160492346772ded9b24f765a`、branch `master`；status SHA-256
  `39d1f6c63477d3faf9beb23e6eda9bf80c8f231418e1f019bb1730fbe2a1bdc1`，仍恰好两个
  pinned untracked，逐文件哈希与 W0 相同。
- 默认 Memory DB SHA-256 仍为
  `c828b6ed632ccd21864cc6c48b8d15a2dd969ff433b73be39f0c9fad47a4e6aa`，无 WAL/SHM。
  隔离 Web DB 为 1 proposal、1 review、1 active head、1 version、两套 FTS 各 1；其 WAL/SHM
  属仍运行服务的正常状态，不参与默认数据指纹。
- `http://127.0.0.1:57960` 最终 HTTP 200；PID 62609/62615 仍存活，62615 监听
  `127.0.0.1:57960`。服务、隔离 workspace、两条已验收 session 与 credential 配置均保留供
  用户继续试用；未发布、提交、push、切换默认 bundle 或清理临时证据。

```text
EXECUTION_STATUS: COMPLETE
PLAN_ID: deepseek-harness-skills-fs-eval-20260815
CHECKOUT_FINGERPRINT: XuanLing 47f1cff156896cd3006258b6e4519a4bb2bc3f6a / afde7a15…（152 entries）；DSH 47f943859bef60e4160492346772ded9b24f765a / 39d1f6c6…（2 pinned untracked）；snapshot 1ee881e3…；default DB c828b6ed… no WAL/SHM
CURRENT_WAVE: W7
CURRENT_WORK_PACKAGE: W7.3-fingerprints-live-handoff
WAVE_STATE: complete
CONTRACTS_PROVEN: C-01 through C-11
EVIDENCE_ADDED: W6 file Skill session + independent oracle; W6 two-turn Memory transcript + SQLite/FTS audit; Native/MCP UI evidence; W7 npm/docs/bridge/report/diff/fingerprint/live-health gates
FAILED_GATES: none current; historical discovery failures remain recorded above
NOT_RUN_GATES: none
BLOCKERS: none
NEXT_EXACT_ACTION: None for this plan; any production-default change requires a separate authorized plan.
LEDGER_PATH: docs/plans/deepseek-harness-skills-filesystem-evaluation-execution-ledger.md
```
