import { createHash } from 'node:crypto'
import type { BlueprintDefinition, GraphNode, TeamStageConfig } from '../definition/types.ts'
import type { AttemptRecord, RunRecord, TeamStageRecord } from '../persistence/records.ts'

const ACTIVE_ATTEMPT_STATES = new Set(['preparing', 'ready', 'running'])
const TERMINAL_STAGE_STATES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'])

type ActiveAgentAttempt = AttemptRecord & {
  intent: NonNullable<AttemptRecord['intent']> & { kind: 'agentTask' }
}

/**
 * A public TeamStage request is an assertion about a frozen Run, not a second
 * definition format. Keep this error on the existing redacted TeamStage
 * conflict vocabulary so the host can expose the same stable wire code.
 */
export class FrozenTeamStageBoundaryError extends Error {
  override readonly name = 'FrozenTeamStageBoundaryError'
  readonly code = 'TEAM_STAGE_CONFLICT'
  constructor(
    readonly runId: string,
    readonly issueCode: string
  ) {
    super(`frozen TeamStage boundary rejected for ${runId}: ${issueCode}`)
  }
}

export interface FrozenTeamStageRequest {
  sessionId: string
  stageId: string
  taskSpecificationFingerprint: string
  subject: string
  description: string
  blockedBy?: readonly string[] | undefined
  writeScopes?: readonly string[] | undefined
}

export interface FrozenTeamStageAdmission {
  node: GraphNode & { kind: 'agentTask'; teamStage: TeamStageConfig }
  attempt: AttemptRecord
  task: TeamStageConfig['task']
  taskSpecificationFingerprint: string
  existingStage?: TeamStageRecord
}

/** The fingerprint has the same semantic inputs as the automatic driver. */
export function frozenTeamTaskSpecificationFingerprint(config: TeamStageConfig, resourceDigests: Record<string, string>): string {
  return createHash('sha256')
    .update(JSON.stringify({ config, resources: resourceDigests }))
    .digest('hex')
}

function reject(runId: string, issueCode: string): never {
  throw new FrozenTeamStageBoundaryError(runId, issueCode)
}

function assertActiveAttempt(record: RunRecord, attempt: AttemptRecord): ActiveAgentAttempt {
  if (attempt.intent === undefined) reject(record.runId, 'teamstage-attempt-intent-missing')
  if (attempt.intent.kind !== 'agentTask') reject(record.runId, 'teamstage-attempt-kind-mismatch')
  if (!ACTIVE_ATTEMPT_STATES.has(attempt.state) || attempt.result !== undefined) reject(record.runId, 'teamstage-attempt-not-ready')
  return attempt as ActiveAgentAttempt
}

function activeAttempt(record: RunRecord, stageId: string): AttemptRecord {
  const matches = record.attempts.filter(attempt => attempt.nodeId === stageId)
  if (matches.length !== 1) reject(record.runId, matches.length === 0 ? 'teamstage-attempt-missing' : 'teamstage-attempt-ambiguous')
  return assertActiveAttempt(record, matches[0]!)
}

/**
 * Resolve all public TeamStage semantics from the Run's frozen definition and
 * original Attempt. This is deliberately before bind/createTask: a client can
 * provide opaque IDs and matching-format digests, but cannot choose the node,
 * task text, resource set, source root or Attempt that receives the effect.
 */
export function resolveFrozenTeamStageAdmission(record: RunRecord, definition: BlueprintDefinition, request: FrozenTeamStageRequest): FrozenTeamStageAdmission {
  if (record.source?.sessionId !== request.sessionId) reject(record.runId, 'teamstage-source-mismatch')
  const candidate = definition.graph.nodes.find(node => node.id === request.stageId)
  if (candidate === undefined) reject(record.runId, 'teamstage-node-not-found')
  if (candidate.kind !== 'agentTask' || candidate.teamStage === undefined) reject(record.runId, 'teamstage-node-kind-mismatch')

  const attempt =
    record.teamStage?.attemptId === undefined
      ? activeAttempt(record, request.stageId)
      : (() => {
          const bound = record.attempts.find(value => value.attemptId === record.teamStage!.attemptId && value.nodeId === request.stageId)
          if (bound === undefined) reject(record.runId, 'teamstage-attempt-binding-missing')
          return bound
        })()
  const active = assertActiveAttempt(record, attempt)

  const fingerprint = frozenTeamTaskSpecificationFingerprint(candidate.teamStage, active.intent.resourceDigests)
  if (request.taskSpecificationFingerprint !== fingerprint) reject(record.runId, 'teamstage-task-specification-mismatch')
  if (request.subject !== candidate.teamStage.task.subject || request.description !== candidate.teamStage.task.description) {
    reject(record.runId, 'teamstage-task-text-mismatch')
  }
  if (request.blockedBy !== undefined || request.writeScopes !== undefined) reject(record.runId, 'teamstage-task-policy-is-not-frozen')

  const existingStage = record.teamStage
  if (existingStage !== undefined) {
    if (existingStage.stageId !== candidate.id || existingStage.attemptId !== active.attemptId || existingStage.taskSpecificationFingerprint !== fingerprint)
      reject(record.runId, 'teamstage-binding-mismatch')
    if (TERMINAL_STAGE_STATES.has(existingStage.state) && existingStage.state === 'recovery_required') {
      reject(record.runId, 'teamstage-recovery-required')
    }
  } else if (record.state !== 'running') {
    reject(record.runId, 'teamstage-run-not-active')
  }

  return {
    node: candidate as GraphNode & { kind: 'agentTask'; teamStage: TeamStageConfig },
    attempt: active,
    task: structuredClone(candidate.teamStage.task),
    taskSpecificationFingerprint: fingerprint,
    ...(existingStage === undefined ? {} : { existingStage })
  }
}
