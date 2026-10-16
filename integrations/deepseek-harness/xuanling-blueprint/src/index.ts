/** Host-owned document/catalog and durable runtime entry. Public DTOs contain
 * logical IDs only; machine roots are resolved exclusively from configuration.
 * Explicit local-root helpers remain an in-process compatibility seam.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { fileURLToPath } from 'node:url'
import { createdBlueprintId, libraryDocumentRoot, libraryIds } from './definition/library.ts'
import { authoringGuide, inputDescription, validateCandidate, type AuthoringCandidate } from './definition/authoring.ts'
import { acquireLibraryWriter, readLibraryDeletion, writeLibraryDeletion, LibraryStateError } from './definition/library-state.ts'
import { publishPackage } from './definition/package-create.ts'
import { canonicalJson } from './definition/document.ts'
import { projectRunSnapshot, focusAttemptsForSession } from './conversation/run-projection.ts'
import { installConversationTools, liveCaller, assertRootCaller } from './conversation/host-tools.ts'
import { captureNativeSourceParent, assertNativeSourceParent, type NativeSourceParent } from './conversation/native-session-lineage.ts'
import {
  inspectSessionCodec,
  frozenGraphCodec,
  frozenPresentationCodec,
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
  TeamStageActionView
} from './conversation/contracts.ts'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { AgentCompositionUnsupportedError, BlueprintAgentExecutor, captureAgentModelSelection, type AgentExecutionEvidence } from './host/agent-executor.ts'
import {
  collectPreflight,
  resolveEffectiveToolNames,
  type ToolBindings,
  type PreflightRunArgs,
  type PreflightRunValue,
  type PreflightCheck
} from './host/preflight.ts'
import type { AttemptDiagnostics } from './host/runtime-diagnostics.ts'
import { listHostResources, hostResourceCatalogValue, type HostResourceCatalogValue } from './host/resource-catalog.ts'
import { RuntimeSnapshots, createHostResourceProvider } from './resources/runtime-snapshots.ts'
import { TERMINAL_RUN_STATES, type RunRecord } from './persistence/records.ts'
import { DecisionConflictError, RunNotFoundError, TeamOutputRejectedError, TeamStageConflictError, TeamTaskConflictError } from './persistence/run-store.ts'
import { snapshotDirectory } from './resources/index.ts'
import { resolveResource, type SkillRoot } from './resources/resolver.ts'
import {
  DefinitionDocumentMissingError,
  DocumentRevisionConflictError,
  PackageBoundaryError,
  loadDefinitionPackage,
  readPackageFiles,
  saveDefinitionDocument,
  type DefinitionDocument,
  type DefinitionPackage
} from './definition/persist.ts'
import { TYPERT } from './typert.host.ts'
import { admitResources } from './security/resource-admission.ts'
import { readZip } from './portability/zip.ts'
import { decodeDefinition, validateDefinition } from './definition/index.ts'
import { NodeValueError, matchesWireType, validateNodeInputs, structuralOutputs } from './host/node-values.ts'
import { openBlueprintDomain, RunStore, WriterLease, DurabilityFailureError } from './persistence/index.ts'
import { readyNodes, compileGraph, reconcileOnStart } from './orchestration/index.ts'
import { exportBlueprint, importBlueprint } from './portability/index.ts'
import { resolveHostExportResources } from './portability/host-resources.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamNativeAdapter, TeamCapabilityUnavailableError, TeamIdentityUnavailableError, type LeadHandle } from './teamstage/native-adapter.ts'
import { createBoundTeamTask } from './teamstage/task-binding.ts'
import { cancelOwnedTeamStage, validateOwnedTeamMemberNames } from './teamstage/cancellation.ts'
import { acceptTeamOutput, TeamAcceptanceRejectedError } from './teamstage/acceptance.ts'
import { TeamArtifactError } from './teamstage/output-artifact.ts'
import { TeamStageDriver } from './teamstage/driver.ts'
import { TeamStageObservations } from './teamstage/observability.ts'
import { admitTeamDriver, TeamDriverError, type TeamProviders } from './teamstage/driver-admission.ts'
import { resolveFrozenTeamStageAdmission } from './teamstage/public-boundary.ts'
import type { PreparedTeam } from './resources/runtime-snapshots.ts'

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

export interface McpProbeArgs {
  serverName: string
  toolName: string
  args: Record<string, unknown>
}

export interface McpProbeEvidence {
  available: boolean
  dispatched: boolean
  isError: boolean
  text: string
  detail?: string
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

interface RuntimeHandle {
  opened: Awaited<ReturnType<typeof openBlueprintDomain>>
  store: RunStore
  lease: WriterLease
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

interface NodeSettlement {
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
  private libraryTail: Promise<unknown> = Promise.resolve()
  private readonly documentTails = new Map<string, Promise<unknown>>()
  private readonly teamObservations = new TeamStageObservations()

  constructor(
    ctx: Context,
    private readonly config: BlueprintConfig = {}
  ) {
    super(ctx, 'blueprint', { namespace: 'blueprint' })
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
        await this.libraryTail
        await Promise.allSettled(this.opening.values())
        for (const handle of this.runtimes.values()) {
          for (const controllers of handle.controllers.values()) for (const controller of controllers.values()) controller.abort()
          await Promise.allSettled(handle.cancellationTails.values())
          await Promise.allSettled(handle.jobs.values())
          await handle.admissionTail
          await handle.opened.close()
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
    this.assertDefinitionActive(blueprintId)
    const roots = this.config.blueprints ?? {}
    if (Object.hasOwn(roots, blueprintId) && typeof roots[blueprintId] === 'string' && roots[blueprintId]) {
      return resolve(roots[blueprintId]!)
    }
    try {
      const library = this.managedLibraryRoot()
      const root = library && libraryDocumentRoot(library, blueprintId)
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

  /** Serialize read/check/publish/admission by physical configured root, including aliases. */
  private async withDocument<T>(root: string, action: () => T | Promise<T>, mutation = false): Promise<T> {
    let key = resolve(root)
    try {
      key = realpathSync(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new RemoteError('blueprint/durability-failed', 'document root unavailable', { operation: 'document-open' })
    }
    const task = (this.documentTails.get(key) ?? Promise.resolve()).then(() => (mutation ? this.withLibraryMutation(action) : action()))
    const observed = task.catch(() => {})
    this.documentTails.set(key, observed)
    try {
      return await task
    } finally {
      if (this.documentTails.get(key) === observed) this.documentTails.delete(key)
    }
  }

  private readDeletion(blueprintId: string) {
    const library = this.managedLibraryRoot()
    try {
      return library ? readLibraryDeletion(library, blueprintId) : undefined
    } catch {
      throw new RemoteError('blueprint/library-state-invalid', 'library state unavailable', { operation: 'read' })
    }
  }
  private assertDefinitionActive(blueprintId: string): void {
    if (this.readDeletion(blueprintId)) throw new RemoteError('blueprint/definition-deleted', 'definition deleted', { blueprintId })
  }
  private withLibraryMutation<T>(action: () => T | Promise<T>): Promise<T> {
    const task = this.libraryTail.then(async () => {
      const library = this.managedLibraryRoot()
      // Configured-only hosts without a file profile retain their existing writes.
      // They cannot delete until a durable library location is configured.
      if (!library) return await action()
      let lease: WriterLease
      try {
        lease = acquireLibraryWriter(library)
      } catch (error) {
        if (error instanceof LibraryStateError) throw new RemoteError('blueprint/library-state-invalid', 'library state unavailable', { operation: 'lock' })
        throw new RemoteError('blueprint/library-busy', 'library writer unavailable', { operation: 'lock' })
      }
      try {
        return await action()
      } finally {
        lease.release()
      }
    })
    this.libraryTail = task.catch(() => {})
    return task
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

  private loadConfiguredPackage(blueprintId: string, root: string): DefinitionPackage {
    this.assertDefinitionActive(blueprintId)
    let snapshot: DefinitionPackage
    try {
      snapshot = loadDefinitionPackage(root)
    } catch (error) {
      throw this.documentFailure(blueprintId, 'load', error)
    }
    if (snapshot.document.blueprintId !== blueprintId)
      throw new RemoteError('blueprint/definition-invalid', 'configured ID does not match definition', { issues: 'blueprint-id-mismatch' })
    this.checkResources(this.decodeOrThrow(snapshot.document.definitionJson))
    return snapshot
  }
  private loadConfigured(blueprintId: string, root: string): DefinitionDocument {
    return this.loadConfiguredPackage(blueprintId, root).document
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
    const definitions = []
    const library = this.managedLibraryRoot()
    let managed: string[] = []
    try {
      if (library) managed = libraryIds(library).filter(id => existsSync(join(library, id, 'blueprint.json')))
    } catch {
      throw new RemoteError('blueprint/definition-write-failed', 'library read failed', {
        blueprintId: 'library',
        operation: 'list',
        reason: 'package-read-failed'
      })
    }
    for (const blueprintId of [...new Set([...Object.keys(this.config.blueprints ?? {}), ...managed])].sort()) {
      if (this.readDeletion(blueprintId)) continue
      const root = this.blueprintRoot(blueprintId)
      const item = await this.withDocument(root, () => {
        try {
          const document = this.loadConfigured(blueprintId, root)
          return {
            blueprintId,
            name: this.decodeOrThrow(document.definitionJson).name,
            documentRevision: document.documentRevision,
            semanticRevision: document.semanticRevision
          }
        } catch (error) {
          if (error instanceof RemoteError && error.code === 'blueprint/definition-deleted') return null
          if (error instanceof RemoteError && error.code === 'blueprint/definition-not-found')
            return { blueprintId, name: blueprintId, documentRevision: null, semanticRevision: null }
          throw error
        }
      })
      if (item) definitions.push(item)
    }
    return { definitions }
  }

  async loadDefinition(args: LoadDefinitionArgs): Promise<DefinitionDocument> {
    this.checkArgs('loadDefinition', args)
    const root = this.blueprintRoot(args.blueprintId)
    return await this.withDocument(root, () => this.loadConfigured(args.blueprintId, root))
  }

  /** First save: request identity makes an uncertain response retryable after restart. */
  async createDefinition(args: CreateDefinitionArgs): Promise<DefinitionDocument> {
    this.checkArgs('createDefinition', args)
    const library = this.managedLibraryRoot()
    if (!library)
      throw new RemoteError('blueprint/capability-unavailable', 'library root unavailable', {
        method: 'createDefinition',
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION
      })
    const id = createdBlueprintId(args.requestId)
    if (Object.hasOwn(this.config.blueprints ?? {}, id)) throw this.revisionConflict(id, null, null)
    const definition = this.decodeOrThrow(args.definitionJson)
    definition.id = id
    this.checkResources(definition)
    try {
      const root = libraryDocumentRoot(library, id)!
      return await this.withDocument(
        root,
        () => {
          // Recheck after waiting for other document operations.
          libraryDocumentRoot(library, id)
          try {
            const stored = this.loadConfigured(id, root)
            if (canonicalJson(this.decodeOrThrow(stored.definitionJson)) !== canonicalJson(definition))
              throw this.revisionConflict(id, null, stored.documentRevision)
            return stored
          } catch (error) {
            if (!(error instanceof RemoteError && error.code === 'blueprint/definition-not-found')) throw error
          }
          try {
            readPackageFiles(root, definition)
          } catch {
            throw new RemoteError('blueprint/definition-invalid', 'new blueprint resources unavailable', { issues: 'resource-unavailable' })
          }
          return saveDefinitionDocument(root, definition, null)
        },
        true
      )
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw this.documentFailure(id, 'create', error)
    }
  }

  async deleteDefinition(args: DeleteDefinitionArgs): Promise<{ blueprintId: string; deleted: true }> {
    this.checkArgs('deleteDefinition', args)
    if (!this.managedLibraryRoot())
      throw new RemoteError('blueprint/capability-unavailable', 'library unavailable', {
        method: 'deleteDefinition',
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION
      })
    const replay = () => {
      const deleted = this.readDeletion(args.blueprintId)
      if (!deleted) return undefined
      if (deleted.requestId !== args.requestId || deleted.documentRevision !== args.expectedRevision)
        throw this.revisionConflict(args.blueprintId, args.expectedRevision, null)
      return { blueprintId: args.blueprintId, deleted: true as const }
    }
    const prior = replay()
    if (prior) return prior
    const root = this.blueprintRoot(args.blueprintId)
    return this.withDocument(
      root,
      () => {
        const prior = replay()
        if (prior) return prior
        const document = this.loadConfigured(args.blueprintId, root)
        if (document.documentRevision !== args.expectedRevision) throw this.revisionConflict(args.blueprintId, args.expectedRevision, document.documentRevision)
        try {
          writeLibraryDeletion(this.managedLibraryRoot()!, {
            stateVersion: 1,
            blueprintId: args.blueprintId,
            documentRevision: args.expectedRevision,
            requestId: args.requestId,
            deletedAt: Date.now()
          })
        } catch (error) {
          throw this.documentFailure(args.blueprintId, 'delete', error)
        }
        return { blueprintId: args.blueprintId, deleted: true as const }
      },
      true
    )
  }

  async listResources(): Promise<{ resources: HostResourceCatalogValue[] }> {
    return hostResourceCatalogValue(await listHostResources(this.ctx, { cwd: process.cwd() }))
  }

  async describeBlueprint(blueprintId?: string) {
    const resourceCatalog = (await this.listResources()).resources
    if (blueprintId !== undefined) {
      const document = await this.loadDefinition({ blueprintId })
      const definition = this.decodeOrThrow(document.definitionJson)
      return { ...document, definition, input: inputDescription(definition), resources: Object.keys(definition.resources), resourceCatalog }
    }
    let runtimeAvailable = true
    try {
      this.configuredRuntimeRoot()
    } catch {
      runtimeAvailable = false
    }
    return {
      ...authoringGuide(),
      runtimeAvailable,
      resourceCatalog,
      toolBindings: Object.entries(this.config.toolBindings ?? {}).map(([bindingId, binding]) => ({ bindingId, tools: binding.tools }))
    }
  }

  async validateBlueprint(candidate: AuthoringCandidate) {
    const result = validateCandidate(candidate)
    return result.ok ? { ok: true, input: inputDescription(result.definition) } : result
  }

  async createBlueprint(candidate: AuthoringCandidate, requestId: string, source: RunSource, signal?: AbortSignal): Promise<DefinitionDocument> {
    signal?.throwIfAborted()
    const result = validateCandidate(candidate)
    if (!result.ok)
      throw new RemoteError('blueprint/definition-invalid', 'candidate rejected; use blueprint_validate for issues', {
        issues: result.issues.map(issue => issue.code).join('; ')
      })
    const library = this.managedLibraryRoot()
    if (!library)
      throw new RemoteError('blueprint/capability-unavailable', 'library unavailable', {
        method: 'createBlueprint',
        plugin: PLUGIN_NAME,
        version: PLUGIN_VERSION
      })
    const id = createdBlueprintId(JSON.stringify([source.sessionId, requestId]))
    if (Object.hasOwn(this.config.blueprints ?? {}, id)) throw this.revisionConflict(id, null, null)
    const definition = { ...result.definition, id }
    const root = libraryDocumentRoot(library, id)!
    return await this.withDocument(
      root,
      () => {
        libraryDocumentRoot(library, id)
        try {
          const stored = this.loadConfiguredPackage(id, root)
          const sameFiles =
            stored.files.size === candidate.files.length && candidate.files.every(file => stored.files.get(file.path)?.equals(Buffer.from(file.text)))
          if (!sameFiles || canonicalJson(this.decodeOrThrow(stored.document.definitionJson)) !== canonicalJson(definition))
            throw this.revisionConflict(id, null, stored.document.documentRevision)
          return stored.document
        } catch (error) {
          if (!(error instanceof RemoteError && error.code === 'blueprint/definition-not-found')) throw error
        }
        signal?.throwIfAborted()
        try {
          return publishPackage(root, definition, candidate.files)
        } catch (error) {
          throw this.documentFailure(id, 'create', error)
        }
      },
      true
    )
  }

  async saveDefinition(args: SaveDefinitionArgs): Promise<DefinitionDocument> {
    this.checkArgs('saveDefinition', args)
    const root = this.blueprintRoot(args.blueprintId)
    const definition = this.decodeOrThrow(args.definitionJson)
    this.checkResources(definition)
    if (definition.id !== args.blueprintId)
      throw new RemoteError('blueprint/definition-invalid', 'configured ID does not match definition', { issues: 'blueprint-id-mismatch' })
    return await this.withDocument(
      root,
      () => {
        try {
          this.loadConfigured(args.blueprintId, root)
        } catch (error) {
          if (!(error instanceof RemoteError && error.code === 'blueprint/definition-not-found')) throw error
        }
        try {
          return saveDefinitionDocument(root, definition, args.expectedRevision)
        } catch (error) {
          throw this.documentFailure(args.blueprintId, 'save', error)
        }
      },
      true
    )
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
    let opened: RuntimeHandle['opened'] | undefined
    try {
      opened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
      const handle: RuntimeHandle = {
        opened,
        store: new RunStore(opened.domain),
        lease,
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
        backgroundFailures: new Map()
      }
      await reconcileOnStart(handle.store)
      this.runtimes.set(root, handle)
      for (const id of await handle.store.listRunIds()) {
        const run = await handle.store.get(id)
        if (['queued', 'running', 'cancelling'].includes(run.state)) this.scheduleRun(handle, id)
      }
      return handle
    } catch (error) {
      await opened?.close()
      lease.release()
      throw error
    }
  }

  private scheduleRun(handle: RuntimeHandle, runId: string, sourceParent?: NativeSourceParent): void {
    if (this.closing) return
    if (handle.jobs.has(runId)) {
      handle.rerun.add(runId)
      return
    }
    const job = handle.driverTail
      .then(async () => {
        const run = await handle.store.get(runId)
        await this.driveRun(handle, runId, this.decodeOrThrow(run.definitionJson), sourceParent)
      })
      .catch(async () => {
        // Raw dependency errors (including causes/credentials) never become Run evidence.
        const run = await handle.store.get(runId)
        if (TERMINAL_RUN_STATES.includes(run.state) || run.state === 'recovery_required') return
        const unknown = run.attempts.some(a => a.intent !== undefined && a.result === undefined && a.state !== 'waiting_input')
        await handle.store.settleTerminal(runId, unknown ? 'recovery_required' : 'failed', { reason: 'driver-failed' })
      })
    // Always consume rejection; if even the failure write fails, preserve a typed
    // unavailable read rather than reporting a silently hung running projection.
    const observed = job.catch(() => {
      handle.backgroundFailures.set(runId, new Error('durable background settlement failed'))
    })
    handle.jobs.set(runId, observed)
    handle.driverTail = observed
    void observed.then(() => {
      if (handle.jobs.get(runId) === observed) handle.jobs.delete(runId)
      if (handle.rerun.delete(runId)) this.scheduleRun(handle, runId, sourceParent)
    })
  }

  // wire method (descriptor in ./typert.host.ts): ping
  async ping(): Promise<PingValue> {
    return { status: 'ok', service: PLUGIN_NAME, version: PLUGIN_VERSION }
  }

  /**
   * W4.1 diagnostic seam: composes a scoped agent through the host's public
   * registry from FROZEN snapshot bytes and reports execution evidence.
   * Diagnostic only — business surfaces stay capability-unavailable until
   * their waves land.
   */
  async hostProbe(
    args: HostProbeArgs | InternalHostProbeArgs
  ): Promise<Pick<AgentExecutionEvidence, 'sessionId' | 'agentCreated' | 'scopedInjections' | 'inboxSplicedSeen' | 'outcome'>> {
    if ('blueprintId' in args) {
      this.checkArgs('hostProbe', args)
      const root = this.blueprintRoot(args.blueprintId)
      try {
        const document = this.loadConfigured(args.blueprintId, root)
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

  /**
   * W7.3 controlled real-MCP journey: dispatch an MCP tool through the SAME
   * host tools pipeline (policy/guard/dispatch) a blueprint ToolCall uses.
   * The MCP server itself is an operator-registered host binding — this
   * method never starts external programs on its own.
   */
  async mcpProbe(args: McpProbeArgs): Promise<McpProbeEvidence> {
    this.checkArgs('mcpProbe', args)
    const ctxAny = this.ctx as unknown as { get?(service: string): unknown }
    const tools =
      typeof ctxAny.get === 'function'
        ? (ctxAny.get('tools') as { schemas?: () => Array<{ name: string }>; execute?: (exec: Record<string, unknown>) => Promise<unknown> } | undefined)
        : undefined
    if (tools === undefined || typeof tools.execute !== 'function') {
      return { available: false, dispatched: false, isError: true, text: '', detail: 'host tools service unavailable' }
    }
    const prefixed = args.serverName === '' ? args.toolName : `mcp__${args.serverName}__${args.toolName}`
    const schemas = typeof tools.schemas === 'function' ? tools.schemas() : []
    const visible = schemas.some(schema => schema.name === prefixed)
    if (!visible) {
      return { available: false, dispatched: false, isError: true, text: '', detail: `MCP tool ${prefixed} is not registered in this profile` }
    }
    const controller = new AbortController()
    const result = (await tools.execute({
      callId: `bp-mcp-${Date.now().toString(36)}`,
      name: prefixed,
      arguments: args.args,
      signal: controller.signal
    })) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } | undefined
    const text = (result?.content ?? []).map(block => (block.type === 'text' ? String(block.text ?? '') : '')).join('\n')
    return { available: true, dispatched: true, isError: result?.isError === true, text }
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
    return await this.withDocument(root, async () => {
      const snapshot = this.loadConfiguredPackage(args.blueprintId, root)
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
    return await this.withDocument(
      root,
      async () => {
        const snapshot = this.loadConfiguredPackage(args.blueprintId, root)
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
      if (!created.replayed) this.scheduleRun(handle, created.runId, sourceParent)
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

  private async driveRun(
    handle: RuntimeHandle,
    runId: string,
    definition: ReturnType<typeof decodeDefinition>,
    sourceParent?: NativeSourceParent
  ): Promise<void> {
    const graph = compileGraph(definition)
    const capacity = this.config.maxConcurrentNodes ?? 4
    const controllers = new Map<string, AbortController>()
    const active = new Map<string, Promise<void>>()
    const completed: Array<{ nodeId: string; settlement?: NodeSettlement; error?: unknown }> = []
    let stop: NodeSettlement | undefined
    let fatal: unknown
    let hasFatal = false
    const exclusive = (nodeId: string) => {
      const node = graph.nodeById.get(nodeId)!
      // Both boundaries mutate Run-wide waiting/Team state. They own the Run
      // alone, without changing the native TeamStage's own member scheduling.
      return node.kind === 'humanDecision' || node.teamStage !== undefined
    }
    const abortAll = () => {
      for (const controller of controllers.values()) controller.abort()
    }
    handle.controllers.set(runId, controllers)
    try {
      while (true) {
        for (const done of completed.splice(0)) {
          active.delete(done.nodeId)
          if (done.error !== undefined) {
            fatal = done.error
            hasFatal = true
          }
          if (done.settlement !== undefined && (stop === undefined || done.settlement.terminal === 'recovery_required')) stop = done.settlement
        }
        const record = await handle.store.get(runId)
        // A failed branch must retain its reason when earlier siblings are
        // interrupted. Never choose the sibling cancellation by insertion order.
        const failure = record.attempts.find(a => a.state === 'failed' || a.state === 'timed_out') ?? record.attempts.find(a => a.state === 'cancelled')
        if (failure && stop === undefined)
          stop = {
            terminal: failure.state === 'timed_out' ? 'timed_out' : failure.state === 'cancelled' ? 'cancelled' : 'failed',
            detail: { reason: 'attempt-settled-non-success' }
          }
        if (this.closing && !TERMINAL_RUN_STATES.includes(record.state) && record.state !== 'recovery_required') await handle.store.requestCancel(runId)
        const terminal = TERMINAL_RUN_STATES.includes(record.state) || record.state === 'recovery_required'
        if (stop !== undefined || hasFatal || terminal || record.state === 'cancelling' || this.closing) {
          abortAll()
          if (active.size) {
            await Promise.race(active.values())
            continue
          }
          if (hasFatal) throw fatal
          // An unknown effect wins even if a concurrent cancellation/result
          // temporarily terminalized known Attempts. Do not fabricate its result.
          if (stop?.terminal === 'recovery_required') await handle.store.settleTerminal(runId, stop.terminal, stop.detail)
          else if (!terminal) {
            if (record.teamStage !== undefined && !['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(record.teamStage.state))
              await this.cancelTeamRun(handle, record)
            else await handle.store.settleTerminal(runId, stop?.terminal ?? 'cancelled', stop?.detail ?? { reason: 'no-in-flight-effect' })
          }
          return
        }
        if (record.state === 'waiting_input') return
        if (definition.graph.nodes.some(node => node.teamStage !== undefined) && record.source === undefined) {
          stop = { terminal: 'failed', detail: { reason: 'teamstage-executor-unavailable' } }
          continue
        }
        const decisions: Record<string, string> = {}
        const states = new Map<string, Array<RunRecord['attempts'][number]['state']>>()
        for (const a of record.attempts) {
          states.set(a.nodeId, [...(states.get(a.nodeId) ?? []), a.state])
          const outcome = a.result?.outcome as { branch?: string } | undefined
          if (outcome?.branch) decisions[a.nodeId] = outcome.branch
        }
        const schedule = readyNodes(definition, { attempts: [...states].map(([nodeId, states]) => ({ nodeId, states })), decisions })
        if (schedule.skipped.length) {
          await handle.store.transition(runId, draft => {
            if (draft.state === 'cancelling') return
            for (const nodeId of schedule.skipped) {
              if (!draft.attempts.some(a => a.nodeId === nodeId))
                draft.attempts.push({ attemptId: `att-${randomUUID()}`, nodeId, attempt: 1, state: 'skipped' })
            }
          })
          continue
        }
        const ready = schedule.ready.filter(nodeId => !active.has(nodeId))
        // Only Run-wide human/Team boundaries wait for unrelated work to
        // drain. Ordinary structural nodes advance when their own dependencies
        // settle, allowing fast branches to refill the available capacity.
        const first = active.size > 0 && ready.some(exclusive) ? undefined : ready[0]
        const hasExclusive = [...active.keys()].some(exclusive)
        if (first !== undefined && active.size < capacity && !hasExclusive && (!exclusive(first) || active.size === 0)) {
          // Reserve in memory BEFORE preparation awaits. The durable intent is
          // still committed by executeRunNode before the first external effect.
          const controller = new AbortController()
          controllers.set(first, controller)
          const job = this.executeRunNode(handle, runId, definition, record, first, controller, sourceParent)
            .then(
              settlement => {
                completed.push({ nodeId: first, ...(settlement === undefined ? {} : { settlement }) })
              },
              error => {
                completed.push({ nodeId: first, error })
              }
            )
            .finally(() => {
              controllers.delete(first)
            })
          active.set(first, job)
          // Re-read after every admission/settlement. Fast branch descendants
          // refill capacity without waiting for an unrelated slow branch.
          continue
        }
        if (active.size) {
          await Promise.race(active.values())
          continue
        }
        const complete = definition.graph.nodes.every(n => record.attempts.some(a => a.nodeId === n.id && ['succeeded', 'skipped'].includes(a.state)))
        await handle.store.settleTerminal(runId, complete ? 'succeeded' : 'recovery_required', {
          reason: complete ? 'selected-paths-settled' : 'no-safe-progress'
        })
        return
      }
    } finally {
      // This also covers an unexpected store/read failure: no background Agent
      // may escape the owner job before scheduleRun writes its failure receipt.
      abortAll()
      await Promise.allSettled(active.values())
      if (handle.controllers.get(runId) === controllers) handle.controllers.delete(runId)
    }
  }

  private async executeRunNode(
    handle: RuntimeHandle,
    runId: string,
    definition: ReturnType<typeof decodeDefinition>,
    record: RunRecord,
    nodeId: string,
    controller: AbortController,
    sourceParent?: NativeSourceParent
  ): Promise<NodeSettlement | undefined> {
    const graph = compileGraph(definition)
    const node = graph.nodeById.get(nodeId)!
    let intent: Awaited<ReturnType<RunStore['recordIntent']>> | undefined
    let diagnostics: Extract<AttemptDiagnostics, { status: 'available' }> | undefined
    const settledDiagnostics = (code: string) => (diagnostics === undefined ? {} : { diagnostics: { ...diagnostics, acceptance: { code } } })
    try {
      const initial: unknown = JSON.parse(record.inputRef)
      const bound: Record<string, unknown> = {}
      const omitted = new Set<string>()
      let bindingError: NodeValueError | undefined
      for (const dep of graph.dataDeps.get(nodeId) ?? []) {
        const parent = record.attempts.findLast(a => a.nodeId === dep.fromNode)
        if (node.kind === 'join' && parent?.state === 'skipped') {
          omitted.add(dep.toPort)
          continue
        }
        const outcome = parent?.result?.outcome as { outputs?: Record<string, unknown> } | undefined
        if (parent?.state !== 'succeeded') {
          bindingError ??= new NodeValueError('binding-unavailable')
          continue
        }
        if (!outcome?.outputs || !Object.hasOwn(outcome.outputs, dep.fromPort)) {
          bindingError ??= new NodeValueError(node.kind === 'condition' ? 'condition-input-invalid' : 'binding-missing')
          continue
        }
        const value = outcome.outputs[dep.fromPort]
        if (!matchesWireType(value, graph.nodeById.get(dep.fromNode)?.outputs?.[dep.fromPort]) || !matchesWireType(value, node.inputs?.[dep.toPort])) {
          bindingError ??= new NodeValueError(node.kind === 'condition' ? 'condition-input-invalid' : 'binding-invalid')
        }
        Object.defineProperty(bound, dep.toPort, { value, enumerable: true, writable: true, configurable: true })
      }
      // Multiple edges may target a port. A skipped sibling cannot erase an
      // actually selected binding at that same declared port.
      for (const port of Object.keys(bound)) omitted.delete(port)
      const input = (graph.dataDeps.get(nodeId)?.length ?? 0) > 0 ? bound : initial
      const inputJson = JSON.stringify(input)
      const prepared =
        node.kind === 'agentTask' && bindingError === undefined
          ? node.teamStage === undefined
            ? await handle.snapshots.prepare(runId, definition, node)
            : await handle.snapshots.prepareTeam(runId, definition, node)
          : undefined
      if (this.closing || controller.signal.aborted) {
        if (this.closing) {
          const requested = await handle.store.requestCancel(runId)
          if (requested.teamStage !== undefined) await this.cancelTeamRun(handle, requested)
        }
        return
      }
      const effectiveToolNames = prepared ? resolveEffectiveToolNames(this.ctx, definition, node, this.config.toolBindings) : []
      // Capture once before durable intent; the explicit property below tells
      // the executor not to read a later Host default, even when undefined.
      const modelSelection =
        prepared && node.teamStage === undefined
          ? node.modelSelection === undefined
            ? captureAgentModelSelection(this.ctx)
            : {
                provider: node.modelSelection.provider,
                model: node.modelSelection.model,
                ...(node.modelSelection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(node.modelSelection.reasoningEffort) })
              }
          : undefined
      if (bindingError === undefined) {
        diagnostics = {
          status: 'available',
          input: {
            type: input === null ? 'null' : Array.isArray(input) ? 'array' : (typeof input as 'object' | 'string' | 'number' | 'boolean'),
            bytes: Buffer.byteLength(inputJson),
            sha256: createHash('sha256').update(inputJson).digest('hex')
          },
          resourceDigests: prepared?.resourceDigests ?? {},
          ...(modelSelection === undefined ? {} : { modelSelection }),
          tools: { effectiveNames: effectiveToolNames },
          acceptance: { code: 'pending' }
        }
      }
      // A rejected incomplete binding has no dispatch input/model/tool facts
      // to invent. Still commit the Attempt before its typed rejection result.
      const executionSessionId = node.kind === 'agentTask' && node.teamStage === undefined ? `bp-${randomUUID()}` : undefined
      intent = await handle.store.recordIntent(runId, {
        nodeId,
        kind: node.kind,
        ...(executionSessionId === undefined ? {} : { sessionId: executionSessionId }),
        resourceDigests: diagnostics?.resourceDigests ?? {},
        diagnostics: diagnostics ?? { status: 'unavailable' }
      })
      // cancel may have committed while the intent or preparation was in progress.
      const beforeDispatch = await handle.store.get(runId)
      if (beforeDispatch.state === 'cancelling' || beforeDispatch.attempts.some(a => ['failed', 'timed_out', 'cancelled'].includes(a.state))) controller.abort()
      if (controller.signal.aborted) {
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: false,
          outcome: { kind: 'cancelled' },
          evidence: 'cancel-before-dispatch',
          ...settledDiagnostics('cancelled')
        })
        return
      }
      if (bindingError !== undefined) throw bindingError
      validateNodeInputs(node, input, omitted)
      if (node.kind === 'condition') {
        const config = node.condition!
        const predicate = (input as Record<string, unknown>)[config.inputPort] as boolean
        const branch = predicate ? config.trueBranch : config.falseBranch
        const outputs = structuralOutputs(node, input, omitted)
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: true,
          outcome: { branch, outputs, value: predicate },
          evidence: 'condition-boolean',
          ...settledDiagnostics('not-required')
        })
        return
      }
      if (node.kind === 'humanDecision') {
        await handle.store.transition(runId, draft => {
          if (draft.state === 'cancelling') return
          draft.state = 'waiting_input'
          draft.attempts.find(a => a.attemptId === intent!.attemptId)!.state = 'waiting_input'
        })
        if ((await handle.store.get(runId)).state === 'cancelling') {
          await handle.store.recordResult(runId, intent.attemptId, {
            ok: false,
            outcome: { kind: 'cancelled' },
            evidence: 'cancel-before-wait',
            ...settledDiagnostics('cancelled')
          })
        }
        return
      }
      if (node.kind === 'input' || node.kind === 'output' || (node.kind === 'join' && node.join !== 'any')) {
        const outputs = structuralOutputs(node, input, omitted)
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: true,
          outcome: { outputs, value: input },
          evidence: 'structural-node',
          ...settledDiagnostics('not-required')
        })
        return
      }
      if (prepared && diagnostics) {
        const cwd = prepared.materialize(intent.attemptId)
        if (node.teamStage !== undefined) {
          const parent = sourceParent ?? (record.source === undefined ? undefined : captureNativeSourceParent(this.ctx, record.source.sessionId))
          if (!parent) throw new TeamDriverError('teamstage-identity-unavailable')
          assertNativeSourceParent(this.ctx, parent, record.source!.sessionId)
          await new TeamStageDriver(this.ctx, handle.store, handle.root, this.config.teamProviders, this.teamObservations).execute({
            record,
            node,
            attemptId: intent.attemptId,
            source: parent.agent,
            prepared: prepared as PreparedTeam,
            effectiveToolNames,
            input,
            cwd,
            signal: controller.signal,
            mapOutputs: value => {
              const outputs: Record<string, unknown> = {}
              for (const [port, type] of Object.entries(node.outputs ?? {})) {
                if (type === 'string') outputs[port] = JSON.stringify(value)
                else if (type === 'json') outputs[port] = value
                else throw new NodeValueError('output-invalid')
                if (!matchesWireType(outputs[port], type)) throw new NodeValueError('output-invalid')
              }
              return outputs
            }
          })
          return
        }
        const registry = this.ctx.get('agents')
        if (!registry) throw new AgentCompositionUnsupportedError('missing registry')
        const executor = new BlueprintAgentExecutor(this.ctx, registry as never)
        const evidence = await executor.execute({
          runId,
          attemptId: intent.attemptId,
          nodeId,
          sessionId: executionSessionId!,
          agentMd: prepared.agentMd,
          ...(prepared.agentPreset === undefined ? {} : { agentPreset: prepared.agentPreset }),
          ...(prepared.agentComposition === undefined ? {} : { agentComposition: prepared.agentComposition }),
          ...(prepared.hostAgentComposition === undefined ? {} : { hostAgentComposition: prepared.hostAgentComposition }),
          skills: prepared.skills,
          input: typeof input === 'string' ? input : inputJson,
          cwd,
          signal: controller.signal,
          ...(record.source === undefined ? {} : { source: record.source }),
          ...(sourceParent === undefined ? {} : { sourceParent }),
          effectiveToolNames,
          modelSelection,
          ...(prepared.outputSchema === undefined ? {} : { outputSchema: prepared.outputSchema })
        })
        if (evidence.outcome.kind === 'recovery_required') {
          return { terminal: 'recovery_required', detail: { reason: 'agent-effect-unknown', sessionId: evidence.sessionId } }
        }
        // Schema-backed ports consume the authoritative tools/result capture,
        // never JSON guessed from assistant prose or a provider's detail text.
        let outcome = evidence.outcome
        let acceptance = evidence.acceptance ?? { code: 'not-required' }
        if (prepared.outputSchema !== undefined && outcome.ok && (acceptance.code !== 'accepted' || !Object.hasOwn(evidence, 'structuredOutput'))) {
          const kind = acceptance.code === 'output-invalid' ? 'output-invalid' : 'structured-output-missing'
          outcome = { ok: false, kind, detail: kind }
          acceptance = { code: kind, ...(acceptance.issueCount === undefined ? {} : { issueCount: acceptance.issueCount }) }
        }
        diagnostics = { ...diagnostics, acceptance, tools: { effectiveNames: effectiveToolNames, denials: evidence.toolDenials ?? [] } }
        const outputs: Record<string, unknown> = {}
        if (outcome.ok) {
          for (const [port, type] of Object.entries(node.outputs ?? {})) {
            if (type === 'string') outputs[port] = prepared.outputSchema === undefined ? outcome.detail : JSON.stringify(evidence.structuredOutput)
            else if (type === 'json') {
              if (prepared.outputSchema === undefined) {
                try {
                  outputs[port] = JSON.parse(outcome.detail)
                } catch {
                  throw new NodeValueError('output-invalid')
                }
              } else outputs[port] = evidence.structuredOutput
            } else throw new NodeValueError('output-invalid')
            if (!matchesWireType(outputs[port], type)) throw new NodeValueError('output-invalid')
          }
        }
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: outcome.ok,
          outcome: { ...outcome, outputs },
          evidence: outcome.ok ? 'agent-succeeded' : `agent-${outcome.kind}`,
          diagnostics
        })
        return
      }
      await handle.store.recordResult(runId, intent.attemptId, {
        ok: false,
        outcome: { kind: 'unsupported-node' },
        evidence: 'node-executor-unavailable',
        ...settledDiagnostics('node-executor-unavailable')
      })
    } catch (error) {
      const current = await handle.store.get(runId)
      if (TERMINAL_RUN_STATES.includes(current.state)) return
      if (error instanceof DurabilityFailureError) throw error
      if (node.teamStage !== undefined && intent !== undefined) {
        if (current.state === 'cancelling' && current.teamStage?.cancel !== undefined && controller.signal.aborted) {
          // The durable cutoff owns settlement. Join its existing native
          // interrupt/drain/delete work; an aborted execution alone cannot
          // distinguish a known cancellation from an unknown Team effect.
          await this.cancelTeamRun(handle, current)
          return
        }
        const verifiedRejection = error instanceof TeamArtifactError || error instanceof TeamAcceptanceRejectedError
        const issue = error instanceof TeamDriverError || verifiedRejection ? error.issueCode : 'teamstage-effect-unknown'
        const known = [
          'teamstage-tool-not-permitted',
          'teamstage-tool-rejected',
          'teamstage-provider-failed',
          'teamstage-output-invalid',
          'teamstage-structured-output-missing',
          'teamstage-task-not-completed'
        ].includes(issue)
        const unknown =
          (!known && !verifiedRejection) ||
          current.teamStage?.effects?.some(effect => ['pending', 'recovery_required'].includes(effect.state)) ||
          current.state === 'cancelling' ||
          controller.signal.aborted
        if (current.teamStage !== undefined && current.teamStage.state !== 'recovery_required') {
          await handle.store.updateTeamStage(runId, { state: unknown ? 'recovery_required' : 'failed', ...(unknown ? { recovery: { code: issue } } : {}) })
        }
        if (unknown) {
          return { terminal: 'recovery_required', detail: { reason: issue } }
        }
        await handle.store.recordResult(runId, intent.attemptId, { ok: false, outcome: { kind: issue }, evidence: issue, ...settledDiagnostics(issue) })
        return
      }
      const kind = error instanceof NodeValueError ? error.code : 'failed'
      if (intent)
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: false,
          outcome: { kind, detail: error instanceof NodeValueError ? kind : 'node resources, binding or output rejected' },
          evidence: 'node-failed',
          ...settledDiagnostics(kind)
        })
      else {
        // Cancellation can win while resource preparation has no intent.
        // It must not create a new Attempt or replace the durable cutoff.
        if (current.state === 'cancelling' || current.attempts.some(a => ['failed', 'timed_out', 'cancelled'].includes(a.state))) return
        return { terminal: 'failed', detail: { reason: 'prepare-failed' } }
      }
    }
  }

  // wire method (descriptor in ./typert.host.ts): inspectRun
  async inspectRun(args: InspectRunArgs & { runtimeRoot?: string }): Promise<RunSnapshotView> {
    if (args.runtimeRoot === undefined) this.checkArgs('inspectRun', args)
    const handle = await this.configuredRuntime(args.runtimeRoot)
    if (handle.backgroundFailures.has(args.runId))
      throw new RemoteError('blueprint/durability-failed', 'background settlement unavailable', { operation: 'driver-settlement' })
    const record = await handle.store.tryGet(args.runId)
    if (record === undefined) {
      throw new RemoteError('blueprint/run-not-found', `run ${args.runId} not found`, { runId: args.runId })
    }
    return projectRunSnapshot(record, this.teamObservations.snapshot(record))
  }

  async inspectSession(args: InspectSessionArgs): Promise<InspectSessionValue> {
    this.checkArgs('inspectSession', args)
    const handle = await this.configuredRuntime()
    const matches: RunRecord[] = []
    for (const id of await handle.store.listRunIds()) {
      const record = await handle.store.get(id)
      if (
        record.source?.sessionId === args.sessionId ||
        record.attempts.some(a => a.sessionId === args.sessionId) ||
        record.teamStage?.members.some(member => member.sessionId === args.sessionId)
      )
        matches.push(record)
    }
    matches.sort((a, b) => b.createdAt - a.createdAt || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))
    const selected = args.runId === undefined ? matches[0] : matches.find(run => run.runId === args.runId)
    if (args.runId !== undefined && selected === undefined) throw new RemoteError('blueprint/run-not-found', 'run-not-found', { runId: args.runId })
    if (!selected) return inspectSessionCodec().parse({ status: 'unbound', sessionId: args.sessionId })
    if (handle.backgroundFailures.has(selected.runId))
      throw new RemoteError('blueprint/durability-failed', 'background settlement unavailable', { operation: 'driver-settlement' })
    const definition = this.decodeOrThrow(selected.definitionJson)
    const graph = frozenGraphCodec().parse({
      nodes: definition.graph.nodes.map(node => ({
        id: node.id,
        kind: node.kind,
        ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
        ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
        ...(node.branches === undefined ? {} : { branches: node.branches })
      })),
      edges: definition.graph.edges
    })
    return inspectSessionCodec().parse({
      status: 'bound',
      sessionId: args.sessionId,
      runs: matches.map(run => ({
        runId: run.runId,
        ...(run.blueprintId === undefined ? {} : { blueprintId: run.blueprintId }),
        state: run.state,
        createdAt: run.createdAt,
        definitionRevision: run.definitionRevision
      })),
      selected: {
        run: projectRunSnapshot(selected, this.teamObservations.snapshot(selected)),
        ...(selected.source === undefined ? {} : { source: selected.source }),
        graph,
        ...(definition.presentation === undefined ? {} : { presentation: frozenPresentationCodec().parse(definition.presentation) }),
        focusAttemptIds: focusAttemptsForSession(selected, args.sessionId)
      }
    })
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
    if (after.teamStage === undefined && after.state === 'cancelling' && !handle.controllers.has(args.runId)) this.scheduleRun(handle, args.runId)
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
      if (decision.applied && decision.record.state === 'running') this.scheduleRun(handle, args.runId)
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
  ): ReturnType<BlueprintService['exportInternal']>
  async exportDefinition(args: ExportDefinitionArgs & { rootDir?: string; runtimeRoot?: string; outPath?: string }) {
    if (args.rootDir !== undefined) return await this.exportInternal({ ...args, rootDir: args.rootDir })
    this.checkArgs('exportDefinition', args)
    const root = this.blueprintRoot(args.blueprintId)
    return await this.withDocument(root, async () => {
      const snapshot = this.loadConfiguredPackage(args.blueprintId, root)
      const { document, files } = snapshot
      const definition = this.decodeOrThrow(document.definitionJson)
      let staging: string | undefined
      try {
        // Materialize boundary-checked bytes first. The legacy exporter never gets
        // the live package or shared trees, so none of its reads can follow links.
        staging = mkdtempSync(join(tmpdir(), 'bp-export-bytes-'))
        const packageRoot = join(staging, 'package')
        this.materializePackage(snapshot, packageRoot)
        const definitions = [definition]
        for (const ref of Object.values(definition.resources)) {
          if (ref.kind === 'subflow' && ref.path) {
            const bytes = files.get(`${ref.path}/blueprint.json`)
            if (!bytes) throw new Error('subflow unavailable')
            const subflow = this.decodeOrThrow(bytes.toString('utf8'))
            definitions.push(subflow)
          }
        }
        const roots = new Map<string, SkillRoot>()
        for (const def of definitions) {
          for (const [id, ref] of Object.entries(def.resources)) {
            if (ref.source?.kind !== 'shared') continue
            const resource = await resolveResource(id, { kind: ref.kind, source: ref.source }, { blueprintRoot: root, roots: this.config.skillRoots ?? [] })
            if (resource.kind !== 'shared-skill') throw new Error('Skill unavailable')
            const snapshot = snapshotDirectory(resource.skillDir, {
              kind: 'shared-skill',
              rootId: resource.rootId,
              skillDir: resource.skillDir,
              skillName: resource.skillName
            })
            const rootPath = join(staging, 'roots', resource.rootId)
            roots.set(resource.rootId, { rootId: resource.rootId, rootPath })
            for (const file of snapshot.files) {
              const target = join(rootPath, resource.skillName, file.path)
              mkdirSync(dirname(target), { recursive: true })
              writeFileSync(target, file.bytes)
            }
          }
        }
        const hostResources = await resolveHostExportResources(this.ctx, definitions, process.cwd())
        const result = exportBlueprint(packageRoot, { roots: [...roots.values()], hostResources })
        return {
          blueprintId: args.blueprintId,
          closureDigest: result.manifest.closureDigest,
          files: Object.keys(result.manifest.files).length,
          archiveSha256: createHash('sha256').update(result.archive).digest('hex'),
          archiveBase64: result.archive.toString('base64'),
          requiredBindings: result.manifest.requiredBindings
        }
      } catch (error) {
        throw this.portabilityFailure('export', error)
      } finally {
        if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
      }
    })
  }

  async importDefinition(args: ImportDefinitionArgs): Promise<{ blueprintId: string; filesWritten: number; closureDigest: string }>
  async importDefinition(args: { archivePath: string; targetDir?: string }): ReturnType<BlueprintService['importInternal']>
  async importDefinition(args: ImportDefinitionArgs | { archivePath: string; targetDir?: string }) {
    if ('archivePath' in args) return await this.importInternal(args)
    this.checkArgs('importDefinition', args)
    const root = this.blueprintRoot(args.blueprintId)
    return await this.withDocument(
      root,
      () => {
        this.assertDefinitionActive(args.blueprintId)
        try {
          const archive = Buffer.from(args.archiveBase64, 'base64')
          if (archive.toString('base64') !== args.archiveBase64) throw new Error('invalid archive encoding')
          const definitionEntry = readZip(archive).find(entry => entry.name === 'blueprint.json')
          if (!definitionEntry) throw new Error('missing definition')
          const definition = this.decodeOrThrow(definitionEntry.data.toString('utf8'))
          this.checkResources(definition)
          if (definition.id !== args.blueprintId) throw new Error('configured ID mismatch')
          // Configured roots may be aliases. Publish to their physical target, not
          // replace an operator's root symlink. Existing nonempty packages refuse.
          const target = existsSync(root) ? realpathSync(root) : root
          const result = importBlueprint(archive, target, { allowExisting: true })
          return { blueprintId: args.blueprintId, filesWritten: result.filesWritten.length, closureDigest: result.manifest.closureDigest }
        } catch (error) {
          throw this.portabilityFailure('import', error)
        }
      },
      true
    )
  }

  // wire method (descriptor in ./typert.host.ts): exportDefinition
  private async exportInternal(
    args: ExportDefinitionArgs & { rootDir: string; runtimeRoot?: string; outPath?: string }
  ): Promise<{ blueprintId: string; closureDigest: string; files: number; archiveSha256: string; archivePath: string | null; requiredBindings: string[] }> {
    const runtimeRoot = args.runtimeRoot ?? join(tmpdir(), 'bp-runtime-default')
    // Machine binding lives OUTSIDE the portable package: rootId → local path.
    const bindingsFile = join(runtimeRoot, 'root-bindings.json')
    let roots: Array<{ rootId: string; rootPath: string }> = []
    if (existsSync(bindingsFile)) {
      try {
        const parsed = JSON.parse(readFileSync(bindingsFile, 'utf8')) as { roots?: Array<{ rootId: string; rootPath: string }> }
        roots = parsed.roots ?? []
      } catch {
        roots = []
      }
    }
    try {
      const definition = this.decodeOrThrow(readFileSync(join(args.rootDir, 'blueprint.json'), 'utf8'))
      const definitions = [definition]
      for (const ref of Object.values(definition.resources)) {
        const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
        if (ref.kind === 'subflow' && path) definitions.push(this.decodeOrThrow(readFileSync(join(args.rootDir, path, 'blueprint.json'), 'utf8')))
      }
      const hostResources = await resolveHostExportResources(this.ctx, definitions, process.cwd())
      const result = exportBlueprint(args.rootDir, { roots, hostResources })
      const archiveSha256 = createHash('sha256').update(result.archive).digest('hex')
      let archivePath: string | null = null
      if (args.outPath !== undefined) {
        writeFileSync(args.outPath, result.archive)
        archivePath = args.outPath
      }
      return {
        blueprintId: result.manifest.blueprintId,
        closureDigest: result.manifest.closureDigest,
        files: Object.keys(result.manifest.files).length,
        archiveSha256,
        archivePath,
        requiredBindings: result.manifest.requiredBindings
      }
    } catch (error) {
      throw this.portabilityFailure('export', error)
    }
  }

  // wire method (descriptor in ./typert.host.ts): importDefinition
  private async importInternal(args: {
    archivePath: string
    targetDir?: string
  }): Promise<{ targetDir: string; blueprintId: string; filesWritten: number; closureDigest: string }> {
    try {
      if (!existsSync(args.archivePath)) {
        throw new RemoteError('blueprint/import-failed', `archive not found: ${args.archivePath}`, { detail: args.archivePath, code: 'ENOENT' })
      }
      const target = args.targetDir ?? join(dirname(args.archivePath), 'imported-blueprint')
      const result = importBlueprint(readFileSync(args.archivePath), target)
      return {
        targetDir: result.targetDir,
        blueprintId: result.manifest.blueprintId,
        filesWritten: result.filesWritten.length,
        closureDigest: result.manifest.closureDigest
      }
    } catch (error) {
      if (error instanceof RemoteError) throw error
      const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'UNKNOWN'
      throw new RemoteError('blueprint/import-failed', String((error as Error).message).slice(0, 400), {
        detail: String((error as Error).message).slice(0, 400),
        code
      })
    }
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
