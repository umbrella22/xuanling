---
name: xuanling-memory-workflow
description: Guides DeepSeek Harness agents through the XuanLing shared lexical memory lifecycle. Use when the agent finds a fact, preference, procedure, solution, or summary worth keeping across sessions, when preparing a memory candidate, or when the user asks to approve, reject, replace, or recall a stored memory. Enforces the proposal and review boundary — candidates are created pending, and only an explicit user decision completes a review.
---

# XuanLing Memory Workflow

XuanLing memory is proposal-first: nothing you write becomes a canonical
record until a human decides on the proposal. Two separate turns, always.

## Before writing anything

1. Search first with `memory_search` (namespaces, scopes, and tags matter —
   a duplicate record is worse than no record).
2. Read the exact current content with `memory_get` when a hit looks close.
   Updating means a replace proposal against that record's current revision,
   not a second create.

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
  confirm the specific proposal id if in doubt.
- Never describe yourself or this agent as the human reviewer. You propose;
  the user disposes. When you report a review outcome, attribute the decision
  to the user who made it.
- Never approve a proposal to finish a task, save tokens, or unblock a
  workflow; an unreviewed candidate is a correct end state.

## When not to write

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
