import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as pause } from 'node:timers/promises'
import * as yaml from 'js-yaml'
import { fileURLToPath } from 'node:url'
import { ROOT, sha256 } from './conversation-evidence.mjs'
import { prepareProfile, bootHost, stopHost } from './conversation-runtime.mjs'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
import { parseTeamStageCollectorConfiguration } from './teamstage-live.mjs'

const PACKAGE = '@xuanling-rs/xuanling-dsh-blueprint'
const TEAM_PROFILE = '@deepseek-ai/dsh-experimental-agent-team-profile'
const REPORT_ENV = 'BP_LIVE_TEAM_REPORT_DIR'
const BLUEPRINT_ID = 'live-teamstage'
const LEAD_SESSION = 'live-teamstage-lead'
const VALUE = Object.freeze({ result: 'live-teamstage', verified: true })

function fail(code) {
  throw Object.assign(new Error(code), { code })
}

function safeCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)
    ? error.code
    : error?.name === 'AssertionError'
      ? 'ASSERTION_FAILED'
      : 'LIVE_TEAMSTAGE_FAILED'
}

function safeReadJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function extractProviderKey(path, provider) {
  let document
  try {
    if (!path || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail('LIVE_TEAM_KEY_FILE_INVALID')
    document = yaml.load(readFileSync(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'LIVE_TEAM_KEY_FILE_INVALID') throw error
    fail('LIVE_TEAM_KEY_FILE_INVALID')
  }
  const entry = Object.entries(document ?? {}).find(([name]) => name.toLowerCase() === provider.toLowerCase())?.[1]
  const key = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.key : undefined
  if (typeof key !== 'string' || key.trim() !== key || key.length === 0 || key.includes('\u0000') || key.includes('\r') || key.includes('\n')) {
    fail('LIVE_TEAM_KEY_FILE_INVALID')
  }
  return key
}

function safeRun(run) {
  const enumeration = (value, values) => (values.includes(value) ? value : 'unknown')
  const timestamp = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)
  const projectCode = value =>
    enumeration(value, [
      'accepted',
      'rejected',
      'not-required',
      'teamstage-provider-failed',
      'team-effect-unknown',
      'effect-unknown',
      'member-binding-unknown',
      'task-replay-unknown',
      'task-binding-unknown',
      'task-revision-unknown',
      'recovery-required',
      'cancelled',
      'reviewed-succeeded',
      'reviewed-failed',
      'reviewed-cancelled',
      'reviewed-timed-out',
      'teamstage-identity-unavailable',
      'teamstage-cancellation-failed',
      'teamstage-deadline-exceeded',
      'teamstage-cancelled',
      'teamstage-team-effect-unknown',
      'teamstage-not-dispatching',
      'teamstage-aborted'
    ])
  const diagnostics = value =>
    value?.status === 'available'
      ? {
          status: 'available',
          acceptance: {
            code: projectCode(value.acceptance?.code),
            ...(Number.isInteger(value.acceptance?.issueCount) ? { issueCount: value.acceptance.issueCount } : {})
          },
          ...(value.recovery === undefined ? {} : { recovery: { code: projectCode(value.recovery.code) } })
        }
      : { status: value?.status === 'unavailable' ? 'unavailable' : 'unknown' }
  const attempts = (run?.attempts ?? []).map(attempt => ({
    attemptId: attempt.attemptId ?? null,
    nodeId: attempt.nodeId ?? null,
    state: attempt.state ?? 'unknown',
    resultKind: attempt.resultKind ?? null,
    sessionId: attempt.sessionId ?? null,
    acceptance: attempt.diagnostics?.acceptance?.code === undefined ? null : projectCode(attempt.diagnostics.acceptance.code),
    ...(attempt.diagnostics === undefined ? {} : { diagnostics: diagnostics(attempt.diagnostics) })
  }))
  const team = run?.team
  return {
    runId: run?.runId ?? null,
    state: run?.state ?? 'unknown',
    seq: Number.isInteger(run?.seq) ? run.seq : null,
    definitionRevision: run?.definitionRevision ?? null,
    attempts,
    team:
      team === undefined
        ? null
        : {
            state: team.state ?? 'unknown',
            stageId: team.stageId ?? null,
            attemptId: team.attemptId ?? null,
            teamId: team.teamId ?? null,
            taskId: team.taskId ?? null,
            taskRevision: team.taskRevision ?? null,
            ...(team.recovery === undefined ? {} : { recovery: { code: projectCode(team.recovery.code) } }),
            ...(team.execution === undefined
              ? {}
              : {
                  execution: {
                    startedAt: timestamp(team.execution.startedAt),
                    ...(team.execution.deadlineAt === undefined ? {} : { deadlineAt: timestamp(team.execution.deadlineAt) }),
                    ...(team.execution.timeoutMs === undefined ? {} : { timeoutMs: timestamp(team.execution.timeoutMs) }),
                    ...(team.execution.abort === undefined
                      ? {}
                      : {
                          abort: {
                            source: enumeration(team.execution.abort.source, ['deadline', 'caller', 'stage_control']),
                            code: projectCode(team.execution.abort.code),
                            occurredAt: timestamp(team.execution.abort.occurredAt)
                          }
                        })
                  }
                }),
            ...(team.effects === undefined
              ? {}
              : {
                  effects: Array.isArray(team.effects)
                    ? team.effects.map(effect => ({
                        effectId: typeof effect.effectId === 'string' ? effect.effectId : null,
                        kind: enumeration(effect.kind, ['create', 'spawn', 'task-update', 'message', 'update', 'drain', 'task-delete']),
                        ...(['create', 'spawn', 'task-update', 'message', 'update', 'drain', 'task-delete'].includes(effect.kind) ? {} : { kindKnown: false }),
                        state: enumeration(effect.state, ['pending', 'succeeded', 'failed', 'recovery_required'])
                      }))
                    : 'unknown'
                }),
            ...(team.runtime === undefined
              ? {}
              : {
                  runtime: {
                    attemptId: typeof team.runtime.attemptId === 'string' ? team.runtime.attemptId : null,
                    observedAt: timestamp(team.runtime.observedAt),
                    members: Array.isArray(team.runtime.members)
                      ? team.runtime.members.map(member => ({
                          memberId: typeof member.memberId === 'string' ? member.memberId : null,
                          sessionId: typeof member.sessionId === 'string' ? member.sessionId : null,
                          activity: enumeration(member.activity, ['waiting_model', 'thinking', 'responding', 'tool_call', 'executing_tool', 'idle']),
                          updatedAt: timestamp(member.updatedAt),
                          requestOrdinal: timestamp(member.requestOrdinal),
                          textDeltas: timestamp(member.textDeltas),
                          reasoningDeltas: timestamp(member.reasoningDeltas),
                          toolCallDeltas: timestamp(member.toolCallDeltas),
                          ...(member.requestStartedAt === undefined ? {} : { requestStartedAt: timestamp(member.requestStartedAt) }),
                          ...(member.lastProgressAt === undefined ? {} : { lastProgressAt: timestamp(member.lastProgressAt) })
                        }))
                      : 'unknown'
                  }
                }),
            members: (team.members ?? []).map(member => ({
              memberId: member.memberId ?? null,
              name: member.name ?? null,
              logicalName: member.logicalName ?? null,
              sessionId: member.sessionId ?? null,
              phase: member.phase ?? null,
              status: member.status ?? null
            })),
            outputAcceptance:
              team.outputAcceptance === undefined
                ? null
                : {
                    code: enumeration(team.outputAcceptance.code, ['accepted', 'rejected']),
                    artifactId: team.outputAcceptance.artifactId ?? null,
                    sourceSessionId: team.outputAcceptance.sourceSessionId ?? null,
                    digest: team.outputAcceptance.digest ?? null,
                    evidenceDigest: team.outputAcceptance.evidenceDigest ?? null,
                    checks: Array.isArray(team.outputAcceptance.checks)
                      ? team.outputAcceptance.checks.map(check => enumeration(check, ['schema', 'digest', 'artifact-digest', 'agreement']))
                      : []
                  }
          }
  }
}

function safeOperatorFacts(value) {
  if (!value || typeof value !== 'object')
    return {
      available: false,
      sessions: [],
      events: [],
      provider_calls: 0,
      failed_provider_calls: 0,
      tool_names: [],
      approval_events: 0
    }
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.map(session => ({
        sessionId: typeof session.sessionId === 'string' ? session.sessionId : null,
        status: typeof session.status === 'string' ? session.status : null,
        ...(Object.hasOwn(session, 'start_source')
          ? {
              start_source: ['startup', 'resume', 'clear', 'compact'].includes(session.start_source) ? session.start_source : 'unknown'
            }
          : {}),
        requests: Array.isArray(session.requests)
          ? session.requests.map(request => ({
              ordinal: request.ordinal ?? null,
              provider: request.provider ?? null,
              model: request.model ?? null,
              ...(Array.isArray(request.tool_names) ? { tool_names: request.tool_names.filter(name => typeof name === 'string') } : {}),
              failed: request.failed === true,
              finished: request.finished === true,
              textDeltas: request.textDeltas ?? 0,
              error_code: safeRecordedErrorCode(request.error_code),
              finish_kind: ['stop', 'tool-calls', 'max-tokens', 'error', 'aborted', 'unknown'].includes(request.finish_kind) ? request.finish_kind : null,
              ...Object.fromEntries(
                ['startedAt', 'finishedAt', 'durationMs', 'firstProgressAt', 'lastProgressAt', 'reasoningDeltas', 'toolCallDeltas']
                  .filter(key => typeof request[key] === 'number' && Number.isFinite(request[key]) && request[key] >= 0)
                  .map(key => [key, request[key]])
              ),
              ...(Object.hasOwn(request, 'iterator_finalized') ? { iterator_finalized: request.iterator_finalized === true } : {}),
              ...(Object.hasOwn(request, 'providerOutcome')
                ? {
                    providerOutcome: ['succeeded', 'failed', 'aborted'].includes(request.providerOutcome) ? request.providerOutcome : 'unknown'
                  }
                : {}),
              ...(request.abort_source === undefined
                ? {}
                : {
                    abort_source: ['user', 'parent', 'hook', 'disposed', 'legacy'].includes(request.abort_source) ? request.abort_source : 'unknown'
                  }),
              ...(request.error_source === undefined
                ? {}
                : {
                    error_source: ['provider_finish', 'iterator_throw', 'caller_signal'].includes(request.error_source) ? request.error_source : 'unknown'
                  })
            }))
          : [],
        tools: Array.isArray(session.tools) ? session.tools : [],
        terminals: Array.isArray(session.terminals)
          ? session.terminals.map(terminal => ({
              turn: terminal.turn ?? null,
              kind: typeof terminal.kind === 'string' ? terminal.kind : null,
              error_code: safeRecordedErrorCode(terminal.error_code),
              ...(terminal.abort_source === undefined
                ? {}
                : {
                    abort_source: ['user', 'parent', 'hook', 'disposed', 'legacy'].includes(terminal.abort_source) ? terminal.abort_source : 'unknown'
                  }),
              seq: terminal.seq ?? null
            }))
          : []
      }))
    : []
  const events = Array.isArray(value.events) ? value.events : []
  return {
    available: true,
    instance_pid: Number.isInteger(value.instance_pid) && value.instance_pid > 0 ? value.instance_pid : null,
    operator_ready: value.operator_ready === true,
    observation_only: value.observation_only === true,
    sessions,
    events,
    stream_requests: sessions.flatMap(session => session.requests),
    provider_calls: sessions.reduce((sum, session) => sum + session.requests.length, 0),
    failed_provider_calls: sessions.reduce((sum, session) => sum + session.requests.filter(request => request.failed).length, 0),
    tool_names: [...new Set(sessions.flatMap(session => session.tools.map(tool => tool.name)).filter(Boolean))].sort(),
    approval_events: events.filter(event => String(event.type).startsWith('approval/')).length
  }
}

function safeProviderErrorCode(value) {
  // Public DSH LlmFailure codes used by installed adapters/runtime. An unknown
  // extension remains explicit; arbitrary code/name/message bytes are unsafe.
  return [
    'AUTH',
    'RATE_LIMIT',
    'INVALID_REQUEST',
    'SERVER',
    'TIMEOUT',
    'TRANSPORT',
    'PI_AI_ERROR',
    'STREAM_CLOSED',
    'ABORTED',
    'UNKNOWN',
    'EMPTY_RESPONSE',
    'CONTEXT_WINDOW_EXCEEDED',
    'QUOTA',
    'ACCOUNT_QUOTA',
    'QUOTA_EXCEEDED',
    'ACCOUNT_QUOTA_EXCEEDED',
    'INVALID_CREDENTIAL',
    'LLM_STREAM_IDLE_TIMEOUT'
  ].includes(value?.code)
    ? value.code
    : 'UNKNOWN'
}

function safeRecordedErrorCode(value) {
  return value === null || value === undefined ? null : safeProviderErrorCode(typeof value === 'string' ? { code: value } : value)
}

function validateMemberLineage(run, operator, config, artifactAudit) {
  const member = run.team?.members?.[0]
  const session = operator.sessions.find(item => item.sessionId === member?.sessionId)
  if (
    !session ||
    !session.requests.length ||
    session.requests.some(
      request =>
        request.failed ||
        !request.finished ||
        (request.providerOutcome !== undefined && request.providerOutcome !== 'succeeded') ||
        request.provider !== 'blueprint-live' ||
        request.model !== config.model
    ) ||
    session.terminals.some(terminal => ['error', 'aborted'].includes(terminal.kind))
  )
    fail('LIVE_TEAM_MEMBER_PROVIDER_EVIDENCE_INVALID')
  if (member.status !== 'inactive' || !['idle', 'disposed'].includes(session.status)) fail('LIVE_TEAM_MEMBER_NOT_QUIESCENT')
  const artifact = artifactAudit?.items?.find(item => item.producerMemberId === member.memberId && item.producerSessionId === member.sessionId)
  const completedTurn = session.terminals.find(
    terminal => terminal.kind === 'completed' && `${session.sessionId}:${terminal.turn}` === artifact?.turnId && terminal.seq === artifact?.endLogSeq
  )
  if (
    !artifact ||
    artifact.turnId !== artifact.completedTurnId ||
    !completedTurn ||
    !(artifact.startLogSeq < artifact.captureLogSeq && artifact.captureLogSeq < artifact.endLogSeq)
  )
    fail('LIVE_TEAM_COMPLETED_CAPTURE_MISSING')
  const completed = operator.events.findLast(
    event =>
      event.type === 'team/task' &&
      event.sessionId === LEAD_SESSION &&
      event.teamId === run.team.teamId &&
      event.taskId === run.team.taskId &&
      event.status === 'completed' &&
      event.ownerId === member.sessionId &&
      Number.isInteger(event.revision)
  )
  if (!completed) fail('LIVE_TEAM_NATIVE_TASK_NOT_COMPLETED')
  const successfulCall = tool =>
    session.tools.some(
      result => result.direction === 'result' && result.callId === tool.callId && result.name === tool.name && result.isError === false && result.seq > tool.seq
    )
  const calls = session.tools.filter(
    tool =>
      tool.direction === 'call' &&
      successfulCall(tool) &&
      (tool.surface !== 'ptc' ||
        session.tools.some(
          root => root.direction === 'call' && root.name === 'run_code' && root.callId === tool.rootCallId && root.turn === tool.turn && successfulCall(root)
        ))
  )
  const list = calls.find(call => call.name === 'team_task_list')
  const claim = calls.find(call => call.name === 'team_task_update' && call.action === 'claim' && call.taskId === run.team.taskId)
  const complete = calls.find(call => call.name === 'team_task_update' && call.action === 'complete' && call.taskId === run.team.taskId)
  const structured = calls.find(call => call.name === 'structured_output' && call.callId === artifact.callId)
  const captureRoot = calls.find(call => call.callId === artifact.rootCallId && (call.name === 'structured_output' || call.name === 'run_code'))
  const captureResult = session.tools.find(
    result => result.direction === 'result' && result.callId === artifact.rootCallId && result.seq === artifact.captureLogSeq && result.isError === false
  )
  if (
    !list ||
    !claim ||
    !complete ||
    !structured ||
    !(list.seq < claim.seq && claim.seq < complete.seq && complete.seq < structured.seq) ||
    !Number.isInteger(claim.expectedRevision) ||
    !Number.isInteger(complete.expectedRevision) ||
    complete.expectedRevision <= claim.expectedRevision ||
    completed.revision !== complete.expectedRevision + 1 ||
    !captureRoot ||
    !captureResult ||
    structured.turn !== completedTurn.turn ||
    captureRoot.turn !== completedTurn.turn ||
    (structured.rootCallId ?? structured.callId) !== artifact.rootCallId
  )
    fail('LIVE_TEAM_MEMBER_TOOL_LINEAGE_INVALID')
  return {
    status: 'passed',
    source_session_id: member.sessionId,
    task_id: completed.taskId,
    task_revision: completed.revision,
    task_owner_id: completed.ownerId,
    ordered_successful_calls: [list, claim, complete, structured].map(call => ({
      name: call.name,
      call_id: call.callId,
      seq: call.seq
    }))
  }
}

function artifactAudit(root, run) {
  const artifactRoot = join(root, 'runtime/store/team-output-artifacts')
  if (!existsSync(artifactRoot)) fail('LIVE_TEAM_ARTIFACT_ROOT_MISSING')
  if (lstatSync(artifactRoot).isSymbolicLink()) fail('LIVE_TEAM_ARTIFACT_ROOT_SYMLINK')
  const directories = readdirSync(artifactRoot)
    .filter(name => !name.startsWith('.tmp-'))
    .sort()
  assert.equal(directories.length, 1)
  const items = directories.map(directory => {
    const path = join(artifactRoot, directory)
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('LIVE_TEAM_ARTIFACT_DIRECTORY_INVALID')
    const valuePath = join(path, 'value.json'),
      provenancePath = join(path, 'provenance.json')
    for (const file of [valuePath, provenancePath]) {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('LIVE_TEAM_ARTIFACT_FILE_INVALID')
    }
    const valueBytes = readFileSync(valuePath),
      provenanceBytes = readFileSync(provenancePath)
    let value, provenance
    try {
      value = JSON.parse(valueBytes)
      provenance = JSON.parse(provenanceBytes)
    } catch {
      fail('LIVE_TEAM_ARTIFACT_JSON_INVALID')
    }
    assert.equal(valueBytes.toString(), canonical(value))
    assert.equal(provenanceBytes.toString(), canonical(provenance))
    assert.deepEqual(value, VALUE)
    assert.match(provenance.artifactId, /^ta-[a-f0-9-]{36}$/)
    assert.equal(directory, sha256(provenance.artifactId))
    assert.equal(provenance.byteLength, valueBytes.length)
    assert.equal(provenance.digest, sha256(valueBytes))
    const { evidenceDigest, ...rest } = provenance
    assert.equal(evidenceDigest, sha256(canonical(rest)))
    assert.equal(provenance.runId, run.runId)
    assert.equal(provenance.definitionRevision, run.definitionRevision)
    assert.equal(provenance.nodeId, 'work')
    assert.equal(provenance.stageId, run.team.stageId)
    assert.equal(provenance.attemptId, run.team.attemptId)
    assert.equal(provenance.taskId, run.team.taskId)
    assert.equal(provenance.teamId, run.team.teamId)
    const member = run.team.members.find(item => item.memberId === provenance.producerMemberId)
    assert.ok(member)
    assert.equal(member.sessionId, provenance.evidence.producerSessionId)
    assert.equal(member.name, provenance.nativeName)
    assert.equal(member.phase, 'active')
    assert.equal(member.status, 'inactive')
    assert.equal(provenance.schemaResourceId, 'schema')
    assert.equal(provenance.schemaResourceDigest, sha256(readFileSync(join(root, 'definition/lib/output.schema.json'))))
    assert.equal(provenance.schemaDigest, sha256(canonical(JSON.parse(readFileSync(join(root, 'definition/lib/output.schema.json'), 'utf8')))))
    assert.equal(provenance.resourceDigests.schema, provenance.schemaResourceDigest)
    assert.equal(provenance.resourceDigests[provenance.logicalName], sha256(readFileSync(join(root, `definition/lib/${provenance.logicalName}.md`))))
    assert.equal(provenance.evidence.turnId, provenance.evidence.completedTurnId)
    assert.ok(provenance.evidence.startLogSeq < provenance.evidence.captureLogSeq)
    assert.ok(provenance.evidence.captureLogSeq < provenance.evidence.endLogSeq)
    return {
      artifactId: provenance.artifactId,
      producerMemberId: provenance.producerMemberId,
      producerSessionId: provenance.evidence.producerSessionId,
      logicalName: provenance.logicalName,
      digest: provenance.digest,
      byteLength: valueBytes.length,
      evidenceDigest,
      callId: provenance.evidence.callId,
      rootCallId: provenance.evidence.rootCallId,
      turnId: provenance.evidence.turnId,
      completedTurnId: provenance.evidence.completedTurnId,
      startLogSeq: provenance.evidence.startLogSeq,
      captureLogSeq: provenance.evidence.captureLogSeq,
      endLogSeq: provenance.evidence.endLogSeq
    }
  })
  assert.equal(run.team.outputAcceptance.artifactId, items[0].artifactId)
  assert.equal(run.team.outputAcceptance.digest, items[0].digest)
  assert.equal(run.team.outputAcceptance.sourceSessionId, items[0].producerSessionId)
  return { status: 'passed', independent_physical_bytes: true, canonical_provenance: true, items }
}

async function until(read, predicate, timeout = 30_000) {
  const deadline = timeout === null ? Infinity : Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (predicate(value)) return value
    await pause(80)
  }
  fail('LIVE_TEAM_OBSERVATION_TIMEOUT')
}

async function observeTerminalRun(read, facts, onSnapshot) {
  // Native provider/tool policies settle execution. Live observation has no
  // independent total deadline that could dispose a healthy slow member.
  const budget = null
  const summary = status => ({
    status,
    budget_ms: budget,
    last_run_state: facts.run?.state ?? 'unknown',
    last_run_seq: facts.run?.seq ?? null
  })
  facts.observation = summary('observing')
  try {
    const run = await until(
      async () => {
        const snapshot = await read()
        facts.run = safeRun(snapshot)
        onSnapshot?.(facts.run)
        return snapshot
      },
      value => ['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(value?.state),
      budget
    )
    facts.observation = summary('terminal_observed')
    return run
  } catch (error) {
    facts.observation = {
      ...summary(error?.code === 'LIVE_TEAM_OBSERVATION_TIMEOUT' ? 'timed_out' : 'failed'),
      code: safeCode(error)
    }
    throw error
  }
}

function safeGateway(authUrl, rpc, instance) {
  const url = new URL(authUrl)
  let cookie = ''
  return {
    async authenticate() {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000)
      })
      cookie = (response.headers.getSetCookie?.() ?? []).map(value => value.split(';')[0]).join('; ')
      if (!cookie || ![302, 303].includes(response.status)) fail('HOST_AUTH_FAILED')
    },
    async call(method, args) {
      const rpcId = randomUUID()
      const response = await fetch(new URL(`/api/${method}`, url.origin), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
      })
      const body = await response.json()
      const result = body?.result
      const errorCode = typeof result?.error?.code === 'string' && /^[a-z0-9/_-]+$/.test(result.error.code) ? result.error.code : null
      rpc.push({
        method,
        rpcId,
        at: new Date().toISOString(),
        status: response.status,
        ok: result?.ok === true,
        hostInstance: instance,
        provenance: 'real public DSH gateway',
        responseRpcId: body?.rpcId === rpcId ? rpcId : null,
        error_code: errorCode
      })
      if (response.status !== 200 || body?.type !== 'server-response' || body.rpcId !== rpcId || result?.ok !== true) fail('HOST_GATEWAY_RPC_FAILED')
      return result.value
    }
  }
}

function operatorSource(paths, config) {
  return `
import { writeFileSync, renameSync } from 'node:fs'
export const inject = ['agents', 'agentTeams', 'llm'${config.leadAgentPreset ? ", 'agentPresets', 'tools'" : ''}]
export async function apply(ctx) {
const state = new Map()
let operatorReady = false
const observationOnly = process.env.XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY === '1'
const events = []
const path = ${JSON.stringify(paths.operatorFacts)}
const text = value => typeof value === 'string' ? value : value === undefined ? null : String(value)
const errorCode = ${safeProviderErrorCode.toString()}
const abortSource = value => ['user', 'parent', 'hook', 'disposed', 'legacy'].includes(value?.kind) ? value.kind : 'unknown'
const row = id => {
  let value = state.get(id)
  if (!value) { value = { sessionId: id, status: null, requests: [], tools: [], terminals: [] }; state.set(id, value) }
  return value
}
const toolName = value => ['run_code', 'team_task_list', 'team_task_get', 'team_task_update', 'send_message', 'list_agents', 'wait_agent', 'structured_output', 'write'].includes(value) ? value : 'other'
const taskArgs = (name, args) => name === 'team_task_update' ? { action: ['claim', 'complete'].includes(args?.action) ? args.action : 'other',
  taskId: text(args?.task_id), expectedRevision: Number.isInteger(args?.expected_revision) ? args.expected_revision : null } : {}
const publish = () => {
  const facts = { schema_version: 1, instance_pid: process.pid, operator_ready: operatorReady, observation_only: observationOnly,
    sessions: [...state.values()], events: events.slice(-200) }
  writeFileSync(path + '.next', JSON.stringify(facts), { mode: 0o600 })
  renameSync(path + '.next', path)
}
ctx.on('agent/created', ({ agent, source }) => {
  const item = row(agent.id)
  item.status = agent.status
  item.start_source = ['startup', 'resume', 'clear', 'compact'].includes(source) ? source : 'unknown'
  publish()
})
ctx.on('agent/status', ({ agent, status }) => { row(agent.id).status = status; publish() })
ctx.on('agent/disposed', ({ agent }) => { row(agent.id).status = 'disposed'; publish() })
ctx.on('agent/error', ({ agent, error }) => { events.push({ sessionId: agent.id, type: 'agent/error', code: errorCode(error) }); publish() })
ctx.on('session/event', (session, event) => {
  const item = row(session.id)
  if (event.type === 'request/context') {
    item.provider = text(event.data.provider)
    item.model = text(event.data.model)
  }
  if (event.type === 'tool/call') {
    let args
    try { args = JSON.parse(event.data.arguments) } catch { /* malformed arguments confer no task authority */ }
    item.tools.push({ direction: 'call', name: toolName(event.data.name), callId: text(event.data.callId), turn: event.data.turn, seq: event.seq,
      ...taskArgs(event.data.name, args) })
  }
  if (event.type === 'tool/result') {
    const message = event.data.message
    const callId = text(message?.toolCallId)
    const prior = message?.role === 'tool' && message.source?.kind === 'tool' && message.source.callId === callId
      ? item.tools.findLast(tool => tool.direction === 'call' && tool.callId === callId) : undefined
    item.tools.push({ direction: 'result', name: prior?.name ?? 'other', callId, isError: prior === undefined || message?.isError === true, seq: event.seq })
  }
  if (event.type === 'tool/ptc-dispatch-start') {
    const root = item.tools.findLast(tool => tool.direction === 'call' && tool.name === 'run_code' && tool.callId === event.data.rootCallId)
    item.tools.push({ direction: 'call', name: toolName(event.data.name),
      callId: text(event.data.subCallId), rootCallId: text(event.data.rootCallId), parentCallId: text(event.data.parentCallId),
      seq: event.seq, turn: root?.turn ?? null, surface: 'ptc', ...taskArgs(event.data.name, event.data.arguments) })
  }
  if (event.type === 'tool/ptc-dispatch') {
    const prior = item.tools.findLast(tool => tool.direction === 'call' && tool.surface === 'ptc' && tool.callId === event.data.subCallId
      && tool.rootCallId === event.data.rootCallId && tool.parentCallId === event.data.parentCallId && tool.name === toolName(event.data.name))
    item.tools.push({ direction: 'result', name: prior?.name ?? 'other', callId: text(event.data.subCallId),
      rootCallId: text(event.data.rootCallId), parentCallId: text(event.data.parentCallId),
      isError: prior === undefined || event.data.isError !== false, seq: event.seq, surface: 'ptc' })
  }
  if (event.type === 'turn/end') item.terminals.push({ turn: event.data.turn, kind: text(event.data.reason?.kind),
    error_code: event.data.reason?.error === undefined ? null : errorCode(event.data.reason.error), seq: event.seq,
    ...(event.data.reason?.kind === 'aborted' ? { abort_source: abortSource(event.data.reason.reason) } : {}) })
  if (event.type === 'team/member') events.push({ sessionId: session.id, type: event.type, seq: event.seq })
  if (event.type === 'team/task') events.push({ sessionId: session.id, type: event.type, seq: event.seq,
    teamId: text(event.data.teamId), taskId: text(event.data.task?.id), revision: event.data.task?.revision ?? null,
    status: text(event.data.task?.status), ownerId: text(event.data.task?.ownerId) })
  publish()
})
ctx.on('llm/stream', async function* (options, next) {
  const item = row(text(options.sessionId))
  const started = performance.now()
  const request = { ordinal: item.requests.length + 1, provider: text(options.provider), model: text(options.model), failed: false, finished: false,
    tool_names: (options.tools ?? []).map(tool => tool.name),
    startedAt: Date.now(), textDeltas: 0, reasoningDeltas: 0, toolCallDeltas: 0, iterator_finalized: false, finish_kind: null, providerOutcome: 'unknown' }
  item.requests.push(request); publish()
  try {
    for await (const chunk of next()) {
      let progress = false
      if (chunk.type === 'text-delta' && chunk.text) { request.textDeltas++; progress = true }
      if (chunk.type === 'reasoning-delta' && chunk.text) { request.reasoningDeltas++; progress = true }
      if (chunk.type === 'tool-call-delta' && (chunk.argumentsDelta || chunk.name)) { request.toolCallDeltas++; progress = true }
      if (progress) { request.firstProgressAt ??= Date.now(); request.lastProgressAt = Date.now(); publish() }
      if (chunk.type === 'finish') {
        request.finish_kind = ['stop', 'tool-calls', 'max-tokens', 'error', 'aborted'].includes(chunk.reason?.kind) ? chunk.reason.kind : 'unknown'
        request.providerOutcome = ['stop', 'tool-calls', 'max-tokens'].includes(request.finish_kind) ? 'succeeded'
          : request.finish_kind === 'aborted' ? 'aborted' : request.finish_kind === 'error' ? 'failed' : 'unknown'
        if (['error', 'aborted'].includes(chunk.reason?.kind)) {
          request.failed = true
          request.error_code = errorCode(chunk.reason?.failure)
          request.error_source = 'provider_finish'
          if (chunk.reason.kind === 'aborted') request.abort_source = options.signal?.aborted ? abortSource(options.signal.reason) : 'unknown'
        }
        publish()
      }
      yield chunk
    }
  } catch (error) {
    request.failed = true
    request.error_code = errorCode(error)
    request.providerOutcome = options.signal?.aborted ? 'aborted' : 'failed'
    request.error_source = options.signal?.aborted ? 'caller_signal' : 'iterator_throw'
    if (options.signal?.aborted) request.abort_source = abortSource(options.signal.reason)
    publish()
    throw error
  } finally {
    request.finished = true
    request.iterator_finalized = true
    request.finishedAt = Date.now()
    request.durationMs = Math.max(0, performance.now() - started)
    publish()
  }
})
publish()
let readySessionId = ${JSON.stringify(LEAD_SESSION)}
let leadToolNames
if (!observationOnly) {
  const handle = await ctx.agents.create({ sessionId: readySessionId, meta: { cwd: process.cwd()${config.leadAgentPreset ? `, agentPreset: ${JSON.stringify(config.leadAgentPreset)}` : ''} },
    ${config.leadAgentPreset ? `setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, ${JSON.stringify(config.leadAgentPreset)}) },` : ''}
    agentOptions: { provider: 'blueprint-live', model: ${JSON.stringify(config.model)} } })
  readySessionId = handle.agent.id
  ${config.leadAgentPreset ? 'leadToolNames = ctx.tools.schemas(handle.agent).map(tool => tool.name).sort()' : ''}
  ctx.effect(() => () => handle.dispose())
}
operatorReady = true
writeFileSync(${JSON.stringify(paths.ready)}, JSON.stringify({ sessionId: readySessionId, instance_pid: process.pid,
  ${config.leadAgentPreset ? `lead_preset: ${JSON.stringify(config.leadAgentPreset)}, lead_tool_names: leadToolNames,` : ''}
  operator_ready: operatorReady, observation_only: observationOnly }), { mode: 0o600 })
publish()
}
`
}

function fixture(root, paths, config) {
  const definitionRoot = join(root, '.xuanling', 'workflows', BLUEPRINT_ID)
  mkdirSync(join(definitionRoot, 'lib'), { recursive: true, mode: 0o700 })
  const definition = {
    schemaVersion: 2,
    id: BLUEPRINT_ID,
    name: 'Live TeamStage acceptance graph',
    resources: {
      stage: { kind: 'agent', path: 'lib/stage.md' },
      primary: { kind: 'agent', path: 'lib/primary.md' },
      schema: { kind: 'schema', path: 'lib/output.schema.json' }
    },
    graph: {
      nodes: [
        { id: 'input', kind: 'input', outputs: { request: 'string' } },
        {
          id: 'work',
          kind: 'agentTask',
          inputs: { request: 'string' },
          outputs: { result: 'json' },
          agentRef: 'stage',
          outputSchemaRef: 'schema',
          teamStage: {
            task: {
              subject: 'Live TeamStage acceptance task',
              description: 'Claim and complete this exact frozen task, then publish the agreed structured value.'
            },
            members: [
              {
                name: 'primary',
                description: 'Live primary TeamStage producer',
                agentRef: 'primary',
                context: 'fresh'
              }
            ],
            requiredChecks: ['schema', 'digest', 'artifact-digest', 'agreement']
          }
        },
        { id: 'output', kind: 'output', inputs: { result: 'json' }, outputs: { result: 'json' } }
      ],
      edges: [
        { kind: 'data', from: 'input.request', to: 'work.request' },
        { kind: 'data', from: 'work.result', to: 'output.result' }
      ]
    }
  }
  writeFileSync(join(definitionRoot, 'blueprint.json'), JSON.stringify(definition), {
    mode: 0o600
  })
  writeFileSync(
    join(definitionRoot, 'lib/stage.md'),
    'Drive the native TeamStage task to a durable, schema-valid result. The member must use native Team tools and structured_output.\n',
    { mode: 0o600 }
  )
  writeFileSync(
    join(definitionRoot, 'lib/primary.md'),
    [
      'You are the only primary member in a live TeamStage acceptance run.',
      'Use the native Team tools in this exact order: team_task_list, team_task_update action claim, team_task_update action complete, then structured_output.',
      'Use the exact task id and current revision returned by the previous tool. Do not answer with prose and do not put JSON in ordinary text.',
      'The final structured_output value must be exactly {"result":"live-teamstage","verified":true}.'
    ].join('\n') + '\n',
    { mode: 0o600 }
  )
  writeFileSync(
    join(definitionRoot, 'lib/output.schema.json'),
    JSON.stringify({
      type: 'object',
      properties: { result: { type: 'string' }, verified: { type: 'boolean' } },
      required: ['result', 'verified'],
      additionalProperties: false
    }),
    { mode: 0o600 }
  )
  const operatorPath = join(root, 'live-teamstage-operator.mjs')
  writeFileSync(operatorPath, operatorSource(paths, config), { mode: 0o600 })
  return { workspaceRoot: root, runtimeRoot: join(root, '.xuanling'), operatorModules: [operatorPath] }
}

function validateReportDir(path) {
  if (typeof path !== 'string' || !path.startsWith(ROOT + '/')) fail('LIVE_TEAM_REPORT_DIR_INVALID')
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) fail('LIVE_TEAM_REPORT_DIR_INVALID')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (!lstatSync(path).isDirectory()) fail('LIVE_TEAM_REPORT_DIR_INVALID')
  return path
}

// Importing the public observer/fixture helpers performs no credential read,
// model dispatch, host boot or CLI configuration parsing.
const main = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
const config = main
  ? (() => {
      try {
        return parseTeamStageCollectorConfiguration(process.argv.slice(2), process.env)
      } catch (error) {
        console.log(
          JSON.stringify({
            status: 'not_run',
            failure: safeCode(error),
            key_read: false,
            provider_calls: 0
          })
        )
        process.exitCode = 1
        return undefined
      }
    })()
  : undefined

export {
  fixture as prepareLiveTeamFixture,
  safeGateway,
  safeOperatorFacts,
  safeReadJson,
  extractProviderKey,
  artifactAudit,
  validateMemberLineage,
  safeCode,
  safeRun
}

if (config?.mode === 'live') {
  const report = validateReportDir(process.env[REPORT_ENV])
  const startedAt = new Date().toISOString()
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'blueprint-live-teamstage-'))
  const paths = {
    ready: join(root, 'lead-ready.json'),
    operatorFacts: join(root, 'operator-facts.json')
  }
  const facts = {
    schema_version: 1,
    plan_id: 'dsh-blueprint-teamstage-v1',
    work_package: 'W2.live-teamstage-real',
    mode: 'live-provider-teamstage',
    status: 'failed',
    started_at: startedAt,
    provider: {
      name: config.provider,
      model: config.model,
      protocol: config.protocol,
      base_url: config.baseUrl
    },
    profile: {
      isolated: true,
      install_mode: 'linked',
      dsh_version: '0.2.1-rc.2',
      team_profile: TEAM_PROFILE
    },
    key_read: false,
    provider_calls: 0,
    steps: [],
    rpc: [],
    fingerprint_before: captureEvidenceFingerprint()
  }
  let child
  let exitCode = 1
  try {
    const key = extractProviderKey(config.keyFile, config.provider)
    const isolatedKey = join(root, 'provider-key.txt')
    writeFileSync(isolatedKey, key, { mode: 0o600, flag: 'wx' })
    facts.key_read = true
    const profile = await prepareProfile(
      {
        mode: 'live',
        installMode: 'linked',
        keyFile: isolatedKey,
        providerBaseUrl: config.baseUrl,
        providerModel: config.model,
        providerProtocol: config.protocol
      },
      { prepare: async ({ root: fixtureRoot }) => fixture(fixtureRoot, paths, config) },
      root,
      facts.steps
    )
    const manifestPath = join(profile.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.dsh.profile.bundles.push(TEAM_PROFILE)
    writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    profile.env.XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY = '0'
    const boot = bootHost(profile, facts.steps)
    child = boot.child
    const gateway = safeGateway(await boot.ready, facts.rpc, 1)
    await gateway.authenticate()
    const ping = await gateway.call('blueprint/ping', {})
    assert.equal(ping?.status, 'ok')
    assert.equal(ping.service, PACKAGE)
    const lead = await until(
      () => safeReadJson(paths.ready),
      value => value?.sessionId === LEAD_SESSION && value.instance_pid === child.pid && value.operator_ready === true && value.observation_only === false
    )
    const document = await gateway.call('blueprint/loadDefinition', {
      args: { blueprintId: BLUEPRINT_ID }
    })
    const startArgs = {
      blueprintId: BLUEPRINT_ID,
      expectedRevision: document.documentRevision,
      inputJson: JSON.stringify({ request: 'Perform the live TeamStage acceptance task.' }),
      requestId: 'live-teamstage-acceptance-once',
      sessionId: lead.sessionId
    }
    const admitted = await gateway.call('blueprint/startSessionRun', { args: startArgs })
    const replay = await gateway.call('blueprint/startSessionRun', { args: startArgs })
    assert.equal(replay.runId, admitted.runId)
    assert.equal(replay.replayed, true)
    let lastProgressWrite = 0
    const run = await observeTerminalRun(
      () => gateway.call('blueprint/inspectRun', { args: { runId: admitted.runId } }),
      facts,
      snapshot => {
        if (Date.now() - lastProgressWrite < 1000 && !['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(snapshot.state)) return
        lastProgressWrite = Date.now()
        writeFileSync(
          join(report, 'progress.json'),
          JSON.stringify({
            observed_at: new Date().toISOString(),
            run: snapshot,
            operator: safeOperatorFacts(safeReadJson(paths.operatorFacts))
          }) + '\n',
          { mode: 0o600 }
        )
      }
    )
    facts.run = safeRun(run)
    const operatorBefore = safeOperatorFacts(safeReadJson(paths.operatorFacts))
    assert.equal(operatorBefore.instance_pid, child.pid)
    assert.equal(operatorBefore.operator_ready, true)
    assert.equal(operatorBefore.observation_only, false)
    facts.operator_before_restart = operatorBefore
    facts.provider_calls = operatorBefore.provider_calls
    if (run.state !== 'succeeded') fail('LIVE_TEAM_RUN_NOT_SUCCEEDED')
    assert.equal(run.team?.state, 'succeeded')
    assert.equal(run.team?.members?.length, 1)
    const work = run.attempts?.filter(attempt => attempt.nodeId === 'work')
    assert.equal(work?.length, 1)
    assert.equal(work[0].state, 'succeeded')
    assert.equal(work[0].diagnostics?.acceptance?.code, 'accepted')
    const output = run.attempts?.find(attempt => attempt.nodeId === 'output')
    assert.equal(output?.state, 'succeeded')
    facts.artifact_audit = artifactAudit(root, run)
    assert.ok(facts.provider_calls > 0)
    assert.equal(operatorBefore.failed_provider_calls, 0)
    assert.ok(operatorBefore.tool_names.includes('team_task_list'))
    assert.ok(operatorBefore.tool_names.includes('team_task_update'))
    assert.ok(operatorBefore.tool_names.includes('structured_output'))
    assert.ok(operatorBefore.stream_requests.every(request => request.provider === 'blueprint-live' && request.model === config.model))
    facts.member_lineage = validateMemberLineage(run, operatorBefore, config, facts.artifact_audit)
    await stopHost(child)
    child = undefined
    profile.env.XUANLING_TEAMSTAGE_COLLECTOR_OBSERVE_ONLY = '1'
    const restarted = bootHost(profile, facts.steps, 'restart')
    child = restarted.child
    const gatewayAfterRestart = safeGateway(await restarted.ready, facts.rpc, 2)
    await gatewayAfterRestart.authenticate()
    await until(
      () => safeReadJson(paths.ready),
      value => value?.sessionId === LEAD_SESSION && value.instance_pid === child.pid && value.operator_ready === true && value.observation_only === true
    )
    const restored = await gatewayAfterRestart.call('blueprint/inspectRun', {
      args: { runId: run.runId }
    })
    assert.deepEqual(restored, run)
    const operatorAfter = safeOperatorFacts(
      await until(
        () => safeReadJson(paths.operatorFacts),
        value => value?.instance_pid === child.pid && value.operator_ready === true && value.observation_only === true
      )
    )
    facts.restart = {
      same_profile: true,
      record_unchanged: true,
      instance_pid: operatorAfter.instance_pid,
      operator_ready: operatorAfter.operator_ready,
      observation_only: operatorAfter.observation_only,
      provider_calls_after_restart: operatorAfter.provider_calls,
      member_sessions_created_after_restart: operatorAfter.sessions.filter(session => session.sessionId !== LEAD_SESSION).length
    }
    assert.equal(operatorAfter.provider_calls, 0)
    assert.equal(facts.restart.member_sessions_created_after_restart, 0)
    facts.status = 'passed'
    exitCode = 0
  } catch (error) {
    facts.failure = safeCode(error)
    facts.run ??= undefined
  } finally {
    if (child) await stopHost(child).catch(() => {})
    const operator = safeOperatorFacts(safeReadJson(paths.operatorFacts))
    if (!facts.operator_before_restart) facts.operator_before_restart = operator
    facts.operator_after_cleanup = operator
    facts.provider_calls = Math.max(facts.provider_calls, operator.provider_calls)
    facts.completed_at = new Date().toISOString()
    facts.cleanup_removed = false
    facts.fingerprint_after = captureEvidenceFingerprint()
    rmSync(root, { recursive: true, force: true })
    facts.cleanup_removed = !existsSync(root)
    writeFileSync(join(report, 'receipt.json'), JSON.stringify(facts, null, 2) + '\n', {
      mode: 0o600
    })
    writeFileSync(
      join(report, 'fingerprint.json'),
      JSON.stringify(
        {
          schema_version: 1,
          plan_id: facts.plan_id,
          work_package: facts.work_package,
          status: facts.status,
          fingerprint: facts.fingerprint_after,
          provider: facts.provider,
          key_read: facts.key_read,
          provider_calls: facts.provider_calls
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
    writeFileSync(
      join(report, 'targeted.log'),
      JSON.stringify({
        status: facts.status,
        failure: facts.failure ?? null,
        provider: facts.provider,
        key_read: facts.key_read,
        provider_calls: facts.provider_calls,
        team_state: facts.run?.team?.state ?? null,
        cleanup_removed: facts.cleanup_removed
      }) + '\n',
      { mode: 0o600 }
    )
    writeFileSync(join(report, 'targeted.exit'), `${exitCode}\n`, { mode: 0o600 })
  }
  console.log(
    JSON.stringify({
      status: facts.status,
      failure: facts.failure ?? null,
      provider: facts.provider,
      key_read: facts.key_read,
      provider_calls: facts.provider_calls,
      team_state: facts.run?.team?.state ?? null,
      cleanup_removed: facts.cleanup_removed
    })
  )
  process.exitCode = exitCode
}
