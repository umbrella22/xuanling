/** Strict TeamStage output acceptance.
 *
 * The public DTO is a request for acceptance. The host verdict is the fact
 * that makes it acceptable: it binds immutable artifact bytes, the frozen
 * schema, the exact graph Attempt and the primary member. Client supplied
 * digests and policy lists never create that fact.
 */
import {
  TEAM_KNOWN_CHECKS,
  teamHostArtifactVerdictSchema,
  teamMemberSnapshotSchema,
  teamOutputAcceptanceSchema,
  type TeamHostArtifactVerdict,
  type TeamMemberSnapshot,
  type TeamOutputAcceptance
} from '../persistence/records.ts'
import { TeamOutputRejectedError, TerminalStateError } from '../persistence/run-store.ts'
import type { RunStore } from '../persistence/run-store.ts'
import { isDeepStrictEqual } from 'node:util'
import { TeamArtifactError, TeamOutputArtifacts } from './output-artifact.ts'

export class TeamAcceptanceRejectedError extends Error {
  override readonly name = 'TeamAcceptanceRejectedError'
  readonly code = 'TEAM_ACCEPTANCE_REJECTED'
  constructor(
    readonly issueCode: string,
    detail = issueCode
  ) {
    super(detail)
  }
}

export interface TeamOutputArtifactRef {
  artifactId: string
  digest: string
  byteLength?: number
}

export interface TeamAcceptanceInput {
  store: RunStore
  runId: string
  output?: unknown
  acceptance?: unknown
  task?: { status?: string; id?: string; revision?: number }
  taskStatus?: string
  members?: readonly TeamMemberSnapshot[]
  requiredMemberIds?: readonly string[]
  requiredMemberPolicy?: { memberIds?: readonly string[]; requiredMemberIds?: readonly string[] }
  requiredChecks?: readonly string[]
  artifact?: TeamOutputArtifactRef
  /** Host-only immutable artifact and provenance verdict. */
  hostVerdict?: unknown
  /** Production host capability: verifies referenced physical bytes, never client digests. */
  artifacts?: TeamOutputArtifacts
  /** Existing graph Attempt and the verified primary output for settlement. */
  attemptId?: string
  outputs?: Record<string, unknown>
}

const DTO_KEYS = new Set([
  'code',
  'schemaVersion',
  'runId',
  'stageId',
  'taskId',
  'attemptId',
  'sourceSessionId',
  'artifactId',
  'digest',
  'evidenceDigest',
  'checks',
  'issueCode'
])
const BASE_CHECKS = [...TEAM_KNOWN_CHECKS]

function reject(code: string, detail = code): never {
  throw new TeamAcceptanceRejectedError(code, detail)
}

function strictCandidate(value: unknown): TeamOutputAcceptance {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) reject('output-not-object')
  const candidate = value as Record<string, unknown>
  for (const key of Object.keys(candidate)) if (!DTO_KEYS.has(key)) reject('unknown-output-field')
  const parsed = teamOutputAcceptanceSchema.safeParse(candidate)
  if (!parsed.success) reject('schema-invalid')
  return parsed.data as TeamOutputAcceptance
}

function hostVerdict(value: unknown): TeamHostArtifactVerdict {
  const parsed = teamHostArtifactVerdictSchema.safeParse(value)
  if (!parsed.success) reject('host-verdict-required')
  return parsed.data as TeamHostArtifactVerdict
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && left.every(value => right.includes(value))
}

function sameAcceptance(left: TeamOutputAcceptance, right: TeamOutputAcceptance): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function memberFor(stageMembers: readonly TeamMemberSnapshot[], id: string): TeamMemberSnapshot | undefined {
  return stageMembers.find(candidate => candidate.memberId === id)
}

function memberIsAuthorized(stageMembers: readonly TeamMemberSnapshot[], sourceSessionId: string, leadSessionId: string): boolean {
  if (sourceSessionId === leadSessionId) return true
  const member = stageMembers.find(candidate => candidate.sessionId === sourceSessionId)
  return member !== undefined && member.phase !== 'failed' && member.phase !== 'provisioning' && member.status !== 'failed' && member.status !== 'provisioning'
}

function currentMemberEvidence(member: TeamMemberSnapshot, stage: NonNullable<Awaited<ReturnType<RunStore['get']>>['teamStage']>, attemptId: string): boolean {
  const evidence = member.evidence
  return (
    member.sessionId !== undefined &&
    evidence !== undefined &&
    evidence.runId === stage.runId &&
    evidence.stageId === stage.stageId &&
    evidence.taskId === stage.taskId &&
    evidence.attemptId === attemptId &&
    evidence.captureId.length > 0 &&
    evidence.completedTurnId.length > 0 &&
    evidence.flushedAt >= 0 &&
    evidence.quiescentAt >= evidence.flushedAt &&
    member.phase === 'active' &&
    !['failed', 'provisioning', 'running'].includes(member.status)
  )
}

function requiredMembersSatisfied(
  stageMembers: readonly TeamMemberSnapshot[],
  ids: readonly string[],
  stage: NonNullable<Awaited<ReturnType<RunStore['get']>>['teamStage']>,
  attemptId: string
): boolean {
  return ids.every(id => {
    const member = memberFor(stageMembers, id)
    return member !== undefined && currentMemberEvidence(member, stage, attemptId)
  })
}

function requiredChecks(stage: NonNullable<Awaited<ReturnType<RunStore['get']>>['teamStage']>): string[] {
  const configured = stage.requiredChecks ?? []
  if (configured.some(check => !TEAM_KNOWN_CHECKS.includes(check as (typeof TEAM_KNOWN_CHECKS)[number]))) reject('unknown-required-check')
  return [...new Set([...BASE_CHECKS, ...configured])]
}

function requireUnreducedPolicy(args: TeamAcceptanceInput, memberIds: string[], checks: string[]): void {
  const requestedMembers = args.requiredMemberIds ?? args.requiredMemberPolicy?.requiredMemberIds ?? args.requiredMemberPolicy?.memberIds
  if (requestedMembers !== undefined && !sameSet([...requestedMembers], memberIds)) reject('required-member-policy-override')
  if (args.requiredChecks !== undefined && !sameSet([...args.requiredChecks], checks)) reject('required-check-policy-override')
}

/** Validate the host verdict and settle the existing graph Attempt atomically. */
export async function acceptTeamOutput(args: TeamAcceptanceInput): Promise<Awaited<ReturnType<RunStore['get']>>> {
  const candidate = strictCandidate(args.output ?? args.acceptance)
  // Detach the verification inputs before the first await. Store/context
  // objects are capabilities, not part of the immutable acceptance facts.
  args = {
    store: args.store,
    runId: args.runId,
    ...(args.artifacts === undefined ? {} : { artifacts: args.artifacts }),
    ...structuredClone({
      ...(args.task === undefined ? {} : { task: args.task }),
      ...(args.taskStatus === undefined ? {} : { taskStatus: args.taskStatus }),
      ...(args.members === undefined ? {} : { members: args.members }),
      ...(args.requiredMemberIds === undefined ? {} : { requiredMemberIds: args.requiredMemberIds }),
      ...(args.requiredMemberPolicy === undefined ? {} : { requiredMemberPolicy: args.requiredMemberPolicy }),
      ...(args.requiredChecks === undefined ? {} : { requiredChecks: args.requiredChecks }),
      ...(args.artifact === undefined ? {} : { artifact: args.artifact }),
      ...(args.hostVerdict === undefined ? {} : { hostVerdict: args.hostVerdict }),
      ...(args.attemptId === undefined ? {} : { attemptId: args.attemptId }),
      ...(args.outputs === undefined ? {} : { outputs: args.outputs })
    })
  }
  const current = await args.store.get(args.runId)
  let stage = structuredClone(current.teamStage)
  if (stage === undefined) reject('stage-binding-missing')
  if (candidate.code === 'accepted' && args.artifacts !== undefined) {
    if (!(args.artifacts instanceof TeamOutputArtifacts)) reject('artifact-verifier-required')
    if (args.task?.id === undefined || args.task.revision === undefined || args.task.status === undefined) reject('task-binding-unverified')
    try {
      const verified = await args.artifacts.verifyStage({
        store: args.store,
        runId: args.runId,
        task: { id: args.task.id, revision: args.task.revision, status: args.task.status }
      })
      if (verified.definitionRevision !== current.definitionRevision) reject('artifact-binding-mismatch')
      if (args.outputs !== undefined && !isDeepStrictEqual(args.outputs, verified.outputs)) reject('artifact-output-value-mismatch')
      args.outputs = verified.outputs
      args.hostVerdict = verified.hostVerdict
      stage = verified.stage
    } catch (error) {
      if (error instanceof TeamArtifactError) reject(error.issueCode)
      throw error
    }
  }
  if (candidate.runId !== args.runId || candidate.stageId !== stage.stageId || candidate.taskId !== stage.taskId) reject('foreign-binding')
  if (!memberIsAuthorized(stage.members, candidate.sourceSessionId, stage.leadSessionId)) reject('foreign-source-session')
  if (candidate.code === 'rejected' && candidate.issueCode === undefined) reject('rejection-reason-missing')

  if (args.members !== undefined) {
    if (!Array.isArray(args.members)) reject('member-observation-invalid')
    for (const observed of args.members) {
      if (!teamMemberSnapshotSchema.safeParse(observed).success) reject('member-observation-invalid')
      const canonical = memberFor(stage.members, observed.memberId)
      if (canonical === undefined || canonical.phase !== observed.phase || canonical.status !== observed.status) reject('member-observation-conflict')
    }
  }
  if (stage.outputAcceptance !== undefined) {
    if (!sameAcceptance(stage.outputAcceptance, candidate)) reject('acceptance-conflict')
    if (candidate.code === 'rejected') return current
  }
  const acceptedReplay = stage.outputAcceptance?.code === 'accepted'
  if (['cancelling', 'cancelled', 'recovery_required', 'failed', 'timed_out'].includes(current.state) || (current.state === 'succeeded' && !acceptedReplay))
    reject('run-not-accepting')
  if (['cancelling', 'cancelled', 'recovery_required', 'failed', 'timed_out'].includes(stage.state) || (stage.state === 'succeeded' && !acceptedReplay))
    reject('stage-not-accepting')
  if (candidate.code === 'rejected') return await args.store.recordTeamOutputAcceptance(args.runId, candidate)

  const attemptId = args.attemptId ?? stage.attemptId
  if (attemptId === undefined || stage.attemptId !== attemptId) reject('attempt-settlement-required')
  const verdict = hostVerdict(args.hostVerdict)
  if (
    verdict.runId !== stage.runId ||
    verdict.stageId !== stage.stageId ||
    verdict.taskId !== stage.taskId ||
    verdict.attemptId !== attemptId ||
    verdict.producerSessionId !== candidate.sourceSessionId ||
    verdict.artifactId !== candidate.artifactId ||
    verdict.digest !== candidate.digest ||
    verdict.evidenceDigest !== candidate.evidenceDigest ||
    verdict.status !== 'verified'
  )
    reject('host-verdict-binding-mismatch')
  if (verdict.byteLength <= 0) reject('artifact-empty')
  if (
    args.artifact !== undefined &&
    (args.artifact.artifactId !== verdict.artifactId ||
      args.artifact.digest !== verdict.digest ||
      (args.artifact.byteLength !== undefined && args.artifact.byteLength !== verdict.byteLength))
  )
    reject('artifact-verdict-mismatch')

  const requiredIds = stage.requiredMemberIds ?? stage.members.map(member => member.memberId)
  const checks = requiredChecks(stage)
  requireUnreducedPolicy(args, requiredIds, checks)
  if (!checks.every(check => candidate.checks.includes(check))) reject('required-check-missing')
  if (stage.effects?.some(effect => effect.state === 'pending')) reject('pending-team-effect')
  if (stage.primaryMemberId !== undefined && verdict.producerMemberId !== stage.primaryMemberId) reject('producer-policy-mismatch')
  const producer = memberFor(stage.members, verdict.producerMemberId)
  if (producer === undefined || !requiredIds.includes(verdict.producerMemberId)) reject('producer-policy-mismatch')
  if (!requiredMembersSatisfied(stage.members, requiredIds, stage, attemptId)) reject('required-member-policy-unsatisfied')
  if (producer.sessionId !== verdict.producerSessionId) reject('producer-policy-mismatch')
  if (args.task === undefined || args.task.id !== stage.taskId || args.task.revision !== stage.taskRevision) reject('task-binding-unverified')
  if (args.taskStatus !== undefined && args.taskStatus !== args.task.status) reject('task-observation-conflict')
  if (args.task.status !== 'completed') reject('task-not-completed')
  if (args.outputs === undefined || args.outputs === null || typeof args.outputs !== 'object' || Array.isArray(args.outputs)) reject('attempt-outputs-required')

  try {
    return await args.store.settleTeamStageAttempt(args.runId, {
      attemptId,
      acceptance: candidate,
      outputs: args.outputs,
      evidence: 'host-artifact-verified',
      verification: { definitionRevision: current.definitionRevision, stage, hostVerdict: verdict }
    })
  } catch (error) {
    if (error instanceof TeamOutputRejectedError) throw new TeamAcceptanceRejectedError(error.issueCode)
    if (error instanceof TeamArtifactError) throw new TeamAcceptanceRejectedError(error.issueCode)
    if (error instanceof TerminalStateError) throw new TeamAcceptanceRejectedError('run-not-accepting')
    throw error
  }
}
