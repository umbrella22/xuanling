// Actual production Panel with real React hooks; capture only public element props.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'
const workspaces: BlueprintWorkspace[] = []
const callbacks = new Map<string, (...args: any[]) => unknown>()
const retained = new Map<string, (...args: any[]) => unknown>()
let rendering = 0
const originalState = React.useState
React.useState = ((initial: unknown) => {
  const value = originalState(initial)
  if (value[0] instanceof BlueprintWorkspace) {
    const known = workspaces.indexOf(value[0])
    if (known >= 0) rendering = known
    workspaces[rendering] = value[0]
  }
  return value
}) as typeof React.useState
React.createElement = new Proxy(React.createElement, {
  apply(target, receiver, args) {
    const props = args[1]
    if (props?.['data-bp-action'] && props.onClick) callbacks.set(`${rendering}:${props['data-bp-action']}`, props.onClick)
    if (props?.['data-bp-select'] === 'blueprint') callbacks.set(`${rendering}:load`, props.onChange)
    if (props?.['data-bp-run-input']) callbacks.set(`${rendering}:input`, props.onChange)
    return Reflect.apply(target, receiver, args)
  }
})
const { createBlueprintPanel } = await import('../../src/client/features/authoring/ui/panel/panel-composition.tsx')
const calls: unknown[][] = []
const definition = (id: string) => ({
  schemaVersion: 2,
  id,
  name: id,
  resources: {},
  graph: { nodes: id === 'distant' ? [{ id: 'far-input', kind: 'input', outputs: { value: 'string' } }] : [], edges: [] },
  ...(id === 'distant' ? { presentation: { nodes: { 'far-input': { x: 1500, y: 1200 } } } } : {})
})
const doc = (id: string) => ({
  blueprintId: id,
  documentRevision: `doc-${id}`,
  semanticRevision: `sem-${id}`,
  layoutRevision: 'layout',
  definitionJson: JSON.stringify(definition(id))
})
const catalog = ['one', 'two', 'distant'].map(id => ({ blueprintId: id, name: id, documentRevision: `doc-${id}`, semanticRevision: `sem-${id}` }))
const roots = [0, 1].map(i => createRoot(document.getElementById(`root-${i}`)!))
const panels = [0, 1].map(index => {
  const host = {
    async listResources() {
      return { resources: [] }
    },
    async listDefinitions() {
      return { definitions: catalog }
    },
    async loadDefinition(id: string) {
      calls.push([index, 'load', id])
      return doc(id)
    },
    async saveDefinition(id: string, json: string, revision: string | null) {
      calls.push([index, 'save', id, json, revision])
      return { ...doc(id), definitionJson: json }
    },
    async preflightRun(id: string, revision: string, input: string) {
      calls.push([index, 'check', id, input])
      return { blueprintId: id, documentRevision: revision, semanticRevision: `sem-${id}`, canStart: true, checks: [] }
    },
    async startRun(id: string) {
      calls.push([index, 'start', id])
      return { runId: 'run', state: 'queued', replayed: false }
    },
    async inspectRun(runId: string) {
      calls.push([index, 'inspect', runId])
      return { runId, state: 'running', seq: 0, definitionRevision: 'sem-one', attempts: [], logTail: [] }
    }
  }
  const values = new Map<string, string>()
  return createBlueprintPanel({
    hostLink: host,
    storage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value)
      }
    }
  })
})
let language: 'en' | 'zh' = 'en'
const render = (index: number, strict = true) => {
  rendering = index
  flushSync(() =>
    roots[index]!.render(
      React.createElement(
        strict ? React.StrictMode : React.Fragment,
        null,
        React.createElement(panels[index]!, {
          t: (key, params = {}) => (language === 'en' ? en : zh)[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name as keyof typeof params]))
        })
      )
    )
  )
}
const pending = new Map<number, () => void>()
Object.assign(window, {
  panelSnapshot: {
    render,
    async load(index: number, id: string) {
      await workspaces[index]!.load(id)
    },
    capture(index: number, action: string) {
      const key = `${index}:${action}`
      const value = callbacks.get(key)
      if (!value) throw new Error(`missing callback ${key}`)
      retained.set(key, value)
    },
    invoke(index: number, action: string, value?: string) {
      rendering = index
      return retained.get(`${index}:${action}`)!(action === 'load' ? { target: { value } } : action === 'input' ? value : {})
    },
    async settle() {
      await Promise.resolve()
      await Promise.resolve()
    },
    calls() {
      return calls
    },
    clear() {
      calls.length = 0
    },
    state(index: number) {
      const w = workspaces[index]!
      return { id: w.blueprintId, input: w.inputJson, busy: w.busy, connection: w.getSnapshot().run.connectionState }
    },
    model(index: number) {
      workspaces[index]!.model.applySnapshot({ runId: 'model-only', state: 'succeeded', seq: 1, definitionRevision: 'sem-one', attempts: [], logTail: [] })
    },
    locale(index: number) {
      language = language === 'en' ? 'zh' : 'en'
      render(index)
    },
    busy(index: number) {
      void workspaces[index]!.perform(() => new Promise<void>(resolve => pending.set(index, resolve)))
    },
    finish(index: number) {
      pending.get(index)?.()
    },
    unmount(index: number) {
      flushSync(() => roots[index]!.unmount())
    }
  }
})
installCanvasStyles()
render(0)
render(1)
