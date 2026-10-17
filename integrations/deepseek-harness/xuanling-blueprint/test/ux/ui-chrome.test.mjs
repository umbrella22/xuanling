// Callable product controls and layout effects; native geometry/locale acceptance is main-owned.
import assert from 'node:assert/strict'
import test from 'node:test'
import { iconControl } from '../../src/client/features/compact/logic/compact-chrome.ts'
import { WorkspaceTooltip } from '../../src/client/shared/controls/tooltips.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
const h = (type, props, ...children) => ({ type, props: props ?? {}, children })
const all = (tree, pred) =>
  !tree || typeof tree !== 'object' ? [] : [...(pred(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => all(child, pred))]
const tFor = dict => key => {
  assert.ok(Object.hasOwn(dict, key), key)
  return dict[key]
}
for (const dict of [en, zh]) {
  test(`compact C01 ${dict === zh ? 'zh' : 'en'} disabled native icon keeps focus/hover reason and refuses activation`, () => {
    let tooltip = null,
      activated = 0
    const wrapper = iconControl(
      { createElement: h },
      tFor(dict),
      {
        action: 'undo',
        labelKey: 'action.undo',
        icon: 'undo',
        reason: 'interaction.disabled.history-unavailable',
        shortcut: 'Ctrl / ⌘ Z',
        onClick: () => activated++
      },
      value => (tooltip = value)
    )
    const button = wrapper.children[0],
      anchor = {}
    assert.equal(button.props.disabled, true)
    assert.equal(button.props['aria-disabled'], true)
    assert.equal(wrapper.props.tabIndex, 0)
    assert.match(wrapper.props['aria-label'], new RegExp(dict['interaction.disabled.history-unavailable']))
    assert.equal(button.props['aria-label'], dict['action.undo'])
    assert.equal(button.children[0].props['aria-hidden'], true)
    wrapper.props.onFocus({ currentTarget: anchor })
    assert.equal(tooltip.anchor, anchor)
    const bubble = WorkspaceTooltip({
      React: { createElement: h, useRef: () => ({ current: null }), useState: initial => [initial, () => {}], useEffect() {} },
      root: { current: null },
      content: tooltip,
      t: tFor(dict),
      onClose() {}
    })
    assert.equal(bubble.props.role, 'tooltip')
    assert.equal(bubble.props['data-bp-tooltip'], 'undo')
    assert.equal(all(bubble, n => n.type === 'small')[0].children[0], dict['interaction.disabled.history-unavailable'])
    assert.equal(all(bubble, n => n.type === 'kbd')[0].children[0], 'Ctrl / ⌘ Z')
    button.props.onClick()
    assert.equal(activated, 0)
    assert.equal(tooltip, null)
    wrapper.props.onMouseEnter({ currentTarget: anchor })
    assert.ok(tooltip)
    let stopped = false
    wrapper.props.onKeyDown({
      key: 'Escape',
      stopPropagation() {
        stopped = true
      }
    })
    assert.equal(stopped, true)
    assert.equal(tooltip, null)
  })
}
test('compact C01 tooltip tracks workspace resize, flips above a low anchor, clamps all edges and cleans listeners', () => {
  const descriptors = new Map(['document', 'window', 'ResizeObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const listeners = new Map(),
    observed = []
  let observer,
    disconnected = 0,
    closed = 0,
    width = 500,
    height = 400,
    position,
    effect
  const element = { getBoundingClientRect: () => ({ width: 180, height: 70 }) },
    root = { current: { getBoundingClientRect: () => ({ left: 100, top: 50, width, height }) } }
  globalThis.document = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  globalThis.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  globalThis.ResizeObserver = class {
    constructor(fn) {
      observer = fn
    }
    observe(value) {
      observed.push(value)
    }
    disconnect() {
      disconnected++
    }
  }
  const React = {
    createElement: h,
    useRef: () => ({ current: element }),
    useState: initial => [(position ??= initial), value => (position = value)],
    useEffect: fn => (effect = fn)
  }
  const content = { action: 'more-actions', labelKey: 'compact.more', anchor: { getBoundingClientRect: () => ({ left: 580, top: 410, bottom: 450 }) } }
  const render = () => WorkspaceTooltip({ React, root, content, t: tFor(en), onClose: () => closed++ })
  try {
    render()
    const cleanup = effect()
    assert.deepEqual(observed, [element, root.current])
    assert.deepEqual(render().props.style, { left: 320, top: 284 })
    width = 220
    height = 100
    observer()
    assert.deepEqual(render().props.style, { left: 40, top: 30 })
    listeners.get('keydown')({ key: 'Escape' })
    assert.equal(closed, 1)
    listeners.get('keydown')({ key: 'Tab' })
    assert.equal(closed, 2)
    listeners.get('pointerdown')({})
    assert.equal(closed, 3)
    cleanup()
    assert.equal(disconnected, 1)
    assert.equal(listeners.size, 0)
  } finally {
    for (const [key, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
  }
})
