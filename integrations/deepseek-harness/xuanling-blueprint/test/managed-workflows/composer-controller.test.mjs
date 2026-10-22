import test from 'node:test'
import assert from 'node:assert/strict'
import { ManagedComposerController } from '../../src/client/features/conversation/logic/managed-composer-controller.ts'
const live = { status: 'managed', runId: 'root', attemptId: 'attempt', sessionId: 'session', nodeId: 'review', state: 'active', canMessage: true }
const receipt = args => ({
  ...Object.fromEntries(['runId', 'attemptId', 'sessionId', 'requestId'].map(key => [key, args[key]])),
  messageId: 'message',
  replayed: false
})

test('stale terminal state is rechecked before dispatch; draft survives and no inbox call occurs', async () => {
  let state = live,
    calls = 0
  const c = new ManagedComposerController(
    {
      inspectNodeSession: async () => state,
      messageNode: async args => {
        calls++
        return receipt(args)
      }
    },
    'session'
  )
  await c.refresh()
  c.setDraft('Please reconsider')
  state = { ...live, state: 'closed', canMessage: false }
  await c.send()
  assert.equal(calls, 0)
  assert.equal(c.getSnapshot().draft, 'Please reconsider')
  assert.equal(c.getSnapshot().node.canMessage, false)
})
test('concurrent submissions and changed drafts cannot alter an uncertain retry identity or delivery', async () => {
  const gate = Promise.withResolvers(),
    calls = []
  const c = new ManagedComposerController(
    {
      inspectNodeSession: async () => live,
      messageNode: async args => {
        calls.push(structuredClone(args))
        if (calls.length === 1) {
          await gate.promise
          throw new Error('lost response')
        }
        return receipt(args)
      }
    },
    'session'
  )
  await c.refresh()
  c.setDelivery('steer')
  c.setDraft('  Keep exact focus  ')
  const send = c.send()
  await Promise.resolve()
  await c.send()
  c.setDraft('discarded change')
  gate.resolve()
  await send
  assert.equal(c.getSnapshot().submission, 'uncertain')
  c.setDelivery('queue')
  c.setDraft('second change')
  await c.send(true)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1], calls[0])
  assert.equal(calls[0].delivery, 'steer')
  assert.equal(calls[0].text, '  Keep exact focus  ')
  assert.equal(c.getSnapshot().draft, '')
})
test('a late membership reply after the Session generation closes cannot re-enable messaging', async () => {
  const gate = Promise.withResolvers()
  let calls = 0
  const c = new ManagedComposerController(
    {
      inspectNodeSession: () => gate.promise,
      messageNode: async args => {
        calls++
        return receipt(args)
      }
    },
    'session'
  )
  c.setDraft('preserved')
  const read = c.refresh()
  c.close()
  gate.resolve(live)
  await read
  await c.send()
  assert.equal(c.getSnapshot().connection, 'unavailable')
  assert.equal(c.getSnapshot().draft, 'preserved')
  assert.equal(calls, 0)
})
test('a mismatched receipt is not shown as delivered and retries the original payload', async () => {
  const calls = []
  const c = new ManagedComposerController(
    {
      inspectNodeSession: async () => live,
      messageNode: async args => {
        calls.push(structuredClone(args))
        return { ...receipt(args), sessionId: 'foreign' }
      }
    },
    'session'
  )
  await c.refresh()
  c.setDraft('message')
  await c.send()
  assert.equal(c.getSnapshot().submission, 'uncertain')
  await c.send(true)
  assert.deepEqual(calls[0], calls[1])
  assert.equal(c.getSnapshot().draft, 'message')
})
