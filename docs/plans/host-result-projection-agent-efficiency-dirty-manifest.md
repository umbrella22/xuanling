# 宿主结果投影与 Agent 使用效率优化 dirty attribution manifest

> 记录时间：2026-08-18。
> 基线 revision：`9a08f33a2582e4a6c61d0eceb3bfb6f3657ef13f`。
> 用途：冻结 W0 看到的既有实现输入及其所有权；不表示这些文件已经通过本计划验收。

## 1. Git 状态边界

- W0.1 只读基线：status `7ca45f778f0d169662a16015f1ea2cc9ae03c3d109c16dfbf1c4c74720d24a62`，
  staged diff `b956b522c2d18180bb48ccddeaa5868d12a4b04b5a72e10b4ff77e0350c99eac`，
  unstaged diff `2ce1808f84cca597d805b8086e2bf268b755e52a73c98c3dad3709262396ae1d`。
- 计划编写期间发生的变化仅为下表既有实现输入被外部操作放入 Git index；这些文件的路径、
  per-file bytes 与 post-authoring diff hashes 均保持一致。W0 未执行 unstage/restage。
- 下表 `external input` 表示在本计划执行前已存在、当前归用户或外部执行者所有的
  `implemented_unverified` 输入。后续 Wave 只有在 Allowed files 内实际修改后，才把相应 diff 归入
  本计划。

## 2. Staged implementation inputs

| Path | SHA-256 | Role | Owner at W0 |
| --- | --- | --- | --- |
| `integrations/deepseek-harness/README-ZH.md` | `28df1f98b483d1a815d7ebc05ac9fbfc8a3488ab93a6ccb00fc2f95aff020baa` | DSH integration docs | external input |
| `integrations/deepseek-harness/README.md` | `de9e036a87992a14ac31f2db2dd209485a0e4f9e1e7e0871f0bc58aa6d2c6517` | DSH integration docs | external input |
| `integrations/deepseek-harness/xuanling-memory/README-ZH.md` | `69183b32e20b9cd9acc74dd7e83edd4f517e52260ecff3ac906cfb8f238028de` | Memory bundle docs | external input |
| `integrations/deepseek-harness/xuanling-memory/README.md` | `01fa9205831b484104b1ce11e93b0d352ec465ce2ebc350737ada62526a94468` | Memory bundle docs | external input |
| `integrations/deepseek-harness/xuanling-memory/cordis.patch.yml` | `ce61936b6683bd2903487e1a86bbd885a5acbe3b0b1feff60f0159e2eb78bc07` | Memory bundle launch | external input |
| `integrations/deepseek-harness/xuanling-memory/mcp-result-adapter.mjs` | `32b62ff9e2ff1bb69545f8bde56fbf654ce7876409aa8c145ab79e1b7e96faa0` | DSH result adapter | external input |
| `integrations/deepseek-harness/xuanling-memory/package.json` | `d1d85f381e09044c1c532d8de9a1b954d804fe1d2521421cf701a22a45f2ac18` | Memory bundle package | external input |
| `integrations/deepseek-harness/xuanling-memory/schema-adapter.mjs` | `8e8bcb862009b264de12d30842b7b44cf9517138c79eb6eaa7c9b6518f62665a` | Memory schema/result composition | external input |
| `integrations/deepseek-harness/xuanling-tools-replace/README-ZH.md` | `574620e82298ddf648e143382eb404af46ffd16e40ad9140646660afa40f6112` | replace bundle docs | external input |
| `integrations/deepseek-harness/xuanling-tools-replace/README.md` | `4440f66b079c84b153cabef824e93e44188ed3c1ca57d2039075b11905b3bd63` | replace bundle docs | external input |
| `integrations/deepseek-harness/xuanling-tools-replace/cordis.patch.yml` | `979b1baecefd488745b3ca4b0af15f5ef6f4fe2d7e22a08076c7298f8483b8d6` | replace bundle launch | external input |
| `integrations/deepseek-harness/xuanling-tools-replace/mcp-result-adapter.mjs` | `32b62ff9e2ff1bb69545f8bde56fbf654ce7876409aa8c145ab79e1b7e96faa0` | DSH result adapter | external input |
| `integrations/deepseek-harness/xuanling-tools-replace/package.json` | `8469d780b65f0b57e1d15cf4891b893c78f62d0c3f5b3f927d9f6887bfd6ebbe` | replace bundle package | external input |
| `integrations/deepseek-harness/xuanling-tools/README-ZH.md` | `75172f1a2ed29ae6e6d048b088a8d939ac0110b87ab1f6d606c6b8758e6ed5c0` | additive bundle docs | external input |
| `integrations/deepseek-harness/xuanling-tools/README.md` | `28303075a78fdaabd07b472c716ce54d8720701f3b6d02227e1de5e67ec463ef` | additive bundle docs | external input |
| `integrations/deepseek-harness/xuanling-tools/cordis.patch.yml` | `aa4dc93730cb0ad4a5d07202c96e58acbb4a602bb5c49629c945f55d36c660fd` | additive bundle launch | external input |
| `integrations/deepseek-harness/xuanling-tools/mcp-result-adapter.mjs` | `32b62ff9e2ff1bb69545f8bde56fbf654ce7876409aa8c145ab79e1b7e96faa0` | DSH result adapter | external input |
| `integrations/deepseek-harness/xuanling-tools/package.json` | `ac4ca46db76237b493836b343fd2576b76980dfd8ae9e96f4fce904daf76431b` | additive bundle package | external input |
| `integrations/zcode-plugin/plugins/xuanling-mcp/.mcp.json` | `2ee903083f9253aed855a3e922c8c9b9f4ce3ad565457ca10013e9765431d7dd` | ZCode launch contract | external input |
| `integrations/zcode-plugin/plugins/xuanling-mcp/README-ZH.md` | `98942c03c54ea7c275df24daf5c84c19f62f40aa34070968fa7583152d653333` | ZCode plugin docs | external input |
| `integrations/zcode-plugin/plugins/xuanling-mcp/README.md` | `5f69aad5a642f0d846ab5ec5307e274382b5bbc30e4a5c4c088e8569f67da59f` | ZCode plugin docs | external input |
| `integrations/zcode-plugin/plugins/xuanling-mcp/mcp-result-adapter.mjs` | `eec33d417fe75919b38c3fba6ae083e53be84c77c444385c42d5aafe04beb910` | ZCode result adapter | external input |
| `npm/scripts/verify-zcode-marketplace.mjs` | `c15de0e4cd0227389f2ee6352b971c0c25289e2b032291be16fa06f22eb8042a` | package verifier | external input |
| `npm/test/deepseek-harness-bundle.test.mjs` | `1cd33cc54df4e7245446bbdf69b3c775ec2ecb9565d8c13726b14f0cb67881cf` | DSH bundle contract | external input |
| `npm/test/deepseek-schema-projection.test.mjs` | `e79500d2aea105a68cd73a8d316dd8e17e6ad4ede11287a25cd334091df3664f` | DSH schema/result contract | external input |
| `npm/test/mcp-result-projection.test.mjs` | `da3fa99cac5a79ac7b37c7fe8282b06dbc08e8ab1f626c6786ef2f6866e75d92` | host projection contract | external input |
| `npm/test/zcode-plugin-contract.test.mjs` | `e27d6d5dd9c829663a87cce181350d56eedb18748e3b4e5b2ece0051af87f6d0` | ZCode plugin contract | external input |

三份 DSH `mcp-result-adapter.mjs` 字节相同；ZCode adapter 字节及语义保持独立。

## 3. Unstaged documentation inputs

| Path | SHA-256 | Owner at W0 |
| --- | --- | --- |
| `docs/adr/0002-filesystem-tool-safety-and-efficiency-rfc.md` | `acd70aad10ad404dd5668f7dd09ee6f61d09a2afeecae43785edda5c4b89b179` | external input |
| `docs/guides/xuanling-mcp-integration.md` | `aa609fc9b315636408cbaddb1f018c9c76e0a11ff4ded512e34914c520aab47d` | external input |
| `docs/plans/README.md` | `5577747739192f671c46e0ed7b25e081e6c3b4bb1273032ddec6020adea23e00` | plan-authoring input |

## 4. W0 outputs and protected user files

- W0 outputs: this manifest, the current implementation plan and execution ledger, plus the append-only
  reconciliation in `host-local-integration-distribution-execution-ledger.md`. Their hashes are intentionally not
  self-recorded here; Git diff and the execution ledger are canonical.
- Protected user files: repository-root `AGENTS.md` and `plan.md`. They remain untracked and are excluded from all
  implementation, staging, packaging, and release sets. Their contents are not copied into this manifest.
- Protected external checkout: `/Volumes/project_home/github/deepseek-harness` remains at
  `47f943859bef60e4160492346772ded9b24f765a` with exactly its two pre-existing untracked comparison tests.
- Protected user data: `/Users/ikaros/.xuanling/memory.db` was read only for its W0 fingerprint; no WAL/SHM or
  open holder was observed, and no test may use that path.
