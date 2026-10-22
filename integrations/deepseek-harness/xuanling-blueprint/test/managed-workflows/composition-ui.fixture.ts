import React from 'react'
import { createRoot } from 'react-dom/client'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { resolveBlueprintHost } from '../../src/client/adapters/host/remote.ts'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'
let workspace: BlueprintWorkspace
let applyCallback: (() => void) | undefined
let retainedApply: (() => void) | undefined
let delayReference = false
let releaseReference: (() => void) | undefined
const createElement = React.createElement
React.createElement = new Proxy(createElement, {
  apply(target, receiver, args) {
    if (args[1]?.['data-bp-child-apply']) applyCallback = args[1].onClick
    return Reflect.apply(target, receiver, args)
  }
})
const useState = React.useState
React.useState = ((initial: unknown) => {
  const state = useState(initial)
  if (state[0] instanceof BlueprintWorkspace) workspace = state[0]
  return state
}) as typeof React.useState
const { createBlueprintPanel } = await import('../../src/client/features/authoring/ui/panel/panel-composition.tsx')
const namespace = Object.fromEntries(
  BLUEPRINT_INVOCATIONS.map(({ method }) => [
    method,
    async (args = {}) => {
      const result = await fetch(`/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
      const value = await result.json()
      if (method === 'inspectBlueprintReference' && delayReference) {
        delayReference = false
        await new Promise<void>(resolve => (releaseReference = resolve))
      }
      return value
    }
  ])
)
const host = resolveBlueprintHost({ get: () => namespace })!
const Panel = createBlueprintPanel({ hostLink: host, storage: localStorage })
let language: 'en' | 'zh' = 'en'
const root = createRoot(document.getElementById('root')!)
const render = () =>
  root.render(
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(Panel, {
        t: (key, params = {}) => (language === 'en' ? en : zh)[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name as keyof typeof params]))
      })
    )
  )
Object.assign(window, {
  composition: {
    state: () => workspace && { id: workspace.blueprintId, definition: workspace.editor.exportDefinition(), canUndo: workspace.editor.canUndo },
    locale(value: 'en' | 'zh') {
      language = value
      render()
    },
    retainApply() {
      retainedApply = applyCallback
    },
    replayApply() {
      retainedApply?.()
    },
    delay() {
      delayReference = true
    },
    release() {
      releaseReference?.()
    },
    pending: () => !!releaseReference,
    unmount() {
      root.unmount()
    }
  }
})
document.body.style.margin = '0'
installCanvasStyles()
render()
