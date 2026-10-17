import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { registerHooks } from 'node:module'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { InspectorSession, renderNodeInspector } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import { decodeClipboard } from '../../src/client/features/authoring/logic/graph/clipboard.ts'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'

const initial = {
  schemaVersion: 1,
  id: 'host-inspector',
  name: 'Host Inspector',
  resources: { local: { kind: 'agent', path: 'lib/agents/local.md' } },
  graph: { nodes: [{ id: 'task', kind: 'agentTask', agentRef: 'local', inputs: {}, outputs: { text: 'string' } }], edges: [] }
}
const catalog = [
  { kind: 'agent', id: 'Review / QA', displayName: 'Review / QA', description: '', source: 'dsh', provenance: 'custom', availability: 'available' },
  { kind: 'skill', id: 'review', displayName: 'Review', description: '', source: 'dsh', provenance: 'custom', availability: 'available' },
  {
    kind: 'mcp',
    id: 'mcp__search__query',
    bindingId: 'mcp__search__query',
    displayName: 'Search',
    description: '',
    source: 'dsh',
    provenance: 'custom',
    availability: 'available'
  }
]
const translate = key => en[key] ?? key
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements)
  if (!React.isValidElement(tree)) return []
  return [tree, ...elements(tree.props.children)]
}
function fixture(t) {
  const editor = GraphEditor.fromDefinition(initial)
  const session = new InspectorSession(editor, 'task')
  const off = session.subscribe(() => {})
  t.after(off)
  const render = () =>
    renderNodeInspector(
      { node: editor.nodes[0], editor, resources: editor.exportDefinition().resources, resourceCatalog: catalog, t: translate },
      session,
      session.getSnapshot()
    )
  const find = (key, value, extra = () => true) => {
    const result = elements(render()).find(item => item.props[key] === value && extra(item))
    assert.ok(result, `${key}=${value}`)
    return result
  }
  return { editor, session, find }
}
const change = value => ({ currentTarget: { value } })

test('Host choice precedes blueprint choice; binding and declaration form one Undo transaction', t => {
  const f = fixture(t)
  const select = f.find('data-bp-field', 'agentRef')
  const options = elements(select).filter(item => item.type === 'option')
  assert.match(options[1].props.children, /^Review \/ QA/)
  assert.match(options[2].props.children, /^local/)
  select.props.onChange(change(options[1].props.value))
  const definition = f.editor.exportDefinition()
  const refId = definition.graph.nodes[0].agentRef
  assert.deepEqual(definition.resources[refId].source, { kind: 'host', id: 'Review / QA' })
  validateDefinition(decodeDefinition(JSON.stringify(definition)))
  f.editor.undo()
  assert.deepEqual(f.editor.exportDefinition().resources, initial.resources)
  assert.equal(f.editor.exportDefinition().graph.nodes[0].agentRef, 'local')
  assert.equal(f.editor.canUndo, false)
  f.editor.redo()
  assert.deepEqual(f.editor.exportDefinition().resources[refId].source, { kind: 'host', id: 'Review / QA' })
})

test('Host Skill and exact MCP identities survive copy/paste with explicit model route', t => {
  const f = fixture(t)
  for (const field of ['skillRefs', 'toolsetRefs']) f.find('data-bp-field', field).props.onChange({ currentTarget: { checked: true } })
  f.find('data-bp-field', 'model-mode').props.onChange(change('explicit'))
  for (const [field, value] of [
    ['provider', 'openai-responses'],
    ['model', 'gpt-test'],
    ['reasoningEffort', 'high']
  ])
    f.find('data-bp-field', `modelSelection.${field}`).props.onChange(change(value))
  f.find('data-bp-action', 'apply-model-route').props.onClick()
  const copied = f.editor.createClipboard(['task'])
  const parsed = decodeClipboard(copied)
  assert.equal(parsed.nodes.length, 1)
  const target = GraphEditor.fromDefinition(f.editor.exportDefinition())
  assert.equal(target.pasteClipboard(copied, { x: 200, y: 200 }).ok, true)
  const node = target.exportDefinition().graph.nodes.find(item => item.id !== 'task')
  assert.deepEqual(node.modelSelection, { provider: 'openai-responses', model: 'gpt-test', reasoningEffort: 'high' })
  for (const [field, id] of [
    ['skillRefs', 'review'],
    ['toolsetRefs', 'mcp__search__query']
  ])
    assert.equal(target.exportDefinition().resources[node[field][0]].source.id, id)
})

test('Explicit model draft rejects blank fields and Undo synchronizes applied and default routes', t => {
  const f = fixture(t)
  f.session.setExplicitModel(true)
  f.session.setModelRoute('provider', 'openai-responses')
  f.session.applyModelRoute()
  assert.equal(f.editor.exportDefinition().graph.nodes[0].modelSelection, undefined)
  assert.equal(f.session.getSnapshot().modelRoute.explicit, true)
  f.session.setModelRoute('model', 'gpt-test')
  f.session.applyModelRoute()
  f.editor.undo()
  assert.equal(f.session.getSnapshot().modelRoute.explicit, false)
  f.editor.redo()
  assert.equal(f.session.getSnapshot().modelRoute.model, 'gpt-test')
  f.session.setExplicitModel(false)
  assert.equal(f.editor.exportDefinition().graph.nodes[0].modelSelection, undefined)
  f.editor.undo()
  assert.equal(f.session.getSnapshot().modelRoute.model, 'gpt-test')
})

test('production panel displays Host labels without exposing generated reference keys', async t => {
  // Control only hook/Flow seats; the loaded workspace, panel and editor are real.
  const owner = { states: [], refs: [], stateCursor: 0, refCursor: 0 },
    child = { states: [], refs: [], stateCursor: 0, refCursor: 0 }
  let active = owner,
    runBridgeEffect = false
  const seatKey = Symbol.for('xuanling.blueprint.test.host-resource-display')
  globalThis[seatKey] = {
    react: {
      ...React,
      useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
      useState(initial) {
        const states = active.states,
          i = active.stateCursor++
        if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
        return [
          states[i],
          update => {
            states[i] = typeof update === 'function' ? update(states[i]) : update
          }
        ]
      },
      useRef(initial) {
        return (active.refs[active.refCursor++] ??= { current: initial })
      },
      useMemo: factory => factory(),
      useCallback: callback => callback,
      useEffect(effect) {
        if (runBridgeEffect) child.bridgeCleanup = effect()
      }
    }
  }
  t.after(() => {
    delete globalThis[seatKey]
  })
  const panelUrl = new URL('../../src/client/features/authoring/ui/panel/panel-composition.tsx', import.meta.url).href
  const panelControllerUrl = new URL('../../src/client/features/authoring/ui/panel/panel-controller.tsx', import.meta.url).href
  const canvasSurfaceUrl = new URL('../../src/client/features/authoring/ui/canvas/canvas-surface.tsx', import.meta.url).href
  const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`
  const reactUrl = moduleUrl(`export default globalThis[Symbol.for('xuanling.blueprint.test.host-resource-display')].react`)
  const flowUrl = moduleUrl(`export const useReactFlow=()=>({});
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrowclosed'};
export const ReactFlow='flow',ReactFlowProvider='provider',Background='background',Controls='controls',MiniMap='minimap',Handle='handle',NodeResizer='resizer',BaseEdge='base-edge';export const getSmoothStepPath=()=>['M 0 0',0,0];`)
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (
        (context.parentURL === panelUrl ||
          context.parentURL === panelControllerUrl ||
          context.parentURL === canvasSurfaceUrl ||
          (specifier === 'react' && context.parentURL?.includes('/src/client/features/authoring/ui/panel/'))) &&
        ['react', '@xyflow/react'].includes(specifier)
      )
        return { url: specifier === 'react' ? reactUrl : flowUrl, shortCircuit: true }
      return next(specifier, context)
    }
  })
  let createBlueprintPanel
  try {
    ;({ createBlueprintPanel } = await import(panelUrl))
  } finally {
    hooks.deregister()
  }
  const editor = GraphEditor.fromDefinition(initial)
  const session = new InspectorSession(editor, 'task')
  const off = session.subscribe(() => {})
  t.after(off)
  const renderInspector = () =>
    renderNodeInspector(
      { node: editor.nodes[0], editor, resources: editor.exportDefinition().resources, resourceCatalog: catalog, t: translate },
      session,
      session.getSnapshot()
    )
  const agent = elements(renderInspector()).find(item => item.props['data-bp-field'] === 'agentRef')
  const hostOption = elements(agent).find(item => item.type === 'option' && item.props.children.startsWith('Review / QA'))
  agent.props.onChange(change(hostOption.props.value))
  for (const field of ['skillRefs', 'toolsetRefs'])
    elements(renderInspector())
      .find(item => item.props['data-bp-field'] === field)
      .props.onChange({ currentTarget: { checked: true } })
  editor.updateResource('shared', { kind: 'skill', source: { kind: 'shared', rootId: 'fixture', path: 'review' } })
  const definition = editor.exportDefinition(),
    serialized = JSON.stringify(definition)
  const host = {
    async listDefinitions() {
      return { definitions: [{ blueprintId: definition.id, name: definition.name, documentRevision: 'document', semanticRevision: 'semantic' }] }
    },
    async listResources() {
      return { resources: catalog }
    },
    async loadDefinition() {
      return { blueprintId: definition.id, definitionJson: serialized, documentRevision: 'document', semanticRevision: 'semantic', layoutRevision: 'layout' }
    }
  }
  const Panel = createBlueprintPanel({ hostLink: host, storage: undefined })
  const render = () => {
    active = owner
    owner.stateCursor = owner.refCursor = 0
    const entry = Panel({ t: translate })
    assert.equal(entry.props.workspace, owner.states[0])
    assert.equal(entry.props.workspaceSnapshot, owner.states[0].getSnapshot())
    active = child
    child.stateCursor = child.refCursor = 0
    let tree = entry.type(entry.props)
    const provider = elements(tree).find(el => el.type === 'provider')
    assert.ok(provider)
    if (child.providerKey !== provider.key) {
      child.bridgeCleanup?.()
      const bridge = elements(provider).find(el => typeof el.type === 'function' && typeof el.props.onReady === 'function')
      assert.ok(bridge)
      runBridgeEffect = true
      try {
        bridge.type(bridge.props)
      } finally {
        runBridgeEffect = false
      }
      child.providerKey = provider.key
      child.stateCursor = child.refCursor = 0
      tree = entry.type(entry.props)
    }
    return tree
  }
  render()
  const workspace = owner.states[0]
  await workspace.initialize()
  await workspace.load(definition.id)
  for (const [availableCatalog, expected] of [
    [catalog, 'Review / QA · Review · Search'],
    [[], 'Review / QA · review · mcp__search__query']
  ]) {
    workspace.host.listResources = async () => ({ resources: availableCatalog })
    await workspace.refreshResources()
    const tree = render(),
      flow = elements(tree).find(item => item.type === 'flow')
    assert.equal(flow.props.nodes[0].data.summary, expected)
    for (const [id, ref] of Object.entries(definition.resources)) {
      const key = ref.source?.kind === 'host' ? `dsh:${ref.kind}:${ref.source.id}` : `blueprint:${id}`
      const row = elements(tree).find(item => item.props['data-bp-resource-row'] === key)
      const title = elements(row).find(item => item.props['data-bp-resource-title']).props.children
      const label =
        ref.source?.kind === 'host' ? (availableCatalog.find(row => row.kind === ref.kind && row.id === ref.source.id)?.displayName ?? ref.source.id) : id
      const source = en[ref.source?.kind === 'host' ? 'resource.host' : 'resource.blueprint']
      assert.equal(title, `${label} - ${source}`)
      if (ref.source?.kind === 'host') {
        assert.equal(title.includes(id), false)
        row.props.onClick()
        const dialog = elements(render()).find(item => item.props['data-bp-resource-dialog'])
        const json = elements(dialog).find(item => item.props.label === en['resource.newJson'])
        assert.deepEqual(JSON.parse(json.props.value), ref, 'resource dialog JSON retains canonical source data')
        elements(dialog)
          .find(item => item.props['data-bp-action'] === 'resource-cancel')
          .props.onClick()
      }
    }
    assert.equal(elements(tree).filter(item => item.props['data-bp-resource']).length, 0, 'legacy resource list must not duplicate categorized cards')
    assert.equal(JSON.stringify(workspace.editor.exportDefinition()), serialized, 'display never rewrites canonical keys or source identity')
  }
})
