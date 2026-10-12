/**
 * RunStore (C-08): durable RunAggregate on a real storage domain. Every
 * state change is one single-record `table.update` (atomic sync RMW —
 * W0.3 evidence); the transition is appended to the in-record log with a
 * monotonic seq. External effects must be ordered through `recordIntent`
 * (durable BEFORE dispatch) and settled with `recordResult`; a run whose
 * last intent has no result reopens as recovery_required (see
 * ./recovery.ts in W3.3).
 */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { runSourceCodec, type RunSource } from '../conversation/contracts.ts'
import { attemptDiagnosticsCodec, type AttemptDiagnostics } from '../host/runtime-diagnostics.ts'
import { teamStageExecutionCodec, type TeamStageExecution } from '../host/teamstage-diagnostics.ts'
import type { DomainLike, KvTableLike } from './domain.ts'
import type { CommandRecord } from './records.ts'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  artifactDigest, artifactReject, canonicalJson, frozenArtifactNode, fullArtifactPolicy,
  memberEvidenceForArtifact, requireArtifactStageWritable, TeamArtifactError, validateCaptureArtifactBinding,
} from '../teamstage/artifact-contract.ts'
import {
  TERMINAL_RUN_STATES,
  TEAM_STAGE_SCHEMA_VERSION,
  teamStageBindingSchema,
  teamOutputAcceptanceSchema,
  teamHostArtifactVerdictSchema,
  teamMemberSnapshotSchema,
  teamStageRecordSchema,
  teamCaptureArtifactRefSchema,
  teamMemberReservationSchema,
  type AttemptRecord,
  type RunRecord,
  type RunState,
  type TeamMemberSnapshot,
  type TeamHostArtifactVerdict,
  type TeamOutputAcceptance,
  type TeamStageRecord,
  type TeamStageState,
  type TeamMemberReservation,
  type TeamCaptureArtifactRef,
} from './records.ts'
import { CommandAdmission, CommandConflictError, DurabilityFailureError, newRunId, type AdmissionRequest, type AdmissionResult } from './command-admission.ts'

const LOG_CAP = 200
const ACTIVE_TEAM_ATTEMPT_STATES = new Set(['preparing', 'ready', 'running'])

export class AttemptSettledError extends Error {
  readonly code = 'ATTEMPT_SETTLED_CONFLICT'
  constructor() { super('Attempt intent/result is immutable; an explicit new Attempt is required') }
}
export class DecisionConflictError extends Error {
  readonly code = 'DECISION_CONFLICT'
  constructor() { super('decision conflicts with the durable waiting/settled Attempt') }
}

export class TeamStageConflictError extends Error {
  override readonly name = 'TeamStageConflictError'
  readonly code = 'TEAM_STAGE_CONFLICT'
  constructor(readonly runId: string, detail: string) { super(`team stage conflict for ${runId}: ${detail}`) }
}

export class TeamTaskConflictError extends Error {
  override readonly name = 'TeamTaskConflictError'
  readonly code = 'TEAM_TASK_CONFLICT'
  constructor(readonly runId: string, detail: string) { super(`team task conflict for ${runId}: ${detail}`) }
}

export class TeamOutputRejectedError extends Error {
  override readonly name = 'TeamOutputRejectedError'
  readonly code = 'TEAM_OUTPUT_REJECTED'
  constructor(readonly runId: string, readonly issueCode: string) { super(`team output rejected for ${runId}: ${issueCode}`) }
}

export class TeamEffectReplayError extends Error {
  override readonly name = 'TeamEffectReplayError'
  readonly code = 'TEAM_EFFECT_SETTLED'
  constructor(detail = 'Team external effect has already been settled; replay requires a new effect identity') { super(detail) }
}

/** Abort an RMW without writing when another store already committed the exact settlement. */
class TeamSettlementReplay extends Error {
  constructor(readonly record: RunRecord) { super('TeamStage settlement already committed') }
}

export interface TeamStageBinding {
  stageId: string
  teamId: string
  leadSessionId: string
  taskSpecificationFingerprint: string
  attemptId?: string
  requiredMemberIds?: string[]
  requiredChecks?: string[]
  primaryMemberId?: string
}

const teamTaskBindingSchema = z.strictObject({ taskId: z.string().min(1), taskRevision: z.number().int().positive() })
type TeamTaskBinding = z.infer<typeof teamTaskBindingSchema>

export class RunNotFoundError extends Error {
  override readonly name = 'RunNotFoundError'
  readonly code = 'RUN_NOT_FOUND'
  constructor(readonly runId: string) {
    super(`run ${runId} not found`)
  }
}

export class TerminalStateError extends Error {
  override readonly name = 'TerminalStateError'
  readonly code = 'TERMINAL_STATE_IMMUTABLE'
  constructor(runId: string, state: RunState) {
    super(`run ${runId} is terminal (${state}); transitions are immutable`)
  }
}

export class RunStore {
  private readonly runs: KvTableLike<string, RunRecord>
  private readonly commands: KvTableLike<string, CommandRecord>
  readonly admission: CommandAdmission
  private readonly queues = new Map<string, Promise<unknown>>()

  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(key) ?? Promise.resolve()).then(task)
    const tail = result.catch(() => {})
    this.queues.set(key, tail)
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key) })
    return result
  }

  constructor(domain: DomainLike) {
    this.runs = domain.table('runs') as KvTableLike<string, RunRecord>
    this.commands = domain.table('commands') as KvTableLike<string, CommandRecord>
    this.admission = new CommandAdmission(this.commands)
  }

  /** Read-only replay lookup BEFORE any new capability check or snapshot.
   * Never admits a new command. The service serializes this with admission. */
  async replayRun(request: AdmissionRequest): Promise<RunRecord | undefined> {
    const key = CommandAdmission.commandKey(request.scope, request.requestId)
    let existing: CommandRecord | undefined
    try { existing = await this.commands.get(key) }
    catch (cause) { throw new DurabilityFailureError('command-replay-read', cause) }
    if (!existing) return undefined
    if (existing.payloadFingerprint !== request.payloadFingerprint) {
      throw new CommandConflictError(key, existing.payloadFingerprint, request.payloadFingerprint)
    }
    if (existing.runId !== null) return await this.get(existing.runId)
    // Crash after runs.put but before bind: discover the original aggregate,
    // without mutating/refreezing it merely to acknowledge the command again.
    for (const id of await this.listRunIds()) {
      const run = await this.get(id)
      if (run.commandKey === key) return run
    }
    return undefined
  }

  /** Admit a start command and create the run aggregate. Replay with the
   * same fingerprint returns the original run without side effects. */
  async createRun(request: AdmissionRequest, definitionRevision: string, definitionJson: string, inputRef: string, metadata: { blueprintId?: string; source?: RunSource } = {}): Promise<{ runId: string; replayed: boolean }> {
    const frozen = z.strictObject({ blueprintId: z.string().min(1).optional(), source: runSourceCodec().optional() }).parse(metadata)
    return await this.serial('admission', () => this.createRunSerial(request, definitionRevision, definitionJson, inputRef, { ...(frozen.blueprintId === undefined ? {} : { blueprintId: frozen.blueprintId }), ...(frozen.source === undefined ? {} : { source: frozen.source }) }))
  }

  private async createRunSerial(request: AdmissionRequest, definitionRevision: string, definitionJson: string, inputRef: string, metadata: { blueprintId?: string; source?: RunSource } = {}): Promise<{ runId: string; replayed: boolean }> {
    const admitted: AdmissionResult = await this.admission.admit(request)
    if (admitted.replayed && admitted.runId !== null) {
      return { runId: admitted.runId, replayed: true }
    }
    // A crash between runs.put and command bind must not create a second Run.
    if (admitted.replayed) {
      for (const id of await this.listRunIds()) {
        if ((await this.get(id)).commandKey === admitted.commandKey) {
          await this.admission.bindRun(admitted.commandKey, id)
          return { runId: id, replayed: true }
        }
      }
    }
    const runId = newRunId()
    const now = Date.now()
    const record: RunRecord = {
      ...metadata,
      runId,
      definitionRevision,
      definitionJson,
      inputRef,
      commandKey: admitted.commandKey,
      state: 'queued',
      attempts: [],
      log: [{ seq: 0, at: now, kind: 'admitted', detail: { scope: request.scope, requestId: request.requestId } }],
      seq: 0,
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.runs.put(runId, record)
      await this.admission.bindRun(admitted.commandKey, runId)
    } catch (cause) {
      throw new DurabilityFailureError(`run create ${runId}`, cause)
    }
    return { runId, replayed: false }
  }

  async get(runId: string): Promise<RunRecord> {
    const record = await this.tryGet(runId)
    if (record === undefined) throw new RunNotFoundError(runId)
    return record
  }

  async tryGet(runId: string): Promise<RunRecord | undefined> {
    try { return await this.runs.get(runId) }
    catch (cause) { throw new DurabilityFailureError('run read', cause) }
  }

  /** Bind the canonical stage fact before any Team task effect. This is a
   * single-record serial RMW and is deliberately independent of native Team
   * APIs (W1 has no external effects). Replaying the exact binding is safe. */
  async bindTeamStage(runId: string, binding: TeamStageBinding): Promise<RunRecord> {
    let parsedBinding: TeamStageBinding
    try { parsedBinding = teamStageBindingSchema.parse(binding) as TeamStageBinding }
    catch { throw new TeamStageConflictError(runId, 'stage, team, lead and task specification identities are required') }
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      const existing = current.teamStage
      if (existing !== undefined) {
        assertActiveTeamStageAttempt(current, parsedBinding, runId)
        const same = existing.stageId === parsedBinding.stageId && existing.teamId === parsedBinding.teamId
          && existing.leadSessionId === parsedBinding.leadSessionId
          && existing.taskSpecificationFingerprint === parsedBinding.taskSpecificationFingerprint
          && existing.attemptId === parsedBinding.attemptId
          && JSON.stringify(existing.requiredMemberIds ?? []) === JSON.stringify(parsedBinding.requiredMemberIds ?? [])
          && JSON.stringify(existing.requiredChecks ?? []) === JSON.stringify(parsedBinding.requiredChecks ?? [])
          && existing.primaryMemberId === parsedBinding.primaryMemberId
        if (!same) throw new TeamStageConflictError(runId, 'a different stage/team/lead binding already exists')
        return current
      }
      return await this.applyTransition(runId, draft => {
        const now = Date.now()
        assertActiveTeamStageAttempt(draft, parsedBinding, runId)
        const candidate: TeamStageRecord = {
          schemaVersion: TEAM_STAGE_SCHEMA_VERSION,
          ...parsedBinding,
          runId,
          state: 'provisioning',
          members: [],
          updatedAt: now,
        }
        draft.teamStage = teamStageRecordSchema.parse(candidate) as TeamStageRecord
        draft.log.push({ seq: draft.seq + 1, at: now, kind: 'state', detail: { teamStage: 'bound', stageId: parsedBinding.stageId, teamId: parsedBinding.teamId } })
      })
    })
  }

  /**
   * Settle the TeamStage and its existing graph Attempt in one serialized
   * record update. External Team effects and artifact writes happen before
   * this method; this reducer only commits already verified, redacted facts.
   */
  async settleTeamStageAttempt(runId: string, args: {
    attemptId: string
    acceptance: TeamOutputAcceptance
    outputs: Record<string, unknown>
    evidence?: string
    verification: { definitionRevision: string; stage: TeamStageRecord; hostVerdict: TeamHostArtifactVerdict }
  }): Promise<RunRecord> {
    let acceptance: TeamOutputAcceptance
    try { acceptance = teamOutputAcceptanceSchema.parse(args.acceptance) as TeamOutputAcceptance }
    catch { throw new TeamOutputRejectedError(runId, 'malformed-acceptance') }
    if (acceptance.code !== 'accepted') throw new TeamOutputRejectedError(runId, 'accepted-settlement-required')
    const attemptId = args.attemptId
    const outputs = structuredClone(args.outputs)
    const evidence = args.evidence ?? 'team-stage-accepted'
    let verification: typeof args.verification
    try {
      verification = {
        definitionRevision: args.verification.definitionRevision,
        stage: teamStageRecordSchema.parse(args.verification.stage) as TeamStageRecord,
        hostVerdict: teamHostArtifactVerdictSchema.parse(args.verification.hostVerdict) as TeamHostArtifactVerdict,
      }
    } catch { throw new TeamOutputRejectedError(runId, 'host-verdict-required') }
    const expected = verification.stage
    const provenance = { definitionRevision: verification.definitionRevision, taskRevision: expected.taskRevision, hostVerdict: verification.hostVerdict }
    const isReplay = (record: RunRecord): boolean => {
      const stage = record.teamStage
      if (stage?.outputAcceptance === undefined) return false
      if (!sameTeamOutputAcceptance(stage.outputAcceptance, acceptance)) throw new TeamOutputRejectedError(runId, 'acceptance-conflict')
      const attempt = record.attempts.find(candidate => candidate.attemptId === attemptId)
      if (stage.state !== 'succeeded' || stage.attemptId !== attemptId || attempt?.state !== 'succeeded' || attempt.result?.ok !== true) {
        throw new TeamOutputRejectedError(runId, 'attempt-already-settled')
      }
      const outcome = attempt.result.outcome as { outputs?: unknown; teamVerification?: unknown } | undefined
      if (!isDeepStrictEqual(outcome?.outputs, outputs)) throw new TeamOutputRejectedError(runId, 'acceptance-conflict')
      if (!isDeepStrictEqual(outcome?.teamVerification, provenance)) throw new TeamOutputRejectedError(runId, 'host-verdict-binding-mismatch')
      if (['cancelling', 'cancelled', 'recovery_required', 'failed', 'timed_out'].includes(record.state)) throw new TeamOutputRejectedError(runId, 'run-not-accepting')
      return true
    }
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      if (isReplay(current)) return current
      try {
        return await this.applyTransition(runId, draft => {
          if (draft.state === 'cancelling' || draft.state === 'recovery_required') throw new TeamOutputRejectedError(runId, 'run-not-accepting')
          const stage = draft.teamStage
          if (stage === undefined) throw new TeamOutputRejectedError(runId, 'stage-binding-missing')
          if (stage.attemptId !== attemptId || expected.attemptId !== attemptId) throw new TeamOutputRejectedError(runId, 'attempt-binding-mismatch')
          if (acceptance.attemptId !== attemptId) throw new TeamOutputRejectedError(runId, 'acceptance-attempt-mismatch')
          if (acceptance.runId !== runId || acceptance.stageId !== stage.stageId || stage.runId !== expected.runId || stage.stageId !== expected.stageId
            || stage.teamId !== expected.teamId || stage.leadSessionId !== expected.leadSessionId
            || stage.taskSpecificationFingerprint !== expected.taskSpecificationFingerprint) throw new TeamOutputRejectedError(runId, 'foreign-binding')
          if (stage.taskId === undefined || acceptance.taskId !== stage.taskId) throw new TeamOutputRejectedError(runId, 'task-binding-missing')
          if (stage.taskId !== expected.taskId || stage.taskRevision !== expected.taskRevision) throw new TeamOutputRejectedError(runId, 'task-binding-unverified')
          if (draft.definitionRevision !== verification.definitionRevision) throw new TeamOutputRejectedError(runId, 'host-verdict-binding-mismatch')
          if (!isDeepStrictEqual(stage.requiredMemberIds, expected.requiredMemberIds)) throw new TeamOutputRejectedError(runId, 'required-member-policy-override')
          if (!isDeepStrictEqual(stage.requiredChecks, expected.requiredChecks)) throw new TeamOutputRejectedError(runId, 'required-check-policy-override')
          if (stage.primaryMemberId !== expected.primaryMemberId) throw new TeamOutputRejectedError(runId, 'producer-policy-mismatch')
          if (!isDeepStrictEqual(stage.members, expected.members)) throw new TeamOutputRejectedError(runId, 'required-member-policy-unsatisfied')
          if (!isDeepStrictEqual(stage.reservations, expected.reservations) || !isDeepStrictEqual(stage.captures, expected.captures)) throw new TeamOutputRejectedError(runId, 'artifact-current-capture-mismatch')
          if (stage.reservations !== undefined) {
            const policy = fullArtifactPolicy(draft)
            const primary = stage.captures?.find(ref => ref.producerMemberId === policy.primaryId)
            if (primary === undefined || primary.artifactId !== verification.hostVerdict.artifactId || primary.digest !== verification.hostVerdict.digest
              || primary.byteLength !== verification.hostVerdict.byteLength || primary.schemaDigest !== verification.hostVerdict.schemaDigest) throw new TeamOutputRejectedError(runId, 'artifact-verdict-mismatch')
            for (const ref of stage.captures ?? []) validateCaptureArtifactBinding(draft, ref)
            if (stage.captures?.length !== policy.requiredIds.length || policy.requiredIds.some(id => !stage.captures?.some(ref => ref.producerMemberId === id))) throw new TeamOutputRejectedError(runId, 'artifact-required-capture-missing')
          }
          if (stage.effects?.some(effect => effect.state === 'pending')) throw new TeamOutputRejectedError(runId, 'pending-team-effect')
          if (!isDeepStrictEqual(stage.effects, expected.effects)) throw new TeamOutputRejectedError(runId, 'host-verdict-binding-mismatch')
          const attempt = draft.attempts.find(candidate => candidate.attemptId === attemptId)
          if (attempt === undefined || attempt.nodeId !== stage.stageId) throw new TeamOutputRejectedError(runId, 'attempt-not-found')
          if (stage.cancel !== undefined || stage.recovery !== undefined || ['cancelling', 'cancelled', 'recovery_required', 'succeeded', 'failed', 'timed_out'].includes(stage.state)) throw new TeamOutputRejectedError(runId, 'stage-not-accepting')
          if (attempt.result !== undefined || ['cancelling', 'recovery_required', 'succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'].includes(attempt.state)) throw new TeamOutputRejectedError(runId, 'attempt-already-settled')
          const seq = draft.seq + 1
          const at = Date.now()
          stage.outputAcceptance = structuredClone(acceptance)
          stage.state = 'succeeded'
          stage.updatedAt = at
          attempt.result = { seq, at, ok: true, outcome: { kind: 'succeeded', outputs, teamVerification: provenance }, evidence }
          attempt.state = 'succeeded'
          if (attempt.diagnostics?.status === 'available') attempt.diagnostics.acceptance = { code: 'accepted' }
          draft.log.push({ seq, at, kind: 'result', detail: { attemptId, teamStage: 'accepted', evidence } })
          teamStageRecordSchema.parse(stage)
        }, isReplay)
      } catch (error) {
        if (error instanceof TeamSettlementReplay) return error.record
        throw error
      }
    })
  }

  /** Attach the exact native task identity after an external adapter creates
   * it. Revision 1 is the only W1 task revision; duplicate replay is idempotent. */
  async bindTeamTask(runId: string, task: { taskId: string; taskRevision: number }): Promise<RunRecord> {
    let parsedTask: TeamTaskBinding
    try { parsedTask = teamTaskBindingSchema.parse(task) }
    catch { throw new TeamTaskConflictError(runId, 'taskId and positive taskRevision are required') }
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      const existing = current.teamStage
      if (existing === undefined) throw new TeamTaskConflictError(runId, 'stage binding is missing')
      if (existing.taskId !== undefined || existing.taskRevision !== undefined) {
        if (existing.taskId === parsedTask.taskId && existing.taskRevision === parsedTask.taskRevision) return current
        throw new TeamTaskConflictError(runId, 'a different task is already bound')
      }
      if (['cancelling', 'cancelled', 'recovery_required', 'succeeded', 'failed', 'timed_out'].includes(existing.state)) {
        throw new TeamTaskConflictError(runId, `cannot bind a Team task while stage is ${existing.state}`)
      }
      return await this.applyTransition(runId, draft => {
        const stage = draft.teamStage
        if (stage === undefined) throw new TeamTaskConflictError(runId, 'stage binding is missing')
        stage.taskId = parsedTask.taskId
        stage.taskRevision = parsedTask.taskRevision
        stage.state = 'active'
        stage.updatedAt = Date.now()
        teamStageRecordSchema.parse(stage)
        draft.log.push({ seq: draft.seq + 1, at: stage.updatedAt, kind: 'state', detail: { teamStage: 'task-bound', taskId: parsedTask.taskId, taskRevision: parsedTask.taskRevision } })
      })
    })
  }

  /** Advance the canonical native Team task revision with a strict CAS.
   * The native Team call happens outside this reducer; this method only
   * records the already-observed identity/revision fact and never calls Team. */
  async updateTeamTaskRevision(runId: string, expectedRevision: number, nextRevision: number): Promise<RunRecord> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1
      || !Number.isInteger(nextRevision) || nextRevision !== expectedRevision + 1) {
      throw new TeamTaskConflictError(runId, 'task revision must advance exactly one step')
    }
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      const stage = current.teamStage
      if (stage === undefined || stage.taskId === undefined || stage.taskRevision === undefined) {
        throw new TeamTaskConflictError(runId, 'stage task binding is missing')
      }
      if (['cancelling', 'cancelled', 'recovery_required', 'succeeded', 'failed', 'timed_out'].includes(stage.state)) {
        throw new TeamTaskConflictError(runId, `cannot update a Team task while stage is ${stage.state}`)
      }
      if (stage.taskRevision !== expectedRevision) {
        throw new TeamTaskConflictError(runId, 'stale canonical task revision')
      }
      return await this.applyTransition(runId, draft => {
        const bound = draft.teamStage
        if (bound === undefined || bound.taskId === undefined || bound.taskRevision !== expectedRevision) {
          throw new TeamTaskConflictError(runId, 'stale canonical task revision')
        }
        bound.taskRevision = nextRevision
        bound.updatedAt = Date.now()
        teamStageRecordSchema.parse(bound)
        draft.log.push({ seq: draft.seq + 1, at: bound.updatedAt, kind: 'state', detail: {
          teamStage: 'task-revision', taskId: bound.taskId, expectedRevision, taskRevision: nextRevision,
        } })
      })
    })
  }

  /** Record a verified native task snapshot. Other native Team tools may have
   * advanced several revisions since the last Blueprint observation. This is
   * one observation with a local CAS, not a replay of invented task mutations. */
  async observeTeamTaskRevision(runId: string, task: { taskId: string; taskRevision: number }, expectedRevision: number): Promise<RunRecord> {
    let observed: TeamTaskBinding
    try { observed = teamTaskBindingSchema.parse(task) }
    catch { throw new TeamTaskConflictError(runId, 'task observation is malformed') }
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || observed.taskRevision < expectedRevision) {
      throw new TeamTaskConflictError(runId, 'task observation cannot move a revision backwards')
    }
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      const stage = current.teamStage
      if (stage === undefined || stage.taskId !== observed.taskId || stage.taskRevision !== expectedRevision) {
        throw new TeamTaskConflictError(runId, 'stale or foreign task observation')
      }
      if (['cancelling', 'cancelled', 'recovery_required', 'succeeded', 'failed', 'timed_out'].includes(stage.state)) {
        throw new TeamTaskConflictError(runId, `cannot observe a Team task while stage is ${stage.state}`)
      }
      if (observed.taskRevision === expectedRevision) return current
      return await this.applyTransition(runId, draft => {
        const bound = draft.teamStage
        if (bound === undefined || bound.taskId !== observed.taskId || bound.taskRevision !== expectedRevision) {
          throw new TeamTaskConflictError(runId, 'stale or foreign task observation')
        }
        bound.taskRevision = observed.taskRevision
        bound.updatedAt = Date.now()
        teamStageRecordSchema.parse(bound)
        draft.log.push({ seq: draft.seq + 1, at: bound.updatedAt, kind: 'state', detail: {
          teamStage: 'task-observed', taskId: observed.taskId, expectedRevision, taskRevision: observed.taskRevision,
        } })
      })
    })
  }

  /** First budget and first abort source are immutable; exact replay is read-only. */
  async recordTeamStageExecution(runId: string, attemptId: string, execution: TeamStageExecution): Promise<RunRecord> {
    let frozen: TeamStageExecution
    try { frozen = teamStageExecutionCodec().parse(execution) }
    catch { throw new TeamStageConflictError(runId, 'execution diagnostic is malformed') }
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      const stage = current.teamStage
      if (stage?.attemptId !== attemptId) throw new TeamStageConflictError(runId, 'execution Attempt binding mismatch')
      if (isDeepStrictEqual(stage.execution, frozen)) return current
      if (stage.state === 'succeeded' || (stage.execution === undefined && !['provisioning', 'active'].includes(stage.state))) {
        throw new TeamStageConflictError(runId, 'execution diagnostic cannot start after settlement')
      }
      const previous = stage.execution
      if (previous !== undefined && (previous.startedAt !== frozen.startedAt || previous.deadlineAt !== frozen.deadlineAt
        || previous.timeoutMs !== frozen.timeoutMs || previous.abort !== undefined)) {
        throw new TeamStageConflictError(runId, 'execution budget and first abort are immutable')
      }
      return await this.applyTransition(runId, draft => {
        draft.teamStage!.execution = frozen
        draft.teamStage!.updatedAt = Date.now()
        teamStageRecordSchema.parse(draft.teamStage)
      })
    })
  }

  /** Update canonical lifecycle observations without reading native Team
   * projection as truth. Members are snapshots and output is strict DTO data. */
  async updateTeamStage(runId: string, update: { state?: TeamStageState; members?: TeamMemberSnapshot[]; effects?: never; cancel?: TeamStageRecord['cancel']; recovery?: TeamStageRecord['recovery'] }): Promise<RunRecord> {
    if (Object.hasOwn(update, 'effects')) {
      throw new TeamStageConflictError(runId, 'canonical Team effects are append-only and cannot be replaced')
    }
    const frozen = structuredClone(update)
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      if (current.teamStage?.state === 'succeeded') {
        if (Object.entries(frozen).every(([key, value]) => isDeepStrictEqual(value, current.teamStage![key as keyof TeamStageRecord]))) return current
        throw new TeamStageConflictError(runId, 'accepted TeamStage evidence is immutable')
      }
      return await this.applyTransition(runId, draft => {
        const stage = draft.teamStage
        if (stage === undefined) throw new TeamStageConflictError(runId, 'stage binding is missing')
        if (stage.state === 'succeeded') throw new TeamStageConflictError(runId, 'accepted TeamStage evidence is immutable')
        if (frozen.state === 'succeeded' && stage.attemptId !== undefined) throw new TeamStageConflictError(runId, 'graph-bound success requires atomic Attempt settlement')
        if (frozen.state !== undefined && !allowedTeamStageTransition(stage.state, frozen.state)) {
          throw new TeamStageConflictError(runId, `invalid TeamStage transition ${stage.state} -> ${frozen.state}`)
        }
        if (frozen.state === 'succeeded' && stage.outputAcceptance?.code !== 'accepted') {
          throw new TeamStageConflictError(runId, 'accepted Team output is required before stage success')
        }
        if (frozen.state !== undefined) stage.state = frozen.state
        if (frozen.members !== undefined) stage.members = frozen.members
        if (frozen.cancel !== undefined) stage.cancel = frozen.cancel
        if (frozen.recovery !== undefined) stage.recovery = frozen.recovery
        stage.updatedAt = Date.now()
        teamStageRecordSchema.parse(stage)
      })
    })
  }

  /** Atomically add or replace one canonical member snapshot. A caller must
   * never read a member array, append locally, and write the stale array back:
   * concurrent provisioning would otherwise lose a successfully bound member. */
  async upsertTeamMember(runId: string, member: TeamMemberSnapshot): Promise<RunRecord> {
    let parsed: TeamMemberSnapshot
    try { parsed = teamMemberSnapshotSchema.parse(member) as TeamMemberSnapshot }
    catch { throw new TeamStageConflictError(runId, 'member snapshot is malformed') }
    return await this.serial(runId, () => this.applyTransition(runId, draft => {
      const stage = draft.teamStage
      if (stage === undefined) throw new TeamStageConflictError(runId, 'stage binding is missing')
      if (['cancelling', 'cancelled', 'recovery_required', 'succeeded', 'failed', 'timed_out'].includes(stage.state)) {
        throw new TeamStageConflictError(runId, `cannot bind a Team member while stage is ${stage.state}`)
      }
      const members = stage.members.filter(candidate => candidate.memberId !== parsed.memberId
        && (parsed.name === undefined || candidate.name !== parsed.name))
      stage.members = [...members, structuredClone(parsed)]
      stage.updatedAt = Date.now()
      teamStageRecordSchema.parse(stage)
      draft.log.push({ seq: draft.seq + 1, at: stage.updatedAt, kind: 'state', detail: { teamStage: 'member-bound', memberId: parsed.memberId, memberName: parsed.name } })
    }))
  }

  /** Reserve the native address and frozen resource/schema facts BEFORE spawn. */
  async reserveTeamMember(runId: string, args: {
    attemptId: string; effectId: string; logicalName: string; schema: unknown; resourceDigests: Record<string, string>
  }): Promise<TeamMemberReservation> {
    const frozen = structuredClone(args)
    let schemaCanonicalJson: string
    try { assertObjectJsonSchema(frozen.schema); schemaCanonicalJson = canonicalJson(frozen.schema) }
    catch { throw new TeamOutputRejectedError(runId, 'artifact-schema-invalid') }
    const nativeName = `bp-${randomUUID()}`
    const matching = (record: RunRecord): boolean => {
      const { node, stage } = frozenArtifactNode(record)
      if (stage.attemptId !== frozen.attemptId || !node.teamStage!.members.some(member => member.name === frozen.logicalName)) artifactReject('artifact-reservation-binding-mismatch')
      const existing = stage.reservations?.find(item => item.logicalName === frozen.logicalName || item.effectId === frozen.effectId)
      if (existing === undefined) return false
      if (existing.attemptId !== frozen.attemptId || existing.effectId !== frozen.effectId || existing.logicalName !== frozen.logicalName
        || existing.schemaCanonicalJson !== schemaCanonicalJson || !isDeepStrictEqual(existing.resourceDigests, frozen.resourceDigests)) artifactReject('artifact-reservation-conflict')
      return true
    }
    const result = await this.artifactTransition(runId, draft => {
      requireArtifactStageWritable(draft)
      const { node, stage } = frozenArtifactNode(draft)
      const declared = node.teamStage!.members.find(member => member.name === frozen.logicalName)!
      const attempt = draft.attempts.find(item => item.attemptId === frozen.attemptId)!
      const schemaResourceId = node.outputSchemaRef!
      const schemaResourceDigest = frozen.resourceDigests[schemaResourceId]
      if (schemaResourceDigest === undefined || attempt.intent?.resourceDigests[schemaResourceId] !== schemaResourceDigest
        || frozen.resourceDigests[declared.agentRef] === undefined) artifactReject('artifact-resource-binding-mismatch')
      for (const [id, digest] of Object.entries(frozen.resourceDigests)) {
        if (attempt.intent?.resourceDigests[id] !== undefined && attempt.intent.resourceDigests[id] !== digest) artifactReject('artifact-resource-binding-mismatch')
      }
      if (stage.effects?.some(effect => effect.effectId === frozen.effectId || effect.memberName === nativeName)) artifactReject('artifact-reservation-after-effect')
      if (stage.reservations?.some(item => item.schemaCanonicalJson !== schemaCanonicalJson || item.schemaResourceDigest !== schemaResourceDigest)) artifactReject('artifact-schema-binding-mismatch')
      const parsed = teamMemberReservationSchema.safeParse({
        runId, stageId: stage.stageId, definitionRevision: draft.definitionRevision,
        attemptId: frozen.attemptId, effectId: frozen.effectId, logicalName: frozen.logicalName, nativeName,
        reservationSeq: draft.seq + 1, schemaCanonicalJson, schemaDigest: artifactDigest(schemaCanonicalJson),
        schemaResourceId, schemaResourceDigest, resourceDigests: frozen.resourceDigests, memberId: `member-${randomUUID()}`,
      })
      if (!parsed.success) artifactReject('artifact-reservation-invalid')
      const reservation = parsed.data
      if (stage.reservations?.some(item => item.nativeName === nativeName)) artifactReject('artifact-reservation-conflict')
      stage.reservations = [...(stage.reservations ?? []), reservation]
      const ordered = node.teamStage!.members.map(member => stage.reservations!.find(item => item.logicalName === member.name))
      if (ordered.every(item => item !== undefined)) {
        stage.requiredMemberIds = ordered.map(item => item!.memberId)
        stage.primaryMemberId = stage.requiredMemberIds[0]!
      }
      stage.requiredChecks = [...node.teamStage!.requiredChecks]
      stage.updatedAt = Date.now()
      teamStageRecordSchema.parse(stage)
      draft.log.push({ seq: draft.seq + 1, at: stage.updatedAt, kind: 'state', detail: { teamStage: 'member-reserved', effectId: frozen.effectId, nativeName } })
    }, matching)
    return structuredClone(result.teamStage!.reservations!.find(item => item.logicalName === frozen.logicalName)!)
  }

  /** The creation listener proves native membership; this records its exact child identity. */
  async bindTeamMemberReservation(runId: string, args: { attemptId: string; effectId: string; memberId: string; sessionId: string }): Promise<RunRecord> {
    const parsed = z.strictObject({ attemptId: z.string().min(1), effectId: z.string().min(1), memberId: z.string().min(1), sessionId: z.string().min(1) }).safeParse(args)
    if (!parsed.success) throw new TeamOutputRejectedError(runId, 'artifact-member-binding-invalid')
    const frozen = parsed.data
    const matching = (record: RunRecord): boolean => {
      const reservation = record.teamStage?.reservations?.find(item => item.effectId === frozen.effectId)
      if (reservation?.sessionId === undefined) return false
      if (reservation.attemptId !== frozen.attemptId || reservation.memberId !== frozen.memberId || reservation.sessionId !== frozen.sessionId) artifactReject('artifact-member-binding-conflict')
      return true
    }
    return await this.artifactTransition(runId, draft => {
      requireArtifactStageWritable(draft)
      const { node, stage } = frozenArtifactNode(draft)
      const reservation = stage.reservations?.find(item => item.effectId === frozen.effectId)
      if (reservation === undefined || reservation.attemptId !== frozen.attemptId || stage.attemptId !== frozen.attemptId
        || reservation.memberId !== frozen.memberId || reservation.runId !== runId || reservation.stageId !== stage.stageId
        || reservation.definitionRevision !== draft.definitionRevision) artifactReject('artifact-reservation-missing')
      if (frozen.sessionId === stage.leadSessionId || stage.reservations?.some(item => item !== reservation
        && (item.memberId === frozen.memberId || item.sessionId === frozen.sessionId))) artifactReject('artifact-member-binding-conflict')
      const effect = stage.effects?.find(item => item.effectId === frozen.effectId)
      if (effect?.kind !== 'spawn' || effect.memberName !== reservation.nativeName || effect.actorSessionId !== stage.leadSessionId
        || !['pending', 'succeeded'].includes(effect.state) || (effect.state === 'succeeded' && effect.resultMemberId !== frozen.sessionId)) artifactReject('artifact-spawn-unverified')
      if (stage.members.some(item => item.memberId === frozen.memberId || item.sessionId === frozen.sessionId || item.name === reservation.nativeName)) artifactReject('artifact-member-binding-conflict')
      reservation.sessionId = frozen.sessionId
      stage.members.push({ memberId: frozen.memberId, sessionId: frozen.sessionId, name: reservation.nativeName, logicalName: reservation.logicalName, phase: 'provisioning', status: 'provisioning' })
      const ordered = node.teamStage!.members.map(member => stage.reservations!.find(item => item.logicalName === member.name))
      if (ordered.every(item => item?.memberId !== undefined)) {
        stage.requiredMemberIds = ordered.map(item => item!.memberId!)
        stage.primaryMemberId = stage.requiredMemberIds[0]!
      }
      stage.updatedAt = Date.now()
      teamStageRecordSchema.parse(stage)
      draft.log.push({ seq: draft.seq + 1, at: stage.updatedAt, kind: 'state', detail: { teamStage: 'reserved-member-bound', effectId: frozen.effectId, memberId: frozen.memberId } })
    }, matching)
  }

  /** Byte publication has completed; bind the immutable ref and current capture in one RMW. */
  async bindTeamCaptureArtifact(runId: string, args: { artifact: TeamCaptureArtifactRef; expectedMember: TeamMemberSnapshot; taskRevision: number }): Promise<RunRecord> {
    const parsedRef = teamCaptureArtifactRefSchema.safeParse(args.artifact)
    const parsedMember = teamMemberSnapshotSchema.safeParse(args.expectedMember)
    if (!parsedRef.success || !parsedMember.success) throw new TeamOutputRejectedError(runId, 'artifact-reference-invalid')
    const ref = parsedRef.data
    const member = parsedMember.data
    const taskRevision = args.taskRevision
    const matching = (record: RunRecord): boolean => {
      const previous = record.teamStage?.captures?.find(item => item.producerMemberId === ref.producerMemberId)
      if (previous === undefined) return false
      if (!isDeepStrictEqual(previous, ref)) artifactReject('artifact-capture-conflict')
      validateCaptureArtifactBinding(record, ref)
      return true
    }
    return await this.artifactTransition(runId, draft => {
      requireArtifactStageWritable(draft)
      validateCaptureArtifactBinding(draft, ref, false)
      const stage = draft.teamStage!
      const current = stage.members.find(item => item.memberId === ref.producerMemberId)!
      if (stage.taskRevision !== taskRevision || !isDeepStrictEqual(current, member)) artifactReject('artifact-current-capture-mismatch')
      stage.captures = [...(stage.captures ?? []), ref]
      current.evidence = memberEvidenceForArtifact(ref)
      stage.updatedAt = Date.now()
      teamStageRecordSchema.parse(stage)
      draft.log.push({ seq: draft.seq + 1, at: stage.updatedAt, kind: 'state', detail: { teamStage: 'capture-artifact-bound', artifactId: ref.artifactId, evidenceDigest: ref.evidenceDigest } })
    }, matching)
  }

  private async artifactTransition(runId: string, reducer: (draft: RunRecord) => void, replay: (record: RunRecord) => boolean): Promise<RunRecord> {
    return await this.serial(runId, async () => {
      try {
        const current = await this.get(runId)
        if (replay(current)) return current
        return await this.applyTransition(runId, reducer, replay)
      } catch (error) {
        if (error instanceof TeamSettlementReplay) return error.record
        if (error instanceof TeamArtifactError) throw new TeamOutputRejectedError(runId, error.issueCode)
        throw error
      }
    })
  }

  /** Store only the redacted acceptance DTO and never raw provider output. */
  async recordTeamOutputAcceptance(runId: string, acceptance: TeamOutputAcceptance): Promise<RunRecord> {
    let parsed: TeamOutputAcceptance
    try {
      parsed = teamOutputAcceptanceSchema.parse(acceptance) as TeamOutputAcceptance
    } catch {
      throw new TeamOutputRejectedError(runId, 'malformed-acceptance')
    }
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      if (parsed.code === 'accepted' && current.teamStage?.attemptId !== undefined) throw new TeamOutputRejectedError(runId, 'accepted-settlement-required')
      const existing = current.teamStage?.outputAcceptance
      if (existing !== undefined) {
        if (sameTeamOutputAcceptance(existing, parsed)) return current
        throw new TeamOutputRejectedError(runId, 'acceptance-conflict')
      }
      if (current.teamStage !== undefined && ['cancelling', 'cancelled', 'recovery_required', 'succeeded', 'failed', 'timed_out'].includes(current.teamStage.state)) {
        throw new TeamOutputRejectedError(runId, 'stage-not-accepting')
      }
      return await this.applyTransition(runId, draft => {
        const stage = draft.teamStage
        if (stage === undefined) throw new TeamOutputRejectedError(runId, 'stage-binding-missing')
        if (parsed.code === 'accepted' && stage.attemptId !== undefined) throw new TeamOutputRejectedError(runId, 'accepted-settlement-required')
        if (stage.taskId === undefined || stage.taskRevision === undefined) throw new TeamOutputRejectedError(runId, 'task-binding-missing')
        if (parsed.runId !== runId || parsed.stageId !== stage.stageId || parsed.taskId !== stage.taskId) throw new TeamOutputRejectedError(runId, 'foreign-binding')
        stage.outputAcceptance = structuredClone(parsed)
        if (parsed.code === 'rejected') stage.state = 'failed'
        stage.updatedAt = Date.now()
        teamStageRecordSchema.parse(stage)
        draft.log.push({ seq: draft.seq + 1, at: stage.updatedAt, kind: 'result', detail: { teamStage: 'output-acceptance', code: parsed.code, evidenceDigest: parsed.evidenceDigest } })
      })
    })
  }

  /** All run ids visible in the projection index (no cross-record txn). */
  async listRunIds(): Promise<string[]> {
    if (this.runs.entries === undefined) throw new DurabilityFailureError('run list', new Error('backend lacks entries()'))
    try {
      return [...this.runs.entries()].map(([id]) => id).sort()
    } catch (cause) {
      throw new DurabilityFailureError('run list', cause)
    }
  }

  /** Atomic single-record transition. `reducer` runs synchronously inside
   * the RMW (plan §8.3.2: no model/tool calls inside reducers). Terminal
   * states are immutable: the reducer is not invoked again. */
  async transition(runId: string, reducer: (draft: RunRecord) => void): Promise<RunRecord> {
    return await this.serial(runId, () => this.applyTransition(runId, reducer))
  }

  private async applyTransition(runId: string, reducer: (draft: RunRecord) => void, settlementReplay?: (record: RunRecord) => boolean): Promise<RunRecord> {
    let next: RunRecord | undefined
    try {
      next = await this.runs.update(runId, (value) => {
        if (value === undefined) throw new RunNotFoundError(runId)
        // A stale read in another store can race both acceptance and the
        // scheduler's terminal commit. Compare the existing fact before the
        // terminal mutation guard; a replay aborts this RMW without writing.
        if (settlementReplay?.(value)) throw new TeamSettlementReplay(structuredClone(value))
        if (TERMINAL_RUN_STATES.includes(value.state)) throw new TerminalStateError(runId, value.state)
        const draft = structuredClone(value)
        const seqBefore = draft.seq
        reducer(draft)
        // Reconciliation also writes through this atomic record boundary. Keep
        // available diagnostics honest without inventing an execution result
        // or rewriting legacy Attempts that never captured these facts.
        for (const attempt of draft.attempts) {
          if (attempt.diagnostics?.status !== 'available') continue
          if (attempt.state === 'recovery_required' && attempt.result === undefined) {
            attempt.diagnostics.acceptance = { code: 'recovery-required' }
            attempt.diagnostics.recovery = { code: 'effect-unknown' }
          } else {
            const reviewed = (attempt.result?.outcome as { recovery?: unknown } | undefined)?.recovery
            if (typeof reviewed === 'string' && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(reviewed)) {
              const code = `reviewed-${reviewed === 'timed_out' ? 'timed-out' : reviewed}`
              attempt.diagnostics.acceptance = { code }
              attempt.diagnostics.recovery = { code }
            }
          }
        }
        draft.seq = seqBefore + 1
        draft.updatedAt = Date.now()
        if (draft.log.length > LOG_CAP) draft.log = draft.log.slice(draft.log.length - LOG_CAP)
        return draft
      })
    } catch (cause) {
      if (cause instanceof TeamSettlementReplay || cause instanceof RunNotFoundError || cause instanceof TerminalStateError || cause instanceof AttemptSettledError || cause instanceof DecisionConflictError
        || cause instanceof TeamStageConflictError || cause instanceof TeamTaskConflictError || cause instanceof TeamOutputRejectedError || cause instanceof TeamEffectReplayError || cause instanceof TeamArtifactError) throw cause
      if (cause instanceof Error && String(cause.message).includes('has no record')) {
        throw new RunNotFoundError(runId)
      }
      throw new DurabilityFailureError(`run transition ${runId}`, cause)
    }
    if (next === undefined) throw new RunNotFoundError(runId)
    return next
  }

  /** Durable dispatch intent: MUST be committed before any external effect
   * (intent-before-effect, C-08). */
  async recordIntent(runId: string, attempt: { nodeId: string; kind: string; resourceDigests?: Record<string, string>; diagnostics?: AttemptDiagnostics; sessionId?: string }): Promise<{ attemptId: string; seq: number; intent: NonNullable<AttemptRecord['intent']> }> {
    const sessionId = attempt.sessionId === undefined ? undefined : z.string().min(1).parse(attempt.sessionId)
    const diagnostics = attempt.diagnostics === undefined ? undefined : attemptDiagnosticsCodec().parse(attempt.diagnostics)
    const resourceDigests = attempt.resourceDigests ?? (diagnostics?.status === 'available' ? diagnostics.resourceDigests : {})
    if (diagnostics?.status === 'available' && !sameDigests(resourceDigests, diagnostics.resourceDigests)) throw new AttemptSettledError()
    const newAttemptId = `att-${randomUUID()}`
    const meta: { attemptId: string; seq: number; intent: NonNullable<AttemptRecord['intent']> | null } = { attemptId: '', seq: 0, intent: null }
    await this.transition(runId, (draft) => {
      if (!['queued', 'running'].includes(draft.state)) throw new AttemptSettledError()
      if (draft.state === 'queued') draft.state = 'running'
      const seq = draft.seq + 1
      const intent = { seq, at: Date.now(), kind: attempt.kind, resourceDigests: structuredClone(resourceDigests) }
      if (draft.attempts.some(a => a.nodeId === attempt.nodeId)) throw new AttemptSettledError()
      draft.attempts.push({ attemptId: newAttemptId, nodeId: attempt.nodeId, state: 'running', attempt: 1, intent, ...(sessionId === undefined ? {} : { sessionId }), ...(diagnostics === undefined ? {} : { diagnostics: structuredClone(diagnostics) }) })
      draft.log.push({ seq, at: intent.at, kind: 'intent', detail: { attemptId: newAttemptId, nodeId: attempt.nodeId, kind: attempt.kind } })
      meta.attemptId = newAttemptId
      meta.seq = seq
      meta.intent = intent
    })
    if (meta.intent === null) throw new DurabilityFailureError(`intent ${runId}`, new Error('reducer did not run'))
    return { attemptId: meta.attemptId, seq: meta.seq, intent: meta.intent }
  }

  /** Settle a dispatched intent with its known result. */
  async recordResult(runId: string, attemptId: string, result: { ok: boolean; outcome: unknown; evidence: string; diagnostics?: AttemptDiagnostics }): Promise<RunRecord> {
    const diagnostics = result.diagnostics === undefined ? undefined : attemptDiagnosticsCodec().parse(result.diagnostics)
    return await this.transition(runId, (draft) => {
      const seq = draft.seq + 1
      const attempt = draft.attempts.find(a => a.attemptId === attemptId)
      if (attempt === undefined) throw new Error(`attempt ${attemptId} not found in run ${runId}`)
      if (draft.teamStage?.state === 'provisioning' && draft.teamStage.attemptId === attemptId
        && attempt.result === undefined && !TERMINAL_ATTEMPTS.has(attempt.state)) {
        throw new TeamStageConflictError(runId, 'cannot settle the original Attempt while TeamStage is provisioning')
      }
      if (attempt.result !== undefined || TERMINAL_ATTEMPTS.has(attempt.state)) throw new AttemptSettledError()
      if (diagnostics !== undefined) {
        if (diagnostics.status === 'available' && !sameDigests(attempt.intent?.resourceDigests ?? {}, diagnostics.resourceDigests)) throw new AttemptSettledError()
        if (attempt.diagnostics?.status === 'available' && (diagnostics.status !== 'available'
          || JSON.stringify(diagnostics.input) !== JSON.stringify(attempt.diagnostics.input)
          || JSON.stringify(diagnostics.modelSelection) !== JSON.stringify(attempt.diagnostics.modelSelection)
          || JSON.stringify(diagnostics.tools.effectiveNames) !== JSON.stringify(attempt.diagnostics.tools.effectiveNames))) throw new AttemptSettledError()
        attempt.diagnostics = structuredClone(diagnostics)
      }
      attempt.result = { seq, at: Date.now(), ok: result.ok, outcome: result.outcome, evidence: result.evidence }
      const kind = (result.outcome as { kind?: string } | null)?.kind
      attempt.state = draft.state === 'cancelling' || kind === 'cancelled' ? 'cancelled' : kind === 'timeout' ? 'timed_out' : result.ok ? 'succeeded' : 'failed'
      if (draft.state === 'cancelling' && draft.attempts.every(a => a.result !== undefined || TERMINAL_ATTEMPTS.has(a.state))) draft.state = 'cancelled'
      draft.log.push({ seq, at: attempt.result.at, kind: 'result', detail: { attemptId, ok: result.ok, evidence: result.evidence } })
    })
  }

  /** Request cancellation: the run and any non-terminal TeamStage enter the
   * durable cancelling cutoff before callers touch native effects. */
  async requestCancel(runId: string, reason?: string): Promise<RunRecord> {
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      const stage = current.teamStage
      const stageTerminal = stage === undefined || ['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(stage.state)
      const needsTeamCutoff = stage !== undefined && !stageTerminal
        && (stage.state !== 'cancelling' || stage.cancel === undefined)
      if (TERMINAL_RUN_STATES.includes(current.state) || current.state === 'recovery_required'
        || (current.state === 'cancelling' && !needsTeamCutoff)) return current
      return await this.applyTransition(runId, draft => {
        const seq = draft.seq + 1
        const at = Date.now()
        const draftStage = draft.teamStage
        const draftStageTerminal = draftStage === undefined || ['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(draftStage.state)
        const activeAttempt = draft.attempts.some(a => a.intent !== undefined && a.result === undefined && !TERMINAL_ATTEMPTS.has(a.state) && a.state !== 'waiting_input')
        const active = activeAttempt || !draftStageTerminal
        draft.state = active ? 'cancelling' : 'cancelled'
        for (const a of draft.attempts) {
          if (a.result === undefined && !TERMINAL_ATTEMPTS.has(a.state)) {
            a.state = active ? 'cancelling' : 'cancelled'
            if (!active && a.diagnostics?.status === 'available') a.diagnostics.acceptance = { code: 'cancelled' }
          }
        }
        const stageDetail: Record<string, unknown> = {}
        if (!draftStageTerminal && draftStage !== undefined) {
          const boundedReason = typeof reason === 'string' ? reason.trim().slice(0, 256) : ''
          draftStage.state = 'cancelling'
          // The first durable cancellation fact is the cutoff. A repeated
          // request may repair a legacy record that entered `cancelling`
          // without a TeamStage fact, but it must not move that cutoff.
          if (draftStage.cancel === undefined) {
            draftStage.cancel = {
              requestedAt: at,
              ...(boundedReason.length === 0 ? {} : { reason: boundedReason }),
            }
          }
          draftStage.updatedAt = at
          stageDetail.teamStage = 'cancelling'
          stageDetail.stageId = draftStage.stageId
          stageDetail.ownedMemberIds = draftStage.members.map(member => member.memberId)
          stageDetail.ownedSessionIds = draftStage.members.flatMap(member => member.sessionId === undefined ? [] : [member.sessionId])
          teamStageRecordSchema.parse(draftStage)
        }
        draft.log.push({ seq, at, kind: 'cancel-requested', detail: stageDetail })
      })
    })
  }

  /** Request cancellation of only the canonical TeamStage sidecar. The
   * ordinary Run and its Attempts keep their parent conversation state; the
   * native coordinator owns the stage resources after this cutoff. */
  async requestTeamStageCancel(runId: string, reason?: string): Promise<RunRecord> {
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      const stage = current.teamStage
      if (stage === undefined) throw new TeamStageConflictError(runId, 'stage binding is missing')
      if (['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(stage.state)
        || (stage.state === 'cancelling' && stage.cancel !== undefined)) return current
      return await this.applyTransition(runId, draft => {
        const next = draft.teamStage
        if (next === undefined) throw new TeamStageConflictError(runId, 'stage binding is missing')
        if (['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(next.state)) return
        const boundedReason = typeof reason === 'string' ? reason.trim().slice(0, 256) : ''
        next.state = 'cancelling'
        // Preserve the first stage-only cutoff across retries and restart.
        if (next.cancel === undefined) {
          next.cancel = {
            requestedAt: Date.now(),
            ...(boundedReason.length === 0 ? {} : { reason: boundedReason }),
          }
        }
        next.updatedAt = Date.now()
        teamStageRecordSchema.parse(next)
        draft.log.push({ seq: draft.seq + 1, at: next.updatedAt, kind: 'cancel-requested', detail: {
          teamStage: 'cancelling', scope: 'team-stage', stageId: next.stageId,
          ownedMemberIds: next.members.map(member => member.memberId),
          ownedSessionIds: next.members.flatMap(member => member.sessionId === undefined ? [] : [member.sessionId]),
        } })
      })
    })
  }

  /** One atomic decision fact, original waiting Attempt settlement and branch selection.
   * Idempotency is read from canonical Attempt results, not the bounded log. */
  async decide(runId: string, decisionId: string, action: 'approve' | 'reject', branch: string): Promise<{ record: RunRecord; applied: boolean }> {
    return await this.serial(runId, async () => {
      const current = await this.get(runId)
      const prior = current.attempts.map(a => a.result?.outcome as { decisionId?: string; action?: string } | undefined).find(o => o?.decisionId === decisionId)
      if (prior) {
        if (prior.action !== action) throw new DecisionConflictError()
        return { record: current, applied: false }
      }
      if (current.state !== 'waiting_input' || !decisionId) throw new DecisionConflictError()
      const record = await this.applyTransition(runId, draft => {
        const attempt = draft.attempts.find(a => a.state === 'waiting_input' && a.result === undefined && ['condition', 'humanDecision'].includes(a.intent?.kind ?? ''))
        if (!attempt) throw new DecisionConflictError()
        const seq = draft.seq + 1
        const outcome = { decisionId, action, branch, nodeId: attempt.nodeId }
        attempt.state = action === 'approve' ? 'succeeded' : 'cancelled'
        attempt.result = { seq, at: Date.now(), ok: action === 'approve', outcome, evidence: 'human-decision' }
        if (attempt.diagnostics?.status === 'available') attempt.diagnostics.acceptance = { code: action === 'approve' ? 'not-required' : 'cancelled' }
        draft.state = action === 'approve' ? 'running' : 'cancelled'
        draft.log.push({ seq, at: Date.now(), kind: 'decision', detail: outcome })
      })
      return { record, applied: true }
    })
  }

  /** Terminal settlement after cancelling (effect known, no unknown side effects). */
  async settleTerminal(runId: string, terminal: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'recovery_required', detail: Record<string, unknown> = {}): Promise<RunRecord> {
    return await this.transition(runId, (draft) => {
      const stageAttempt = draft.teamStage?.state === 'provisioning' && draft.teamStage.attemptId !== undefined
        ? draft.attempts.find(attempt => attempt.attemptId === draft.teamStage!.attemptId)
        : undefined
      if (stageAttempt !== undefined && stageAttempt.result === undefined && !TERMINAL_ATTEMPTS.has(stageAttempt.state)) {
        throw new TeamStageConflictError(runId, 'cannot settle the original Attempt while TeamStage is provisioning')
      }
      const seq = draft.seq + 1
      if (terminal === 'cancelled' && draft.state === 'cancelling' && draft.teamStage?.attemptId !== undefined) {
        const stage = draft.teamStage
        const attempt = draft.attempts.find(candidate => candidate.attemptId === stage.attemptId)
        if (stage.state !== 'cancelled' || stage.cancel === undefined || stage.recovery !== undefined
          || stage.effects?.some(effect => ['pending', 'recovery_required'].includes(effect.state))
          || attempt?.nodeId !== stage.stageId || attempt.intent?.kind !== 'agentTask'
          || attempt.state !== 'cancelling' || attempt.result !== undefined) {
          throw new TeamStageConflictError(runId, 'known Team cancellation is required to settle the original Attempt')
        }
        const at = Date.now()
        attempt.state = 'cancelled'
        attempt.result = { seq, at, ok: false, outcome: { kind: 'cancelled' }, evidence: 'teamstage-cancelled' }
        if (attempt.diagnostics?.status === 'available') attempt.diagnostics.acceptance = { code: 'cancelled' }
        draft.log.push({ seq, at, kind: 'result', detail: { attemptId: attempt.attemptId, ok: false, evidence: 'teamstage-cancelled' } })
      }
      // A cancellation wins a racing known settlement, never resurrects Run.
      draft.state = draft.state === 'cancelling' && terminal !== 'recovery_required' ? 'cancelled' : terminal
      if (terminal === 'recovery_required') {
        for (const a of draft.attempts) if (a.intent !== undefined && a.result === undefined && !TERMINAL_ATTEMPTS.has(a.state)) {
          a.state = 'recovery_required'
          if (a.diagnostics?.status === 'available') {
            a.diagnostics.acceptance = { code: 'recovery-required' }
            a.diagnostics.recovery = { code: 'effect-unknown' }
          }
        }
      }
      draft.log.push({ seq, at: Date.now(), kind: terminal === 'recovery_required' ? 'recovery' : 'state', detail })
    })
  }

  /** Rebuild the derived projection from canonical records (C-08: the
   * projection is always rebuildable; deleting it loses nothing). */
  async rebuildProjection(): Promise<{ total: number; byState: Record<string, number>; runs: Array<{ runId: string; state: RunState; definitionRevision: string }> }> {
    const ids = await this.listRunIds()
    const byState: Record<string, number> = {}
    const runs: Array<{ runId: string; state: RunState; definitionRevision: string }> = []
    for (const id of ids) {
      const record = await this.get(id)
      byState[record.state] = (byState[record.state] ?? 0) + 1
      runs.push({ runId: record.runId, state: record.state, definitionRevision: record.definitionRevision })
    }
    return { total: ids.length, byState, runs }
  }
}

const TERMINAL_ATTEMPTS = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'])

function assertActiveTeamStageAttempt(record: RunRecord, binding: TeamStageBinding, runId: string): void {
  if (binding.attemptId === undefined) return
  const attempt = record.attempts.find(candidate => candidate.attemptId === binding.attemptId)
  if (attempt === undefined || attempt.nodeId !== binding.stageId) {
    throw new TeamStageConflictError(runId, 'stage binding attempt does not belong to the declared graph node')
  }
  if (attempt.intent?.kind !== 'agentTask') {
    throw new TeamStageConflictError(runId, 'stage binding attempt is not an agentTask Attempt')
  }
  if (!ACTIVE_TEAM_ATTEMPT_STATES.has(attempt.state) || attempt.result !== undefined) {
    throw new TeamStageConflictError(runId, 'stage binding attempt is not active')
  }
}

function allowedTeamStageTransition(from: TeamStageState, to: TeamStageState): boolean {
  if (from === to) return true
  if (to === 'recovery_required') return true
  if (from === 'cancelling') return to === 'cancelled'
  if (from === 'provisioning') return ['active', 'waiting_input', 'cancelling', 'cancelled', 'failed', 'timed_out'].includes(to)
  if (from === 'active') return ['waiting_input', 'cancelling', 'succeeded', 'failed', 'timed_out'].includes(to)
  if (from === 'waiting_input') return ['active', 'cancelling', 'succeeded', 'failed', 'timed_out'].includes(to)
  return false
}

function sameDigests(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && a[key] === b[key])
}

function sameTeamOutputAcceptance(a: TeamOutputAcceptance, b: TeamOutputAcceptance): boolean {
  return a.code === b.code && a.schemaVersion === b.schemaVersion && a.runId === b.runId
    && a.stageId === b.stageId && a.taskId === b.taskId && a.sourceSessionId === b.sourceSessionId
    && a.attemptId === b.attemptId
    && a.artifactId === b.artifactId && a.digest === b.digest && a.evidenceDigest === b.evidenceDigest
    && a.issueCode === b.issueCode && a.checks.length === b.checks.length
    && a.checks.every((check, index) => check === b.checks[index])
}
