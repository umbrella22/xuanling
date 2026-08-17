# XuanLing Memory v2 抽离与重构执行账本

> 本文件是 `memory-v2-extraction-20260814` 的 canonical handoff。中断后从本文件恢复,
> 不依赖聊天摘要。计划见
> [memory-v2-extraction-development-plan.md](memory-v2-extraction-development-plan.md)。

```yaml
schema_version: 1
plan_id: "memory-v2-extraction-20260814"
updated_at: "2026-08-15T03:05:00+08:00"
plan_status: "executing"
checkout:
  revision: "47f1cff156896cd3006258b6e4519a4bb2bc3f6a"
  status_sha256: "cea322c2f76319ad0c13ecd86f8c860becd171ac38413e9422436a388f7dfeaa"
  relevant_diff_sha256: "32e881fbb2cdf9f479375e54a67ca581a65194c9f5aa477c3c2364a2a8eca225"
  relevant_untracked_sha256: "3834473613aa749526e4b5cf2d8a4f47594cafdf0688af7734000173e47677aa"
  untracked_recipe: "git ls-files --others --exclude-standard | sort;每行 path+file sha256;整体 sha256"
  w0_baseline_ignored_docs_path_list_sha256: "39eadacee5337b685937bcc6d4f76e565904d561cde6dc028015be6652a11daf"
  w0_baseline_ignored_docs_content_tree_sha256: "a5cedd04dac146dfd2931ee929305bb2c7e6628733afadc649819601e5720881"
current_wave: "C16"
current_work_package: "C16.5"
wave_state: "complete"
clean_acceptance_count: 6
last_completed_action: "W8.10 preflight 报告生成;W8.1-W8.9 全部非破坏性工作包完成"
next_action: "C-16 live 验收全绿。剩余外部项:git remote/CI、向 ZCode 反馈 host 参数序列化与双字段注入(host 修复后可移除兼容开关)、用户决定 commit"
required_gates:
  - "cargo fmt/check/clippy(三 crate)"
  - "cargo test -p xuanling-memory --test contract(24+1 ignored;feature 27+1)"
  - "cargo test -p xuanling-toolkit --features test-fixtures --test contract(132)"
  - "cargo test -p xuanling-mcp --test protocol(106)/golden(21)"
  - "node --test npm/test/*.test.mjs(16,含 zcode-plugin-contract 5)"
  - "npm --prefix npm run check(0.2.0)/check:docs(15)/test + smoke(42)"
  - "node npm/scripts/verify-mcp-contract.mjs(6 checks)与 raw-mcp-probe.mjs"
  - "C-15:全部 probe/测试/smoke 用 unique temp --memory-db;真实默认 DB 三文件 hash 不变"
  - "race/restart/import/rebuild 关键测试三次连续通过"
  - "git diff --check"
changed_files:
  - "W0-W2:docs 重建、边界测试、crate 抽离"
  - "W3.G2:MCP 测试 harness 七文件 C-15 化"
  - "W3.5-W3.7:九工具面、memory_contract_version=2、v1 全删、0001_memory_v2.sql、open() 拒 v1"
  - "W5:jsonl.rs、scope.rs 对称 Serialize、v2.rs 幂等重放、cli_maintenance.rs(4)、main.rs MemoryCommand"
  - "W6:embedder feature 门控、experimental 合同 3+2、catalog/source 扫描、memory CLI 父组修正"
  - "W7:copy_move_remove.rs copy_io_error(path_role)、write.rs Myers diff+局部 hunk、
     cli/raw/verify 脚本、check-docs 表格扫描、docs 两处 omitted-output 修正、
     docs/skills 新 Skill 源"
  - "W8:Cargo/npm/README 0.2.0、CI memory+smoke temp DB、publish canonical guard、
     integrations/zcode-plugin/**、zcode-plugin-contract.test.mjs、release codesign"
failed_commands: []
not_run_commands:
  - "W8.11 本机切换(live ZCode、插件同步、旧 DB 三文件删除——等待新授权)"
  - "W9 三平台 CI 实跑、live ZCode transcript、最终回归与文档收口"
blockers:
  - "W8.11:旧默认 DB 三文件删除需用户在 preflight 报告之后重新授权;未取得前 BLOCKED"

```

### W3.G2 完成证据(2026-08-14T16:50+08:00)→ C-15 隔离转绿

1. **基线冻结(只读)**:主文件 `62972a0a…`(241664B,mtime 15:46:13)、migrations
   {1,2,3}、v1 records=1、v2 canonical 全 0、integrity ok、无 holder。
2. **根因定位(二分)**:memory 套件 ✓ / golden ✓ / smoke ✓ / **protocol ✗ 触碰 WAL**。
   泄漏源为四个未被任何防护覆盖的生成点:`tests/protocol/tool_call.rs`、`handshake.rs`、
   `schema_snapshot.rs`(`Command::new(binary())`)与 `framing.rs`(`Command::new(locate_binary())`)
   ——它们历来不带 `--memory-db` 启动 stdio server;**原始 migration-3 写入者即为此类
   protocol 运行**。另修 `contract_hardening.rs` 的 `Peer::start/start_with_env/start_with_args`
   (原先同样裸启)。
3. **修复**:全部生成点创建 unique tempdir 并显式传 `--memory-db`(Peer 结构体持有
   TempDir;handshake/snapshot 返回 tuple 的两处以 `mem::forget` 保持生命周期);五个
   harness 文件内嵌 `enforce_isolated_memory_db`(缺 flag 或指向默认路径即 panic)。
4. **结构化 guard** `all_test_servers_use_explicit_temp_memory_db`(protocol 套件内):
   (a) 运行时校验缺失 flag / 默认路径均被拒绝(AssertUnwindSafe 断言 panic);
   (b) 源扫描七个 harness 文件,凡 `.spawn()` 块必须含 `--memory-db`,`.output()` 的
   CLI 查询(--help/--version/invalid args)为 allowlist。
5. **受控窗口证明**(窗口内零 mcp-plugin 调用):protocol 102/102 + smoke 前后,真实库
   主文件与 WAL hash **字节不变**(`62972a0a…`/`53f189d3…`);migrations {1,2,3}、
   counts、integrity、holders 全部与基线一致。WAL 残余帧 `53f189d3…` 来自修复前的
   泄漏运行(已回滚、无 durable 变化),此后字节稳定。
6. **全套 gate 绿**:fmt/clippy clean;protocol 102、golden 23、memory 43、toolkit 130、
   边界 4、npm 11、check:docs 14、`git diff --check` clean。

## 基线指纹核验记录(2026-08-14T14:16+08:00)

| 指纹 | 计划基线 | 结论 |
| --- | --- | --- |
| revision | `47f1cff…bc3f6a` | 一致 |
| relevant diff | `4e1e447b…7fb2a8cc` | 一致 |
| status(去 plan.md) | `961b04f0…b089031` | 一致(plan.md 为计划文件,可归因) |
| untracked 集合 | profile.rs + plan.md | 一致(均可归因) |
| docs 文件集 | 99 | 一致 |

计划 `ignored_docs_sha256` 配方未复现,以 path-list(`39eadace…`)与 content-tree
(`a5cedd04…`)替代,见 W0 记录。

## W0 完成证据(2026-08-14T14:45+08:00)→ complete

99 文件删除(清单 `af25b0d1…`)、9 个新文档、ignore 解除、README 类 legacy 清理
(源码内联 ADR 注释延后,理由落账)、check-docs.mjs(红性验证)。全 gate 绿。
详见前一版账本(此节内容未变)。

## W1 完成证据(2026-08-14T15:00+08:00)→ complete

`npm/test/repository-boundary.test.mjs` 四项 cargo metadata 结构化断言,红因逐一
核对;35 项 memory 测试基线固定(24 memory_contract + 11 memory_w5)。

## W2 完成证据(2026-08-14T15:35+08:00)→ complete

- Move map:migrations/store/error/tests 逐字迁移,模块路径重写清单见前版。
- 依赖边界:toolkit 无 sqlx/unicode-normalization;memory 无 toolkit/mcp;
  MCP 经 `mem_error()` 15+1 变体显式映射(IntegrityError→Internal 为临时,
  v2 工具直接序列化 memory 错误,W3.5 将移除)。
- Gate:35/35 parity、130/130 toolkit、101/101 protocol、23/23 golden、
  snapshot 字节等价(doc 注释 "(plan §8)" 已复原)、边界 4/4、npm 11/11。

## W3 进行中(2026-08-14T16:30+08:00)

### 已完成(W3.1-W3.4,store 层)

| 工作包 | 状态 | 产物 |
| --- | --- | --- |
| W3.1 v2 schema | ✅(过渡形态) | `migrations/0003_memory_v2_core.sql`:record_versions/record_heads(+dedupe_key)/record_tags/proposals/reviews/feedback_events/FTS v2 表(`memory_fts_v2_unicode/trigram`,避开 v1 同名表)+ active-dedupe 部分唯一索引 |
| W3.2 proposal DTO | ✅ | `src/proposal.rs`:MemoryPayload/ProposalOperation/Status/ReviewDecision、Candidate*/Review*/RecordGet/Feedback/SearchV2 全套 DTO(JsonSchema + deny_unknown_fields) |
| W3.3 review CAS | ✅ | `src/store/v2.rs`:candidate_create/replace/archive(request digest 幂等)、review 单事务(approve-create/replace/archive、head CAS、proposal revision 1→2 CAS、失败零写入、重放幂等)、record_get(当前/历史)、candidate_get/list(query-bound cursor) |
| W3.4 feedback | ✅ | feedback_event:append-only、version-bound、幂等(UNIQUE 竞态重放) |
| (W4 前置)search_v2 | 基础版 | exact/ancestors scope、active-only、applicability 过滤、rank lexical→scope distance→pinned→feedback→id;FTS 索引已由 review 事务维护(W4 换 RRF 双索引查询) |

- `src/scope.rs`:严格 tagged JSON MemoryScope(自定义 Deserialize:未知字段/空 id/
  U+001F 均拒绝)、ancestors 链、scope_key 规范化。
- `src/error.rs`:新增 `IntegrityError`(codes additive;MCP mem_error 临时映射 Internal)。
- 测试:`tests/contract/memory_v2_contract.rs` 8 项全绿(candidate_invisible、
  invalid_writes_nothing、rejected_never_changes_head、stale_target_conflicts、
  concurrent_review_cas、archive_preserves_history、idempotency_mismatch、
  scope_isolation)。
- **当前 gate 全绿**:memory 43/43、protocol 101/101、golden 23/23、clippy/fmt clean。
- 过渡设计说明:v1 migrations(0001/0002)暂留使 v1 测试继续通过;v2 表经 0003 共存。
  最终收敛(下述 a/b 步)时删除 v1 migration 并把 v2 基线改为 0001。

### 剩余工作包(按序执行)

1. **W3.G2 验证与真实 DB 隔离**:
   - 保存 `/Users/ikaros/.xuanling/toolkit-memory.db` 的 read-only migrations、v1/v2 canonical
     counts、integrity、三个 DB 文件 stat/hash 与 holder post-incident baseline；不读取 payload；
   - 把所有会启动 stdio server 的 protocol/golden helper 与 npm smoke 收敛为每个 child
     创建 unique temp DB 并显式传 `--memory-db`；`--help`/`--version` 查询为唯一 allowlist；
   - 加入 `all_test_servers_use_explicit_temp_memory_db` 结构化 guard；隔离 `HOME`、共享 temp
     DB 或口头约定都不满足合同；
   - 用 temp DB 运行 protocol/golden/smoke/raw proof，再次只读获取真实库状态；before/after
     完全一致后才将 current_work_package 改为 W3.5。
2. **W3.5 MCP 工具面**:
   - handlers.rs 删除 `memory_put/update/delete/compact/context` 工具定义与 dispatch;
   - 新增九工具:`memory_candidate_create/replace/archive/get/list`、`memory_review`、
     `memory_get`、`memory_search`、`memory_feedback`(v2 DTO 即 schema;
     destructiveHint 仅 review=true;候选工具 idempotentHint=true、readOnlyHint=false;
     get/list/search readOnly;feedback idempotent);
   - dispatch 走 `store.candidate_* / review / record_get / search_v2 / feedback_event`,
     memory 错误直接序列化为 envelope(删除 mem_error 映射);
   - namespace 缺省注入沿用 v1 的 ns_args 机制(default_namespace)。
3. **W3.6** server.rs `_meta` 增加 `xuanling.memory_contract_version: 2`
   (保留现有 contract_version=2);protocol 测试补断言。
4. **v1 移除与 schema 收敛**:
   - 删 `src/store/{ops,search,embeddings}.rs`、`src/{compact,context}.rs` 及其
     re-exports(lib.rs/store mod.rs);保留 `src/embedder.rs`(实验,W6 门控);
   - 删 `tests/contract/memory_contract.rs`、`memory_w5_contract.rs`(v1 行为已被
     v2 合同替代;检索类断言迁入 W4);
   - 删 migrations/0001/0002,把 0003 重命名为 `0001_memory_v2.sql`;
   - store/mod.rs open()/open_in_memory() 在 migrate 前检查
     `SELECT 1 FROM sqlite_master WHERE name='memory_records'` → 命中即返回
     `unsupported`("v1 database; create a fresh v2 database")(W3.7)。
5. **goldens**:tests/golden 的 v1 memory 用例改写为 v2 流程(lifecycle =
   candidate_create→review→get/search;feedback;update→replace 流)。
6. **snapshot**:`XUANLING_MCP_UPDATE_SNAPSHOTS=1` 重生成并逐块 review diff
   (预期:5 旧工具消失、9 新工具出现、memory schema 面变化)。
7. 三 crate fmt/check/clippy/test + protocol/golden + 边界 + npm 全套 +
   `git diff --check`;三次 `concurrent_review_cas` 连续通过(计划 §11)。

### Stop conditions 复核

C-15 已触发：真实默认 DB 被计划外应用 migration 3，且后续 debug raw probes 省略
`--memory-db` 并触碰 WAL/SHM；W3 因此回到 `red_confirmed`。无 self-approval 声明、无物理
删除、scope 未作授权、未改非 Memory MCP 行为。W3.G2 未完成前禁止继续 W3.5。

### 真实默认 DB 隔离事件与 W3.G1 证据

- `/Users/ikaros/.xuanling/toolkit-memory.db` 的 `_sqlx_migrations` 已含 migration 3
  `memory v2 core`，`installed_on=2026-08-14 07:02:54`；migration 最初写入者为 `UNKNOWN`。
- read-only audit：v1 `memory_records=1`；v2 proposal/version/head/review/feedback canonical
  counts 全为 0；`PRAGMA integrity_check=ok`。不记录或展示该 v1 row 的 payload。
- 新启已安装 0.1.0 binary 因“migration 3 previously applied but missing”禁用 Memory；该行为
  是 hybrid migration set 的用户可见影响，不是 v2 store 合同通过证据。
- 本次 debug raw probes 省略 `--memory-db`，约 15:50 触碰真实 WAL/SHM；审计 counts 未变。
  一次 read-only inspection 遇到 transient database lock，后续 read-only audit 成功。
- inspection 时存在两个 ZCode 0.1.0 process；`lsof` 未显示其持有三个旧 DB 路径。该结果
  只属于本次快照，W8 不得复用 PID/holder 结论。
- 未回滚 migration、drop table、删除/重命名 DB、停止进程或再次用默认路径启动 probe。
  W3.G1 完成；W3.G2 隔离证明尚未运行。

## 动态计划修订证据（MCP dogfooding）

- 独立重跑：`xuanling-memory` contract 43/43、MCP protocol 101/101、golden 23/23；
  只确认局部行为 gate；C-15 incident 使 W3 总状态保持 `red_confirmed`，不能用这些通过项
  跳过 W3.G2。
- `CONFIRMED`：`stage_copy_over*` 在 staging copy 失败时把错误映射到 source；destination
  parent 缺失会给出误导路径。`make_unified_diff` 明确生成整文件删除/新增。
- `CONFIRMED`：当前 smoke/source catalog 为 41；已安装 0.1.0 binary、manifest 和 Skill
  为 39；Skill 的 omitted-output 语义与当前 source 合同冲突。
- raw probe：已安装 binary 接受 `output={"mode":"bounded","max_bytes":64}`，且
  `tools/list` 的 stdout schema 包含 `{file:{path}}` union。因此 live `-32602` 保持
  `UNVERIFIED_RISK`，必须在 W7/W8 比较 ZCode serialized request。
- 当前 debug binary raw initialize/list 已确认 contract version 2、41 tools，且
  `_meta.tool_count` 等于实际 list 长度。
- `docs/guides/xuanling-mcp-integration.md` 与 `docs/repository-boundary.md` 的 omitted-output
  默认 65,536 文案与 source/README/test 的 omission -> complete 不一致；W7 verifier 必须
  覆盖这些文档，不得只同步 Skill。
- 全 docs table audit 发现 architecture 的两条状态 union 被 raw pipe 拆列；当前 docs checker
  仍绿色。原 W0 未定义 table gate，历史状态不回退；W7.5 以此作为正确红基线。
- raw result 同时包含 JSON text `content` 与同义 `structuredContent`；`rmcp 3.1.2`
  的 `CallToolResult::structured` 明确产生该形态。raw duplication 为 `CONFIRMED`，
  模型上下文是否双计数仍为 `UNVERIFIED_RISK`；在 negotiated frame 与 host context/render
  对照前，禁止删除任一兼容字段。
- 计划新增 C-11..C-15、R-13..R-21 与 W7；原 packaging/final waves 顺延为 W8/W9。
  长任务支持明确转交异步 process-job 独立专项，不增加 shell fallback 或伪 timeout。
- **恢复点已回退**：从 W3.G2 证明 temp-DB 隔离，通过后才恢复 W3.5；W7 只有 W3-W6
  全部 `complete` 后才解锁。

### 本轮 gate 记录

| Command/Oracle | Observed at (+08:00) | Checkout fingerprint | Result |
| --- | --- | --- | --- |
| `cargo test -p xuanling-memory --test contract` | 2026-08-14T15:45:31+08:00 | revision `47f1cff…bc3f6a`, status `e42ad622…05793b` | 43 passed, 0 failed |
| `cargo test -p xuanling-mcp --test protocol --test golden` | 2026-08-14T15:45:53+08:00 | revision `47f1cff…bc3f6a`, diff `980168ae…1afb3` | protocol 101 + golden 23 passed |
| installed 0.1.0 raw bounded-output/stdout schema probe | 2026-08-14T15:21:54+08:00 | SHA `713c84f4…46ccd`; path recorded in plan §2.1 | object/schema behavior evidence retained；未记录 explicit temp DB，隔离维度 stale |
| debug raw `fs_copy` + `fs_edit_preview` reproduction | 2026-08-14T15:51:01+08:00 | debug SHA `7d230919…e4095a`; source hash `2a4699d8…293758` | 行为复现有效；省略 `--memory-db`，触碰真实 WAL/SHM，隔离维度 stale |
| real default DB W3.G1 read-only audit | 2026-08-14T15:51:42+08:00 | migration 3；v1=1；v2 canonical=0；integrity ok | incident confirmed；一次 transient lock 后读取成功；W3.G2 required |
| `npm --prefix npm run check:docs` | 2026-08-14T15:41:28+08:00 | status `e42ad622…05793b` | 14 markdown files checked |
| tracked `git diff --check` + no-index plan/ledger whitespace check | 2026-08-14T15:41:28+08:00 | diff `980168ae…1afb3` | no whitespace findings |
| dynamic-plan authoring gates | recorded 2026-08-14T16:10:48+08:00 | status/diff/untracked hashes unchanged | docs 14 OK；plan/ledger table 0 findings；full docs only two expected W7 red rows；placeholder 0；whitespace 0 |


### W3.5-W3.7 完成证据(2026-08-14T17:30+08:00)→ W3 complete

1. **W3.5 九工具面**:删除 `memory_put/update/delete/compact/context` 定义与 dispatch;
   新增 `memory_candidate_create/replace/archive/get/list`、`memory_review`、`memory_get`、
   `memory_search`、`memory_feedback`(v2 DTO 即 schema;候选工具 non-destructive+
   idempotent,review 唯一 destructive=true+idempotent=true(新预设 review_terminal),
   get/list/search readOnly,feedback idempotent)。dispatch 经 `run_memory_async`
   直序列化 memory 错误(code 原样保留,mem_error 16 臂全删)。namespace 缺省注入沿用
   ns_args 机制(feedback DTO 无 namespace 字段,用原始 arguments)。
2. **W3.6**:`_meta` 新增 `xuanling.memory_contract_version: "2"`(保留 contract_version=2)。
3. **v1 移除与 schema 收敛(W3.7)**:删 v1 store 三文件、compact/context、35 项 v1 测试、
   migrations 0001/0002;`0003_memory_v2_core.sql` 重命名为 `0001_memory_v2.sql`;
   `open()/open_in_memory()` 在 migrate 前检查 `sqlite_master` 含 `memory_records` →
   `unsupported`(no migration, no repair),拒绝测试用 temp 内构造的 v1 fixture
   (真实库从未打开)并断言零迁移;`default_db_path()` → `~/.xuanling/memory.db`,
   无 HOME/USERPROFILE 返回 None,main.rs 显式报错(不回退 cwd)。
4. **测试 v2 化**:agent_acceptance(a6 双进程 v2、a7/a8、4 个 context 测试 → 3 个
   v2 search 等价)、contract_hardening(unknown-field 走 create+review)、
   goldens(lifecycle/replace_flow/feedback v2;compact/context 删除;误删的 4 个非
   memory golden 已从 git HEAD 恢复)、annotations allowlist v2 化。
5. **Snapshot**:重生成;diff 恰为合同面:-5 旧 +6 新 = **42 tools**;smoke 同步为 42
   且去掉硬编码计数文案(C-12 方向)。
6. **Gate(全绿)**:3× concurrent_review_cas 连续通过;memory 9/9、toolkit 130/130、
   protocol 101/101、golden 21/21、边界 4/4、npm 11/11、check/docs OK、smoke 42、
   fmt ×3、clippy ×2、`git diff --check` clean;真实默认 DB 主文件+WAL hash
   前后不变(`62972a0a…`/`53f189d3…`)。


### W4 完成证据(2026-08-14T18:05+08:00)→ W4 complete

- **W4.1 active-only 双 FTS 投影查询**:search_v2 重写——`memory_fts_v2_unicode` +
  `memory_fts_v2_trigram` 各取 `MATCH ? ORDER BY rank LIMIT candidate_limit`
  (用户输入经 `fts_phrase` 双引号转义为字面短语,FTS 语法字符不生效),RRF(k=60)合并;
  候选再按 active heads + 当前 version + scope 集合过滤加载。
- **W4.2 短 CJK instr 回退**:1-2 字符查询走参数绑定 `instr(content/title/summary/tags)`
  扫描(reasons=instr_fallback),绕开 trigram ≥3 字符限制。
- **W4.3 exact/ancestor planner**:exact 单 scope;ancestors 走 workspace→project→global,
  sibling 永不进入(既有测试覆盖)。
- **W4.4 确定性排序与 reasons**:score→scope_distance→pinned→当前 revision feedback
  差值→record_id;reasons 标注来源索引。
- **W4.5 当前 revision feedback 聚合**:helpful/unhelpful 计数按 (record, 当前 revision)
  子查询聚合,参与排序。
- **W4.6 rebuild_projection**:单事务 DELETE 双 FTS + 从 active heads/current versions
  重插;canonical 表零改动(测试断言 counts 前后一致)。
- **nearest-scope 去重**:ancestors 模式下相同内容(namespace+content_sha256)保留
  最近 scope(测试:workspace+global 同内容 → 仅 workspace 命中,distance=0)。
- **测试(14/14)**:新增 one_and_two_character_cjk、historical_versions_not_searchable、
  nearest_scope_wins、unchanged_search_is_byte_identical、rebuild_projection 共 5 项
  + 既有 9 项;3× byte-identical 连续通过;protocol 101/101、golden 21/21
  (MCP search golden 走新 RRF 路径)、fmt ×3、clippy、真实库不变。
- **测量**:`rebuild_projection` 10,000 active records = **593ms**(in-memory DB,
  Apple Silicon debug build);打开第二个 store 句柄不触发重建(显式专用)。

### W5 完成证据(2026-08-14T18:40+08:00)→ W5 complete

- **W5.1 codec**:`src/jsonl.rs` format v1——header(`xuanling_memory_export`/format 1/
  schema 2/exported_at)+ 按稳定主键排序的实体行(record_version/record_head/proposal/
  review/feedback_event)+ trailer(counts+SHA-256,覆盖 header..最后实体行)。投影(FTS)永不
  导出;导出目标已存在 → typed `conflict` 零覆盖。
- **W5.2 原子 export**:单一致性读事务 → 同目录临时文件(0600,fsync)→ rename;CLI 测试
  断言 0600 权限位。
- **W5.3 全量校验 + 单事务 import**:格式/header/checksum/counts/引用/生命周期
  (terminal 必有 review、pending 必无 review、revision 1|2、dedupe_key 与 content_sha256
  重算核对、target version 存在)全部通过后才写;目标非空 → `conflict`;任何失败零部分写
  (truncated/checksum/CLI invalid import 三测试证明 target counts 全 0)。
- **W5.4 maintenance CLI**:main.rs `MemoryCommand`(export/import/rebuild-index)一次性
  完成并退出,stdout 单行 JSON summary、stderr 诊断、失败非零退出;
  `no_subcommand_remains_stdio_server` 红转绿:stdin 保持打开且无帧时子命令仍退出
  (负向对照:无子命令二进制 800ms 内不退出)。4 项 CLI 测试全部带 unique temp
  `--memory-db` + `assert_isolated_memory_db` 运行时校验,并纳入 C-15 源扫描名单。
- **W5.5 restart round-trip**:`restart_after_import_recalls_through_rebuilt_projection`
  (disk DB 关闭→重开,record_get 历史版本 + search_v2 经重建投影命中)+ CLI
  export→import→rebuild-index→重开验证链路。
- **修复暴露的缺陷**:① scope 序列化不对称——原 derive(Serialize) 输出 external-tag
  `{"project":{…}}`,与严格 Deserialize 要求的 tagged `{"type":…}` 冲突(JSONL round-trip
  失败即此);改为手动 Serialize 对称 tagged 形式,并给枚举加
  `serde(tag="type",rename_all="snake_case")` 使 schemars 描述同一 wire form。
  tools-list.json 重生成 diff 经结构化比对确认**仅 MemoryScope 子树变化**(工具名/
  annotations/42 计数不变)——MCP schema 从此与实际接受形态一致。
  ② 幂等重放视图:same key+same digest 但不同 proposal_id 的重放此前按请求 id 解析 →
  not_found;`check_proposal_idempotency` 现在返回原 proposal_id,重放返回现有 proposal 视图。
  ③ golden 23→21:W3.7 将 v1 memory goldens 改写为 v2 三流程(lifecycle/replace/feedback),
  净合并 2 项,非意外丢失(21=18 非 memory+3 v2)。
- **gate(全绿)**:memory contract 21+1ignored ×3;protocol 105(101+4 CLI);golden 21;
  toolkit 130;边界 4;npm check/check:docs 14/test 11;smoke 42;`cargo test --workspace`
  全绿;`cargo check --workspace --all-targets`;fmt ×3/clippy 0 warning;
  `git diff --check` clean。
- **C-15**:本 Wave 全部 spawn(protocol/golden/CLI/smoke)用 unique temp `--memory-db`;
  真实默认 DB 三文件 hash 前后不变:`62972a0a…`(db)/`53f189d3…`(wal)/`5c202072…`(shm)。

### W6 完成证据(2026-08-14T19:10+08:00)→ W6 complete

- **W6.1 feature 隔离**:`experimental-embeddings`(非默认)门控 `embedder` 模块与
  re-export;default = []。embedding rows 与 hybrid search 在 v2 schema/存储中不存在
  (W3.7 已随 v1 删除),W6.2「适配 versioned records」判定 **N/A**(证据:0001_memory_v2.sql
  无 embedding 表;store/v2.rs 无 hybrid 路径)。W6.3「删 compact/context」在 W3.7 已
  完成(grep 无残留,仅注释性词语)。
- **W6.4 文档**:ADR 第 9 条扩展——feature 只暴露 trait + 测试双替身,无真实 adapter,
  不提供模型安装流程;architecture 新增「Semantic(experimental)」节声明同样边界。
- **CLI 形状修正**:计划 §6.1 规定 `xuanling-mcp memory <subcommand>`,原实现是根级
  子命令——加入 `CliCommand::Memory { command }` 嵌套组,CLI 测试改用 `memory` 前缀。
- **红测试(4 项新增 + 1 catalog)**:`default_build_has_no_model_runtime_or_downloader`
  (cargo tree 禁用清单:fastembed/tokenizers/candle/ort/hf-hub/reqwest/hyper/ureq/openai/
  burn…)、`experimental_feature_tree_stays_within_the_same_dependency_island`、
  `default_source_has_no_network_or_model_cache_paths`(源码路径扫描 12 标记全零)、
  `default_catalog_has_no_semantic_tool`(tools/list 无 semantic/embed/hybrid/vector);
  feature 门控:`fake_embedder_is_deterministic_and_discriminates`、
  `fake_embedder_config_digest_is_stable_per_configuration`、
  `experimental_failure_preserves_lexical_results`(Noop typed unsupported 后检索
  byte-identical)。
- **gate(全绿)**:default memory 24(1 ignored)、feature memory 27(1 ignored)、
  protocol 106、golden 21、clippy 0 warning(default+feature)、fmt、
  check:docs 14、`git diff --check`。
- **C-15**:真实默认 DB 三文件 hash 不变(`62972a0a…`/`53f189d3…`/`5c202072…`)。

### W7 完成证据(2026-08-14T19:50+08:00)→ W7 complete

- **W7.1 dogfood fixture**:debug binary `target/debug/xuanling-mcp`(SHA `bb25c54b…`,
  0.1.0 构建期)、installed binary `/Users/ikaros/.local/share/zcode-plugins/xuanling-local/
  plugins/xuanling-mcp/bin/node_modules/xuanling-mcp-darwin-arm64/bin/xuanling-mcp`
  (SHA `713c84f4…`,0.1.0)、plugin.json(SHA `21add4ab…`,39 tools 文案)、Skill
  (SHA `a276d86f…`,39 tools + v1 memory 工具 + 65,536 默认)——全部落账,不按进程名推断。
- **W7.2 path-role(C-11)红转绿**:`copy_missing_destination_parent_reports_destination_role`
  红基线正确(not_found path 错指 source、details=Null);实现 `copy_io_error`:
  direct 分支 NotFound→`path_role=destination`;staging/dir-recursive/exdev 分支
  NotFound→`source`(父目录已证明存在);其余 kind→`ambiguous` 携带双 operand。
  五个调用点替换,零目标写入由测试断言。
- **W7.3 局部 hunk(C-11)红转绿**:`single_line_edit_emits_replayable_local_hunk` 红基线
  (202 行整文件 delete+add);实现 Myers O(ND) diff + `DIFF_CONTEXT_LINES=3` 分组/合并、
  hunk body 重建;200 行单行替换产出 1 hunk×7 行,且经 `fs_patch` 重放得到逐字节正确
  结果(hunks_applied=1)。toolkit 132/132 全绿。
- **W7.4 verifier**:`npm/scripts/verify-mcp-contract.mjs`(6 checks:contract_version=2、
  memory_contract_version=2、`xuanling.tool_count`==derived list、required 38 名全在、
  forbidden v1/semantic 名全无、process_run stdout union string+{file:{path}});
  首个失败即非零退出。smoke 去硬编码 42,改为 derived count + `_meta` 一致性。
- **W7.5 表格扫描器**:check-docs 增加 fence-aware 表格解析(unescaped-pipe 列数一致、
  delimiter 校验);红基线正确命中 architecture 两条已知破表行,`active \| archived` /
  `pending \| approved \| rejected` 转义后转绿;注入破表红测→删除→恢复绿。
- **W7.6-W7.7 raw 事实冻结与责任定位**(`npm/scripts/raw-mcp-probe.mjs`,全部显式 temp
  --memory-db):
  - debug:contract 2/memory 2/42 tools/bounded object **ok**/stdout union **ok**/
    duplication content+structured **同义文本**。
  - installed:contract 1/39 tools/bounded object **ok**/stdout union **ok**/
    duplication 同义。
  - **定位**:ZCode `-32602` 在 raw 层不成立——两个 binary 都接受 tagged object,失败
    层在 host 序列化(live transcript 取证移入 W8/W9 required gate);stdout union 两
    binary 均完整;raw 双字段同义为 CONFIRMED,模型上下文是否双计数仍 UNKNOWN——
    禁止删除任一字段,等待 host 对照。
- **W7.8 正向不变量**:byte-identical search ×4、replace 1、remove 5、deterministic 3
  定向合同全绿;direct argv/no-shell 无变化。
- **W7.9 Skill/docs**:docs/repository-boundary.md 与 integration guide 的 omitted-output
  由「65 536 默认」修正为「省略即 complete」;新 Skill 源 `docs/skills/
  xuanling-mcp-tools-SKILL.md`(candidate/review、omitted→complete、direct argv、
  sort -u/process_pipeline/fs_search 示例、长任务不承诺跨 host deadline、不写死总数)。
- **gate(全绿)**:toolkit 132、memory 24/27、protocol 106、golden 21、clippy 0、
  boundary 4、npm check/check:docs 15/test 11、verifier 6/6、smoke 42、diff-check。
- **C-15**:本 Wave 全部 spawn 显式 temp DB;真实默认 DB 三文件 hash 不变。

### W8 进行中(2026-08-14T20:00+08:00)→ 非破坏部分完成,切换步骤 BLOCKED

- **W8.1 版本 0.2.0**:workspace Cargo.toml、npm/package.json、npm package、
  README ×2(历史首次发布 0.1.0 注记保留);`npm run check` 通过 0.2.0。
- **W8.2 CI**:portability/npm 两个 workflow paths 加入 `crates/xuanling-memory/**`;
  gate 增加 memory fmt/check/clippy/test(default+experimental)与三 crate 依赖岛
  guard;release smoke 增加显式 temp `--memory-db`(C-15 化)。
- **W8.3 publish guard**:validate-release 新增 canonical repository 检查
  (repository.url 必须为 `git+https://github.com/umbrella22/xuanling.git` 且
  GITHUB_REPOSITORY 为 `umbrella22/xuanling`,否则拒绝发布)。
- **W8.4-W8.6 marketplace**:`integrations/zcode-plugin/`(plugin.json 0.2.0 inline
  native mcpServers、.mcp.json compatibility mirror、Skill、README、
  `scripts/sync-binary.mjs` 由脚本自身位置推导 repo、不写 cache)。
- **W8.8 Skill 合同**:`npm/test/zcode-plugin-contract.test.mjs` 5 项——plugin/npm/cargo
  版本一致、mirror 一致、Skill 无 legacy 工具名、无硬编码总数、omitted→complete/
  no-shell/idempotency_key 语义;npm test 16/16。
- **W8.7/W8.9 release staging**:`cargo build --release` 0.2.0;ad-hoc codesign
  (`--force --sign -`)+ `codesign --verify --strict` 通过;release binary
  SHA `16017fba…`;W7 verifier 6/6、raw probe(contract 2/42 tools/bounded ok/
  union ok/duplication 同义)、smoke 42 全绿,全部显式 temp DB。
- **W8.10 hybrid DB preflight(只读,2026-08-14T20:00)**:
  - migrations {1 memory,2 fts update triggers,3 memory v2 core} 全 success;
    migration 3 installed_on=2026-08-14 07:02:54。
  - v1 `memory_records`=1;v2 canonical(versions/heads/proposals/reviews/feedback)=0。
  - `PRAGMA integrity_check`=ok;未读取或展示任何 payload。
  - 文件 identity:`toolkit-memory.db` 241664B mtime 15:46:13 sha `62972a0a…`;
    `-wal` 1961152B mtime 16:36:53 sha `53f189d3…`;`-shm` 32768B mtime 18:27:19
    sha `5c202072…`;`toolkit-memory.db.stale-20260813.bak` 110592B sha `86d909e2…`
    (**保持不动**)。
  - holder:本快照 `lsof` 无 holder;两个 0.1.0 ZCode 进程(PID 36951/37977)运行中。
- **待授权(W8.11)**:删除目标仅限三个精确路径
  `/Users/ikaros/.xuanling/toolkit-memory.db`、`-wal`、`-shm`,不建备份、不删
  `.bak`、不删新 v2 DB;授权后按计划顺序:marketplace 原子替换→ZCode 刷新→旧 PID
  TERM→lsof 复核→三文件删除→live ZCode 验收。

### W8 切换前验收(2026-08-15T00:05-00:20+08:00)→ 全部通过

按用户指示先完成验收、验收后再授权删除。对照 W8 entry gate 与 W8.11 第 1 步:

- **npm release staging 链(本地,未 publish)**:stage-main → generate-third-party-licenses
  (173 notices)→ stage-platform(darwin-arm64,release binary)→ verify-package(main
  `xuanling-mcp@0.2.0` + platform `0.2.0-darwin-arm64` 均 OK)→ pack-package
  (`xuanling-mcp-0.2.0.tgz` + `0.2.0-darwin-arm64.tgz`)→ install-local-tarballs(offline
  安装)→ **launcher smoke 42 tools OK**(temp DB)。
- **plugin staging**:`integrations/zcode-plugin/scripts/sync-binary.mjs` 由自身路径解析
  repo,从 npm/dist/darwin-arm64/install-final 拷贝;plugin binary `--version` 0.2.0、
  `codesign --verify --strict` 通过、verify-mcp-contract 6/6、raw probe 与 debug/release
  完全一致(contract 2/memory 2/42 tools/bounded ok/union ok/duplication 同义)。
- **签名链说明**:artifact 实为 linker-signed adhoc(arm64 默认);此前一次手动
  `codesign --force` 后观察到的 SHA `16017fba…` 为瞬态(该卷随后呈现回 linker-signed
  内容,mtime 仍为构建时刻);当前链条自洽:target/release == npm 包内 binary ==
  plugin binary,SHA 均为 `81349591…`,strict 验证通过。记录以 `81349591…` 为准。
- **memory 生命周期验收**(`npm/scripts/verify-memory-workflow.mjs`,显式 temp DB):
  candidate_create pending → 审批前不可检索 → review approve → get rev1 → search 命中 →
  feedback(revision-bound)→ replace CAS → approve → rev2 → archive CAS → approve →
  归档后不可检索、历史仍可取——**9/9 步通过**,plugin binary 与 target/release 各跑一遍。
- **CLI 维护面(release binary)**:`memory export/import/rebuild-index` 单行 JSON summary
  正常退出,stdin 保持打开不挂起。
- **C-15**:以上全部 probe 用 unique temp `--memory-db`。

### 默认 DB 身份变化事件与最新 preflight(2026-08-15T00:10+08:00)

- **事件**:旧 0.1.0 进程退出(进程 2→1,PID 36951/37977 → 新 PID 1228)触发 SQLite
  正常 checkpoint:WAL 并入主文件后 `-wal`/`-shm` 被删除。主文件 mtime
  2026-08-15T00:10:15、size 241664B、SHA 由 `62972a0a…` → **`932fc4c2…`**。
  非本仓测试触碰(全部显式 temp DB);当前 `lsof` 无 holder。
- **副本核验(对原文件零触碰)**:migrations {1,2,3} 全 success;counts 不变
  (v1=1,v2 canonical 全 0);`integrity_check`=ok;副本 hash 与主文件一致
  (`932fc4c2…`)——逻辑内容与首次 preflight 完全相同,仅 checkpoint 形态变化。
- **`.stale-20260813.bak`** 不变(`86d909e2…`,110592B)。
- **删除范围现状**:`toolkit-memory.db` 存在(`932fc4c2…`);`-wal`/`-shm` 当前不存在
  (任何 0.1.0 memory 调用都可能重建)。按计划第 7 步,授权须针对本最新报告:
  删除目标仍为三个精确路径(两个 sidecar 以 missing-ok 语义处理),不建备份、
  不删 `.bak`、不删新 v2 DB。

### W8.11 本机切换执行证据(2026-08-15T00:20-00:35+08:00)

用户确认授权(针对最新报告:主文件 SHA `932fc4c2…` 241664B,-wal/-shm 当时不存在)。

1. **marketplace 原子替换**:repo `integrations/zcode-plugin/` 重构为完整 marketplace
   (`marketplace.json` 0.2.0 + `plugins/xuanling-mcp/**`;合同测试 5/5 含 marketplace
   版本一致性)。staging 目录先行验证(marketplace 0.2.0、binary 0.2.0、strict
   codesign、SHA `81349591…`)→ 同级 mv 换入 `/Users/ikaros/.local/share/
   zcode-plugins/xuanling-local` → 旧目录即时移除;未触碰 `~/.zcode/cli/plugins/cache`。
2. **TERM 旧进程**:PID 1228(唯一 0.1.0)两次 SIGTERM 后正常退出(未用 SIGKILL);
   `pgrep` 无残留,`lsof` 三个旧路径无 holder。
3. **删除(身份复核通过)**:主文件 SHA/mtime/size 与授权报告逐项一致,-wal/-shm
   仍不存在;`rm -f` 三个显式路径(无 glob、无递归、无备份)。删除后三路径确认
   不存在;`.stale-20260813.bak` 完好(`86d909e2…`);hybrid 库(v1 row=1)随删除
   终结。
4. **新默认库**:`memory export`(无 --memory-db)以 0.2.0 binary 创建
   `~/.xuanling/memory.db`——单一 migration `memory v2`、20 个 v2 对象、空导出 OK。
5. **残留观察**:harness 在 cache 仍为 0.1.0 时重连,respawn 了 0.1.0 server
   (PID 6733),其在启动时把旧路径重建为**全新空 v1 库**(4096B,migrations 仅
   {1,2},零用户数据,带空 -wal/-shm)。该对象不在已授权删除身份之内,保留待
   用户刷新插件后处置。
6. **live 0.2.0 验收(步骤 9-11)待外部动作**:需用户在 ZCode UI 刷新/重启插件
   使 cache 同步 marketplace 0.2.0;随后验证实际进程 0.2.0、经 ZCode 跑完整
   memory 工作流与 tagged-object 直呼、抓取 serialized request 对照。
7. **repo 终态回归**:npm check 0.2.0、check:docs 15、npm test 16/16、
   `git diff --check` clean。

### W8.11 live 验收与收口(2026-08-15T00:50-01:10+08:00)

- **0.2.0 上线**:用户 UI Update + ZCode 全量重启后,installed_plugins.json=0.2.0,
  live 进程自 `cache/.../0.2.0` 拉起(PID 25881/25966),新默认库
  `~/.xuanling/memory.db` 激活;旧 0.1.0 进程两次 TERM 后退出,未用 SIGKILL。
- **空 v1 库清理(用户授权"如果有空v1库就删了")**:副本核验 0 records、仅
  migrations {1,2}(118784B 为 FTS 空表页分配,零行)后,lsof 无 holder,删除
  `toolkit-memory.db{,-wal,-shm}`;`.stale-20260813.bak` 保持(`86d909e2…`)。
  删除后无进程重建旧路径(0.2.0 不再触碰它)。
- **live tagged-object 验收(责任终局)**:
  - 纯原始类型参数经 ZCode 正常(如 fs_read_text path+line range);
  - **object 参数经 ZCode 全部失败**:`output={"mode":"bounded",...}` →
    "invalid request arguments: `output` must be an object";
    `scope={"type":"global"}` → "scope must be a tagged object";
    `payload={...}` → "invalid type: string \"{...}\", expected struct
    MemoryPayload"——host 把 object 型参数序列化为字符串。同一 0.2.0 binary 的
    raw MCP 同参数 9/9 通过(verify-memory-workflow,两次)。**结论:`-32602`
    家族根因 = ZCode host 工具调用参数序列化,server 在 raw/contract 层全部无辜。**
  - **双字段上下文注入观察**:工具结果同时渲染 JSON `content` 文本与
    "Structured content:" 同义副本,两者均进入模型上下文(host 侧);server raw 帧
    形态与 W7 冻结一致。按计划 W8 exit:两项均指向不可修改的外部 host → 记录为
    外部 blocker,不做任何 server 侧兼容性弱化(禁止收窄 tagged union)。
- 经 ZCode 的完整 memory 工作流因 host 参数缺陷无法执行(host 侧修复后可用
  `npm/scripts/verify-memory-workflow.mjs` 同一序列重验);server 侧同工作流已在
  0.2.0 binary 以 raw 层 9/9 验证两遍。

### W9 最终回归(2026-08-15T01:30-01:55+08:00)→ deterministic_green

- **W9.1/W9.2 全量 gate(fmt/check/clippy×3 crate、toolkit 132、memory 24+1/
  feature 27+1、protocol 106、golden 21、workspace 11 ok、npm check 0.2.0、
  npm test 16、check:docs 15、--locked release build、smoke 42、verifier 6/6、
  diff-check)全绿**。
- **W9.4 三连**:concurrent_review_cas + restart_after_import + round_trip +
  rebuild_projection 连续 3 次通过。
- **W9.5 live**:进程 0.2.0 ✓、新默认库激活 ✓、原始参数直呼 ✓;object 参数与
  双字段注入为 host 外部 blocker(见 W8.11)。
- **W9.6 扫描与守卫强化**:legacy 工具名/v1 路径/CodeGraph/LSP/downloader 生产面
  扫描仅命中 verifier 禁用清单与 C-15 守卫自身(allowlist)。发现并修复 C-15 守卫
  缺口:运行时拒绝名单现在同时保护旧 `toolkit-memory.db` 与新默认 `memory.db`
  (contract_hardening/agent_acceptance/cli_maintenance 三处 + 运行时负向断言双路径)。
- **R-21/C-15 终证**:整轮 W9 回归(含强化守卫后的 protocol 重跑)前后,新默认
  v2 DB 三文件字节不变(`d6aa99c2…`/`9ad902ec…`/`fbfcaed5…`);自动化零触碰。
- **未运行(外部依赖)**:`git remote -v` 为空 → 三平台 CI 无法执行,按 W9 停止
  条件状态上限 deterministic_green 并 BLOCKED,不以本机结果外推。

### C-16 ZCode 兼容垫片(动态修订,2026-08-15T02:00-02:40+08:00)

用户授权实现方案 B("只做给 ZCode"):live 证据链为——`env`(inline object schema)经
ZCode 正常、`output`/`scope`/`payload`(全部 `$ref → $defs`)被字符串化,raw 层同
binary 同对象 9/9 通过 → host 参数矫正不解析 `$ref`。

- **合同 C-16**:`--compat-lenient-object-params`(默认 OFF)下,仅当顶层参数的
  schema(经 `$ref` 解析)为 object 或含 object 的 union,且值是可解析为 JSON object
  的字符串时,矫正为对象后再 dispatch;字符串型参数永不矫正;默认路径保持 strict
  schema 合同(C-12 不变);模式经 initialize `_meta`
  `xuanling.compat.lenient_object_params` 公开。
- **实现**:`crates/xuanling-mcp/src/compat.rs`(catalog 序列化 schema 静态建表:
  每 tool 的 object 型顶层参数;`$ref` 本地解析 + 深度防环 + oneOf/anyOf/allOf +
  additionalProperties 判定);server `call_tool` 在 dispatch 前矫正;main.rs CLI
  flag;_meta 透传。
- **测试(3 项,protocol 套件 109)**:lenient 矫正(bounded output 字符串化成功
  truncated=true + stringified scope/payload 走完 create→review→search);strict 默认
  仍 -32602;字符串型参数不误伤(形似 JSON 的 literal pattern 命中 1)。新文件纳入
  C-15 源扫描名单 + 自带双默认路径运行时守卫。
- **版本 0.2.1**(workspace/npm/plugin/marketplace/README 同步);ZCode 插件
  manifest(plugin.json inline + .mcp.json mirror)追加 `--compat-lenient-object-params`
  ——**仅 ZCode 部署启用**;npm 层只文档化不启用;合同测试断言两 launcher 同带标志。
- **文档**:architecture CLI 选项节 + integration guide「ZCode compatibility shim」节。
- **staging**:release --locked 重建 + strict codesign + smoke 42 + verifier 6/6 +
  workflow 9/9(release 与 plugin binary 各一遍);npm 链(verify-package 0.2.1、
  pack、install-final、launcher smoke);marketplace 原子替换至 0.2.1(staging 校验
  版本+标志后换入)。
- **gate**:clippy 0、fmt、toolkit 132、memory 24+1、protocol 109、golden 21、
  npm check 0.2.1、npm test 16、check:docs 15、diff-check。
- **待办**:用户在 ZCode Update 到 0.2.1 → live 验证经 ZCode 的 memory 工作流
  (host 仍发字符串,server 矫正后应全通)→ C16 转绿。

### C-16 live 验收(2026-08-15T02:50-03:05+08:00)→ C-16 complete

用户 Update 至 0.2.1 + ZCode 全量重启后,live 进程
`cache/.../0.2.1/...xuanling-mcp --workspace-root … --compat-lenient-object-params`
(PID 1545)。经 ZCode(host 仍把 object 参数字符串化,server 垫片矫正)逐项验证:

1. memory_candidate_create(stringified scope+payload)→ pending ✓
2. memory_search 审批前 items=[] ✓(候选不可见)
3. memory_review approve → approved,revision 1→2 ✓
4. memory_search 命中(reasons=[fts_unicode61, fts_trigram],score/scope_distance)✓
5. memory_feedback helpful(revision-bound;历史视图中 helpful_count=1)✓
6. memory_candidate_replace CAS(target rev1)→ review approve → rev2 ✓
7. memory_get rev2 = 替换后内容 ✓
8. memory_candidate_archive CAS(rev2)→ review approve ✓
9. 归档后 memory_search items=[] ✓
10. memory_get rev1 历史仍可取(status=archived,helpful_count=1)✓
11. **原始 `-32602` oracle**:fs_read_text + `output={"mode":"bounded","max_bytes":64}`
    → returned_bytes=64、truncated=true、preimage-bound next_resume ✓

写入发生在真实默认库 `~/.xuanling/memory.db`(namespace=zcode-live-acceptance,
计划允许的 live 路径)。C-16 全链闭环:live 证据(host 缺陷)→ 合同 → 红绿测试 →
0.2.1 staging → marketplace → live 全绿。host 修复其参数序列化后,移除插件 manifest
中的 `--compat-lenient-object-params` 并回归 strict 默认即可。

## 事件日志

- 2026-08-14T14:16 指纹核验;计划写入 PLAN_PATH;初始账本。
- 2026-08-14T14:45 W0 complete(红基线、99 删除、9 新文档、checker、全 gate)。
- 2026-08-14T15:00 W1 complete(边界红测试正确红;35 基线)。
- 2026-08-14T15:35 W2 complete(抽离、parity 35/35、snapshot 等价、边界 4/4 绿)。
- 2026-08-14T16:30 W3.1-W3.4 store 层完成(memory 43/43、protocol 101、golden 23)。
- 计划动态修订:C-11..C-15、W7 dogfooding、真实 DB 隔离;C-15 incident 使 W3 回
  red_confirmed。
- 2026-08-14T16:50 **W3.G2 complete**:基线冻结→二分定位四个未防护生成点
  (tool_call/handshake/schema_snapshot/framing + contract_hardening Peer 裸启,亦即
  原始 migration-3 写入者)→全部 temp-DB 化 + 运行时校验 + 源扫描 guard→受控窗口
  证明真实库主文件与 WAL 字节不变→全套 gate 绿(protocol 102/golden 23/memory 43/
  toolkit 130/边界 4/npm 11/docs 14/diff-check)。
  C-15 harness 级转绿;恢复点 **W3.5**(MCP 九工具面,按 W3 剩余清单 2-7 执行)。

```text
EXECUTION_STATUS: BLOCKED
PLAN_ID: memory-v2-extraction-20260814
CHECKOUT_FINGERPRINT: revision=47f1cff156896cd3006258b6e4519a4bb2bc3f6a
  status(excl plan.md)=2aedd2bb733a826f911103f7a4545352f2d8608f2dff16ad0ccef42391bc1efc
CURRENT_WAVE: C16
CURRENT_WORK_PACKAGE: C16.5
WAVE_STATE: complete
CONTRACTS_PROVEN: C-01..C-15 中 C-01/C-02/C-03/C-04/C-05/C-06/C-07/C-08/C-10/C-11/
  C-12/C-13/C-14/C-15 的 source/debug/staged 层证据全部落账;C-09(0.2.0 本机使用)与
  live ZCode 层(W8.11/W9)待授权后验收
EVIDENCE_ADDED: 本文件 W3.G2、W4、W5、W6、W7 完成证据与 W8 非破坏部分 + hybrid DB
  preflight 报告
FAILED_GATES: 无(全部已运行 gate 绿)
NOT_RUN_GATES: W8.11 本机切换与 live ZCode transcript、W9 三平台 CI 实跑与最终回归
BLOCKERS:
  - 外部:仓库无 git remote,三平台 CI 无法运行(W9 停止条件)
  - 外部 host:ZCode 工具调用把 object 型参数序列化为字符串(scope/payload/
    output 全部失败;raw 层同参数通过)——memory 工作流与 bounded-output 经
    ZCode 不可用,待 host 修复
  - 外部 host:工具结果 content+structuredContent 双份注入模型上下文
NEXT_EXACT_ACTION: 计划与 C-16 全部收口。剩余外部项:(1) git remote + 三平台
  CI;(2) 向 ZCode 反馈 host 参数序列化(修复后移除插件 manifest 的
  --compat-lenient-object-params 回归 strict)与双字段上下文注入;(3) 用户决定
  是否 commit 工作树
LEDGER_PATH: docs/plans/memory-v2-extraction-execution-ledger.md
```
- 2026-08-14T17:30 **W3 complete**(W3.G2 隔离 + W3.1-W3.4 store + W3.5-W3.7 工具面
  与收敛):C-03/C-04/C-08/C-15 落账;恢复点 **W4.1**(search_v2 切换 RRF 双 FTS)。
- 2026-08-14T18:05 **W4 complete**(C-04/C-05 store 级):RRF 双 FTS、短 CJK 回退、
  稳定输出、投影重建;恢复点 **W5.1**(JSONL codec)。
- 2026-08-14T18:40 **W5 complete**(C-06):JSONL v1 codec/原子 export/单事务 import/
  CLI 子命令/restart round-trip;修复 scope 序列化对称与幂等重放视图;protocol 105、
  golden 21、真实库不变;恢复点 **W6.1**(experimental-embeddings feature 隔离)。
- 2026-08-14T19:10 **W6 complete**(C-07):experimental-embeddings 非默认门控、
  默认无模型/无网络/无 semantic 面、memory CLI 父组修正;恢复点 **W7.1**。
- 2026-08-14T19:50 **W7 complete**(C-11/C-12/C-13/C-14/C-15):fs_copy path-role、
  Myers 局部 hunk、contract verifier、docs 表格扫描、raw 双 binary 责任定位、
  Skill 新源;恢复点 **W8.1**(0.2.0 bump)。
- 2026-08-14T20:00 **W8 非破坏部分完成**:0.2.0 bump、CI memory+C-15 smoke、
  publish canonical guard、integrations/zcode-plugin marketplace、release
  codesign+staged verifier、hybrid DB preflight 报告;W8.11 停在删除授权边界,
  **EXECUTION_STATUS: BLOCKED**。
- 2026-08-15T00:35 **W8.11 切换执行**:marketplace 原子替换 0.2.0、旧进程 TERM、
  三个授权路径删除(身份复核一致)、新默认库 v2 创建验证;cache 窗口期 respawn 的
  0.1.0 重建了空 v1 旧路径文件(零数据,待处置);live 0.2.0 验收待用户刷新插件。
- 2026-08-15T03:05 **C-16 complete**:0.2.1+兼容垫片 live 全绿(memory 工作流
  10/10 + bounded-output oracle 直呼通过);垫片为 ZCode 专属部署开关,host 修复后
  可移除。
- 2026-08-15T02:40 **C-16 动态修订**:ZCode 兼容垫片实现+测试+0.2.1 staging+
  marketplace 替换;等待 Update 后 live 验证。
- 2026-08-15T01:55 **W8 live 收口 + W9 deterministic_green**:0.2.0 上线、空 v1
  清理、live 验收完成(object 参数失败 CONFIRMED 为 ZCode host 序列化缺陷,
  server raw 层 9/9 无辜;双字段上下文注入为 host 行为);W9 全量回归绿、
  C-15 守卫强化至双默认路径、新默认库全程字节不变;外部 BLOCKED:无 remote
  (CI)、host 参数序列化、host 双字段注入。
- 2026-08-15T00:20 **W8 切换前验收全绿**:npm staging 链(0.2.0 tarball+launcher
  smoke 42)、plugin staging(strict codesign+verifier 6/6+raw probe 一致)、
  memory 生命周期 9/9(plugin 与 release 双 binary)、CLI 维护面;期间旧 0.1.0
  进程退出触发默认库 checkpoint(SHA 62972a0a…→932fc4c2…,-wal/-shm 移除),
  副本核验 counts/integrity 不变;等待针对最新身份的删除授权。
