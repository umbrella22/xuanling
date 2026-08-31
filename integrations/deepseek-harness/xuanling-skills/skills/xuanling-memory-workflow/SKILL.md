---
name: xuanling-memory-workflow
description: Guides DeepSeek Harness agents in activating and routing host file memory (L1) and XuanLing shared lexical memory (L2). Use when mcp_catalog__xuanling or XuanLing memory tools are visible and the task recalls an explicit memory pointer, retains a cross-project fact, prepares a pending candidate, or handles an explicit user review decision. Enforces single-write storage and separate proposal/review turns.
---

# XuanLing Memory Workflow

XuanLing memory is proposal-first: nothing you write becomes a canonical
record until a human decides on the proposal. Two separate turns, always.

When DSH exposes `mcp_catalog__xuanling` instead of individual memory tools,
search the catalog and activate only the exact raw names needed for the next
step, such as `memory_search` and then `memory_get`. Activation changes the next
model request's tool surface; it is not a memory review and never authorizes a
candidate write. Do not activate the complete nine-tool lifecycle preemptively.

## Choose one memory layer

For a project-local must-see convention that belongs in every session, write
only the host file memory (L1). Make zero XuanLing write and do not create a
candidate for the same content.

For a cross-project, team-level, or shared fact that the user wants retained
in XuanLing L2, call `memory_search` first. If the fact is absent or has no
match, call `memory_candidate_create` to create a pending candidate; only a
later explicit user review can make it canonical.

At task begin or after a topic switch, follow an explicit L1 memory pointer by
issuing one scoped `memory_search`. This is a pull trigger, not an instruction
to search on every turn.

## Before writing anything

1. Search first with `memory_search` (namespaces, scopes, and tags matter —
   a duplicate record is worse than no record).
2. Read the exact current content with `memory_get` when a hit looks close.
   Updating means a replace proposal against that record's current revision,
   not a second create.

`memory_search` returns complete active `MemoryRecordView` values inside its
ranked items, not a lightweight manifest. Keep the first query scoped and
small, then use `memory_get` only when an exact current record is required.

## Creating a candidate

- Call `memory_candidate_create` with the full payload: kind (`fact`,
  `preference`, `procedure`, `solution`, or `summary`), content, and a
  one-line title/summary. Include an `idempotency_key` you derive from the
  proposal's meaning.
- The call only creates a pending candidate. Report the returned proposal id
  and its revision to the user, then stop: the terminal state without review
  is awaiting review.
- To retry a failed candidate call, reuse the same idempotency key with the
  same payload. Changing the payload under a reused key is a conflict; that
  is correct behavior, not an error to work around.
- Replacing or archiving follows the same shape: `memory_candidate_replace`
  or `memory_candidate_archive` targets a specific record revision, and the
  server refuses to apply it if that revision went stale.

## The review gate

- Call `memory_review` only after an explicit user instruction — an approval
  or rejection decision that names the concrete proposal. A conversational
  "looks good" during other work is not that decision; ask the user to
  confirm the specific proposal id if in doubt. DSH also asks for one-time Host
  approval immediately before dispatch; this runtime gate enforces the user
  decision, while `reviewer_id` remains caller-attested at the Rust boundary.
- Never describe yourself or this agent as the human reviewer. You propose;
  the user disposes. When you report a review outcome, attribute the decision
  to the user who made it.
- Never approve a proposal to finish a task, save tokens, or unblock a
  workflow; an unreviewed candidate is a correct end state.

## When not to write

- If recall has no match or the store is unavailable during ordinary work,
  continue the main task and make zero canonical write. Do not invent a fact
  or treat a partial candidate as a fallback result.
- Parse failures, model hiccups, tool errors, or an unavailable store mean
  you skip the write entirely. Do not create partial or best-effort
  candidates to compensate; just continue the user's task and mention the
  skipped save if it matters.
- Nothing here authorizes writing secrets, raw credentials, or user-private
  content into the shared store.
- Feedback after recall uses `memory_feedback` on a specific record revision
  and is safe anytime.

## Scope and namespace quick reference

- `scope` is a tagged object: `{"type":"global"}`,
  `{"type":"project","project_id":...}`, or
  `{"type":"workspace","project_id":...,"workspace_id":...}`.
- Search walks ancestor scopes only when asked; sibling projects never leak.
