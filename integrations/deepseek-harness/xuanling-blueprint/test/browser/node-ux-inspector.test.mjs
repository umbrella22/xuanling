// Real Inspector React element tree, session and public callbacks; no source regex oracle.
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { GraphEditor } from '../../src/client/graph-editor.ts'
import { InspectorSession, renderNodeInspector } from '../../src/client/inspector.ts'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { en } from '../../src/client/locales.ts'
const t = (key, params = {}) => {
  assert.ok(Object.hasOwn(en, key), key)
  return en[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
}
const elements = tree => (Array.isArray(tree) ? tree.flatMap(elements) : !React.isValidElement(tree) ? [] : [tree, ...elements(tree.props.children)])
const fields = ['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef']
function fixture(kind) {
  const definition = {
    schemaVersion: 1,
    id: 'NodeUXInspector',
    name: 'Synthetic',
    resources: {
      Agent: { kind: 'agent', source: { kind: 'host', id: 'synthetic-agent' } },
      Skill: { kind: 'skill', source: { kind: 'host', id: 'synthetic-skill' } },
      Tools: { kind: 'mcp', bindingId: 'synthetic-tools' },
      Schema: { kind: 'schema', path: 'schemas/synthetic.json' }
    },
    graph: {
      nodes: [
        {
          id: 'node',
          kind,
          inputs: { value: 'boolean' },
          outputs: { result: 'boolean' },
          ...(kind === 'humanDecision' || kind === 'condition' ? { branches: ['yes', 'no'] } : {}),
          agentRef: 'Agent',
          skillRefs: ['Skill'],
          toolsetRefs: ['Tools'],
          outputSchemaRef: 'Schema'
        }
      ],
      edges: []
    }
  }
  const editor = GraphEditor.fromDefinition(definition),
    session = new InspectorSession(editor, 'node')
  const render = () => renderNodeInspector({ node: editor.nodes[0], editor, resources: definition.resources, t }, session, session.getSnapshot())
  return { definition, editor, session, render }
}
for (const kind of ['input', 'output', 'condition', 'join', 'humanDecision']) {
  test(`U03 RED ${kind} has no editable Agent/Skill/MCP/output-schema binding controls`, () => {
    const f = fixture(kind),
      before = f.editor.exportDefinition()
    const tree = f.render()
    const bindings = elements(tree).filter(n => fields.includes(n.props['data-bp-field']))
    assert.deepEqual(f.editor.exportDefinition(), before, 'render must not sanitize legacy bindings')
    assert.deepEqual(
      bindings.map(n => n.props['data-bp-field']),
      [],
      'non-agent current Inspector must hide ineffective binding editors'
    )
  })
  test(`U03/U11 GREEN ${kind} legacy bindings survive real Host decode/validate and unrelated edit`, () => {
    const f = fixture(kind)
    const before = structuredClone(f.definition.graph.nodes[0])
    const decoded = decodeDefinition(JSON.stringify(f.editor.exportDefinition()))
    validateDefinition(decoded)
    f.session.patch({ outputs: { result: 'boolean', 'raw.中文': 'string' } })
    const after = decodeDefinition(JSON.stringify(f.editor.exportDefinition()))
    validateDefinition(after)
    for (const field of fields) assert.deepEqual(after.graph.nodes[0][field], before[field])
    assert.equal(after.graph.nodes[0].outputs['raw.中文'], 'string')
  })
}
test('U03 GREEN AgentTask retains effective binding editors and exact callback identities', () => {
  const f = fixture('agentTask'),
    tree = f.render()
  for (const field of fields)
    assert.ok(
      elements(tree).some(n => n.props['data-bp-field'] === field),
      field
    )
  const agent = elements(tree).find(n => n.props['data-bp-field'] === 'agentRef')
  assert.equal(typeof agent.props.onChange, 'function')
  agent.props.onChange({ currentTarget: { value: 'Agent' } })
  assert.equal(f.editor.exportDefinition().graph.nodes[0].agentRef, 'Agent')
})
