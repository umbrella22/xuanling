/** Typed execution facts and transient, content-free native member activity. */
import type { RunRecord } from '../persistence/records.ts'
import { TeamDriverError } from './driver-admission.ts'
import { teamStageRuntimeCodec, type TeamStageExecution, type TeamStageRuntime } from '../host/teamstage-diagnostics.ts'

export type { TeamStageRuntime } from '../host/teamstage-diagnostics.ts'
type MemberActivity = TeamStageRuntime['members'][number]

/** A deadline supplied by the host/DSH runtime. Blueprint never creates one. */
export interface TeamStageDeadline {
  signal: AbortSignal
  timeoutMs: number
}

/** First abort wins. Raw native reasons never cross the durable/DTO boundary. */
export function teamStageControl(parent: AbortSignal, stage: AbortSignal, deadline?: TeamStageDeadline, now: () => number = Date.now) {
  const controller = new AbortController()
  const startedAt = now()
  const execution: TeamStageExecution =
    deadline === undefined ? { startedAt } : { startedAt, deadlineAt: startedAt + deadline.timeoutMs, timeoutMs: deadline.timeoutMs }
  const removers: Array<() => void> = []
  const inputs = [['caller', parent] as const, ['stage_control', stage] as const, ...(deadline === undefined ? [] : [['deadline', deadline.signal] as const])]
  for (const [source, signal] of inputs) {
    const abort = () => {
      if (controller.signal.aborted) return
      const code =
        source === 'deadline'
          ? 'teamstage-deadline-exceeded'
          : source === 'caller'
            ? 'teamstage-cancelled'
            : signal.reason instanceof TeamDriverError && ['teamstage-team-effect-unknown', 'teamstage-not-dispatching'].includes(signal.reason.issueCode)
              ? (signal.reason.issueCode as 'teamstage-team-effect-unknown' | 'teamstage-not-dispatching')
              : 'teamstage-aborted'
      execution.abort = { source, code, occurredAt: now() }
      controller.abort(new TeamDriverError(code))
    }
    if (signal.aborted) abort()
    else {
      signal.addEventListener('abort', abort, { once: true })
      removers.push(() => signal.removeEventListener('abort', abort))
    }
  }
  return {
    signal: controller.signal,
    snapshot: () => structuredClone(execution),
    dispose() {
      for (const remove of removers.splice(0)) remove()
    }
  }
}

export function teamStageAbortError(signal: AbortSignal): TeamDriverError {
  return signal.reason instanceof TeamDriverError ? signal.reason : new TeamDriverError('teamstage-cancelled')
}

/** A stage lifetime holds only its latest per-member activity, never model text. */
export class TeamStageObservations {
  private readonly stages = new Map<string, { attemptId: string; members: Map<string, MemberActivity> }>()
  begin(runId: string, attemptId: string): void {
    this.stages.set(runId, { attemptId, members: new Map() })
  }
  bind(runId: string, attemptId: string, memberId: string, sessionId: string): MemberActivity | undefined {
    const stage = this.stages.get(runId)
    if (stage?.attemptId !== attemptId) return undefined
    const member: MemberActivity = {
      memberId,
      sessionId,
      activity: 'idle',
      updatedAt: Date.now(),
      requestOrdinal: 0,
      textDeltas: 0,
      reasoningDeltas: 0,
      toolCallDeltas: 0
    }
    stage.members.set(memberId, member)
    return member
  }
  end(runId: string, attemptId: string): void {
    if (this.stages.get(runId)?.attemptId === attemptId) this.stages.delete(runId)
  }
  snapshot(record: RunRecord): TeamStageRuntime | undefined {
    const binding = record.teamStage
    const stage = this.stages.get(record.runId)
    if (!binding?.attemptId || stage?.attemptId !== binding.attemptId || record.state !== 'running' || !['provisioning', 'active'].includes(binding.state))
      return undefined
    const attempt = record.attempts.find(value => value.attemptId === binding.attemptId)
    if (!attempt || attempt.nodeId !== binding.stageId || !['preparing', 'ready', 'running'].includes(attempt.state)) return undefined
    return teamStageRuntimeCodec().parse({
      attemptId: stage.attemptId,
      observedAt: Date.now(),
      members: [...stage.members.values()].filter(member =>
        binding.members.some(bound => bound.memberId === member.memberId && bound.sessionId === member.sessionId && bound.phase === 'active')
      )
    })
  }
}

export function observeMemberChunk(member: MemberActivity, chunk: { type: string; text?: string }): void {
  if (chunk.type === 'finish') {
    member.activity = 'idle'
    member.updatedAt = Date.now()
    return
  }
  if (chunk.type === 'reasoning-delta' && chunk.text) {
    member.reasoningDeltas++
    member.activity = 'thinking'
  } else if (chunk.type === 'text-delta' && chunk.text) {
    member.textDeltas++
    member.activity = 'responding'
  } else if (chunk.type === 'tool-call-delta') {
    member.toolCallDeltas++
    member.activity = 'tool_call'
  } else return
  member.updatedAt = member.lastProgressAt = Date.now()
}
