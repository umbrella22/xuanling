// Session-scoped recovery resolution: pure state classification, wire bridge
// decoding, controller sequencing and the conversation-view recovery section.
// Deterministic client behavior with controlled React seats, not live acceptance.
import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import {
  ConversationController,
  conversationRecoveryState,
  resolveConversationHost
} from '../../src/client/features/conversation/logic/conversation-controller.ts'
import { BlueprintRemoteError } from '../../src/client/adapters/host/remote.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
import { teamStageBlocksRecovery } from '../../src/host/teamstage-recovery.ts'

const RECOVERY = 'recovery_required'
const value = ({ state = RECOVERY, seq = 7, runId = 'run-a' } = {}) => ({
  status: 'bound',
  sessionId: 'source',
  runs: [{ runId, blueprintId: 'blueprint-a', state, createdAt: 2, definitionRevision: 'frozen-v1' }],
  selected: {
    run: {
      runId,
      state,
      definitionRevision: 'frozen-v1',
      seq,
      attempts: [{ nodeId: 'work', attemptId: 'attempt-a', sessionId: 'child-a', attempt: 1, state }],
      logTail: []
    },
    source: { sessionId: 'source', kind: 'ui', callId: 'source-call' },
    graph: { nodes: [{ id: 'work', kind: 'agentTask' }], edges: [] },
    focusAttemptIds: []
  }
})
const teamStage = (state = RECOVERY) => ({
  schemaVersion: 1,
  stageId: 'work',
  runId: 'run-a',
  teamId: 'team-a',
  leadSessionId: 'source',
  taskSpecificationFingerprint: 'a'.repeat(64),
  state,
  members: [],
  updatedAt: 1
})

test('conversationRecoveryState classifies only the bound selected recovery_required Run', () => {
  assert.equal(conversationRecoveryState(null), 'none')
  assert.equal(conversationRecoveryState(undefined), 'none')
  assert.equal(conversationRecoveryState({ status: 'unbound', sessionId: 'source' }), 'none')
  assert.equal(conversationRecoveryState(value({ state: 'running' })), 'none')
  assert.equal(conversationRecoveryState(value({ state: 'failed' })), 'none')
  assert.equal(conversationRecoveryState(value()), 'resolvable')
  const manual = value()
  manual.selected.run.team = teamStage()
  assert.equal(conversationRecoveryState(manual), 'team-manual', 'unknown native Team effect needs manual cleanup first')
  manual.selected.run.team.state = 'failed'
  assert.equal(conversationRecoveryState(manual), 'resolvable', 'a settled TeamStage does not block resolution')
  for (const state of ['provisioning', 'active', 'waiting_input', 'cancelling']) {
    const unsettled = value()
    unsettled.selected.run.team = teamStage(state)
    assert.equal(conversationRecoveryState(unsettled), 'team-manual', `an unsettled ${state} TeamStage is rejected by the Host, so the UI must not offer it`)
  }
  for (const state of ['succeeded', 'cancelled', 'timed_out']) {
    const settled = value()
    settled.selected.run.team = teamStage(state)
    assert.equal(conversationRecoveryState(settled), 'resolvable')
  }
})

test('teamStageBlocksRecovery is the single predicate shared by Host and both recovery UIs', () => {
  assert.equal(teamStageBlocksRecovery(undefined), false)
  for (const state of ['succeeded', 'failed', 'cancelled', 'timed_out']) assert.equal(teamStageBlocksRecovery(state), false, state)
  for (const state of ['provisioning', 'active', 'waiting_input', 'cancelling', 'recovery_required']) assert.equal(teamStageBlocksRecovery(state), true, state)
})

test('recovery bridge forwards the Session-scoped reviewed sequence through the proxy receiver', async () => {
  const calls = []
  const namespace = {
    async resolveRecovery(args) {
      assert.equal(this, namespace, 'host proxy receiver is preserved')
      calls.push(args)
      return { ok: true, value: { runId: args.runId, state: 'failed', seq: 9, applied: true } }
    }
  }
  const host = resolveConversationHost({
    get(key) {
      assert.equal(key, 'remote.blueprint')
      return namespace
    }
  })
  assert.deepEqual(Object.keys(host).sort(), ['inspectSession', 'resolveRecovery'])
  const args = { runId: 'run-a', sessionId: 'source', resolution: 'failed', note: 'checked child session', expectedSeq: 7 }
  assert.deepEqual(await host.resolveRecovery(args), { runId: 'run-a', state: 'failed', seq: 9, applied: true })
  assert.deepEqual(calls, [args], 'strict args pass through unchanged, including optional Session scope')
  for (const invalid of [
    { ...args, resolution: 'retry' },
    { ...args, resolution: 'cancelled', runId: 'bad run id' },
    { ...args, note: '' },
    { ...args, note: 'x'.repeat(501) },
    { ...args, expectedSeq: -1 },
    { ...args, expectedSeq: 1.5 },
    { ...args, raw: '/secret' }
  ]) {
    await assert.rejects(host.resolveRecovery(invalid), { code: 'blueprint/bad-request' })
  }
  assert.equal(calls.length, 1, 'invalid args never reach the Host')
  const withoutSession = { runId: 'run-a', resolution: 'failed', note: 'canvas caller', expectedSeq: 1 }
  assert.deepEqual(await host.resolveRecovery(withoutSession), { runId: 'run-a', state: 'failed', seq: 9, applied: true })
  assert.deepEqual(calls.at(-1), withoutSession, 'the Session scope is optional for canvas callers')
  const optional = resolveConversationHost({ get: () => ({}) })
  assert.equal(optional.resolveRecovery, undefined, 'recovery capability stays optional')
})

test('recovery bridge rejects malformed envelopes and results without leaking raw payloads', async () => {
  let wire = { ok: true, value: { runId: 'run-a', state: 'failed', seq: 8, applied: true } }
  const namespace = {
    async resolveRecovery() {
      return wire
    }
  }
  const host = resolveConversationHost({ get: () => namespace })
  const args = { runId: 'run-a', resolution: 'succeeded', note: 'reviewed', expectedSeq: 0 }
  assert.deepEqual(await host.resolveRecovery(args), wire.value)
  for (const invalid of [
    null,
    [],
    { ok: 'yes' },
    { ok: true, value: { runId: 'run-a', state: 'failed', seq: 8 } },
    { ok: true, value: { ...wire.value, note: 'raw' } }
  ]) {
    wire = invalid
    await assert.rejects(host.resolveRecovery(args), { code: 'blueprint/dto-invalid' })
  }
  wire = { ok: false, error: { code: 'blueprint/run-lifecycle-conflict', raw: 'PRIVATE_SENTINEL' } }
  await assert.rejects(host.resolveRecovery(args), error => {
    assert.equal(error.code, 'blueprint/run-lifecycle-conflict')
    assert.equal(String(error.message).includes('PRIVATE_SENTINEL'), false)
    return true
  })
  wire = { ok: false, error: { body: 'PRIVATE_SENTINEL' } }
  await assert.rejects(host.resolveRecovery(args), error => {
    assert.equal(error.code, 'blueprint/remote-failed')
    assert.equal(String(error.message).includes('PRIVATE_SENTINEL'), false)
    return true
  })
})

test('lifecycle bridge forwards the Session scope for archive and restore', async () => {
  const calls = []
  const namespace = {
    async archiveRun(args) {
      calls.push(['archiveRun', args])
      return { ok: true, value: { runId: args.runId, archived: true } }
    },
    async restoreRun(args) {
      calls.push(['restoreRun', args])
      return { ok: true, value: { runId: args.runId, archived: false } }
    }
  }
  const host = resolveConversationHost({ get: () => namespace })
  assert.deepEqual(await host.archiveRun({ runId: 'run-a', sessionId: 'source' }), { runId: 'run-a', archived: true })
  assert.deepEqual(await host.restoreRun({ runId: 'run-a', sessionId: 'source' }), { runId: 'run-a', archived: false })
  assert.deepEqual(calls, [
    ['archiveRun', { runId: 'run-a', sessionId: 'source' }],
    ['restoreRun', { runId: 'run-a', sessionId: 'source' }]
  ])
  await assert.rejects(host.archiveRun({ runId: 'run-a', sessionId: 'source', raw: '/secret' }), { code: 'blueprint/bad-request' })
})

test('controller resolveRecovery sends the Session scope and reviewed sequence, then refreshes once', async () => {
  const reads = []
  const resolutions = []
  let inspected = value()
  let settle
  const host = {
    async inspectSession(args) {
      reads.push(args)
      return inspected
    },
    async resolveRecovery(args) {
      resolutions.push(args)
      return new Promise(resolve => {
        settle = resolve
      })
    }
  }
  const controller = new ConversationController(host, 'source')
  await controller.refresh()
  assert.equal(controller.getSnapshot().value.selected.run.state, RECOVERY)
  const pending = controller.resolveRecovery('failed', '  operator checked the child session  ')
  assert.deepEqual(
    resolutions,
    [{ runId: 'run-a', sessionId: 'source', resolution: 'failed', note: 'operator checked the child session', expectedSeq: 7 }],
    'note is trimmed on the wire and the observed seq is the optimistic guard'
  )
  assert.equal(reads.length, 1, 'no refresh before the reviewed terminal is durable')
  inspected = value({ state: 'failed', seq: 9 })
  settle({ runId: 'run-a', state: 'failed', seq: 9, applied: true })
  assert.equal(await pending, true)
  assert.equal(reads.length, 2, 'success refreshes the bound Session facts once')
  assert.equal(controller.getSnapshot().value.selected.run.state, 'failed')
  assert.equal(controller.getSnapshot().connection, 'connected')
  assert.equal(controller.getSnapshot().errorCode, null)
})

test('controller resolveRecovery publishes static typed failures and stays non-throwing', async () => {
  const controller = new ConversationController(
    {
      async inspectSession() {
        return value()
      },
      async resolveRecovery() {
        throw new BlueprintRemoteError('blueprint/remote-failed')
      }
    },
    'source'
  )
  await controller.refresh()
  const previous = controller.getSnapshot().value
  assert.equal(await controller.resolveRecovery('succeeded', 'reviewed'), false)
  assert.equal(controller.getSnapshot().errorCode, 'blueprint/remote-failed')
  assert.equal(controller.getSnapshot().connection, 'stale', 'a transport failure still marks the view stale')
  assert.equal(controller.getSnapshot().value, previous, 'typed failure keeps the last known facts')
  const foreign = new ConversationController(
    {
      async inspectSession() {
        return value()
      },
      async resolveRecovery() {
        return { runId: 'foreign-run', state: 'failed', seq: 9, applied: true }
      }
    },
    'source'
  )
  await foreign.refresh()
  assert.equal(await foreign.resolveRecovery('failed', 'reviewed'), false)
  assert.equal(foreign.getSnapshot().errorCode, 'blueprint/dto-invalid', 'a response for another Run is not applied')
  const wire = []
  const bridge = resolveConversationHost({
    get: () => ({
      async resolveRecovery(args) {
        wire.push(args)
        throw new Error('must not reach the Host with an empty audit note')
      }
    })
  })
  const whitespace = new ConversationController(
    {
      async inspectSession() {
        return value()
      },
      resolveRecovery: bridge.resolveRecovery
    },
    'source'
  )
  await whitespace.refresh()
  assert.equal(await whitespace.resolveRecovery('failed', '   '), false)
  assert.equal(whitespace.getSnapshot().errorCode, 'blueprint/bad-request', 'the wire codec rejects an empty audit note before dispatch')
  assert.deepEqual(wire, [])
})

test('a lifecycle conflict keeps the view connected and re-reads the current seq so the form can retry', async () => {
  const reads = []
  const sent = []
  let inspected = value({ seq: 7 })
  let conflict = true
  const controller = new ConversationController(
    {
      async inspectSession(args) {
        reads.push(args)
        return inspected
      },
      async resolveRecovery(args) {
        sent.push(args.expectedSeq)
        if (conflict) {
          // Another reviewer advanced the Run after this view read it.
          inspected = value({ seq: 8 })
          throw new BlueprintRemoteError('blueprint/run-lifecycle-conflict')
        }
        inspected = value({ state: 'failed', seq: 9 })
        return { runId: 'run-a', state: 'failed', seq: 9, applied: true }
      }
    },
    'source'
  )
  await controller.refresh()
  assert.equal(await controller.resolveRecovery('failed', 'reviewed'), false)
  const after = controller.getSnapshot()
  assert.equal(after.connection, 'connected', 'a typed business conflict is not a lost connection')
  assert.equal(after.errorCode, 'blueprint/run-lifecycle-conflict', 'the conflict stays visible after the refresh')
  assert.equal(after.value.selected.run.seq, 8, 'the refresh picks up the advanced sequence')
  assert.equal(reads.length, 2)
  conflict = false
  assert.equal(await controller.resolveRecovery('failed', 'reviewed again'), true)
  assert.deepEqual(sent, [7, 8], 'the retry uses the freshly read sequence, not the outdated one')
  assert.equal(controller.getSnapshot().errorCode, null)
})

test('a lifecycle conflict whose refresh fails falls back to the refresh outcome', async () => {
  let fail = false
  const controller = new ConversationController(
    {
      async inspectSession() {
        if (fail) throw new BlueprintRemoteError('blueprint/remote-failed')
        return value()
      },
      async resolveRecovery() {
        fail = true
        throw new BlueprintRemoteError('blueprint/run-lifecycle-conflict')
      }
    },
    'source'
  )
  await controller.refresh()
  assert.equal(await controller.resolveRecovery('failed', 'reviewed'), false)
  assert.notEqual(controller.getSnapshot().connection, 'connected')
  assert.equal(controller.getSnapshot().errorCode, 'blueprint/remote-failed')
})

test('controller resolveRecovery needs a connected bound Session and the Host capability', async () => {
  const unbound = new ConversationController(
    {
      async inspectSession() {
        return { status: 'unbound', sessionId: 'source' }
      },
      async resolveRecovery() {
        throw new Error('not called')
      }
    },
    'source'
  )
  await unbound.refresh()
  assert.equal(await unbound.resolveRecovery('failed', 'reviewed'), false)
  const noCapability = new ConversationController(
    {
      async inspectSession() {
        return value()
      }
    },
    'source'
  )
  await noCapability.refresh()
  assert.equal(await noCapability.resolveRecovery('failed', 'reviewed'), false)
  const calls = []
  const controller = new ConversationController(
    {
      async inspectSession() {
        return value()
      },
      async resolveRecovery(args) {
        calls.push(args)
        return { runId: 'run-a', state: 'failed', seq: 9, applied: true }
      }
    },
    'source'
  )
  await controller.refresh()
  controller.pause()
  assert.equal(await controller.resolveRecovery('failed', 'reviewed'), false)
  assert.deepEqual(calls, [], 'observation cleanup cannot dispatch a resolution')
})

test('archiveSelectedRun archives in the bound Session Workspace', async () => {
  const archived = []
  const controller = new ConversationController(
    {
      async inspectSession() {
        return value({ state: 'running' })
      },
      async archiveRun(args) {
        archived.push(args)
        return { runId: args.runId, archived: true }
      }
    },
    'source'
  )
  await controller.refresh()
  await controller.archiveSelectedRun()
  assert.deepEqual(archived, [{ runId: 'run-a', sessionId: 'source' }], 'a non-default Workspace Run is archived where it was created')
})

// ── conversation-view recovery section: controlled React seat ──────────────
const key = Symbol.for('blueprint.test.session.recovery')
const seat = { active: null }
globalThis[key] = seat
seat.react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState(initial) {
    const f = seat.active,
      i = f.stateCursor++
    f.states[i] ??= typeof initial === 'function' ? initial() : initial
    return [
      f.states[i],
      next => {
        f.states[i] = typeof next === 'function' ? next(f.states[i]) : next
      }
    ]
  },
  useEffect(callback, deps) {
    const f = seat.active,
      i = f.effectCursor++,
      old = f.effects[i]
    if (!old || deps.some((entry, index) => entry !== old.deps[index])) {
      old?.cleanup?.()
      f.effects[i] = { callback, deps, cleanup: null, pending: true }
    }
  }
}
const client = new URL('../../src/client/', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'react' && context.parentURL?.startsWith(client + 'features/conversation/'))
      return {
        url: 'data:text/javascript,' + encodeURIComponent('export default globalThis[Symbol.for("blueprint.test.session.recovery")].react'),
        shortCircuit: true
      }
    return next(specifier, context)
  }
})
let Section
try {
  ;({ ConversationRecoverySection: Section } = await import(client + 'features/conversation/ui/conversation-recovery.tsx'))
} finally {
  hooks.deregister()
}
test.after(() => {
  delete globalThis[key]
})
const all = (tree, predicate) =>
  !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...(tree.children ?? []).flat(Infinity).flatMap(child => all(child, predicate))]
const one = (tree, predicate) => {
  const found = all(tree, predicate)
  assert.equal(found.length, 1)
  return found[0]
}
const translate =
  dict =>
  (translationKey, params = {}) => {
    assert.ok(Object.hasOwn(dict, translationKey), 'MISSING_VISIBLE_TRANSLATION:' + translationKey)
    return dict[translationKey].replace(/\{(\w+)\}/g, (_token, name) => String(params[name]))
  }
const snapshotOf = (bound, connection = 'connected', errorCode = null) => ({
  sessionId: 'source',
  value: bound,
  connection,
  selectedAttemptId: null,
  errorCode
})

function fixture(dict = en) {
  const state = { states: [], effects: [], stateCursor: 0, effectCursor: 0 }
  const calls = []
  const live = { errorCode: null }
  let settle
  const controller = {
    resolveRecovery(resolution, note) {
      calls.push({ resolution, note })
      return new Promise(resolve => {
        settle = resolve
      })
    },
    getSnapshot() {
      return live
    }
  }
  return {
    calls,
    live,
    settle(applied) {
      settle(applied)
    },
    render(bound, snapshot) {
      seat.active = state
      state.stateCursor = state.effectCursor = 0
      return Section({ bound, snapshot, controller, t: translate(dict) })
    },
    effects() {
      for (const effect of state.effects)
        if (effect.pending) {
          effect.pending = false
          effect.cleanup = effect.callback()
        }
    }
  }
}

test('recovery section shows localized copy, a bounded note field and both identities in both locales', () => {
  for (const dict of [zh, en]) {
    const f = fixture(dict)
    const bound = value()
    const tree = f.render(bound, snapshotOf(bound))
    const section = one(tree, node => node.props['data-bp-recovery'] === 'run-a')
    assert.equal(section.props['data-bp-recovery-kind'], 'resolvable')
    const text = JSON.stringify(tree)
    for (const visible of [dict['recovery.title'], dict['recovery.help'], dict['recovery.note'], dict['recovery.markFailed'], dict['recovery.markSucceeded']]) {
      assert.ok(text.includes(visible), 'visible recovery copy missing: ' + visible)
    }
    const note = one(tree, node => node.props['data-bp-recovery-note'] === true)
    assert.equal(note.type, 'textarea')
    assert.equal(note.props.maxLength, 500)
    const buttons = all(tree, node => node.type === 'button')
    assert.deepEqual(
      buttons.map(node => node.props['data-bp-action']),
      ['recovery-failed', 'recovery-succeeded']
    )
    for (const button of buttons) assert.equal(button.props.disabled, true, 'empty note cannot be resolved')
  }
})

test('recovery section resolves with the note, disables while busy and reports the recorded terminal', async () => {
  const f = fixture(en)
  const bound = value()
  let tree = f.render(bound, snapshotOf(bound))
  one(tree, node => node.props['data-bp-recovery-note'] === true).props.onChange({ currentTarget: { value: '  checked the child session  ' } })
  tree = f.render(bound, snapshotOf(bound))
  assert.equal(one(tree, node => node.props['data-bp-action'] === 'recovery-failed').props.disabled, false)
  one(tree, node => node.props['data-bp-action'] === 'recovery-succeeded').props.onClick()
  tree = f.render(bound, snapshotOf(bound))
  assert.deepEqual(f.calls, [{ resolution: 'succeeded', note: '  checked the child session  ' }], 'controller owns trimming')
  assert.equal(one(tree, node => node.props['data-bp-action'] === 'recovery-failed').props.disabled, true, 'busy blocks a second resolution')
  assert.equal(one(tree, node => node.props['data-bp-recovery-note'] === true).props.disabled, true)
  f.settle(true)
  await Promise.resolve()
  await Promise.resolve()
  tree = f.render(bound, snapshotOf(bound))
  const resolved = one(tree, node => node.props['data-bp-recovery-resolved'] === 'succeeded')
  assert.ok(JSON.stringify(resolved.children).includes(en['recovery.resolved'].replace('{state}', 'Succeeded')))
  assert.equal(all(tree, node => node.props['data-bp-recovery-error']).length, 0)
  const terminal = value({ state: 'succeeded', seq: 9 })
  tree = f.render(terminal, snapshotOf(terminal))
  assert.equal(one(tree, node => node.props['data-bp-recovery-kind'] === 'none').props['data-bp-recovery'], 'run-a')
  assert.equal(all(tree, node => node.type === 'textarea').length, 0, 'the terminal Run no longer offers the form')
  assert.ok(JSON.stringify(tree).includes(en['recovery.resolved'].replace('{state}', 'Succeeded')), 'the local status outlives the refreshed form')
})

test('recovery section surfaces the published typed failure code and never raw payloads', async () => {
  const f = fixture(en)
  const bound = value()
  let tree = f.render(bound, snapshotOf(bound))
  one(tree, node => node.props['data-bp-recovery-note'] === true).props.onChange({ currentTarget: { value: 'reviewed' } })
  tree = f.render(bound, snapshotOf(bound))
  one(tree, node => node.props['data-bp-action'] === 'recovery-failed').props.onClick()
  f.live.errorCode = 'blueprint/run-lifecycle-conflict'
  f.settle(false)
  await Promise.resolve()
  await Promise.resolve()
  tree = f.render(bound, snapshotOf(bound, 'stale', 'blueprint/run-lifecycle-conflict'))
  const error = one(tree, node => node.props['data-bp-recovery-error'] === 'blueprint/run-lifecycle-conflict')
  assert.ok(JSON.stringify(error.children).includes('Operation failed: blueprint/run-lifecycle-conflict'))
  assert.equal(all(tree, node => node.props['data-bp-recovery-resolved']).length, 0)
  assert.equal(one(tree, node => node.props['data-bp-recovery-note'] === true).props.disabled, false, 'a stale draft note stays editable')
  assert.equal(
    all(tree, node => node.type === 'button').every(node => node.props.disabled === true),
    true,
    'stale facts cannot resolve'
  )
})

test('team-manual recovery shows guidance instead of buttons; a new Run resets the note', () => {
  const f = fixture(zh)
  const manual = value()
  manual.selected.run.team = teamStage()
  const tree = f.render(manual, snapshotOf(manual))
  const section = one(tree, node => node.props['data-bp-recovery'] === 'run-a')
  assert.equal(section.props['data-bp-recovery-kind'], 'team-manual')
  assert.ok(JSON.stringify(section.children).includes(zh['recovery.teamManual']))
  assert.equal(all(tree, node => ['textarea', 'button'].includes(node.type)).length, 0, 'native Team cleanup happens outside this seat')
  const normal = fixture(zh)
  const first = value()
  let next = normal.render(first, snapshotOf(first))
  one(next, node => node.props['data-bp-recovery-note'] === true).props.onChange({ currentTarget: { value: 'draft note' } })
  next = normal.render(first, snapshotOf(first))
  assert.equal(one(next, node => node.props['data-bp-recovery-note'] === true).props.value, 'draft note')
  const second = value({ runId: 'run-b' })
  next = normal.render(second, snapshotOf(second))
  normal.effects()
  next = normal.render(second, snapshotOf(second))
  assert.equal(one(next, node => node.props['data-bp-recovery-note'] === true).props.value, '', 'selected Run change clears the discarded note')
})

test('recovery section renders nothing for a bound Run that is not waiting for recovery', () => {
  const f = fixture(en)
  for (const state of ['running', 'succeeded', 'failed', 'waiting_input']) {
    const bound = value({ state })
    assert.equal(f.render(bound, snapshotOf(bound)), null)
  }
})
