// Synthetic hook probes test collector delegation; never live/browser evidence.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { ROOT, sha256 } from '../../../../../test/blueprint/capabilities/conversation-evidence.mjs'
import { createConversationObserver, observerSource } from '../../../../../test/blueprint/capabilities/conversation-observer.mjs'
import { observeNativeRequests, projectInspection } from '../../../../../test/blueprint/capabilities/conversation-browser.mjs'

const { createToolResultMessage } = await import(pathToFileURL(join(ROOT, 'test/blueprint/node_modules/@deepseek-ai/dsh-llm/lib/types/message.js')).href)

function observerHarness() {
  const hooks = new Map(), options = new Map(), snapshots = []
  const agent = { id: 'unit-session' }
  const ctx = { on: (name, hook, config) => { hooks.set(name, hook); options.set(name, config) }, get: () => ({ currentInitiator: () => agent }) }
  const marked = new WeakSet()
  createConversationObserver(ctx, { isAgentLoopRequest: value => marked.has(value), hash: sha256, flush: facts => snapshots.push(facts), clock: () => '2026-10-08T15:00:00.000Z' })
  hooks.get('agent/created')({ agent })
  return { hooks, options, snapshots, agent, marked, latest: () => snapshots.at(-1).sessions[0] }
}
test('observer preserves exact request/chunk identity and real assistant frame identity', async () => {
  const h = observerHarness(), request = { sessionId: h.agent.id }, chunk = { type: 'text-delta', text: 'unit provider-shaped chunk' }
  h.marked.add(request)
  h.hooks.get('agent/assistant-stream')({ agent: h.agent, frame: { type: 'start', attemptId: 'real-frame-unit:7', turn: 3, step: 4 } })
  const stream = h.hooks.get('llm/stream')(request, async function* () { yield chunk })
  const first = await stream.next()
  assert.strictEqual(first.value, chunk)
  assert.equal(h.latest().requests.length, 1)
  assert.equal(h.latest().requests[0].identity, 'real-frame-unit:7')
  assert.equal(h.latest().requests[0].turn, 3)
  assert.equal(h.latest().requests[0].active, true)
  assert.equal(h.latest().requests[0].textDeltas, 1)
  await stream.next()
  assert.equal(h.latest().requests[0].active, false)
  assert.equal(h.options.get('llm/stream').prepend, true)
  assert.ok(!JSON.stringify(h.snapshots).includes(chunk.text))
})
test('unmarked calls and read-only polls cannot inflate model calls; stream failure propagates', async () => {
  const h = observerHarness()
  const unmarked = h.hooks.get('llm/stream')({ sessionId: h.agent.id }, async function* () { yield { type: 'text-delta', text: 'unit' } })
  for await (const _ of unmarked) { /* drain unchanged chunks */ }
  assert.equal(h.latest().requests.length, 0)
  assert.equal(h.hooks.has('blueprint/inspectSession'), false)
  const request = { sessionId: h.agent.id }, failure = new Error('unit upstream details excluded')
  h.marked.add(request)
  const stream = h.hooks.get('llm/stream')(request, async function* () { yield* []; throw failure })
  await assert.rejects(stream.next(), error => error === failure)
  assert.equal(h.latest().requests[0].failed, true)
  assert.equal(h.latest().requests[0].active, false)
  assert.ok(!JSON.stringify(h.snapshots).includes(failure.message))
})
test('native approval delegates exactly once and requires logged decision rather than waterfall return', async () => {
  const h = observerHarness(), session = { id: h.agent.id }
  h.hooks.get('session/event')(session, { type: 'approval/asked', seq: 5, data: { id: 'audit-unit', callId: 'call-unit', reason: 'unit hidden reason' } })
  let nextCount = 0
  const outcome = await h.hooks.get('approval/request')({ agent: h.agent, callId: 'call-unit' }, async () => { nextCount++; return 'allowed-once' })
  assert.equal(nextCount, 1)
  assert.equal(outcome, 'allowed-once')
  assert.equal(h.options.get('approval/request').prepend, true)
  assert.equal(h.latest().approvals[0].decidedLogged, false)
  h.hooks.get('session/event')(session, { type: 'approval/decided', seq: 6, data: { id: 'audit-unit', outcome: 'allowed-once' } })
  assert.equal(h.latest().approvals[0].decidedLogged, true)
  assert.equal(h.latest().approvals[0].decidedSeq, 6)
  assert.ok(!JSON.stringify(h.snapshots).includes('unit hidden reason'))
})
test('tool lineage joins logged call/result with public pipeline identity without raw arguments/results', () => {
  const h = observerHarness(), session = { id: h.agent.id }
  h.hooks.get('session/event')(session, { type: 'tool/call', seq: 7, data: { name: 'blueprint_start', callId: 'call-unit', turn: 2, arguments: 'unit hidden arguments' } })
  h.hooks.get('tools/result')({ agent: h.agent, name: 'blueprint_start', callId: 'call-unit' }, { isError: false, content: 'unit hidden result' })
  assert.equal(h.latest().toolCalls[0].pipelineResultObserved, true)
  assert.equal(h.latest().toolCalls[0].resultLogged, false)
  h.hooks.get('session/event')(session, { type: 'tool/result', seq: 8, data: { message: createToolResultMessage({ callId: 'call-unit', isError: false, content: [{ type: 'text', text: 'unit hidden result' }] }) } })
  assert.equal(h.latest().toolCalls[0].resultLogged, true)
  assert.equal(h.latest().toolCalls[0].ok, true)
  assert.ok(!JSON.stringify(h.snapshots).includes('unit hidden'))
  assert.match(observerSource('file:///public-llm/index.js'), /export const inject=\['agents','llm'\]/)
})
test('installed native result message joins only its real tool identity; missing error flag cannot mean successful write', () => {
  const h = observerHarness(), session = { id: h.agent.id }, emit = h.hooks.get('session/event')
  emit(session, { type: 'tool/call', seq: 1, data: { name: 'blueprint_start', callId: 'start-unit', turn: 0, arguments: JSON.stringify({ input: { nonce: 'unit-hidden-nonce' } }) } })
  assert.equal(h.latest().toolCalls[0].inputSha256, sha256('{"nonce":"unit-hidden-nonce"}'))
  assert.ok(!JSON.stringify(h.snapshots).includes('unit-hidden-nonce'))
  emit(session, { type: 'tool/call', seq: 2, data: { name: 'write', callId: 'write-unit', turn: 1, arguments: 'unit hidden native arguments' } })
  emit(session, { type: 'approval/asked', seq: 3, data: { id: 'approval-unit', callId: 'write-unit' } })
  emit(session, { type: 'approval/decided', seq: 4, data: { id: 'approval-unit', outcome: 'allowed-once' } })
  const message = input => createToolResultMessage({ ...input, content: [{ type: 'text', text: 'unit hidden result' }] })
  h.hooks.get('tools/result')({ agent: h.agent, name: 'write', callId: 'wrong-call' }, { isError: false })
  emit(session, { type: 'tool/result', seq: 5, data: { message: message({ callId: 'wrong-call', isError: false }) } })
  emit(session, { type: 'tool/result', seq: 5, data: { message: { ...message({ callId: 'write-unit', isError: false }), source: { kind: 'tool', callId: 'wrong-call' } } } })
  h.hooks.get('tools/result')({ agent: h.agent, name: 'blueprint_start', callId: 'write-unit' }, { isError: false })
  assert.equal(h.latest().toolCalls[1].resultLogged, false)
  assert.equal(h.latest().toolCalls[1].pipelineResultObserved, undefined)
  emit(session, { type: 'tool/result', seq: 6, data: { message: message({ callId: 'write-unit' }) } })
  assert.equal(h.latest().toolCalls[1].ok, false)
  for (const isError of [true, false]) {
    h.hooks.get('tools/result')({ agent: h.agent, name: 'write', callId: 'write-unit' }, { isError })
    emit(session, { type: 'tool/result', seq: 7, data: { message: message({ callId: 'write-unit', isError }) } })
    const observed = h.latest().toolCalls[1]
    assert.equal(observed.ok, !isError); assert.equal(observed.pipelineResultObserved, !isError)
    assert.equal(observed.resultSeq, 7); assert.equal(observed.isError, isError)
    assert.equal(observed.callId, h.latest().approvals[0].callId)
  }
  assert.ok(!JSON.stringify(h.snapshots).includes('unit hidden'))
})
test('native HTTP and resident WebSocket capture excludes inspect polls from mutations', () => {
  const page = new EventEmitter(), socket = new EventEmitter(), collector = observeNativeRequests(page)
  page.emit('websocket', socket)
  for (const [method, id] of [['blueprint/inspectSession', 'read-unit'], ['blueprint/startSessionRun', 'write-unit']]) {
    socket.emit('framesent', { payload: JSON.stringify({ type: 'client-request', method, rpcId: id, payload: { args: { hidden: 'unit raw secret' } } }) })
  }
  page.emit('request', { method: () => 'POST', url: () => 'http://127.0.0.1:3000/api/session/prompt',
    postDataJSON: () => ({ type: 'client-request', method: 'session/prompt', rpcId: 'prompt-unit', payload: { hidden: 'unit raw prompt' } }) })
  assert.equal(collector.requests.length, 3)
  assert.equal(collector.mutations(), 2)
  assert.ok(!JSON.stringify(collector.requests).includes('unit raw'))
  collector.stop()
  socket.emit('framesent', { payload: JSON.stringify({ type: 'client-request', method: 'session/prompt', rpcId: 'after-stop' }) })
  assert.equal(collector.requests.length, 3)
})
test('frozen projection checks every focused Attempt and actual DOM node state', () => {
  const host = { status: 'bound', sessionId: 'source', selected: { run: { runId: 'run-unit', definitionRevision: 'rev-unit', attempts: [
    { attemptId: 'a1', nodeId: 'n1', state: 'running', attempt: 1, sessionId: 's1' }, { attemptId: 'a2', nodeId: 'n2', state: 'running', attempt: 1, sessionId: 's2' },
  ] }, graph: { nodes: [{ id: 'n1' }, { id: 'n2' }], edges: [] }, focusAttemptIds: ['a1', 'a2'] } }
  const dom = { sessionId: 'source', runId: 'run-unit', revision: 'rev-unit', nestedComposers: 0, attempts: ['a1', 'a2'], nodes: [{ nodeId: 'n1', state: 'running' }, { nodeId: 'n2', state: 'running' }] }
  assert.deepEqual(projectInspection(host, dom).focusAttemptIds, ['a1', 'a2'])
  assert.throws(() => projectInspection(host, { ...dom, attempts: ['a1'] }), /EVIDENCE_DOM_FOCUS/)
  assert.throws(() => projectInspection(host, { ...dom, nodes: [{ nodeId: 'n1', state: 'running' }] }), /EVIDENCE_DOM_GRAPH/)
  assert.throws(() => projectInspection(host, { ...dom, nodes: [{ nodeId: 'n1', state: 'succeeded' }, { nodeId: 'n2', state: 'running' }] }), /EVIDENCE_DOM_NODE_STATE/)
})
