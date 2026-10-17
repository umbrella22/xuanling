// Real React DOM, synthetic anchors, no Host/profile/provider.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { WorkspaceTooltip } from '__tooltip_under_test__'
const container = document.getElementById('root')!
const root = createRoot(container)
const tracked = new Map<EventTarget, Map<string, Set<EventListenerOrEventListenerObject>>>()
const add = EventTarget.prototype.addEventListener
const remove = EventTarget.prototype.removeEventListener
const capture = (options: boolean | AddEventListenerOptions | undefined) => (typeof options === 'boolean' ? options : !!options?.capture)
const relevant = (target: EventTarget, type: string) =>
  (target === document && ['keydown', 'pointerdown'].includes(type)) || (target === window && type === 'resize')
EventTarget.prototype.addEventListener = function (type, callback, options) {
  if (callback && relevant(this, type)) {
    const entries = tracked.get(this) ?? new Map()
    tracked.set(this, entries)
    const key = `${type}:${capture(options)}`
    const callbacks = entries.get(key) ?? new Set()
    entries.set(key, callbacks)
    callbacks.add(callback)
  }
  return add.call(this, type, callback, options)
}
EventTarget.prototype.removeEventListener = function (type, callback, options) {
  if (callback && relevant(this, type))
    tracked
      .get(this)
      ?.get(`${type}:${capture(options)}`)
      ?.delete(callback)
  return remove.call(this, type, callback, options)
}
const NativeObserver = ResizeObserver
const observers = new Map<ResizeObserver, Set<Element>>()
window.ResizeObserver = class extends NativeObserver {
  constructor(callback: ResizeObserverCallback) {
    super(callback)
    observers.set(this, new Set())
  }
  observe(element: Element, options?: ResizeObserverOptions) {
    observers.get(this)!.add(element)
    super.observe(element, options)
  }
  unobserve(element: Element) {
    observers.get(this)!.delete(element)
    super.unobserve(element)
  }
  disconnect() {
    observers.get(this)!.clear()
    super.disconnect()
  }
}
let closes = 0
const anchor = document.getElementById('anchor')!
const workspace = { current: document.getElementById('workspace') as HTMLDivElement }
const snapshot = () => ({
  listeners: [...tracked.entries()]
    .flatMap(([target, entries]) =>
      [...entries]
        .filter(([, callbacks]) => callbacks.size)
        .map(([key, callbacks]) => `${target === document ? 'document' : 'window'}:${key}:${callbacks.size}`)
    )
    .sort(),
  observed: [...observers.values()].reduce((sum, elements) => sum + elements.size, 0),
  closes
})
let epoch = 0
Object.assign(window, {
  tooltipFixture: {
    snapshot,
    render() {
      const current = ++epoch
      root.render(
        React.createElement(WorkspaceTooltip, {
          React,
          root: workspace,
          content: { action: `synthetic-${current}`, labelKey: 'compact.more', shortcut: 'Ctrl Z', anchor },
          t: () => 'Synthetic tooltip',
          onClose: () => {
            closes++
          }
        })
      )
      return current
    },
    hide() {
      root.render(null)
    },
    dispose() {
      root.unmount()
    }
  }
})
