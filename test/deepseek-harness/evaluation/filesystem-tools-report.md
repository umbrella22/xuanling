# DeepSeek Harness 文件工具 W5/W6 证据报告

> 证据状态：W5 已通过严格 analyzer 与独立文件 oracle，W6 已通过隔离 Web 候选验收；本报告只形成候选组合，不改变任何默认 bundle。
> 原始证据根：`/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725`。
> 验证器：`test/deepseek-harness/evaluation/scripts/verify-report.mjs`。

## 范围

评估在 XuanLing `47f1cff156896cd3006258b6e4519a4bb2bc3f6a` 和 DeepSeek Harness
`47f943859bef60e4160492346772ded9b24f765a` 上执行。三臂共享冻结 fixture、prompt、
`deepseek-official/deepseek-v4-pro/max` 路由、`workspace-write` 权限、隔离 session、隔离
Memory DB、同一个按需文件工作流 Skill，且 shell、subagent、workflow 与其他旁路工具均未暴露。

| Arm | 文件工具目录 | 质量 trial | Cache pair |
| --- | --- | ---: | ---: |
| A | 仅 DSH 原生文件工具 | 3 | 1 cold/warm |
| B | 仅 XuanLing `fs` profile，原生文件工具关闭 | 3 | 1 cold/warm |
| C | 原生与 XuanLing `fs` 同时暴露 | 3 | 1 cold/warm |

## 验收结果

每个 arm 的三次 quality trial 都由 runner 完整采集，全部通过冻结文件 oracle。批量 oracle
随后独立重判 quality workspace 和六个 cache workspace snapshot，结果为 15/15 passed。所有
会话都解析到一个 `turn/end`，固定路由无漂移，provider usage 完整，且没有 shell、拒绝工具、
未知工具或工具解析错误。

| Arm | 完整/通过/路由/usage | XuanLing fs calls | Native fs calls | 平均时长(ms, 5 sessions) |
| --- | --- | ---: | ---: | ---: |
| A | 5/5 / 5/5 / 5/5 / 5/5 | 0 | 84 | 73,265.6 |
| B | 5/5 / 5/5 / 5/5 / 5/5 | 101 | 0 | 148,290.6 |
| C | 5/5 / 5/5 / 5/5 / 5/5 | 1 | 76 | 64,805.8 |

B 在没有 Native fallback 的条件下完成全部五次文件任务，证明 fs16 可独立工作。C 的 77 次
文件调用中只有 1 次走 XuanLing，说明同一任务中同时暴露两族工具不会自动带来 XuanLing
文件原语的实际使用。

## Usage 与 Cache

下表使用每 arm 的全部五个 session，包含三次 quality 和一个 cold/warm pair。`inputTokens`、
`outputTokens` 与 `cacheReadTokens` 直接取 provider usage 字段；它们不是定价或跨任务性能结论。

| Arm | 平均 inputTokens | 平均 outputTokens | 平均 cacheReadTokens | 全局 fs call 分布 |
| --- | ---: | ---: | ---: | --- |
| A | 7,197.2 | 5,167.8 | 64,076.8 | native 84, XuanLing 0 |
| B | 11,767.6 | 10,439.8 | 149,555.2 | native 0, XuanLing 101 |
| C | 11,625.0 | 4,803.6 | 118,246.4 | native 76, XuanLing 1 |

全部 15 个 session 的 `cache_read_share` 为 0.9156。每个 cold/warm pair 的 provider-facing
prefix SHA-256 相同，且 warm 的 `inputTokens` 均低于 cold：A 为 8,352 到 3,318，B 为
13,600 到 5,802，C 为 14,062 到 3,397。每 arm 只有一个 pair，这只能证明本次 pair 的
前缀与 usage 观察，不能推导稳定命中率、价格或性能因果关系。

## 候选组合

已验证的候选是保留 DSH 原生文件工具，并按现有 `xuanling-memory` bundle 提供 XuanLing
Memory v2；`xuanling-file-workflow` Skill 作为按需工作流说明挂载。该组合保留原生工具的
观察闸门、workspace sandbox、审批和 Web 卡片集成，同时以较小的 XuanLing 工具目录提供
跨会话 Memory。

XuanLing fs16 保留为 opt-in profile：需要 SHA-256 preimage、严格 patch、显式 byte budget/
续读或完整分页时，B 的结果证明它可以独立完成任务。C 不作为默认候选，因为这组证据中模型
几乎总是选择 Native 工具，未显示混合目录带来已使用的独有收益。

这不是生产切换或一般性排名。W6 Web 已验证候选组合中的 Skill、文件编辑、Memory
proposal-only 首回合、显式 review 第二回合，以及真实 UI 中的工具呈现；该证据不自动把
候选应用到生产默认 bundle。

## W6 Web 候选验收

隔离 Web 服务运行于 `http://127.0.0.1:57960`，使用独立 `DSH_HOME`、fixture workspace
和 Memory DB。服务进程工作目录与 XuanLing capability root 都指向
`web/workspace`。首次 UI 注册错误地保留了仓库根 workspace；验收在发送模型请求前通过
Host `workspace.create` API 注册并选择隔离目录，并以 `session.list.cwd` 再次核对，未让
文件工具触碰 XuanLing checkout。

- 文件 session `session-0868a696-620c-4d9e-b62d-911b044f9a7c`：模型加载
  `xuanling-file-workflow`，明确选择 DSH Native 文件工具；原始 transcript 只有
  `read`、`edit`、`write`、`glob`、Skill 和 todo 控制调用，没有 shell、terminal、
  subagent、workflow 或 XuanLing fs 调用。独立
  `verify-filesystem-fixture.mjs --workspace` 返回 `pass=true`，UI 显示原生 Read/Edit/
  Write/Glob 行与可点击产物。
- Memory session `session-096385fd-fbb4-4d26-9183-ad64c4504972`：第一回合加载
  `xuanling-memory-workflow`，先搜索两次，再创建 proposal
  `proc-dsh-eval-fixture-oracle-before-self-report-0001`。回合结束时 SQLite 为
  proposal `pending/revision 1`，review/head/version 均为 0。第二个明确用户回合只调用
  一次 `memory_review(approve, expected revision 1)`；之后 proposal 为
  `approved/revision 2`，review、active head、immutable version、Unicode FTS 与 trigram
  FTS 各一行，record revision 为 1。UI 的 MCP 行以 `Tool call
  mcp__xuanling__...` 命名，展开后分别显示结构化 IN/OUT，与 Native 文件行可区分。
- 审批后的第一条多关键词查询 `fixture oracle filesystem evaluation self-report` 返回空；
  第二条标题查询 `Verify DSH filesystem results independently` 命中 active record，原因同时
  包含 `fts_unicode61` 和 `fts_trigram`。这不破坏 proposal/review 生命周期验收，但确认当前
  纯词法召回对查询组合和分词较敏感；在向量或重排方案确定前，不应把单次空结果解释成
  “不存在记忆”。
- credential 仅由隔离 `DSH_HOME/.credentials.yaml` 提供（权限 `0600`），没有读取、输出或
  写入报告。默认 `/Users/ikaros/.xuanling/memory.db` 保持 SHA-256
  `c828b6ed632ccd21864cc6c48b8d15a2dd969ff433b73be39f0c9fad47a4e6aa`，且无 WAL/SHM。

## 限制与保留证据

- 每 arm 只有三次 quality trial 和一个 cold/warm pair；模型输出的随机性、不同工程结构和
  不同任务类型均未覆盖。
- 文件 oracle 证明冻结任务的最终 tree，不证明任意编辑工作流、用户审批或所有错误恢复路径。
- W6 只有一个文件 session 和一个两回合 Memory session；它验证候选可用性，不构成新的
  A/B/C 统计样本。Memory 的多关键词查询空结果仍需在召回专项中处理。
- 直接 probe 已单独覆盖 XuanLing 的 CAS、pagination、bounded read、UTF-8 与 workspace
  guard；本次 live workload 不要求每一项独有原语，所以不能把 B 的成功解释成全部能力都
  优于 Native。
- `meta.json` 中 15 个 `secret_redactions` 都为 0；对证据根的独立扫描检查了 313 个普通
  文件、跳过 7,815 个 symlink，并发现 0 个 provider credential occurrence。
- 旧 smoke 和旧 W5 根保留为发现 false-green 与 cache snapshot 缺口的历史证据，不参与本报告
  的绿色结论。

## 机器可复算证据

```json
{
  "schema": "xuanling-dsh-filesystem-evaluation-report/v1",
  "evidence_root": "/private/tmp/xuanling-dsh-fs-eval.codex-fs-w5-final-20260815-1725",
  "population": {
    "arms": ["A", "B", "C"],
    "quality_runs": 3,
    "cache_pairs": 1
  },
  "analyzer_version": 7,
  "frozen_route": {
    "provider": "deepseek-official",
    "model": "deepseek-v4-pro",
    "reasoning_effort": "max"
  },
  "coverage": {
    "total_trials": 15,
    "oracle_passed": 15,
    "cache_read_share": 0.9156,
    "secret_redactions": 0,
    "tool_errors": 0
  },
  "arms": {
    "A": {
      "total_trials": 5,
      "quality_trials": 3,
      "complete": 5,
      "oracle_passed": 5,
      "route_valid": 5,
      "usage_known": 5,
      "average_duration_ms": 73265.6,
      "tool_calls": {
        "xuanling_fs": 0,
        "native_fs": 84,
        "skill": 5,
        "control": 2,
        "shell": 0
      }
    },
    "B": {
      "total_trials": 5,
      "quality_trials": 3,
      "complete": 5,
      "oracle_passed": 5,
      "route_valid": 5,
      "usage_known": 5,
      "average_duration_ms": 148290.6,
      "tool_calls": {
        "xuanling_fs": 101,
        "native_fs": 0,
        "skill": 6,
        "control": 12,
        "shell": 0
      }
    },
    "C": {
      "total_trials": 5,
      "quality_trials": 3,
      "complete": 5,
      "oracle_passed": 5,
      "route_valid": 5,
      "usage_known": 5,
      "average_duration_ms": 64805.8,
      "tool_calls": {
        "xuanling_fs": 1,
        "native_fs": 76,
        "skill": 5,
        "control": 8,
        "shell": 0
      }
    }
  },
  "cache_pairs": [
    {
      "arm": "A",
      "request_prefix_sha256": "a1e97a8420fb55d38c18e9d1a29ac78fcbf7ca59b964282145fb75bc29677e43",
      "cold_input_tokens": 8352,
      "warm_input_tokens": 3318,
      "cold_cache_read_tokens": 67072,
      "warm_cache_read_tokens": 67840
    },
    {
      "arm": "B",
      "request_prefix_sha256": "395cca5798b941cd79cd0a68c0e026b551952fe33c625b0079b970558f98be22",
      "cold_input_tokens": 13600,
      "warm_input_tokens": 5802,
      "cold_cache_read_tokens": 124160,
      "warm_cache_read_tokens": 192896
    },
    {
      "arm": "C",
      "request_prefix_sha256": "0f3fef86be41e78dd6055be8f01fdd2ab9a0a04346cc886ba40b6a40c7adc5d0",
      "cold_input_tokens": 14062,
      "warm_input_tokens": 3397,
      "cold_cache_read_tokens": 153984,
      "warm_cache_read_tokens": 142976
    }
  ],
  "decision": {
    "status": "candidate_not_applied",
    "production_change": false,
    "default_profile": "memory_native_fs",
    "conditional_profile": "memory_xuanling_fs",
    "hybrid_profile": "memory_hybrid",
    "evidence_refs": [
      "quality/A/oracle_passed",
      "quality/B/oracle_passed",
      "quality/C/oracle_passed",
      "tools/C/xuanling_fs",
      "tools/C/native_fs"
    ]
  }
}
```
