import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { InspectorSession, renderNodeInspector } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
const definition = {
  schemaVersion: 2,
  id: 'bp',
  name: 'Blueprint',
  resources: {},
  graph: { nodes: [{ id: 'n', kind: 'agentTask', inputs: {}, outputs: {} }], edges: [] }
}
const all = tree => (Array.isArray(tree) ? tree.flatMap(all) : !React.isValidElement(tree) ? [] : [tree, ...all(tree.props.children)])
test('Inspector semantic dispatch has a framework-neutral command owner', () => {
  assert.ok(
    existsSync(new URL('../../src/client/features/authoring/logic/inspector/inspector-command-adapter.ts', import.meta.url)),
    'INSPECTOR_COMMAND_ADAPTER_MISSING'
  )
})
test('retained renderer callbacks reject a no-longer-current session before mutating the old graph', () => {
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'n')
  session.setJson('options', '{"id":"n","kind":"agentTask","agentRef":"changed"}')
  let current = true
  const tree = renderNodeInspector({ node: editor.nodes[0], editor, resources: {}, t: key => key }, session, session.getSnapshot(), {
    isCurrent: () => current
  })
  const apply = all(tree).find(item => item.props['data-bp-action'] === 'apply-node-options')
  const before = JSON.stringify(editor.exportDefinition())
  current = false
  apply.props.onClick()
  assert.equal(JSON.stringify(editor.exportDefinition()), before, 'STALE_INSPECTOR_CALLBACK_MUTATED_OLD_EDITOR')
  assert.equal(editor.canUndo, false)
})

import { dispatchInspectorIntent } from '../../src/client/features/authoring/logic/inspector/inspector-command-adapter.ts'
test('command adapter rejects invalid/disabled/stale/missing-node without draft, graph, history or subscription effects', () => {
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'n')
  let publications = 0,
    current = true,
    disabled = false
  const off = session.subscribe(() => publications++)
  const context = { session, isCurrent: () => current, isDisabled: () => disabled, resourceChoices: () => [] }
  try {
    const before = JSON.stringify(editor.exportDefinition()),
      snapshot = session.getSnapshot()
    for (const intent of [
      null,
      [],
      {},
      { type: 'json-commit', field: 'unknown' },
      { type: 'model-mode', explicit: 'true' },
      { type: 'port-row', field: 'outputs', id: 999, property: 'name', value: 'x' }
    ])
      assert.deepEqual(dispatchInspectorIntent(context, intent), { ok: false, reason: 'invalid-intent' })
    disabled = true
    assert.deepEqual(dispatchInspectorIntent(context, { type: 'json-buffer', field: 'outputs', text: '{}' }), { ok: false, reason: 'disabled' })
    disabled = false
    current = false
    assert.deepEqual(dispatchInspectorIntent(context, { type: 'json-commit', field: 'outputs' }), { ok: false, reason: 'stale' })
    assert.equal(publications, 0)
    assert.equal(session.getSnapshot(), snapshot)
    assert.equal(JSON.stringify(editor.exportDefinition()), before)
    assert.equal(editor.canUndo, false)
    current = true
    editor.deleteItems(['n'], [])
    const absent = JSON.stringify(editor.exportDefinition()),
      count = publications
    assert.deepEqual(dispatchInspectorIntent(context, { type: 'json-buffer', field: 'outputs', text: '{}' }), { ok: false, reason: 'missing-node' })
    assert.equal(publications, count)
    assert.equal(JSON.stringify(editor.exportDefinition()), absent)
  } finally {
    off()
  }
})
test('same-current adapter preserves malformed notices, exact drafts and concurrent field-delta merge', () => {
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'n'),
    context = { session, isCurrent: () => true, isDisabled: () => false, resourceChoices: () => [] }
  const before = JSON.stringify(editor.exportDefinition())
  dispatchInspectorIntent(context, { type: 'json-buffer', field: 'outputs', text: '{PRIVATE' })
  assert.deepEqual(dispatchInspectorIntent(context, { type: 'json-commit', field: 'outputs' }), { ok: true, status: 'dispatched' })
  assert.deepEqual(session.getSnapshot().notice, { key: 'inspector.invalidJsonRetained' })
  assert.equal(JSON.stringify(editor.exportDefinition()), before)
  const options = JSON.parse(session.getSnapshot().json.options)
  options.outputs = { ' exact ': 'string' }
  dispatchInspectorIntent(context, { type: 'json-buffer', field: 'options', text: JSON.stringify(options) })
  session.patch({ agentRef: 'newer' })
  dispatchInspectorIntent(context, { type: 'json-commit', field: 'options' })
  assert.equal(editor.exportDefinition().graph.nodes[0].agentRef, 'newer')
  assert.deepEqual(editor.exportDefinition().graph.nodes[0].outputs, { ' exact ': 'string' })
})
test('retained renderer callback uses live disabled admission without breaking independent renderer instances', () => {
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'n')
  let disabled = false
  const props = { node: editor.nodes[0], editor, resources: {}, t: key => key }
  const tree = renderNodeInspector(props, session, session.getSnapshot(), { isDisabled: () => disabled })
  const input = all(tree).find(item => item.props['data-bp-json'] === 'outputs')
  const snapshot = session.getSnapshot()
  disabled = true
  input.props.onChange('{}')
  input.props.onBlur()
  assert.equal(session.getSnapshot(), snapshot)
  disabled = false
  input.props.onChange('{"raw":"string"}')
  input.props.onBlur()
  assert.deepEqual(editor.exportDefinition().graph.nodes[0].outputs, { raw: 'string' })
})

test('retained resource callback resolves replacement catalog from the live owner props', () => {
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'n')
  const catalog = [{ kind: 'skill', id: ' exact host 中文 ', displayName: 'Skill', availability: 'available' }]
  let props = { node: editor.nodes[0], editor, resources: {}, resourceCatalog: catalog, t: key => key }
  const tree = renderNodeInspector(props, session, session.getSnapshot(), { currentProps: () => props })
  const checkbox = all(tree).find(item => item.props['data-bp-field'] === 'skillRefs' && item.props.type === 'checkbox')
  const before = JSON.stringify(editor.exportDefinition())
  props = { ...props, resourceCatalog: catalog.map(entry => ({ ...entry, availability: 'unavailable' })) }
  assert.deepEqual(checkbox.props.onChange({ currentTarget: { checked: true } }), { ok: false, reason: 'unavailable-resource' })
  assert.equal(JSON.stringify(editor.exportDefinition()), before)
  assert.equal(editor.canUndo, false)
  props = { ...props, resourceCatalog: [...catalog] }
  checkbox.props.onChange({ currentTarget: { checked: true } })
  const after = editor.exportDefinition(),
    ref = after.graph.nodes[0].skillRefs[0]
  assert.equal(after.resources[ref].source.id, ' exact host 中文 ')
  editor.undo()
  assert.equal(JSON.stringify(editor.exportDefinition()), before)
})
