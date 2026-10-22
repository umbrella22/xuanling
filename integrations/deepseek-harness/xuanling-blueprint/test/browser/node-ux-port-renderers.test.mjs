import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { InspectorSession, renderNodeInspector } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import { frozenPresentationCodec } from '../../src/conversation/contracts.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
const translate =
  d =>
  (k, p = {}) => {
    assert.ok(Object.hasOwn(d, k), k)
    return d[k].replace(/\{(\w+)\}/g, (_, n) => String(p[n]))
  }
const elements = x => (Array.isArray(x) ? x.flatMap(elements) : !React.isValidElement(x) ? [] : [x, ...elements(x.props.children)])
const definition = () => ({
  schemaVersion: 2,
  id: 'Ports',
  name: 'Synthetic',
  resources: {},
  graph: {
    nodes: [
      { id: 'a', kind: 'input', inputs: { '入.中文': 'string' }, outputs: { '出.中文': 'string' } },
      { id: 'b', kind: 'output', inputs: { value: 'string' } }
    ],
    edges: []
  },
  presentation: {
    nodes: {
      a: { x: 0, y: 0, ports: { control: false, inputs: false, outputs: false } },
      b: { x: 300, y: 0 }
    }
  }
})
import { registerHooks } from 'node:module'
const key = Symbol.for('blueprint.test.port.renderers'),
  seat = { active: null }
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) =>
    type?.name === 'CanvasSurface' ? type(props ?? {}) : { type, props: props ?? {}, children: children.length ? children : [props?.children] },
  memo: fn => fn,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
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
  useEffect(effect) {
    if (seat.runBridgeEffect) seat.active.bridgeCleanup = effect()
  }
}
const url = code => `data:text/javascript,${encodeURIComponent(code)}`
const reactUrl = url(
  `export default globalThis[Symbol.for('blueprint.test.port.renderers')].react; export const createElement=globalThis[Symbol.for('blueprint.test.port.renderers')].react.createElement;`
)
const flow = url(`export const useReactFlow=()=>globalThis[Symbol.for('blueprint.test.port.renderers')].active.flowApi;
export const Position={Left:'left',Right:'right'},MarkerType={ArrowClosed:'arrowclosed'};
export const ReactFlow='flow',ReactFlowProvider='provider',Background='background',Controls='controls',MiniMap='minimap',Handle='handle',NodeResizer='resizer',BaseEdge='base-edge'; export const getSmoothStepPath=()=>['M 0 0 L 1 1',0,0];`)
// Inspector is a frozen opaque boundary here, not a fake editor implementation.
const inspector = url('export function NodeInspector(){}')
const client = new URL('../../src/client/', import.meta.url).href
const hooks = registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL?.startsWith(client) && spec === 'react') return { url: reactUrl, shortCircuit: true }
    if (
      (context.parentURL === `${client}features/authoring/ui/panel/panel-composition.tsx` ||
        context.parentURL === `${client}features/authoring/ui/panel/panel-controller.tsx` ||
        context.parentURL === `${client}features/authoring/ui/canvas/canvas-surface.tsx` ||
        context.parentURL === `${client}features/authoring/ui/canvas/canvas-renderers.tsx`) &&
      spec === '@xyflow/react'
    )
      return { url: flow, shortCircuit: true }
    if (
      (context.parentURL === `${client}features/authoring/ui/panel/panel-composition.tsx` ||
        context.parentURL === `${client}features/authoring/ui/panel/panel-controller.tsx`) &&
      spec === '../inspector/inspector-composition.tsx'
    )
      return { url: inspector, shortCircuit: true }
    return next(spec, context)
  }
})
let createBlueprintPanel
try {
  ;({ createBlueprintPanel } = await import(`${client}features/authoring/ui/panel/panel-composition.tsx`))
} finally {
  hooks.deregister()
}
test.after(() => {
  delete globalThis[key]
})

const all = (tree, predicate) =>
  !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => all(child, predicate))]

// Render the real root and child with independent React hook owners. The local
// Flow bridge commits its API before callbacks run, as it does after mounting.
function panelRenderer(Panel, f, t) {
  const owner = { states: [], refs: [], memos: [], cursor: 0, refCursor: 0, memoCursor: 0 }
  f.flowApi = f.flow
  return () => {
    seat.active = owner
    owner.cursor = owner.refCursor = owner.memoCursor = 0
    const entry = Panel({ t })
    f.workspace = entry.props.workspace
    assert.equal(f.workspace, owner.states[0])
    assert.equal(entry.props.workspaceSnapshot, f.workspace.getSnapshot())
    seat.active = f
    f.cursor = f.refCursor = f.memoCursor = 0
    let tree = entry.type(entry.props)
    const provider = all(tree, n => n.type === 'provider')[0]
    assert.ok(provider)
    if (f.providerKey !== provider.props.key) {
      f.bridgeCleanup?.()
      const bridge = all(provider, n => typeof n.type === 'function' && typeof n.props.onReady === 'function')[0]
      assert.ok(bridge)
      seat.runBridgeEffect = true
      try {
        bridge.type(bridge.props)
      } finally {
        seat.runBridgeEffect = false
      }
      f.providerKey = provider.props.key
      f.cursor = f.refCursor = f.memoCursor = 0
      tree = entry.type(entry.props)
    }
    return tree
  }
}
for (const dict of [en, zh])
  test(`Inspector real toggles and connected typed refusal ${dict === en ? 'en' : 'zh'}`, () => {
    const editor = GraphEditor.fromDefinition(definition()),
      session = new InspectorSession(editor, 'a'),
      t = translate(dict)
    const render = () => renderNodeInspector({ node: editor.nodes[0], editor, resources: {}, t }, session, session.getSnapshot())
    for (const side of ['control', 'inputs', 'outputs']) {
      const toggle = elements(render()).find(e => e.props['data-bp-port-toggle'] === side)
      assert.ok(toggle)
      assert.equal(toggle.props.checked, false)
      assert.equal(toggle.props['aria-label'], dict[`port.visibility.${side}`])
      toggle.props.onChange({ currentTarget: { checked: true } })
      assert.equal(editor.exportLayout().nodes.a.ports[side], true)
    }
    editor.undo()
    assert.equal(elements(render()).find(e => e.props['data-bp-port-toggle'] === 'outputs').props.checked, false)
    editor.redo()
    assert.equal(elements(render()).find(e => e.props['data-bp-port-toggle'] === 'outputs').props.checked, true)
    editor.patchPresentation(['a'], { ports: { inputs: false } })
    assert.equal(elements(render()).find(e => e.props['data-bp-port-toggle'] === 'inputs').props.checked, false)
    assert.deepEqual(frozenPresentationCodec().parse(editor.exportLayout()), editor.exportLayout())
    editor.connect(
      { nodeId: 'a', direction: 'out', kind: 'data', port: '出.中文', type: 'string' },
      { nodeId: 'b', direction: 'in', kind: 'data', port: 'value', type: 'string' }
    )
    const before = editor.exportDefinition(),
      history = editor.canUndo
    elements(render())
      .find(e => e.props['data-bp-port-toggle'] === 'outputs')
      .props.onChange({ currentTarget: { checked: false } })
    assert.deepEqual(editor.exportDefinition(), before)
    assert.equal(editor.canUndo, history)
    assert.equal(session.getSnapshot().notice.key, 'connection.portVisibilityConnected')
    assert.equal(session.getSnapshot().notice.params.edgeCount, 1)
  })
for (const connected of [false, true])
  test(`actual BlueprintNode handles use effective edge priority connected=${connected}`, async () => {
    const d = definition()
    if (connected) d.graph.edges.push({ kind: 'data', from: 'a.出.中文', to: 'b.value' })
    const doc = {
      blueprintId: d.id,
      definitionJson: JSON.stringify(d),
      documentRevision: 'doc',
      semanticRevision: 'semantic',
      layoutRevision: 'layout'
    }
    const host = {
      async listDefinitions() {
        return {
          definitions: [
            {
              blueprintId: d.id,
              name: d.name,
              documentRevision: 'doc',
              semanticRevision: 'semantic'
            }
          ]
        }
      },
      async loadDefinition() {
        return doc
      },
      async validate() {
        return { ok: true }
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
    const render = panelRenderer(Panel, f, translate(en))
    render()
    await f.workspace.initialize()
    await f.workspace.load(d.id)
    const flow = all(render(), n => n.type === 'flow')[0],
      n = flow.props.nodes.find(n => n.id === 'a')
    const body = flow.props.nodeTypes.blueprint({ id: n.id, data: n.data, selected: false })
    assert.equal(all(body, e => e.props['data-bp-port-edge-priority']).length, connected ? 1 : 0)
    if (!connected) {
      const oldHeight = n.data.minHeight
      f.workspace.editor.patchPresentation(['a'], { ports: { inputs: true } })
      const refreshed = all(render(), e => e.type === 'flow')[0].props.nodes.find(e => e.id === 'a')
      assert.ok(refreshed.data.minHeight > oldHeight, 'actual parent Panel updates visible row geometry')
      f.workspace.editor.undo()
      assert.equal(all(render(), e => e.type === 'flow')[0].props.nodes.find(e => e.id === 'a').data.minHeight, oldHeight)
    }
    const handles = all(body, e => e.type === 'handle')
    assert.deepEqual(
      handles.map(h => h.props.id),
      connected ? ['data:出.中文'] : []
    )
    assert.equal(flow.props.edges.length, connected ? 1 : 0)
    assert.deepEqual(f.workspace.editor.exportDefinition().graph, d.graph)
  })

import { ConversationController } from '../../src/client/features/conversation/logic/conversation-controller.ts'
const frozenKey = Symbol.for('blueprint.test.port.frozen')
const frozenSeat = { active: null }
globalThis[frozenKey] = frozenSeat
frozenSeat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState(initial) {
    const f = frozenSeat.active,
      i = f.stateCursor++
    f.states[i] ??= typeof initial === 'function' ? initial() : initial
    return [
      f.states[i],
      value => {
        f.states[i] = value
      }
    ]
  },
  useRef(initial) {
    const f = frozenSeat.active,
      i = f.refCursor++
    return (f.refs[i] ??= { current: initial })
  },
  useEffect(callback, deps) {
    const f = frozenSeat.active,
      i = f.effectCursor++,
      old = f.effects[i]
    if (!old || deps.some((value, index) => value !== old.deps[index])) {
      old?.cleanup?.()
      f.effects[i] = { callback, deps, cleanup: null, pending: true }
    }
  }
}
const frozenUrl = source => `data:text/javascript,${encodeURIComponent(source)}`
const frozenClient = new URL('../../src/client/', import.meta.url).href
const frozenHooks = registerHooks({
  resolve(spec, context, next) {
    if (context.parentURL?.startsWith(`${frozenClient}features/conversation/`) && spec === 'react')
      return {
        url: frozenUrl("export default globalThis[Symbol.for('blueprint.test.port.frozen')].react"),
        shortCircuit: true
      }
    if (context.parentURL?.startsWith(`${frozenClient}features/conversation/`) && spec === '@xyflow/react')
      return {
        url: frozenUrl(
          "export const ReactFlow='flow',Handle='handle',BaseEdge='edge';export const Position={Left:'left',Right:'right'};export const getSmoothStepPath=()=>['M 0 0 L 1 1'];"
        ),
        shortCircuit: true
      }
    return next(spec, context)
  }
})
let View
try {
  ;({ ConversationBlueprintView: View } = await import(`${frozenClient}features/conversation/ui/conversation-view.tsx?port-renderer-seat`))
} finally {
  frozenHooks.deregister()
}
test.after(() => {
  delete globalThis[frozenKey]
})

for (const dict of [en, zh])
  for (const connected of [false, true])
    test(`actual FrozenNode readonly handles ${dict === en ? 'en' : 'zh'} connected=${connected}`, async () => {
      const d = definition()
      if (connected) d.graph.edges.push({ kind: 'data', from: 'a.出.中文', to: 'b.value' })
      const value = {
        status: 'bound',
        sessionId: 'source',
        runs: [{ runId: 'run', state: 'succeeded', createdAt: 1, definitionRevision: 'frozen' }],
        selected: {
          run: {
            runId: 'run',
            state: 'succeeded',
            seq: 1,
            definitionRevision: 'frozen',
            attempts: [],
            logTail: []
          },
          graph: d.graph,
          presentation: d.presentation,
          focusAttemptIds: []
        }
      }
      const before = structuredClone(value),
        controller = new ConversationController(
          {
            async inspectSession() {
              return value
            }
          },
          'source'
        )
      await controller.refresh()
      const state = {
        states: [],
        refs: [],
        effects: [],
        stateCursor: 0,
        refCursor: 0,
        effectCursor: 0
      }
      frozenSeat.active = state
      const flow = all(View({ controller, sessionId: 'source', t: translate(dict) }), n => n.type === 'flow')[0],
        node = flow.props.nodes.find(n => n.id === 'a')
      const body = flow.props.nodeTypes.frozen({ id: 'a', data: node.data, selected: false })
      const handles = all(body, n => n.type === 'handle')
      assert.deepEqual(
        handles.map(h => h.props.id),
        connected ? ['data:出.中文'] : []
      )
      assert.ok(handles.every(h => h.props.isConnectable === false))
      assert.equal(flow.props.edges.length, connected ? 1 : 0)
      assert.deepEqual(value, before)
      for (const h of handles)
        assert.equal(
          h.props['aria-label'],
          translate(dict)('node.portAria', {
            nodeId: 'a',
            direction: translate(dict)('port.output'),
            kind: translate(dict)('port.data'),
            port: '出.中文'
          })
        )
    })
