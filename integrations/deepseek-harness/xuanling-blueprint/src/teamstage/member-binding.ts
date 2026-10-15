/** Durable Team member provisioning and lifecycle snapshots. */
import type { RunStore } from '../persistence/run-store.ts'
import type { TeamMemberSnapshot } from '../persistence/records.ts'
import { TeamStageConflictError } from '../persistence/run-store.ts'
import { TeamStageRunner } from './runner.ts'
import { memberSnapshot, type LeadHandle, type TeamNativeAdapter, type TeamSpawnTeammateRequest } from './native-adapter.ts'

export class TeamMemberBindingError extends Error {
  override readonly name = 'TeamMemberBindingError'
  readonly code: string
  constructor(code: string, detail: string) {
    super(detail)
    this.code = code
  }
}

function spawnRequest(value: unknown): TeamSpawnTeammateRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'member request must be an object')
  }
  const request = value as Record<string, unknown>
  if (typeof request.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(request.name)) {
    throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'member name must be a lowercase logical identifier')
  }
  if (typeof request.description !== 'string' || request.description.trim().length === 0) {
    throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'member description is required')
  }
  if (!Array.isArray(request.prompt)) throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'member prompt must be an array')
  if (request.context !== 'fresh' && request.context !== 'fork') throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'member context is invalid')
  if (typeof request.provider !== 'string' || request.provider.trim().length === 0)
    throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'member provider is required')
  if (!(request.signal instanceof AbortSignal)) throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'member signal is required')
  return {
    name: request.name,
    description: request.description,
    prompt: request.prompt,
    context: request.context,
    provider: request.provider,
    signal: request.signal
  }
}

function memberResult(value: unknown, expectedName: string): TeamMemberSnapshot {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'native Team member response is not an object')
  }
  const record = value as Record<string, unknown>
  const snapshot = memberSnapshot(record.member ?? record)
  if (snapshot.name !== expectedName) throw new TeamMemberBindingError('TEAM_MEMBER_INVALID', 'native Team member identity does not match the requested name')
  return snapshot
}

/** Spawn one declared teammate only after the stage effect intent is durable. */
export async function spawnBoundTeamMember(args: {
  store: RunStore
  adapter: TeamNativeAdapter
  runId: string
  lead: LeadHandle
  request: unknown
  effectId: string
}): Promise<TeamMemberSnapshot> {
  const request = spawnRequest(args.request)
  const current = await args.store.get(args.runId)
  const stage = current.teamStage
  if (stage === undefined) throw new TeamStageConflictError(args.runId, 'stage binding is missing')
  const existing = stage.members.find(member => member.name === request.name)
  if (existing !== undefined) return existing

  const runner = new TeamStageRunner(args.store)
  const member = await runner.dispatch({
    store: args.store,
    runId: args.runId,
    stageId: stage.stageId,
    teamId: args.lead.teamId,
    effectId: args.effectId,
    kind: 'spawn',
    actorSessionId: args.lead.agent.id,
    memberName: request.name,
    effect: async () => memberResult(await args.adapter.spawnTeammate(args.lead, request), request.name),
    result: value => ({ ok: value.phase !== 'failed', memberId: value.memberId, status: value.status }),
    unknown: error => error instanceof TeamMemberBindingError || error instanceof TeamStageConflictError
  })

  try {
    await args.store.upsertTeamMember(args.runId, member)
    if (member.phase === 'failed') await args.store.updateTeamStage(args.runId, { state: 'failed' as const })
  } catch (error) {
    await args.store
      .updateTeamStage(args.runId, { state: 'recovery_required', recovery: { code: 'member-binding-unknown', detail: member.memberId } })
      .catch(() => {})
    if (error instanceof TeamMemberBindingError) throw error
    throw new TeamMemberBindingError('TEAM_EFFECT_UNKNOWN', 'native member was created but canonical binding failed')
  }
  return member
}
