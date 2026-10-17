import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

const url = new URL('../../src/client/features/authoring/logic/graph/viewport-state.ts', import.meta.url)
const view = await import(existsSync(url) ? url.href : '../../src/client/features/authoring/logic/workspace/workspace-controller.ts')

test('C-08 viewport preferences have a strict codec and generation-bound store', () => {
  assert.equal(typeof view.decodeViewportState, 'function', 'LOCAL_VIEWPORT_CODEC_MISSING')
  assert.equal(typeof view.ViewportStateStore, 'function', 'GENERATION_BOUND_VIEWPORT_STORE_MISSING')
})

const state = (overrides = {}) => ({
  version: 1,
  viewport: { x: -123.5, y: 987.25, zoom: 0.125 },
  mode: 'select',
  minimap: false,
  motion: 'off',
  canvasLocked: true,
  ...overrides
})
const memoryStorage = () => {
  const values = new Map()
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('C-08 strict finite viewport codec preserves valid coordinates without unowned clamp/zoom bounds', () => {
  for (const zoom of [Number.MIN_VALUE, 0.001, 1, 12345, Number.MAX_VALUE]) {
    const input = state({ viewport: { x: Number.MAX_VALUE, y: -Number.MAX_VALUE, zoom } })
    const decoded = view.decodeViewportState(input)
    assert.deepEqual(decoded, input)
    assert.notEqual(decoded, input)
    assert.notEqual(decoded.viewport, input.viewport)
  }
  const invalid = [
    null,
    [],
    {},
    state({ version: 2 }),
    state({ mode: 'drag' }),
    state({ minimap: 'false' }),
    state({ motion: true }),
    state({ canvasLocked: 1 }),
    state({ unknown: 'secret' }),
    state({ viewport: { x: 0, y: 0, zoom: 1, z: 0 } })
  ]
  for (const value of [NaN, Infinity, -Infinity, '1', null]) {
    for (const field of ['x', 'y', 'zoom']) invalid.push(state({ viewport: { x: 0, y: 0, zoom: 1, [field]: value } }))
  }
  for (const zoom of [0, -1]) invalid.push(state({ viewport: { x: 0, y: 0, zoom } }))
  const missing = state()
  delete missing.canvasLocked
  invalid.push(missing)
  for (const input of invalid) assert.equal(view.decodeViewportState(input), null, JSON.stringify(input))
})

test('C-08 each blueprint has an isolated key, restored view and preferences; no definition/draft keys', () => {
  const storage = memoryStorage(),
    store = new view.ViewportStateStore(storage)
  const idA = '蓝图/含空格 % .A',
    idB = '蓝图/含空格 % .B'
  assert.notEqual(view.viewportKey(idA), view.viewportKey(idB))
  assert.ok(view.viewportKey(idA).startsWith('xuanling-blueprint:viewport:'))
  const a = store.bind(idA)
  assert.equal(a.readStatus, 'missing')
  assert.deepEqual(a.state, view.defaultViewportState())
  assert.deepEqual(a.write(state()), { ok: true })
  const b = store.bind(idB)
  assert.equal(b.readStatus, 'missing')
  assert.deepEqual(b.write(state({ mode: 'pan', minimap: true, motion: 'on', canvasLocked: false })), { ok: true })
  const restored = store.bind(idA)
  assert.equal(restored.readStatus, 'restored')
  assert.deepEqual(restored.state, state())
  assert.deepEqual([...storage.values.keys()].sort(), [view.viewportKey(idA), view.viewportKey(idB)].sort())
  // Reload with a new instance reads the same UI state only.
  assert.deepEqual(new view.ViewportStateStore(storage).bind(idB).state, state({ mode: 'pan', minimap: true, motion: 'on', canvasLocked: false }))
})

test('C-08 corrupt JSON/shape and denied/unavailable storage fall back without writes', () => {
  const storage = memoryStorage(),
    key = view.viewportKey('A')
  for (const bad of ['{', 'null', JSON.stringify(state({ viewport: { x: 1, y: 2, zoom: -1 } })), JSON.stringify({ ...state(), metadata: {} })]) {
    storage.values.set(key, bad)
    const binding = new view.ViewportStateStore(storage).bind('A')
    assert.equal(binding.readStatus, 'corrupt')
    assert.deepEqual(binding.state, view.defaultViewportState())
    assert.equal(storage.values.get(key), bad, 'read fallback does not overwrite corrupt state')
  }
  const unavailable = [
    undefined,
    {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('quota')
      }
    }
  ]
  for (const adapter of unavailable) {
    const binding = new view.ViewportStateStore(adapter).bind('A')
    assert.equal(binding.readStatus, 'unavailable')
    assert.deepEqual(binding.state, view.defaultViewportState())
    assert.deepEqual(binding.write(state()), { ok: false, reason: 'storage-unavailable' })
  }
  const deniedWrite = new view.ViewportStateStore({
    getItem: () => null,
    setItem() {
      throw new Error('denied')
    }
  }).bind('A')
  assert.deepEqual(deniedWrite.write(state()), { ok: false, reason: 'storage-unavailable' })
})

test('C-08 late writer cannot cross navigation including A→B→A or unmount', async () => {
  const storage = memoryStorage(),
    store = new view.ViewportStateStore(storage)
  const a = store.bind('A')
  const pending = Promise.resolve().then(() => a.write(state()))
  const b = store.bind('B')
  const newest = store.bind('A')
  assert.equal(await pending.then(result => result.reason), 'stale-context')
  assert.deepEqual(b.write(state()), { ok: false, reason: 'stale-context' })
  assert.equal(storage.values.size, 0)
  assert.deepEqual(newest.write(state()), { ok: true })
  const before = [...storage.values]
  assert.deepEqual(newest.write(state({ motion: 'invalid' })), { ok: false, reason: 'invalid-state' })
  store.invalidate()
  assert.deepEqual(newest.write(state()), { ok: false, reason: 'stale-context' })
  assert.deepEqual([...storage.values], before)
})

test('C-08 returned defaults/state do not alias future bindings or the caller input', () => {
  const storage = memoryStorage(),
    store = new view.ViewportStateStore(storage),
    input = state()
  const binding = store.bind('A')
  binding.state.viewport.x = 999
  assert.deepEqual(store.bind('B').state, view.defaultViewportState())
  const current = store.bind('A')
  assert.equal(current.write(input).ok, true)
  input.viewport.x = 999
  assert.equal(store.bind('A').state.viewport.x, -123.5)
})
