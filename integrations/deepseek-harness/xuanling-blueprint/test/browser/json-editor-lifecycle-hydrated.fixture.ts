import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { EditorView } from '@codemirror/view'
import { JsonEditor } from '../../src/client/features/authoring/logic/inspector/json-editor.ts'
import type { JsonEditorProps } from '../../src/client/features/authoring/logic/inspector/json-editor.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'

const observers = new Set<IntersectionObserver>()
const NativeObserver = window.IntersectionObserver
window.IntersectionObserver = class extends NativeObserver {
  override observe(target: Element) {
    if (target.matches('[data-bp-json-editor]')) observers.add(this)
    super.observe(target)
  }
  override disconnect() {
    observers.delete(this)
    super.disconnect()
  }
}
const changes: Array<{ owner: string; text: string }> = []
const blurs: Array<{ owner: string; text: string }> = []
let owner = 'first'
let props: JsonEditorProps
let root: ReturnType<typeof createRoot> | undefined
let held: EditorView | null = null
const render = () => {
  const currentOwner = owner
  flushSync(() =>
    root?.render(
      React.createElement(JsonEditor, {
        ...props,
        onChange: text => changes.push({ owner: currentOwner, text }),
        onBlur: text => blurs.push({ owner: currentOwner, text })
      })
    )
  )
}
Object.assign(window, {
  jsonLifecycle: {
    mount() {
      owner = 'first'
      props = { defaultValue: '{"initial":1}', label: 'JSON buffer', name: 'payload', rows: 4, t: key => en[key] }
      changes.length = 0
      blurs.length = 0
      root = createRoot(document.getElementById('mount')!)
      render()
    },
    update(next: Partial<JsonEditorProps>, nextOwner = owner) {
      props = { ...props, ...next }
      owner = nextOwner
      render()
    },
    capture() {
      held = EditorView.findFromDOM(document.querySelector('.cm-editor')!)
      return !!held
    },
    unmount() {
      flushSync(() => root?.unmount())
      root = undefined
    },
    stats() {
      return { observers: observers.size, changes: [...changes], blurs: [...blurs], destroyed: held?.destroyed ?? false, composing: held?.composing ?? false }
    }
  }
})
installCanvasStyles()
