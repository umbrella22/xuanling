/** Creation-window composition. No listener waits for spawn or Agent idle. */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { attachStructuredRuntime, STRUCTURED_OUTPUT_TOOL } from '../host/dsh-structured-compat.ts'
import { TEAM_MEMBER_TOOLS, TeamDriverError } from './driver-admission.ts'
import { TeamStageRunner } from './runner.ts'
import type { RunStore } from '../persistence/run-store.ts'
import { observeMemberChunk, teamStageAbortError, type TeamStageRuntime } from './observability.ts'

export interface MemberCapture {
  value: unknown
  evidence: {
    producerSessionId: string; callId: string; rootCallId: string; turnId: string; completedTurnId: string
    startLogSeq: number; captureLogSeq: number; endLogSeq: number
    completedAt: number; flushedAt: number; quiescentAt: number
  }
}

export function installTeamMemberScope(agent: Agent, options: {
  schema: ObjectJsonSchema; effectiveToolNames: readonly string[]; taskId: string
  nativeNames: readonly string[]; primary: boolean
  observerContext: Context
  signal: AbortSignal
  store: RunStore; runId: string; stageId: string; teamId: string; attemptId: string; memberId: string; nativeName: string
  activity?: TeamStageRuntime['members'][number]
  onUnknown(): void
}): { finish(signal: AbortSignal): Promise<MemberCapture>; assertQuiescent(): void; dispose(): void } {
  const ctx = agent.ctx
  // Native continuable completion disposes the child scope before emitting
  // agent/disposed. These observers belong to the stage, not that child scope.
  const observer = options.observerContext
  const tools = ctx.tools
  const removers: Array<() => void> = []
  const forbidden = new Set(['spawn_teammate', 'team_task_create', 'interrupt_agent', 'blueprint_start'])
  const businessNames = options.effectiveToolNames.filter(name => !forbidden.has(name)
    && !TEAM_MEMBER_TOOLS.includes(name as typeof TEAM_MEMBER_TOOLS[number]))
  const names = new Set([...businessNames, ...TEAM_MEMBER_TOOLS])
  // Policy remains child-owned for its whole continuation lifetime. Disposal
  // below only removes observers; it must never widen a surviving child.
  // DSH restrict names the global inherited business layer. Local Team tools
  // remain local registrations and are constrained by the guard below.
  tools.restrict({ allow: [...businessNames] })
  const denials = new Set<string>()
  tools.guard(exec => {
    const args = exec.arguments as Record<string, unknown> | null
    let allowed = !options.signal.aborted && exec.agent === agent && (exec.name === 'run_code' || exec.name === STRUCTURED_OUTPUT_TOOL || names.has(exec.name))
    if (exec.name === 'team_task_get' || exec.name === 'team_task_update') allowed &&= args?.task_id === options.taskId
    if (exec.name === 'team_task_update') allowed &&= options.primary && (args?.action === 'claim' || args?.action === 'complete')
    if (exec.name === 'send_message') allowed &&= args?.target === 'lead'
      || (args?.target !== options.nativeName && options.nativeNames.includes(args?.target as string))
    if (allowed) return undefined
    denials.add('teamstage-tool-not-permitted')
    return 'blueprint Team member tool permission denied'
  })
  const structured = attachStructuredRuntime(ctx, options.schema)
  const startLogSeq = agent.session.seq
  let turn: { id: number; start: number } | undefined
  let end: { id: number; seq: number; kind: string; at: number } | undefined
  let candidate: { callId: string; rootCallId: string; turnId: number; value: unknown; captureLogSeq?: number } | undefined
  let nested: { exec: ToolExecution; turnId: number } | undefined
  let invalid = false
  let completion: Promise<MemberCapture> | undefined
  let completionSeq: number | undefined
  let verifiedSeq: number | undefined
  let idleSeq: number | undefined
  let disposedSeq: number | undefined
  let invalidated = false
  // A member can have more than one tool invocation in flight while a model
  // stream is still open. Keep lifecycle ownership in this scope so an early
  // completion cannot publish `idle` over a later request or sibling tool.
  let activeToolExecutions = 0
  let activeStreams = 0
  let currentStreamOrdinal = 0
  const settleActivity = () => {
    if (activeStreams > 0 || activeToolExecutions > 0 || options.activity === undefined) return
    options.activity.activity = 'idle'
    options.activity.updatedAt = Date.now()
  }
  const registered = () => observer.get('agents')?.get(SessionId(agent.id))
  const assertUnchanged = (seq: number) => {
    options.signal.throwIfAborted()
    const live = registered()
    if (invalidated || agent.status !== 'idle' || agent.session.seq !== seq
      || (live !== agent && !(live === undefined && disposedSeq === seq))) {
      throw new TeamDriverError('teamstage-quiescence-unverified')
    }
  }
  const stopped = new Promise<never>((_, reject) => {
    const abort = () => reject(teamStageAbortError(options.signal))
    if (options.signal.aborted) abort()
    else options.signal.addEventListener('abort', abort, { once: true })
    removers.push(() => options.signal.removeEventListener('abort', abort))
  })
  void stopped.catch(() => {})
  const captureCompletion = async (): Promise<MemberCapture> => {
    options.signal.throwIfAborted()
    if (denials.size) throw new TeamDriverError([...denials][0]!)
    if (end?.kind === 'error') throw new TeamDriverError('teamstage-provider-failed')
    if (end?.kind === 'aborted') throw new TeamDriverError('teamstage-cancelled')
    if (end?.kind !== 'completed' || candidate === undefined || end.id !== candidate.turnId || turn?.id !== candidate.turnId
      || candidate.captureLogSeq === undefined || candidate.captureLogSeq >= end.seq) {
      throw new TeamDriverError(invalid ? 'teamstage-output-invalid' : 'teamstage-structured-output-missing')
    }
    if (registered() !== agent) throw new TeamDriverError('teamstage-quiescence-unverified')
    const seq = agent.session.seq
    completionSeq = seq
    const captured = { ...candidate, value: structuredClone(candidate.value) }
    const completed = { ...end }
    // Start our own durability barrier while the exact Session is still live.
    // A public disposal edge alone never proves successful flush participation.
    const sessions = observer.get('sessions')
    if (typeof sessions?.flush !== 'function') throw new TeamDriverError('teamstage-executor-unavailable')
    let participated: boolean
    try {
      participated = await Promise.race([sessions.flush(agent.session), stopped])
    } catch {
      if (options.signal.aborted) throw teamStageAbortError(options.signal)
      throw new TeamDriverError('teamstage-flush-unverified')
    }
    if (participated !== true) throw new TeamDriverError('teamstage-flush-unverified')
    const flushedAt = Date.now()
    await Promise.race([agent.whenIdle(), stopped])
    assertUnchanged(seq)
    if (denials.size) throw new TeamDriverError([...denials][0]!)
    verifiedSeq = seq
    return { value: captured.value, evidence: {
      producerSessionId: agent.id, callId: captured.callId, rootCallId: captured.rootCallId,
      turnId: `${agent.id}:${captured.turnId}`, completedTurnId: `${agent.id}:${completed.id}`,
      startLogSeq, captureLogSeq: captured.captureLogSeq!, endLogSeq: completed.seq,
      completedAt: completed.at, flushedAt, quiescentAt: Date.now(),
    } }
  }
  removers.push(observer.on('agent/status', ({ agent: changed, status }) => {
    if (changed !== agent) return
    if (status === 'running') {
      if (completionSeq !== undefined) invalidated = true
    } else if (registered() === agent) {
      idleSeq = agent.session.seq
      if (end?.kind === 'completed' && candidate !== undefined && completion === undefined) {
        completion = captureCompletion()
        void completion.catch(() => {})
      }
    }
  }))
  removers.push(observer.on('agent/disposed', ({ agent: disposed }) => {
    if (disposed !== agent) return
    if (agent.status === 'idle' && idleSeq === agent.session.seq && completionSeq === idleSeq && registered() === undefined) disposedSeq = idleSeq
    else invalidated = true
  }))
  removers.push(observer.on('agent/created', ({ agent: created }) => {
    if (created.id === agent.id) invalidated = true
  }, true))
  removers.push(observer.on('session/event', (session, event) => {
    if (session !== agent.session || event.seq < startLogSeq) return
    if (completionSeq !== undefined && event.seq >= completionSeq) invalidated = true
    if (event.type === 'turn/start') turn = { id: event.data.turn, start: event.seq }
    if (event.type === 'tool/result' && candidate && event.data.turn === candidate.turnId
      && event.data.message.toolCallId === candidate.rootCallId && !event.data.message.isError) candidate.captureLogSeq = event.seq
    if (event.type === 'turn/end') end = { id: event.data.turn, seq: event.seq, kind: event.data.reason.kind, at: event.time }
  }))
  if (options.activity) {
    const activity = options.activity
    removers.push(observer.on('llm/stream', async function* (request, next) {
      if (request.sessionId !== agent.id || registered() !== agent || invalidated) { yield* next(); return }
      const ordinal = ++currentStreamOrdinal
      activeStreams++
      activity.activity = 'waiting_model'
      activity.updatedAt = activity.requestStartedAt = Date.now()
      activity.requestOrdinal = ordinal
      activity.textDeltas = activity.reasoningDeltas = activity.toolCallDeltas = 0
      delete activity.lastProgressAt
      try { for await (const chunk of next()) { if (ordinal === currentStreamOrdinal) observeMemberChunk(activity, chunk); yield chunk } }
      finally {
        activeStreams = Math.max(0, activeStreams - 1)
        settleActivity()
      }
    }))
    removers.push(observer.on('tools/execute', async (exec, next) => {
      if (exec.agent !== agent) return await next()
      activeToolExecutions++
      activity.activity = 'executing_tool'; activity.updatedAt = Date.now()
      try { return await next() }
      finally { activeToolExecutions = Math.max(0, activeToolExecutions - 1); settleActivity() }
    }))
  }
  removers.push(observer.on('tools/result', function (this: unknown, exec, result) {
    if (exec.agent !== agent) return
    if (result.isError) {
      if (exec.name === STRUCTURED_OUTPUT_TOOL && result.error.info?.code === 'INVALID_ARGS') invalid = true
      else denials.add('teamstage-tool-rejected')
    }
    if (exec.name === STRUCTURED_OUTPUT_TOOL && !result.isError && turn && exec.parent !== undefined) nested = { exec, turnId: turn.id }
    const captured = structured.captured()
    if (!captured || candidate || result.isError || !turn) return
    const actual = exec.name === STRUCTURED_OUTPUT_TOOL && exec.parent === undefined ? exec
      : nested?.exec.parent === exec.token ? nested.exec : undefined
    if (!actual) return
    invalid = false
    candidate = { callId: actual.callId, rootCallId: actual.rootCallId, turnId: nested?.turnId ?? turn.id, value: captured.value }
  }))
  // Native mutation tools retain their own implementations/approval. The
  // scoped around-dispatch layer adds Blueprint durability before delegation.
  // An error here cannot prove the native journal was untouched.
  const runner = new TeamStageRunner(options.store)
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.agent !== agent || !['send_message', 'team_task_update'].includes(exec.name)) return await next()
    options.signal.throwIfAborted()
    try {
      let observedTask: { taskId: string; taskRevision: number; status: string } | undefined
      return await runner.dispatch({ store: options.store, runId: options.runId, stageId: options.stageId,
        teamId: options.teamId, actorSessionId: agent.id, memberId: options.memberId, memberName: options.nativeName,
        taskId: options.taskId, effectId: `team-tool:${options.attemptId}:${randomUUID()}`,
        kind: exec.name === 'send_message' ? 'message' : 'task-update',
        effect: async () => {
          const previous = exec.name === 'team_task_update' ? (await options.store.get(options.runId)).teamStage : undefined
          const result = await next()
          if (result.isError) throw new TeamDriverError('teamstage-team-effect-unknown')
          if (exec.name === 'team_task_update') {
            const args = exec.arguments as Record<string, unknown>
            const task = result.value as Record<string, unknown> | null
            const expectedRevision = args.expected_revision
            if (previous?.taskId !== options.taskId || previous.taskRevision === undefined
              || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
              || !task || task.id !== options.taskId || task.revision !== expectedRevision + 1
              || task.status !== (args.action === 'claim' ? 'in_progress' : 'completed')) {
              throw new TeamDriverError('teamstage-team-effect-unknown')
            }
            observedTask = { taskId: options.taskId, taskRevision: task.revision as number, status: task.status as string }
            // Publish the real successful mutation before returning to the
            // model. Cancellation freezes this revision; a cutoff race still
            // rejects the observation and preserves the unknown native effect.
            await options.store.observeTeamTaskRevision(options.runId,
              { taskId: observedTask.taskId, taskRevision: observedTask.taskRevision }, previous.taskRevision)
          }
          return result
        }, result: () => ({ ok: true, ...observedTask }), unknown: () => true })
    } catch (error) {
      options.onUnknown()
      throw error
    }
  })
  return {
    async finish(signal) {
      await Promise.race([agent.whenIdle(), stopped])
      signal.throwIfAborted()
      completion ??= captureCompletion()
      const capture = await Promise.race([completion, stopped])
      signal.throwIfAborted()
      assertUnchanged(verifiedSeq!)
      return capture
    },
    assertQuiescent() {
      if (verifiedSeq === undefined) throw new TeamDriverError('teamstage-quiescence-unverified')
      assertUnchanged(verifiedSeq)
    },
    dispose() { for (const remove of removers.splice(0).reverse()) remove() },
  }
}
