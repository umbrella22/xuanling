/** C-07/C-08/C-10 production workspace and wire contracts, not browser proof. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { BlueprintWorkspace } from '../../src/client/workspace.ts'
import { resolveBlueprintHost } from '../../src/client/remote.ts'

const definition = id => ({
  schemaVersion: 1,
  id,
  name: '用户.ID',
  resources: {},
  graph: {
    nodes: [{ id: 'user-source', kind: 'input', outputs: { value: 'string' } }],
    edges: []
  }
})
function fixture(options = {}) {
  const docs = new Map(['one', 'two'].map(id => [id, definition(id)])),
    calls = []
  const doc = id => ({
    blueprintId: id,
    definitionJson: JSON.stringify(docs.get(id)),
    documentRevision: JSON.stringify(docs.get(id)),
    semanticRevision: 'sem-' + id,
    layoutRevision: 'layout'
  })
  const report = (id, revision) => ({
    blueprintId: id,
    documentRevision: revision,
    semanticRevision: 'sem-' + id,
    canStart: options.canStart ?? true,
    checks: ['block', 'warning', 'info', 'pass']
      .filter(s => s !== 'block' || options.canStart === false)
      .map(status => ({ code: 'fixture-' + status, status, nodeId: 'user-source' }))
  })
  let starts = 0
  const host = {
    async listDefinitions() {
      return {
        definitions: [...docs.keys()].map(id => ({
          blueprintId: id,
          name: id,
          documentRevision: doc(id).documentRevision,
          semanticRevision: doc(id).semanticRevision
        }))
      }
    },
    async loadDefinition(id) {
      return doc(id)
    },
    async validate(json) {
      return { ok: true, semanticRevision: 'sem-' + JSON.parse(json).id }
    },
    async saveDefinition(id, json, expectedRevision) {
      calls.push(['save', { id, json, expectedRevision }])
      await options.onSave?.()
      docs.set(id, JSON.parse(json))
      return doc(id)
    },
    async preflightRun(id, revision, inputJson) {
      calls.push(['check', { id, revision, inputJson }])
      return options.check ? options.check(report(id, revision)) : report(id, revision)
    },
    async startRun(id, revision, inputJson, requestId) {
      calls.push(['start', { id, revision, inputJson, requestId }])
      starts++
      if (starts <= (options.failStarts ?? 0)) throw Object.assign(new Error('do not expose provider body'), { code: 'blueprint/transport-unavailable' })
      return { runId: 'run-' + id, semanticRevision: 'sem-' + id, state: 'queued', replayed: starts > 1 }
    },
    async inspectRun(runId) {
      return { runId, state: 'succeeded', seq: 1, definitionRevision: 'sem-one', attempts: [], logTail: [] }
    }
  }
  const map = new Map(),
    storage = { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) }
  const workspace = new BlueprintWorkspace(host, storage)
  return {
    workspace,
    host,
    calls,
    docs,
    report,
    async load() {
      await workspace.initialize()
      await workspace.load('one')
    }
  }
}
const code = expected => error => error?.code === expected

test('C-07 check saves first; binds exact documentRevision and unmodified input; Run still calls Host', async () => {
  const f = fixture()
  await f.load()
  f.workspace.inputJson = '{ "用户.port": "original" }'
  f.workspace.editor.updateNode('user-source', { outputs: { value: 'number' } })
  await f.workspace.checkRun()
  const view = f.workspace.preflight
  assert.equal(view.status, 'current')
  assert.equal(view.report.canStart, true)
  assert.deepEqual(
    f.calls.map(c => c[0]),
    ['save', 'check']
  )
  assert.equal(view.documentRevision, f.workspace.document.documentRevision)
  assert.equal(view.inputJson, f.workspace.inputJson)
  const detached = f.workspace.preflight
  detached.report.checks[0].code = 'MUTATED'
  assert.notEqual(f.workspace.preflight.report.checks[0].code, 'MUTATED')
  await f.workspace.run()
  assert.deepEqual(
    f.calls.map(c => c[0]),
    ['save', 'check', 'save', 'check', 'start']
  )
  const request = f.calls.at(-1)[1]
  assert.equal(request.revision, f.workspace.document.documentRevision)
  assert.equal(request.inputJson, '{ "用户.port": "original" }')
  assert.equal(f.workspace.runId, 'run-one')
})
test('C-07 blocked/contradictory reports and Host refusal cannot fall through to admission', async () => {
  for (const options of [{ canStart: false }, { check: r => ({ ...r, canStart: true, checks: [{ code: 'blocked', status: 'block' }] }) }]) {
    const f = fixture(options)
    await f.load()
    await assert.rejects(f.workspace.run(), code('blueprint/preflight-blocked'))
    assert.equal(f.calls.filter(c => c[0] === 'start').length, 0)
    assert.equal(f.workspace.preflight.status, 'current')
  }
  const f = fixture()
  await f.load()
  f.host.startRun = async () => {
    throw Object.assign(new Error('opaque'), { code: 'blueprint/preflight-blocked' })
  }
  await assert.rejects(f.workspace.run(), code('blueprint/preflight-blocked'))
  assert.equal(f.workspace.runId, null)
})
for (const change of ['input', 'semantic', 'generation', 'input-roundtrip', 'semantic-roundtrip']) {
  test(`C-07 delayed canStart invalidated by ${change}, no start and no stale overwrite`, async () => {
    const pending = Promise.withResolvers(),
      seen = Promise.withResolvers()
    const f = fixture({
      check: r => {
        seen.resolve(r)
        return pending.promise
      }
    })
    await f.load()
    const operation = f.workspace.run()
    const before = await seen.promise
    if (change.startsWith('input')) {
      f.workspace.inputJson = '{"changed":true}'
      if (change === 'input-roundtrip') f.workspace.inputJson = '{}'
    }
    if (change.startsWith('semantic')) {
      f.workspace.editor.updateNode('user-source', { outputs: { value: 'boolean' } })
      if (change === 'semantic-roundtrip') f.workspace.editor.undo()
    }
    if (change === 'generation') await f.workspace.load('two')
    assert.equal(f.workspace.preflight.status, 'stale')
    pending.resolve(before)
    await assert.rejects(operation, code('blueprint/preflight-stale'))
    assert.equal(f.calls.filter(c => c[0] === 'start').length, 0)
    assert.equal(f.workspace.preflight.status, 'stale')
    if (change === 'generation') assert.equal(f.workspace.blueprintId, 'two')
  })
}
test('C-07 newer check wins even if the old response arrives last', async () => {
  const old = Promise.withResolvers(),
    seen = Promise.withResolvers()
  let count = 0
  const f = fixture({ check: r => (++count === 1 ? (seen.resolve(r), old.promise) : r) })
  await f.load()
  const first = f.workspace.checkRun()
  const oldReport = await seen.promise
  f.workspace.inputJson = '{"new":true}'
  await f.workspace.checkRun()
  const current = f.workspace.preflight
  old.resolve(oldReport)
  await assert.rejects(first, code('blueprint/preflight-stale'))
  assert.deepEqual(f.workspace.preflight, current)
  assert.equal(f.workspace.preflight.inputJson, '{"new":true}')
})
test('C-07 edits during save (including revert) must not start a check on a new captured payload', async () => {
  const saved = Promise.withResolvers(),
    seen = Promise.withResolvers()
  const f = fixture({
    onSave: () => {
      seen.resolve()
      return saved.promise
    }
  })
  await f.load()
  const operation = f.workspace.run()
  await seen.promise
  f.workspace.inputJson = '{"new":1}'
  f.workspace.inputJson = '{}'
  saved.resolve()
  await assert.rejects(operation, code('blueprint/preflight-stale'))
  assert.equal(f.calls.filter(c => c[0] === 'check' || c[0] === 'start').length, 0)
})
test('C-07 transport retry uses identical pending requestId; changed payload gets a new ID', async () => {
  const f = fixture({ failStarts: 2 })
  await f.load()
  await assert.rejects(f.workspace.run(), code('blueprint/transport-unavailable'))
  await assert.rejects(f.workspace.run(), code('blueprint/transport-unavailable'))
  const starts = f.calls.filter(c => c[0] === 'start')
  assert.equal(starts[0][1].requestId, starts[1][1].requestId)
  f.workspace.inputJson = '{"changed":1}'
  await f.workspace.run()
  assert.notEqual(f.calls.filter(c => c[0] === 'start')[2][1].requestId, starts[0][1].requestId)
})
test('C-07 legacy Host is explicitly unavailable; malformed strict reports are typed failures without raw errors', async () => {
  const f = fixture()
  delete f.host.preflightRun
  await f.load()
  await assert.rejects(f.workspace.run(), code('blueprint/capability-unavailable'))
  assert.equal(f.workspace.preflight.status, 'unavailable')
  assert.equal(f.calls.length, 0)
  for (const mutate of [
    r => ({ ...r, rawPrompt: 'RAW_SENTINEL' }),
    r => ({ ...r, checks: [{ code: 'fixture-ready', status: 'pass', rawError: 'RAW_SENTINEL' }] }),
    r => ({ ...r, checks: [{ code: 'invalid', status: 'ok' }] })
  ]) {
    const bad = fixture({ check: mutate })
    await bad.load()
    await assert.rejects(bad.workspace.run(), code('blueprint/dto-invalid'))
    assert.equal(bad.workspace.preflight.status, 'failed')
    assert.equal(JSON.stringify(bad.workspace.preflight).includes('RAW_SENTINEL'), false)
    assert.equal(bad.calls.filter(c => c[0] === 'start').length, 0)
  }
})
test('C-07 unrelated revision/blueprint/semantic response never authorizes start', async () => {
  for (const field of ['blueprintId', 'documentRevision', 'semanticRevision']) {
    const f = fixture({ check: r => ({ ...r, [field]: 'unrelated' }) })
    await f.load()
    await assert.rejects(f.workspace.run(), code('blueprint/preflight-stale'))
    assert.equal(f.workspace.preflight.status, 'stale')
    assert.equal(f.calls.filter(c => c[0] === 'start').length, 0)
  }
})
test('C-07 wire reuses strict descriptor and preserves namespace receiver; old namespace fails closed', async () => {
  const args = { blueprintId: 'id', expectedRevision: 'doc', inputJson: 'false' }
  const report = {
    blueprintId: 'id',
    documentRevision: 'doc',
    semanticRevision: 'sem',
    canStart: true,
    checks: ['block', 'warning', 'info', 'pass'].map(status => ({ code: status, status }))
  }
  const ns = {
    async preflightRun(actual) {
      assert.equal(this, ns)
      assert.deepEqual(actual, args)
      return { ok: true, value: report }
    }
  }
  const host = resolveBlueprintHost({ get: () => ns })
  assert.deepEqual(await host.preflightRun('id', 'doc', 'false'), report)
  ns.preflightRun = async () => ({ ok: true, value: { ...report, raw: 'PRIVATE' } })
  await assert.rejects(host.preflightRun('id', 'doc', 'false'), code('blueprint/dto-invalid'))
  delete ns.preflightRun
  await assert.rejects(host.preflightRun('id', 'doc', 'false'), code('blueprint/capability-unavailable'))
})
test('C-08/C-10 presentation/renderer changes preserve semantic check, selection, input, history and Run binding', async () => {
  const f = fixture()
  await f.load()
  await f.workspace.run()
  await f.workspace.checkRun()
  const report = f.workspace.preflight.report,
    payload = f.workspace.inputJson,
    editor = f.workspace.editor
  editor.selection.add('user-source')
  editor.beginLayout()
  editor.moveNode('user-source', 250, 300)
  editor.commitLayout()
  assert.equal(f.workspace.preflight.status, 'current')
  assert.deepEqual(f.workspace.preflight.report, report)
  assert.equal(editor.selection.has('user-source'), true)
  assert.equal(f.workspace.inputJson, payload)
  assert.equal(f.workspace.runId, 'run-one')
  assert.equal(editor.undo(), true)
  assert.equal(editor.redo(), true)
  await f.workspace.save()
  assert.equal(f.workspace.preflight.status, 'stale', 'changed saved document revision invalidates the report even for layout-only edits')
})
