/** Pure public projections of one canonical aggregate cut. Never re-read the
 * store while building related run/source/focus fields. */
import type { RunRecord, TeamStageRecord } from '../persistence/records.ts'
import { attemptDiagnosticsCodec } from '../host/runtime-diagnostics.ts'
import { teamStageProjectionCodec, type RunSnapshotView, type TeamStageProjection } from './contracts.ts'
import type { TeamStageRuntime } from '../host/teamstage-diagnostics.ts'

const NODE_VALUE_ERROR_CODES = new Set([
  'condition-input-invalid',
  'input-missing',
  'input-invalid',
  'binding-missing',
  'binding-unavailable',
  'binding-invalid',
  'binding-drift',
  'output-missing',
  'output-invalid'
])
export function projectRunSnapshot(record: RunRecord, runtime?: TeamStageRuntime): RunSnapshotView {
  return {
    runId: record.runId,
    state: record.state,
    definitionRevision: record.definitionRevision,
    ...(record.bindingDigests === undefined ? {} : { bindingDigests: { ...record.bindingDigests } }),
    ...(record.source === undefined ? {} : { source: { ...record.source } }),
    attempts: record.attempts.map(a => {
      const outcome = a.result?.outcome as { kind?: string; outputs?: unknown; value?: unknown } | undefined
      const hasOutput = outcome !== undefined && (Object.hasOwn(outcome, 'outputs') || Object.hasOwn(outcome, 'value'))
      return {
        nodeId: a.nodeId,
        state: a.state,
        attempt: a.attempt,
        attemptId: a.attemptId,
        ...(a.sessionId === undefined ? {} : { sessionId: a.sessionId }),
        diagnostics: attemptDiagnosticsCodec().parse(a.diagnostics ?? { status: 'unavailable' }),
        ...(a.result ? { resultKind: a.result.ok ? 'succeeded' : (outcome?.kind ?? a.state) } : {}),
        ...(a.result?.ok && hasOutput
          ? {
              outputJson: JSON.stringify({
                ...(Object.hasOwn(outcome!, 'outputs') ? { outputs: outcome!.outputs } : {}),
                ...(Object.hasOwn(outcome!, 'value') ? { value: outcome!.value } : {})
              })
            }
          : {}),
        ...(a.result && !a.result.ok
          ? { errorCode: typeof outcome?.kind === 'string' && NODE_VALUE_ERROR_CODES.has(outcome.kind) ? outcome.kind : a.state }
          : {})
      }
    }),
    seq: record.seq,
    logTail: record.log.slice(-10).map(e => ({ seq: e.seq, kind: e.kind })),
    ...(record.teamStage === undefined ? {} : { team: projectTeamStage(record, runtime) })
  }
}

export function focusAttemptsForSession(record: RunRecord, sessionId: string): string[] {
  if (record.source?.sessionId !== sessionId) {
    const stage = record.teamStage
    const member = stage?.members.some(value => value.sessionId === sessionId) === true
    return record.attempts
      .filter(a => a.sessionId === sessionId || (member && a.attemptId === stage?.attemptId && a.nodeId === stage.stageId))
      .map(a => a.attemptId)
  }
  const active = record.attempts.filter(a => ['preparing', 'ready', 'running', 'waiting_input', 'cancelling', 'recovery_required'].includes(a.state))
  if (active.length) return active.map(a => a.attemptId)
  // Canonical insertion order is the Attempt dispatch order, including legacy
  // Attempts without timestamps. An empty Run has no node to invent.
  const latest = record.attempts.at(-1)
  return latest === undefined ? [] : [latest.attemptId]
}

/** Project canonical TeamStage facts to the strict browser DTO. Native Team
 * roster/task observations are intentionally not accepted here; W3 may attach
 * them as a separate derived observation. */
export function projectTeamStage(record: RunRecord, runtime?: TeamStageRuntime): TeamStageProjection | undefined {
  if (record.teamStage === undefined) return undefined
  const stage = record.teamStage
  const attempt = stage.attemptId === undefined ? undefined : record.attempts.find(value => value.attemptId === stage.attemptId)
  const matches =
    runtime !== undefined &&
    record.state === 'running' &&
    stage.state === 'active' &&
    attempt?.nodeId === stage.stageId &&
    attempt.state === 'running' &&
    stage.attemptId === runtime.attemptId &&
    runtime.members.every(member =>
      stage.members.some(bound => bound.memberId === member.memberId && bound.sessionId === member.sessionId && bound.phase === 'active')
    )
  return teamStageProjectionCodec().parse({ ...projectTeamRecord(stage), ...(matches ? { runtime } : {}) })
}

function projectTeamRecord(stage: TeamStageRecord) {
  return {
    schemaVersion: stage.schemaVersion,
    stageId: stage.stageId,
    runId: stage.runId,
    teamId: stage.teamId,
    leadSessionId: stage.leadSessionId,
    ...(stage.attemptId === undefined ? {} : { attemptId: stage.attemptId }),
    ...(stage.requiredMemberIds === undefined ? {} : { requiredMemberIds: [...stage.requiredMemberIds] }),
    ...(stage.requiredChecks === undefined ? {} : { requiredChecks: [...stage.requiredChecks] }),
    ...(stage.primaryMemberId === undefined ? {} : { primaryMemberId: stage.primaryMemberId }),
    taskSpecificationFingerprint: stage.taskSpecificationFingerprint,
    ...(stage.taskId === undefined ? {} : { taskId: stage.taskId }),
    ...(stage.taskRevision === undefined ? {} : { taskRevision: stage.taskRevision }),
    state: stage.state,
    members: stage.members.map(member => ({
      memberId: member.memberId,
      ...(member.name === undefined ? {} : { name: member.name }),
      phase: member.phase,
      status: member.status,
      ...(member.sessionId === undefined ? {} : { sessionId: member.sessionId }),
      ...(member.evidence === undefined
        ? {}
        : {
            evidence: {
              captureId: member.evidence.captureId,
              completedTurnId: member.evidence.completedTurnId,
              flushedAt: member.evidence.flushedAt,
              quiescentAt: member.evidence.quiescentAt
            }
          })
    })),
    ...(stage.outputAcceptance === undefined ? {} : { outputAcceptance: { ...stage.outputAcceptance, checks: [...stage.outputAcceptance.checks] } }),
    ...(stage.cancel === undefined ? {} : { cancel: { ...stage.cancel } }),
    ...(stage.recovery === undefined ? {} : { recovery: { ...stage.recovery } }),
    ...(stage.execution === undefined ? {} : { execution: stage.execution }),
    ...(stage.effects === undefined ? {} : { effects: stage.effects.map(effect => ({ effectId: effect.effectId, kind: effect.kind, state: effect.state })) }),
    updatedAt: stage.updatedAt
  }
}
