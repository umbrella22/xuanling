import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { definition, fixture } from '../feedback-fixtures.mjs'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

/** Seed one terminal Run directly in the durable store of a workspace runtime. */
async function seedTerminalRun(runtimeRoot, requestId) {
  const opened = await openBlueprintDomain({ path: runtimeRoot })
  try {
    const store = new RunStore(opened.domain)
    const { runId } = await store.createRun(
      { scope: 'run', requestId, payloadFingerprint: `fp:${requestId}` },
      'rev-1',
      JSON.stringify(definition()),
      'input',
      { blueprintId: 'feedback', source: { sessionId: 'feedback-session', kind: 'ui' } }
    )
    await store.settleTerminal(runId, 'failed', { reason: 'prepare-failed' })
    return await store.get(runId)
  } finally {
    await opened.close()
  }
}

test('conversation calls follow the caller Workspace; unattributed calls keep the Host default', async t => {
  const f = await fixture(t, { emptyConfig: true })
  const other = join(f.root, 'other')
  mkdirSync(other, { recursive: true })
  f.ctx.provide('workspaceRegistry', {
    list: () => [
      { path: join(f.root, 'workspace'), sessionIds: ['default-session'] },
      { path: other, sessionIds: ['feedback-session'] }
    ]
  })
  const blueprint = f.ctx.blueprint

  const saved = await blueprint.withSessionWorkspace('feedback-session', () =>
    blueprint.createDefinition({ requestId: 'other-ws', definitionJson: JSON.stringify(definition('other-flow')) })
  )
  assert.ok(existsSync(join(other, '.xuanling', 'workflows', saved.blueprintId, 'blueprint.json')), 'definition lands in the session Workspace')
  assert.equal(existsSync(join(f.root, 'workspace', '.xuanling', 'workflows', saved.blueprintId)), false)

  assert.deepEqual((await blueprint.listDefinitions()).definitions, [], 'the panel without a session still sees the Host default Workspace')

  const listed = await f.dispatch('workflow_list', {})
  assert.equal(Boolean(listed.isError), false, JSON.stringify(listed))
  assert.match(JSON.stringify(listed), /other-flow/, 'conversation tool lists the caller Workspace library')

  const viaCwd = await blueprint.withSessionWorkspace('child-step-session', () => blueprint.listDefinitions(), join(other, 'nested', 'dir'))
  assert.equal(viaCwd.definitions.length, 1, 'a child session is attributed through a registered Workspace containing its cwd')

  const unregistered = await blueprint.withSessionWorkspace('stray', () => blueprint.listDefinitions(), join(f.root, 'not-a-workspace'))
  assert.deepEqual(unregistered.definitions, [], 'an unregistered cwd never becomes a definition root')
  assert.equal(existsSync(join(f.root, 'not-a-workspace', '.xuanling')), false)
})

test('conversation Run RPCs follow the caller Workspace; unscoped canvas RPCs keep the Host default', async t => {
  const f = await fixture(t, { emptyConfig: true })
  const other = join(f.root, 'other')
  mkdirSync(join(other, '.xuanling'), { recursive: true })
  f.ctx.provide('workspaceRegistry', {
    list: () => [
      { path: join(f.root, 'workspace'), sessionIds: [] },
      { path: other, sessionIds: ['feedback-session'] }
    ]
  })
  const record = await seedTerminalRun(join(other, '.xuanling'), 'other-run')
  const blueprint = f.ctx.blueprint

  const scoped = await blueprint.queryRuns({ sessionId: 'feedback-session' })
  assert.deepEqual(
    scoped.runs.map(run => run.runId),
    [record.runId],
    'queryRuns reads the session Workspace (load-more pagination)'
  )
  assert.deepEqual((await blueprint.queryRuns({ blueprintId: 'feedback' })).runs, [], 'a query without a session keeps the Host default Workspace')

  const session = await blueprint.inspectSession({ sessionId: 'feedback-session' })
  assert.equal(session.status, 'bound')
  assert.equal(session.selected.run.runId, record.runId)

  const report = await blueprint.workflowReport({ runId: record.runId, sessionId: 'feedback-session' })
  assert.equal(report.runId, record.runId)
  assert.equal(report.outcome, 'failed')
  await assert.rejects(blueprint.workflowReport({ runId: record.runId }), { code: 'blueprint/run-not-found' })

  const archived = await blueprint.archiveRun({ runId: record.runId, sessionId: 'feedback-session' })
  assert.deepEqual({ runId: archived.runId, archived: archived.archived }, { runId: record.runId, archived: true })
  await assert.rejects(blueprint.archiveRun({ runId: record.runId }), { code: 'blueprint/run-not-found' })
})

test('an explicit workspaceRoot pins the library regardless of the caller session', async t => {
  const f = await fixture(t)
  f.ctx.provide('workspaceRegistry', { list: () => [{ path: join(f.root, 'elsewhere'), sessionIds: ['feedback-session'] }] })
  const saved = await f.ctx.blueprint.withSessionWorkspace('feedback-session', () =>
    f.ctx.blueprint.createDefinition({ requestId: 'pinned', definitionJson: JSON.stringify(definition('pinned')) })
  )
  assert.ok(existsSync(join(f.root, 'workspace', '.xuanling', 'workflows', saved.blueprintId, 'blueprint.json')))
})
