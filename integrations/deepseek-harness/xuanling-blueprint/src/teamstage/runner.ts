/** Durable Team external-effect runner.
 *
 * The RunStore transition callback is intentionally limited to logical,
 * redacted facts. The callback passed to `dispatch` runs only after the
 * intent has committed and is never invoked from a reducer.
 */
import { teamStageRecordSchema, type RunRecord, type TeamEffectSnapshot } from '../persistence/records.ts'
import { TeamEffectReplayError, TeamStageConflictError, TeamTaskConflictError } from '../persistence/run-store.ts'
import type { RunStore } from '../persistence/run-store.ts'

export { TeamEffectReplayError } from '../persistence/run-store.ts'

export class TeamEffectUnknownError extends Error {
  override readonly name = 'TeamEffectUnknownError'
  readonly code = 'TEAM_EFFECT_UNKNOWN'
  constructor(detail = 'Team external effect outcome is unknown') { super(detail) }
}

export interface TeamEffectFacts {
  runId: string
  stageId: string
  teamId: string
  effectId: string
  kind: string
  actorSessionId: string
  memberName?: string
  taskId?: string
  memberId?: string
}

export interface TeamEffectResultFacts {
  ok: boolean
  errorCode?: string
  taskId?: string
  taskRevision?: number
  memberId?: string
  status?: string
}

export interface TeamEffectDispatch<T> extends TeamEffectFacts {
  store: RunStore
  effect: () => Promise<T> | T
  result?: (value: T) => TeamEffectResultFacts
  unknown?: (error: unknown) => boolean
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
    throw new TeamStageConflictError('', `${label} must be a non-empty logical identifier`)
  }
  return value
}

function effectFacts(value: TeamEffectFacts): TeamEffectFacts {
  const facts: TeamEffectFacts = {
    runId: id(value.runId, 'runId'), stageId: id(value.stageId, 'stageId'),
    teamId: id(value.teamId, 'teamId'), effectId: id(value.effectId, 'effectId'), kind: id(value.kind, 'kind'),
    actorSessionId: id(value.actorSessionId, 'actorSessionId'),
  }
  if (value.memberName !== undefined) facts.memberName = id(value.memberName, 'memberName')
  if (value.taskId !== undefined) facts.taskId = id(value.taskId, 'taskId')
  if (value.memberId !== undefined) facts.memberId = id(value.memberId, 'memberId')
  return facts
}

function resultFacts(value: TeamEffectResultFacts): TeamEffectResultFacts {
  if (value === null || typeof value !== 'object' || typeof value.ok !== 'boolean') {
    throw new TeamStageConflictError('', 'Team effect result must contain a boolean ok field')
  }
  const checked: TeamEffectResultFacts = { ok: value.ok }
  if (value.errorCode !== undefined) checked.errorCode = errorCode({ code: value.errorCode })
  if (value.taskId !== undefined) checked.taskId = id(value.taskId, 'taskId')
  if (value.taskRevision !== undefined) {
    if (!Number.isInteger(value.taskRevision) || value.taskRevision < 1) throw new TeamStageConflictError('', 'taskRevision must be a positive integer')
    checked.taskRevision = value.taskRevision
  }
  if (value.memberId !== undefined) checked.memberId = id(value.memberId, 'memberId')
  if (value.status !== undefined) {
    if (!/^[a-z0-9_-]{1,64}$/u.test(value.status)) throw new TeamStageConflictError('', 'status must be a bounded lowercase identifier')
    checked.status = value.status
  }
  return checked
}

function errorCode(error: unknown): string {
  const code = error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : 'TEAM_EFFECT_FAILED'
  return /^[A-Z0-9_.:-]{1,96}$/u.test(code) ? code : 'TEAM_EFFECT_FAILED'
}

/** Find a still-unsettled intent using canonical bounded transition facts. */
function unresolved(record: RunRecord, facts: TeamEffectFacts): boolean {
  const canonical = record.teamStage?.effects?.find(effect => effect.effectId === facts.effectId)
  if (canonical !== undefined) return canonical.state === 'pending'
  let pending = false
  for (const event of record.log) {
    if (event.detail.teamEffect !== 'team' || event.detail.effectId !== facts.effectId) continue
    if (event.kind === 'intent') pending = true
    if (event.kind === 'result' || event.kind === 'recovery') pending = false
  }
  return pending
}

async function append(store: RunStore, facts: TeamEffectFacts, phase: 'intent' | 'result' | 'recovery', result: TeamEffectResultFacts = { ok: false }): Promise<RunRecord> {
  return await store.transition(facts.runId, draft => {
    const stage = draft.teamStage
    if (stage === undefined || stage.stageId !== facts.stageId || stage.teamId !== facts.teamId) {
      throw new TeamStageConflictError(facts.runId, 'Team effect binding does not match the canonical stage')
    }
    const effects = [...(stage.effects ?? [])]
    const existingIndex = effects.findIndex(effect => effect.effectId === facts.effectId)
    const existing = existingIndex < 0 ? undefined : effects[existingIndex]
    if (phase === 'intent') {
      if (existing?.state === 'pending') throw new TeamTaskConflictError(facts.runId, 'unresolved Team effect requires recovery')
      if (existing !== undefined) throw new TeamEffectReplayError()
      if (facts.kind === 'create' && effects.some(effect => effect.kind === 'create' && effect.state === 'pending')) {
        throw new TeamTaskConflictError(facts.runId, 'a Team task create effect is already unresolved')
      }
      if (facts.kind === 'spawn' && facts.memberName === undefined) {
        throw new TeamStageConflictError(facts.runId, 'a Team member spawn requires its canonical member name')
      }
      if (facts.kind === 'spawn' && facts.memberName !== undefined
        && effects.some(effect => effect.kind === 'spawn' && effect.memberName === facts.memberName
          && effect.state !== 'failed')) {
        throw new TeamTaskConflictError(facts.runId, `member ${facts.memberName} already has a reserved spawn effect`)
      }
      const intent: TeamEffectSnapshot = {
        effectId: facts.effectId,
        kind: facts.kind,
        stageId: facts.stageId,
        teamId: facts.teamId,
        actorSessionId: facts.actorSessionId,
        ...(facts.memberName === undefined ? {} : { memberName: facts.memberName }),
        ...(facts.taskId === undefined ? {} : { taskId: facts.taskId }),
        ...(facts.memberId === undefined ? {} : { memberId: facts.memberId }),
        state: 'pending',
        intentAt: Date.now(),
      }
      effects.push(intent)
    } else {
      if (existing === undefined || existing.state !== 'pending') {
        throw new TeamTaskConflictError(facts.runId, `Team effect ${phase} has no unresolved intent`)
      }
      const settledAt = Date.now()
      const checkedResult = phase === 'result' ? resultFacts(result) : undefined
      effects[existingIndex] = {
        ...existing,
        state: phase === 'recovery' ? 'recovery_required' : result.ok ? 'succeeded' : 'failed',
        settledAt,
        ...(checkedResult === undefined ? {} : {
          ok: checkedResult.ok,
          ...(checkedResult.errorCode === undefined ? {} : { errorCode: checkedResult.errorCode }),
          ...(checkedResult.taskId === undefined ? {} : { resultTaskId: checkedResult.taskId }),
          ...(checkedResult.taskRevision === undefined ? {} : { resultTaskRevision: checkedResult.taskRevision }),
          ...(checkedResult.memberId === undefined ? {} : { resultMemberId: checkedResult.memberId }),
          ...(checkedResult.status === undefined ? {} : { resultStatus: checkedResult.status }),
        }),
      }
      if (phase === 'result' && checkedResult === undefined) throw new TeamStageConflictError(facts.runId, 'result facts are missing')
    }
    const detail: Record<string, unknown> = {
      teamEffect: 'team', phase, effectId: facts.effectId, kind: facts.kind,
      stageId: facts.stageId, teamId: facts.teamId, actorSessionId: facts.actorSessionId,
    }
    if (facts.taskId !== undefined) detail.taskId = facts.taskId
    if (facts.memberId !== undefined) detail.memberId = facts.memberId
    if (facts.memberName !== undefined) detail.memberName = facts.memberName
    if (phase === 'result') {
      const checkedResult = resultFacts(result)
      detail.ok = checkedResult.ok
      if (checkedResult.errorCode !== undefined) detail.errorCode = checkedResult.errorCode
      if (checkedResult.taskId !== undefined) detail.taskId = checkedResult.taskId
      if (checkedResult.taskRevision !== undefined) detail.taskRevision = checkedResult.taskRevision
      if (checkedResult.memberId !== undefined) detail.memberId = checkedResult.memberId
      if (checkedResult.status !== undefined) detail.status = checkedResult.status
    }
    if (phase === 'recovery') {
      detail.recovery = 'required'
      stage.state = 'recovery_required'
      stage.recovery = { code: 'team-effect-unknown', detail: facts.effectId }
      stage.updatedAt = Date.now()
    }
    stage.effects = effects
    teamStageRecordSchema.parse(stage)
    draft.log.push({ seq: draft.seq + 1, at: Date.now(), kind: phase === 'intent' ? 'intent' : phase === 'recovery' ? 'recovery' : 'result', detail })
  })
}

export async function recordTeamEffectIntent(store: RunStore, facts: TeamEffectFacts): Promise<RunRecord> {
  const checked = effectFacts(facts)
  try { return await append(store, checked, 'intent') }
  catch (error) {
    if (error instanceof TeamTaskConflictError) throw new TeamEffectUnknownError(error.message)
    throw error
  }
}

export async function recordTeamEffectResult(store: RunStore, facts: TeamEffectFacts, result: TeamEffectResultFacts): Promise<RunRecord> {
  const checked = effectFacts(facts)
  try { return await append(store, checked, 'result', result) }
  catch (error) {
    if (error instanceof TeamTaskConflictError) throw new TeamEffectUnknownError(error.message)
    throw error
  }
}

export async function recordTeamEffectRecovery(store: RunStore, facts: TeamEffectFacts): Promise<RunRecord> {
  const checked = effectFacts(facts)
  const current = await store.get(checked.runId)
  if (!unresolved(current, checked)) return current
  try { return await append(store, checked, 'recovery') }
  catch (error) {
    if (error instanceof TeamTaskConflictError) return await store.get(checked.runId)
    throw error
  }
}

export class TeamStageRunner {
  constructor(readonly store: RunStore) {}

  async dispatch<T>(request: TeamEffectDispatch<T>): Promise<T> {
    const facts = effectFacts(request)
    await recordTeamEffectIntent(this.store, facts)

    let value: T
    try {
      value = await request.effect()
    } catch (cause) {
      const isUnknown = cause instanceof TeamEffectUnknownError || request.unknown?.(cause) === true
      if (isUnknown) {
        await recordTeamEffectRecovery(this.store, facts)
      } else {
        await recordTeamEffectResult(this.store, facts, { ok: false, errorCode: errorCode(cause) })
      }
      throw cause
    }

    // Once the native call has returned, a mapper or durable result failure
    // leaves the external outcome uncertain. Recording an ordinary failed
    // result would make a later retry indistinguishable from a safe failure.
    let result: TeamEffectResultFacts
    try {
      result = resultFacts(request.result?.(value) ?? { ok: true })
    } catch (cause) {
      await recordTeamEffectRecovery(this.store, facts)
      throw cause
    }
    try {
      await recordTeamEffectResult(this.store, facts, result)
    } catch (cause) {
      await recordTeamEffectRecovery(this.store, facts)
      throw cause
    }
    return value
  }

  /** Alias used by callers that name the operation rather than the transport. */
  async run<T>(request: TeamEffectDispatch<T>): Promise<T> { return await this.dispatch(request) }
}
