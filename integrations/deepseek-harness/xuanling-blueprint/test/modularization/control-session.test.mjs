import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync } from 'node:fs'
const source = new URL('../../src/client/shared/controls/control-session.ts', import.meta.url)
test('controls expose a pure transition boundary', () => assert.ok(existsSync(source), 'CONTROL_SESSION_BOUNDARY_MISSING'))
const api = () => import(source.href)
const options = [
  { value: 'disabled', text: 'Unavailable', disabled: true },
  { value: ' raw / value ', text: 'Alpha', disabled: false },
  { value: 'alpine', text: 'Alpine', disabled: false },
  { value: 'beta', text: 'Beta', disabled: false }
]
const context = { options, value: ' raw / value ', disabled: false }
test('opening and walking retain exact selected values until explicit commit', async () => {
  const { initialSelectState, transitionSelect } = await api()
  let result = transitionSelect(initialSelectState(), context, { type: 'key', key: 'ArrowDown', now: 0 })
  assert.equal(result.state.open, true)
  assert.equal(result.state.active, 1)
  result = transitionSelect(result.state, context, { type: 'key', key: 'ArrowDown', now: 1 })
  assert.equal(result.state.active, 2)
  assert.equal(result.chosen, undefined)
  result = transitionSelect(result.state, context, { type: 'key', key: 'Enter', now: 2 })
  assert.equal(result.chosen, 'alpine')
  assert.equal(result.state.open, false)
  assert.equal(transitionSelect(initialSelectState(), context, { type: 'choose', index: 1 }).chosen, undefined)
})
test('disabled and missing options cannot open or emit, and navigation wraps past disabled entries', async () => {
  const { initialSelectState, transitionSelect } = await api()
  for (const disabled of [
    { ...context, disabled: true },
    { ...context, options: [] },
    { ...context, options: [options[0]] }
  ]) {
    assert.equal(transitionSelect(initialSelectState(), disabled, { type: 'open' }).state.open, false)
    assert.equal(transitionSelect(initialSelectState(), disabled, { type: 'choose', index: 0 }).chosen, undefined)
  }
  let state = transitionSelect(initialSelectState(), context, { type: 'open', last: true }).state
  assert.equal(state.active, 1, 'current selected option takes precedence over last')
  state = transitionSelect(state, context, { type: 'key', key: 'ArrowUp', now: 0 }).state
  assert.equal(state.active, 3)
  assert.equal(transitionSelect(state, context, { type: 'choose', index: 0 }).chosen, undefined)
})
test('typeahead uses an injected clock, repeated letters cycle, and IME/modifier input has no effect', async () => {
  const { initialSelectState, transitionSelect } = await api()
  let state = transitionSelect(initialSelectState(), context, { type: 'key', key: 'a', now: 1000 }).state
  assert.equal(state.active, 2)
  state = transitionSelect(state, context, { type: 'key', key: 'l', now: 1100 }).state
  assert.equal(state.active, 2)
  state = transitionSelect(state, context, { type: 'key', key: 'b', now: 2000 }).state
  assert.equal(state.active, 3)
  for (const flags of [{ composing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    assert.deepEqual(transitionSelect(state, context, { type: 'key', key: 'a', now: 2100, ...flags }).state, state)
  }
})
test('Escape, Tab, Home and End preserve their existing action and propagation semantics', async () => {
  const { initialSelectState, transitionSelect } = await api()
  const closed = initialSelectState()
  assert.equal(transitionSelect(closed, context, { type: 'key', key: 'Escape', now: 0 }).stopPropagation, false)
  let result = transitionSelect(closed, context, { type: 'key', key: 'End', now: 0 })
  assert.equal(result.state.active, 3)
  result = transitionSelect(result.state, context, { type: 'key', key: 'Home', now: 0 })
  assert.equal(result.state.active, 1)
  result = transitionSelect(result.state, context, { type: 'key', key: 'Escape', now: 0 })
  assert.equal(result.preventDefault, true)
  assert.equal(result.stopPropagation, true)
  assert.equal(result.state.open, false)
  result = transitionSelect({ ...closed, open: true }, context, { type: 'key', key: 'Tab', now: 0 })
  assert.equal(result.stopPropagation, false)
  assert.equal(result.preventDefault, false)
  assert.equal(result.state.open, false)
})

test('typed confirmation busy state disables both actions while legacy defaults remain actionable', async () => {
  const { default: React } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { ConfirmationView, ConfirmationDialog } = await import('../../src/client/shared/controls/styled-controls.ts')
  const binding = { instanceId: 'test-owner', blueprintId: 'target', editorEpoch: 0, documentRevision: 'doc' }
  const labels = { title: 'Confirm?', description: 'Target', cancelLabel: 'Cancel', confirmLabel: 'Confirm' }
  const typed = renderToStaticMarkup(
    React.createElement(ConfirmationView, {
      React,
      state: { ...labels, binding, action: { type: 'delete-current' }, busy: true },
      onIntent: () => assert.fail('SSR has no actions')
    })
  )
  assert.match(typed, /data-bp-confirm-cancel="true"[^>]*disabled=""/, 'BUSY_CONFIRMATION_CANCEL_NOT_DISABLED')
  assert.match(typed, /data-bp-confirm-accept="true"[^>]*disabled=""/, 'BUSY_CONFIRMATION_ACCEPT_NOT_DISABLED')
  const legacy = renderToStaticMarkup(React.createElement(ConfirmationDialog, { React, ...labels, onCancel: () => {}, onConfirm: () => {} }))
  assert.doesNotMatch(legacy, /disabled=/)
})
