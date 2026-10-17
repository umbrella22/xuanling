import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'

test('resource refresh rejection from an older read cannot clear a newer catalog or publish', async () => {
  const pending = []
  const workspace = new BlueprintWorkspace({
    listResources: () => {
      const read = Promise.withResolvers()
      pending.push(read)
      return read.promise
    }
  })
  const first = workspace.refreshResources()
  const second = workspace.refreshResources()
  const entry = { source: 'dsh', kind: 'agent', id: 'current', displayName: 'Current', description: '', availability: 'available' }
  pending[1].resolve({ resources: [entry] })
  await second
  const current = workspace.getSnapshot()
  let publications = 0
  const unsubscribe = workspace.subscribe(() => publications++)
  pending[0].reject(new Error('older resource request failed'))
  await first
  assert.equal(workspace.resourceCatalogState, 'current', 'OLD_RESOURCE_ERROR_REPLACED_CURRENT_STATE')
  assert.deepEqual(workspace.resourceCatalog, [entry], 'OLD_RESOURCE_ERROR_CLEARED_CURRENT_ENTRIES')
  assert.equal(workspace.getSnapshot(), current)
  assert.equal(publications, 0)
  unsubscribe()
  workspace.dispose()
})

test('resource refresh invokes the Host capability with its original receiver', async () => {
  let calls = 0
  const host = {
    async listResources() {
      assert.equal(this, host, 'RESOURCE_HOST_RECEIVER_LOST')
      calls++
      return { resources: [] }
    }
  }
  const workspace = new BlueprintWorkspace(host)
  await workspace.refreshResources()
  assert.equal(calls, 1, 'RESOURCE_HOST_CAPABILITY_NOT_COMPLETED')
  assert.equal(workspace.resourceCatalogState, 'current')
  workspace.dispose()
})

const navigationDocument = id => ({
  blueprintId: id,
  documentRevision: `doc-${id}`,
  semanticRevision: `semantic-${id}`,
  layoutRevision: 'layout',
  definitionJson: JSON.stringify({ schemaVersion: 1, id, name: id, resources: {}, graph: { nodes: [], edges: [] } })
})
const navigationCatalog = ['one', 'two'].map(id => ({ blueprintId: id, name: id, documentRevision: `doc-${id}`, semanticRevision: `semantic-${id}` }))

test('navigation during draft validation prevents late restoration and publication in the next document', async () => {
  const validation = Promise.withResolvers()
  const started = Promise.withResolvers()
  const workspace = new BlueprintWorkspace(
    {
      loadDefinition: async id => navigationDocument(id),
      validate: () => {
        started.resolve()
        return validation.promise
      }
    },
    {
      getItem: key =>
        key === 'xuanling-blueprint:draft:one'
          ? JSON.stringify({ documentRevision: 'doc-one', definitionJson: navigationDocument('one').definitionJson, layout: {} })
          : null,
      setItem: () => assert.fail('navigation must not persist a draft')
    }
  )
  workspace.catalog = navigationCatalog
  const oldLoad = workspace.load('one')
  await started.promise
  await workspace.load('two')
  const current = workspace.getSnapshot()
  let publications = 0
  workspace.subscribe(() => publications++)
  validation.resolve({ ok: true })
  await oldLoad
  assert.equal(workspace.blueprintId, 'two', 'OLD_DRAFT_VALIDATION_REBOUND_DOCUMENT')
  assert.equal(workspace.getSnapshot(), current)
  assert.equal(workspace.notice.key, 'status.loaded')
  assert.equal(publications, 0)
  workspace.dispose()
})

test('a late document read cannot replace a newer navigation or publish its loaded notice', async () => {
  const old = Promise.withResolvers()
  const workspace = new BlueprintWorkspace({ loadDefinition: id => (id === 'one' ? old.promise : Promise.resolve(navigationDocument(id))) })
  workspace.catalog = navigationCatalog
  const first = workspace.load('one')
  await workspace.load('two')
  const current = workspace.getSnapshot()
  let publications = 0
  workspace.subscribe(() => publications++)
  old.resolve(navigationDocument('one'))
  await first
  assert.equal(workspace.blueprintId, 'two', 'OLD_DOCUMENT_READ_REBOUND_DOCUMENT')
  assert.equal(workspace.getSnapshot(), current)
  assert.equal(publications, 0)
  workspace.dispose()
})

test('existing document save keeps edits made while awaiting the accepted baseline', async () => {
  const pending = Promise.withResolvers()
  let submitted
  const workspace = new BlueprintWorkspace({
    loadDefinition: async id => navigationDocument(id),
    saveDefinition: (id, json, revision) => {
      assert.equal(id, 'one')
      assert.equal(revision, 'doc-one')
      submitted = json
      return pending.promise
    }
  })
  workspace.catalog = navigationCatalog
  await workspace.load('one')
  workspace.editor.renameDefinition('submitted')
  const saving = workspace.save()
  workspace.editor.renameDefinition('edited during save')
  pending.resolve({ ...navigationDocument('one'), documentRevision: 'accepted', definitionJson: submitted })
  await saving
  assert.equal(workspace.document.documentRevision, 'accepted')
  assert.equal(JSON.parse(workspace.document.definitionJson).name, 'submitted')
  assert.equal(workspace.editor.exportDefinition().name, 'edited during save', 'SAVE_REPLACED_CONCURRENT_EDIT')
  assert.equal(workspace.dirty, true)
  workspace.dispose()
})

test('existing document save completing after navigation cannot adopt or publish in the next document', async () => {
  const pending = Promise.withResolvers()
  const workspace = new BlueprintWorkspace({
    loadDefinition: async id => navigationDocument(id),
    saveDefinition: () => pending.promise
  })
  workspace.catalog = navigationCatalog
  await workspace.load('one')
  const saving = workspace.save()
  const rejected = assert.rejects(saving, /Document changed while saving/)
  await workspace.load('two')
  const current = workspace.getSnapshot()
  let publications = 0
  workspace.subscribe(() => publications++)
  pending.resolve({ ...navigationDocument('one'), documentRevision: 'late' })
  await rejected
  assert.equal(workspace.blueprintId, 'two', 'SAVE_REBOUND_PREVIOUS_DOCUMENT')
  assert.equal(workspace.document.documentRevision, 'doc-two')
  assert.equal(workspace.getSnapshot(), current)
  assert.equal(publications, 0)
  workspace.dispose()
})

test('run preserves dynamic checkRun dispatch before any Host admission', async () => {
  const workspace = new BlueprintWorkspace(undefined)
  const sentinel = new Error('dynamic preflight stopped admission')
  let checks = 0
  workspace.checkRun = async () => {
    checks++
    throw sentinel
  }
  await assert.rejects(workspace.run(), error => error === sentinel, 'RUN_BYPASSED_DYNAMIC_CHECK_RUN')
  assert.equal(checks, 1)
  workspace.dispose()
})
