/** Browser-safe conversation contracts. These views contain logical identities
 * and frozen layout only; resource locators and execution configuration stay host-owned. */
import { z } from 'zod'
import { attemptDiagnosticsCodec } from '../host/runtime-diagnostics.ts'
import { teamStageExecutionCodec, teamStageRuntimeCodec } from '../host/teamstage-diagnostics.ts'

const id = () => z.string().min(1)
const TEAM_STAGE_SCHEMA_VERSION = 1 as const
const TEAM_OUTPUT_ACCEPTANCE_SCHEMA_VERSION = 1 as const
export const runSourceCodec = () =>
  z.strictObject({
    sessionId: id(),
    kind: z.enum(['ui', 'tool']),
    callId: id().optional(),
    turn: z.number().int().nonnegative().optional()
  })
export type RunSource = z.infer<ReturnType<typeof runSourceCodec>>
const teamDigest = () => z.string().regex(/^[a-f0-9]{64}$/)
export const teamOutputAcceptanceCodec = () =>
  z.strictObject({
    code: z.enum(['accepted', 'rejected']),
    schemaVersion: z.literal(TEAM_OUTPUT_ACCEPTANCE_SCHEMA_VERSION),
    runId: id(),
    stageId: id(),
    taskId: id(),
    attemptId: id().optional(),
    sourceSessionId: id(),
    artifactId: id(),
    digest: teamDigest(),
    evidenceDigest: teamDigest(),
    checks: z.array(id()).min(1),
    issueCode: id().optional()
  })
export type TeamOutputAcceptanceView = z.infer<ReturnType<typeof teamOutputAcceptanceCodec>>
export const teamStageProjectionCodec = () =>
  z.strictObject({
    schemaVersion: z.literal(TEAM_STAGE_SCHEMA_VERSION),
    stageId: id(),
    runId: id(),
    teamId: id(),
    leadSessionId: id(),
    attemptId: id().optional(),
    requiredMemberIds: z.array(id()).optional(),
    requiredChecks: z.array(id()).optional(),
    primaryMemberId: id().optional(),
    taskSpecificationFingerprint: teamDigest(),
    taskId: id().optional(),
    taskRevision: z.number().int().positive().optional(),
    state: z.enum(['provisioning', 'active', 'waiting_input', 'cancelling', 'recovery_required', 'succeeded', 'failed', 'cancelled', 'timed_out']),
    members: z.array(
      z.strictObject({
        memberId: id(),
        name: id().optional(),
        phase: z.enum(['provisioning', 'active', 'failed', 'inactive']),
        status: id(),
        sessionId: id().optional(),
        evidence: z.strictObject({ captureId: id(), completedTurnId: id(), flushedAt: z.number(), quiescentAt: z.number() }).optional()
      })
    ),
    outputAcceptance: teamOutputAcceptanceCodec().optional(),
    cancel: z.strictObject({ requestedAt: z.number(), reason: id().optional() }).optional(),
    recovery: z.strictObject({ code: id(), detail: z.string().optional() }).optional(),
    execution: teamStageExecutionCodec().optional(),
    effects: z.array(z.strictObject({ effectId: id(), kind: id(), state: z.enum(['pending', 'succeeded', 'failed', 'recovery_required']) })).optional(),
    runtime: teamStageRuntimeCodec().optional(),
    updatedAt: z.number()
  })
export type TeamStageProjection = z.infer<ReturnType<typeof teamStageProjectionCodec>>
const teamTaskViewCodec = () =>
  z.strictObject({
    id: id(),
    revision: z.number().int().positive(),
    status: z.string().min(1).optional()
  })
export type TeamTaskView = z.infer<ReturnType<typeof teamTaskViewCodec>>
export const startTeamStageArgsCodec = () =>
  z.strictObject({
    sessionId: id(),
    runId: id(),
    stageId: id(),
    taskSpecificationFingerprint: teamDigest(),
    subject: z.string().min(1),
    description: z.string().min(1),
    blockedBy: z.array(id()).optional(),
    writeScopes: z.array(id()).optional()
  })
export type StartTeamStageArgs = z.infer<ReturnType<typeof startTeamStageArgsCodec>>
export const cancelTeamStageArgsCodec = () =>
  z.strictObject({
    sessionId: id(),
    runId: id(),
    memberNames: z.array(id()),
    reason: z.string().min(1).max(256).optional()
  })
export type CancelTeamStageArgs = z.infer<ReturnType<typeof cancelTeamStageArgsCodec>>
export const acceptTeamStageOutputArgsCodec = () =>
  z.strictObject({
    sessionId: id(),
    runId: id(),
    stageId: id(),
    taskId: id(),
    code: z.enum(['accepted', 'rejected']),
    schemaVersion: z.literal(TEAM_OUTPUT_ACCEPTANCE_SCHEMA_VERSION),
    artifactId: id(),
    digest: teamDigest(),
    evidenceDigest: teamDigest(),
    checks: z.array(id()).min(1),
    issueCode: id().optional(),
    requiredChecks: z.array(id()).min(1).optional(),
    requiredMemberIds: z.array(id()).optional()
  })
export type AcceptTeamStageOutputArgs = z.infer<ReturnType<typeof acceptTeamStageOutputArgsCodec>>
export const teamStageActionCodec = () =>
  z.strictObject({
    runId: id(),
    team: teamStageProjectionCodec(),
    task: teamTaskViewCodec().optional(),
    replayed: z.boolean()
  })
export type TeamStageActionView = z.infer<ReturnType<typeof teamStageActionCodec>>
export const runSnapshotCodec = () =>
  z.strictObject({
    runId: id(),
    state: z.string(),
    definitionRevision: z.string(),
    source: runSourceCodec().optional(),
    seq: z.number(),
    attempts: z.array(
      z.strictObject({
        nodeId: z.string(),
        state: z.string(),
        attempt: z.number(),
        attemptId: z.string().optional(),
        sessionId: id().optional(),
        resultKind: z.string().optional(),
        outputJson: z.string().optional(),
        errorCode: z.string().optional(),
        diagnostics: attemptDiagnosticsCodec().optional()
      })
    ),
    logTail: z.array(z.strictObject({ seq: z.number(), kind: z.string() })),
    team: teamStageProjectionCodec().optional()
  })
export type RunSnapshotView = z.infer<ReturnType<typeof runSnapshotCodec>>
const edge = () => z.strictObject({ kind: z.enum(['data', 'control']), from: z.string(), to: z.string() })
const xy = () => z.strictObject({ x: z.number().finite(), y: z.number().finite() })
export const frozenGraphCodec = () =>
  z.strictObject({
    nodes: z.array(
      z.strictObject({
        id: id(),
        kind: z.enum(['input', 'output', 'agentTask', 'condition', 'join', 'humanDecision']),
        inputs: z.record(z.string(), z.string()).optional(),
        outputs: z.record(z.string(), z.string()).optional(),
        branches: z.array(z.string()).optional()
      })
    ),
    edges: z.array(edge())
  })
export type FrozenGraphView = z.infer<ReturnType<typeof frozenGraphCodec>>
export const frozenPresentationCodec = () =>
  z.strictObject({
    nodes: z.record(
      z.string(),
      xy().extend({
        ports: z.strictObject({ control: z.boolean().optional(), inputs: z.boolean().optional(), outputs: z.boolean().optional() }).optional(),
        title: z.string().optional(),
        collapsed: z.boolean().optional(),
        pinned: z.boolean().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        color: z.enum(['default', 'blue', 'green', 'amber', 'red', 'purple']).optional()
      })
    ),
    resources: z.record(z.string(), z.strictObject({ title: z.string().optional(), description: z.string().optional() })).optional(),
    groups: z.array(z.strictObject({ id: id(), label: z.string().optional(), nodeIds: z.array(z.string()) })).optional(),
    edges: z.array(edge().extend({ points: z.array(xy()) })).optional()
  })
export type FrozenPresentationView = z.infer<ReturnType<typeof frozenPresentationCodec>>
export const startSessionRunArgsCodec = () =>
  z.strictObject({
    blueprintId: id(),
    expectedRevision: id(),
    inputJson: z.string(),
    requestId: id(),
    sessionId: id()
  })
export type StartSessionRunArgs = z.infer<ReturnType<typeof startSessionRunArgsCodec>>
export const runAdmissionCodec = () => z.strictObject({ runId: id(), semanticRevision: z.string(), state: z.string(), replayed: z.boolean() })
export type RunAdmissionView = z.infer<ReturnType<typeof runAdmissionCodec>>
const RUN_HISTORY_STATES = ['queued', 'running', 'waiting_input', 'cancelling', 'recovery_required', 'succeeded', 'failed', 'cancelled', 'timed_out'] as const
const runHistoryStateCodec = () => z.enum(RUN_HISTORY_STATES)
export const runQueryArgsCodec = () =>
  z
    .strictObject({
      sessionId: id().optional(),
      blueprintId: id().optional(),
      state: runHistoryStateCodec().optional(),
      cursor: id().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      includeArchived: z.boolean().optional()
    })
    .superRefine((value, ctx) => {
      if (value.sessionId === undefined && value.blueprintId === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [], message: 'sessionId or blueprintId is required' })
      }
    })
export type RunQueryArgs = z.infer<ReturnType<typeof runQueryArgsCodec>>
const runHistorySummaryCodec = () =>
  z.strictObject({
    runId: id(),
    blueprintId: id().optional(),
    state: runHistoryStateCodec(),
    createdAt: z.number(),
    updatedAt: z.number(),
    definitionRevision: id(),
    attemptCount: z.number().int().nonnegative(),
    archived: z.boolean()
  })
export const runQueryCodec = () => z.strictObject({ runs: z.array(runHistorySummaryCodec()), nextCursor: id().optional() })
export type RunQueryValue = z.infer<ReturnType<typeof runQueryCodec>>
export const runLifecycleActionArgsCodec = () => z.strictObject({ runId: id() })
export type RunLifecycleActionArgs = z.infer<ReturnType<typeof runLifecycleActionArgsCodec>>
export const runLifecycleActionCodec = () => z.strictObject({ runId: id(), archived: z.boolean() })
export type RunLifecycleActionValue = z.infer<ReturnType<typeof runLifecycleActionCodec>>
export const inspectSessionArgsCodec = () => z.strictObject({ sessionId: id(), runId: id().optional() })
export type InspectSessionArgs = z.infer<ReturnType<typeof inspectSessionArgsCodec>>
export const inspectSessionCodec = () =>
  z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('unbound'), sessionId: id() }),
    z.strictObject({
      status: z.literal('bound'),
      sessionId: id(),
      runs: z.array(z.strictObject({ runId: id(), blueprintId: id().optional(), state: z.string(), createdAt: z.number(), definitionRevision: z.string() })),
      nextCursor: id().optional(),
      selected: z.strictObject({
        run: runSnapshotCodec(),
        source: runSourceCodec().optional(),
        graph: frozenGraphCodec(),
        presentation: frozenPresentationCodec().optional(),
        focusAttemptIds: z.array(id()),
        team: teamStageProjectionCodec().optional()
      })
    })
  ])
export type InspectSessionValue = z.infer<ReturnType<typeof inspectSessionCodec>>
