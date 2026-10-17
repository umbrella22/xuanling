import assert from 'node:assert/strict'
import test from 'node:test'
import {
  InteractionOverlay,
  clampOverlay,
  archiveBase64,
  archiveBytes,
  downloadBlueprint
} from '../../src/client/features/authoring/ui/overlays/interaction-overlays.tsx'
import { contextCommands } from '../../src/client/shared/controls/command-policy.ts'
import { zh, en } from '../../src/client/shared/i18n/locales.ts'
const all = (tree, pred) =>
  !tree || typeof tree !== 'object' ? [] : [...(pred(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(c => all(c, pred))]
function fixture(overlay, options = {}) {
  const f = { states: [], refs: [], cursor: 0, refCursor: 0, effects: [], added: [], commands: [], imports: [], names: [], closed: 0, dict: en }
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useRef: initial => (f.refs[f.refCursor++] ??= { current: initial }),
    useState(initial) {
      const i = f.cursor++
      if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial
      return [f.states[i], v => (f.states[i] = typeof v === 'function' ? v(f.states[i]) : v)]
    },
    useEffect: effect => f.effects.push(effect)
  }
  const facts = {
    canvasFocused: true,
    hasDefinition: true,
    busy: false,
    canvasLocked: false,
    selectedNodes: 1,
    selectedEdges: 1,
    selectedGroups: 0,
    movableNodes: 1,
    canUndo: true,
    canRedo: true,
    canPaste: true,
    canRun: true,
    canCancel: true,
    canOpen: true,
    canRefreshDefinitions: true
  }
  f.props = {
    React,
    overlay,
    root: { current: { getBoundingClientRect: () => ({ width: 600, height: 400 }) } },
    t: (k, params = {}) => {
      assert.ok(Object.hasOwn(f.dict, k), k)
      return f.dict[k].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
    },
    commands: contextCommands('node', facts),
    onCommand: c => f.commands.push(c),
    onAdd: k => f.added.push(k),
    onRename: n => f.names.push(n),
    onClose: () => f.closed++,
    importTargets: [
      { blueprintId: 'used', name: 'Used', nonempty: true },
      { blueprintId: 'empty', name: 'Empty', nonempty: false }
    ],
    onImportFile: (id, file) => f.imports.push([id, file]),
    ...options
  }
  f.render = () => {
    f.cursor = f.refCursor = 0
    f.effects = []
    return (f.tree = InteractionOverlay(f.props))
  }
  f.render()
  return f
}
const one = (f, pred) => {
  const found = all(f.render(), pred)
  assert.equal(found.length, 1)
  return found[0]
}
const event = key => ({ key, nativeEvent: {}, preventDefault() {}, stopPropagation() {} })
test('C02 overlays clamp all edges including oversized and negative origins', () => {
  assert.deepEqual(clampOverlay({ x: 580, y: 390 }, { width: 250, height: 260 }, { width: 600, height: 400 }), { x: 350, y: 140 })
  assert.deepEqual(clampOverlay({ x: -12, y: -5 }, { width: 800, height: 500 }, { width: 600, height: 400 }), { x: 0, y: 0 })
})
test('C03 search uses actual declared candidates and active descendant; bilingual filtering and IME retain edits', () => {
  const origin = { nodeId: 'a', port: 'raw', direction: 'out', kind: 'data', type: 'string' }
  const f = fixture({ kind: 'node-search', screen: { x: 0, y: 0 }, position: { x: 100, y: 100 }, origin })
  const input = () => one(f, n => n.props['data-bp-search-input'])
  assert.ok(!all(f.tree, n => n.props['data-bp-search-kind'] === 'condition').length)
  input().props.onChange({ currentTarget: { value: '输出' } })
  const option = one(f, n => n.props['data-bp-search-kind'] === 'output')
  assert.equal(option.props.role, 'option')
  assert.equal(input().props['aria-activedescendant'], 'bp-search-output')
  f.tree.props.onKeyDown({ ...event('Enter'), nativeEvent: { isComposing: true } })
  assert.deepEqual(f.added, [])
  f.tree.props.onKeyDown(event('Enter'))
  assert.deepEqual(f.added, ['output'])
  f.dict = zh
  assert.equal(one(f, n => n.props['data-bp-search-kind'] === 'output').children[0], '输出')
  f.tree.props.onKeyDown(event('Escape'))
  assert.equal(f.closed, 1)
})
test('C02 menu arrows/Home/End and Enter target real menu items; focus setup chooses search input', () => {
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const f = fixture({ kind: 'context-menu', surface: 'node', screen: { x: 0, y: 0 }, position: { x: 100, y: 100 } })
  const items = [0, 1, 2].map(id => ({
    focus() {
      globalThis.document.activeElement = this
    },
    id
  }))
  globalThis.document = { activeElement: items[0] }
  f.refs[0].current = { querySelectorAll: () => items }
  try {
    f.tree.props.onKeyDown(event('End'))
    assert.equal(document.activeElement, items[2])
    f.tree.props.onKeyDown(event('ArrowDown'))
    assert.equal(document.activeElement, items[0])
    f.tree.props.onKeyDown(event('ArrowUp'))
    assert.equal(document.activeElement, items[2])
    f.tree.props.onKeyDown(event('Home'))
    assert.equal(document.activeElement, items[0])
    one(f, n => n.props['data-bp-menu-command'] === 'copy').props.onClick()
    assert.deepEqual(f.commands, ['copy'])
    f.tree.props.onKeyDown(event('Tab'))
    assert.equal(f.closed, 1)
  } finally {
    if (savedDocument) Object.defineProperty(globalThis, 'document', savedDocument)
    else delete globalThis.document
  }
})
test('C02 overlay effect clamps and focuses the correct input; outside click closes and removes listeners', () => {
  const descriptors = new Map(['document', 'window', 'ResizeObserver'].map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]))
  const listeners = new Map(),
    queried = [],
    focus = []
  globalThis.document = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) }
  globalThis.window = { addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) }
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {
      focus.push('disconnect')
    }
  }
  try {
    const f = fixture({ kind: 'node-search', screen: { x: 595, y: 395 }, position: { x: 100, y: 100 } })
    f.refs[0].current = {
      getBoundingClientRect: () => ({ width: 250, height: 200 }),
      querySelector: s => {
        queried.push(s)
        return { focus: () => focus.push('search') }
      },
      contains: target => target === 'inside'
    }
    const cleanup = f.effects[0]()
    assert.deepEqual(queried, ['[data-bp-search-input]'])
    assert.equal(focus[0], 'search')
    assert.deepEqual(f.render().props.style, { left: 350, top: 200 })
    listeners.get('pointerdown')({ target: 'inside' })
    assert.equal(f.closed, 0)
    listeners.get('pointerdown')({ target: 'outside' })
    assert.equal(f.closed, 1)
    cleanup()
    assert.equal(listeners.size, 0)
  } finally {
    for (const [k, descriptor] of descriptors)
      if (descriptor) Object.defineProperty(globalThis, k, descriptor)
      else delete globalThis[k]
  }
})
test('C06 rename submits raw title without normalization', () => {
  const f = fixture({ kind: 'rename', targetId: 'a', group: false, value: '', screen: { x: 0, y: 0 } })
  one(f, n => n.props['data-bp-rename-field']).props.onChange({ currentTarget: { value: '  原样 title  ' } })
  one(f, n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(f.names, ['  原样 title  '])
})
test('C09 native file input and explicit configured ID confirmation; nonempty cannot submit', () => {
  const f = fixture({ kind: 'import', screen: { x: 0, y: 0 } }),
    file = { name: 'flow.zip' }
  assert.equal(one(f, n => n.props['data-bp-import-file']).props.type, 'file')
  assert.equal(one(f, n => n.type === 'option' && n.props.value === 'used').props.disabled, true)
  const submit = () => one(f, n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  one(f, n => n.props['data-bp-import-file']).props.onChange({ currentTarget: { files: [file] } })
  submit()
  assert.deepEqual(f.imports, [])
  one(f, n => n.props['data-bp-import-confirm']).props.onChange({ currentTarget: { checked: true } })
  submit()
  assert.deepEqual(f.imports, [['empty', file]])
  one(f, n => n.props['data-bp-import-target']).props.onChange({ currentTarget: { value: 'used' } })
  one(f, n => n.props['data-bp-import-confirm']).props.onChange({ currentTarget: { checked: true } })
  submit()
  assert.equal(f.imports.length, 1)
})
for (const reason of ['canvas-locked', 'busy']) {
  test(`C09 actual import overlay disables confirmed Apply for ${reason}, keeps close/Escape and resumes on release`, () => {
    const f = fixture({ kind: 'import', screen: { x: 0, y: 0 } }),
      file = { name: 'flow.zip' }
    one(f, n => n.props['data-bp-import-file']).props.onChange({ currentTarget: { files: [file] } })
    one(f, n => n.props['data-bp-import-confirm']).props.onChange({ currentTarget: { checked: true } })
    assert.equal(one(f, n => n.props['data-bp-action'] === 'import-apply').props.disabled, false)
    f.props.importDisabledReason = reason
    const apply = one(f, n => n.props['data-bp-action'] === 'import-apply')
    assert.equal(apply.props.disabled, true, 'C09_BLOCKED_IMPORT_APPLY_MUST_BE_DISABLED')
    assert.equal(one(f, n => n.props.role === 'status').children[0], en[`interaction.disabled.${reason}`])
    one(f, n => n.type === 'form').props.onSubmit({ preventDefault() {} })
    assert.deepEqual(f.imports, [])
    const close = one(f, n => n.props['aria-label'] === en['interaction.close'])
    assert.notEqual(close.props.disabled, true)
    close.props.onClick()
    assert.equal(f.closed, 1)
    f.render().props.onKeyDown(event('Escape'))
    assert.equal(f.closed, 2)
    f.dict = zh
    assert.equal(one(f, n => n.props.role === 'status').children[0], zh[`interaction.disabled.${reason}`])
    f.props.importDisabledReason = null
    assert.equal(one(f, n => n.props['data-bp-action'] === 'import-apply').props.disabled, false)
    one(f, n => n.type === 'form').props.onSubmit({ preventDefault() {} })
    assert.deepEqual(f.imports, [['empty', file]])
  })
}
test('C09 browser-only binary conversion retains arbitrary ZIP bytes and native download dispatch/revoke', () => {
  const bytes = Uint8Array.from([0, 255, 128, 65, 10, 13]),
    base64 = archiveBase64(bytes)
  assert.deepEqual(archiveBytes(base64), bytes)
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document'),
    create = URL.createObjectURL,
    revoke = URL.revokeObjectURL,
    timer = globalThis.setTimeout
  const calls = [],
    anchor = {
      click() {
        calls.push(['click', this.download, this.href])
      },
      remove() {
        calls.push(['remove'])
      }
    }
  let blob
  globalThis.document = {
    createElement: tag => {
      assert.equal(tag, 'a')
      return anchor
    },
    body: { appendChild: element => assert.equal(element, anchor) }
  }
  URL.createObjectURL = value => {
    blob = value
    return 'blob:fixture'
  }
  URL.revokeObjectURL = url => calls.push(['revoke', url])
  globalThis.setTimeout = fn => fn()
  try {
    downloadBlueprint(bytes, 'flow.zip', 'application/zip')
    assert.equal(blob.type, 'application/zip')
    assert.deepEqual(calls, [['click', 'flow.zip', 'blob:fixture'], ['remove'], ['revoke', 'blob:fixture']])
  } finally {
    URL.createObjectURL = create
    URL.revokeObjectURL = revoke
    globalThis.setTimeout = timer
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else delete globalThis.document
  }
})

test('compact C04 actual context overlay groups appearance/layout and dispatches the unchanged color command', () => {
  const f = fixture({ kind: 'context-menu', surface: 'node', screen: { x: 0, y: 0 }, position: { x: 100, y: 100 } })
  const appearance = one(f, n => n.props['data-bp-menu-group'] === 'appearance')
  assert.equal(appearance.props['aria-haspopup'], 'menu')
  assert.equal(appearance.props['aria-expanded'], false)
  assert.equal(all(f.tree, n => n.props['data-bp-menu-command'] === 'color-blue').length, 0, 'C04_COLOR_NOT_FLAT')
  appearance.props.onClick()
  assert.equal(one(f, n => n.props['data-bp-submenu'] === 'appearance').props.role, 'menu')
  one(f, n => n.props['data-bp-menu-command'] === 'color-blue').props.onClick()
  assert.deepEqual(f.commands, ['color-blue'])
})

test('compact C04 callable keyboard stays in the active submenu and Left/two Escapes restore parent then initiator', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const f = fixture({ kind: 'context-menu', surface: 'node', screen: { x: 0, y: 0 }, position: { x: 100, y: 100 } })
  const pool = new Map(),
    dom = node => {
      const id = node.props['data-bp-menu-group'] ?? node.props['data-bp-menu-command']
      if (!pool.has(id))
        pool.set(id, {
          id,
          focus() {
            document.activeElement = this
          },
          getAttribute: key => node.props[key],
          closest: () => (node.props['data-bp-menu-level'] === 'root' ? null : { getAttribute: () => node.props['data-bp-menu-level'] })
        })
      return pool.get(id)
    }
  const menuItems = level => all(f.render(), n => n.props.role === 'menuitem' && !n.props.disabled && n.props['data-bp-menu-level'] === level).map(dom)
  globalThis.document = { activeElement: dom(one(f, n => n.props['data-bp-menu-group'] === 'appearance')) }
  f.refs[0].current = {
    querySelectorAll: selector => menuItems(selector.match(/level="([^"]+)"/)[1]),
    querySelector: selector =>
      selector.includes('[data-bp-menu-group=') ? pool.get(selector.match(/group="([^"]+)"/)[1]) : menuItems(selector.match(/submenu="([^"]+)"/)[1])[0]
  }
  const press = key => {
    let stopped = false
    f.render().props.onKeyDown({
      ...event(key),
      stopPropagation() {
        stopped = true
      }
    })
    assert.equal(stopped, true, key)
  }
  const focusChild = () => {
    f.render()
    f.effects[1]()
  }
  try {
    press('ArrowRight')
    focusChild()
    assert.equal(document.activeElement.id, 'color-default')
    press('End')
    assert.equal(document.activeElement.id, 'color-purple')
    press('ArrowDown')
    assert.equal(document.activeElement.id, 'color-default')
    press('ArrowUp')
    assert.equal(document.activeElement.id, 'color-purple')
    press('Home')
    assert.equal(document.activeElement.id, 'color-default')
    press('ArrowLeft')
    assert.equal(document.activeElement.id, 'appearance')
    assert.equal(f.closed, 0)
    assert.equal(all(f.render(), n => n.props['data-bp-submenu']).length, 0)
    press('Enter')
    focusChild()
    press('Escape')
    assert.equal(document.activeElement.id, 'appearance')
    assert.equal(f.closed, 0)
    press('Escape')
    assert.equal(f.closed, 1)
    press('Tab')
    assert.equal(f.closed, 2)
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    else delete globalThis.document
  }
})
test('compact C04 disabled layout actions retain readable reason and refuse callbacks', () => {
  const f = fixture({ kind: 'context-menu', surface: 'node', screen: { x: 0, y: 0 }, position: { x: 0, y: 0 } })
  one(f, n => n.props['data-bp-menu-group'] === 'layout').props.onClick()
  const item = one(f, n => n.props['data-bp-menu-command'] === 'align-left')
  assert.equal(item.props.disabled, true)
  assert.equal(item.props['aria-disabled'], true)
  assert.equal(one(f, n => n.props['data-bp-disabled-reason'] === 'align-left').children[0], en['interaction.disabled.no-selection'])
  item.props.onClick()
  assert.deepEqual(f.commands, [])
})
