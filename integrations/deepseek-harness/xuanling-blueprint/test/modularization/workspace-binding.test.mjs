import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace, draftKey } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'

test('Workspace exposes the missing data binding boundary', () => {
  const value = new BlueprintWorkspace(undefined)
  assert.equal(typeof value.acceptsViewBinding, 'function', 'WORKSPACE_VIEW_BINDING_BOUNDARY_MISSING')
  assert.equal(typeof value.getSnapshot().binding?.instanceId, 'string')
  const initial = value.getSnapshot().binding
  assert.equal(value.acceptsViewBinding(initial), true)
  assert.equal(value.acceptsViewBinding({ ...initial, editorEpoch: initial.editorEpoch + 1 }), false)
  value.newDraft('draft')
  const draft = value.getSnapshot().binding
  assert.notEqual(draft.editorEpoch, initial.editorEpoch)
  assert.equal(value.acceptsViewBinding(initial), false)
  assert.equal(value.acceptsViewBinding(draft), true)
  value.dispose()
  assert.equal(value.acceptsViewBinding(draft), false)
})

test('view binding rejects the previous published editor during asynchronous draft restoration', async () => {
  let resolveValidation
  let validationStarted
  const started = new Promise(resolve => {
    validationStarted = resolve
  })
  const validation = new Promise(resolve => {
    resolveValidation = resolve
  })
  const definition = { schemaVersion: 1, id: 'target', name: 'Target', resources: {}, graph: { nodes: [], edges: [] } }
  const document = {
    blueprintId: 'target',
    documentRevision: 'r1',
    semanticRevision: 's1',
    layoutRevision: 'l1',
    definitionJson: JSON.stringify(definition)
  }
  const writes = []
  const value = new BlueprintWorkspace(
    {
      loadDefinition: async () => document,
      validate: () => {
        validationStarted()
        return validation
      }
    },
    {
      getItem: key => (key === draftKey('target') ? JSON.stringify({ documentRevision: 'r1', definitionJson: JSON.stringify(definition), layout: {} }) : null),
      setItem: (...args) => writes.push(args)
    }
  )
  value.catalog = [{ blueprintId: 'target', name: 'Target', documentRevision: 'r1', semanticRevision: 's1' }]
  const loading = value.load('target')
  const loadingSnapshot = value.getSnapshot()
  const loadingEditor = value.editor
  try {
    await started
    assert.equal(value.getSnapshot(), loadingSnapshot, 'the previous snapshot remains published while validation is pending')
    assert.notEqual(value.editor, loadingEditor)
    assert.equal(value.blueprintId, 'target')
    assert.equal(value.document.documentRevision, 'r1')
    assert.equal(value.acceptsViewBinding(loadingSnapshot.binding), false, 'STALE_PUBLISHED_VIEW_BINDING_ACCEPTED')
    assert.deepEqual(writes, [])
  } finally {
    resolveValidation({ ok: true })
    await loading
    value.dispose()
  }
})

test('view bindings reject other instances and malformed identities without publishing or writing', () => {
  const writes = []
  const value = new BlueprintWorkspace(undefined, { getItem: () => null, setItem: (...args) => writes.push(args) })
  const other = new BlueprintWorkspace(undefined)
  const snapshot = value.getSnapshot()
  let notifications = 0
  value.subscribe(() => notifications++)
  for (const binding of [null, {}, other.getSnapshot().binding, { ...snapshot.binding, editorEpoch: -1 }, { ...snapshot.binding, documentRevision: 1 }]) {
    assert.equal(value.acceptsViewBinding(binding), false)
  }
  assert.equal(value.getSnapshot(), snapshot)
  assert.equal(notifications, 0)
  assert.deepEqual(writes, [])
  value.dispose()
  other.dispose()
})
