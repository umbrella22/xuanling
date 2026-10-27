/**
 * T12 (C-06/C-12): Run records capture the frozen execution context; record 2
 * stays readable; an unknown record version is rejected without rewriting.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

const definition = () => ({
  schemaVersion: 2,
  id: 'bp-run',
  name: 'Context run',
  resources: {},
  graph: { nodes: [{ id: 'input', kind: 'input' }], edges: [] }
})

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-record3-'))
  const workspace = join(root, 'workspace')
  mkdirSync(join(workspace, '.xuanling', 'workflows', 'bp-run'), { recursive: true })
  writeFileSync(join(workspace, '.xuanling', 'workflows', 'bp-run', 'blueprint.json'), JSON.stringify(definition()))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${join(root, 'profile')}/`).href
  ctx.provide('systemPrompt', { tools: () => () => {} })
  new ToolRuntime(ctx, { mode: 'native' })
  ctx.provide('workspaceRegistry', { list: () => [{ id: 'ws-a', title: 'Alpha', path: workspace, sessionIds: [] }] })
  await ctx.plugin(BlueprintService, { workspaceRoot: workspace })
  const service = ctx.blueprint
  const runtimeRoot = join(realpathSync(workspace), '.xuanling')
  const close = async () => {
    await ctx.fiber.dispose()
  }
  t.after(async () => {
    await close().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  })
  return { service, workspace, runtimeRoot, close, root }
}

async function runToTerminal(service) {
  const document = await service.loadDefinition({ blueprintId: 'bp-run' })
  const admitted = await service.startRun({
    blueprintId: 'bp-run',
    expectedRevision: document.documentRevision,
    inputJson: '{}',
    requestId: 'record3-run'
  })
  for (let turn = 0; turn < 500; turn++) {
    const view = await service.inspectRun({ runId: admitted.runId })
    if (['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(view.state)) return admitted.runId
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('Run did not settle')
}

test('T12: a new Run freezes record schema 3 with target, instance and fingerprint', async t => {
  const f = await fixture(t)
  const runId = await runToTerminal(f.service)
  const file = join(f.runtimeRoot, 'runs', runId, 'run.json')
  const record = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(record.schemaVersion, 3)
  assert.deepEqual(record.context.instanceAssetRef, { library: { kind: 'workspace', workspaceId: 'ws-a' }, blueprintId: 'bp-run' })
  assert.equal(record.context.originAssetRef, null)
  assert.equal(record.context.targetWorkspace.workspaceId, 'ws-a')
  assert.match(record.context.targetWorkspace.rootFingerprint, /^[a-f0-9]{64}$/)
  assert.equal(record.context.preparationDigest, null)
})

test('T12: record 2 remains readable and an unknown version is preserved', async t => {
  const f = await fixture(t)
  const runId = await runToTerminal(f.service)
  const file = join(f.runtimeRoot, 'runs', runId, 'run.json')
  const original = JSON.parse(readFileSync(file, 'utf8'))

  // Simulate a record written by the previous release.
  const legacy = { ...original, schemaVersion: 2 }
  delete legacy.context
  writeFileSync(file, JSON.stringify(legacy, null, 2))
  await f.close()

  const opened = await openBlueprintDomain({ path: f.runtimeRoot })
  try {
    const store = new RunStore(opened.domain)
    const read = await store.get(runId)
    assert.equal(read.runId, runId)
    assert.equal(read.state, 'succeeded')
    assert.equal(read.schemaVersion, 3, 'the decoded view normalizes the effective schema version')
  } finally {
    await opened.close()
  }

  const unknown = { ...legacy, schemaVersion: 99 }
  const bytes = JSON.stringify(unknown, null, 2)
  writeFileSync(file, bytes)
  const reopened = await openBlueprintDomain({ path: f.runtimeRoot })
  try {
    const store = new RunStore(reopened.domain)
    await assert.rejects(() => store.get(runId))
  } finally {
    await reopened.close()
  }
  assert.equal(readFileSync(file, 'utf8'), bytes, 'an unreadable record must not be rewritten')
})
