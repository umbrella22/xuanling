import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

const url = new URL('../../src/client/command-policy.ts', import.meta.url)
const policy = await import(existsSync(url) ? url.href : '../../src/client/workspace.ts')

test('C-02 central canvas shortcut policy is a callable behavior boundary', () => {
  assert.equal(typeof policy.resolveCanvasShortcut, 'function', 'CANVAS_COMMAND_POLICY_MISSING')
  assert.equal(typeof policy.contextCommands, 'function', 'CANVAS_CONTEXT_COMMANDS_MISSING')
})

const facts = (overrides = {}) => ({ canvasFocused: true, hasDefinition: true, busy: false, canvasLocked: false,
  selectedNodes: 2, selectedEdges: 1, selectedGroups: 0, movableNodes: 2,
  canUndo: true, canRedo: true, canPaste: true, canRun: true, canCancel: true, canOpen: true, canRefreshDefinitions: true, ...overrides })
const resolve = (event, overrides) => policy.resolveCanvasShortcut({ key: '', ...event }, facts(overrides))

test('C-02 primary chords are identical on Ctrl and Meta and all declared canvas keys produce intents', () => {
  const chords = { c: 'copy', x: 'cut', v: 'paste', a: 'select-all', z: 'undo', y: 'redo', g: 'group', s: 'save', o: 'open', Enter: 'run' }
  for (const primary of ['ctrlKey', 'metaKey']) {
    for (const [key, command] of Object.entries(chords)) assert.deepEqual(resolve({ key, [primary]: true }), { kind: 'command', command, preventDefault: true })
    assert.equal(resolve({ key: 'z', [primary]: true, shiftKey: true }).command, 'redo')
    assert.equal(resolve({ key: 'v', [primary]: true, shiftKey: true }).command, 'paste-with-incoming')
    assert.equal(resolve({ key: 'Enter', [primary]: true, altKey: true }).command, 'cancel')
  }
  const keys = { Delete: 'delete', Backspace: 'delete', Escape: 'clear-selection', ' ': 'pan-start', Tab: 'search', f: 'fit-view',
    p: 'toggle-pin', c: 'toggle-collapse', m: 'toggle-minimap', ArrowLeft: 'move-left', ArrowRight: 'move-right',
    ArrowUp: 'move-up', ArrowDown: 'move-down', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', h: 'lock-canvas', v: 'unlock-canvas', r: 'refresh-definitions' }
  for (const [key, command] of Object.entries(keys)) assert.equal(resolve({ key }).command, command, key)
  assert.equal(resolve({ key: 'F', shiftKey: true }).command, 'fit-selection')
  assert.equal(resolve({ key: '+', shiftKey: true }).command, 'zoom-in')
  for (const [event, command] of [
    [{ key: '.' }, 'fit-view'], [{ key: 'c', altKey: true }, 'toggle-collapse'],
    [{ key: '+', altKey: true }, 'zoom-in'], [{ key: '+', altKey: true, shiftKey: true }, 'zoom-in'],
    [{ key: '-', altKey: true }, 'zoom-out'], [{ key: 'M', altKey: true, shiftKey: true }, 'toggle-minimap'],
  ]) assert.equal(resolve(event).command, command)
})

test('C-02 DSH typing, nested contenteditable, IME, prior handling and outside canvas preserve native keys', () => {
  const targets = [{ tagName: 'INPUT' }, { tagName: 'textarea' }, { tagName: 'SELECT' }, { isContentEditable: true },
    { tagName: 'SPAN', closest: selector => selector === '[contenteditable="true"]' ? {} : null }]
  for (const target of targets) {
    for (const key of ['Delete', 'Tab', ' ', 'ArrowLeft', 'Enter', 's', 'v', 'h']) {
      const result = resolve({ key, target, ctrlKey: key === 's' })
      assert.deepEqual(result, { kind: 'ignored', reason: 'editing-target', preventDefault: false })
    }
  }
  for (const event of [{ isComposing: true }, { keyCode: 229 }]) assert.deepEqual(resolve({ key: 'Delete', ...event }), { kind: 'ignored', reason: 'composition', preventDefault: false })
  assert.equal(resolve({ key: 'Delete', defaultPrevented: true }).reason, 'handled')
  assert.deepEqual(resolve({ key: 's', ctrlKey: true }, { canvasFocused: false }), { kind: 'ignored', reason: 'outside-canvas', preventDefault: false })
})

test('C-02 unsupported modifiers and browser chords never become canvas commands', () => {
  for (const event of [{ key: 'c', ctrlKey: true, metaKey: true }, { key: 'v', ctrlKey: true, altKey: true },
    { key: 's', ctrlKey: true, shiftKey: true }, { key: 'Tab', shiftKey: true }, { key: 'h', altKey: true },
    { key: 'r', ctrlKey: true }, { key: 'f', metaKey: true }, { key: 'Enter' }, { key: 'constructor' }, { key: 'constructor', ctrlKey: true }]) {
    assert.deepEqual(resolve(event), { kind: 'ignored', reason: 'unbound', preventDefault: false }, JSON.stringify(event))
  }
})

test('C-02 destructive/save/run repeats are suppressed without allowing native Save; arrow and zoom repeat', () => {
  for (const event of [{ key: 'Delete' }, { key: 'x', ctrlKey: true }, { key: 's', metaKey: true }, { key: 'Enter', ctrlKey: true },
    { key: 'Enter', ctrlKey: true, altKey: true }, { key: 'v', ctrlKey: true }, { key: 'p' }, { key: ' ' }, { key: 'r' }]) {
    assert.deepEqual(resolve({ ...event, repeat: true }), { kind: 'ignored', reason: 'repeat', preventDefault: true })
  }
  for (const key of ['ArrowRight', '+', '-']) assert.equal(resolve({ key, repeat: true }).kind, 'command')
})

test('C-02 busy, missing definitions, selection/history/admission and lock facts disable typed intents', () => {
  const cases = [
    [{ key: 'Delete' }, { busy: true }, 'busy'], [{ key: 'Delete' }, { hasDefinition: false }, 'no-definition'],
    [{ key: 'Delete' }, { selectedNodes: 0, selectedEdges: 0 }, 'no-selection'],
    [{ key: 'ArrowLeft' }, { movableNodes: 0 }, 'no-movable-selection'],
    [{ key: 'z', ctrlKey: true }, { canUndo: false }, 'history-unavailable'],
    [{ key: 'y', ctrlKey: true }, { canRedo: false }, 'history-unavailable'],
    [{ key: 'v', ctrlKey: true }, { canPaste: false }, 'clipboard-unavailable'],
    [{ key: 'Enter', ctrlKey: true }, { canRun: false }, 'run-unavailable'],
    [{ key: 'Enter', ctrlKey: true, altKey: true }, { canCancel: false }, 'cancel-unavailable'],
    [{ key: 'o', ctrlKey: true }, { canOpen: false }, 'open-unavailable'],
    [{ key: 'r' }, { canRefreshDefinitions: false }, 'refresh-unavailable'],
  ]
  for (const [event, override, reason] of cases) {
    const result = resolve(event, override)
    assert.equal(result.kind, 'disabled'); assert.equal(result.reason, reason); assert.equal(result.preventDefault, true)
  }
  for (const key of ['Delete', 'ArrowLeft', 'p', 'c', 'Tab']) assert.equal(resolve({ key }, { canvasLocked: true }).reason, 'canvas-locked')
  for (const event of [{ key: 'c', ctrlKey: true }, { key: 's', ctrlKey: true }, { key: 'Enter', ctrlKey: true }, { key: 'v' }]) assert.equal(resolve(event, { canvasLocked: true }).kind, 'command')
  for (const event of [{ key: 'r' }, { key: 'o', ctrlKey: true }]) assert.equal(resolve(event, { hasDefinition: false }).kind, 'command')
  for (const event of [{ key: '.' }, { key: '-', altKey: true, repeat: true }, { key: 'm', altKey: true, shiftKey: true },
    { key: ' ' }, { key: 'h' }, { key: 'v' }, { key: 'a', ctrlKey: true }, { key: 'Escape' }]) assert.equal(resolve(event, { busy: true }).kind, 'command')
})

test('C-02 context menus share availability and typed deferred label keys; no unsupported execution promise', () => {
  for (const surface of ['canvas', 'node', 'edge', 'group']) {
    const context = facts({ selectedGroups: surface === 'group' ? 1 : 0, selectedNodes: surface === 'group' ? 0 : 1 })
    const before = structuredClone(context)
    const menu = policy.contextCommands(surface, context)
    assert.ok(menu.length > 0)
    for (const item of menu) {
      assert.equal(item.labelKey, `command.${item.command}`)
      assert.equal(item.disabledReason, policy.commandDisabledReason(item.command, context))
      assert.equal(item.enabled, item.disabledReason === null)
      assert.ok(!['bypass', 'mute', 'run-branch', 'subgraph'].includes(item.command))
    }
    assert.deepEqual(context, before)
    for (const item of policy.contextCommands(surface, facts({ busy: true }))) {
      assert.equal(item.disabledReason, policy.commandDisabledReason(item.command, facts({ busy: true })))
    }
  }
})
