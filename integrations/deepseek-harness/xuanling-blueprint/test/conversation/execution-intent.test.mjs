/**
 * T05 (C-05): design requests stop at a plan; execute requests continue to a
 * real Run or report the typed blocker. Host approval is never bypassed.
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

const candidate = () => ({
  definition: {
    schemaVersion: 2,
    id: 'draft',
    name: 'Intent plan',
    resources: {},
    graph: { nodes: [{ id: 'input', kind: 'input' }], edges: [] }
  },
  files: []
})

async function fixture(t, { target = true, approval, bound = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-intent-'))
  const workspace = join(root, 'workspace')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${join(root, 'profile')}/`).href
  ctx.provide('systemPrompt', { tools: () => () => {} })
  const tools = new ToolRuntime(ctx, { mode: 'native' })
  if (bound) ctx.provide('workspaceRegistry', { list: () => [{ id: 'ws-a', path: workspace, title: 'Alpha', sessionIds: ['session-a'] }] })
  else ctx.provide('workspaceRegistry', { list: () => [] })
  const live = {
    id: 'session-a',
    session: { id: 'session-a', header: { id: 'session-a', isSeeded: false, cwd: bound ? workspace : join(root, 'unregistered') } },
    ctx
  }
  ctx.provide('agents', { get: id => (String(id) === 'session-a' ? live : undefined), list: () => [live] })
  let approvals = 0
  if (approval === 'allow') {
    ctx.provide('approval', {
      request: async () => {
        approvals++
        return 'allowed-once'
      }
    })
  }
  await ctx.plugin(BlueprintService, {
    ...(target ? { workspaceRoot: workspace } : {}),
    associationRoot: join(root, 'associations')
  })
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  let call = 0
  const dispatch = (name, args) => tools.execute({ name, arguments: args, callId: `intent-${++call}`, signal: new AbortController().signal, agent: live })
  return { ctx, service: ctx.blueprint, dispatch, root, workspace, approvals: () => approvals }
}

test('T05: design stops at a saved plan and never starts a Run', async t => {
  const f = await fixture(t, { target: true })
  const result = await f.dispatch('blueprint_create', { ...candidate(), requestId: 'intent-design', intent: 'design' })
  assert.equal(Boolean(result.isError), false, JSON.stringify(result))
  assert.equal(result.value.status, 'saved')
  assert.equal(result.value.runId, undefined)
  assert.deepEqual((await f.service.queryRuns({ sessionId: 'session-a' })).runs, [])
  assert.equal((await f.service.inspectSession({ sessionId: 'session-a' })).associations[0].status, 'saved')
})

test('T05: execute continues through admission and links the plan to a real Run', async t => {
  const f = await fixture(t, { target: true, approval: 'allow' })
  const result = await f.dispatch('blueprint_create', { ...candidate(), requestId: 'intent-execute', intent: 'execute' })
  assert.equal(Boolean(result.isError), false, JSON.stringify(result))
  assert.ok(result.value.runId, JSON.stringify(result))
  assert.ok(['queued', 'running', 'succeeded'].includes(result.value.status))
  assert.equal(f.approvals(), 1, 'execute must pass the Host approval waterfall exactly once')
  const runs = await f.service.queryRuns({ sessionId: 'session-a' })
  assert.equal(runs.runs.length, 1)
  assert.equal(runs.runs[0].runId, result.value.runId)
})

test('T05: execute without a trusted target reports a blocker and creates no Run', async t => {
  const f = await fixture(t, { target: false, approval: 'allow', bound: false })
  const result = await f.dispatch('blueprint_create', { ...candidate(), requestId: 'intent-no-target', intent: 'execute' })
  assert.equal(Boolean(result.isError), false, JSON.stringify(result))
  assert.equal(result.value.status, 'blocked')
  assert.equal(result.value.code, 'blueprint/workspace-required')
  assert.deepEqual((await f.service.queryRuns({ sessionId: 'session-a' })).runs, [])
  const session = await f.service.inspectSession({ sessionId: 'session-a' })
  assert.equal(session.associations[0].status, 'blocked')
  assert.equal(session.associations[0].runId, null)
})

test('T05: a design retry cannot erase an existing Run link on the same request', async t => {
  const f = await fixture(t, { target: true, approval: 'allow' })
  const execute = await f.dispatch('blueprint_create', { ...candidate(), requestId: 'intent-replay', intent: 'execute' })
  assert.equal(Boolean(execute.isError), false, JSON.stringify(execute))
  const runId = execute.value.runId
  assert.ok(runId)
  const design = await f.dispatch('blueprint_create', { ...candidate(), requestId: 'intent-replay', intent: 'design' })
  assert.equal(Boolean(design.isError), false, JSON.stringify(design))
  const session = await f.service.inspectSession({ sessionId: 'session-a' })
  assert.equal(session.associations.length, 1)
  assert.equal(session.associations[0].runId, runId, 'a design retry must preserve the linked Run')
  assert.equal(session.associations[0].status, 'settled')
  assert.equal((await f.service.queryRuns({ sessionId: 'session-a' })).runs.length, 1)
})
