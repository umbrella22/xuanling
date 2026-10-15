/**
 * Canonical run/command record shapes (C-08/C-10). The RunAggregate record is
 * the single durable fact for one run: state, attempts, command key, and an
 * append-only transition log — merged atomically by single-record
 * `table.update` (W0.3: sync RMW, missing-record update throws).
 */
import { z } from 'zod'
import { runSourceCodec, type RunSource } from '../conversation/contracts.ts'
import { attemptDiagnosticsCodec, type AttemptDiagnostics } from '../host/runtime-diagnostics.ts'
import { teamStageExecutionCodec, type TeamStageExecution } from '../host/teamstage-diagnostics.ts'

export const RUN_STATES = ['queued', 'running', 'waiting_input', 'cancelling', 'recovery_required', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const
export const ATTEMPT_STATES = [
  'preparing',
  'ready',
  'running',
  'waiting_input',
  'cancelling',
  'recovery_required',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
  'skipped'
] as const

export type RunState = (typeof RUN_STATES)[number]
export type AttemptState = (typeof ATTEMPT_STATES)[number]
export const TERMINAL_RUN_STATES: readonly RunState[] = ['succeeded', 'failed', 'cancelled', 'timed_out']

export const TEAM_STAGE_STATES = [
  'provisioning',
  'active',
  'waiting_input',
  'cancelling',
  'recovery_required',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out'
] as const
export type TeamStageState = (typeof TEAM_STAGE_STATES)[number]
export const TEAM_ACCEPTANCE_CODES = ['accepted', 'rejected'] as const
export type TeamAcceptanceCode = (typeof TEAM_ACCEPTANCE_CODES)[number]
export const TEAM_STAGE_SCHEMA_VERSION = 1 as const
export const TEAM_OUTPUT_ACCEPTANCE_SCHEMA_VERSION = 1 as const
export const TEAM_EFFECT_STATES = ['pending', 'succeeded', 'failed', 'recovery_required'] as const
export type TeamEffectState = (typeof TEAM_EFFECT_STATES)[number]
export const TEAM_KNOWN_CHECKS = ['schema', 'digest', 'artifact-digest', 'agreement'] as const
export type TeamKnownCheck = (typeof TEAM_KNOWN_CHECKS)[number]

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256 digest')

/** Host-generated identity, never a client-provided filename. */
export const teamArtifactIdSchema = z.string().regex(/^ta-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
const resourceDigestsSchema = z.record(z.string().min(1), sha256)

export const teamMemberReservationSchema = z.strictObject({
  runId: z.string().min(1),
  stageId: z.string().min(1),
  definitionRevision: z.string().min(1),
  attemptId: z.string().min(1),
  effectId: z.string().min(1),
  logicalName: z.string().min(1),
  nativeName: z
    .string()
    .regex(/^bp-[a-f0-9-]{36}$/)
    .max(64),
  reservationSeq: z.number().int().positive(),
  schemaCanonicalJson: z.string().min(1),
  schemaDigest: sha256,
  schemaResourceId: z.string().min(1),
  schemaResourceDigest: sha256,
  resourceDigests: resourceDigestsSchema,
  memberId: z.string().min(1),
  sessionId: z.string().min(1).optional()
})
export type TeamMemberReservation = z.infer<typeof teamMemberReservationSchema>

export const teamCaptureEvidenceSchema = z
  .strictObject({
    producerSessionId: z.string().min(1),
    callId: z.string().min(1),
    rootCallId: z.string().min(1),
    turnId: z.string().min(1),
    completedTurnId: z.string().min(1),
    startLogSeq: z.number().int().nonnegative(),
    captureLogSeq: z.number().int().nonnegative(),
    endLogSeq: z.number().int().nonnegative(),
    completedAt: z.number().finite().nonnegative(),
    flushedAt: z.number().finite().nonnegative(),
    quiescentAt: z.number().finite().nonnegative()
  })
  .superRefine((value, ctx) => {
    if (
      value.turnId !== value.completedTurnId ||
      value.captureLogSeq <= value.startLogSeq ||
      value.endLogSeq <= value.captureLogSeq ||
      value.flushedAt < value.completedAt ||
      value.quiescentAt < value.flushedAt
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'capture requires this completed turn, ordered log references, flush and quiescence' })
    }
  })
export type TeamCaptureEvidence = z.infer<typeof teamCaptureEvidenceSchema>

export const teamCaptureArtifactRefSchema = z.strictObject({
  artifactId: teamArtifactIdSchema,
  digest: sha256,
  byteLength: z.number().int().positive(),
  evidenceDigest: sha256,
  runId: z.string().min(1),
  definitionRevision: z.string().min(1),
  nodeId: z.string().min(1),
  stageId: z.string().min(1),
  attemptId: z.string().min(1),
  taskId: z.string().min(1),
  teamId: z.string().min(1),
  producerMemberId: z.string().min(1),
  logicalName: z.string().min(1),
  nativeName: z.string().min(1),
  effectId: z.string().min(1),
  reservationSeq: z.number().int().positive(),
  schemaDigest: sha256,
  schemaResourceId: z.string().min(1),
  schemaResourceDigest: sha256,
  resourceDigests: resourceDigestsSchema,
  evidence: teamCaptureEvidenceSchema
})
export type TeamCaptureArtifactRef = z.infer<typeof teamCaptureArtifactRefSchema>

export interface TeamMemberSnapshot {
  memberId: string
  name?: string
  logicalName?: string
  phase: 'provisioning' | 'active' | 'failed' | 'inactive'
  status: string
  sessionId?: string
  /** Evidence from this run; phase/status alone never satisfies acceptance. */
  evidence?: {
    runId: string
    stageId: string
    taskId: string
    attemptId: string
    captureId: string
    schemaDigest: string
    valueDigest: string
    completedTurnId: string
    flushedAt: number
    quiescentAt: number
  }
}

/** Canonical external-effect fact retained independently of the bounded audit log. */
export interface TeamEffectSnapshot {
  effectId: string
  kind: string
  stageId: string
  teamId: string
  actorSessionId: string
  /** Canonical member identity used to serialize spawn reservations. */
  memberName?: string
  taskId?: string
  memberId?: string
  state: TeamEffectState
  intentAt: number
  settledAt?: number
  ok?: boolean
  errorCode?: string
  /** Result identities remain available after the bounded audit log rotates. */
  resultTaskId?: string
  resultTaskRevision?: number
  resultMemberId?: string
  resultStatus?: string
}

export interface TeamOutputAcceptance {
  code: TeamAcceptanceCode
  schemaVersion: typeof TEAM_OUTPUT_ACCEPTANCE_SCHEMA_VERSION
  runId: string
  stageId: string
  taskId: string
  attemptId?: string
  sourceSessionId: string
  artifactId: string
  digest: string
  evidenceDigest: string
  checks: string[]
  issueCode?: string
}

/** Host-owned verification of immutable artifact bytes and member evidence.
 * This never carries raw provider output or a filesystem locator. */
export interface TeamHostArtifactVerdict {
  status: 'verified'
  artifactId: string
  digest: string
  byteLength: number
  schemaDigest: string
  evidenceDigest: string
  runId: string
  stageId: string
  taskId: string
  attemptId: string
  producerSessionId: string
  producerMemberId: string
}

export interface TeamStageRecord {
  schemaVersion: typeof TEAM_STAGE_SCHEMA_VERSION
  stageId: string
  runId: string
  teamId: string
  leadSessionId: string
  taskSpecificationFingerprint: string
  /** The existing graph Attempt settled by this stage. */
  attemptId?: string
  /** Server-derived policy; client DTOs cannot reduce these sets. */
  requiredMemberIds?: string[]
  requiredChecks?: string[]
  primaryMemberId?: string
  taskId?: string
  taskRevision?: number
  state: TeamStageState
  members: TeamMemberSnapshot[]
  effects?: TeamEffectSnapshot[]
  /** Additive host facts; old records may omit these but cannot acquire verified success without them. */
  reservations?: TeamMemberReservation[]
  captures?: TeamCaptureArtifactRef[]
  outputAcceptance?: TeamOutputAcceptance
  cancel?: { requestedAt: number; reason?: string }
  recovery?: { code: string; detail?: string }
  execution?: TeamStageExecution
  updatedAt: number
}

export const teamMemberSnapshotSchema = z.strictObject({
  memberId: z.string().min(1),
  name: z.string().min(1).optional(),
  logicalName: z.string().min(1).optional(),
  phase: z.enum(['provisioning', 'active', 'failed', 'inactive']),
  status: z.string().min(1),
  sessionId: z.string().min(1).optional(),
  evidence: z
    .strictObject({
      runId: z.string().min(1),
      stageId: z.string().min(1),
      taskId: z.string().min(1),
      attemptId: z.string().min(1),
      captureId: z.string().min(1),
      schemaDigest: sha256,
      valueDigest: sha256,
      completedTurnId: z.string().min(1),
      flushedAt: z.number(),
      quiescentAt: z.number()
    })
    .optional()
})

export const teamEffectSnapshotSchema = z
  .strictObject({
    effectId: z.string().min(1),
    kind: z.string().min(1),
    stageId: z.string().min(1),
    teamId: z.string().min(1),
    actorSessionId: z.string().min(1),
    memberName: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    memberId: z.string().min(1).optional(),
    state: z.enum(TEAM_EFFECT_STATES),
    intentAt: z.number(),
    settledAt: z.number().optional(),
    ok: z.boolean().optional(),
    errorCode: z.string().min(1).optional(),
    resultTaskId: z.string().min(1).optional(),
    resultTaskRevision: z.number().int().positive().optional(),
    resultMemberId: z.string().min(1).optional(),
    resultStatus: z.string().min(1).optional()
  })
  .superRefine((value, ctx) => {
    if (value.state !== 'pending' && value.settledAt === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['settledAt'], message: 'settled effects require settledAt' })
    }
    if (value.state === 'succeeded' && value.ok !== true) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ok'], message: 'succeeded effects require ok=true' })
    }
    if (value.state === 'failed' && value.ok !== false) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ok'], message: 'failed effects require ok=false' })
    }
  })

export const teamOutputAcceptanceSchema = z
  .strictObject({
    code: z.enum(TEAM_ACCEPTANCE_CODES),
    schemaVersion: z.literal(TEAM_OUTPUT_ACCEPTANCE_SCHEMA_VERSION),
    runId: z.string().min(1),
    stageId: z.string().min(1),
    taskId: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    sourceSessionId: z.string().min(1),
    artifactId: z.string().min(1),
    digest: sha256,
    evidenceDigest: sha256,
    checks: z.array(z.string().min(1)).min(1),
    issueCode: z.string().min(1).optional()
  })
  .superRefine((value, ctx) => {
    if (value.code === 'rejected' && value.issueCode === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['issueCode'], message: 'rejected output requires issueCode' })
    }
  })

export const teamHostArtifactVerdictSchema = z.strictObject({
  status: z.literal('verified'),
  artifactId: z.string().min(1),
  digest: sha256,
  byteLength: z.number().int().nonnegative(),
  schemaDigest: sha256,
  evidenceDigest: sha256,
  runId: z.string().min(1),
  stageId: z.string().min(1),
  taskId: z.string().min(1),
  attemptId: z.string().min(1),
  producerSessionId: z.string().min(1),
  producerMemberId: z.string().min(1)
})

export const teamStageRecordSchema = z
  .strictObject({
    schemaVersion: z.literal(TEAM_STAGE_SCHEMA_VERSION),
    stageId: z.string().min(1),
    runId: z.string().min(1),
    teamId: z.string().min(1),
    leadSessionId: z.string().min(1),
    taskSpecificationFingerprint: sha256,
    attemptId: z.string().min(1).optional(),
    requiredMemberIds: z.array(z.string().min(1)).min(1).optional(),
    requiredChecks: z.array(z.string().min(1)).min(1).optional(),
    primaryMemberId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    taskRevision: z.number().int().positive().optional(),
    state: z.enum(TEAM_STAGE_STATES),
    members: z.array(teamMemberSnapshotSchema),
    effects: z.array(teamEffectSnapshotSchema).optional(),
    reservations: z.array(teamMemberReservationSchema).optional(),
    captures: z.array(teamCaptureArtifactRefSchema).optional(),
    outputAcceptance: teamOutputAcceptanceSchema.optional(),
    cancel: z.strictObject({ requestedAt: z.number(), reason: z.string().min(1).optional() }).optional(),
    recovery: z.strictObject({ code: z.string().min(1), detail: z.string().optional() }).optional(),
    execution: teamStageExecutionCodec().optional(),
    updatedAt: z.number()
  })
  .superRefine((value, ctx) => {
    if ((value.taskId === undefined) !== (value.taskRevision === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taskRevision'], message: 'taskId and taskRevision must be provided together' })
    }
    if (value.outputAcceptance !== undefined && value.outputAcceptance.runId !== value.runId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputAcceptance', 'runId'], message: 'output runId must match stage runId' })
    }
    if (value.outputAcceptance !== undefined && value.outputAcceptance.stageId !== value.stageId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputAcceptance', 'stageId'], message: 'output stageId must match stageId' })
    }
    if (value.outputAcceptance !== undefined && (value.taskId === undefined || value.taskRevision === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputAcceptance', 'taskId'], message: 'output acceptance requires a bound task' })
    }
    if (value.outputAcceptance !== undefined && value.taskId !== undefined && value.outputAcceptance.taskId !== value.taskId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputAcceptance', 'taskId'], message: 'output taskId must match taskId' })
    }
    if (
      value.outputAcceptance !== undefined &&
      value.attemptId !== undefined &&
      value.outputAcceptance.attemptId !== undefined &&
      value.outputAcceptance.attemptId !== value.attemptId
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['outputAcceptance', 'attemptId'], message: 'output attemptId must match attemptId' })
    }
    if (value.state === 'succeeded' && value.outputAcceptance?.code !== 'accepted') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['state'], message: 'succeeded TeamStage requires accepted output' })
    }
    if (value.attemptId === undefined && value.state === 'succeeded') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attemptId'], message: 'succeeded TeamStage requires its graph Attempt binding' })
    }
    if (value.state === 'succeeded' && value.outputAcceptance?.attemptId !== value.attemptId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outputAcceptance', 'attemptId'],
        message: 'succeeded TeamStage requires accepted output for its graph Attempt'
      })
    }
    if (value.requiredMemberIds !== undefined) {
      const ids = new Set(value.requiredMemberIds)
      if (ids.size !== value.requiredMemberIds.length)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredMemberIds'], message: 'required member ids must be unique' })
    }
    if (value.requiredChecks !== undefined) {
      const checks = new Set(value.requiredChecks)
      if (checks.size !== value.requiredChecks.length)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiredChecks'], message: 'required checks must be unique' })
    }
    const memberIds = new Set<string>()
    const memberNames = new Set<string>()
    const memberSessions = new Set<string>()
    for (const [index, member] of value.members.entries()) {
      if (memberIds.has(member.memberId)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['members', index, 'memberId'], message: 'memberId must be unique within a TeamStage' })
      }
      memberIds.add(member.memberId)
      if (member.name !== undefined) {
        if (memberNames.has(member.name)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['members', index, 'name'], message: 'member name must be unique within a TeamStage' })
        }
        memberNames.add(member.name)
      }
      if (member.sessionId !== undefined) {
        if (memberSessions.has(member.sessionId)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['members', index, 'sessionId'], message: 'member sessionId must be unique within a TeamStage' })
        }
        memberSessions.add(member.sessionId)
      }
    }
    if (value.effects !== undefined) {
      const effectIds = new Set<string>()
      for (const [index, effect] of value.effects.entries()) {
        if (effectIds.has(effect.effectId)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effects', index, 'effectId'], message: 'effectId must be unique within a TeamStage' })
        }
        effectIds.add(effect.effectId)
        if (effect.stageId !== value.stageId) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effects', index, 'stageId'], message: 'effect stageId must match stageId' })
        }
        if (effect.teamId !== value.teamId) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effects', index, 'teamId'], message: 'effect teamId must match teamId' })
        }
      }
    }
    for (const field of ['reservations', 'captures'] as const) {
      const entries = value[field] ?? []
      for (const key of field === 'reservations' ? (['logicalName', 'nativeName', 'effectId'] as const) : (['producerMemberId', 'artifactId'] as const)) {
        const ids = entries.map(entry => (entry as unknown as Record<string, unknown>)[key])
        if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${key} must be unique` })
      }
    }
  })

export const teamStageBindingSchema = z.strictObject({
  stageId: z.string().min(1),
  teamId: z.string().min(1),
  leadSessionId: z.string().min(1),
  taskSpecificationFingerprint: sha256,
  attemptId: z.string().min(1).optional(),
  requiredMemberIds: z.array(z.string().min(1)).min(1).optional(),
  requiredChecks: z.array(z.string().min(1)).min(1).optional(),
  primaryMemberId: z.string().min(1).optional()
})

export interface AttemptRecord {
  attemptId: string
  nodeId: string
  state: AttemptState
  attempt: number
  /** Durable dispatch intent: written BEFORE any external effect. */
  intent?: { seq: number; at: number; kind: string; resourceDigests: Record<string, string> }
  /** Settled outcome: written when the effect is known. */
  result?: { seq: number; at: number; ok: boolean; outcome: unknown; evidence: string }
  sessionId?: string
  diagnostics?: AttemptDiagnostics
}

export interface TransitionEvent {
  seq: number
  at: number
  kind: 'admitted' | 'intent' | 'result' | 'state' | 'decision' | 'cancel-requested' | 'recovery'
  detail: Record<string, unknown>
}

export interface RunRecord {
  blueprintId?: string
  source?: RunSource
  runId: string
  definitionRevision: string
  /** The frozen definition document driving this run (same-process replay
   * and restart recovery read this, never the live file). */
  definitionJson: string
  inputRef: string
  commandKey: string
  state: RunState
  attempts: AttemptRecord[]
  /** Optional additive TeamStage canonical fact. Legacy records omit this key. */
  teamStage?: TeamStageRecord
  /** Append-only transition evidence; bounded, oldest entries are dropped. */
  log: TransitionEvent[]
  seq: number
  createdAt: number
  updatedAt: number
}

export interface CommandRecord {
  commandKey: string
  scope: string
  requestId: string
  payloadFingerprint: string
  runId: string | null
  createdAt: number
}

export const runRecordSchema = z
  .object({
    blueprintId: z.string().min(1).optional(),
    source: runSourceCodec().optional(),
    runId: z.string().min(1),
    definitionRevision: z.string().min(1),
    definitionJson: z.string(),
    inputRef: z.string(),
    commandKey: z.string().min(1),
    state: z.enum(RUN_STATES),
    attempts: z.array(
      z.object({
        attemptId: z.string().min(1),
        nodeId: z.string().min(1),
        state: z.enum(ATTEMPT_STATES),
        attempt: z.number().int().nonnegative(),
        intent: z.object({ seq: z.number(), at: z.number(), kind: z.string(), resourceDigests: z.record(z.string(), z.string()) }).optional(),
        result: z.object({ seq: z.number(), at: z.number(), ok: z.boolean(), outcome: z.unknown(), evidence: z.string() }).optional(),
        sessionId: z.string().optional(),
        diagnostics: attemptDiagnosticsCodec().optional()
      })
    ),
    teamStage: teamStageRecordSchema.optional(),
    log: z.array(
      z.object({
        seq: z.number(),
        at: z.number(),
        kind: z.enum(['admitted', 'intent', 'result', 'state', 'decision', 'cancel-requested', 'recovery']),
        detail: z.record(z.string(), z.unknown())
      })
    ),
    seq: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number()
  })
  .superRefine((value, ctx) => {
    if (value.teamStage !== undefined && value.teamStage.runId !== value.runId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['teamStage', 'runId'], message: 'team stage runId must match parent runId' })
    }
  })

export const commandRecordSchema = z.object({
  commandKey: z.string().min(1),
  scope: z.string().min(1),
  requestId: z.string().min(1),
  payloadFingerprint: z.string().min(1),
  runId: z.string().nullable(),
  createdAt: z.number()
})

export const recordsSchema = {
  runs: runRecordSchema,
  commands: commandRecordSchema
}
