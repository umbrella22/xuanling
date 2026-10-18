/** Host-owned document/catalog and durable runtime entry. Public DTOs contain
 * logical IDs only; machine roots are resolved exclusively from configuration.
 * Explicit local-root helpers remain an in-process compatibility seam.
 */
import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import type { AuthoringCandidate } from './definition/authoring.ts'
import { projectRunSnapshot } from './conversation/run-projection.ts'
import { installConversationTools, liveCaller, assertRootCaller } from './conversation/host-tools.ts'
import { captureNativeSourceParent, assertNativeSourceParent, type NativeSourceParent } from './conversation/native-session-lineage.ts'
import {
  type RunQueryArgs,
  type RunQueryValue,
  type RunLifecycleActionArgs,
  type RunLifecycleActionValue,
  teamStageActionCodec,
  type RunSource,
  type RunSnapshotView,
  type StartSessionRunArgs,
  type InspectSessionArgs,
  type InspectSessionValue,
  type StartTeamStageArgs,
  type CancelTeamStageArgs,
  type AcceptTeamStageOutputArgs,
  type TeamStageActionView
} from './conversation/contracts.ts'
export type {
  RunSource,
  RunSnapshotView,
  StartSessionRunArgs,
  InspectSessionArgs,
  InspectSessionValue,
  FrozenGraphView,
  FrozenPresentationView,
  RunAdmissionView,
  StartTeamStageArgs,
  CancelTeamStageArgs,
  AcceptTeamStageOutputArgs,
  TeamStageActionView,
  RunLifecycleActionArgs,
  RunLifecycleActionValue,
  RunQueryArgs,
  RunQueryValue
} from './conversation/contracts.ts'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AgentCompositionUnsupportedError, BlueprintAgentExecutor, type AgentExecutionEvidence } from './host/agent-executor.ts'
import { collectPreflight, type ToolBindings, type PreflightRunArgs, type PreflightRunValue, type PreflightCheck } from './host/preflight.ts'
import type { HostResourceCatalogValue } from './host/resource-catalog.ts'
import { RuntimeSnapshots, createHostResourceProvider } from './resources/runtime-snapshots.ts'
import { type RunRecord } from './persistence/records.ts'
import { DecisionConflictError, RunNotFoundError, TeamOutputRejectedError, TeamStageConflictError, TeamTaskConflictError } from './persistence/run-store.ts'
import { snapshotDirectory } from './resources/index.ts'
import { resolveResource, type SkillRoot } from './resources/resolver.ts'
import {
  DefinitionDocumentMissingError,
  DocumentRevisionConflictError,
  PackageBoundaryError,
  type DefinitionDocument,
  type DefinitionPackage
} from './definition/persist.ts'
import { TYPERT } from './typert.host.ts'
import { admitResources } from './security/resource-admission.ts'
import { decodeDefinition, validateDefinition } from './definition/index.ts'
import { openBlueprintDomain, RunQuery, RunStore, WriterLease, DurabilityFailureError } from './persistence/index.ts'
import { RunReadService } from './service/run-read-service.ts'
import { BlueprintDocumentLibrary } from './service/document-library.ts'
import { BlueprintDefinitionUseCases } from './service/definition-use-cases.ts'
import { BlueprintPortabilityUseCases } from './service/portability-use-cases.ts'
import { RunExecutionService } from './service/run-execution.ts'
import { reconcileOnStart } from './orchestration/index.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamNativeAdapter, TeamCapabilityUnavailableError, TeamIdentityUnavailableError, type LeadHandle } from './teamstage/native-adapter.ts'
import { createBoundTeamTask } from './teamstage/task-binding.ts'
import { cancelOwnedTeamStage, validateOwnedTeamMemberNames } from './teamstage/cancellation.ts'
import { acceptTeamOutput } from './teamstage/acceptance.ts'
import { TeamStageObservations } from './teamstage/observability.ts'
import { admitTeamDriver, TeamDriverError, type TeamProviders } from './teamstage/driver-admission.ts'
import { resolveFrozenTeamStageAdmission } from './teamstage/public-boundary.ts'

// Explicit frozen TeamStage nodes use the optional native boundary. These
// exports do not mount DSH's Team profile; ordinary Run routing is independent.
export * from './teamstage/index.ts'

/** Build metadata surfaced through `ping` for install diagnostics. */
export const PLUGIN_NAME = '@xuanling-rs/xuanling-dsh-blueprint'
export const PLUGIN_VERSION = '0.6.1'

export interface PingValue {
  status: 'ok'
  service: string
  version: string
}

export interface ValidateArgs {
  definitionJson: string
}

export interface StartRunArgs {
  blueprintId: string
  expectedRevision: string
  inputJson: string
  requestId: string
}
interface InternalStartRunArgs {
  definitionJson: string
  inputJson: string
  runtimeRoot?: string
  rootDir?: string
  requestId?: string
}
export interface BlueprintConfig {
  blueprints?: Record<string, string>
  /** Host-managed definitions; defaults to runtimeRoot/definitions, or the profile data directory. */
  libraryRoot?: string
  runtimeRoot?: string
  /** Maximum ordinary graph nodes in flight within one Run; defaults to 4. */
  maxConcurrentNodes?: number
  skillRoots?: SkillRoot[]
  toolBindings?: ToolBindings
  /** Native subagent registry routes, separate from the LLM provider. */
  teamProviders?: TeamProviders
}
export interface DeleteDefinitionArgs {
  blueprintId: string
  expectedRevision: string
  requestId: string
}
export interface LoadDefinitionArgs {
  blueprintId: string
}
export interface CreateDefinitionArgs {
  requestId: string
  definitionJson: string
}
export interface SaveDefinitionArgs {
  blueprintId: string
  definitionJson: string
  expectedRevision: string | null
}

export interface InspectRunArgs {
  runId: string
}

export interface CancelRunArgs {
  runId: string
}

export interface DecideArgs {
  runId: string
  decisionId: string
  action: string
}

export interface ExportDefinitionArgs {
  blueprintId: string
}

export interface ImportDefinitionArgs {
  blueprintId: string
  archiveBase64: string
}

export interface HostProbeArgs {
  blueprintId: string
  resourceId: string
  input: string
}
interface InternalHostProbeArgs {
  skillDir: string
  input: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'blueprint/capability-unavailable': {
      readonly method: string
      readonly plugin: string
      readonly version: string
    }
    'blueprint/preflight-blocked': { readonly checks: PreflightCheck[] }
    'blueprint/host-probe-invalid': {
      readonly reason: string
    }
    'blueprint/definition-invalid': {
      readonly issues: string
    }
    'blueprint/definition-deleted': { readonly blueprintId: string }
    'blueprint/library-state-invalid': { readonly operation: string }
    'blueprint/library-busy': { readonly operation: string }
    'blueprint/definition-not-found': { readonly blueprintId: string }
    'blueprint/revision-conflict': { readonly blueprintId: string; readonly expectedRevision: string | null; readonly actualRevision: string | null }
    'blueprint/definition-write-failed': { readonly blueprintId: string; readonly operation: string; readonly reason: string }
    'blueprint/session-unavailable': { readonly sessionId: string }
    'blueprint/nested-run-unavailable': { readonly sessionId: string }
    'blueprint/team-unavailable': { readonly method: string; readonly plugin: string; readonly version: string }
    'blueprint/team-identity-unavailable': { readonly sessionId: string }
    'blueprint/team-stage-conflict': { readonly runId: string; readonly detail: string }
    'blueprint/team-task-conflict': { readonly runId: string; readonly detail: string }
    'blueprint/team-output-rejected': { readonly runId: string; readonly issueCode: string }
    'blueprint/run-not-found': {
      readonly runId: string
    }
    'blueprint/invalid-cursor': Record<string, never>
    'blueprint/invalid-query': {
      readonly reason: string
    }
    'blueprint/run-lifecycle-conflict': {
      readonly runId: string
      readonly detail: string
    }
    'blueprint/illegal-transition': {
      readonly detail: string
    }
    'blueprint/durability-failed': {
      readonly operation: string
    }
    'blueprint/export-failed': {
      readonly detail: string
      readonly code: string
    }
    'blueprint/import-failed': {
      readonly detail: string
      readonly code: string
    }
    'blueprint/decision-invalid': {
      readonly detail: string
    }
  }
}

export interface RuntimeHandle {
  opened: Awaited<ReturnType<typeof openBlueprintDomain>>
  store: RunStore
  query: RunQuery
  reads: RunReadService
  lease: WriterLease
  stopLeaseHeartbeat: () => void
  root: string
  snapshots: RuntimeSnapshots
  admissionTail: Promise<unknown>
  driverTail: Promise<unknown>
  jobs: Map<string, Promise<void>>
  rerun: Set<string>
  controllers: Map<string, Map<string, AbortController>>
  cancellationTails: Map<string, Promise<RunRecord>>
  backgroundFailures: Map<string, Error>
}

export interface NodeSettlement {
  terminal: 'failed' | 'cancelled' | 'timed_out' | 'recovery_required'
  detail: Record<string, unknown>
}

function publicTeamTask(value: unknown, runId: string): { id: string; revision: number; status?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TeamTaskConflictError(runId, 'native Team task response is not an object')
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate.id !== 'string' ||
    candidate.id.length === 0 ||
    typeof candidate.revision !== 'number' ||
    !Number.isInteger(candidate.revision) ||
    candidate.revision < 1
  ) {
    throw new TeamTaskConflictError(runId, 'native Team task response lacks a stable id/revision')
  }
  return {
    id: candidate.id,
    revision: candidate.revision,
    ...(typeof candidate.status === 'string' && candidate.status.length > 0 ? { status: candidate.status } : {})
  }
}

function publicTeamAction(record: RunRecord, task: unknown, replayed: boolean): TeamStageActionView {
  const projection = projectRunSnapshot(record).team
  if (projection === undefined) throw new TeamStageConflictError(record.runId, 'TeamStage projection is missing')
  return teamStageActionCodec().parse({
    runId: record.runId,
    team: projection,
    ...(task === undefined ? {} : { task: publicTeamTask(task, record.runId) }),
    replayed
  })
}

function teamStageRemoteError(error: unknown, method: string, sessionId: string): RemoteError {
  if (error instanceof RemoteError) return error
  const code = (error as { code?: unknown })?.code
  if (code === 'TEAM_UNAVAILABLE' || error instanceof TeamCapabilityUnavailableError) {
    return new RemoteError('blueprint/team-unavailable', 'TeamStage capability unavailable', { method, plugin: PLUGIN_NAME, version: PLUGIN_VERSION })
  }
  if (code === 'TEAM_IDENTITY_UNAVAILABLE' || error instanceof TeamIdentityUnavailableError) {
    return new RemoteError('blueprint/team-identity-unavailable', 'Team Lead identity unavailable', { sessionId })
  }
  if (code === 'RUN_NOT_FOUND' || error instanceof RunNotFoundError) {
    return new RemoteError('blueprint/run-not-found', 'Run not found', { runId: (error as { runId?: string }).runId ?? 'unknown' })
  }
  if (code === 'TEAM_STAGE_CONFLICT' || error instanceof TeamStageConflictError) {
    const candidate = error as { runId?: string }
    return new RemoteError('blueprint/team-stage-conflict', 'TeamStage state conflict', { runId: candidate.runId ?? 'unknown', detail: 'stage-conflict' })
  }
  if (code === 'TEAM_TASK_CONFLICT' || error instanceof TeamTaskConflictError || code === 'TEAM_TASK_INVALID' || code === 'TEAM_TASK_STALE_REVISION') {
    const candidate = error as { runId?: string }
    return new RemoteError('blueprint/team-task-conflict', 'Team task state conflict', { runId: candidate.runId ?? 'unknown', detail: 'task-conflict' })
  }
  if (code === 'TEAM_OUTPUT_REJECTED' || error instanceof TeamOutputRejectedError || code === 'TEAM_ACCEPTANCE_REJECTED') {
    const candidate = error as { runId?: string; issueCode?: string }
    return new RemoteError('blueprint/team-output-rejected', 'Team output rejected', {
      runId: candidate.runId ?? 'unknown',
      issueCode: candidate.issueCode ?? 'output-rejected'
    })
  }
  if (code === 'TEAM_MEMBER_INVALID' || code === 'TEAM_CANCELLATION_FAILED') {
    const candidate = error as { runId?: string }
    return new RemoteError('blueprint/team-stage-conflict', 'Team member state conflict', { runId: candidate.runId ?? 'unknown', detail: 'member-invalid' })
  }
  return new RemoteError('blueprint/durability-failed', 'TeamStage operation failed', { operation: method })
}

export class BlueprintService extends TypertRemoteService {
  static inject = [] as const
  /** Single-process writer per runtime root (W0.3: backends do not
   * coordinate across processes; the lease enforces one writer here). */
  private readonly runtimes = new Map<string, RuntimeHandle>()
  private readonly opening = new Map<string, Promise<RuntimeHandle>>()
  private closing = false
  private readonly documents: BlueprintDocumentLibrary
  private readonly definitions: BlueprintDefinitionUseCases
  private readonly portability: BlueprintPortabilityUseCases
  private readonly teamObservations = new TeamStageObservations()
  private readonly execution: RunExecutionService

  constructor(
    ctx: Context,
    private readonly config: BlueprintConfig = {}
  ) {
    super(ctx, 'blueprint', { namespace: 'blueprint' })
    this.documents = new BlueprintDocumentLibrary({
      managedRoot: () => this.managedLibraryRoot(),
      decodeDefinition: definitionJson => this.decodeOrThrow(definitionJson),
      checkResources: definition => this.checkResources(definition),
      documentFailure: (blueprintId, operation, error) => this.documentFailure(blueprintId, operation, error)
    })
    this.definitions = new BlueprintDefinitionUseCases({
      ctx: this.ctx,
      config,
      documents: this.documents,
      managedLibraryRoot: () => this.managedLibraryRoot(),
      configuredRuntimeRoot: () => this.configuredRuntimeRoot(),
      blueprintRoot: blueprintId => this.blueprintRoot(blueprintId),
      decodeOrThrow: definitionJson => this.decodeOrThrow(definitionJson),
      checkResources: definition => this.checkResources(definition),
      checkArgs: (method, args) => this.checkArgs(method, args),
      revisionConflict: (blueprintId, expectedRevision, actualRevision) => this.revisionConflict(blueprintId, expectedRevision, actualRevision),
      documentFailure: (blueprintId, operation, error) => this.documentFailure(blueprintId, operation, error)
    })
    this.portability = new BlueprintPortabilityUseCases({
      ctx: this.ctx,
      skillRoots: () => this.config.skillRoots,
      documents: this.documents,
      blueprintRoot: blueprintId => this.blueprintRoot(blueprintId),
      decodeOrThrow: definitionJson => this.decodeOrThrow(definitionJson),
      checkArgs: (method, args) => this.checkArgs(method, args),
      checkResources: definition => this.checkResources(definition),
      materializePackage: (snapshot, root) => this.materializePackage(snapshot, root),
      portabilityFailure: (method, error) => this.portabilityFailure(method, error)
    })
    this.execution = new RunExecutionService({
      ctx: this.ctx,
      config: {
        ...(config.maxConcurrentNodes === undefined ? {} : { maxConcurrentNodes: config.maxConcurrentNodes }),
        ...(config.toolBindings === undefined ? {} : { toolBindings: config.toolBindings }),
        ...(config.teamProviders === undefined ? {} : { teamProviders: config.teamProviders })
      },
      isClosing: () => this.closing,
      decodeDefinition: definitionJson => this.decodeOrThrow(definitionJson),
      driveRun: (handle, runId, definition, sourceParent) => this.driveRun(handle, runId, definition, sourceParent),
      cancelTeamRun: (handle, run, lead, memberNames, reason, settleParentRun) => this.cancelTeamRun(handle, run, lead, memberNames, reason, settleParentRun),
      teamObservations: this.teamObservations
    })
    if (config.maxConcurrentNodes !== undefined && (!Number.isSafeInteger(config.maxConcurrentNodes) || config.maxConcurrentNodes < 1))
      throw new TypeError('maxConcurrentNodes must be a positive safe integer')
    installConversationTools(this.ctx, this, (args, source) =>
      this.startConfiguredRun(
        {
          ...args,
          requestId: `blueprint-tool-${createHash('sha256')
            .update(JSON.stringify([source.sessionId, source.callId]))
            .digest('hex')}`
        },
        source
      )
    )
    this.ctx.effect(
      () => async () => {
        this.closing = true
        await this.documents.drainLibrary()
        await Promise.allSettled(this.opening.values())
        for (const handle of this.runtimes.values()) {
          for (const controllers of handle.controllers.values()) for (const controller of controllers.values()) controller.abort()
          await Promise.allSettled(handle.cancellationTails.values())
          await Promise.allSettled(handle.jobs.values())
          await handle.admissionTail
          await handle.opened.close()
          handle.stopLeaseHeartbeat()
          handle.lease.release()
        }
        this.runtimes.clear()
      },
      'blueprint: close runtime stores'
    )
  }

  /** Decode+validate with the typed wire failure vocabulary (domain errors
   * stay DEFINITION_INVALID locally; the wire carries blueprint/definition-invalid). */
  private decodeOrThrow(definitionJson: string): ReturnType<typeof decodeDefinition> {
    try {
      const definition = decodeDefinition(definitionJson)
      validateDefinition(definition)
      return definition
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'DEFINITION_INVALID') {
        const issues = (error as { issues?: Array<{ code: string; pointer?: string }> }).issues ?? []
        const summary = issues
          .slice(0, 3)
          .map(i => i.code)
          .join('; ')
        throw new RemoteError('blueprint/definition-invalid', `definition invalid: ${summary}`, { issues: summary })
      }
      throw error
    }
  }

  private checkArgs(method: string, args: unknown): void {
    const codec = TYPERT.invocations.find(i => i.method === method)?.parameters[0]?.codec.create()
    if (!codec?.safeParse(args).success) throw new RemoteError('gateway/bad-request', 'invalid blueprint arguments', {})
  }

  private teamLeadForSession(sessionId: string, method: string): { caller: ReturnType<typeof liveCaller>; lead: LeadHandle } {
    let caller: ReturnType<typeof liveCaller>
    try {
      caller = liveCaller(this.ctx, sessionId)
      assertRootCaller(caller)
    } catch (error) {
      const code = (error as { code?: unknown })?.code
      if (code === 'nested-run-unavailable')
        throw new RemoteError('blueprint/nested-run-unavailable', 'nested TeamStage mutation is unavailable', { sessionId })
      throw new RemoteError('blueprint/session-unavailable', 'TeamStage caller session is unavailable', { sessionId })
    }
    try {
      return { caller, lead: new TeamNativeAdapter(this.ctx).lead(caller) }
    } catch (error) {
      throw teamStageRemoteError(error, method, sessionId)
    }
  }

  /** Execute one owned Team cancellation per Run. The in-memory tail closes
   * the same-process race; the durable stage/effect facts cover restart and
   * late native outcomes. */
  private cancelTeamRun(
    handle: RuntimeHandle,
    run: RunRecord,
    lead?: LeadHandle,
    memberNames?: readonly string[],
    reason?: string,
    settleParentRun = true
  ): Promise<RunRecord> {
    const existing = handle.cancellationTails.get(run.runId)
    if (existing !== undefined) {
      if (!settleParentRun) return existing
      return existing.then(async result => {
        const current = await handle.store.get(run.runId)
        if (current.state !== 'cancelling') return current
        if (result.teamStage?.state === 'recovery_required') {
          return await handle.store.settleTerminal(run.runId, 'recovery_required', { reason: result.teamStage.recovery?.code ?? 'team-effect-unknown' })
        }
        if (result.teamStage?.state === 'cancelled') {
          return await handle.store.settleTerminal(run.runId, 'cancelled', { reason: 'teamstage-cancelled' })
        }
        return current
      })
    }
    const task = this.performTeamCancellation(handle, run, lead, memberNames, reason, settleParentRun)
    handle.cancellationTails.set(run.runId, task)
    void task.then(
      () => {
        if (handle.cancellationTails.get(run.runId) === task) handle.cancellationTails.delete(run.runId)
      },
      () => {
        if (handle.cancellationTails.get(run.runId) === task) handle.cancellationTails.delete(run.runId)
      }
    )
    return task
  }

  private async performTeamCancellation(
    handle: RuntimeHandle,
    run: RunRecord,
    suppliedLead?: LeadHandle,
    memberNames?: readonly string[],
    reason?: string,
    settleParentRun = true
  ): Promise<RunRecord> {
    const current = await handle.store.get(run.runId)
    const stage = current.teamStage
    if (stage === undefined) return current
    if (['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(stage.state)) {
      if (!settleParentRun || current.state !== 'cancelling') return current
      return await handle.store.settleTerminal(current.runId, stage.state === 'recovery_required' ? 'recovery_required' : 'cancelled', {
        reason: stage.state === 'recovery_required' ? 'team-effect-unknown' : 'teamstage-cancelled'
      })
    }

    let lead = suppliedLead
    try {
      if (lead === undefined) {
        const parent = captureNativeSourceParent(this.ctx, stage.leadSessionId)
        lead = new TeamNativeAdapter(this.ctx).lead(parent.agent)
      }
      if (lead.agent.id !== stage.leadSessionId || lead.teamId !== stage.teamId) {
        throw new TeamIdentityUnavailableError('Team cancellation authority does not match the canonical stage')
      }
    } catch (error) {
      if (error instanceof DurabilityFailureError) throw error
      await handle.store
        .updateTeamStage(current.runId, {
          state: 'recovery_required',
          recovery: { code: 'teamstage-identity-unavailable' }
        })
        .catch(() => {})
      if (!settleParentRun) return await handle.store.get(current.runId)
      return await handle.store.settleTerminal(current.runId, 'recovery_required', { reason: 'teamstage-identity-unavailable' })
    }

    try {
      const after = await cancelOwnedTeamStage({
        store: handle.store,
        adapter: new TeamNativeAdapter(this.ctx),
        lead,
        runId: current.runId,
        ...(memberNames === undefined ? {} : { ownedMemberNames: memberNames }),
        ...(reason === undefined ? {} : { reason })
      })
      if (after.teamStage?.state === 'recovery_required') {
        if (!settleParentRun) return after
        return await handle.store.settleTerminal(current.runId, 'recovery_required', { reason: after.teamStage.recovery?.code ?? 'team-effect-unknown' })
      }
      if (after.teamStage?.state === 'cancelled') {
        if (!settleParentRun) return after
        return await handle.store.settleTerminal(current.runId, 'cancelled', { reason: 'teamstage-cancelled' })
      }
      return after
    } catch (error) {
      if (error instanceof DurabilityFailureError) throw error
      await handle.store
        .updateTeamStage(current.runId, {
          state: 'recovery_required',
          recovery: { code: 'teamstage-cancellation-failed' }
        })
        .catch(() => {})
      if (!settleParentRun) return await handle.store.get(current.runId)
      return await handle.store.settleTerminal(current.runId, 'recovery_required', { reason: 'teamstage-cancellation-failed' })
    }
  }

  private assertTeamStageLead(record: RunRecord, runId: string, sessionId: string, lead: LeadHandle): void {
    const stage = record.teamStage
    if (stage === undefined) throw new TeamStageConflictError(runId, 'stage binding is missing')
    if (stage.leadSessionId !== sessionId || stage.teamId !== lead.teamId) {
      throw new TeamStageConflictError(runId, 'caller is not the canonical TeamStage Lead')
    }
  }

  private blueprintRoot(blueprintId: string): string {
    this.documents.assertDefinitionActive(blueprintId)
    const roots = this.config.blueprints ?? {}
    if (Object.hasOwn(roots, blueprintId) && typeof roots[blueprintId] === 'string' && roots[blueprintId]) {
      return resolve(roots[blueprintId]!)
    }
    try {
      const library = this.managedLibraryRoot()
      const root = library && this.documents.libraryDocumentRoot(library, blueprintId)
      if (root && existsSync(join(root, 'blueprint.json'))) return root
    } catch (error) {
      throw this.documentFailure(blueprintId, 'load', error)
    }
    throw new RemoteError('blueprint/definition-not-found', 'definition not found', { blueprintId })
  }

  private managedLibraryRoot(): string | undefined {
    if (this.config.libraryRoot) return resolve(this.config.libraryRoot)
    if (this.config.runtimeRoot) return resolve(this.config.runtimeRoot, 'definitions')
    if (this.ctx.baseUrl?.startsWith('file:')) return fileURLToPath(new URL('data/xuanling-blueprint/definitions/', this.ctx.baseUrl))
    return undefined
  }

  /** In-process compatibility seam for existing document queue fixtures. The
   * queue implementation itself remains owned by BlueprintDocumentLibrary. */
  private withDocument<T>(root: string, action: () => T | Promise<T>, mutation = false): Promise<T> {
    return this.documents.withDocument(root, action, mutation)
  }

  private documentFailure(blueprintId: string, operation: string, error: unknown): RemoteError {
    if (error instanceof DefinitionDocumentMissingError)
      return new RemoteError('blueprint/definition-not-found', 'configured definition not found', { blueprintId })
    if (error instanceof DocumentRevisionConflictError) return this.revisionConflict(blueprintId, error.expected, error.actual)
    if (error instanceof PackageBoundaryError || (error as { code?: string })?.code === 'DEFINITION_INVALID')
      return new RemoteError('blueprint/definition-invalid', 'configured definition rejected', {
        issues: error instanceof PackageBoundaryError ? 'package-boundary-rejected' : 'invalid-definition'
      })
    return new RemoteError('blueprint/definition-write-failed', 'definition operation failed', {
      blueprintId,
      operation,
      reason: operation === 'load' ? 'package-read-failed' : 'package-write-failed'
    })
  }

  private checkResources(definition: ReturnType<typeof decodeDefinition>): void {
    if (admitResources(definition.resources).length)
      throw new RemoteError('blueprint/definition-invalid', 'resource references rejected', { issues: 'resource-admission-rejected' })
  }

  private materializePackage(snapshot: DefinitionPackage, root: string): void {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'blueprint.json'), snapshot.document.definitionJson, { mode: 0o600 })
    for (const [path, bytes] of snapshot.files) {
      const target = join(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, bytes, { mode: 0o600 })
    }
  }

  private revisionConflict(blueprintId: string, expectedRevision: string | null, actualRevision: string | null): RemoteError {
    return new RemoteError('blueprint/revision-conflict', 'definition revision conflict', { blueprintId, expectedRevision, actualRevision })
  }

  private configuredRuntimeRoot(): string {
    if (this.config.runtimeRoot) return resolve(this.config.runtimeRoot)
    if (this.ctx.baseUrl?.startsWith('file:')) return fileURLToPath(new URL('data/xuanling-blueprint/runtime/', this.ctx.baseUrl))
    throw new RemoteError('blueprint/capability-unavailable', 'runtime location unavailable', {
      method: 'runtime',
      plugin: PLUGIN_NAME,
      version: PLUGIN_VERSION
    })
  }

  private async configuredRuntime(internalRoot?: string): Promise<RuntimeHandle> {
    const root = internalRoot ?? this.configuredRuntimeRoot()
    try {
      return await this.runtimeFor(root)
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError('blueprint/durability-failed', 'runtime unavailable', { operation: 'runtime-open' })
    }
  }

  async listDefinitions(): Promise<{
    definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }>
  }> {
    return await this.definitions.listDefinitions()
  }

  async loadDefinition(args: LoadDefinitionArgs): Promise<DefinitionDocument> {
    return await this.definitions.loadDefinition(args)
  }

  /** First save: request identity makes an uncertain response retryable after restart. */
  async createDefinition(args: CreateDefinitionArgs): Promise<DefinitionDocument> {
    return await this.definitions.createDefinition(args)
  }

  async deleteDefinition(args: DeleteDefinitionArgs): Promise<{ blueprintId: string; deleted: true }> {
    return await this.definitions.deleteDefinition(args)
  }

  async listResources(): Promise<{ resources: HostResourceCatalogValue[] }> {
    return await this.definitions.listResources()
  }

  async describeBlueprint(blueprintId?: string) {
    return await this.definitions.describeBlueprint(blueprintId)
  }

  async validateBlueprint(candidate: AuthoringCandidate) {
    return await this.definitions.validateBlueprint(candidate)
  }

  async createBlueprint(candidate: AuthoringCandidate, requestId: string, source: RunSource, signal?: AbortSignal): Promise<DefinitionDocument> {
    return await this.definitions.createBlueprint(candidate, requestId, source, signal)
  }

  async saveDefinition(args: SaveDefinitionArgs): Promise<DefinitionDocument> {
    return await this.definitions.saveDefinition(args)
  }

  private async runtimeFor(runtimeRoot: string): Promise<RuntimeHandle> {
    mkdirSync(resolve(runtimeRoot), { recursive: true })
    const root = realpathSync(resolve(runtimeRoot))
    if (this.closing) throw new RemoteError('blueprint/durability-failed', 'runtime is closing', { operation: 'runtime-close' })
    const existing = this.runtimes.get(root)
    if (existing) return existing
    const pending = this.opening.get(root)
    if (pending) return await pending
    const opening = this.openRuntime(root)
    this.opening.set(root, opening)
    try {
      return await opening
    } finally {
      this.opening.delete(root)
    }
  }

  private async openRuntime(root: string): Promise<RuntimeHandle> {
    mkdirSync(join(root, 'store'), { recursive: true })
    const lease = WriterLease.acquire(root)
    const stopLeaseHeartbeat = lease.startHeartbeat()
    let opened: RuntimeHandle['opened'] | undefined
    try {
      opened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
      const store = new RunStore(opened.domain)
      const query = new RunQuery(store)
      const backgroundFailures = new Map<string, Error>()
      const handle: RuntimeHandle = {
        opened,
        store,
        query,
        reads: new RunReadService({
          store,
          query,
          backgroundFailures,
          decodeDefinition: definitionJson => this.decodeOrThrow(definitionJson),
          teamRuntime: record => this.teamObservations.snapshot(record)
        }),
        lease,
        stopLeaseHeartbeat,
        root,
        snapshots: new RuntimeSnapshots(
          root,
          this.config.skillRoots === undefined ? undefined : () => this.config.skillRoots!,
          createHostResourceProvider(this.ctx)
        ),
        admissionTail: Promise.resolve(),
        driverTail: Promise.resolve(),
        jobs: new Map(),
        rerun: new Set(),
        controllers: new Map(),
        cancellationTails: new Map(),
        backgroundFailures
      }
      await reconcileOnStart(handle.store)
      this.runtimes.set(root, handle)
      for (const id of await handle.store.listRunIds()) {
        const run = await handle.store.get(id)
        if (['queued', 'running', 'cancelling'].includes(run.state)) this.execution.scheduleRun(handle, id)
      }
      return handle
    } catch (error) {
      await opened?.close()
      stopLeaseHeartbeat()
      lease.release()
      throw error
    }
  }

  /** Internal deterministic verification seam. Production admission uses
   * scheduleRun through the durable wire path; characterization fixtures can
   * drive a seeded Run through the same extracted execution owner directly. */
  async driveRun(handle: RuntimeHandle, runId: string, definition: ReturnType<typeof decodeDefinition>, sourceParent?: NativeSourceParent): Promise<void> {
    // Some deterministic reducer fixtures construct the service prototype
    // directly so they can seed a Run without opening a Cordis plugin. Keep
    // that in-process seam compatible with the extracted owner while normal
    // production instances continue using the constructor-owned singleton.
    const execution =
      this.execution ??
      new RunExecutionService({
        ctx: this.ctx,
        config: {
          ...(this.config?.maxConcurrentNodes === undefined ? {} : { maxConcurrentNodes: this.config.maxConcurrentNodes }),
          ...(this.config?.toolBindings === undefined ? {} : { toolBindings: this.config.toolBindings }),
          ...(this.config?.teamProviders === undefined ? {} : { teamProviders: this.config.teamProviders })
        },
        isClosing: () => this.closing ?? false,
        decodeDefinition: definitionJson => this.decodeOrThrow(definitionJson),
        cancelTeamRun: (runtime, run, lead, memberNames, reason, settleParentRun) =>
          this.cancelTeamRun(runtime, run, lead, memberNames, reason, settleParentRun),
        teamObservations: this.teamObservations ?? new TeamStageObservations()
      })
    await execution.driveRun(handle, runId, definition, sourceParent)
  }

  // wire method (descriptor in ./typert.host.ts): ping
  async ping(): Promise<PingValue> {
    return { status: 'ok', service: PLUGIN_NAME, version: PLUGIN_VERSION }
  }

  /**
   * Internal verification seam: composes a scoped agent through the host's public
   * registry from FROZEN snapshot bytes and reports execution evidence.
   * It is intentionally absent from the Typert wire descriptors; production
   * callers use the durable Run/Attempt path instead of an unrecorded probe.
   */
  private async hostProbe(
    args: HostProbeArgs | InternalHostProbeArgs
  ): Promise<Pick<AgentExecutionEvidence, 'sessionId' | 'agentCreated' | 'scopedInjections' | 'inboxSplicedSeen' | 'outcome'>> {
    if ('blueprintId' in args) {
      const root = this.blueprintRoot(args.blueprintId)
      try {
        const document = this.documents.loadConfigured(args.blueprintId, root)
        const definition = this.decodeOrThrow(document.definitionJson)
        const ref = definition.resources[args.resourceId]
        if (!ref || ref.kind !== 'skill')
          throw new RemoteError('blueprint/host-probe-invalid', 'configured Skill reference unavailable', { reason: 'skill-ref-unavailable' })
        const resource = await resolveResource(
          args.resourceId,
          ref.source?.kind === 'shared'
            ? { kind: ref.kind, source: ref.source }
            : { kind: ref.kind, path: `${ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : '')}/SKILL.md` },
          { blueprintRoot: root, roots: this.config.skillRoots ?? [] }
        )
        const skillDir = resource.kind === 'shared-skill' ? resource.skillDir : resource.kind === 'package-file' ? dirname(resource.absolutePath) : undefined
        if (!skillDir) throw new Error('Skill reference rejected')
        return await this.hostProbe({ skillDir, input: args.input })
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw new RemoteError('blueprint/host-probe-invalid', 'configured Skill could not be resolved', { reason: 'skill-unavailable' })
      }
    }
    const ctxAny = this.ctx as unknown as { get?(service: string): unknown }
    const registry = typeof ctxAny.get === 'function' ? ctxAny.get('agents') : undefined
    if (registry === undefined || registry === null) {
      throw new AgentCompositionUnsupportedError("host has no 'agents' registry service")
    }
    const snapshot = snapshotDirectory(args.skillDir, { kind: 'shared-skill', rootId: 'probe', skillDir: args.skillDir, skillName: 'probe' })
    const skillMd = snapshot.files.find(f => f.path === 'SKILL.md')
    if (skillMd === undefined) {
      throw new RemoteError('blueprint/host-probe-invalid', 'probe skill has no SKILL.md', { reason: 'missing-skill-md' })
    }
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const cwd = mkdtempSync(join(tmpdir(), 'bp-host-probe-'))
    const executor = new BlueprintAgentExecutor(this.ctx, registry as never)
    try {
      for (const file of snapshot.files) {
        const target = join(cwd, file.path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, file.bytes)
      }
      const evidence = await executor.execute({
        runId: 'probe',
        attemptId: 'probe',
        nodeId: 'probe',
        agentMd: '',
        skills: [{ name: 'probe', content: skillMd.bytes.toString('utf8'), digest: snapshot.treeDigest }],
        input: args.input,
        cwd
      })
      const probeEvidence = {
        sessionId: evidence.sessionId,
        agentCreated: evidence.agentCreated,
        scopedInjections: evidence.scopedInjections,
        inboxSplicedSeen: evidence.inboxSplicedSeen,
        outcome: evidence.outcome
      }
      if (evidence.outcome.kind === 'recovery_required') {
        // Existing diagnostic codec has four values, unlike business Attempts.
        // Keep unknown explicitly failed; never remove an in-use working tree.
        return {
          ...probeEvidence,
          outcome: { ok: false, kind: 'failed', detail: 'recovery_required: Agent effect/quiescence is unknown; diagnostic cwd retained' }
        }
      }
      rmSync(cwd, { recursive: true, force: true })
      if (evidence.outcome.kind === 'cancelled')
        return { ...probeEvidence, outcome: { ok: false, kind: 'failed', detail: 'cancelled: Agent turn was aborted' } }
      return probeEvidence
    } catch (error) {
      rmSync(cwd, { recursive: true, force: true })
      throw error
    }
  }

  // wire method (descriptor in ./typert.host.ts): validate
  async validate(args: ValidateArgs): Promise<{ ok: true; semanticRevision: string }> {
    this.checkArgs('validate', args)
    const definition = this.decodeOrThrow(args.definitionJson)
    const semanticRevision = createHash('sha256')
      .update(JSON.stringify(expectedSemantic(definition)))
      .digest('hex')
    return { ok: true, semanticRevision }
  }

  private preflightSkillRoots(): SkillRoot[] {
    if (this.config.skillRoots !== undefined) return this.config.skillRoots
    // Read existing machine bindings only. Preflight never opens a writable
    // runtime or creates a lease/store/Agent as a side effect.
    let runtimeRoot: string
    try {
      runtimeRoot = this.configuredRuntimeRoot()
    } catch {
      return []
    }
    const file = join(runtimeRoot, 'root-bindings.json')
    if (!existsSync(file)) return []
    try {
      const value = JSON.parse(readFileSync(file, 'utf8')) as { roots?: SkillRoot[] }
      if (!Array.isArray(value.roots) || value.roots.some(root => !root || typeof root.rootId !== 'string' || typeof root.rootPath !== 'string')) return []
      return value.roots
    } catch {
      return []
    }
  }

  async preflightRun(args: PreflightRunArgs): Promise<PreflightRunValue> {
    this.checkArgs('preflightRun', args)
    const root = this.blueprintRoot(args.blueprintId)
    return await this.documents.withDocument(root, async () => {
      const snapshot = this.documents.loadConfiguredPackage(args.blueprintId, root)
      if (snapshot.document.documentRevision !== args.expectedRevision)
        throw this.revisionConflict(args.blueprintId, args.expectedRevision, snapshot.document.documentRevision)
      const input = this.parseInput(args.inputJson)
      this.configuredRuntimeRoot()
      return await collectPreflight(this.ctx, snapshot, this.decodeOrThrow(snapshot.document.definitionJson), {
        input,
        ...(this.config.toolBindings === undefined ? {} : { toolBindings: this.config.toolBindings }),
        skillRoots: this.preflightSkillRoots(),
        ...(this.config.teamProviders === undefined ? {} : { teamProviders: this.config.teamProviders })
      })
    })
  }

  private parseInput(inputJson: string): unknown {
    try {
      return JSON.parse(inputJson)
    } catch {
      throw new RemoteError('blueprint/definition-invalid', 'input must be JSON', { issues: 'invalid-input-json' })
    }
  }

  // Admission commits promptly; graph execution is a separate supervised job.
  async startRun(args: StartRunArgs | InternalStartRunArgs): Promise<{ runId: string; semanticRevision: string; state: string; replayed: boolean }> {
    if (!('blueprintId' in args)) return await this.admitRun(args)
    this.checkArgs('startRun', args)
    return await this.startConfiguredRun(args)
  }

  async startSessionRun(args: StartSessionRunArgs) {
    this.checkArgs('startSessionRun', args)
    let caller
    try {
      caller = liveCaller(this.ctx, args.sessionId)
      assertRootCaller(caller)
    } catch (error) {
      const nested = (error as { code?: string })?.code === 'nested-run-unavailable'
      throw new RemoteError(
        nested ? 'blueprint/nested-run-unavailable' : 'blueprint/session-unavailable',
        nested ? 'nested-run-unavailable' : 'session-unavailable',
        { sessionId: args.sessionId }
      )
    }
    return await this.startConfiguredRun(args, { sessionId: caller.session.id, kind: 'ui' })
  }

  /** Admit one durable TeamStage task from an exact root Lead. The Team id is
   * resolved from the live native Agent and never accepted from wire input. */
  async startTeamStage(args: StartTeamStageArgs): Promise<TeamStageActionView> {
    this.checkArgs('startTeamStage', args)
    const { lead } = this.teamLeadForSession(args.sessionId, 'startTeamStage')
    const handle = await this.configuredRuntime()
    try {
      const before = await handle.store.tryGet(args.runId)
      if (before === undefined) throw new RunNotFoundError(args.runId)
      if (before.teamStage !== undefined) this.assertTeamStageLead(before, args.runId, args.sessionId, lead)
      const definition = this.decodeOrThrow(before.definitionJson)
      const frozen = resolveFrozenTeamStageAdmission(before, definition, args)
      await handle.store.bindTeamStage(args.runId, {
        stageId: args.stageId,
        teamId: lead.teamId,
        leadSessionId: args.sessionId,
        taskSpecificationFingerprint: frozen.taskSpecificationFingerprint,
        attemptId: frozen.attempt.attemptId,
        requiredChecks: [...frozen.node.teamStage.requiredChecks]
      })
      const task = await createBoundTeamTask({
        store: handle.store,
        adapter: new TeamNativeAdapter(this.ctx),
        runId: args.runId,
        lead,
        request: {
          subject: frozen.task.subject,
          description: frozen.task.description
        },
        effectId: `team-task-create:${args.runId}:${args.stageId}`
      })
      const record = await handle.store.get(args.runId)
      return publicTeamAction(record, task, before.teamStage?.taskId !== undefined)
    } catch (error) {
      throw teamStageRemoteError(error, 'startTeamStage', args.sessionId)
    }
  }

  /** Cancel the canonical TeamStage; memberNames is only a consistency check. */
  async cancelTeamStage(args: CancelTeamStageArgs): Promise<TeamStageActionView> {
    this.checkArgs('cancelTeamStage', args)
    const { lead } = this.teamLeadForSession(args.sessionId, 'cancelTeamStage')
    const handle = await this.configuredRuntime()
    try {
      const before = await handle.store.tryGet(args.runId)
      if (before === undefined) throw new RunNotFoundError(args.runId)
      this.assertTeamStageLead(before, args.runId, args.sessionId, lead)
      if (
        args.memberNames !== undefined &&
        before.teamStage !== undefined &&
        !['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(before.teamStage.state)
      ) {
        // Validate consistency input before requestCancel writes the durable
        // cutoff. The canonical stage still derives the complete target set.
        validateOwnedTeamMemberNames(before.teamStage, args.memberNames)
      }
      const requested = await handle.store.requestTeamStageCancel(args.runId, args.reason)
      const after = requested.teamStage === undefined ? requested : await this.cancelTeamRun(handle, requested, lead, args.memberNames, args.reason, false)
      const stage = after.teamStage
      const deleted = stage?.effects?.find(effect => effect.kind === 'task-delete' && effect.state === 'succeeded')
      const task =
        stage?.taskId === undefined || stage.taskRevision === undefined
          ? undefined
          : {
              id: stage.taskId,
              revision: deleted?.resultTaskRevision ?? stage.taskRevision,
              ...(deleted?.resultStatus === undefined ? {} : { status: deleted.resultStatus })
            }
      return publicTeamAction(after, task, ['cancelled', 'succeeded', 'failed', 'timed_out', 'recovery_required'].includes(before.teamStage?.state ?? ''))
    } catch (error) {
      throw teamStageRemoteError(error, 'cancelTeamStage', args.sessionId)
    }
  }

  /** Accept a redacted output record. `sourceSessionId` is derived from the
   * live caller, and native task status is read through the Lead authority. */
  async acceptTeamStageOutput(args: AcceptTeamStageOutputArgs): Promise<TeamStageActionView> {
    this.checkArgs('acceptTeamStageOutput', args)
    const { caller, lead } = this.teamLeadForSession(args.sessionId, 'acceptTeamStageOutput')
    const handle = await this.configuredRuntime()
    try {
      const before = await handle.store.tryGet(args.runId)
      if (before === undefined) throw new RunNotFoundError(args.runId)
      this.assertTeamStageLead(before, args.runId, args.sessionId, lead)
      const stage = before.teamStage!
      const candidate = {
        code: args.code,
        schemaVersion: args.schemaVersion,
        runId: args.runId,
        stageId: args.stageId,
        taskId: args.taskId,
        sourceSessionId: caller.session.id,
        artifactId: args.artifactId,
        digest: args.digest,
        evidenceDigest: args.evidenceDigest,
        checks: args.checks,
        ...(args.issueCode === undefined ? {} : { issueCode: args.issueCode })
      }
      const task =
        args.code !== 'accepted' || stage.taskId === undefined || stage.taskRevision === undefined
          ? undefined
          : publicTeamTask(new TeamNativeAdapter(this.ctx).getTask(lead, stage.taskId), args.runId)
      if (task !== undefined && stage.outputAcceptance === undefined) {
        await handle.store.observeTeamTaskRevision(args.runId, { taskId: task.id, taskRevision: task.revision }, stage.taskRevision!)
      }
      const after = await acceptTeamOutput({
        store: handle.store,
        runId: args.runId,
        output: candidate,
        ...(task === undefined ? {} : { task, taskStatus: task.status }),
        artifact: { artifactId: args.artifactId, digest: args.digest },
        ...(args.requiredChecks === undefined ? {} : { requiredChecks: args.requiredChecks }),
        ...(args.requiredMemberIds === undefined ? {} : { requiredMemberIds: args.requiredMemberIds })
      })
      const storedTask =
        after.teamStage?.taskId === undefined || after.teamStage.taskRevision === undefined
          ? task
          : (task ?? { id: after.teamStage.taskId, revision: after.teamStage.taskRevision })
      return publicTeamAction(after, storedTask, false)
    } catch (error) {
      throw teamStageRemoteError(error, 'acceptTeamStageOutput', args.sessionId)
    }
  }

  private async startConfiguredRun(args: StartRunArgs, source?: RunSource) {
    const sourceParent = source === undefined ? undefined : captureNativeSourceParent(this.ctx, source.sessionId)
    const root = this.blueprintRoot(args.blueprintId)
    return await this.documents.withDocument(
      root,
      async () => {
        const snapshot = this.documents.loadConfiguredPackage(args.blueprintId, root)
        const { document } = snapshot
        if (document.documentRevision !== args.expectedRevision) throw this.revisionConflict(args.blueprintId, args.expectedRevision, document.documentRevision)
        this.parseInput(args.inputJson)
        const runtimeRoot = this.configuredRuntimeRoot()
        let staging: string | undefined
        try {
          return await this.admitRun(
            { definitionJson: document.definitionJson, inputJson: args.inputJson, runtimeRoot, requestId: args.requestId },
            document.semanticRevision,
            async () => {
              // Called under admissionTail, ONLY after a matching command replay
              // has returned. A changed Host/shared Skill cannot reinterpret it.
              const report = await collectPreflight(this.ctx, snapshot, this.decodeOrThrow(document.definitionJson), {
                input: this.parseInput(args.inputJson),
                ...(this.config.toolBindings === undefined ? {} : { toolBindings: this.config.toolBindings }),
                skillRoots: this.preflightSkillRoots(),
                ...(this.config.teamProviders === undefined ? {} : { teamProviders: this.config.teamProviders })
              })
              if (!report.canStart) throw new RemoteError('blueprint/preflight-blocked', 'new Run blocked by preflight', { checks: report.checks })
              try {
                staging = mkdtempSync(join(tmpdir(), 'bp-admission-bytes-'))
                this.materializePackage(snapshot, staging)
                return staging
              } catch (error) {
                throw this.documentFailure(args.blueprintId, 'admission-stage', error)
              }
            },
            { blueprintId: args.blueprintId, ...(source === undefined ? {} : { source }) },
            sourceParent
          )
        } finally {
          if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
        }
      },
      true
    )
  }

  private async admitRun(
    args: InternalStartRunArgs,
    savedSemanticRevision?: string,
    beforeNewAdmission?: () => Promise<string | undefined>,
    metadata: { blueprintId?: string; source?: RunSource } = {},
    sourceParent?: NativeSourceParent
  ): Promise<{ runId: string; semanticRevision: string; state: string; replayed: boolean }> {
    const definition = this.decodeOrThrow(args.definitionJson)
    this.parseInput(args.inputJson)
    // Team requires an existing source root; the source-less internal entry
    // stays fail-closed before opening a runtime or committing a Run.
    const checks: PreflightCheck[] = definition.graph.nodes
      .filter(node => node.teamStage !== undefined && sourceParent === undefined)
      .map(node => ({ code: 'teamstage-executor-unavailable', status: 'block', nodeId: node.id }))
    if (checks.length) throw new RemoteError('blueprint/preflight-blocked', 'new Run blocked by preflight', { checks })
    const semanticRevision =
      savedSemanticRevision ??
      createHash('sha256')
        .update(JSON.stringify(expectedSemantic(definition)))
        .digest('hex')
    const handle = await this.configuredRuntime(args.runtimeRoot ?? join(tmpdir(), 'bp-runtime-default'))
    const requestId = args.requestId ?? randomUUID()
    const sourceFingerprint =
      metadata.source === undefined
        ? ''
        : `\u0000${JSON.stringify([metadata.source.sessionId, metadata.source.kind, metadata.source.callId ?? null, metadata.source.turn ?? null])}`
    const payloadFingerprint = createHash('sha256').update(`${args.definitionJson}\u0000${args.inputJson}${sourceFingerprint}`).digest('hex')
    const request = { scope: 'run', requestId, payloadFingerprint }
    const admitted = handle.admissionTail.then(async () => {
      const replay = await handle.store.replayRun(request)
      if (replay) return { runId: replay.runId, semanticRevision: replay.definitionRevision, state: replay.state, replayed: true }
      const rootDir = beforeNewAdmission ? await beforeNewAdmission() : args.rootDir
      if (sourceParent !== undefined && metadata.source !== undefined) assertNativeSourceParent(this.ctx, sourceParent, metadata.source.sessionId)
      for (const node of definition.graph.nodes.filter(node => node.teamStage !== undefined)) {
        try {
          admitTeamDriver(this.ctx, node, sourceParent?.agent, this.config.teamProviders)
        } catch (error) {
          const code = error instanceof TeamDriverError ? error.issueCode : 'teamstage-executor-unavailable'
          throw new RemoteError('blueprint/preflight-blocked', 'new Run blocked by preflight', { checks: [{ code, status: 'block', nodeId: node.id }] })
        }
      }
      const created = await handle.store.createRun(request, semanticRevision, args.definitionJson, args.inputJson, metadata)
      if (!created.replayed) {
        try {
          await handle.snapshots.freezePackage(created.runId, definition, rootDir)
        } catch {
          await handle.store.settleTerminal(created.runId, 'failed', { reason: 'resource-freeze-failed' })
          throw new RemoteError('blueprint/durability-failed', 'Run resources could not be frozen', { operation: 'freeze-package' })
        }
      }
      const record = await handle.store.get(created.runId)
      if (!created.replayed) this.execution.scheduleRun(handle, created.runId, sourceParent)
      return { runId: created.runId, semanticRevision: record.definitionRevision, state: record.state, replayed: created.replayed }
    })
    handle.admissionTail = admitted.catch(() => {})
    try {
      return await admitted
    } catch (error) {
      if (error instanceof DurabilityFailureError)
        throw new RemoteError('blueprint/durability-failed', 'admission write failed', { operation: error.operation })
      throw error
    }
  }

  private readonly runReads = (handle: RuntimeHandle): RunReadService => handle.reads

  // wire method (descriptor in ./typert.host.ts): inspectRun
  async inspectRun(args: InspectRunArgs & { runtimeRoot?: string }): Promise<RunSnapshotView> {
    if (args.runtimeRoot === undefined) this.checkArgs('inspectRun', args)
    const handle = await this.configuredRuntime(args.runtimeRoot)
    return await this.runReads(handle).inspectRun(args.runId)
  }

  async queryRuns(args: RunQueryArgs): Promise<RunQueryValue> {
    this.checkArgs('queryRuns', args)
    const handle = await this.configuredRuntime()
    return await this.runReads(handle).queryRuns(args)
  }

  private async setRunArchived(args: RunLifecycleActionArgs, archived: boolean): Promise<RunLifecycleActionValue> {
    this.checkArgs(archived ? 'archiveRun' : 'restoreRun', args)
    const handle = await this.configuredRuntime()
    return await this.runReads(handle).setArchived(args, archived)
  }

  async archiveRun(args: RunLifecycleActionArgs): Promise<RunLifecycleActionValue> {
    return await this.setRunArchived(args, true)
  }

  async restoreRun(args: RunLifecycleActionArgs): Promise<RunLifecycleActionValue> {
    return await this.setRunArchived(args, false)
  }

  async inspectSession(args: InspectSessionArgs): Promise<InspectSessionValue> {
    this.checkArgs('inspectSession', args)
    const handle = await this.configuredRuntime()
    return await this.runReads(handle).inspectSession(args)
  }

  // wire method (descriptor in ./typert.host.ts): cancelRun
  async cancelRun(args: CancelRunArgs & { runtimeRoot?: string }): Promise<{ runId: string; state: string }> {
    if (args.runtimeRoot === undefined) this.checkArgs('cancelRun', args)
    const handle = await this.configuredRuntime(args.runtimeRoot)
    const record = await handle.store.tryGet(args.runId)
    if (record === undefined) {
      throw new RemoteError('blueprint/run-not-found', `run ${args.runId} not found`, { runId: args.runId })
    }
    const afterRequest = await handle.store.requestCancel(args.runId)
    for (const controller of handle.controllers.get(args.runId)?.values() ?? []) controller.abort()
    const after = afterRequest.teamStage === undefined ? afterRequest : await this.cancelTeamRun(handle, afterRequest)
    if (after.teamStage === undefined && after.state === 'cancelling' && !handle.controllers.has(args.runId)) this.execution.scheduleRun(handle, args.runId)
    return { runId: after.runId, state: after.state }
  }

  async decide(args: DecideArgs & { runtimeRoot?: string }): Promise<{ runId: string; decisionId: string; state: string; applied: boolean }> {
    if (args.runtimeRoot === undefined) this.checkArgs('decide', args)
    const handle = await this.configuredRuntime(args.runtimeRoot)
    const record = await handle.store.tryGet(args.runId)
    if (!record) throw new RemoteError('blueprint/run-not-found', 'Run not found', { runId: args.runId })
    if (args.action !== 'approve' && args.action !== 'reject')
      throw new RemoteError('blueprint/decision-invalid', 'unsupported decision action', { detail: 'action-invalid' })
    const definition = this.decodeOrThrow(record.definitionJson)
    const waiting = record.attempts.find(a => a.state === 'waiting_input')
    const node = definition.graph.nodes.find(n => n.id === waiting?.nodeId)
    const branches = definition.graph.edges.filter(e => e.kind === 'control' && e.from.startsWith(`${node?.id}@`)).map(e => e.from.split('@')[1]!)
    const branch = args.action === 'approve' && node?.branches?.length === 1 ? node.branches[0]! : args.action
    if (waiting && branches.length && !branches.includes(branch))
      throw new RemoteError('blueprint/decision-invalid', 'decision has no matching branch', { detail: 'branch-invalid' })
    try {
      const decision = await handle.store.decide(args.runId, args.decisionId, args.action, branch)
      if (decision.applied && decision.record.state === 'running') this.execution.scheduleRun(handle, args.runId)
      return { runId: args.runId, decisionId: args.decisionId, state: decision.record.state, applied: decision.applied }
    } catch (error) {
      if (error instanceof DecisionConflictError)
        throw new RemoteError('blueprint/decision-invalid', 'decision conflicts with durable Attempt', { detail: 'decision-conflict' })
      throw error
    }
  }

  /** Only whitelisted portability codes leave the owner; path/body/cause never do. */
  private portabilityFailure(method: 'export' | 'import', error: unknown): RemoteError {
    const candidate = (error as { code?: string })?.code
    const allowed = ['ARCHIVE_UNSAFE', 'IMPORT_CONFLICT', 'EXPORT_DEPENDENCY_MISSING', 'PORTABILITY_CONFLICT', 'SENSITIVE_EXPORT_BLOCKED', 'DEFINITION_INVALID']
    const code = candidate && allowed.includes(candidate) ? candidate : 'PORTABILITY_FAILED'
    const detail = `${method}-rejected`
    return new RemoteError(method === 'export' ? 'blueprint/export-failed' : 'blueprint/import-failed', detail, { detail, code })
  }

  async exportDefinition(
    args: ExportDefinitionArgs
  ): Promise<{ blueprintId: string; closureDigest: string; files: number; archiveSha256: string; archiveBase64: string; requiredBindings: string[] }>
  async exportDefinition(
    args: ExportDefinitionArgs & { rootDir: string; runtimeRoot?: string; outPath?: string }
  ): ReturnType<BlueprintPortabilityUseCases['exportInternal']>
  async exportDefinition(args: ExportDefinitionArgs & { rootDir?: string; runtimeRoot?: string; outPath?: string }) {
    if (args.rootDir !== undefined) return await this.portability.exportInternal({ ...args, rootDir: args.rootDir })
    return await this.portability.exportConfigured(args)
  }

  async importDefinition(args: ImportDefinitionArgs): Promise<{ blueprintId: string; filesWritten: number; closureDigest: string }>
  async importDefinition(args: { archivePath: string; targetDir?: string }): ReturnType<BlueprintPortabilityUseCases['importInternal']>
  async importDefinition(args: ImportDefinitionArgs | { archivePath: string; targetDir?: string }) {
    if ('archivePath' in args) return await this.portability.importInternal(args)
    return await this.portability.importConfigured(args)
  }
}

function expectedSemantic(definition: ReturnType<typeof decodeDefinition>): unknown {
  const { presentation: _p, ...semantic } = definition
  return semantic
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    blueprint: BlueprintService
  }
}

export default BlueprintService
