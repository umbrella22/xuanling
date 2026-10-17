import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
test('overlay interaction state has a pure owner separate from production markup', async () => {
  assert.ok(existsSync(new URL('../../src/client/features/authoring/logic/overlays/overlay-session.ts', import.meta.url)), 'OVERLAY_SESSION_BOUNDARY_MISSING')
  const { initialOverlaySession, transitionOverlay } = await import('../../src/client/features/authoring/logic/overlays/overlay-session.ts')
  const initial = initialOverlaySession('rename', ' exact ', 'empty')
  assert.equal(initial.name, ' exact ')
  const confirmed = transitionOverlay(initial, { type: 'confirm-import', confirmed: true })
  assert.equal(confirmed.confirmed, true)
  assert.equal(transitionOverlay(confirmed, { type: 'target', targetId: 'other' }).confirmed, false)
  assert.equal(transitionOverlay(confirmed, { type: 'file-changed' }).confirmed, false)
  assert.equal(transitionOverlay(initial, { type: 'query', query: ' raw ' }).query, ' raw ')
  assert.equal(initial.query, '')
})

import React from 'react'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { InteractionOverlay, OverlayView } from '../../src/client/features/authoring/ui/overlays/interaction-overlays.tsx'
import { en } from '../../src/client/shared/i18n/locales.ts'

function boundFixture() {
  const workspace = new BlueprintWorkspace(undefined)
  const binding = workspace.getSnapshot().binding
  const f = { states: [], refs: [], effects: [], intents: [], errors: [], cursor: 0, refCursor: 0 }
  const seat = {
    ...React,
    useRef: value => (f.refs[f.refCursor++] ??= { current: value }),
    useState: value => {
      const index = f.cursor++
      if (!(index in f.states)) f.states[index] = typeof value === 'function' ? value() : value
      return [
        f.states[index],
        value => {
          f.states[index] = typeof value === 'function' ? value(f.states[index]) : value
        }
      ]
    },
    useEffect: effect => f.effects.push(effect)
  }
  f.props = {
    React: seat,
    overlay: { kind: 'import', screen: { x: 0, y: 0 } },
    root: { current: null },
    t: (key, params = {}) => en[key]?.replace(/\{([^}]+)\}/g, (_, key) => String(params[key] ?? '')) ?? key,
    commands: [],
    importTargets: [{ blueprintId: 'empty', name: 'Empty', nonempty: false }],
    state: { kind: 'import', binding, importTargets: [{ blueprintId: 'empty', nonempty: false }], importConfirmedId: 'empty' },
    onIntent: intent => f.intents.push(intent),
    onArchiveError: code => f.errors.push(code)
  }
  f.render = () => {
    f.cursor = f.refCursor = 0
    f.effects = []
    const element = OverlayView(f.props)
    assert.equal(element.type, InteractionOverlay)
    return InteractionOverlay(element.props)
  }
  const children = tree => (!React.isValidElement(tree) ? [] : [tree, ...React.Children.toArray(tree.props.children).flatMap(children)])
  f.find = (key, value = true) => {
    const found = children(f.render()).find(item => item.props[key] === value)
    assert.ok(found, key)
    return found
  }
  f.close = () =>
    children(f.render())
      .find(item => item.type === 'button' && item.props['aria-label'] === en['interaction.close'])
      .props.onClick()
  f.submit = () =>
    children(f.render())
      .find(item => item.type === 'form')
      .props.onSubmit({ preventDefault() {} })
  f.pick = file => {
    f.find('data-bp-import-file').props.onChange({ currentTarget: { files: [file] } })
    f.find('data-bp-import-confirm').props.onChange({ currentTarget: { checked: true } })
  }
  f.workspace = workspace
  return f
}

test('typed overlay reads archive only in adapter and suppresses pending close/target/file/unmount changes', async t => {
  for (const cancel of ['close', 'target', 'file', 'unmount', 'disabled', 'binding']) {
    const f = boundFixture()
    t.after(() => f.workspace.dispose())
    let resolve,
      reads = 0
    f.pick({
      arrayBuffer: () => {
        reads++
        return new Promise(done => {
          resolve = done
        })
      }
    })
    f.submit()
    assert.equal(reads, 1)
    if (cancel === 'close') f.close()
    if (cancel === 'target') f.find('data-bp-import-target').props.onChange({ currentTarget: { value: 'empty' } })
    if (cancel === 'file') f.find('data-bp-import-file').props.onChange({ currentTarget: { files: [] } })
    if (cancel === 'unmount') {
      const clean = f.effects.at(-1)()
      clean()
    }
    if (cancel === 'disabled') {
      f.props = { ...f.props, importDisabledReason: 'busy' }
      f.render()
    }
    if (cancel === 'binding') {
      f.workspace.newDraft('other')
      f.props = { ...f.props, state: { ...f.props.state, binding: f.workspace.getSnapshot().binding } }
      f.render()
    }
    resolve(new Uint8Array([0, 255, 128]).buffer)
    await new Promise(done => setImmediate(done))
    assert.equal(f.intents.filter(intent => intent.type === 'overlay-import-ready').length, 0, cancel)
  }
})

test('typed overlay emits confirmed empty archive with actual Workspace binding and safe read failure', async t => {
  const f = boundFixture()
  t.after(() => f.workspace.dispose())
  f.pick({ arrayBuffer: async () => new Uint8Array([0, 255, 128]).buffer })
  f.submit()
  await new Promise(done => setImmediate(done))
  assert.deepEqual(f.intents, [
    { type: 'overlay-import-ready', binding: f.workspace.getSnapshot().binding, blueprintId: 'empty', archiveBase64: 'AP+A', confirmedId: 'empty' }
  ])
  f.pick({
    arrayBuffer: async () => {
      throw new Error('PRIVATE_PATH')
    }
  })
  f.submit()
  await new Promise(done => setImmediate(done))
  assert.deepEqual(f.errors, ['blueprint/archive-read-failed'])
})

test('typed local confirmation works without outer confirmation and survives unrelated rerender', async t => {
  const f = boundFixture()
  t.after(() => f.workspace.dispose())
  f.props = { ...f.props, state: { ...f.props.state, importConfirmedId: undefined } }
  let resolve
  f.pick({
    arrayBuffer: () =>
      new Promise(done => {
        resolve = done
      })
  })
  f.submit()
  f.props = { ...f.props, commands: [...f.props.commands] }
  f.render()
  resolve(new Uint8Array([1]).buffer)
  await new Promise(done => setImmediate(done))
  assert.equal(f.intents.filter(intent => intent.type === 'overlay-import-ready').length, 1, 'CONFIRMED_IMPORT_LOST_ON_UNRELATED_RENDER')
})

test('typed disabled refuses file reads and stale read errors are suppressed', async t => {
  const f = boundFixture()
  t.after(() => f.workspace.dispose())
  let reads = 0,
    reject
  f.props = { ...f.props, state: { ...f.props.state, disabled: true } }
  f.pick({
    arrayBuffer: async () => {
      reads++
      return new ArrayBuffer(0)
    }
  })
  f.submit()
  assert.equal(reads, 0, 'DISABLED_TYPED_IMPORT_READS_FILE')
  f.props = { ...f.props, state: { ...f.props.state, disabled: false } }
  f.pick({
    arrayBuffer: () =>
      new Promise((_, fail) => {
        reject = fail
      })
  })
  f.submit()
  f.workspace.newDraft('other')
  f.props = { ...f.props, state: { ...f.props.state, binding: f.workspace.getSnapshot().binding } }
  f.render()
  reject(new Error('PRIVATE_STALE'))
  await new Promise(done => setImmediate(done))
  assert.deepEqual(f.errors, [], 'STALE_ARCHIVE_ERROR')
})

test('typed target A to B requires a new local confirmation and uses current callback/availability', async t => {
  const f = boundFixture()
  t.after(() => f.workspace.dispose())
  const targets = [
    { blueprintId: 'a', name: 'A', nonempty: false },
    { blueprintId: 'b', name: 'B', nonempty: false }
  ]
  f.props = { ...f.props, importTargets: targets, state: { ...f.props.state, importConfirmedId: undefined, importTargets: targets } }
  f.render()
  f.find('data-bp-import-target').props.onChange({ currentTarget: { value: 'a' } })
  let resolve
  f.pick({
    arrayBuffer: () =>
      new Promise(done => {
        resolve = done
      })
  })
  f.find('data-bp-import-target').props.onChange({ currentTarget: { value: 'b' } })
  assert.equal(f.find('data-bp-import-confirm').props.checked, false)
  f.submit()
  assert.equal(resolve, undefined, 'changing target must not keep confirmation')
  f.find('data-bp-import-confirm').props.onChange({ currentTarget: { checked: true } })
  f.submit()
  const current = []
  f.props = { ...f.props, onIntent: intent => current.push(intent) }
  f.render()
  resolve(new Uint8Array([2]).buffer)
  await new Promise(done => setImmediate(done))
  assert.equal(f.intents.length, 0)
  assert.equal(current[0].blueprintId, 'b')
  assert.equal(current[0].confirmedId, 'b')
  let reject
  f.pick({
    arrayBuffer: () =>
      new Promise((_, fail) => {
        reject = fail
      })
  })
  f.submit()
  f.props = { ...f.props, state: { ...f.props.state, importTargets: targets.map(target => ({ ...target, nonempty: true })) } }
  f.render()
  reject(new Error('PRIVATE_NO_LONGER_AVAILABLE'))
  await new Promise(done => setImmediate(done))
  assert.deepEqual(f.errors, [])
})
