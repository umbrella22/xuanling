/**
 * T04 (C-04): a saved plan belongs to the conversation before any Run exists.
 * Red target: `inspectSession` previously reported `unbound` for every session
 * without a Run, and nothing durable recorded the created blueprint.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'

const candidate = (name = 'Plan') => ({
  definition: {
    schemaVersion: 2,
    id: 'draft',
    name,
    resources: {},
    graph: { nodes: [{ id: 'input', kind: 'input' }], edges: [] }
  },
  files: []
})

async function fixture(t, roots = {}) {
  const root = roots.root ?? mkdtempSync(join(tmpdir(), 'bp-association-'))
  const workspace = join(root, 'workspace')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${join(root, 'profile')}/`).href
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const tools = new ToolRuntime(ctx, { mode: 'native' })
  ctx.provide('workspaceController', { initializeDefault: async () => ({ workspace: { path: workspace } }) })
  const live = { id: 'session-a', session: { id: 'session-a', header: { id: 'session-a', isSeeded: false } }, ctx }
  ctx.provide('agents', { get: id => (String(id) === 'session-a' ? live : undefined), list: () => [live] })
  await ctx.plugin(BlueprintService, {
    workspaceRoot: workspace,
    associationRoot: join(root, 'associations'),
    ...roots.config
  })
  t.after(async () => {
    await ctx.fiber.dispose()
    if (roots.keep !== true) rmSync(root, { recursive: true, force: true })
  })
  let call = 0
  const dispatch = (name, args, sessionId = 'session-a', signal = new AbortController().signal) =>
    tools.execute({ name, arguments: args, callId: `assoc-${++call}`, signal, agent: sessionId === 'session-a' ? live : { ctx, session: { id: sessionId } } })
  return { ctx, service: ctx.blueprint, tools, dispatch, root, workspace }
}

test('T04: create returns a durable plan and inspectSession shows it without a Run', async t => {
  const f = await fixture(t)
  const result = await f.dispatch('blueprint_create', { ...candidate(), requestId: 'req-1', intent: 'design' })
  assert.equal(Boolean(result.isError), false, JSON.stringify(result))
  const value = result.value ?? result
  assert.equal(value.status, 'saved')
  assert.equal(value.intent, 'design')
  assert.equal(value.blueprintId, value.association.asset.blueprintId)
  assert.equal(value.association.status, 'saved')
  assert.equal(value.association.runId, null)

  const session = await f.service.inspectSession({ sessionId: 'session-a' })
  assert.equal(session.status, 'unbound')
  assert.equal(session.associations.length, 1)
  assert.equal(session.associations[0].intent, 'design')
  assert.equal(session.associations[0].status, 'saved')
  assert.deepEqual(await f.service.queryRuns({ sessionId: 'session-a' }), { runs: [] })
})

test('T04: the association survives restart and replays the same request idempotently', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-association-restart-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = await fixture(t, { root, keep: true })
  const created = await first.dispatch('blueprint_create', { ...candidate(), requestId: 'req-restart', intent: 'design' })
  assert.equal(Boolean(created.isError), false, JSON.stringify(created))
  const associationId = created.value.association.associationId

  // A fresh Host instance reads the same profile association namespace.
  const second = await fixture(t, { root, keep: true })
  const session = await second.service.inspectSession({ sessionId: 'session-a' })
  assert.equal(session.associations.length, 1)
  assert.equal(session.associations[0].associationId, associationId)

  const replay = await second.dispatch('blueprint_create', { ...candidate(), requestId: 'req-restart', intent: 'design' })
  assert.equal(Boolean(replay.isError), false, JSON.stringify(replay))
  assert.equal((await second.service.inspectSession({ sessionId: 'session-a' })).associations.length, 1)
})

test('review: association linking uses the full asset and revision identity', async t => {
  const { ConversationAssociationStore } = await import('../../src/conversation/association-store.ts')
  const root = mkdtempSync(join(tmpdir(), 'bp-assoc-identity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new ConversationAssociationStore(root)
  for (const workspaceId of ['a', 'b'])
    store.put({
      schemaVersion: 1,
      associationId: `assoc-${workspaceId}`,
      sessionId: 's',
      asset: { library: { kind: 'workspace', workspaceId }, blueprintId: 'same' },
      name: workspaceId,
      documentRevision: 'rev',
      intent: 'design',
      status: 'saved',
      runId: null,
      requestId: workspaceId,
      updatedAt: new Date().toISOString()
    })
  store.link('s', { library: { kind: 'workspace', workspaceId: 'b' }, blueprintId: 'same' }, 'rev', 'run-b')
  assert.equal(store.get('s', 'assoc-a').runId, null)
  assert.equal(store.get('s', 'assoc-b').runId, 'run-b')
})
