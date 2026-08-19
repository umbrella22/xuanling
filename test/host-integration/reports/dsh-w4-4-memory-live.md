# DSH W4.4 Memory Dogfooding Evidence

This report records the primary-agent DSH acceptance for the W4.4 file and Memory workflow
protocol. It does not represent GLM-independent evidence. The maintainer accepted this current-
revision 12/12 result under an explicit executor-identity waiver on 2026-08-19, so it closes W4.4
without claiming that GLM ran the DSH protocol.

## Runtime and Isolation

| Field | Value |
| --- | --- |
| DSH revision | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` |
| XuanLing revision | `9a08f33a2582e4a6c61d0eceb3bfb6f3657ef13f` |
| Route | `deepseek-official/deepseek-v4-pro/max` |
| Run id | `w4-4-dsh-r3b` |
| Trial shape | 4 frozen cases x 3 repetitions |
| Collector | 12/12 complete sessions, exit 0 |
| Independent oracle | 12/12 verified, `pass: true` |
| Evidence root | `/var/folders/3c/bxhhfjtx4mvcfvw1br4843qr0000gn/T/xuanling-dsh-w4-4.w4-4-dsh-r3b` |
| Runner summary SHA-256 | `e53f286f2ae1d269283696bc7ecd00a7e1fec1df13cd43de7d550ead5c8e595c` |
| Verifier summary SHA-256 | `e657faba932a5826f6f7c2e22610a937b45304272493cdf631d8f9eac1e9ca79` |
| MCP binary SHA-256 | `c4cc14cdfe187d73435f50c183fd6bc7d0d420fb738de1649874d2e6df405a32` |

Every trial used a fresh absolute workspace, `DSH_HOME`, and Memory database. The credential was
passed as an owner-only file reference; the credential value was not read or persisted. The
runner's child environment was an explicit allowlist. The default database
`/Users/ikaros/.xuanling/memory.db` remained SHA-256
`4c10be200e4984c07927b485b6660ccf7a8787f66f006019028c5de48e489c74`. No repository-root
`.xuanling-w4-memory.db*` file remained after containment, and no DSH or XuanLing child process
was present after the run.

## Case Results

| Case | Required behavior | Observed tool pattern across 3 trials | Workspace result | Memory result |
| --- | --- | --- | --- | --- |
| 1 | Project-local fact uses L1 only | Skill discovery, native `glob`, `write`, `read`; no Memory call | Only `AGENTS.md` was created; README stayed unchanged | `0` proposals, `0` reviews, `0` heads, `0` versions |
| 2 | Absent shared fact becomes pending proposal | One `memory_search` followed by one `memory_candidate_create` per trial | Workspace unchanged | `1` pending proposal, `0` reviews, `0` heads, `0` versions |
| 3 | L1 pointer triggers one scoped pull after topic switch | One native pointer read and exactly one scoped `memory_search` per trial | Workspace unchanged | `0` proposals, `0` reviews, `0` heads, `0` versions |
| 4 | Empty recall does not block the main task | One `memory_search`, native README `read` then `edit` per trial | README updated to the frozen tagline | `0` proposals, `0` reviews, `0` heads, `0` versions |

Case 2 stopped at the review boundary. No `memory_review` call occurred. The candidate payload,
proposal id, idempotency key, namespace, global scope, and revision `1` matched the frozen contract.
Case 3 and case 4 produced empty search results and performed no Memory write. Provider usage was
present and structurally valid in all 12 transcripts.

The independent verifier recomputed workspace manifests from the trial directories. The resulting
after-manifest digests were stable within each case:

| Case | Before workspace SHA-256 | After workspace SHA-256 |
| --- | --- | --- |
| 1 | `4f62162f3efa1053819017833a9bd2f0846474d624524aa34e9d407e6cc5f8ff` | `5f88b19fb2504f366481ccecb629992b26bf70829a8181e9a2547d005164e61c` |
| 2 | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| 3 | `0a0f1bb794d982086f04f263e521b4901b49875191ee89c07623927d4b8dff87` | `0a0f1bb794d982086f04f263e521b4901b49875191ee89c07623927d4b8dff87` |
| 4 | `1a3ba09fce30390d09e44908e47862920aa0ec164520b8a4e9facb0acae2c24c` | `14fe223b14f0d58cf06e2065767f87c559bfda10fa98ec10d4c9bbf4ac147f7f` |

## Provider Usage

The verifier de-duplicates usage by `(turn, step)` and requires canonical `turn/end` termination.
The 12 verified trials sum to:

| Usage field | Total |
| --- | ---: |
| `inputTokens` | 125,981 |
| `outputTokens` | 15,637 |
| `cacheReadTokens` | 428,160 |
| `cacheWriteTokens` | 0 |

These values are provider-reported session evidence. They are not a tokenizer measurement for the
tool catalog and do not close W4.5.

## Exploratory Run and Corrections

The first exploratory DSH run was retained as diagnostic evidence. It exposed four protocol or
task-shape issues: case 1 did not explicitly require a root `AGENTS.md`; case 2 allowed a second
read-only search before candidate creation; case 3 permitted a recoverable relative-path read error;
and the first workspace association check used the wrong expected root. The frozen task wording and
verifier were tightened, while recoverable typed errors and repeated read-only searches were handled
according to their case contracts. The subsequent `w4-4-dsh-r3b` run passed without suppressing those
observations.

## Verification

The following gates passed:

```text
node --check test/host-integration/dsh-w4-4/run-memory-dogfooding.mjs
node --check test/host-integration/dsh-w4-4/verify-memory-dogfooding.mjs
node test/host-integration/dsh-w4-4/verify-memory-dogfooding.mjs \
  --root /var/folders/3c/bxhhfjtx4mvcfvw1br4843qr0000gn/T/xuanling-dsh-w4-4.w4-4-dsh-r3b \
  --repetitions 3
env -u XUANLING_DSH_RUN_ID node test/host-integration/dsh-w4-4/run-memory-dogfooding.mjs \
  --dry-run \
  --dsh-root /Volumes/project_home/github/deepseek-harness \
  --binary /Volumes/project_home/github/xuanling/target/debug/xuanling-mcp \
  --credentials-file /Users/ikaros/.dsh/.credentials.yaml
node --test npm/test/mcp-result-projection.test.mjs \
  npm/test/zcode-plugin-contract.test.mjs \
  npm/test/deepseek-schema-projection.test.mjs \
  npm/test/deepseek-harness-skills.test.mjs
npm --prefix npm run check:docs
git diff --check
```

The focused Node suite passed 69/69 tests and `check:docs` checked 92 Markdown files. The DSH source
entry `pnpm dsh --profile headless --help` passed. `pnpm run build` in the preserved DSH checkout
remains blocked by the two pre-existing untracked tests
`packages/core/tools/tests/xuanling-compare-measure.spec.ts` and
`packages/mcp/mcp-client/tests/xuanling-live.spec.ts`; both pass `root` to a `Config` type that does
not declare that property. The full `npm --prefix npm test` command was not green (144/148): four
filesystem/Memory runner tests stopped during setup because the preserved untracked
`integrations/deepseek-harness/xuanling-skills/xuanling-skills` self-referential symlink is not a
regular bundle entry. No model call started for those failures, and no W4.4 source change caused
either the DSH build failure or the symlink setup failures.

## Acceptance Boundary

This report establishes a deterministic primary-agent DSH sub-evidence for the Skill routing,
single-write L1/L2 Memory policy, pending-proposal review gate, and no-match continuation. The
maintainer waiver accepts the frozen 4-case, 3-repetition DSH result and its independent verifier as
W4.4 completion evidence. GLM did not run this DSH protocol, and this report cannot support a GLM-
independent claim. ZCode projection acceptance remains W4.2 evidence; layered cost evidence remains
W4.5. Windows portability, release packaging, and publication are outside this report.
