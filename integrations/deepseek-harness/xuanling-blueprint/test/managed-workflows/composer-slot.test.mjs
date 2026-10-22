import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { composerSlot } from './composer-slot-fixture.ts'
import { nestedManagedRun } from './nested-managed-fixture.mjs'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'

test('native composer slot claims only confirmed managed bindings and defers pending business interactions', async t => {
  const h = await nestedManagedRun(t)
  const namespace = Object.fromEntries(BLUEPRINT_INVOCATIONS.map(({ method }) => [method, async args => ({ ok: true, value: await h.service[method](args) })]))
  const f = await composerSlot(namespace, [h.agent.session.id, 'unrelated'])
  t.after(() => f.ctx.fiber.dispose())
  for (let i = 0; i < 20 && f.choose(h.agent.session.id)?.entry.component === f.native; i++) await nextTurn()
  assert.notEqual(f.choose(h.agent.session.id)?.entry.component, f.native, 'active managed nodes need a dedicated input owner')
  assert.equal(f.choose('unrelated').entry.component, f.native)
  assert.equal(f.choose(h.agent.session.id, { kind: 'approval' }).entry.component, f.native)
  await f.dispose()
  assert.equal(f.choose(h.agent.session.id).entry.component, f.native)
})

test('multiple managed bindings retain their own slots and withdrawn generations cannot match', async t => {
  const a = await nestedManagedRun(t),
    b = await nestedManagedRun(t)
  const namespace = {
    inspectNodeSession: async args => ({ ok: true, value: await (args.sessionId === a.agent.session.id ? a : b).service.inspectNodeSession(args) })
  }
  const f = await composerSlot(namespace, [a.agent.session.id, b.agent.session.id])
  t.after(() => f.ctx.fiber.dispose())
  for (let i = 0; i < 30; i++) await nextTurn()
  const first = f.choose(a.agent.session.id),
    second = f.choose(b.agent.session.id)
  assert.notEqual(first.entry.component, f.native)
  assert.notEqual(second.entry.component, f.native)
  assert.notEqual(first.matched.controller, second.matched.controller)
  f.bindings.delete(a.agent.session.id)
  f.notify()
  assert.equal(first.entry.select({ sessionId: a.agent.session.id, session: { subagent: { address: { mode: 'one-shot' } } } }), null)
  assert.equal(f.choose(a.agent.session.id).entry.component, f.native)
  assert.notEqual(f.choose(b.agent.session.id).entry.component, f.native)
})
