import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'
import { BlueprintWorkspace, newDraftKey } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-create-'))
  const fibers = []
  t.after(async () => {
    for (const ctx of fibers) await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  async function open() {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${root}/`).href
    ctx.provide('systemPrompt', {
      tools() {
        return () => {}
      }
    })
    new ToolRuntime(ctx, { mode: 'native' })
    await ctx.plugin(BlueprintService, { workspaceRoot: root, runtimeRoot: join(root, '.xuanling') })
    fibers.push(ctx)
    return ctx.blueprint
  }
  const host = await open()
  const data = new Map()
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }
  const link = service => ({
    listDefinitions: () => service.listDefinitions(),
    loadDefinition: blueprintId => service.loadDefinition({ blueprintId }),
    createDefinition: (requestId, definitionJson) => service.createDefinition({ requestId, definitionJson }),
    saveDefinition: (blueprintId, definitionJson, expectedRevision) => service.saveDefinition({ blueprintId, definitionJson, expectedRevision }),
    validate: definitionJson => service.validate({ definitionJson }),
    preflightRun: (blueprintId, expectedRevision, inputJson) => service.preflightRun({ blueprintId, expectedRevision, inputJson }),
    exportDefinition: blueprintId => service.exportDefinition({ blueprintId })
  })
  return { root, host, open, storage, link, workspace: new BlueprintWorkspace(link(host), storage) }
}
function addGraph(workspace) {
  workspace.editor.addNode({ kind: 'input', label: 'input', x: 0, y: 0, inputs: {}, outputs: { value: 'json' } })
  workspace.editor.addNode({ kind: 'output', label: 'output', x: 300, y: 0, inputs: { value: 'json' }, outputs: {} })
}

test('empty library opens editable draft; first save and host restart preserve the new document without running', async t => {
  const f = await fixture(t),
    w = f.workspace
  await w.initialize()
  assert.ok(w.definition, 'empty library must open a draft')
  assert.equal(w.isNewDraft, true)
  addGraph(w)
  const restored = new BlueprintWorkspace(f.link(f.host), f.storage)
  await restored.initialize()
  assert.deepEqual(restored.definition, w.definition, 'reload before save preserves draft')
  const saved = await restored.save()
  assert.equal(restored.isNewDraft, false)
  assert.equal(restored.dirty, false)
  assert.notEqual(saved.blueprintId, w.blueprintId, 'host assigns the durable identity')
  assert.equal(restored.catalog.length, 1)
  const reopened = await f.open()
  assert.equal((await reopened.listDefinitions()).definitions[0].blueprintId, saved.blueprintId)
  assert.deepEqual(await reopened.loadDefinition({ blueprintId: saved.blueprintId }), saved)
  assert.equal(f.host.runtimes.size, 0, 'editing and saving never dispatch a Run')
})

test('create retries are idempotent; conflicting content and browser locators are rejected', async t => {
  const f = await fixture(t)
  assert.equal(typeof f.host.createDefinition, 'function', 'Host must expose first-save creation')
  const definition = { schemaVersion: 2, id: 'draft', name: '中文 / exact name', resources: {}, graph: { nodes: [], edges: [] } }
  const args = { requestId: 'exact opaque request / 中文', definitionJson: JSON.stringify(definition) }
  const [a, b] = await Promise.all([f.host.createDefinition(args), f.host.createDefinition(args)])
  assert.deepEqual(a, b)
  assert.deepEqual(await (await f.open()).createDefinition(args), a)
  assert.equal((await f.host.listDefinitions()).definitions.length, 1)
  await assert.rejects(f.host.createDefinition({ ...args, definitionJson: JSON.stringify({ ...definition, name: 'conflict' }) }), {
    code: 'blueprint/revision-conflict'
  })
  const descriptor = BLUEPRINT_INVOCATIONS.find(item => item.method === 'createDefinition')
  assert.equal(descriptor.parameters[0].codec.create().safeParse({ ...args, rootDir: '/tmp/escape' }).success, false)
  await assert.rejects(f.host.createDefinition({ ...args, rootDir: '/tmp/escape' }), { code: 'gateway/bad-request' })
  await assert.rejects(f.host.loadDefinition({ blueprintId: '../escape' }), { code: 'blueprint/definition-not-found' })
})

test('lost create response retries the same draft; later edits and navigation survive delayed replies', async t => {
  const f = await fixture(t),
    w = f.workspace
  await w.initialize()
  assert.ok(w.definition, 'new draft exists')
  addGraph(w)
  const create = w.host.createDefinition
  w.host.createDefinition = async (...args) => {
    await create(...args)
    throw new Error('lost response')
  }
  await assert.rejects(w.save(), /lost response/)
  w.editor.addNode({
    kind: 'condition',
    label: 'condition',
    x: 150,
    y: 100,
    inputs: { value: 'boolean' },
    outputs: {},
    definition: { id: 'condition', kind: 'condition', branches: ['yes', 'no'], condition: { inputPort: 'value', trueBranch: 'yes', falseBranch: 'no' } }
  })
  w.host.createDefinition = create
  await w.save()
  assert.equal(w.editor.nodes.length, 3, 'edits after uncertain creation are retained')
  assert.equal(w.dirty, true)
  await w.save()
  assert.equal(w.dirty, false)
  w.newDraft()
  addGraph(w)
  let release
  w.host.createDefinition = async (...args) => {
    const doc = await create(...args)
    await new Promise(resolve => {
      release = resolve
    })
    return doc
  }
  const pending = w.save()
  while (!release) await new Promise(resolve => setImmediate(resolve))
  w.newDraft()
  const next = w.blueprintId
  release()
  await assert.rejects(pending, /Document changed/)
  assert.equal(w.blueprintId, next)
  assert.equal(w.editor.nodes.length, 0)
})

test('managed library never follows a blueprint directory symlink', async t => {
  const f = await fixture(t)
  assert.equal(typeof f.host.createDefinition, 'function')
  const doc = await f.host.createDefinition({
    requestId: 'symlink',
    definitionJson: JSON.stringify({ schemaVersion: 2, id: 'draft', name: 'Draft', resources: {}, graph: { nodes: [], edges: [] } })
  })
  const library = join(f.root, '.xuanling/workflows')
  const target = join(library, doc.blueprintId),
    outside = join(f.root, 'outside')
  rmSync(target, { recursive: true })
  mkdirSync(outside)
  symlinkSync(outside, target)
  await assert.rejects(f.host.saveDefinition({ blueprintId: doc.blueprintId, definitionJson: doc.definitionJson, expectedRevision: null }))
  assert.equal(existsSync(join(outside, 'blueprint.json')), false)
})

test('rejected missing resources can be corrected and saved without duplicate creation', async t => {
  const f = await fixture(t),
    w = f.workspace
  await w.initialize()
  w.editor.updateResource('missing', { kind: 'agent', path: 'lib/agents/missing.md' })
  await assert.rejects(w.save(), { code: 'blueprint/definition-invalid' })
  assert.equal(w.isNewDraft, true)
  assert.equal((await f.host.listDefinitions()).definitions.length, 0)
  w.editor.undo()
  await w.save()
  assert.equal(w.isNewDraft, false)
  assert.equal((await f.host.listDefinitions()).definitions.length, 1)
})

test('first-save check and export bind the assigned identity and never dispatch a Run', async t => {
  const f = await fixture(t),
    w = f.workspace
  await w.initialize()
  addGraph(w)
  const draftId = w.blueprintId
  const report = await w.checkRun()
  assert.notEqual(report.blueprintId, draftId)
  assert.equal(report.blueprintId, w.blueprintId)
  assert.equal(w.preflight.status, 'current')
  assert.equal(f.host.runtimes.size, 0)
  w.newDraft()
  addGraph(w)
  const archive = await w.exportArchive()
  assert.equal(archive.blueprintId, w.blueprintId)
  assert.equal((await f.host.listDefinitions()).definitions.length, 2)
})

test('untrusted new draft is validated before adoption; rejected bytes are retained', async t => {
  const f = await fixture(t)
  const raw = JSON.stringify({ requestId: 'bad', definitionJson: JSON.stringify({ schemaVersion: 2, id: 'draft-bad', graph: { nodes: [] } }) })
  f.storage.setItem(newDraftKey, raw)
  await f.workspace.initialize()
  assert.equal(f.workspace.definition, null)
  assert.equal(f.workspace.notice.key, 'status.draftInvalid')
  assert.equal(f.storage.getItem(newDraftKey), raw)
})
