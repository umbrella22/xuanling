import assert from 'node:assert/strict'
import test from 'node:test'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { InspectorSession } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import {
  acceptsConfirmationIntent,
  acceptsJsonIntent,
  acceptsOverlayIntent,
  acceptsSelectIntent,
  sameWorkspaceViewBinding,
  isWorkspaceViewBinding
} from '../../src/client/shared/contracts/view-contract.ts'

const binding = Object.freeze({ instanceId: 'ws-1', blueprintId: 'bp', editorEpoch: 2, documentRevision: 'rev-1' })
const definition = {
  schemaVersion: 1,
  id: 'bp',
  name: 'Blueprint',
  resources: {},
  graph: { nodes: [{ id: 'n', kind: 'input', inputs: {}, outputs: {} }], edges: [] }
}

test('view contracts are readonly data and reject malformed or stale bindings', () => {
  assert.equal(isWorkspaceViewBinding(binding), true)
  assert.equal(sameWorkspaceViewBinding(binding, { ...binding }), true)
  assert.equal(sameWorkspaceViewBinding(binding, { ...binding, editorEpoch: 3 }), false)
  assert.equal(isWorkspaceViewBinding({ ...binding, editorEpoch: -1 }), false)
  const state = {
    binding,
    value: 'a',
    disabled: false,
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true }
    ]
  }
  assert.equal(acceptsSelectIntent(state, { type: 'select-change', binding, value: 'a' }), true)
  assert.equal(acceptsSelectIntent(state, { type: 'select-change', binding, value: 'b' }), false)
  assert.equal(acceptsSelectIntent(state, { type: 'select-change', binding: { ...binding, editorEpoch: 1 }, value: 'a' }), false)
})

test('JSON buffer and commit intents are distinct and route through InspectorSession validation', () => {
  const editor = GraphEditor.fromDefinition(definition)
  const session = new InspectorSession(editor, 'n')
  const state = { binding, nodeId: 'n', field: 'options', buffer: '{}', disabled: false, notice: null }
  const before = JSON.stringify(editor.exportDefinition())
  assert.equal(acceptsJsonIntent(state, { type: 'json-buffer-change', binding, nodeId: 'n', field: 'options', text: '{bad' }), true)
  session.setJson('options', '{bad')
  assert.equal(JSON.stringify(editor.exportDefinition()), before)
  assert.equal(session.getSnapshot().json.options, '{bad')
  assert.equal(acceptsJsonIntent(state, { type: 'json-commit', binding, nodeId: 'n', field: 'options' }), true)
  session.applyJson('options')
  assert.equal(JSON.stringify(editor.exportDefinition()), before)
  assert.equal(session.getSnapshot().notice.key, 'inspector.invalidJsonRetained')
  assert.equal(acceptsJsonIntent({ ...state, disabled: true }, { type: 'json-commit', binding, nodeId: 'n', field: 'options' }), false)
})

test('overlay guards enforce kind and stale identity without invoking callbacks', () => {
  const state = { binding, kind: 'rename', disabled: false }
  assert.equal(acceptsOverlayIntent(state, { type: 'overlay-rename', binding, value: 'next' }), true)
  assert.equal(acceptsOverlayIntent(state, { type: 'overlay-import-ready', binding, blueprintId: 'bp', archiveBase64: 'YQ==' }), false)
  assert.equal(acceptsOverlayIntent(state, { type: 'overlay-close', binding: { ...binding, documentRevision: 'stale' } }), false)
})

test('confirmation action substitution and arbitrary overlay commands reject', () => {
  const state = { binding, action: { type: 'new-draft', name: ' exact ' }, title: 'New', cancelLabel: 'Cancel', confirmLabel: 'Confirm' }
  assert.equal(
    acceptsConfirmationIntent(state, { type: 'confirmation', binding, decision: 'confirm', action: { type: 'delete-current' } }),
    false,
    'CONFIRMATION_ACTION_SUBSTITUTION'
  )
  assert.equal(acceptsConfirmationIntent(state, { type: 'confirmation', binding, decision: 'confirm', action: { type: 'new-draft', name: 42 } }), false)
  assert.equal(
    acceptsOverlayIntent(
      { binding, kind: 'context-menu', commands: [{ command: 'undo', enabled: false }] },
      { type: 'overlay-command', binding, command: 'undo' }
    ),
    false,
    'DISABLED_OVERLAY_COMMAND'
  )
  assert.equal(acceptsOverlayIntent({ binding, kind: 'rename' }, { type: 'overlay-command', binding, command: 'delete' }), false)
})

test('real Workspace fixture dispatches only accepted selection/confirmation and preserves cancel/stale state', async t => {
  let calls = 0
  const workspace = new BlueprintWorkspace({
    loadDefinition: async () => {
      calls++
      return { blueprintId: 'bp', documentRevision: 'r', semanticRevision: 's', layoutRevision: 'l', definitionJson: JSON.stringify(definition) }
    }
  })
  t.after(() => workspace.dispose())
  workspace.catalog = [{ blueprintId: 'bp', name: 'Blueprint', documentRevision: 'r', semanticRevision: 's' }]
  const binding = workspace.getSnapshot().binding
  const state = {
    binding,
    value: '',
    disabled: false,
    options: [
      { value: 'bp', label: 'Blueprint' },
      { value: 'blocked', label: 'Blocked', disabled: true }
    ]
  }
  const select = async intent => {
    if (workspace.acceptsViewBinding(intent.binding) && acceptsSelectIntent(state, intent))
      await workspace.dispatch({ type: 'load', blueprintId: intent.value })
  }
  const before = workspace.getSnapshot()
  await select({ type: 'select-change', binding, value: 'blocked' })
  await select({ type: 'select-change', binding, value: 'missing' })
  assert.equal(workspace.getSnapshot(), before)
  assert.equal(calls, 0)
  await select({ type: 'select-change', binding, value: 'bp' })
  assert.equal(calls, 1)
  assert.equal(workspace.blueprintId, 'bp')
  const current = workspace.getSnapshot().binding
  const confirm = { binding: current, action: { type: 'new-draft', name: ' exact ' }, title: 'New', cancelLabel: 'Cancel', confirmLabel: 'Confirm' }
  const dispatch = intent => {
    if (!workspace.acceptsViewBinding(intent.binding) || !acceptsConfirmationIntent(confirm, intent) || intent.decision === 'cancel') return
    workspace.dispatch({ type: 'new-draft', name: intent.action.name })
  }
  const loaded = workspace.getSnapshot()
  dispatch({ type: 'confirmation', binding: current, action: confirm.action, decision: 'cancel' })
  dispatch({ type: 'confirmation', binding: current, action: { type: 'delete-current' }, decision: 'confirm' })
  dispatch({ type: 'confirmation', binding, action: confirm.action, decision: 'confirm' })
  assert.equal(workspace.getSnapshot(), loaded)
  dispatch({ type: 'confirmation', binding: current, action: confirm.action, decision: 'confirm' })
  assert.equal(workspace.editor.exportDefinition().name, ' exact ')
  assert.equal(calls, 1)
})

test('real InspectorSession fixture guards stale/disabled/cancel and applies valid JSON exactly once', () => {
  const editor = GraphEditor.fromDefinition(definition)
  const session = new InspectorSession(editor, 'n')
  const state = { binding, nodeId: 'n', field: 'outputs', buffer: '{}', disabled: false, notice: null }
  const send = (intent, view = state) => {
    if (!acceptsJsonIntent(view, intent)) return
    if (intent.type === 'json-buffer-change') session.setJson(intent.field, intent.text)
    else if (intent.type === 'json-commit') session.applyJson(intent.field)
  }
  const base = { binding, nodeId: 'n', field: 'outputs' }
  const before = JSON.stringify(editor.exportDefinition())
  send({ ...base, type: 'json-buffer-change', text: '{secret' })
  send({ ...base, type: 'json-commit' })
  assert.equal(session.getSnapshot().json.outputs, '{secret')
  assert.deepEqual(session.getSnapshot().notice, { key: 'inspector.invalidJsonRetained' })
  send({ ...base, type: 'json-cancel' })
  send({ ...base, type: 'json-buffer-change', binding: { ...binding, editorEpoch: 99 }, text: '{}' })
  send({ ...base, type: 'json-buffer-change', text: '{}' }, { ...state, disabled: true })
  assert.equal(JSON.stringify(editor.exportDefinition()), before)
  assert.equal(editor.canUndo, false)
  assert.equal(session.getSnapshot().json.outputs, '{secret')
  send({ ...base, type: 'json-buffer-change', text: '{" exact ":"string"}' })
  send({ ...base, type: 'json-commit' })
  assert.deepEqual(editor.exportDefinition().graph.nodes[0].outputs, { ' exact ': 'string' })
  assert.equal(editor.canUndo, true)
})

test('import overlay requires explicit matching confirmation and an empty target', () => {
  const state = { binding, kind: 'import', importTargets: [{ blueprintId: 'bp', nonempty: false }], importConfirmedId: 'bp' }
  const intent = { type: 'overlay-import-ready', binding, blueprintId: 'bp', archiveBase64: 'YQ==', confirmedId: 'bp' }
  assert.equal(acceptsOverlayIntent(state, { ...intent, confirmedId: undefined }), false, 'EMPTY_TARGET_CONFIRMATION_REQUIRED')
  assert.equal(acceptsOverlayIntent({ ...state, importConfirmedId: undefined }, intent), false)
  assert.equal(acceptsOverlayIntent({ ...state, importTargets: [{ blueprintId: 'bp', nonempty: true }] }, intent), false, 'NONEMPTY_TARGET_NEVER_OVERWRITTEN')
  assert.equal(acceptsOverlayIntent(state, intent), true)
})

test('overlay controller fixture sends only eligible confirmed import through real Workspace', async t => {
  let reads = 0,
    writes = 0
  let imported = false
  const document = { blueprintId: 'bp', documentRevision: 'r', semanticRevision: 's', layoutRevision: 'l', definitionJson: JSON.stringify(definition) }
  const workspace = new BlueprintWorkspace({
    listDefinitions: async () => {
      reads++
      return { definitions: [{ blueprintId: 'bp', name: 'Blueprint', documentRevision: imported ? 'r' : null, semanticRevision: imported ? 's' : null }] }
    },
    importDefinition: async (id, archive) => {
      writes++
      assert.equal(id, 'bp')
      assert.equal(archive, ' exact archive ')
      imported = true
      return { blueprintId: 'bp' }
    },
    loadDefinition: async () => document
  })
  t.after(() => workspace.dispose())
  const binding = workspace.getSnapshot().binding
  const state = { binding, kind: 'import', importTargets: [{ blueprintId: 'bp', nonempty: false }], importConfirmedId: 'bp' }
  const intent = { type: 'overlay-import-ready', binding, blueprintId: 'bp', archiveBase64: ' exact archive ', confirmedId: 'bp' }
  const send = async (intent, view = state) => {
    if (workspace.acceptsViewBinding(intent.binding) && acceptsOverlayIntent(view, intent) && intent.type === 'overlay-import-ready')
      await workspace.importArchive(intent.blueprintId, intent.archiveBase64, intent.confirmedId)
  }
  const before = workspace.getSnapshot()
  await send({ ...intent, confirmedId: undefined })
  await send(intent, { ...state, importConfirmedId: undefined })
  await send(intent, { ...state, importTargets: [{ blueprintId: 'bp', nonempty: true }] })
  await send({ ...intent, binding: { ...binding, editorEpoch: binding.editorEpoch + 1 } })
  await send({ type: 'overlay-close', binding })
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  assert.equal(workspace.getSnapshot(), before)
  assert.equal(workspace.editor.canUndo, false)
  await send(intent)
  assert.equal(writes, 1)
  assert.equal(workspace.document.documentRevision, 'r')
  assert.deepEqual(workspace.editor.exportDefinition().graph, definition.graph)
})
