# ADR 0001:Memory v2 —— proposal/review、不可变版本与显式 scope

> 状态:Accepted(2026-08-14)。
> 实施:由 [memory-v2-extraction-development-plan.md](../plans/memory-v2-extraction-development-plan.md) 的 W2-W7 落地;
> 本 ADR 记录决策与理由,目标数据结构细节见
> [../architecture/memory-v2-architecture.md](../architecture/memory-v2-architecture.md)。

## 背景

Memory v1 位于 `xuanling-toolkit::memory`,提供 `memory_put/update/delete/compact/context`
等直接写入、覆盖与物理删除,只有 namespace 一个隔离维度。问题:

1. 模型的一次输出可以直接覆盖或删除 canonical 记忆,没有人工/调用方确认环节。
2. 记录被覆盖后历史丢失,无法审计"当时记了什么"。
3. 只有 namespace 隔离,project/workspace 之间互相可见。
4. v1 数据库没有可校验的导出/导入/重建投影的维护通道。
5. 实验性 embedding 代码默认参与编译,检索路径对"是否需要模型"没有明确边界。

## 决策

1. **抽离 crate**:memory 从 toolkit 移入独立 crate `xuanling-memory`;toolkit 不再
   依赖 SQLx 等 memory-only 依赖;MCP 同时依赖两者,toolkit 不 re-export memory。
2. **proposal/review 替代直接 CRUD**:所有 create/replace/archive 只产生 pending
   proposal;只有 `memory_review` 携带 proposal revision CAS 才能原子激活
   (提交不可变 record version、CAS 推进 head、更新 FTS 投影、写入 terminal review,
   单事务)。解析、决策或模型失败时零 canonical 写入,不 fallback。
3. **不可变版本记录**:`memory_record_versions` 按 `(record_id, revision)` 保存完整
   payload;head 只保存当前 revision 与 active/archived 状态;没有物理删除、purge 或
   restore API;archive 只改 head 状态。
4. **显式 scope**:严格 tagged JSON 的 `global/project/workspace` 三态,ID 由调用方
   提供且不透明;get/list/mutate/search 精确匹配 scope,祖先检索只走
   workspace → project → global,绝不跨 sibling project。
5. **lexical-first 检索**:unicode61 + trigram 双 FTS(RRF 合并)加参数绑定短 CJK
   fallback;FTS 是 active-only 派生投影,不进入导出;相同 DB 与请求返回
   byte-identical 结果;检索不写 last-used。
6. **JSONL 维护合同**:版本化 header/trailer(count + SHA-256)的 export;import 只
   接受 canonical 表为空的目标,先全量校验再单事务插入并重建 FTS;`rebuild-index`
   不改变 canonical digest。
7. **breaking MCP v2**:移除 `memory_put/update/delete/compact/context` 五个旧工具,
   暴露 candidate/review/search 九个 v2 工具;server metadata 发布
   `xuanling.memory_contract_version=2`。v1 数据库不迁移:显式打开 v1 schema 返回
   typed error。
8. **默认 DB 更名**:`~/.xuanling/memory.db`;HOME 不可解析时返回 `unavailable`,
   不回退 cwd。
9. **embedding 隔离**:实验性 embedder/embedding/hybrid 代码移入非默认 feature
   `experimental-embeddings`;默认构建无模型运行时、无下载器、无网络副作用,
   不暴露 semantic MCP 工具。该 feature 只暴露协议中立 `Embedder` trait 与
   确定性测试双替身(`NoopEmbedder`/`FakeEmbedder`);crate 不附带任何真实模型
   adapter,项目不提供模型安装流程(model dir 配置、下载 UX、向量服务均不在范围内),
   语义失败必须保持 lexical 结果可用。v2 schema 不含 embedding 行,因此不存在
   record-revision 失效(stale)持久化路径。

## 不做(本轮边界)

- 不实现 CodeGraph、LSP、真实 embedding 模型与模型下载;不在 DTO/schema/MCP 中留
  占位实现。
- 不迁移 v1 用户数据;旧默认库的删除是本机切换的显式授权操作,不属于库合同。
- 不声称验证真人评审:`proposer_id`/`reviewer_id`/comment 都是 caller-attested,
  MCP host approval 只是上层授权信号;scope 不是认证边界。

## 后果

- 写路径变成两步(proposal → review),调用方必须管理 idempotency key;换取的是
  canonical 记忆的可审计性与不可毁史。
- MCP memory 工具面 breaking,0.1.0 → 0.2.0;npm 包同步升版。
- toolkit 编译面收窄(memory-only 依赖移出),边界由 `cargo metadata` 结构化测试守护。
