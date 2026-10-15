// Real Inspector render/callback/history; controlled Panel renderer seat below.
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { GraphEditor } from '../../src/client/graph-editor.ts'
import { InspectorSession, renderNodeInspector } from '../../src/client/inspector.ts'
import { en } from '../../src/client/locales.ts'
const t = (key, params = {}) => {
  assert.ok(Object.hasOwn(en, key), key)
  return en[key].replace(/\{(\w+)\}/g, (_, n) => String(params[n]))
}
const elements = tree => (Array.isArray(tree) ? tree.flatMap(elements) : !React.isValidElement(tree) ? [] : [tree, ...elements(tree.props.children)])
const fields = ['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef', 'model-mode']
const kinds = ['input', 'output', 'agentTask', 'toolCall', 'scriptCall', 'condition', 'join', 'humanDecision', 'subflow', 'iteration', 'unknown']
function inspectorFixture(kind, team = false) {
  const resources = {
    Agent: { kind: 'agent', source: { kind: 'host', id: 'literal-agent' } },
    Skill: { kind: 'skill', source: { kind: 'host', id: 'literal-skill' } },
    Tools: { kind: 'mcp', bindingId: 'literal-tools' },
    Schema: { kind: 'schema', path: 'schema.json' }
  }
  const legacy = {
    agentRef: 'Agent',
    skillRefs: ['Skill'],
    toolsetRefs: ['Tools'],
    outputSchemaRef: 'Schema',
    modelSelection: {
      provider: 'literal-provider',
      model: 'literal-model',
      reasoningEffort: 'high'
    }
  }
  const node = {
    id: 'node',
    kind,
    inputs: { flag: 'boolean' },
    outputs: { value: 'string' },
    ...legacy,
    ...(team
      ? {
          teamStage: {
            task: { subject: 'Synthetic', description: 'Synthetic' },
            members: [{ name: 'reviewer', description: 'Synthetic', agentRef: 'Agent', context: 'fresh' }],
            requiredChecks: ['Synthetic']
          }
        }
      : {})
  }
  const editor = GraphEditor.fromDefinition({
    schemaVersion: 1,
    id: 'Capabilities',
    name: 'Synthetic',
    resources,
    graph: { nodes: [node], edges: [] }
  })
  const session = new InspectorSession(editor, 'node')
  const render = () => renderNodeInspector({ node: editor.nodes[0], editor, resources, t }, session, session.getSnapshot())
  return { editor, session, render, legacy }
}
for (const kind of kinds)
  test(`W2.2 real Inspector ${kind} capability and legacy/history preservation`, () => {
    const f = inspectorFixture(kind),
      before = f.editor.exportDefinition(),
      tree = f.render(),
      visible = elements(tree)
        .filter(e => fields.includes(e.props['data-bp-field']))
        .map(e => e.props['data-bp-field'])
    if (kind === 'agentTask') for (const field of fields) assert.ok(visible.includes(field), field)
    else {
      assert.deepEqual(visible, [])
      const legacy = elements(tree).find(e => e.props['data-bp-legacy-bindings'])
      assert.ok(legacy)
      const pre = elements(legacy).find(e => e.type === 'pre')
      assert.deepEqual(JSON.parse(pre.props.children), f.legacy)
    }
    assert.deepEqual(f.editor.exportDefinition(), before, 'render never clears old execution fields')
    const edit = elements(tree).find(e => e.props['data-bp-action'] === 'add-input-port')
    assert.ok(edit, 'actual port callback exists')
    edit.props.onClick()
    f.session.patch({ outputs: { value: 'string', 'literal.中文': 'boolean' } })
    const after = f.editor.exportDefinition().graph.nodes[0]
    for (const [field, value] of Object.entries(f.legacy)) assert.deepEqual(after[field], value)
    assert.equal(f.editor.undo(), true)
    assert.deepEqual(f.editor.exportDefinition(), before)
    assert.equal(f.editor.redo(), true)
    for (const [field, value] of Object.entries(f.legacy)) assert.deepEqual(f.editor.exportDefinition().graph.nodes[0][field], value)
  })
test('W2.2 TeamStage real Inspector retains four bindings but hides forbidden model route', () => {
  const f = inspectorFixture('agentTask', true),
    tree = f.render(),
    visible = elements(tree)
      .filter(e => fields.includes(e.props['data-bp-field']))
      .map(e => e.props['data-bp-field'])
  for (const field of fields.slice(0, 4)) assert.ok(visible.includes(field), field)
  assert.equal(visible.includes('model-mode'), false)
  assert.equal(
    elements(tree).some(e => e.props['data-bp-model-route']),
    false
  )
  assert.deepEqual(f.editor.exportDefinition().graph.nodes[0].modelSelection, f.legacy.modelSelection)
})

import { registerHooks } from 'node:module'
import { BlueprintWorkspace } from '../../src/client/workspace.ts'
const key = Symbol.for('blueprint.test.capabilities'),
  seat = { active: null }
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  memo: fn => fn,
  useState(initial) {
    const f = seat.active,
      i = f.cursor++
    if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial
    return [
      f.states[i],
      update => {
        f.states[i] = typeof update === 'function' ? update(f.states[i]) : update
      }
    ]
  },
  useRef(initial) {
    const f = seat.active,
      i = f.refCursor++
    return (f.refs[i] ??= { current: initial })
  },
  useMemo(factory, deps) {
    const f = seat.active,
      i = f.memoCursor++,
      last = f.memos[i]
    if (!last || deps.some((v, j) => !Object.is(v, last.deps[j]))) f.memos[i] = { deps, value: factory() }
    return f.memos[i].value
  },
  useCallback: fn => fn,
  useEffect() {}
}
const url = code => `data:text/javascript,${encodeURIComponent(code)}`
const reactUrl = url(
  `export default globalThis[Symbol.for('blueprint.test.capabilities')].react; export const createElement=globalThis[Symbol.for('blueprint.test.capabilities')].react.createElement;`
)
const flow = url(`export const useReactFlow=()=>globalThis[Symbol.for('blueprint.test.capabilities')].active.flow;
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrowclosed'};
export const ReactFlow='flow',ReactFlowProvider='provider',Background='background',Controls='controls',MiniMap='minimap',Handle='handle',NodeResizer='resizer',BaseEdge='base-edge'; export const getSmoothStepPath=()=>['M 0 0 L 1 1',0,0];`)
// Inspector is a frozen opaque boundary here, not a fake editor implementation.
const inspector = url('export function NodeInspector(){}')
const client = new URL('../../src/client/', import.meta.url).href
const hooks = registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL?.startsWith(client) && spec === 'react') return { url: reactUrl, shortCircuit: true }
    if (context.parentURL === `${client}panel.ts` && spec === '@xyflow/react') return { url: flow, shortCircuit: true }
    if (context.parentURL === `${client}panel.ts` && spec === './inspector.ts') return { url: inspector, shortCircuit: true }
    return next(spec, context)
  }
})
let createBlueprintPanel
try {
  ;({ createBlueprintPanel } = await import(`${client}panel.ts`))
} finally {
  hooks.deregister()
}
test.after(() => {
  delete globalThis[key]
})

const all = (tree, predicate) =>
  !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => all(child, predicate))]
for (const kind of kinds.filter(k => k !== 'unknown'))
  test(`W2.2 actual Panel ${kind} has meaningful binding summary only`, async () => {
    const definition = {
      schemaVersion: 1,
      id: 'PanelCapability',
      name: 'Synthetic',
      resources: {},
      graph: { nodes: [{ id: 'node', kind }], edges: [] }
    }
    const doc = {
      blueprintId: definition.id,
      definitionJson: JSON.stringify(definition),
      documentRevision: 'doc',
      semanticRevision: 'semantic',
      layoutRevision: 'layout'
    }
    const host = {
      async listDefinitions() {
        return {
          definitions: [
            {
              blueprintId: definition.id,
              name: definition.name,
              documentRevision: 'doc',
              semanticRevision: 'semantic'
            }
          ]
        }
      },
      async loadDefinition() {
        return structuredClone(doc)
      },
      async validate() {
        return { ok: true, semanticRevision: 'semantic' }
      }
    }
    const f = {
      states: [],
      refs: [],
      memos: [],
      cursor: 0,
      refCursor: 0,
      memoCursor: 0,
      flow: { getNodes: () => [], fitView: async () => true, screenToFlowPosition: p => p }
    }
    const Panel = createBlueprintPanel({
      hostLink: host,
      storage: { getItem: () => null, setItem() {} }
    })
    seat.active = f
    const shell = Panel({ t })
    const entry = shell.children[0]
    const render = () => {
      seat.active = f
      f.cursor = f.refCursor = f.memoCursor = 0
      return entry.type({ t })
    }
    render()
    const workspace = f.states[0]
    assert.ok(workspace instanceof BlueprintWorkspace)
    await workspace.initialize()
    await workspace.load(definition.id)
    const flow = all(render(), n => n.type === 'flow')[0]
    assert.ok(flow)
    const node = flow.props.nodes.find(n => n.id === 'node')
    assert.ok(node)
    assert.equal(node.data.summary, kind === 'agentTask' ? en['node.noResourceBinding'] : '')
    const body = flow.props.nodeTypes.blueprint({ id: node.id, data: node.data, selected: false })
    assert.equal(
      all(body, n =>
        String(n.props.className ?? '')
          .split(' ')
          .includes('bp-node-summary')
      ).length,
      kind === 'agentTask' ? 1 : 0
    )
  })
