/** Owned TeamStage cancellation and quiescence settlement. */
import type { RunRecord, TeamEffectSnapshot } from '../persistence/records.ts'
import { TeamStageConflictError } from '../persistence/run-store.ts'
import type { RunStore } from '../persistence/run-store.ts'
import { TeamEffectUnknownError, TeamStageRunner, recordTeamEffectRecovery } from './runner.ts'
import type { LeadHandle, TeamNativeAdapter } from './native-adapter.ts'

export class TeamCancellationError extends Error {
  override readonly name = 'TeamCancellationError'
  readonly code = 'TEAM_CANCELLATION_FAILED'
  constructor(detail: string) {
    super(detail)
  }
}

export interface OwnedTeamCancellationArgs {
  store: RunStore
  runId: string
  adapter?: TeamNativeAdapter
  lead?: LeadHandle
  /** Public names are consistency checks; the canonical stage owns the target set. */
  ownedMemberNames?: readonly string[]
  memberNames?: readonly string[]
  reason?: string
}

interface PendingTeamEffect {
  effectId: string
  kind: string
  stageId: string
  teamId: string
  actorSessionId: string
  taskId?: string
  memberId?: string
}

function unresolvedTeamEffects(record: RunRecord): PendingTeamEffect[] {
  const canonical = record.teamStage?.effects?.filter(effect => effect.state === 'pending')
  if (canonical !== undefined && canonical.length > 0) {
    return canonical.map(effect => ({
      effectId: effect.effectId,
      kind: effect.kind,
      stageId: effect.stageId,
      teamId: effect.teamId,
      actorSessionId: effect.actorSessionId,
      ...(effect.taskId === undefined ? {} : { taskId: effect.taskId }),
      ...(effect.memberId === undefined ? {} : { memberId: effect.memberId })
    }))
  }
  const pending = new Map<string, PendingTeamEffect>()
  for (const event of record.log) {
    if (
      event.detail.teamEffect !== 'team' ||
      typeof event.detail.effectId !== 'string' ||
      typeof event.detail.stageId !== 'string' ||
      typeof event.detail.teamId !== 'string' ||
      typeof event.detail.kind !== 'string' ||
      typeof event.detail.actorSessionId !== 'string'
    )
      continue
    const value = {
      effectId: event.detail.effectId,
      kind: event.detail.kind,
      stageId: event.detail.stageId,
      teamId: event.detail.teamId,
      actorSessionId: event.detail.actorSessionId,
      ...(typeof event.detail.taskId === 'string' ? { taskId: event.detail.taskId } : {}),
      ...(typeof event.detail.memberId === 'string' ? { memberId: event.detail.memberId } : {})
    }
    if (event.kind === 'intent') pending.set(value.effectId, value)
    if (event.kind === 'result' || event.kind === 'recovery') pending.delete(value.effectId)
  }
  return [...pending.values()]
}

interface CanonicalCancellationTargets {
  names: string[]
  childSessionIds: string[]
}

function requestedNames(args: OwnedTeamCancellationArgs): string[] {
  const values = [args.ownedMemberNames, args.memberNames].filter(value => value !== undefined)
  if (values.some(value => !Array.isArray(value))) throw new TeamCancellationError('owned teammate names must be an array')
  const names = [...new Set(values.flatMap(value => value as readonly unknown[]))]
  if (names.some(name => typeof name !== 'string' || name.trim().length === 0 || name.length > 256)) {
    throw new TeamCancellationError('owned teammate names must be explicit logical identifiers')
  }
  return names as string[]
}

/** Derive the immutable cancellation target from the canonical stage. */
function canonicalTargets(stage: NonNullable<RunRecord['teamStage']>): CanonicalCancellationTargets {
  const names: string[] = []
  const childSessionIds: string[] = []
  const seenNames = new Set<string>()
  const seenSessionIds = new Set<string>()
  for (const member of stage.members) {
    if (typeof member.name !== 'string' || member.name.trim().length === 0) {
      throw new TeamCancellationError('canonical Team member has no logical name')
    }
    if (seenNames.has(member.name)) throw new TeamCancellationError('canonical Team member names are not unique')
    seenNames.add(member.name)
    names.push(member.name)
    if (typeof member.sessionId !== 'string' || member.sessionId.trim().length === 0) {
      throw new TeamCancellationError(`canonical Team member ${member.name} has no child session identity`)
    }
    if (member.sessionId === stage.leadSessionId) {
      throw new TeamCancellationError('canonical Team member cannot be the source Lead')
    }
    if (seenSessionIds.has(member.sessionId)) throw new TeamCancellationError('canonical Team child session ids are not unique')
    seenSessionIds.add(member.sessionId)
    childSessionIds.push(member.sessionId)
  }
  return { names, childSessionIds }
}

/** Validate caller-supplied names without allowing them to narrow the target. */
function assertOwnedNames(stage: NonNullable<RunRecord['teamStage']>, names: readonly string[]): CanonicalCancellationTargets {
  const targets = canonicalTargets(stage)
  for (const name of names) {
    const member = stage.members.find(candidate => candidate.name === name || candidate.memberId === name || candidate.sessionId === name)
    if (member === undefined || member.name === undefined) throw new TeamCancellationError('cancellation target is not owned by this TeamStage')
  }
  return targets
}

/** Validate a public consistency list before the durable cancellation cutoff
 * is written. The list never becomes the cancellation target set. */
export function validateOwnedTeamMemberNames(stage: NonNullable<RunRecord['teamStage']>, names: readonly string[]): void {
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || name.trim().length === 0 || name.length > 256)) {
    throw new TeamCancellationError('owned teammate names must be explicit logical identifiers')
  }
  assertOwnedNames(stage, [...new Set(names)])
}

function taskDeleteView(value: unknown, taskId: string, expectedRevision: number): { id: string; revision: number; status: 'deleted' } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamCancellationError('native task delete returned a malformed response')
  }
  const task = value as Record<string, unknown>
  if (task.id !== taskId || task.revision !== expectedRevision + 1 || task.status !== 'deleted') {
    throw new TeamCancellationError('native task delete did not return the expected tombstone')
  }
  return { id: taskId, revision: expectedRevision + 1, status: 'deleted' }
}

interface CancellationEffectExpectation {
  effectId: string
  kind: string
  stageId: string
  teamId: string
  actorSessionId: string
  taskId?: string
  expectedTaskRevision?: number
  resultStatus: string
}

type CancellationEffectState = 'missing' | 'succeeded' | 'recovery_required'

/** Read a canonical cancellation effect without treating any native result as
 * replayable merely because its effect id matches. The effect binding and its
 * result identities are part of the durable authorization boundary. */
function cancellationEffectState(record: RunRecord, expected: CancellationEffectExpectation): CancellationEffectState {
  const effect: TeamEffectSnapshot | undefined = record.teamStage?.effects?.find(item => item.effectId === expected.effectId)
  if (effect === undefined) return 'missing'
  const bindingMatches =
    effect.kind === expected.kind &&
    effect.stageId === expected.stageId &&
    effect.teamId === expected.teamId &&
    effect.actorSessionId === expected.actorSessionId &&
    (expected.taskId === undefined ? effect.taskId === undefined : effect.taskId === expected.taskId)
  if (!bindingMatches || effect.state !== 'succeeded' || effect.ok !== true || effect.resultStatus !== expected.resultStatus) return 'recovery_required'
  if (expected.taskId !== undefined && (effect.resultTaskId !== expected.taskId || effect.resultTaskRevision !== expected.expectedTaskRevision! + 1))
    return 'recovery_required'
  return 'succeeded'
}

/**
 * Move the canonical stage to cancelling, validate any supplied consistency
 * names against the full canonical owned set, and settle known quiescence. An
 * interrupt error or a running target is treated as an unknown external
 * effect
 * and is durable as recovery_required; it is never converted into success.
 */
export async function cancelOwnedTeamStage(args: OwnedTeamCancellationArgs): Promise<RunRecord> {
  const names = requestedNames(args)
  const before = await args.store.get(args.runId)
  const stage = before.teamStage
  if (stage === undefined) throw new TeamStageConflictError(args.runId, 'stage binding is missing')
  if (['cancelled', 'succeeded', 'failed', 'timed_out', 'recovery_required'].includes(stage.state)) return before

  const targets = assertOwnedNames(stage, names)
  await args.store.updateTeamStage(args.runId, {
    state: 'cancelling',
    ...(stage.cancel === undefined
      ? {
          cancel: { requestedAt: Date.now(), ...(args.reason === undefined ? {} : { reason: args.reason.slice(0, 256) }) }
        }
      : {})
  })

  const cutover = await args.store.get(args.runId)
  const cutoffTaskId = cutover.teamStage?.taskId
  const cutoffTaskRevision = cutover.teamStage?.taskRevision
  const recoverPending = async (detail: string): Promise<RunRecord> => {
    const current = await args.store.get(args.runId)
    for (const effect of unresolvedTeamEffects(current)) {
      await recordTeamEffectRecovery(args.store, {
        runId: args.runId,
        stageId: effect.stageId,
        teamId: effect.teamId,
        effectId: effect.effectId,
        kind: effect.kind,
        actorSessionId: effect.actorSessionId,
        ...(effect.taskId === undefined ? {} : { taskId: effect.taskId }),
        ...(effect.memberId === undefined ? {} : { memberId: effect.memberId })
      }).catch(() => {})
    }
    return await args.store.updateTeamStage(args.runId, { state: 'recovery_required', recovery: { code: 'team-effect-unknown', detail } })
  }
  const recoverUnknown = async (detail: string): Promise<RunRecord> => {
    const current = await args.store.get(args.runId)
    if (current.teamStage?.state === 'recovery_required') return current
    if (unresolvedTeamEffects(current).length > 0) return await recoverPending(detail)
    return await args.store.updateTeamStage(args.runId, { state: 'recovery_required', recovery: { code: 'team-effect-unknown', detail } })
  }

  if (args.adapter === undefined || args.lead === undefined) {
    if (unresolvedTeamEffects(cutover).length > 0) return await recoverPending('cancellation-before-quiescence')
    if (targets.names.length === 0 && cutoffTaskId === undefined) {
      return await args.store.updateTeamStage(args.runId, { state: 'cancelled' })
    }
    return await recoverUnknown('native-cancellation-capability-unavailable')
  }

  let runningObserved = false
  try {
    for (const name of targets.names) {
      const result = await args.adapter.interrupt(args.lead, name)
      if (result === null || typeof result !== 'object' || !['running', 'inactive'].includes(result.previousStatus)) {
        throw new TeamCancellationError('native interrupt returned an invalid status')
      }
      if (result.previousStatus === 'running') runningObserved = true
    }
  } catch (cause) {
    const detail = cause instanceof TeamEffectUnknownError ? 'team-effect-unknown' : 'interrupt-outcome-unknown'
    return await recoverUnknown(detail)
  }

  if (unresolvedTeamEffects(await args.store.get(args.runId)).length > 0) return await recoverPending('cancellation-during-effect')

  const adapter = args.adapter
  if (targets.childSessionIds.length > 0 && typeof adapter.drainChildren === 'function') {
    try {
      const current = await args.store.get(args.runId)
      const stageId = current.teamStage?.stageId
      const teamId = current.teamStage?.teamId
      if (stageId === undefined || teamId === undefined) return await recoverUnknown('stage-binding-missing-after-cancel-cutoff')
      const effectId = `cancel-drain:${stageId}`
      const expected: CancellationEffectExpectation = {
        effectId,
        kind: 'drain',
        stageId,
        teamId,
        actorSessionId: args.lead.agent.id,
        resultStatus: 'drained'
      }
      const state = cancellationEffectState(current, expected)
      if (state === 'recovery_required') return await recoverUnknown('cancellation-drain-effect-not-replayable')
      if (state === 'missing') {
        const runner = new TeamStageRunner(args.store)
        await runner.dispatch({
          store: args.store,
          runId: args.runId,
          stageId,
          teamId,
          effectId,
          kind: 'drain',
          actorSessionId: args.lead.agent.id,
          effect: async () => {
            await adapter.drainChildren!(args.lead!, targets.childSessionIds)
            return true
          },
          result: () => ({ ok: true, status: 'drained' }),
          unknown: () => true
        })
      }
    } catch {
      return await args.store.get(args.runId)
    }
  } else if (runningObserved) {
    return await recoverUnknown('continuation-drain-capability-unavailable')
  }

  const afterDrain = await args.store.get(args.runId)
  const taskId = cutoffTaskId
  const taskRevision = cutoffTaskRevision
  if (taskId !== undefined && taskRevision !== undefined && (afterDrain.teamStage?.taskId !== taskId || afterDrain.teamStage.taskRevision !== taskRevision)) {
    return await recoverUnknown('task-binding-drift-after-cancel-cutoff')
  }
  if (taskId !== undefined && taskRevision !== undefined) {
    if (typeof adapter.updateTask !== 'function') return await recoverUnknown('task-delete-capability-unavailable')
    try {
      const current = await args.store.get(args.runId)
      const stageId = current.teamStage?.stageId
      const teamId = current.teamStage?.teamId
      if (stageId === undefined || teamId === undefined) return await recoverUnknown('stage-binding-missing-before-task-delete')
      const effectId = `cancel-task-delete:${taskId}:${taskRevision}`
      const expected: CancellationEffectExpectation = {
        effectId,
        kind: 'task-delete',
        stageId,
        teamId,
        actorSessionId: args.lead.agent.id,
        taskId,
        expectedTaskRevision: taskRevision,
        resultStatus: 'deleted'
      }
      const state = cancellationEffectState(current, expected)
      if (state === 'recovery_required') return await recoverUnknown('cancellation-task-delete-effect-not-replayable')
      if (state === 'missing') {
        const runner = new TeamStageRunner(args.store)
        await runner.dispatch({
          store: args.store,
          runId: args.runId,
          stageId,
          teamId,
          effectId,
          kind: 'task-delete',
          actorSessionId: args.lead.agent.id,
          taskId,
          effect: async () =>
            taskDeleteView(
              await adapter.updateTask!(args.lead!, {
                taskId,
                expectedRevision: taskRevision,
                action: 'delete'
              }),
              taskId,
              taskRevision
            ),
          result: value => ({ ok: true, taskId: value.id, taskRevision: value.revision, status: value.status }),
          unknown: () => true
        })
      }
    } catch {
      return await args.store.get(args.runId)
    }
  }

  return await args.store.updateTeamStage(args.runId, { state: 'cancelled' })
}
