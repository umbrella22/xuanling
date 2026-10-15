/** W2 Team task lifecycle. Native task writes are authorized by the exact
 * Lead handle, while the Blueprint RunStore remains the canonical stage fact. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RunStore } from '../persistence/run-store.ts'
import { TeamTaskConflictError } from '../persistence/run-store.ts'
import type { TeamNativeAdapter, LeadHandle, TeamCreateTaskRequest, TeamTaskAction } from './native-adapter.ts'
import { TeamStageRunner } from './runner.ts'

export interface TeamTaskCreateRequest {
  subject: string
  description: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
}

export interface TeamTaskViewLike {
  id: string
  revision: number
  status?: string
  [key: string]: unknown
}

export class TeamTaskBindingError extends Error {
  override readonly name = 'TeamTaskBindingError'
  readonly code: string
  constructor(code: string, detail: string) {
    super(detail)
    this.code = code
  }
}

function taskView(value: unknown): TeamTaskViewLike {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'native Team task response is not an object')
  }
  const candidate = value as Record<string, unknown>
  const revision = candidate.revision
  if (typeof candidate.id !== 'string' || candidate.id.length === 0 || typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'native Team task response lacks a stable id/revision')
  }
  return candidate as TeamTaskViewLike
}

function taskRequest(request: unknown): TeamCreateTaskRequest {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'task request must be an object')
  }
  const candidate = request as Record<string, unknown>
  if (
    typeof candidate.subject !== 'string' ||
    candidate.subject.trim().length === 0 ||
    typeof candidate.description !== 'string' ||
    candidate.description.trim().length === 0
  ) {
    throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'task subject and description are required')
  }
  if (candidate.blockedBy !== undefined && (!Array.isArray(candidate.blockedBy) || candidate.blockedBy.some(item => typeof item !== 'string'))) {
    throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'blockedBy must be a string array')
  }
  if (candidate.writeScopes !== undefined && (!Array.isArray(candidate.writeScopes) || candidate.writeScopes.some(item => typeof item !== 'string'))) {
    throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'writeScopes must be a string array')
  }
  return {
    subject: candidate.subject,
    description: candidate.description,
    ...(candidate.blockedBy === undefined ? {} : { blockedBy: [...(candidate.blockedBy as string[])] }),
    ...(candidate.writeScopes === undefined ? {} : { writeScopes: [...(candidate.writeScopes as string[])] })
  }
}

const TEAM_TASK_ACTIONS = new Set<TeamTaskAction>(['claim', 'release', 'edit', 'set_dependencies', 'complete', 'reopen', 'reassign', 'delete'])

function validateTaskFields(fields: unknown): asserts fields is Record<string, unknown> | undefined {
  if (fields === undefined) return
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'task fields must be an object')
  }
  const candidate = fields as Record<string, unknown>
  const allowed = new Set(['subject', 'description', 'blockedBy', 'writeScopes', 'owner'])
  if (Object.keys(candidate).some(key => !allowed.has(key))) throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'unsupported Team task field')
  for (const key of ['blockedBy', 'writeScopes']) {
    const value = candidate[key]
    if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) {
      throw new TeamTaskBindingError('TEAM_TASK_INVALID', `${key} must be a string array`)
    }
  }
  for (const key of ['subject', 'description', 'owner']) {
    const value = candidate[key]
    if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
      throw new TeamTaskBindingError('TEAM_TASK_INVALID', `${key} must be non-empty text`)
    }
  }
}

/** Persist intent and result/recovery through the common effect ledger before
 * touching the native Team task board. */
export async function createBoundTeamTask(args: {
  store: RunStore
  adapter: TeamNativeAdapter
  runId: string
  lead: LeadHandle
  request: TeamTaskCreateRequest
  effectId: string
}): Promise<TeamTaskViewLike> {
  const request = taskRequest(args.request)
  const existing = (await args.store.get(args.runId)).teamStage
  if (existing?.taskId !== undefined && existing.taskRevision !== undefined) {
    try {
      const replay = taskView(args.adapter.getTask(args.lead, existing.taskId))
      if (replay.id !== existing.taskId) throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'native replay returned a foreign task identity')
      return replay
    } catch (error) {
      await args.store
        .updateTeamStage(args.runId, { state: 'recovery_required', recovery: { code: 'task-replay-unknown', detail: existing.taskId } })
        .catch(() => {})
      if (error instanceof TeamTaskBindingError) throw error
      throw new TeamTaskBindingError('TEAM_EFFECT_UNKNOWN', 'native task replay outcome is unknown')
    }
  }
  const activeCreate = existing?.effects?.find(
    effect => effect.kind === 'create' && (effect.state === 'pending' || effect.state === 'succeeded' || effect.state === 'recovery_required')
  )
  if (activeCreate !== undefined && activeCreate.effectId !== args.effectId) {
    throw new TeamTaskBindingError('TEAM_EFFECT_UNKNOWN', 'a Team task create effect is already settled or unresolved')
  }

  const runner = new TeamStageRunner(args.store)
  const task = await runner.dispatch({
    store: args.store,
    runId: args.runId,
    stageId: existing?.stageId ?? '',
    teamId: args.lead.teamId,
    effectId: args.effectId,
    kind: 'create',
    actorSessionId: args.lead.agent.id,
    effect: async () => {
      const task = taskView(await args.adapter.createTask(args.lead, request))
      if (task.revision !== 1) throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'TeamStage requires revision-one task creation')
      return task
    },
    result: value => ({ ok: true, taskId: value.id, taskRevision: value.revision }),
    unknown: error => error instanceof TeamTaskBindingError && error.code === 'TEAM_TASK_INVALID'
  })

  try {
    await args.store.bindTeamTask(args.runId, { taskId: task.id, taskRevision: task.revision })
  } catch {
    await args.store.updateTeamStage(args.runId, { state: 'recovery_required', recovery: { code: 'task-binding-unknown', detail: task.id } }).catch(() => {})
    throw new TeamTaskConflictError(args.runId, 'native task was created but canonical binding failed')
  }
  return task
}

/** CAS update through the Lead service. The expected revision is checked both
 * against the canonical record and the native response before persistence. */
export async function updateBoundTeamTask(args: {
  store: RunStore
  adapter: TeamNativeAdapter
  runId: string
  lead: LeadHandle
  taskId: string
  expectedRevision: number
  action: TeamTaskAction
  fields?: Record<string, unknown>
}): Promise<TeamTaskViewLike> {
  const current = await args.store.get(args.runId)
  const stage = current.teamStage
  if (stage?.taskId !== args.taskId || stage.taskRevision !== args.expectedRevision) {
    throw new TeamTaskConflictError(args.runId, 'stale or foreign canonical task revision')
  }
  if (!TEAM_TASK_ACTIONS.has(args.action)) throw new TeamTaskBindingError('TEAM_TASK_INVALID', 'unsupported Team task action')
  validateTaskFields(args.fields)

  const effectId = `update:${args.taskId}:${args.expectedRevision}`
  const runner = new TeamStageRunner(args.store)
  const task = await runner.dispatch({
    store: args.store,
    runId: args.runId,
    stageId: stage.stageId,
    teamId: args.lead.teamId,
    effectId,
    kind: 'update',
    actorSessionId: args.lead.agent.id,
    taskId: args.taskId,
    effect: async () => {
      const task = taskView(
        await args.adapter.updateTask(args.lead, {
          taskId: args.taskId,
          expectedRevision: args.expectedRevision,
          action: args.action,
          ...args.fields
        })
      )
      if (task.id !== args.taskId || task.revision !== args.expectedRevision + 1) {
        throw new TeamTaskBindingError('TEAM_TASK_STALE_REVISION', 'native task response did not advance exactly one revision')
      }
      return task
    },
    result: value => ({ ok: true, taskId: value.id, taskRevision: value.revision }),
    unknown: error => error instanceof TeamTaskBindingError && (error.code === 'TEAM_TASK_INVALID' || error.code === 'TEAM_TASK_STALE_REVISION')
  })

  try {
    await args.store.updateTeamTaskRevision(args.runId, args.expectedRevision, task.revision)
  } catch (error) {
    await args.store
      .updateTeamStage(args.runId, { state: 'recovery_required', recovery: { code: 'task-revision-unknown', detail: args.taskId } })
      .catch(() => {})
    if (error instanceof TeamTaskConflictError) throw error
    throw new TeamTaskConflictError(args.runId, 'native task update was committed but canonical revision binding failed')
  }
  return task
}

export type { Agent }
