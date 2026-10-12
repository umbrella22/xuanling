# C-11 evidence manifest v1

本接口判定显式证据，不遍历历史 reports。合成测试仅证明判定器/runner 正确；不能证明
provider、三 OS、lifecycle 或产品已验收。最终收集与真实环境验收由 Main 负责。

## 导出接口

- `scripts/verify.mjs`：`captureEvidenceFingerprint({ packageRoot, repoRoot })` 返回
  `{ revision, source_sha256, artifact_sha256 }`；两个 root 可显式指向异地 checkout。
- `scripts/verify.mjs`：`VerificationNotRunError(reasonCode, message)`，
  `code = VERIFICATION_NOT_RUN`；`reasonCode` / `reason_code` 为有界大写原因码。
  runner 不序列化异常 message/stack，缺环境输出 `not-run`、`passed:false`、exit 1、clean count 0。
- `evidence-manifest.mjs`：`EVIDENCE_SCHEMA_VERSION`、冻结的 `REQUIRED_GATES`、
  `validateEvidenceManifest(manifest, { planId, evidenceFingerprint })`、
  `evaluateEvidenceManifest({ evidenceManifestPath, planId, evidenceFingerprint })`、
  `AcceptanceEvidenceError`、`validEvidenceFingerprint`、`equalEvidenceFingerprint`。
- `behavior-evidence.mjs`：冻结的 `LIVE_BEHAVIOR_FLAGS` / `LIVE_BEHAVIOR_IDS` /
  `LIVE_BEHAVIOR_HASHES` / `LIFECYCLE_BEHAVIOR_FLAGS`，及
  `validLiveBehaviorDetail` / `selectLiveBehaviorDetail` / `validPlatformBehaviorDetail` /
  `validLifecycleBehaviorDetail`。验证函数只返回 bool，不回显失败内容。
- `manifest.example.mjs`：`createNotRunEvidenceManifest({ planId, evidenceFingerprint })`。
  生成完整 **not-run** 初始清单；不生成任何 passed 产品证据。

## 收集顺序与调用

1. 冻结 source、CI 和当前 lib。由 Main 独占 build；worker 不 build。
2. 调用 `captureEvidenceFingerprint` 取得当前指纹。
3. 正常 suite 使用 `--plan-id dsh-blueprint-takeover-v1 --report-dir <fresh-dir>`；
   api/security/recovery/critical 使用 `--scope all`，critical 必须 `--repeat 3`。
4. 用 example 导出函数创建完整清单；逐条替换为真实 fresh report 的路径、SHA256、status。
   SHA256 是**原始完整文件字节**，不是 JSON 重新序列化后的哈希。
5. 三 OS 分别采集各自真实 platform runner report，不模拟 `process.platform`。
   当前 fingerprint 必须相同（源码/产物用相对路径排序哈希，不能每个平台任意 rebuild 后
   将不同 lib 哈希伪称相同）。若产物不同，不能通过本 v1 合同，需 Main 决定合同/收集流程。
6. web/headless lifecycle 分别提供相同 v1 report envelope，suite=`lifecycle`，
   scope=`web` / `headless`，results 包含 PL1–PL7 的真实行为验收。
   旧 `probe/assertions` 报告不能直接充当 v1 receipt。缺此能力时保持明确 not-run，不能
   在 aggregator 内将旧历史 JSON 自动包装为 fresh evidence。
7. 使用现有 verify 命令加 `--suite acceptance --evidence-manifest <manifest.json>`，并显式
   指定同一 plan-id 与隔离 report-dir。`--evidence-manifest=...` 也支持；仅 acceptance 可用。

所有 runner suite helpers 始终包含 `planId`、`reportDir`、`evidenceFingerprint`、
`evidenceManifestPath`（非 acceptance 为 undefined）与 `VerificationNotRunError`。
默认 plan-id 和 report routing 不变；malformed options 在执行/写 report 前以 exit 2 拒绝。

## 清单字段

顶层只允许 `schema_version:1`、`plan_id`、`evidence_fingerprint`、`gates`。
每个 gate 的固定 id、suite、scope、minimum_repeat 来自 `REQUIRED_GATES`：

- 15 个正常 suite：foundation / definition / resources / runtime / host / api /
  portability / security / recovery / critical / browser / performance / platform / live / package。
- `platform-darwin`、`platform-linux`、`platform-win32`：suite=platform，scope=null，
  environment.platform 必须分别为真实 `darwin/<arch>`、`linux/<arch>`、`win32/<arch>`。
- `lifecycle-web`、`lifecycle-headless`：suite=lifecycle，scope 分别 web/headless。
- api/security/recovery/critical scope=all；其他正常 suite scope=null。
- critical minimum_repeat>=3；其他>=1；最大值沿用 runner 的 10。

passed 条目示意（实际 SHA/路径必须由真实证据替换，不可直接使用）：

```js
{
  id: 'critical', suite: 'critical', scope: 'all', minimum_repeat: 3,
  status: 'passed', path: './fresh-critical-report.json', sha256: actualFileSha256
}
```

明确缺口条目：

```js
{
  id: 'platform-win32', suite: 'platform', scope: null, minimum_repeat: 1,
  status: 'not-run', reason_code: 'ENVIRONMENT_UNAVAILABLE', path: null, sha256: null
}
```

path 可为绝对路径，或相对**清单所在目录**的合法 OS 路径；不相对 cwd 猜测路径。
仅读取明确指定的 JSON 文件，拒绝 key/docs 路径与指向它们的路径别名，不跟随最终文件符号链接。
绝不删除固定 required 项缩小范围，未知/重复 ID 和额外 schema 字段也拒绝。

## Report v1 合同

- 顶层：schema_version=1、plan_id、suite、scope、repeat、passed、clean_acceptance_count、
  environment.platform、evidence_fingerprint、evidence_fingerprint_after、非空 runs。
- 每个 run：index 从 1 连续递增、passed、clean_acceptance_count、前后 evidence fingerprint、
  非空 results。runner 另外记录 started/finished/duration_ms，保留原 fingerprint 字段。
- result：唯一 id、expect=pass、status=pass；固定 required_cases 不能缺失。
  expected-red 仍被 runner 正确分类，但不能充当正常产品 gate 的绿色结果。
- repeat 与 runs.length 一致并满足 minimum_repeat；**所有** runs 与 results 都绿、连续计数正确，
  而非只检查最终 run 或顶层 passed。任何失败/not-run 重置实际 streak；stale 不能延续原指纹计数。
- 全部前后/run 指纹等于清单与当前 checkout，任意 drift 使报告不通过。
  source 覆盖 plugin src/config/test/tests/scripts/examples、root-level 配置/manifest、test/blueprint 源码、
  CI workflows 与根 package.json；排除 node_modules/lib/reports/dist/.cache/.git/artifacts、
  key/docs、tgz/log。artifact 覆盖当前 lib 所有 JS，稳定相对路径排序后 SHA256。
  生成 reports 不污染 source。非 Git synthetic root 的 revision 为 unknown，不能用于正式 acceptance。

## 深层行为 receipt（不是签名/真实性证明）

以下 detail 是完整 JSON **对象**，不是 200 字符截断字符串。只靠 status/pass、
report.passed、`ready/import-only`、report/case 顶层 behavior_assertions 不可通过。
runner 对 L1 使用白名单结构化保存，不保存 outcome 内自由文本/raw 字段；缺正确行为事实
直接 fail/LIVE_BEHAVIOR_INVALID。sol-L 的真实执行 oracle 负责事实来源和 secret 边界。

### Live L1

`result.detail = { ok: true, behavior_assertions: facts }`。facts 必须包含：

- `runId`、`attemptId`、`downstreamAttemptId`、`sessionId`：非空生产生成 ID，
  ASCII 字母/数字/下划线/连字符；不截断、不归一化；下游 Attempt 与 model Attempt 不同。
- `sessionId` 以 `bp-${runId}-${attemptId}-` 开头且有非空后缀，不能冒用其他 Run/Attempt。
- 以下事实严格为 boolean `true`（truthy/string 不算）：`runSucceeded`、`agentCreated`、
  `inboxSeen`、`scopedAgentSeen`、`requestSeen`、`loopRequestSeen`、`responseSeen`、
  `completed`、`disposed`、`nonceMatched`、`downstreamMatched`。
- `output_sha256`、`nonce_sha256`：64 字符小写 hex SHA256，两个值相等。

字段来自 sol-L `assertJourney` 的实际 Run/Attempt/downstream 和 Agent observer。
缺字段、false、digest 不等、ID 不关联 → typed fail `LIVE_BEHAVIOR_INVALID`；不读取 provider raw。

### Platform PL1

所有 platform suite（含普通 platform 和三 OS gate）PL1：
`detail = { ok:true, platform:process.platform, arch:process.arch }`。
`platform/arch` 与 `report.environment.platform` **完整相等**，不能只改环境声明伪称其他 OS。
错误/缺失 PL1 行为 → typed fail `PLATFORM_BEHAVIOR_INVALID`；独立缺 environment 为 not-run。
实际 OS 来源仍须可信 runner，由 Main 在真实三 OS 分别采集，合成字符串不证明平台运行。

### Lifecycle PL1–PL7

每个生命周期 v1 envelope 额外包含 `mode`（严格等于 web/headless scope）和
`artifacts.tarball = { path, sha256 }`（非空 artifact locator、64 小写 hex digest）。
每个 PL1–PL7 pass result 的 `detail` 为：

```js
{
  ok: true,
  mode: actualMode,                    // 等于 report.mode 和 scope
  artifact_sha256: actualTarballSha,    // 等于 report.artifacts.tarball.sha256
  behavior_assertions: actualAssertions
}
```

对应 actualAssertions 的全部必需 bool：

| Case | 必须真实观察且为 true 的行为字段 |
| --- | --- |
| PL1 | packed |
| PL2 | profileInitialized |
| PL3 | installed、reconciled |
| PL4 | booted、blueprintPingSucceeded |
| PL5 | disabled、uninstalled |
| PL6 | baselineBundlesPreserved |
| PL7 | sourceUntouched、runtimeDataUntouched |

PL4 public service ping 由相应 web/headless 实际宿主路径采集，不能用 import/ready 替代。
模式/产物不一致、缺任何行为或 false → typed fail `LIFECYCLE_BEHAVIOR_INVALID`。
每个 run 都检查，不能用最后一次 green 掩盖前次缺行为。
这里校验收集时的 artifact digest 关联，不重新读取临时 tarball；原始 bytes 与可信 fresh 执行来源
由 Main 收集并审查，摘要不是签名。旧生命周期 `probe/assertions` 不自动转 v1；缺真实 collector
能力时显式 not-run，不能填 synthetic bool 冒充产品验收。自有 collector 写完整 v1 receipt，
不能依赖 runner 其他普通 case 的截断展示字符串充当行为对象。

## 失败分类与证据含义

- 缺 manifest/gate/env、显式 not-run 或真实 not-run report：`VerificationNotRunError`。
- schema/JSON 损坏、tamper、wrong plan/identity/scope/repeat、stale、failed、empty 或缺 case：
  `AcceptanceEvidenceError`，code=`ACCEPTANCE_EVIDENCE_INVALID`，最小 reason_code/gate_id。
- 已提供的坏证据优先于其他缺口；不能用 not-run 掩盖已知 failed/tampered gate。
- evaluator 不回显报告内容、路径、provider raw 或凭据；runner 对异常同样仅输出脱敏原因。
- 所有 receipt 都需要可信真实执行来源；schema/hash 不构成签名，合成可构造完整绿色数据，
  只能作为判定器 calibration，绝不自动证明真实网络/平台/产品验收。

合成测试全部写临时目录并清理；fresh worker 测试日志位于 takeover/w4。最终冻结后 Main
独立复跑；实现/CI/liveworker 的任意 source 修改均使旧证据 stale，不沿用历史完成标记。
