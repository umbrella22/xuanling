/**
 * Recovery reconciliation (C-09): on (re)start, runs whose last dispatch
 * intent has no settled result enter `recovery_required` — the system never
 * re-dispatches work whose external effect is unknown, and never invents an
 * outcome. Explicit reconciliation (`reconcile`) applies human-reviewed
 * evidence and moves the run to a known terminal, or starts a NEW attempt
 * via the normal admission path. Terminal states stay untouched.
 */
import type { RunStore } from '../persistence/run-store.ts'
import { TeamStageConflictError, TerminalStateError } from '../persistence/run-store.ts'
import type { RunRecord } from '../persistence/records.ts'
import { IllegalTransitionError } from './state.ts'

const ATTEMPT_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'])
const RUN_TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out'])

function unknownTeamEffect(run: RunRecord) {
  return run.teamStage?.effects?.find(effect => effect.state === 'pending' || effect.state === 'recovery_required')
}

function teamRecoveryNeeded(run: RunRecord): boolean {
  const stage = run.teamStage
  if (RUN_TERMINAL.has(run.state) || stage === undefined || unknownTeamEffect(run) === undefined) return false
  const attempt = run.attempts.find(candidate => candidate.attemptId === stage.attemptId)
  return (
    run.state !== 'recovery_required' ||
    stage.state !== 'recovery_required' ||
    (attempt !== undefined && attempt.result === undefined && !ATTEMPT_TERMINAL.has(attempt.state) && attempt.state !== 'recovery_required')
  )
}

/** Abort a raced read-only reconciliation before the store advances seq. */
class TeamRecoveryUnchangedError extends TeamStageConflictError {
  constructor(runId: string) {
    super(runId, 'Team recovery is no longer required')
  }
}

export interface ReconciliationReport {
  scanned: number
  /** Runs moved to recovery_required: last intent without a result. */
  recoveryRequired: Array<{ runId: string; attemptId: string; nodeId: string; intentKind: string }>
  /** Runs left untouched (terminal, queued, or already recovered). */
  untouched: string[]
}

export async function reconcileOnStart(store: RunStore): Promise<ReconciliationReport> {
  const report: ReconciliationReport = { scanned: 0, recoveryRequired: [], untouched: [] }
  for (const runId of await store.listRunIds()) {
    report.scanned += 1
    const run = await store.get(runId)
    // Team effects are canonical facts independent of the bounded audit log.
    // A pending or explicitly unknown create/spawn/message/task effect stays
    // unknown after restart, including when the Run was waiting for input. Never
    // redispatch it and never let the waiting state hide it.
    if (teamRecoveryNeeded(run)) {
      let recovered: ReconciliationReport['recoveryRequired'][number] | undefined
      try {
        await store.transition(runId, draft => {
          const stage = draft.teamStage
          const effect = unknownTeamEffect(draft)
          if (stage === undefined || effect === undefined || !teamRecoveryNeeded(draft)) throw new TeamRecoveryUnchangedError(runId)
          const seq = draft.seq + 1
          const at = Date.now()
          const attempt = draft.attempts.find(candidate => candidate.attemptId === stage.attemptId)
          if (attempt !== undefined && attempt.result === undefined && !ATTEMPT_TERMINAL.has(attempt.state)) attempt.state = 'recovery_required'
          draft.state = 'recovery_required'
          stage.state = 'recovery_required'
          stage.recovery = { code: 'team-effect-unknown', detail: effect.effectId }
          stage.updatedAt = at
          draft.log.push({ seq, at, kind: 'recovery', detail: { effectId: effect.effectId, stageId: stage.stageId, reason: 'team-effect-unknown' } })
          recovered = { runId, attemptId: stage.attemptId ?? `team:${effect.effectId}`, nodeId: stage.stageId, intentKind: effect.kind }
        })
      } catch (error) {
        if (error instanceof TerminalStateError || error instanceof TeamRecoveryUnchangedError) {
          report.untouched.push(runId)
          continue
        }
        throw error
      }
      if (recovered !== undefined) report.recoveryRequired.push(recovered)
      continue
    }
    if (['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required', 'waiting_input'].includes(run.state)) {
      report.untouched.push(runId)
      continue
    }
    const unsettled = run.attempts.find(a => a.intent !== undefined && a.result === undefined && !ATTEMPT_TERMINAL.has(a.state))
    if (unsettled === undefined) {
      report.untouched.push(runId)
      continue
    }
    await store.transition(runId, draft => {
      const seq = draft.seq + 1
      for (const attempt of draft.attempts) {
        if (attempt.intent !== undefined && attempt.result === undefined && !ATTEMPT_TERMINAL.has(attempt.state)) attempt.state = 'recovery_required'
      }
      draft.state = 'recovery_required'
      draft.log.push({
        seq,
        at: Date.now(),
        kind: 'recovery',
        detail: { attemptId: unsettled.attemptId, nodeId: unsettled.nodeId, reason: 'intent-without-result' }
      })
    })
    report.recoveryRequired.push({ runId, attemptId: unsettled.attemptId, nodeId: unsettled.nodeId, intentKind: unsettled.intent?.kind ?? 'unknown' })
  }
  return report
}

export type RecoveryAction = 'succeeded' | 'failed' | 'cancelled' | 'timed_out'

/** Apply a human-reviewed recovery decision: the reviewed evidence settles
 * the pending attempt, then the run takes the reviewed terminal state. */
export async function reconcile(store: RunStore, run: RunRecord, action: RecoveryAction, evidence: string): Promise<RunRecord> {
  if (run.state !== 'recovery_required') {
    throw new IllegalTransitionError(run.state, action)
  }
  return await store.transition(run.runId, draft => {
    if (draft.state !== 'recovery_required') throw new IllegalTransitionError(draft.state, action)
    const seq = draft.seq + 1
    for (const attempt of draft.attempts) {
      if (attempt.intent === undefined || attempt.result !== undefined || ATTEMPT_TERMINAL.has(attempt.state)) continue
      attempt.state = action
      attempt.result = {
        seq,
        at: Date.now(),
        ok: action === 'succeeded',
        outcome: { recovery: action, kind: action === 'timed_out' ? 'timeout' : action },
        evidence
      }
    }
    draft.state = action
    draft.log.push({ seq, at: Date.now(), kind: 'state', detail: { recovery: action, evidence } })
  })
}
