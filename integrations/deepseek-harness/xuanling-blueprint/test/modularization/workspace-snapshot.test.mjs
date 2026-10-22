import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'

const run = {
  runId: 'run-one',
  state: 'running',
  seq: 0,
  definitionRevision: 'semantic-one',
  attempts: [{ nodeId: 'input', attempt: 1, state: 'running' }],
  logTail: []
}
function workspace() {
  const writes = []
  const value = new BlueprintWorkspace(undefined, { getItem: () => null, setItem: (...args) => writes.push(args) })
  return { value, writes }
}

test('Workspace supplies the missing immutable snapshot boundary', () => {
  const { value } = workspace()
  assert.equal(typeof value.getSnapshot, 'function', 'WORKSPACE_SNAPSHOT_BOUNDARY_MISSING')
})
test('snapshot reads are cached and published before existing subscriber callbacks', () => {
  const { value } = workspace()
  const initial = value.getSnapshot()
  assert.equal(value.getSnapshot(), initial)
  const seen = []
  value.subscribe(() => seen.push(value.getSnapshot()))
  value.inputJson = '{"a":1}'
  assert.equal(seen.length, 1)
  assert.equal(seen[0], value.getSnapshot())
  assert.equal(seen[0].inputJson, '{"a":1}')
  assert.equal(initial.inputJson, '{}')
  value.model.markDisconnected()
  const disconnected = value.getSnapshot()
  value.model.markDisconnected()
  assert.equal(value.getSnapshot(), disconnected, 'unchanged emit must preserve snapshot identity')
  assert.equal(seen.length, 3, 'W3.1 does not deduplicate existing notifications')
})
test('snapshots detach nested editor, catalog, notice and Run data without freezing mutable compatibility fields', () => {
  const { value } = workspace()
  value.newDraft('snapshot draft')
  value.catalog = [{ blueprintId: 'example', name: 'original', documentRevision: null, semanticRevision: null }]
  value.notice = { key: 'status.error', params: { code: 'typed-code' } }
  value.model.applySnapshot(run)
  const snapshot = value.getSnapshot()
  assert.ok(Object.isFrozen(snapshot))
  assert.throws(() => {
    snapshot.definition.name = 'mutated'
  }, TypeError)
  assert.throws(() => {
    snapshot.catalog[0].name = 'mutated'
  }, TypeError)
  assert.throws(() => {
    snapshot.notice.params.code = 'mutated'
  }, TypeError)
  assert.throws(() => {
    snapshot.run.snapshot.attempts[0].state = 'succeeded'
  }, TypeError)
  value.catalog[0].name = 'still-mutable'
  value.notice.params.code = 'still-mutable'
  value.model.view.attempts[0].state = 'failed'
  assert.equal(snapshot.catalog[0].name, 'original')
  assert.equal(snapshot.notice.params.code, 'typed-code')
  assert.equal(snapshot.run.snapshot.attempts[0].state, 'running')
  assert.equal(value.definition.name, 'snapshot draft')
})
test('model-only updates reuse the editor segment and initial editor is observed without storage effects', () => {
  const { value, writes } = workspace()
  const initial = value.getSnapshot()
  value.editor.setSelection(['initial'])
  assert.deepEqual(value.getSnapshot().editor.selection, ['initial'])
  assert.notEqual(value.getSnapshot().editor, initial.editor)
  assert.equal(writes.length, 0)
  value.newDraft('real editor')
  const before = value.getSnapshot()
  value.model.applySnapshot(run)
  const after = value.getSnapshot()
  assert.equal(after.editor, before.editor)
  assert.equal(after.definition, before.definition)
  value.editor.setSelection(['later'])
  assert.deepEqual(value.getSnapshot().editor.selection, ['later'])
  assert.deepEqual(before.editor.selection, [])
})
test('snapshots are isolated per Workspace and document omits duplicated wire JSON', () => {
  const a = workspace().value
  const b = workspace().value
  a.newDraft('a')
  b.newDraft('b')
  a.document = {
    blueprintId: a.blueprintId,
    documentRevision: 'doc',
    semanticRevision: 'semantic',
    layoutRevision: 'layout',
    definitionJson: 'RAW_NOT_A_VIEW_FIELD'
  }
  a.inputJson = '{"publish":true}'
  assert.equal(Object.hasOwn(a.getSnapshot().document, 'definitionJson'), false)
  assert.equal(a.getSnapshot().document.documentRevision, 'doc')
  assert.equal(b.getSnapshot().definition.name, 'b')
  assert.notEqual(a.getSnapshot().editor, b.getSnapshot().editor)
})

test('run binding, stream progression, gap and reset publish while duplicate sequences stay ignored', () => {
  const { value } = workspace()
  const seen = []
  value.subscribe(() => seen.push(value.getSnapshot()))
  value.runId = 'run-one'
  assert.equal(seen.at(-1).run.runId, 'run-one')
  const bound = value.getSnapshot()
  const count = seen.length
  value.runId = 'run-one'
  assert.equal(seen.length, count)
  assert.equal(value.getSnapshot(), bound)
  value.model.applySnapshot(run)
  const authoritative = value.getSnapshot()
  assert.equal(authoritative.run.overlayEligible, false)
  assert.equal(authoritative.run.snapshot.attempts[0].state, 'running')
  value.model.applyEvent({ seq: 1, kind: 'state', detail: { state: 'succeeded' } })
  const progressed = value.getSnapshot()
  assert.equal(progressed.run.snapshot.state, 'succeeded')
  assert.equal(authoritative.run.snapshot.state, 'running')
  value.model.applyEvent({ seq: 1, kind: 'state', detail: { state: 'failed' } })
  assert.equal(value.getSnapshot(), progressed)
  value.model.applyEvent({ seq: 3, kind: 'state', detail: { state: 'failed' } })
  assert.equal(value.getSnapshot().run.connectionState, 'stale')
  assert.equal(value.getSnapshot().run.snapshot.state, 'succeeded')
  value.model.reset()
  assert.equal(value.getSnapshot().run.snapshot, null)
  assert.equal(value.getSnapshot().run.connectionState, 'connected')
})

test('resource refresh publishes loading, current and unavailable without retaining response objects', async () => {
  const entries = [{ id: 'agent', kind: 'agent', displayName: 'Agent', description: '', source: 'dsh', availability: 'available', provenance: 'builtin' }]
  let reject = false
  const value = new BlueprintWorkspace({
    listResources: async () => {
      if (reject) throw new Error('private')
      return { resources: entries }
    }
  })
  const states = []
  value.subscribe(() => states.push(value.getSnapshot().resources.state))
  await value.refreshResources()
  assert.deepEqual(states, ['loading', 'current'])
  const current = value.getSnapshot()
  entries[0].displayName = 'mutable response'
  assert.equal(current.resources.entries[0].displayName, 'Agent')
  reject = true
  await value.refreshResources()
  assert.deepEqual(states, ['loading', 'current', 'loading', 'unavailable'])
  assert.equal(value.getSnapshot().resources.state, 'unavailable')
})

test('pending document load keeps snapshot definition visibility aligned with the public getter', async () => {
  let resolve
  const pending = new Promise(accept => {
    resolve = accept
  })
  const value = new BlueprintWorkspace({ loadDefinition: () => pending })
  value.catalog = [{ blueprintId: 'target', name: 'Target', documentRevision: 'document-one', semanticRevision: 'semantic-one' }]
  const loading = value.load('target')
  assert.equal(value.blueprintId, null)
  assert.equal(value.definition, null)
  assert.equal(value.getSnapshot().definition, null, 'PENDING_LOAD_DEFINITION_VISIBILITY_MISMATCH')
  resolve({
    blueprintId: 'target',
    documentRevision: 'document-one',
    semanticRevision: 'semantic-one',
    layoutRevision: 'layout-one',
    definitionJson: JSON.stringify({ schemaVersion: 2, id: 'target', name: 'Target', resources: {}, graph: { nodes: [], edges: [] } })
  })
  await loading
  assert.deepEqual(value.getSnapshot().definition, value.definition)
})

test('model-only publications do not export the editor graph', () => {
  const { value } = workspace()
  value.newDraft('export counter')
  let exports = 0
  const original = value.editor.exportDefinition.bind(value.editor)
  value.editor.exportDefinition = () => {
    exports++
    return original()
  }
  const editor = value.getSnapshot().editor
  const definition = value.getSnapshot().definition
  value.model.applySnapshot(run)
  value.model.applyEvent({ seq: 1, kind: 'state', detail: { state: 'succeeded' } })
  value.model.markDisconnected()
  value.model.reset()
  assert.equal(exports, 0)
  assert.equal(value.getSnapshot().editor, editor)
  assert.equal(value.getSnapshot().definition, definition)
})

test('published definition and dirty getters reuse the captured editor generation', () => {
  const { value } = workspace()
  value.newDraft('getter snapshot')
  let exports = 0
  const original = value.editor.exportDefinition.bind(value.editor)
  value.editor.exportDefinition = () => {
    exports++
    return original()
  }
  const before = value.getSnapshot()
  void value.definition
  void value.dirty
  void value.needsNavigationConfirmation
  assert.equal(exports, 0, 'W4.4 SNAPSHOT_GETTER_EXPORT_RED: render-facing getters re-export the live graph')
  assert.equal(value.getSnapshot().definition, before.definition)
})
