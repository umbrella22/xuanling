import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
test('JSON buffer decisions have a pure owner separate from CodeMirror and React', async () => {
  assert.ok(
    existsSync(new URL('../../src/client/features/authoring/logic/inspector/json-editor-session.ts', import.meta.url)),
    'JSON_EDITOR_SESSION_BOUNDARY_MISSING'
  )
  const { initialJsonBuffer, formatJsonBuffer, canSyncJsonBuffer } = await import('../../src/client/features/authoring/logic/inspector/json-editor-session.ts')
  assert.equal(initialJsonBuffer('', 'default'), '')
  assert.equal(initialJsonBuffer(undefined, ' exact '), ' exact ')
  assert.equal(initialJsonBuffer(undefined, undefined), '')
  assert.deepEqual(formatJsonBuffer('{secret', false, false), { accepted: false, text: '{secret' })
  assert.deepEqual(formatJsonBuffer('{"x":1}', false, false), { accepted: true, text: '{\n  "x": 1\n}' })
  assert.equal(formatJsonBuffer('{}', true, false).accepted, false)
  assert.equal(formatJsonBuffer('{}', false, true).accepted, false)
  assert.equal(canSyncJsonBuffer('old', 'new', true), false)
  assert.equal(canSyncJsonBuffer('old', undefined, false), false)
  assert.equal(canSyncJsonBuffer('same', 'same', false), false)
  assert.equal(canSyncJsonBuffer('old', ' raw ', false), true)
})

import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { InspectorSession } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import { JsonEditorView, JsonEditor } from '../../src/client/features/authoring/logic/inspector/json-editor.ts'

test('typed JSON adapter preserves malformed draft text and delegates invalid commit rejection to semantic validation', async t => {
  const definition = {
    schemaVersion: 1,
    id: 'bp',
    name: 'Blueprint',
    resources: {},
    graph: { nodes: [{ id: 'n', kind: 'input', inputs: {}, outputs: {} }], edges: [] }
  }
  const workspace = new BlueprintWorkspace({
    loadDefinition: async () => ({
      blueprintId: 'bp',
      documentRevision: 'r',
      semanticRevision: 's',
      layoutRevision: 'l',
      definitionJson: JSON.stringify(definition)
    })
  })
  t.after(() => workspace.dispose())
  workspace.catalog = [{ blueprintId: 'bp', name: 'Blueprint', documentRevision: 'r', semanticRevision: 's' }]
  await workspace.load('bp')
  const session = new InspectorSession(workspace.editor, 'n'),
    intents = []
  const state = { binding: workspace.getSnapshot().binding, nodeId: 'n', field: 'outputs', buffer: '{}', disabled: false, notice: null }
  const onIntent = intent => {
    if (!workspace.acceptsViewBinding(intent.binding)) return
    intents.push(intent)
    if (intent.type === 'json-buffer-change') session.setJson(intent.field, intent.text)
    if (intent.type === 'json-commit') session.applyJson(intent.field)
  }
  const element = JsonEditorView({ state, onIntent, label: 'Outputs', t: key => key })
  assert.equal(element.type, JsonEditor)
  const before = JSON.stringify(workspace.editor.exportDefinition())
  element.props.onChange('{PRIVATE_MALFORMED')
  assert.equal(session.getSnapshot().json.outputs, '{PRIVATE_MALFORMED')
  element.props.onBlur('{PRIVATE_MALFORMED')
  assert.equal(intents.filter(intent => intent.type === 'json-commit').length, 1)
  assert.deepEqual(session.getSnapshot().notice, { key: 'inspector.invalidJsonRetained' })
  assert.equal(session.getSnapshot().json.outputs, '{PRIVATE_MALFORMED')
  assert.equal(workspace.editor.canUndo, false)
  assert.equal(JSON.stringify(workspace.editor.exportDefinition()), before)
  element.props.onChange('{"p":42}')
  element.props.onBlur('{"p":42}')
  assert.equal(JSON.stringify(workspace.editor.exportDefinition()), before)
  assert.equal(session.getSnapshot().notice.key, 'inspector.portTypesRequired')
  element.props.onChange('{" exact ":"string"}')
  element.props.onBlur('{" exact ":"string"}')
  assert.deepEqual(workspace.editor.exportDefinition().graph.nodes[0].outputs, { ' exact ': 'string' })
  const disabled = JsonEditorView({ state: { ...state, disabled: true }, onIntent, label: 'Outputs', t: key => key })
  const count = intents.length
  disabled.props.onChange('{}')
  disabled.props.onBlur('{}')
  assert.equal(intents.length, count)
  workspace.newDraft('Replacement')
  const replacement = workspace.getSnapshot()
  element.props.onChange('{}')
  element.props.onBlur('{}')
  assert.equal(workspace.getSnapshot(), replacement)
  assert.equal(intents.length, count)
})
