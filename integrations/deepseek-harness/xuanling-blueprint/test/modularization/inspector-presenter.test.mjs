import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
test('Inspector rendering has a safe projection owner separate from controller and markup', () => {
  assert.ok(
    existsSync(new URL('../../src/client/features/authoring/presenters/inspector-presenter.ts', import.meta.url)),
    'INSPECTOR_PRESENTER_BOUNDARY_MISSING'
  )
  assert.ok(existsSync(new URL('../../src/client/features/authoring/ui/inspector/inspector-view.tsx', import.meta.url)), 'INSPECTOR_VIEW_BOUNDARY_MISSING')
})

import React from 'react'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { InspectorSession, renderNodeInspector } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import { projectInspector } from '../../src/client/features/authoring/presenters/inspector-presenter.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'
const definition = {
  schemaVersion: 1,
  id: 'bp',
  name: 'Blueprint',
  resources: {},
  graph: { nodes: [{ id: 'n', kind: 'agentTask', inputs: {}, outputs: {}, skillRefs: [] }], edges: [] }
}
const t = (key, params = {}) => en[key]?.replace(/\{([^}]+)\}/g, (_, key) => String(params[key] ?? '')) ?? key
const all = tree => (Array.isArray(tree) ? tree.flatMap(all) : !React.isValidElement(tree) ? [] : [tree, ...all(tree.props.children)])

test('presenter projects only display fields, detaches drafts, and preserves raw user strings', () => {
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'n'),
    snapshot = structuredClone(session.getSnapshot())
  const secret = 'PRIVATE_CONFIG_CANARY'
  snapshot.privateConfig = secret
  snapshot.modelRoute.privateConfig = secret
  snapshot.rows.inputs = [{ id: 1, name: ' exact 中文 ', type: ' raw/type ', config: secret }]
  snapshot.notice = { key: 'inspector.invalidJson', params: { code: 'invalid-json', raw: secret } }
  snapshot.json.outputs = '{UNFINISHED_USER_BUFFER'
  const choices = Object.fromEntries(
    ['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef'].map(field => [
      field,
      [{ key: ' exact key ', label: 'Safe', checked: false, disabled: false, host: { config: secret }, source: { path: secret } }]
    ])
  )
  const model = projectInspector({ node: editor.nodes[0], edges: editor.edges, snapshot, disabled: false, choices })
  assert.equal(JSON.stringify(model).includes(secret), false)
  assert.equal(model.snapshot.json.outputs, '{UNFINISHED_USER_BUFFER')
  assert.deepEqual(model.snapshot.rows.inputs, [{ id: 1, name: ' exact 中文 ', type: ' raw/type ' }])
  model.choices.agentRef[0].label = 'consumer'
  model.snapshot.rows.inputs[0].name = 'consumer'
  model.snapshot.modelRoute.provider = 'consumer'
  model.snapshot.notice.params.code = 'node-unavailable'
  assert.equal(choices.agentRef[0].label, 'Safe')
  assert.equal(snapshot.rows.inputs[0].name, ' exact 中文 ')
  assert.equal(snapshot.modelRoute.provider, '')
  assert.equal(snapshot.notice.params.code, 'invalid-json')
})

test('adapter keeps Host objects private and resolves current resource availability before binding one undo transaction', () => {
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'n')
  const catalog = [{ kind: 'skill', id: ' opaque 中文 / % ', displayName: 'Safe skill', availability: 'available', privateConfig: 'PRIVATE_CATALOG_CANARY' }]
  const props = { node: editor.nodes[0], editor, resources: {}, resourceCatalog: catalog, t }
  const tree = renderNodeInspector(props, session, session.getSnapshot())
  const checkbox = all(tree).find(item => item.props['data-bp-field'] === 'skillRefs' && item.props.type === 'checkbox')
  assert.ok(checkbox)
  assert.equal(
    JSON.stringify(all(tree).map(item => Object.fromEntries(Object.entries(item.props).filter(([key]) => !['children'].includes(key))))).includes(
      'PRIVATE_CATALOG_CANARY'
    ),
    false
  )
  const before = editor.exportDefinition()
  catalog[0].availability = 'unavailable'
  checkbox.props.onChange({ currentTarget: { checked: true } })
  assert.deepEqual(editor.exportDefinition(), before, 'captured UI choice cannot bypass current availability')
  catalog[0].availability = 'available'
  checkbox.props.onChange({ currentTarget: { checked: true } })
  const after = editor.exportDefinition(),
    ref = after.graph.nodes[0].skillRefs[0]
  assert.equal(after.resources[ref].source.id, catalog[0].id)
  editor.undo()
  assert.deepEqual(editor.exportDefinition(), before)
})

test('legacy display projection retains field order while stripping extra nested route configuration', () => {
  const editor = GraphEditor.fromDefinition({
    ...definition,
    graph: {
      nodes: [
        {
          id: 'n',
          kind: 'condition',
          inputs: {},
          outputs: {},
          agentRef: 'agent',
          skillRefs: ['skill'],
          toolsetRefs: ['tool'],
          outputSchemaRef: 'schema',
          modelSelection: { model: 'M', provider: 'P', privateConfig: 'PRIVATE_ROUTE' }
        }
      ],
      edges: []
    }
  })
  const session = new InspectorSession(editor, 'n')
  const model = projectInspector({
    node: editor.nodes[0],
    edges: [],
    snapshot: session.getSnapshot(),
    disabled: false,
    choices: { agentRef: [], skillRefs: [], toolsetRefs: [], outputSchemaRef: [] }
  })
  assert.deepEqual(Object.keys(JSON.parse(model.legacyBindingsText)), ['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef', 'modelSelection'])
  assert.equal(model.legacyBindingsText.includes('PRIVATE_ROUTE'), false)
  assert.deepEqual(Object.keys(JSON.parse(model.legacyBindingsText).modelSelection), ['model', 'provider'])
})
