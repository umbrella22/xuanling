import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { resolveBlueprintHost, BlueprintRemoteError } from '../../src/client/adapters/host/remote.ts'
const definition = id => ({
  schemaVersion: 2,
  id,
  name: id,
  resources: {},
  graph: { nodes: [{ id: 'a', kind: 'input', outputs: { raw: 'string' } }], edges: [] },
  presentation: { nodes: { a: { x: 1, y: 2 } } }
})
const archive = id => ({ blueprintId: id, closureDigest: 'closure', files: 1, archiveSha256: 'digest', archiveBase64: 'UEs=', requiredBindings: [] })
const fixture = async () => {
  const calls = [],
    docs = new Map(
      ['flow', 'other'].map(id => [
        id,
        { blueprintId: id, definitionJson: JSON.stringify(definition(id)), documentRevision: 'v1', semanticRevision: 's1', layoutRevision: 'l1' }
      ])
    )
  const host = {
    listDefinitions: async () => ({
      definitions: ['flow', 'other', 'empty'].map(id => ({
        blueprintId: id,
        name: id,
        documentRevision: docs.get(id)?.documentRevision ?? null,
        semanticRevision: docs.get(id)?.semanticRevision ?? null
      }))
    }),
    loadDefinition: async id => structuredClone(docs.get(id)),
    saveDefinition: async (id, json, expected) => {
      calls.push(['save', id, expected])
      const doc = { blueprintId: id, definitionJson: json, documentRevision: 'v2', semanticRevision: 's1', layoutRevision: 'l2' }
      docs.set(id, doc)
      return structuredClone(doc)
    },
    exportDefinition: async id => {
      calls.push(['export', id])
      return archive(id)
    },
    importDefinition: async (id, bytes) => {
      calls.push(['import', id, bytes])
      docs.set(id, {
        blueprintId: id,
        definitionJson: JSON.stringify(definition(id)),
        documentRevision: 'imported',
        semanticRevision: 's1',
        layoutRevision: 'l1'
      })
      return { blueprintId: id, filesWritten: 1, closureDigest: 'closure' }
    }
  }
  const workspace = new BlueprintWorkspace(host)
  await workspace.initialize()
  await workspace.load('flow')
  return { workspace, host, calls, docs }
}
test('C09 remote exposes existing Host archive methods with receiver and DTO checks; no new invocations', async () => {
  const calls = [],
    namespace = {
      exportDefinition: async function (args) {
        assert.equal(this, namespace)
        calls.push(['export', args])
        return { ok: true, value: archive(args.blueprintId) }
      },
      importDefinition: async function (args) {
        assert.equal(this, namespace)
        calls.push(['import', args])
        return { ok: true, value: { blueprintId: args.blueprintId, filesWritten: 1, closureDigest: 'closure' } }
      }
    }
  const host = resolveBlueprintHost({
    get: key => {
      assert.equal(key, 'remote.blueprint')
      return namespace
    }
  })
  assert.deepEqual(await host.exportDefinition('flow'), archive('flow'))
  assert.equal((await host.importDefinition('empty', 'UEs=')).blueprintId, 'empty')
  assert.deepEqual(calls, [
    ['export', { blueprintId: 'flow' }],
    ['import', { blueprintId: 'empty', archiveBase64: 'UEs=' }]
  ])
  namespace.exportDefinition = async () => ({ ok: true, value: { archivePath: '/host/path' } })
  await assert.rejects(host.exportDefinition('flow'), error => error.code === 'blueprint/dto-invalid')
  namespace.importDefinition = async () => ({ ok: false, error: { code: 'blueprint/import-target-nonempty' } })
  await assert.rejects(host.importDefinition('flow', 'UEs='), error => error.code === 'blueprint/import-target-nonempty')
})
test('C09 dirty archive export first saves captured ID/CAS; current format retains every presentation field', async () => {
  const { workspace: w, calls } = await fixture()
  w.editor.patchPresentation(['a'], { title: 'raw title', collapsed: true, pinned: true, width: 300, height: 250, color: 'blue' })
  const value = await w.exportArchive()
  assert.deepEqual(value, archive('flow'))
  assert.deepEqual(calls, [
    ['save', 'flow', 'v1'],
    ['export', 'flow']
  ])
  const current = w.editor.exportDefinition()
  assert.deepEqual(current.presentation.nodes.a, { x: 1, y: 2, title: 'raw title', collapsed: true, pinned: true, width: 300, height: 250, color: 'blue' })
  assert.equal(w.dirty, false)
  assert.equal('exportLegacy' in w, false)
})
test('C09 export refuses CAS failure and never asks for archive on unaccepted save', async () => {
  const { workspace: w, host, calls } = await fixture()
  w.editor.patchPresentation(['a'], { title: 'dirty' })
  host.saveDefinition = async () => {
    throw new BlueprintRemoteError('blueprint/revision-conflict')
  }
  await assert.rejects(w.exportArchive(), error => error.code === 'blueprint/revision-conflict')
  assert.equal(w.dirty, true)
  assert.deepEqual(calls, [])
})
test('C09 late archive export after navigation is discarded and leaves destination unchanged', async () => {
  const { workspace: w, host } = await fixture()
  let release
  host.exportDefinition = id => new Promise(resolve => (release = () => resolve(archive(id))))
  const exporting = w.exportArchive()
  await w.load('other')
  const before = w.editor.exportDefinition()
  release()
  await assert.rejects(exporting, error => error.code === 'blueprint/document-stale')
  assert.deepEqual(w.editor.exportDefinition(), before)
})
for (const [id, confirmed, code] of [
  ['flow', 'flow', 'blueprint/import-target-nonempty'],
  ['missing', 'missing', 'blueprint/configured-id-required'],
  ['empty', '', 'blueprint/import-confirmation-required']
]) {
  test(`C09 import rejects ${code} before any Host write`, async () => {
    const { workspace: w, calls } = await fixture(),
      before = w.editor.exportDefinition()
    await assert.rejects(w.importArchive(id, 'UEs=', confirmed), error => error.code === code)
    assert.deepEqual(calls, [])
    assert.deepEqual(w.editor.exportDefinition(), before)
  })
}
test('C09 confirmed empty configured ID imports once via existing Host then loads its actual document', async () => {
  const { workspace: w, calls } = await fixture()
  await w.importArchive('empty', 'UEs=', 'empty')
  assert.deepEqual(calls, [['import', 'empty', 'UEs=']])
  assert.equal(w.blueprintId, 'empty')
  assert.equal(w.document.documentRevision, 'imported')
  assert.equal(w.editor.exportDefinition().id, 'empty')
  assert.equal(w.dirty, false)
})
test('C09 Host nonempty filesystem refusal stays typed, with current graph retained and no retry', async () => {
  const { workspace: w, host } = await fixture(),
    before = w.editor.exportDefinition()
  let calls = 0
  host.importDefinition = async () => {
    calls++
    throw new BlueprintRemoteError('blueprint/import-target-nonempty')
  }
  await assert.rejects(w.importArchive('empty', 'UEs=', 'empty'), error => error.code === 'blueprint/import-target-nonempty')
  assert.equal(calls, 1)
  assert.deepEqual(w.editor.exportDefinition(), before)
})
