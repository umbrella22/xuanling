import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { WORKFLOW_HOST_APPROVAL } from '../../src/service/apply-service.ts'
import { BlueprintService } from '../../src/index.ts'

const definition = id => ({
  schemaVersion: 2,
  id,
  name: id,
  resources: {},
  graph: {
    nodes: [
      { id: 'input', kind: 'input', outputs: { value: 'string' } },
      { id: 'output', kind: 'output', inputs: { value: 'string' } }
    ],
    edges: []
  }
})

async function open(root, options = {}) {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(`${root}/`).href
  ctx.provide('systemPrompt', { tools: () => () => {} })
  new ToolRuntime(ctx, { mode: 'native' })
  await ctx.plugin(BlueprintService, { workspaceRoot: root, ...options })
  return ctx
}

test('P0 service resolves definitions from workspace .xuanling/workflows and ignores legacy mappings', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-workspace-service-'))
  const outside = join(root, 'legacy')
  const workflow = join(root, '.xuanling', 'workflows', 'code-review')
  mkdirSync(workflow, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(workflow, 'blueprint.json'), `${JSON.stringify(definition('code-review'), null, 2)}\n`)
  writeFileSync(join(outside, 'blueprint.json'), `${JSON.stringify(definition('legacy'), null, 2)}\n`)
  const ctx = await open(root)
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  const listed = await ctx.blueprint.listDefinitions()
  assert.deepEqual(
    listed.definitions.map(item => item.blueprintId),
    ['code-review']
  )
  const loaded = await ctx.blueprint.loadDefinition({ blueprintId: 'code-review' })
  assert.equal(JSON.parse(loaded.definitionJson).name, 'code-review')
  const edited = { ...definition('code-review'), name: 'Updated' }
  const saved = await ctx.blueprint.saveDefinition({
    blueprintId: 'code-review',
    definitionJson: JSON.stringify(edited),
    expectedRevision: loaded.documentRevision
  })
  assert.equal(JSON.parse(saved.definitionJson).name, 'Updated')
  assert.equal(JSON.parse(readFileSync(join(workflow, 'blueprint.json'), 'utf8')).name, 'Updated')
  assert.equal(JSON.parse(readFileSync(join(outside, 'blueprint.json'), 'utf8')).name, 'legacy')

  const created = await ctx.blueprint.createDefinition({ requestId: 'workspace-create', definitionJson: JSON.stringify(definition('draft')) })
  assert.equal(existsSync(join(root, '.xuanling', 'workflows', created.blueprintId, 'blueprint.json')), true)
})

test('P2 workflow tools share ApplyService approval, layout diff, CAS and revision history', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-workflow-tools-'))
  const workflow = join(root, '.xuanling', 'workflows', 'code-review')
  mkdirSync(workflow, { recursive: true })
  writeFileSync(join(workflow, 'blueprint.json'), `${JSON.stringify(definition('code-review'), null, 2)}\n`)
  const ctx = await open(root)
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  const current = await ctx.blueprint.workflowGet({ workflowId: 'code-review' })
  // The fixture starts from a hand-written workspace file; the no-op apply
  // seeds the same revision-history entry a normal create/save path records.
  const seeded = await ctx.blueprint.workflowApply({
    workflowId: 'code-review',
    definitionJson: current.definitionJson,
    expectedRevision: current.documentRevision,
    origin: 'canvas'
  })
  assert.equal(seeded.status, 'applied')
  const semantic = { ...definition('code-review'), name: 'Semantic edit' }
  const validation = await ctx.blueprint.workflowValidate({ workflowId: 'code-review', definitionJson: JSON.stringify(semantic) })
  assert.equal(validation.ok, true)
  const candidate = await ctx.blueprint.workflowPropose({
    workflowId: 'code-review',
    definitionJson: JSON.stringify(semantic),
    expectedRevision: current.documentRevision,
    origin: 'conversation'
  })
  assert.equal(candidate.status, 'candidate')
  assert.equal(candidate.diff.semanticChanged, true)

  const pending = await ctx.blueprint.workflowApply({
    workflowId: 'code-review',
    definitionJson: JSON.stringify(semantic),
    expectedRevision: current.documentRevision,
    origin: 'conversation'
  })
  assert.equal(pending.status, 'approval-required')
  await assert.rejects(
    () =>
      ctx.blueprint.workflowApply({
        workflowId: 'code-review',
        definitionJson: JSON.stringify(semantic),
        expectedRevision: current.documentRevision,
        approveSemantic: true
      }),
    { code: 'gateway/bad-request' }
  )
  const applied = await ctx.blueprint.workflowApplyFromHost({
    workflowId: 'code-review',
    definitionJson: JSON.stringify(semantic),
    expectedRevision: current.documentRevision,
    origin: 'conversation',
    approval: WORKFLOW_HOST_APPROVAL
  })
  assert.equal(applied.status, 'applied')
  assert.deepEqual(JSON.parse(applied.document.definitionJson), semantic)

  const layout = { ...semantic, presentation: { nodes: { input: { x: 10, y: 20 } } } }
  const layoutResult = await ctx.blueprint.workflowApply({
    workflowId: 'code-review',
    definitionJson: JSON.stringify(layout),
    expectedRevision: applied.document.documentRevision,
    origin: 'canvas'
  })
  assert.equal(layoutResult.status, 'applied')
  assert.equal(layoutResult.diff.semanticChanged, false)
  assert.equal(layoutResult.diff.layoutChanged, true)

  const revisions = await ctx.blueprint.workflowRevisions({ workflowId: 'code-review' })
  assert.ok(revisions.revisions.some(entry => entry.revision === current.documentRevision))
  assert.ok(revisions.revisions.some(entry => entry.revision === applied.document.documentRevision))
  const pendingRevert = await ctx.blueprint.workflowRevert({
    workflowId: 'code-review',
    revision: current.documentRevision,
    expectedRevision: layoutResult.document.documentRevision
  })
  assert.equal(pendingRevert.status, 'approval-required')
  const reverted = await ctx.blueprint.workflowRevertFromHost({
    approval: WORKFLOW_HOST_APPROVAL,
    workflowId: 'code-review',
    revision: current.documentRevision,
    expectedRevision: layoutResult.document.documentRevision,
    message: 'restore initial workflow'
  })
  assert.equal(reverted.status, 'applied')
  assert.equal(JSON.parse(reverted.document.definitionJson).name, 'code-review')
})
