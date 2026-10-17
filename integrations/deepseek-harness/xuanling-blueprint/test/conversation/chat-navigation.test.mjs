import assert from 'node:assert/strict'
import test from 'node:test'
import { NativeChatNavigation } from '../../src/client/features/conversation/logic/chat-navigation.ts'

function fixture(t) {
  const addresses = new Map(),
    reads = [],
    opened = [],
    events = new Map()
  const keys = ['addEventListener', 'removeEventListener'],
    originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  globalThis.addEventListener = (key, callback, capture) => {
    assert.equal(capture, true)
    events.set(key, callback)
  }
  globalThis.removeEventListener = (key, callback, capture) => {
    assert.equal(capture, true)
    if (events.get(key) === callback) events.delete(key)
  }
  let refresh = () => {},
    open = () => {}
  const navigation = new NativeChatNavigation(),
    list = {
      ids: ['root', 'forked-main', 'listed-child'],
      byId: {
        root: { id: 'root' },
        'forked-main': { id: 'forked-main', parentId: 'root' },
        'listed-child': { id: 'listed-child', origin: 'subagent' }
      }
    }
  const disconnect = navigation.connect(
    {
      subagentAddress: id => addresses.get(id),
      list: { getSnapshot: () => list },
      async refreshProjections(owner) {
        reads.push(owner)
        await refresh(owner)
      }
    },
    {
      openSession(target) {
        open(target)
        opened.push(target)
      }
    }
  )
  t.after(() => {
    disconnect()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return { navigation, addresses, reads, opened, events, disconnect, setRefresh: value => (refresh = value), setOpen: value => (open = value) }
}

test('native chat navigation: a later user intent cancels an outstanding catalog lookup before it can steal the selection', async t => {
  const f = fixture(t)
  let release
  f.setRefresh(() => new Promise(resolve => (release = resolve)))
  const pending = f.navigation.openSession('child', 'root')
  assert.deepEqual(f.reads, ['root'])
  assert.equal(f.events.size, 2, 'intent cancellation is armed during the asynchronous lookup')
  f.events.get('pointerdown')()
  assert.equal(f.events.size, 0)
  f.addresses.set('child', { parentSessionId: 'root', childSessionId: 'child', mode: 'one-shot' })
  release()
  assert.equal(await pending, false)
  assert.deepEqual(f.opened, [], 'late projection data cannot override a newer user navigation')
  assert.equal(f.navigation.getSnapshot(), null)
})

test('native chat navigation: an already open Chat consumes no Blueprint owner; the next manual View intent clears its request without a bounce', async t => {
  const f = fixture(t)
  assert.equal(await f.navigation.openSession('root'), true)
  assert.equal(f.navigation.getSnapshot().sessionId, 'root')
  f.events.get('pointerdown')()
  assert.equal(f.navigation.getSnapshot(), null, 'manual Blueprint tab selection sees no pending Chat request')
  assert.equal(f.events.size, 0)
  assert.deepEqual(f.opened, ['root'])
})

test('native chat navigation: the matching owner consumes once and releases all next-intent listeners', async t => {
  const f = fixture(t)
  assert.equal(await f.navigation.openSession('root'), true)
  const request = f.navigation.getSnapshot()
  assert.equal(f.navigation.consume('other', request.requestId), false)
  assert.equal(f.navigation.consume('root', request.requestId + 1), false)
  assert.equal(f.navigation.consume('root', request.requestId), true)
  assert.equal(f.navigation.consume('root', request.requestId), false)
  assert.equal(f.events.size, 0)
})

test('native chat navigation: a listed child with no native address is unavailable, never a root fallback', async t => {
  const f = fixture(t)
  assert.equal(await f.navigation.openSession('listed-child', 'root'), false)
  assert.deepEqual(f.reads, ['root'])
  assert.deepEqual(f.opened, [])
  assert.equal(f.navigation.getSnapshot(), null)
  assert.equal(f.events.size, 0)
})

test('native chat navigation: a listed ordinary fork opens by identity despite its parentId', async t => {
  const f = fixture(t)
  assert.equal(await f.navigation.openSession('forked-main', 'root'), true)
  assert.deepEqual(f.opened, ['forked-main'])
  assert.deepEqual(f.reads, [], 'a listed ordinary fork does not require a subagent catalog lookup')
  assert.equal(f.navigation.getSnapshot().sessionId, 'forked-main')
})

test('native chat navigation: service removal during catalog refresh invalidates the lookup and cleans listeners', async t => {
  const f = fixture(t)
  let release
  f.setRefresh(() => new Promise(resolve => (release = resolve)))
  const pending = f.navigation.openSession('child', 'root')
  f.disconnect()
  f.addresses.set('child', { parentSessionId: 'root', childSessionId: 'child', mode: 'one-shot' })
  release()
  assert.equal(await pending, false)
  assert.deepEqual(f.opened, [])
  assert.equal(f.events.size, 0)
  assert.equal(f.navigation.getSnapshot(), null)
})

test('native chat navigation: synchronous native refusal drops the request and keeps raw errors private', async t => {
  const f = fixture(t)
  f.setOpen(() => {
    throw new Error('private-native-error')
  })
  assert.equal(await f.navigation.openSession('root'), false)
  assert.equal(f.navigation.getSnapshot(), null)
  assert.equal(f.events.size, 0)
  assert.deepEqual(f.opened, [])
})
