# DSH Native Filesystem Live Evidence

This report records the current-revision Native filesystem acceptance for DeepSeek Harness. The
runner used isolated workspaces, DSH homes, and Memory databases for every trial. The source
checkout remained unchanged.

## Runtime Contract

| Field | Value |
| --- | --- |
| DSH revision | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` |
| Route | `deepseek-official/deepseek-v4-pro/max` |
| Run id | `w4-20260818-fs-c1` |
| Trial shape | Arms A/B/C; 3 quality runs and 1 cold/warm pair per arm |
| Total | 15 trials |
| Runner result | 15/15 complete sessions; exit 0 |
| Fixture oracle | 15/15 pass |
| Route verifier | 15/15 pass |
| Provider usage | Present and valid for 15/15 |
| Cache-read share | `0.9124` |
| Shell calls | 0 |

## Tool Routing

| Arm | Native filesystem calls | XuanLing filesystem calls | Skill calls | Result errors | Outcome |
| --- | ---: | ---: | ---: | ---: | --- |
| A | 79 | 0 | 0 | 0 | 5/5 pass |
| B | 0 | 96 | 2 | 1 | 5/5 pass; one typed precondition retry |
| C | 61 | 35 | 3 | 0 | 5/5 pass |

The B-arm error was `XUANLING_FS_OVERWRITE_REQUIRES_SHA256`. The subsequent call supplied the
required hash and completed the task. No trial was incomplete, and the fixture oracle observed no
incorrect final state.

## Isolation Evidence

The evaluation copy at `/private/tmp/xuanling-dsh-fs-current.tk1xT8` excludes the source checkout's
self-referential package symlink. The raw trial root is
`/var/folders/3c/bxhhfjtx4mvcfvw1br4843qr0000gn/T/xuanling-dsh-fs-eval.w4-20260818-fs-c1`.
The compact analysis, independent oracle output, and runner summary have SHA-256 values recorded in
the companion [fixture](../fixtures/host-live/dsh-native-current-99f6f02-filesystem-live.json).

The credential was passed as an owner-only external file reference; its value was not read or
hashed. The default Memory database retained SHA-256
`4c10be200e4984c07927b485b6660ccf7a8787f66f006019028c5de48e489c74`. No repository-root
`.xuanling-w4-memory.db*` file and no DSH process remained after the run.

## Verification Commands

```text
env -u XUANLING_DSH_RUN_ID node /private/tmp/xuanling-dsh-fs-current.tk1xT8/test/deepseek-harness/evaluation/scripts/run-filesystem-evaluation.mjs --dry-run --dsh-root /Volumes/project_home/github/deepseek-harness --binary /Volumes/project_home/github/xuanling/target/debug/xuanling-mcp --arms A,B,C --quality-runs 3 --cache-pairs 1 --model deepseek-official/deepseek-v4-pro --reasoning-effort max --credentials-file /Users/ikaros/.dsh/.credentials.yaml
XUANLING_DSH_RUN_ID=w4-20260818-fs-c1 node /private/tmp/xuanling-dsh-fs-current.tk1xT8/test/deepseek-harness/evaluation/scripts/run-filesystem-evaluation.mjs --allow-billable-live --dsh-root /Volumes/project_home/github/deepseek-harness --binary /Volumes/project_home/github/xuanling/target/debug/xuanling-mcp --arms A,B,C --quality-runs 3 --cache-pairs 1 --model deepseek-official/deepseek-v4-pro --reasoning-effort max --credentials-file /Users/ikaros/.dsh/.credentials.yaml
node /private/tmp/xuanling-dsh-fs-current.tk1xT8/test/deepseek-harness/evaluation/scripts/analyze-filesystem-evaluation.mjs --root /var/folders/3c/bxhhfjtx4mvcfvw1br4843qr0000gn/T/xuanling-dsh-fs-eval.w4-20260818-fs-c1 --verify --arms A,B,C --quality-runs 3 --cache-pairs 1
node /private/tmp/xuanling-dsh-fs-current.tk1xT8/test/deepseek-harness/evaluation/scripts/verify-filesystem-fixture.mjs --all /var/folders/3c/bxhhfjtx4mvcfvw1br4843qr0000gn/T/xuanling-dsh-fs-eval.w4-20260818-fs-c1
```

The analyzer is version 8 and exits 0 for this complete current-revision matrix. The report
measures provider usage and cache behavior; it does not infer schema token counts from byte size or
session/UI text.

## Boundary

This evidence closes the DSH Native portion of W4.3. It does not close Code Mode independent review,
GLM dogfooding, the ZCode tokenizer limitation, or the Windows portability release gate.
