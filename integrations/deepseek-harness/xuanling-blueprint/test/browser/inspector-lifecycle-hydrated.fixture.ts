import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { GraphEditor } from '../../src/client/features/authoring/logic/graph/graph-editor.ts'
import { NodeInspector } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import type { HostResourceCatalogEntry } from '../../src/client/adapters/host/remote.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'
const definition = {
  schemaVersion: 2 as const,
  id: 'inspector-lifecycle',
  name: 'Inspector',
  resources: { local: { kind: 'agent' as const, path: 'agents/local.md' } },
  graph: {
    nodes: [
      {
        id: 'task',
        kind: 'agentTask' as const,
        agentRef: 'local',
        inputs: {},
        outputs: { original: 'string' },
        modelSelection: { provider: 'fixture-provider', model: 'initial-model' }
      },
      { id: 'other', kind: 'agentTask' as const, agentRef: 'local', inputs: {}, outputs: {} }
    ],
    edges: []
  }
}
let editor: GraphEditor
let root: ReturnType<typeof createRoot> | undefined
let language: 'en' | 'zh' = 'en'
let nodeId = 'task'
let subscriptions = 0
let catalog: HostResourceCatalogEntry[] = []
let captureNext: 'port' | 'resource' | null = null
let retained: ((event: { currentTarget: { checked: boolean } }) => void) | undefined
// Capture the actual public React event prop without replacing the component,
// its hooks, session or command dispatcher.
React.createElement = new Proxy(React.createElement, {
  apply(target, receiver, args) {
    if (
      (captureNext === 'port' && args[1]?.['data-bp-port-toggle'] === 'outputs') ||
      (captureNext === 'resource' && args[1]?.['data-bp-field'] === 'skillRefs')
    ) {
      retained = args[1].onChange
      captureNext = null
    }
    return Reflect.apply(target, receiver, args)
  }
})
const render = () =>
  flushSync(() =>
    root?.render(
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          'fieldset',
          { className: 'bp-workspace' },
          React.createElement(NodeInspector, {
            editor,
            node: editor.nodes.find(node => node.id === nodeId)!,
            resources: editor.exportDefinition().resources,
            resourceCatalog: catalog,
            t: (key, params = {}) => (language === 'zh' ? zh : en)[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name as keyof typeof params]))
          })
        )
      )
    )
  )
Object.assign(window, {
  inspectorLifecycle: {
    mount() {
      editor = GraphEditor.fromDefinition(definition)
      const subscribe = editor.subscribe.bind(editor)
      editor.subscribe = listener => {
        subscriptions++
        const off = subscribe(listener)
        return () => {
          subscriptions--
          off()
        }
      }
      language = 'en'
      nodeId = 'task'
      catalog = [
        { kind: 'skill', id: 'live skill', displayName: 'Live skill', description: '', source: 'dsh', provenance: 'custom', availability: 'available' }
      ]
      root = createRoot(document.getElementById('mount')!)
      render()
    },
    locale(value: 'en' | 'zh') {
      language = value
      render()
    },
    node(id: string) {
      nodeId = id
      render()
    },
    concurrent() {
      editor.updateNode('task', { modelSelection: { provider: 'fixture-provider', model: 'concurrent-model' } })
    },
    undo() {
      editor.undo()
    },
    catalog(available: boolean) {
      catalog = catalog.map(entry => ({ ...entry, availability: available ? 'available' : 'unavailable' }))
      render()
    },
    capture(kind: 'port' | 'resource' = 'port') {
      captureNext = kind
      render()
      return !!retained
    },
    replay(checked = false) {
      retained?.({ currentTarget: { checked } })
    },
    unmount() {
      flushSync(() => root?.unmount())
      root = undefined
    },
    stats() {
      return { subscriptions, definition: editor.exportDefinition(), canUndo: editor.canUndo }
    }
  }
})
installCanvasStyles()
