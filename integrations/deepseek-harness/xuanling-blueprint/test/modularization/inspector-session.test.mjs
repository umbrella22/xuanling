import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
test('Inspector drafts and patch decisions have separate framework-independent owners', async () => {
  assert.ok(
    existsSync(new URL('../../src/client/features/authoring/logic/inspector/inspector-session.ts', import.meta.url)),
    'INSPECTOR_SESSION_BOUNDARY_MISSING'
  )
  assert.ok(
    existsSync(new URL('../../src/client/features/authoring/logic/inspector/inspector-commands.ts', import.meta.url)),
    'INSPECTOR_COMMANDS_BOUNDARY_MISSING'
  )
})

import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { InspectorSession, applyInspectorPatch } from '../../src/client/features/authoring/logic/inspector/inspector-session.ts'
import { deriveInspectorPatch, inspectorOptionDelta } from '../../src/client/features/authoring/logic/inspector/inspector-commands.ts'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { JsonEditorView } from '../../src/client/features/authoring/logic/inspector/json-editor.ts'
const definition = {
  schemaVersion: 2,
  id: 'bp',
  name: 'Blueprint',
  resources: {},
  graph: {
    nodes: [{ id: 'n', kind: 'agentTask', inputs: {}, outputs: {}, skillRefs: [], modelSelection: { provider: 'provider', model: 'model' } }],
    edges: []
  }
}

test('pure patch derivation preserves source data and ignores equivalent JSON while retaining explicit clears', () => {
  const editor = GraphEditor.fromDefinition(definition),
    node = editor.nodes[0],
    before = JSON.stringify(editor.exportDefinition())
  assert.deepEqual(deriveInspectorPatch(node, { modelSelection: { provider: 'provider', model: 'model' } }), { ok: true, changed: false, changes: {} })
  const delta = inspectorOptionDelta(
    { modelSelection: { provider: 'provider', model: 'model' }, agentRef: 'old' },
    { modelSelection: { provider: 'provider', model: 'model' }, agentRef: 'new' }
  )
  assert.deepEqual(delta, { agentRef: 'new' })
  assert.deepEqual(deriveInspectorPatch(node, { outputSchemaRef: undefined }), { ok: true, changed: false, changes: {} })
  assert.deepEqual(deriveInspectorPatch(node, { id: 'other' }), { ok: false, issue: 'node-options-shape' })
  assert.equal(JSON.stringify(editor.exportDefinition()), before)
  assert.equal(editor.canUndo, false)
})

test('session dirty JSON field delta merges newer structured changes and resource binding stays a single undo transaction', () => {
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'n'),
    off = session.subscribe(() => {})
  try {
    const edited = JSON.parse(session.getSnapshot().json.options)
    edited.modelSelection.model = 'new-model'
    session.setJson('options', JSON.stringify(edited))
    session.patch({ agentRef: 'newer' })
    session.applyJson('options')
    assert.equal(editor.exportDefinition().graph.nodes[0].agentRef, 'newer')
    assert.equal(editor.exportDefinition().graph.nodes[0].modelSelection.model, 'new-model')
    session.setModelRoute('provider', ' exact provider ')
    session.setModelRoute('model', ' exact model ')
    session.setExplicitModel(true)
    session.patch({ outputs: { p: 'string' } })
    assert.equal(session.getSnapshot().modelRoute.provider, ' exact provider ')
    session.applyModelRoute()
    assert.deepEqual(editor.exportDefinition().graph.nodes[0].modelSelection, { provider: ' exact provider ', model: ' exact model ' })
    const before = editor.exportDefinition()
    session.bindResource('skillRefs', {
      key: 'host',
      host: { id: ' 中文 / % ', kind: 'skill', displayName: 'Skill', availability: 'available' },
      label: 'Skill',
      unavailable: false
    })
    const bound = editor.exportDefinition(),
      ref = bound.graph.nodes[0].skillRefs[0]
    assert.equal(bound.resources[ref].source.id, ' 中文 / % ')
    editor.undo()
    assert.deepEqual(editor.exportDefinition(), before, 'resource and declaration must undo together')
  } finally {
    off()
  }
})

test('real Workspace binding admission rejects stale Inspector editor intents without disabling same-editor concurrent merge', async t => {
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
  const old = workspace.editor,
    session = new InspectorSession(old, 'n')
  const state = { binding: workspace.getSnapshot().binding, nodeId: 'n', field: 'outputs', buffer: '{}', disabled: false, notice: null }
  const element = JsonEditorView({
    state,
    label: 'Outputs',
    t: key => key,
    onIntent: intent => {
      if (!workspace.acceptsViewBinding(intent.binding)) return
      if (intent.type === 'json-buffer-change') session.setJson(intent.field, intent.text)
      if (intent.type === 'json-commit') session.applyJson(intent.field)
    }
  })
  applyInspectorPatch(old, 'n', { agentRef: 'concurrent' })
  element.props.onChange('{" exact ":"string"}')
  element.props.onBlur()
  assert.equal(old.exportDefinition().graph.nodes[0].agentRef, 'concurrent')
  assert.deepEqual(old.exportDefinition().graph.nodes[0].outputs, { ' exact ': 'string' })
  const oldBefore = JSON.stringify(old.exportDefinition())
  workspace.newDraft('replacement')
  const replacement = workspace.getSnapshot()
  element.props.onChange('{}')
  element.props.onBlur()
  assert.equal(JSON.stringify(old.exportDefinition()), oldBefore)
  assert.equal(workspace.getSnapshot(), replacement)
})
