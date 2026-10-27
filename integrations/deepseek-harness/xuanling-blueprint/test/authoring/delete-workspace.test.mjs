import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace, draftKey, newDraftKey } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'

function fixture() {
  const data = new Map(),
    calls = []
  const document = id => ({
    blueprintId: id,
    documentRevision: 'rev',
    semanticRevision: 'sem',
    layoutRevision: 'layout',
    definitionJson: JSON.stringify({ schemaVersion: 2, id, name: id, resources: {}, graph: { nodes: [], edges: [] } })
  })
  const host = {
    listDefinitions: async () => ({ definitions: ['a', 'b'].map(id => ({ blueprintId: id, name: id, documentRevision: 'rev', semanticRevision: 'sem' })) }),
    loadDefinition: async id => document(id),
    validate: async () => ({ ok: true }),
    deleteDefinition: async (...args) => {
      calls.push(args)
      return { blueprintId: args[0], deleted: true }
    }
  }
  const workspace = new BlueprintWorkspace(host, { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) })
  return { workspace, host, data, calls }
}

test('L01/L02: local draft deletion never calls host; dirty document deletion never saves', async () => {
  const { workspace: w, data, calls } = fixture()
  w.newDraft()
  const draft = w.blueprintId
  await w.deleteCurrent()
  assert.notEqual(w.blueprintId, draft)
  assert.equal(calls.length, 0)
  await w.initialize()
  await w.load('a')
  w.editor.addNode({ kind: 'input', label: 'Input', x: 0, y: 0, inputs: {}, outputs: {} })
  await w.deleteCurrent()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'rev')
  assert.equal(w.isNewDraft, true)
  assert.equal(
    w.catalog.some(x => x.blueprintId === 'a'),
    false
  )
  assert.equal(data.get(draftKey('a')), '')
  assert.ok(data.get(newDraftKey()))
})

test('L02: failed delete retains buffer and retry id; late completion never switches documents', async () => {
  const { workspace: w, host, data } = fixture()
  await w.initialize()
  await w.load('a')
  w.editor.addNode({ kind: 'input', label: 'Input', x: 0, y: 0, inputs: {}, outputs: {} })
  const requests = []
  host.deleteDefinition = async (...args) => {
    requests.push(args)
    throw new Error('network')
  }
  const before = data.get(draftKey('a'))
  await assert.rejects(w.deleteCurrent())
  assert.equal(data.get(draftKey('a')), before)
  assert.equal(w.blueprintId, 'a')
  let finish
  host.deleteDefinition = (...args) => {
    requests.push(args)
    return new Promise(resolve => {
      finish = resolve
    })
  }
  const pending = w.deleteCurrent()
  await w.load('b')
  finish({ blueprintId: 'a', deleted: true })
  await pending
  assert.equal(w.blueprintId, 'b')
  assert.equal(requests[0][2], requests[1][2])
  assert.equal(data.get(draftKey('a')), '')
})
