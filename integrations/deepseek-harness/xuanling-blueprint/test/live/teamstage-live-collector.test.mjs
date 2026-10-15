import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import {
  ACCOUNT_QUOTA_EXCEEDED_CODE,
  QUOTA_EXCEEDED_CODE,
  createToolResultMessage
} from '../../../../../test/blueprint/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

const source = readFileSync(new URL('../../../../../test/blueprint/capabilities/teamstage-live-collector.mjs', import.meta.url), 'utf8')
// Evaluate only the generated observer definition. No collector entrypoint,
// credentials, profile, provider or network runs in these contract tests.
const safeProviderErrorCode = new Function(
  `${source.slice(source.indexOf('function safeProviderErrorCode('), source.indexOf('\nfunction safeRecordedErrorCode('))}; return safeProviderErrorCode`
)()
const operatorSource = new Function(
  'LEAD_SESSION',
  'safeProviderErrorCode',
  `${source.slice(source.indexOf('function operatorSource('), source.indexOf('\nfunction fixture('))}; return operatorSource`
)('lead', safeProviderErrorCode)
const validateMemberLineage = new Function(
  'LEAD_SESSION',
  'fail',
  `${source.slice(source.indexOf('function validateMemberLineage('), source.indexOf('\nfunction artifactAudit('))}; return validateMemberLineage`
)('lead', code => {
  throw Object.assign(new Error(code), { code })
})
const safeRun = new Function(`${source.slice(source.indexOf('function safeRun('), source.indexOf('\nfunction safeOperatorFacts('))}; return safeRun`)()
const safeRecordedErrorCode = value =>
  value === undefined || value === null ? null : safeProviderErrorCode(typeof value === 'string' ? { code: value } : value)
const safeOperatorFacts = new Function(
  'safeRecordedErrorCode',
  `${source.slice(source.indexOf('function safeOperatorFacts('), source.indexOf('\nfunction safeProviderErrorCode('))}; return safeOperatorFacts`
)(safeRecordedErrorCode)

function startObserver(model = 'glm-5.3-flash', options = {}) {
  const handlers = new Map(),
    writes = [...(options.initialWrites ?? [])]
  const effects = []
  let created
  let createCount = 0,
    resumeCount = 0
  const ctx = {
    on(name, handler) {
      handlers.set(name, handler)
    },
    ...options.services,
    agents: {
      async create(value) {
        createCount++
        created = value
        if (options.create) return options.create(value)
        return { agent: { id: 'lead' }, dispose() {} }
      },
      async resume() {
        resumeCount++
        throw new Error('observer must not implicitly resume a durable session')
      }
    },
    effect(effect) {
      effects.push(effect)
    }
  }
  const generated = operatorSource({ operatorFacts: '/isolated/facts.json', ready: '/isolated/ready.json' }, { model, ...options.config })
  const apply = new Function(
    'writeFileSync',
    'renameSync',
    'process',
    `${generated
      .replace(/^import .*\n/m, '')
      .replace('export const inject', 'const inject')
      .replace('export async function apply', 'async function apply')}; return apply`
  )(
    (path, bytes) => writes.push({ path, value: JSON.parse(bytes) }),
    () => {},
    { pid: options.pid ?? 41001, env: options.env ?? {}, cwd: () => '/isolated' }
  )
  const applying = apply(ctx)
  return {
    handlers,
    effects,
    applying,
    get created() {
      return created
    },
    get createCount() {
      return createCount
    },
    get resumeCount() {
      return resumeCount
    },
    snapshot: () => writes.findLast(item => item.path.endsWith('.next'))?.value,
    ready: () => writes.findLast(item => item.path.endsWith('/ready.json'))?.value
  }
}

async function observer(model = 'glm-5.3-flash', options = {}) {
  const observed = startObserver(model, options)
  await observed.applying
  return observed
}

test('live operator creates Lead with the explicitly selected model', async () => {
  const facts = await observer()
  assert.equal(facts.created.agentOptions.model, 'glm-5.3-flash')
})

test('browser Lead mounts the requested native preset before Agent publication', async () => {
  const agentCtx = {},
    agent = { id: 'lead', ctx: agentCtx },
    mounts = []
  const observed = await observer('glm-5.3-flash', {
    config: { leadAgentPreset: 'standard' },
    services: {
      agentPresets: {
        async mount(scope, preset) {
          mounts.push({ scope, preset })
        }
      },
      tools: {
        schemas(scope) {
          assert.equal(scope, agent)
          return [{ name: 'write' }]
        }
      }
    },
    async create(options) {
      assert.equal(options.meta.agentPreset, 'standard')
      assert.equal(typeof options.setup, 'function')
      await options.setup(agentCtx, agent)
      assert.deepEqual(mounts, [{ scope: agentCtx, preset: 'standard' }])
      return { agent, dispose() {} }
    }
  })
  assert.equal(observed.ready().lead_preset, 'standard')
  assert.deepEqual(observed.ready().lead_tool_names, ['write'])
})

test('model-facing tool observation records names without schema or prompt content', async () => {
  const observed = await observer()
  const chunks = observed.handlers.get('llm/stream')(
    {
      sessionId: 'lead',
      provider: 'blueprint-live',
      model: 'glm-5.3-flash',
      tools: [{ name: 'write', description: 'private tool description', parameters: { private: 'private schema body' } }],
      messages: [{ content: 'private prompt body' }]
    },
    async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  )
  for await (const _ of chunks) {
    /* consume the real hook chain */
  }
  const facts = safeOperatorFacts(observed.snapshot())
  assert.deepEqual(facts.sessions[0].requests[0].tool_names, ['write'])
  assert.doesNotMatch(JSON.stringify(facts), /private tool description|private schema body|private prompt body/)
})

test('native Agent hydration records public resume source separately from fresh startup', async () => {
  const observed = await observer()
  observed.handlers.get('agent/created')({ agent: { id: 'lead', status: 'idle' }, source: 'resume' })
  assert.equal(safeOperatorFacts(observed.snapshot()).sessions[0].start_source, 'resume')
  observed.handlers.get('agent/created')({ agent: { id: 'blank', status: 'idle' }, source: 'startup' })
  assert.equal(safeOperatorFacts(observed.snapshot()).sessions[1].start_source, 'startup')
})

test('unknown Agent lifecycle source cannot confer resume authority or leak source content', async () => {
  const observed = await observer()
  observed.handlers.get('agent/created')({ agent: { id: 'lead', status: 'idle' }, source: { kind: 'resume', body: 'private lifecycle payload' } })
  const facts = safeOperatorFacts(observed.snapshot())
  assert.equal(facts.sessions[0].start_source, 'unknown')
  assert.doesNotMatch(JSON.stringify(facts), /private lifecycle payload/)
})

test('observe-only restart keeps all original hooks and publishes readiness without creating or resuming Lead', async () => {
  const observed = await observer('deepseek-flash', {
    pid: 42002,
    env: { XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY: '1' }
  })
  assert.equal(observed.createCount, 0, 'observe-only startup must not recreate the durable Lead session')
  assert.equal(observed.resumeCount, 0, 'observe-only startup must not resume the durable Lead session')
  assert.deepEqual(
    [...observed.handlers.keys()].sort(),
    ['agent/created', 'agent/status', 'agent/disposed', 'agent/error', 'session/event', 'llm/stream'].sort()
  )
  assert.equal(observed.effects.length, 0)
  assert.equal(observed.snapshot().instance_pid, 42002)
  assert.equal(observed.snapshot().operator_ready, true)
  assert.equal(observed.snapshot().observation_only, true)
  assert.equal(
    observed.snapshot().sessions.reduce((count, item) => count + item.requests.length, 0),
    0
  )
  assert.equal(observed.ready().instance_pid, 42002)
  assert.equal(observed.ready().operator_ready, true)
  assert.equal(observed.ready().observation_only, true)
  // Explicit synthetic input verifies that registration remains functional;
  // it is separate from the zero-request startup assertion above.
  observed.handlers.get('session/event')({ id: 'member' }, { type: 'turn/end', seq: 10, data: { turn: 1, reason: { kind: 'completed' } } })
  const chunk = { type: 'finish', reason: { kind: 'stop' } }
  for await (const value of observed.handlers.get('llm/stream')(
    { sessionId: 'member', provider: 'blueprint-live', model: 'deepseek-flash' },
    async function* () {
      yield chunk
    }
  ))
    assert.equal(value, chunk)
  assert.equal(observed.snapshot().sessions[0].terminals[0].kind, 'completed')
  assert.equal(observed.snapshot().sessions[0].requests[0].finished, true)
  assert.equal(observed.snapshot().instance_pid, 42002)
  assert.equal(observed.snapshot().operator_ready, true)
})

test('normal bootstrap publishes not-ready until selected-model Lead creation completes', async () => {
  let finishCreate
  const createFinished = new Promise(resolve => {
    finishCreate = resolve
  })
  const observed = startObserver('glm-5.3-flash', { pid: 43003, create: () => createFinished })
  try {
    assert.equal(observed.createCount, 1)
    assert.equal(observed.resumeCount, 0)
    assert.equal(observed.created.agentOptions.provider, 'blueprint-live')
    assert.equal(observed.created.agentOptions.model, 'glm-5.3-flash')
    assert.equal(observed.handlers.has('session/event'), true)
    assert.equal(observed.handlers.has('llm/stream'), true)
    assert.equal(observed.ready(), undefined, 'ready sentinel cannot precede completion of Lead creation')
    assert.equal(observed.snapshot()?.operator_ready, false, 'facts must report pending bootstrap before create resolves')
    assert.equal(observed.snapshot().instance_pid, 43003)
    assert.equal(observed.snapshot().observation_only, false)
  } finally {
    finishCreate({ agent: { id: 'lead' }, dispose() {} })
    await observed.applying
  }
  assert.equal(observed.snapshot().operator_ready, true)
  assert.equal(observed.ready().instance_pid, 43003)
  assert.equal(observed.ready().operator_ready, true)
  assert.equal(observed.ready().observation_only, false)
  assert.equal(observed.effects.length, 1)
})

test('observe-only restart overwrites stale facts and readiness with the fresh process identity', async () => {
  const stale = { sessionId: 'lead', instance_pid: 44004, operator_ready: true, observation_only: false }
  const observed = await observer('deepseek-flash', {
    pid: 45005,
    env: { XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY: '1' },
    initialWrites: [
      { path: '/isolated/ready.json', value: stale },
      { path: '/isolated/facts.json.next', value: { ...stale, sessions: [], events: [] } }
    ]
  })
  assert.equal(observed.ready().instance_pid, 45005, 'old process readiness cannot satisfy the restarted observer')
  assert.equal(observed.snapshot().instance_pid, 45005)
  assert.equal(observed.snapshot().observation_only, true)
  assert.equal(observed.createCount, 0)
  assert.equal(observed.resumeCount, 0)
  assert.deepEqual(observed.snapshot().sessions, [])
})

test('safe operator facts retain generated process readiness and initial zero provider calls', async () => {
  const observed = await observer('deepseek-flash', { pid: 46006, env: { XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY: '1' } })
  const reduced = safeOperatorFacts(observed.snapshot())
  assert.equal(reduced.instance_pid, 46006)
  assert.equal(reduced.operator_ready, true)
  assert.equal(reduced.observation_only, true)
  assert.equal(reduced.provider_calls, 0)
})

test('provider finish error is recorded without changing the yielded chunk or storing raw message', async () => {
  const facts = await observer()
  const chunk = { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'raw-provider-body secret-value' } } }
  const next = async function* () {
    yield chunk
  }
  const seen = []
  for await (const value of facts.handlers.get('llm/stream')({ sessionId: 'member', provider: 'blueprint-live', model: 'glm-5.3-flash' }, next))
    seen.push(value)
  assert.equal(seen[0], chunk)
  const request = facts.snapshot().sessions.find(item => item.sessionId === 'member').requests[0]
  assert.equal(request.failed, true)
  assert.equal(request.error_code, 'TRANSPORT')
  assert.equal(request.finished, true)
  assert.doesNotMatch(JSON.stringify(facts.snapshot()), /raw-provider-body|secret-value/)
})

test('thrown provider failures keep typed identity and do not replace runtime failure', async () => {
  const facts = await observer()
  const failure = Object.assign(new Error('raw-provider-body secret-value'), { code: 'TIMEOUT' })
  const next = async function* () {
    yield await Promise.reject(failure)
  }
  await assert.rejects(
    async () => {
      for await (const _chunk of facts.handlers.get('llm/stream')({ sessionId: 'member', provider: 'blueprint-live', model: 'glm-5.3-flash' }, next)) {
        /* consume */
      }
    },
    error => error === failure
  )
  assert.equal(facts.snapshot().sessions.find(item => item.sessionId === 'member').requests[0].error_code, 'TIMEOUT')
  assert.doesNotMatch(JSON.stringify(facts.snapshot()), /raw-provider-body|secret-value/)
})

test('generated operator imports as a standalone keyless module', async () => {
  const root = mkdtempSync(join(tmpdir(), 'teamstage-operator-contract-'))
  try {
    const path = join(root, 'operator.mjs')
    writeFileSync(path, operatorSource({ operatorFacts: join(root, 'facts.json'), ready: join(root, 'ready.json') }, { model: 'deepseek-flash' }))
    const module = await import(pathToFileURL(path).href)
    assert.equal(typeof module.apply, 'function')
    assert.deepEqual(module.inject, ['agents', 'agentTeams', 'llm'])
    const ctx = {
      on() {},
      effect() {},
      agents: {
        async create(options) {
          assert.equal(options.agentOptions.model, 'deepseek-flash')
          return { agent: { id: 'lead' }, dispose() {} }
        }
      }
    }
    await module.apply(ctx)
    assert.equal(JSON.parse(readFileSync(join(root, 'ready.json'), 'utf8')).sessionId, 'lead')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function validLineage() {
  const run = { team: { teamId: 'lead', taskId: 'task-1', members: [{ memberId: 'member-id', sessionId: 'member', status: 'inactive' }] } }
  const calls = [
    { name: 'team_task_list', seq: 1 },
    { name: 'team_task_update', action: 'claim', taskId: 'task-1', expectedRevision: 1, seq: 3 },
    { name: 'team_task_update', action: 'complete', taskId: 'task-1', expectedRevision: 2, seq: 5 },
    { name: 'structured_output', seq: 7 }
  ].map((call, index) => ({ direction: 'call', callId: `call-${index}`, turn: 1, ...call }))
  const tools = calls.flatMap(call => [call, { direction: 'result', name: call.name, callId: call.callId, seq: call.seq + 1, isError: false }])
  const operator = {
    sessions: [
      {
        sessionId: 'member',
        status: 'idle',
        requests: [{ provider: 'blueprint-live', model: 'deepseek-flash', failed: false, finished: true }],
        terminals: [{ kind: 'completed', turn: 1, seq: 9 }],
        tools
      }
    ],
    events: [{ type: 'team/task', sessionId: 'lead', teamId: 'lead', taskId: 'task-1', status: 'completed', ownerId: 'member', revision: 3 }]
  }
  const artifact = {
    items: [
      {
        producerMemberId: 'member-id',
        producerSessionId: 'member',
        callId: 'call-3',
        rootCallId: 'call-3',
        turnId: 'member:1',
        completedTurnId: 'member:1',
        startLogSeq: 0,
        captureLogSeq: 8,
        endLogSeq: 9
      }
    ]
  }
  return { run, operator, config: { model: 'deepseek-flash' }, artifact }
}

test('success requires exact frozen member successful ordered tools and completed native task', () => {
  const { run, operator, config, artifact } = validLineage()
  assert.equal(validateMemberLineage(run, operator, config, artifact).status, 'passed')
  for (const mutate of [
    value => {
      value.sessions[0].sessionId = 'lead'
    },
    value => {
      value.sessions[0].requests[0].failed = true
    },
    value => {
      value.sessions[0].requests[0].providerOutcome = 'unknown'
    },
    value => {
      value.sessions[0].requests[0].model = 'different-model'
    },
    value => {
      value.sessions[0].terminals[0].kind = 'error'
    },
    value => {
      value.sessions[0].status = 'running'
    },
    value => {
      value.events[0].ownerId = 'foreign-member'
    },
    value => {
      value.events[0].revision = 4
    },
    value => {
      value.sessions[0].tools.find(tool => tool.direction === 'result').isError = true
    },
    value => {
      value.sessions[0].tools.find(tool => tool.action === 'complete').taskId = 'foreign-task'
    },
    value => {
      value.sessions[0].tools.find(tool => tool.action === 'complete').expectedRevision = 1
    },
    value => {
      value.sessions[0].tools.find(tool => tool.name === 'structured_output').seq = 0
    }
  ]) {
    const altered = structuredClone(operator)
    mutate(altered)
    assert.throws(
      () => validateMemberLineage(run, altered, config, artifact),
      error => error.code.startsWith('LIVE_TEAM_')
    )
  }
})

test('tool/result is linked only with matching public source and task args are reduced to safe facts', async () => {
  const facts = await observer()
  const handle = facts.handlers.get('session/event')
  handle(
    { id: 'member' },
    {
      type: 'tool/call',
      seq: 1,
      data: {
        name: 'team_task_update',
        callId: 'call',
        turn: 1,
        arguments: JSON.stringify({ action: 'complete', task_id: 'task-1', expected_revision: 2, description: 'secret-value raw-provider-body' })
      }
    }
  )
  // Build the actual installed public message shape; isError remains optional
  // in ToolResultMessage even though the current AgentLoop factory supplies it.
  const validResult = createToolResultMessage({ callId: 'call', isError: false, content: [{ type: 'text', text: 'secret-value' }] })
  const result = { ...validResult, source: { kind: 'tool', callId: 'foreign' } }
  handle({ id: 'member' }, { type: 'tool/result', seq: 2, data: { message: result } })
  let tools = facts.snapshot().sessions[0].tools
  assert.equal(tools[0].action, 'complete')
  assert.equal(tools[0].expectedRevision, 2)
  assert.equal(tools[1].name, 'other')
  const { isError: _isError, ...withoutOptionalError } = validResult
  handle({ id: 'member' }, { type: 'tool/result', seq: 3, data: { message: withoutOptionalError } })
  tools = facts.snapshot().sessions[0].tools
  assert.equal(tools[2].name, 'team_task_update')
  assert.equal(tools[2].isError, false)
  assert.doesNotMatch(JSON.stringify(facts.snapshot()), /secret-value|raw-provider-body/)
})

test('disposed requires the same completed turn, physical artifact identity and native inactive roster', () => {
  const { run, operator, config, artifact } = validLineage()
  operator.sessions[0].status = 'disposed'
  assert.equal(validateMemberLineage(run, operator, config, artifact).status, 'passed')
  assert.throws(() => validateMemberLineage(run, operator, config, { items: [] }), { code: 'LIVE_TEAM_COMPLETED_CAPTURE_MISSING' })
  const wrongTurn = structuredClone(artifact)
  wrongTurn.items[0].turnId = 'member:2'
  wrongTurn.items[0].completedTurnId = 'member:2'
  assert.throws(() => validateMemberLineage(run, operator, config, wrongTurn), { code: 'LIVE_TEAM_COMPLETED_CAPTURE_MISSING' })
  operator.sessions[0].terminals = []
  assert.throws(() => validateMemberLineage(run, operator, config, artifact), { code: 'LIVE_TEAM_COMPLETED_CAPTURE_MISSING' })
})

async function publicEventLineage(ptc) {
  const observed = await observer('deepseek-flash')
  const handle = observed.handlers.get('session/event')
  const session = { id: 'member' }
  handle(session, { type: 'turn/start', seq: 1, data: { turn: 1 } })
  const calls = [
    ['team_task_list', {}],
    ['team_task_update', { task_id: 'task-1', expected_revision: 1, action: 'claim' }],
    ['team_task_update', { task_id: 'task-1', expected_revision: 2, action: 'complete' }],
    ['structured_output', { result: 'live-teamstage', verified: true }]
  ]
  calls.forEach(([name, args], index) => {
    const rootId = `root-${index}`
    const callId = ptc ? `${rootId}:ptc:1` : `call-${index}`
    const seq = 3 + index * (ptc ? 4 : 2)
    if (ptc) {
      handle(session, { type: 'tool/call', seq: seq - 1, data: { turn: 1, callId: rootId, name: 'run_code', arguments: '{"code":"secret-value"}' } })
      const data = { rootCallId: rootId, parentCallId: rootId, subCallId: callId, name, arguments: args }
      handle(session, { type: 'tool/ptc-dispatch-start', seq, data })
      handle(session, { type: 'tool/ptc-dispatch', seq: seq + 1, data: { ...data, isError: false, content: [{ type: 'text', text: 'raw-provider-body' }] } })
      handle(session, {
        type: 'tool/result',
        seq: seq + 2,
        data: { turn: 1, message: createToolResultMessage({ callId: rootId, isError: false, content: [] }) }
      })
    } else {
      handle(session, { type: 'tool/call', seq, data: { callId, turn: 1, name, arguments: JSON.stringify(args) } })
      const message = createToolResultMessage({ callId, isError: false, content: [] })
      handle(session, { type: 'tool/result', seq: seq + 1, data: { turn: 1, message } })
    }
  })
  handle(session, { type: 'turn/end', seq: ptc ? 18 : 12, data: { turn: 1, reason: { kind: 'completed' } } })
  handle(
    { id: 'lead' },
    {
      type: 'team/task',
      seq: 4,
      data: {
        version: 2,
        teamId: 'lead',
        task: {
          id: 'task-1',
          revision: 3,
          status: 'completed',
          ownerId: 'member',
          subject: 'secret-value',
          description: 'raw-provider-body',
          blockedBy: [],
          writeScopes: []
        }
      }
    }
  )
  observed.handlers.get('agent/status')({ agent: { id: 'member' }, status: 'idle' })
  for await (const _chunk of observed.handlers.get('llm/stream')(
    { sessionId: 'member', provider: 'blueprint-live', model: 'deepseek-flash' },
    async function* () {
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  )) {
    /* consume */
  }
  const { run, config, artifact } = validLineage()
  const operator = observed.snapshot()
  Object.assign(artifact.items[0], {
    callId: ptc ? 'root-3:ptc:1' : 'call-3',
    rootCallId: ptc ? 'root-3' : 'call-3',
    captureLogSeq: ptc ? 17 : 10,
    endLogSeq: ptc ? 18 : 12
  })
  return { run, config, artifact, operator }
}

test('installed native tool/result message shape and snake_case tool wire yield valid lineage', async () => {
  const { run, operator, config, artifact } = await publicEventLineage(false)
  assert.equal(validateMemberLineage(run, operator, config, artifact).status, 'passed')
  assert.doesNotMatch(JSON.stringify(operator), /secret-value|raw-provider-body/)
})

test('PTC durable leaf events require matching subcall identities and a successful outer capture result', async () => {
  const { run, operator, config, artifact } = await publicEventLineage(true)
  assert.equal(validateMemberLineage(run, operator, config, artifact).status, 'passed')
  assert.doesNotMatch(JSON.stringify(operator), /secret-value|raw-provider-body/)
  for (const rootId of ['root-0', 'root-1', 'root-2', 'root-3']) {
    const failedOuter = structuredClone(operator)
    failedOuter.sessions.find(item => item.sessionId === 'member').tools.find(item => item.direction === 'result' && item.callId === rootId).isError = true
    assert.throws(() => validateMemberLineage(run, failedOuter, config, artifact), { code: 'LIVE_TEAM_MEMBER_TOOL_LINEAGE_INVALID' })
  }
  const wrongRoot = structuredClone(artifact)
  wrongRoot.items[0].rootCallId = 'foreign-root'
  assert.throws(() => validateMemberLineage(run, operator, config, wrongRoot), { code: 'LIVE_TEAM_MEMBER_TOOL_LINEAGE_INVALID' })
  const missingLeaf = structuredClone(operator)
  missingLeaf.sessions.find(item => item.sessionId === 'member').tools = missingLeaf.sessions
    .find(item => item.sessionId === 'member')
    .tools.filter(item => item.callId !== 'root-3:ptc:1')
  assert.throws(() => validateMemberLineage(run, missingLeaf, config, artifact), { code: 'LIVE_TEAM_MEMBER_TOOL_LINEAGE_INVALID' })
})

test('request timing and progress counters observe activity without recording model or reasoning content', async () => {
  const observed = await observer()
  const frames = [
    { type: 'text-delta', index: 0, text: 'private-model-text' },
    { type: 'reasoning-delta', index: 1, text: 'private-reasoning-text' },
    { type: 'reasoning-delta', index: 1, text: 'private-reasoning-text-2' },
    { type: 'tool-call-delta', index: 2, id: 'call', argumentsDelta: 'private-tool-arguments' },
    { type: 'finish', reason: { kind: 'tool-calls' } }
  ]
  for await (const chunk of observed.handlers.get('llm/stream')({ sessionId: 'member' }, async function* () {
    yield* frames
  })) {
    if (chunk.type === 'reasoning-delta') assert.ok(observed.snapshot().sessions.find(session => session.sessionId === 'member').requests[0].firstProgressAt)
  }
  const request = observed.snapshot().sessions.find(session => session.sessionId === 'member').requests[0]
  assert.equal(request.textDeltas, 1)
  assert.equal(request.reasoningDeltas, 2)
  assert.equal(request.toolCallDeltas, 1)
  assert.equal(request.providerOutcome, 'succeeded')
  assert.equal(request.finish_kind, 'tool-calls')
  assert.equal(request.iterator_finalized, true)
  for (const field of ['startedAt', 'finishedAt', 'firstProgressAt', 'lastProgressAt']) assert.ok(Number.isFinite(request[field]))
  assert.ok(request.durationMs >= 0)
  assert.ok(request.finishedAt >= request.lastProgressAt)
  assert.doesNotMatch(JSON.stringify(observed.snapshot()), /private-model-text|private-reasoning-text|private-tool-arguments/)
})

test('iterator finalization without a provider finish never means provider success', async () => {
  const observed = await observer()
  const iterator = observed.handlers.get('llm/stream')({ sessionId: 'member' }, async function* () {
    yield { type: 'reasoning-delta', text: 'private-reasoning-text' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await iterator.next()
  await iterator.return()
  const request = observed.snapshot().sessions[0].requests[0]
  assert.equal(request.finished, true)
  assert.equal(request.iterator_finalized, true)
  assert.equal(request.providerOutcome, 'unknown')
  assert.equal(request.finish_kind, null)
  assert.equal(request.reasoningDeltas, 1)
})

test('turn abort source and error classification allow typed facts only', async () => {
  const observed = await observer()
  const event = observed.handlers.get('session/event')
  event({ id: 'member' }, { type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'private-hook-detail' } } } })
  event({ id: 'member' }, { type: 'turn/end', seq: 2, data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'private-abort-source' } } } })
  event(
    { id: 'member' },
    { type: 'turn/end', seq: 3, data: { turn: 3, reason: { kind: 'error', error: { code: 'SECRET_VALUE', message: 'private-provider-error' } } } }
  )
  const terminals = observed.snapshot().sessions[0].terminals
  assert.equal(terminals[0].abort_source, 'hook')
  assert.equal(terminals[1].abort_source, 'unknown')
  assert.equal(terminals[2].error_code, 'UNKNOWN')
  assert.doesNotMatch(JSON.stringify(observed.snapshot()), /private-hook-detail|private-abort-source|SECRET_VALUE|private-provider-error/)
})

test('observation failure preserves last nonterminal Run and never fabricates a timed_out Run', async () => {
  const observationSource = source.slice(source.indexOf('async function observeTerminalRun('), source.indexOf('\nfunction safeGateway('))
  const observe = new Function('until', 'safeRun', 'safeCode', `${observationSource}; return observeTerminalRun`)(
    async (read, predicate, budget) => {
      assert.equal(budget, null)
      assert.equal(predicate(await read()), false)
      throw Object.assign(new Error('private-observation-error'), { code: 'HOST_GATEWAY_RPC_FAILED' })
    },
    run => ({ state: run.state, seq: run.seq }),
    error => error.code
  )
  const facts = {}
  await assert.rejects(() => observe(async () => ({ state: 'running', seq: 7 }), facts), { code: 'HOST_GATEWAY_RPC_FAILED' })
  assert.deepEqual(facts.run, { state: 'running', seq: 7 })
  assert.deepEqual(facts.observation, { status: 'failed', code: 'HOST_GATEWAY_RPC_FAILED', budget_ms: null, last_run_state: 'running', last_run_seq: 7 })
  assert.doesNotMatch(JSON.stringify(facts), /private-observation-error/)
})

test('observed canonical timed_out Run remains a distinct terminal result', async () => {
  const observationSource = source.slice(source.indexOf('async function observeTerminalRun('), source.indexOf('\nfunction safeGateway('))
  const observe = new Function('until', 'safeRun', 'safeCode', `${observationSource}; return observeTerminalRun`)(
    async (read, predicate, budget) => {
      assert.equal(budget, null)
      const value = await read()
      assert.equal(predicate(value), true)
      return value
    },
    run => ({ state: run.state, seq: run.seq }),
    error => error.code
  )
  const facts = {}
  assert.equal((await observe(async () => ({ state: 'timed_out', seq: 11 }), facts)).state, 'timed_out')
  assert.deepEqual(facts.observation, { status: 'terminal_observed', budget_ms: null, last_run_state: 'timed_out', last_run_seq: 11 })
})

test('safeRun preserves canonical recovery and typed diagnostics while excluding raw detail', () => {
  const run = {
    runId: 'run',
    state: 'recovery_required',
    seq: 12,
    attempts: [
      {
        diagnostics: {
          status: 'available',
          acceptance: { code: 'teamstage-provider-failed' },
          recovery: { code: 'team-effect-unknown', detail: 'private-recovery-detail' },
          rawProviderBody: 'private-provider-body'
        }
      }
    ],
    team: {
      state: 'recovery_required',
      recovery: { code: 'team-effect-unknown', detail: 'private-recovery-detail' },
      effects: [{ effectId: 'effect', kind: 'spawn', state: 'recovery_required', errorCode: 'private-provider-error', detail: 'private-effect-detail' }]
    }
  }
  const projected = safeRun(run)
  assert.deepEqual(projected.team.recovery, { code: 'team-effect-unknown' })
  assert.equal(projected.attempts[0].diagnostics.recovery.code, 'team-effect-unknown')
  assert.deepEqual(projected.team.effects, [{ effectId: 'effect', kind: 'spawn', state: 'recovery_required' }])
  assert.doesNotMatch(JSON.stringify(projected), /private-recovery-detail|private-provider-body|private-provider-error|private-effect-detail/)
  run.team.recovery.code = 'private-unknown-code'
  assert.equal(safeRun(run).team.recovery.code, 'unknown')
})

test('legacy Run projections omit unavailable optional observability facts', () => {
  const projected = safeRun({ team: { state: 'active' } })
  for (const field of ['execution', 'effects', 'runtime', 'recovery']) assert.equal(Object.hasOwn(projected.team, field), false)
})

test('safeRun retains independent recovery and abort facts and safe runtime activity counters', () => {
  const run = {
    team: {
      state: 'recovery_required',
      recovery: { code: 'team-effect-unknown', detail: 'private-provider-detail' },
      execution: {
        startedAt: 1000,
        deadlineAt: 21000,
        timeoutMs: 20000,
        abort: { source: 'deadline', code: 'teamstage-deadline-exceeded', occurredAt: 21001, reason: 'private-abort-reason' }
      },
      runtime: {
        attemptId: 'attempt',
        observedAt: 1200,
        members: [
          {
            memberId: 'member',
            sessionId: 'session',
            activity: 'thinking',
            updatedAt: 1199,
            requestOrdinal: 1,
            requestStartedAt: 1100,
            lastProgressAt: 1199,
            textDeltas: 0,
            reasoningDeltas: 2,
            toolCallDeltas: 0,
            reasoningText: 'private-reasoning-text'
          }
        ]
      },
      effects: [{ effectId: 'effect', kind: 'new-producer-kind', state: 'pending', providerBody: 'private-provider-body' }]
    }
  }
  const projected = safeRun(run)
  assert.equal(projected.team.recovery.code, 'team-effect-unknown')
  assert.deepEqual(projected.team.execution, {
    startedAt: 1000,
    deadlineAt: 21000,
    timeoutMs: 20000,
    abort: { source: 'deadline', code: 'teamstage-deadline-exceeded', occurredAt: 21001 }
  })
  assert.equal(projected.team.runtime.members[0].activity, 'thinking')
  assert.equal(projected.team.runtime.members[0].reasoningDeltas, 2)
  assert.deepEqual(projected.team.effects, [{ effectId: 'effect', kind: 'unknown', kindKnown: false, state: 'pending' }])
  assert.doesNotMatch(JSON.stringify(projected), /private-provider-detail|private-abort-reason|private-reasoning-text|private-provider-body|new-producer-kind/)
  run.team.execution.abort.source = 'private-source'
  run.team.execution.abort.code = 'private-code'
  run.team.runtime.members[0].activity = 'private-activity'
  const unknown = safeRun(run)
  assert.equal(unknown.team.execution.abort.source, 'unknown')
  assert.equal(unknown.team.execution.abort.code, 'unknown')
  assert.equal(unknown.team.runtime.members[0].activity, 'unknown')
})

test('provider abort observes typed caller cause without persisting signal raw reason', async () => {
  const observed = await observer()
  const controller = new AbortController()
  controller.abort({ kind: 'parent', reason: 'private-signal-reason' })
  for await (const _chunk of observed.handlers.get('llm/stream')({ sessionId: 'member', signal: controller.signal }, async function* () {
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'private-provider-message' } } }
  })) {
    /* consume */
  }
  const request = safeOperatorFacts(observed.snapshot()).sessions[0].requests[0]
  assert.equal(request.providerOutcome, 'aborted')
  assert.equal(request.abort_source, 'parent')
  assert.equal(request.error_source, 'provider_finish')
  assert.equal(request.error_code, 'ABORTED')
  assert.doesNotMatch(JSON.stringify(observed.snapshot()), /private-signal-reason|private-provider-message/)
})

test('old receipts keep optional timing unavailable while new projections retain counters', async () => {
  const historical = safeOperatorFacts({ sessions: [{ sessionId: 'old', requests: [{ ordinal: 1, finished: true, textDeltas: 0 }] }] })
  for (const key of ['startedAt', 'finishedAt', 'durationMs', 'reasoningDeltas', 'toolCallDeltas', 'providerOutcome', 'iterator_finalized']) {
    assert.equal(Object.hasOwn(historical.sessions[0].requests[0], key), false)
  }
  const observed = await observer()
  for await (const _chunk of observed.handlers.get('llm/stream')({ sessionId: 'member' }, async function* () {
    yield { type: 'reasoning-delta', text: 'private-reasoning' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })) {
    /* consume */
  }
  const projected = safeOperatorFacts(observed.snapshot()).sessions[0].requests[0]
  assert.equal(projected.reasoningDeltas, 1)
  assert.equal(projected.providerOutcome, 'succeeded')
  assert.ok(projected.finishedAt >= projected.startedAt)
  assert.equal(projected.iterator_finalized, true)
})

test('installed provider quota constants retain their public typed identity without exposing unknown codes', () => {
  for (const code of [QUOTA_EXCEEDED_CODE, ACCOUNT_QUOTA_EXCEEDED_CODE]) assert.equal(safeProviderErrorCode({ code }), code)
  assert.equal(safeProviderErrorCode({ code: 'PRIVATE_PROVIDER_BODY', message: 'private-provider-message' }), 'UNKNOWN')
  assert.equal(safeProviderErrorCode({ name: 'PRIVATE_ERROR_CLASS', message: 'private-provider-message' }), 'UNKNOWN')
})

test('current RunStore settlement and reviewed recovery codes survive safe diagnostics projection', () => {
  // run-store.ts emits recovery-required/cancelled and constructs reviewed-*
  // from the four supported reviewed settlement outcomes at its atomic update.
  const codes = ['recovery-required', 'cancelled', ...['succeeded', 'failed', 'cancelled', 'timed-out'].map(outcome => `reviewed-${outcome}`)]
  for (const code of codes) {
    const projected = safeRun({ attempts: [{ diagnostics: { status: 'available', acceptance: { code }, recovery: { code } } }] })
    assert.equal(projected.attempts[0].acceptance, code)
    assert.equal(projected.attempts[0].diagnostics.acceptance.code, code)
    assert.equal(projected.attempts[0].diagnostics.recovery.code, code)
  }
  const unknown = safeRun({
    attempts: [{ diagnostics: { status: 'available', acceptance: { code: 'private-code' }, recovery: { code: 'private-code', detail: 'private-body' } } }]
  })
  assert.equal(unknown.attempts[0].diagnostics.acceptance.code, 'unknown')
  assert.equal(unknown.attempts[0].diagnostics.recovery.code, 'unknown')
  assert.doesNotMatch(JSON.stringify(unknown), /private-code|private-body/)
})
