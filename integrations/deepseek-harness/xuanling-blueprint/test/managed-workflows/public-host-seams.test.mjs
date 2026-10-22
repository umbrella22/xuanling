import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { nativeSessionLineage } from '../../src/conversation/native-session-lineage.ts'
import { publicHost, textResponse } from './public-host-fixture.mjs'

const signal = () => new AbortController().signal
const message = (text, rpcId) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })

test('public Host seam: same scoped one-shot Agent accepts successive human inbox turns; generic continuation rejects', async t => {
  const { ctx, adapter, selection } = await publicHost(t, [textResponse('need clarification'), textResponse('revised answer')])
  const parent = await ctx.agentLoop.create(SessionId('managed-parent'), selection)
  const id = SessionId('managed-child')
  const lineage = nativeSessionLineage(ctx, { kind: 'tool', sessionId: parent.session.id, callId: 'start' }, id)
  const handle = await ctx.agents.create({
    sessionId: id,
    agentOptions: selection,
    meta: { origin: 'subagent', parentSession: parent.session.id },
    setup: (_ctx, agent) => lineage.setup(agent)
  })
  t.after(() => handle.dispose())
  await lineage.establishCatalog(handle.agent.session, signal())
  handle.agent.followup(message('review the implementation', 'first'))
  await handle.agent.whenIdle()
  assert.equal(ctx.agents.get(id), handle.agent)
  assert.equal(handle.agent.session.header.parentSession, parent.session.id)
  assert.equal(handle.agent.session.snapshotEvents().find(event => event.type === 'subagent/descriptor').data.mode, 'one-shot')
  const request = {
    requestId: 'bypass',
    parentSessionId: parent.session.id,
    childSessionId: id,
    mode: 'continuable',
    delivery: 'queue',
    content: [{ type: 'text', text: 'unmanaged resume' }]
  }
  await assert.rejects(ctx.subagents.prompt(request, signal()), { code: 'subagent/not-resumable' })
  handle.agent.steer(message('focus on cancellation within this review', 'human-correction'))
  await handle.agent.whenIdle()
  const events = handle.agent.session.snapshotEvents()
  assert.equal(adapter.requests.length, 2)
  assert.equal(events.filter(event => event.type === 'turn/end').length, 2)
  assert.deepEqual(
    events.filter(event => event.type === 'user/message').map(event => event.data.source.rpcId),
    ['first', 'human-correction']
  )
  assert.equal(ctx.agents.get(id), handle.agent)
  // Retain public read facts at the persistence boundary, then unload the real
  // Agent. A cold generic prompt must reject the same durable descriptor.
  const header = handle.agent.session.header
  const inheritedEventCount = handle.agent.session.inheritedEventCount
  await handle.dispose()
  ctx.provide('sessionPersistence', {
    identity: Symbol('seam-read-store'),
    async open(sessionId) {
      assert.equal(sessionId, id)
      return {
        id,
        header,
        access: 'read',
        inheritedEventCount,
        async read(offset = 0, length) {
          return { eventState: 'detached', events: events.slice(offset, length === undefined ? undefined : offset + length) }
        },
        async close() {},
        async [Symbol.asyncDispose]() {}
      }
    }
  })
  await assert.rejects(ctx.subagents.prompt({ ...request, requestId: 'cold-bypass' }, signal()), { code: 'subagent/not-resumable' })
  assert.equal(ctx.agents.get(id), undefined)
  assert.equal(adapter.requests.length, 2)
})

test('public Host seam: conversation composer chain supports narrowly routed takeover and clean disposal', () => {
  const slots = new SlotCore()
  const disposeOwner = slots.register({ name: 'root', children: { 'conversation.composer': { kind: 'chain', scope: 'session-maybe' } } }, () => null)
  const readonly = () => 'native one-shot readonly'
  const managed = () => 'blueprint input'
  slots.register({ name: 'conversation.composer', priority: -10, select: owner => (owner.session?.subagent?.mode === 'one-shot' ? {} : null) }, readonly)
  const dispose = slots.register(
    { name: 'conversation.composer', priority: -20, select: owner => (owner.sessionId === 'active-attempt' ? { sessionId: owner.sessionId } : null) },
    managed
  )
  const select = owner => slots.entriesOfSlot('conversation.composer').find(entry => entry.select(owner) != null)?.component
  const oneShot = { subagent: { mode: 'one-shot' } }
  assert.equal(select({ sessionId: 'active-attempt', session: oneShot }), managed)
  assert.equal(select({ sessionId: 'unrelated', session: oneShot }), readonly)
  assert.equal(select({ sessionId: 'root', session: {} }), undefined)
  dispose()
  assert.equal(select({ sessionId: 'active-attempt', session: oneShot }), readonly)
  dispose()
  disposeOwner()
  assert.equal(slots.entriesOfSlot('conversation.composer').length, 0)
})
