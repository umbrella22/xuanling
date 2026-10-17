import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { BlueprintService } from '../../src/index.ts'
import { acquireLibraryWriter, readLibraryDeletion } from '../../src/definition/library-state.ts'
import { publishPackage } from '../../src/definition/package-create.ts'

async function fixture(t, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-authoring-'))
  const contexts = []
  t.after(async () => {
    for (const ctx of contexts) await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const open = async () => {
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${root}/`).href
    ctx.provide('systemPrompt', {
      tools() {
        return () => {}
      }
    })
    new ToolRuntime(ctx, { mode: 'native' })
    const caller = { session: { id: 'author', header: {} }, ctx }
    ctx.provide('agents', { get: id => (id === caller.session.id ? caller : undefined) })
    await ctx.plugin(BlueprintService, config)
    contexts.push(ctx)
    const tool = (name, args = {}, signal = new AbortController().signal) =>
      ctx.tools.execute({ name, arguments: args, agent: caller, callId: `${name}-call`, signal })
    return { ctx, service: ctx.blueprint, tool }
  }
  return { root, open, ...(await open()) }
}
const definition = (type = 'json') => ({
  schemaVersion: 1,
  id: 'draft',
  name: 'Authoring fixture',
  resources: {},
  graph: {
    nodes: [
      { id: 'input', kind: 'input', outputs: { result: type } },
      { id: 'output', kind: 'output', inputs: { result: type } }
    ],
    edges: [{ kind: 'data', from: 'input.result', to: 'output.result' }]
  }
})
const args = doc => ({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, inputJson: '{}' })
function value(result) {
  assert.equal(result.isError, false, JSON.stringify(result))
  return JSON.parse(result.content.map(x => x.text ?? '').join(''))
}

test('D01: default profile runtime admits a valid graph without relocating its library', async t => {
  const f = await fixture(t)
  const doc = await f.service.createDefinition({ requestId: 'default', definitionJson: JSON.stringify(definition()) })
  const report = await f.service.preflightRun(args(doc))
  assert.equal(report.canStart, true)
  assert.equal(existsSync(join(f.root, 'data/xuanling-blueprint/runtime')), false, 'preflight must not write runtime')
  const started = await f.service.startRun({ ...args(doc), requestId: 'start' })
  for (const handle of f.service.runtimes.values()) await handle.driverTail
  assert.equal((await f.service.inspectRun({ runId: started.runId })).state, 'succeeded')
  assert.ok(existsSync(join(f.root, 'data/xuanling-blueprint/definitions', doc.blueprintId, 'blueprint.json')))
  assert.ok(existsSync(join(f.root, 'data/xuanling-blueprint/runtime/store')))
})

test('D03: preflight rejects statically invalid initial output before admission', async t => {
  const f = await fixture(t)
  const doc = await f.service.createDefinition({ requestId: 'input', definitionJson: JSON.stringify(definition('string')) })
  const report = await f.service.preflightRun(args(doc))
  assert.equal(report.canStart, false)
  assert.ok(report.checks.some(c => c.nodeId === 'input' && c.code === 'output-invalid' && c.status === 'block'))
  assert.equal(f.service.runtimes.size, 0)
  assert.equal((await f.service.preflightRun({ ...args(doc), inputJson: '{"result":"hello"}' })).canStart, true)
})

test('A01-A04: native tools describe, validate and create an entire declared Agent package with idempotency', async t => {
  const f = await fixture(t)
  const guide = value(await f.tool('blueprint_describe'))
  assert.ok(guide.example.definition.graph.nodes.some(n => n.kind === 'agentTask'))
  const candidate = guide.example
  assert.equal(value(await f.tool('blueprint_validate', candidate)).ok, true)
  const doc = value(await f.tool('blueprint_create', { ...candidate, requestId: 'agent-fixture' }))
  assert.equal(value(await f.tool('blueprint_create', { ...candidate, requestId: 'agent-fixture' })).blueprintId, doc.blueprintId)
  const reopened = await f.open()
  assert.equal(value(await reopened.tool('blueprint_create', { ...candidate, requestId: 'agent-fixture' })).blueprintId, doc.blueprintId)
  const loaded = await f.service.loadDefinition({ blueprintId: doc.blueprintId })
  assert.ok(JSON.parse(loaded.definitionJson).graph.nodes.some(n => n.agentRef))
  for (const file of candidate.files)
    assert.equal(readFileSync(join(f.root, 'data/xuanling-blueprint/definitions', doc.blueprintId, file.path), 'utf8'), file.text)
  assert.equal(f.service.runtimes.size, 0)
})

test('A05: candidate diagnostics reject missing and escaping files without publishing a package', async t => {
  const f = await fixture(t)
  const candidate = value(await f.tool('blueprint_describe')).example
  const missing = value(await f.tool('blueprint_validate', { ...candidate, files: [] }))
  assert.equal(missing.ok, false)
  assert.ok(missing.issues.some(i => i.code === 'resource-file-missing'))
  const invalid = value(await f.tool('blueprint_validate', { ...candidate, files: [{ path: '../outside', text: 'rejected' }] }))
  assert.equal(invalid.ok, false)
  assert.equal((await f.tool('blueprint_create', { ...candidate, files: [], requestId: 'bad' })).isError, true)
  assert.equal((await f.service.listDefinitions()).definitions.length, 0)
})

test('A05: subflow directories admit only their recursively declared resource closure', async t => {
  const f = await fixture(t)
  const outer = definition(),
    child = definition(),
    leaf = definition()
  outer.resources.child = { kind: 'subflow', path: 'lib/subflows/child' }
  child.resources.leaf = { kind: 'subflow', path: 'lib/subflows/leaf' }
  leaf.resources.agent = { kind: 'agent', path: 'lib/agents/worker.md' }
  const files = [
    { path: 'lib/subflows/child/blueprint.json', text: JSON.stringify(child) },
    { path: 'lib/subflows/child/lib/subflows/leaf/blueprint.json', text: JSON.stringify(leaf) },
    { path: 'lib/subflows/child/lib/subflows/leaf/lib/agents/worker.md', text: 'Declared worker.' }
  ]
  const candidate = { definition: outer, files }
  assert.equal(value(await f.tool('blueprint_validate', candidate)).ok, true)
  const doc = value(await f.tool('blueprint_create', { ...candidate, requestId: 'subflow' }))
  for (const file of files) assert.equal(readFileSync(join(f.root, 'data/xuanling-blueprint/definitions', doc.blueprintId, file.path), 'utf8'), file.text)
  const missing = value(await f.tool('blueprint_validate', { ...candidate, files: files.slice(0, 2) }))
  assert.ok(missing.issues.some(i => i.code === 'resource-file-missing'))
  const extra = value(await f.tool('blueprint_validate', { ...candidate, files: [...files, { path: 'lib/subflows/child/secret.txt', text: 'undeclared' }] }))
  assert.ok(extra.issues.some(i => i.code === 'resource-file-undeclared'))
  const invalid = value(await f.tool('blueprint_validate', { ...candidate, files: [{ ...files[0], text: '{}' }, ...files.slice(1)] }))
  assert.ok(invalid.issues.some(i => i.code === 'subflow-invalid'))
})

test('A04/A06: native create rejects changed retries and cancelled requests; start accepts JSON values', async t => {
  const f = await fixture(t)
  const candidate = { definition: definition(), files: [] }
  const created = value(await f.tool('blueprint_create', { ...candidate, requestId: 'once' }))
  const changed = await f.tool('blueprint_create', { ...candidate, definition: { ...candidate.definition, name: 'changed' }, requestId: 'once' })
  assert.equal(changed.error.info.code, 'blueprint/revision-conflict')
  const controller = new AbortController()
  controller.abort()
  assert.equal((await f.tool('blueprint_create', { ...candidate, requestId: 'cancelled' }, controller.signal)).isError, true)
  assert.equal((await f.service.listDefinitions()).definitions.length, 1)
  const runArgs = { blueprintId: created.blueprintId, expectedRevision: created.documentRevision, input: { nested: ['exact', 2, null] } }
  assert.equal(value(await f.tool('blueprint_preflight', runArgs)).canStart, true)
  const run = value(await f.tool('blueprint_start', runArgs))
  for (const h of f.service.runtimes.values()) await h.driverTail
  assert.equal((await f.service.inspectRun({ runId: run.runId })).state, 'succeeded')
  const legacy = await f.tool('blueprint_start', { blueprintId: created.blueprintId, expectedRevision: created.documentRevision, inputJson: '{}' })
  assert.equal(legacy.error.info.code, 'INVALID_ARGS', 'old model input alias must not silently remain')
})

test('L01-L04: delete persists, replays, rejects stale save/create and preserves frozen run history', async t => {
  const f = await fixture(t)
  assert.equal(typeof f.service.deleteDefinition, 'function', 'Host deletion must exist')
  const request = { requestId: 'delete-me', definitionJson: JSON.stringify(definition()) }
  const doc = await f.service.createDefinition(request)
  const run = await f.service.startRun({ ...args(doc), requestId: 'run-before-delete' })
  for (const h of f.service.runtimes.values()) await h.driverTail
  const del = { blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, requestId: 'delete' }
  const result = await f.service.deleteDefinition(del)
  assert.equal(result.deleted, true)
  assert.deepEqual(await f.service.deleteDefinition(del), result)
  const reopened = await f.open()
  assert.equal((await reopened.service.listDefinitions()).definitions.length, 0)
  await assert.rejects(reopened.service.loadDefinition({ blueprintId: doc.blueprintId }), { code: 'blueprint/definition-deleted' })
  await assert.rejects(f.service.saveDefinition({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, definitionJson: doc.definitionJson }), {
    code: 'blueprint/definition-deleted'
  })
  await assert.rejects(f.service.createDefinition(request), { code: 'blueprint/definition-deleted' })
  assert.equal((await f.service.inspectRun({ runId: run.runId })).state, 'succeeded')
})

test('X01/J01: current export only, every JSON field uses the shared editor', () => {
  const panel = readFileSync(new URL('../../src/client/features/authoring/ui/panel/panel-controller.tsx', import.meta.url), 'utf8')
  const inspector = readFileSync(new URL('../../src/client/features/authoring/ui/inspector/inspector-view.tsx', import.meta.url), 'utf8')
  const inspectorEntry = readFileSync(new URL('../../src/client/features/authoring/ui/inspector/inspector-composition.tsx', import.meta.url), 'utf8')
  assert.equal(panel.includes("moreAction('export-legacy'"), false, 'old format action must be removed')
  assert.ok(inspectorEntry.includes("from './inspector-view.tsx'") && inspectorEntry.includes('return inspectorView('), 'Inspector uses its extracted view')
  assert.ok(panel.includes('JsonEditor') && inspector.includes('JsonEditor'), 'all JSON field surfaces adopt the editor')
})

test('L03: save/delete ordering uses revision CAS and deletion blocks admission and export', async t => {
  const f = await fixture(t)
  const doc = await f.service.createDefinition({ requestId: 'race', definitionJson: JSON.stringify(definition()) })
  const next = { ...definition(), id: doc.blueprintId, name: 'Changed before delete' }
  const [saved, deleted] = await Promise.allSettled([
    f.service.saveDefinition({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, definitionJson: JSON.stringify(next) }),
    f.service.deleteDefinition({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, requestId: 'race-delete' })
  ])
  assert.equal(saved.status, 'fulfilled')
  assert.equal(deleted.status, 'rejected')
  assert.equal(deleted.reason.code, 'blueprint/revision-conflict')
  await f.service.deleteDefinition({ blueprintId: doc.blueprintId, expectedRevision: saved.value.documentRevision, requestId: 'retry-delete' })
  await assert.rejects(f.service.startRun({ ...args(doc), requestId: 'stale-start' }), { code: 'blueprint/definition-deleted' })
  await assert.rejects(f.service.exportDefinition({ blueprintId: doc.blueprintId }), { code: 'blueprint/definition-deleted' })
})

test('L05: failed state write leaves document visible; corrupt state fails closed; backup retains deletion', async t => {
  const f = await fixture(t)
  const doc = await f.service.createDefinition({ requestId: 'state', definitionJson: JSON.stringify(definition()) })
  const library = join(f.root, 'data/xuanling-blueprint/definitions')
  const state = join(library, '.library-state')
  writeFileSync(join(state, 'deleted'), 'not a directory')
  await assert.rejects(f.service.deleteDefinition({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, requestId: 'del' }), {
    code: 'blueprint/library-state-invalid'
  })
  rmSync(join(state, 'deleted'))
  assert.equal((await f.service.listDefinitions()).definitions.length, 1)
  await f.service.deleteDefinition({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, requestId: 'del' })
  cpSync(library, join(f.root, 'backup'), { recursive: true })
  const file = join(state, 'deleted', readdirSync(join(state, 'deleted'))[0])
  writeFileSync(file, '{}')
  await assert.rejects(f.service.listDefinitions(), { code: 'blueprint/library-state-invalid' })
  rmSync(library, { recursive: true })
  cpSync(join(f.root, 'backup'), library, { recursive: true })
  assert.equal((await (await f.open()).service.listDefinitions()).definitions.length, 0)
})

test('A04/L05: exclusive library writer rejects competing mutation and releases after failure', async t => {
  const f = await fixture(t)
  const library = join(f.root, 'data/xuanling-blueprint/definitions')
  const lease = acquireLibraryWriter(library)
  const request = { requestId: 'lease', definitionJson: JSON.stringify(definition()) }
  try {
    await assert.rejects(f.service.createDefinition(request), { code: 'blueprint/library-busy' })
  } finally {
    lease.release()
  }
  const doc = await f.service.createDefinition(request)
  assert.equal((await f.service.loadDefinition({ blueprintId: doc.blueprintId })).documentRevision, doc.documentRevision)
})

test('A04: staging failure publishes no partial package and same target can be retried', async t => {
  const f = await fixture(t)
  const root = join(f.root, 'package')
  assert.throws(() =>
    publishPackage(root, definition(), [
      { path: 'lib/file', text: 'first' },
      { path: 'lib/file/child', text: 'cannot write under a file' }
    ])
  )
  assert.equal(existsSync(root), false)
  assert.equal(
    readdirSync(f.root).some(name => name.startsWith('.authoring-stage-')),
    false
  )
  const doc = publishPackage(root, definition(), [])
  assert.equal(doc.blueprintId, 'draft')
})

test('L06: deletion does not remove configured package bytes or bypass existing alias ID validation', async t => {
  const f = await fixture(t)
  const doc = await f.service.createDefinition({ requestId: 'alias', definitionJson: JSON.stringify(definition()) })
  const library = join(f.root, 'data/xuanling-blueprint/definitions'),
    root = join(library, doc.blueprintId)
  f.service.config.blueprints = { alias: root }
  const before = readFileSync(join(root, 'blueprint.json'))
  await assert.rejects(f.service.loadDefinition({ blueprintId: 'alias' }), { code: 'blueprint/definition-invalid' })
  await f.service.deleteDefinition({ blueprintId: doc.blueprintId, expectedRevision: doc.documentRevision, requestId: 'delete-original' })
  assert.deepEqual(readFileSync(join(root, 'blueprint.json')), before)
  assert.equal(readLibraryDeletion(library, 'alias'), undefined)
  await assert.rejects(f.service.loadDefinition({ blueprintId: 'alias' }), { code: 'blueprint/definition-invalid' })
})
