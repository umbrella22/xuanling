import { WorkspaceWriteLease, WorkspaceWriteError } from './service/workspace-write-lease.ts'
import type { AssociateDefinitionArgs } from './conversation/association-contracts.ts'
import { loadPackagedReference } from './portability/packaged-reference.ts'
/** Host-owned document/catalog and durable runtime entry. Public DTOs contain
 * logical IDs only; machine roots are resolved exclusively from configuration.
 * Explicit local-root helpers remain an in-process compatibility seam.
 */
import type { Context } from '@deepseek-ai/cordis'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuthoringCandidate } from './definition/authoring.ts'
import { projectRunSnapshot } from './conversation/run-projection.ts'
import type { InspectRunViewArgs, InspectRunViewValue } from './conversation/contracts.ts'
import type { RunReport } from './conversation/run-report.ts'
import { installConversationTools, liveCaller, assertRootCaller } from './conversation/host-tools.ts'
import { captureNativeSourceParent, assertNativeSourceParent, type NativeSourceParent } from './conversation/native-session-lineage.ts'
import {
  type RunQueryArgs,
  type RunQueryValue,
  type RunLifecycleActionArgs,
  type RunLifecycleActionValue,
  teamStageActionCodec,
  runAdmissionCodec,
  type RunAdmissionView,
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
import { teamStageBlocksRecovery } from './host/teamstage-recovery.ts'
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
import type { ModelSelection as HostModelSelection } from '@deepseek-ai/dsh-agent'
import { AgentCompositionUnsupportedError, BlueprintAgentExecutor, captureAgentModelSelection, type AgentExecutionEvidence } from './host/agent-executor.ts'
import { resolveEffectiveToolNames, type ToolBindings, type PreflightRunArgs, type PreflightRunValue, type PreflightCheck } from './host/preflight.ts'
import { collectCompositionPreflight } from './service/composition-preflight.ts'
import { blueprintInterface, BlueprintCompositionError } from './definition/composition.ts'
import {
  blueprintReferenceViewCodec,
  projectDefinitionGraph,
  type BlueprintReferenceArgs,
  type BlueprintReferenceView
} from './conversation/blueprint-reference-contracts.ts'
import { freezeBlueprintClosure, type AdmissionPackage } from './service/composition-admission.ts'
import type { HostResourceCatalogValue } from './host/resource-catalog.ts'
import { RuntimeSnapshots, createHostResourceProvider } from './resources/runtime-snapshots.ts'
import { TERMINAL_RUN_STATES, type RunRecord } from './persistence/records.ts'
import {
  DecisionConflictError,
  RunNotFoundError,
  TeamOutputRejectedError,
  TeamStageConflictError,
  TeamTaskConflictError,
  TerminalStateError
} from './persistence/run-store.ts'
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
import { canonicalJson } from './definition/document.ts'
import { createdBlueprintId, isLogicalWorkflowId } from './definition/library.ts'
import { openBlueprintDomain, RunQuery, RunStore, WriterLease, DurabilityFailureError } from './persistence/index.ts'
import { RunReadService } from './service/run-read-service.ts'
import { BlueprintDocumentLibrary } from './service/document-library.ts'
import { BlueprintDefinitionUseCases } from './service/definition-use-cases.ts'
import { BlueprintLibraryResolver, workspaceEntries, type ExecutionTarget } from './service/library-resolver.ts'
import {
  associationIdFor,
  associationView,
  ConversationAssociationStore,
  type AssociationIntent,
  type AssociationView
} from './conversation/association-store.ts'
import { resourceContextFor, scopeForSession } from './host/resource-context.ts'
import { importedAgentPath, listAgentDocuments, readAgentDocument, type AgentDocumentSummary } from './host/agent-documents.ts'
import { assertStoragePath } from './persistence/durable-fs.ts'
import { applyTemplateParameters, extractTemplate } from './templates/extraction.ts'
import { discoverProject, preparationId } from './templates/preparation.ts'
import { BlueprintTemplateStore } from './templates/store.ts'
import { preparationManifestCodec, type BlueprintTemplate, type PreparationManifest, type TemplateSummary } from './templates/contracts.ts'
import { libraryKey, type AssetRef, type LibraryRef, type ListBlueprintLibrariesValue } from './definition/library-ref.ts'
import { ApplyService, WORKFLOW_HOST_APPROVAL, type WorkflowApplyResult, type WorkflowCandidate } from './service/apply-service.ts'
import { BlueprintPortabilityUseCases } from './service/portability-use-cases.ts'
import { RunExecutionService } from './service/run-execution.ts'
import { ManagedNodeSessions } from './service/managed-node-session.ts'
import { ManagedNodeError } from './persistence/managed-node-error.ts'
import type { NodeMessageArgs, NodeMessageReceipt, NodeSessionView } from './conversation/managed-node-contracts.ts'
import { toolsetBindingDigest } from './service/binding-facts.ts'
import { reconcile, reconcileOnStart, RecoveryStaleError } from './orchestration/index.ts'
import { IllegalTransitionError } from './orchestration/state.ts'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { TeamNativeAdapter, TeamCapabilityUnavailableError, TeamIdentityUnavailableError, type LeadHandle } from './teamstage/native-adapter.ts'
import { createBoundTeamTask } from './teamstage/task-binding.ts'
import { cancelOwnedTeamStage, validateOwnedTeamMemberNames } from './teamstage/cancellation.ts'
import { acceptTeamOutput } from './teamstage/acceptance.ts'
import { TeamStageObservations } from './teamstage/observability.ts'
import { admitTeamDriver, TeamDriverError, type TeamProviders } from './teamstage/driver-admission.ts'
import { resolveFrozenTeamStageAdmission } from './teamstage/public-boundary.ts'
import { aggregateBindingDigests, buildBindingFacts } from './service/binding-facts.ts'

// Explicit frozen TeamStage nodes use the optional native boundary. These
// exports do not mount DSH's Team profile; ordinary Run routing is independent.
export * from './teamstage/index.ts'

/** Build metadata surfaced through `ping` for install diagnostics. */
export const PLUGIN_NAME = '@xuanling-rs/xuanling-dsh-blueprint'
export const PLUGIN_VERSION = '0.9.0'
const DEFAULT_MAX_QUEUED_TOOL_RUNS = 8

export interface PingValue {
  status: 'ok'
  service: string
  version: string
}

export interface ValidateArgs {
  definitionJson: string
}

export interface StartRunArgs extends LibrarySelection {
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
  /**
   * Canonical workspace root. Definitions are stored below
   * `<workspaceRoot>/.xuanling/workflows/<blueprintId>/blueprint.json`.
   */
  workspaceRoot?: string
  /** Profile-global blueprint library root. Resolved from the Host profile
   * data root when absent; never from cwd or the install directory. */
  globalLibraryRoot?: string
  /** Profile-scoped conversation association namespace. Derived beside the
   * global library root when absent. */
  associationRoot?: string
  runtimeRoot?: string
  /** Maximum ordinary graph nodes in flight within one Run; defaults to 4. */
  maxConcurrentNodes?: number
  /**
   * Maximum Runs already running or queued in one runtime when an agent tool
   * call asks to start another; defaults to 8. Runs execute one at a time per
   * runtime, so without a bound a looping agent grows the queue indefinitely.
   * Runs started from the UI are not limited.
   */
  maxQueuedToolRuns?: number
  skillRoots?: SkillRoot[]
  toolBindings?: ToolBindings
  /** Native subagent registry routes, separate from the LLM provider. */
  teamProviders?: TeamProviders
}
export interface DeleteDefinitionArgs extends LibrarySelection {
  blueprintId: string
  expectedRevision: string
  requestId: string
}
export interface LibrarySelection {
  /** Logical library. Omitted means the request's default library (Host
   * constraint, caller Workspace, Host default or profile-global). */
  library?: LibraryRef | undefined
  /** Explicit execution target. Valid only where execution is allowed. */
  workspaceId?: string | undefined
}
export interface LoadDefinitionArgs extends LibrarySelection {
  blueprintId: string
}
export interface CreateDefinitionArgs extends LibrarySelection {
  requestId: string
  definitionJson: string
}
export interface SaveDefinitionArgs extends LibrarySelection {
  blueprintId: string
  definitionJson: string
  expectedRevision: string | null
}

export interface InspectRunArgs {
  runId: string
  /** Optional caller session used by conversation tools to enforce ownership. */
  sessionId?: string
}

/** Workspace root of the conversation that issued the current call, when the
 * Host can attribute it. Explicit `workspaceRoot` config still wins. */
const CALLER_WORKSPACE = new AsyncLocalStorage<string>()
const CALLER_SESSION = new AsyncLocalStorage<string>()
/** Library selected by the current logical request. It keeps nested document,
 * preflight and runtime reads on the same library without re-deriving a
 * default from the process or a stale selection. */
const CALLER_LIBRARY = new AsyncLocalStorage<LibraryRef>()

export interface CancelRunArgs {
  runId: string
}

/** Human resolution of a `recovery_required` Run. Never replays work. */
export interface ResolveRecoveryArgs {
  workspaceId?: string
  workspaceQuiescent?: boolean
  runId: string
  /** Scopes a conversation-created Run to the caller's registered Workspace;
   * the canvas omits it and keeps the Host default Workspace. */
  sessionId?: string
  resolution: 'failed' | 'succeeded' | 'cancelled'
  /** What the operator checked; stored in the audit log, bounded. */
  note: string
  /** The `seq` of the snapshot the operator reviewed. */
  expectedSeq: number
}

export interface ResolveRecoveryValue {
  runId: string
  state: string
  seq: number
  applied: boolean
}

export interface DecideArgs {
  runId: string
  decisionId: string
  action: string
}

export interface ExportDefinitionArgs extends LibrarySelection {
  blueprintId: string
}

export interface ImportDefinitionArgs extends LibrarySelection {
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
    'blueprint/workspace-required': Record<string, never>
    'blueprint/workspace-unavailable': { readonly workspaceId: string }
    'blueprint/workspace-mismatch': { readonly workspaceId: string }
    'blueprint/library-unavailable': { readonly kind: string }
    'blueprint/library-invalid': { readonly reason: string }
    'blueprint/asset-not-found': { readonly blueprintId: string }
    'blueprint/instance-required': { readonly blueprintId: string }
    'blueprint/association-pending': { readonly associationId: string }
    'blueprint/association-unavailable': Record<string, never>
    'blueprint/intent-invalid': Record<string, never>
    'blueprint/template-invalid': { readonly reason: string }
    'blueprint/preparation-stale': { readonly preparationId: string }
    'blueprint/binding-required': { readonly bindingId: string }
    'blueprint/discovery-incomplete': { readonly reason: string }
    'blueprint/workspace-write-busy': { readonly workspaceId: string }
    'blueprint/workspace-conflict': { readonly path: string }
    'blueprint/unsupported-version': { readonly object: string; readonly version: string }
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
    'blueprint/revision-not-found': { readonly blueprintId: string; readonly revision: string }
    'blueprint/revision-unavailable': { readonly blueprintId: string; readonly revision: string }
    'blueprint/definition-commit-pending': { readonly operation: string }
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
  managed: ManagedNodeSessions
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
  /** Handles whose writer lease was lost and that are settling before close. */
  private readonly retiring = new Set<Promise<void>>()
  private closing = false
  private readonly libraries: BlueprintLibraryResolver
  private readonly documents: BlueprintDocumentLibrary
  private readonly definitions: BlueprintDefinitionUseCases
  private readonly portability: BlueprintPortabilityUseCases
  private readonly applyService: ApplyService
  private readonly teamObservations = new TeamStageObservations()
  private readonly execution: RunExecutionService
  private associations: ConversationAssociationStore | undefined
  private templateStoreInstance: BlueprintTemplateStore | undefined

  constructor(
    ctx: Context,
    private readonly config: BlueprintConfig = {}
  ) {
    super(ctx, 'blueprint', { namespace: 'blueprint' })
    // Keep the live Host configuration object: existing Hosts and fixtures may
    // change the configured root between requests, and the resolver must observe
    // the same value as runtime/portability.
    this.libraries = new BlueprintLibraryResolver({ ctx: this.ctx, config })
    this.documents = new BlueprintDocumentLibrary({
      managedRoot: () => this.workspaceWorkflowRoot(),
      decodeDefinition: definitionJson => this.decodeOrThrow(definitionJson),
      checkResources: definition => this.checkResources(definition),
      documentFailure: (blueprintId, operation, error) => this.documentFailure(blueprintId, operation, error)
    })
    this.definitions = new BlueprintDefinitionUseCases({
      ctx: this.ctx,
      config,
      documents: this.documents,
      workspaceWorkflowRoot: () => this.workspaceWorkflowRoot(),
      configuredRuntimeRoot: () => this.configuredRuntimeRoot(),
      blueprintRoot: blueprintId => this.blueprintRoot(blueprintId),
      decodeOrThrow: definitionJson => this.decodeOrThrow(definitionJson),
      checkResources: definition => this.checkResources(definition),
      checkArgs: (method, args) => this.checkArgs(method, args),
      revisionConflict: (blueprintId, expectedRevision, actualRevision) => this.revisionConflict(blueprintId, expectedRevision, actualRevision),
      documentFailure: (blueprintId, operation, error) => this.documentFailure(blueprintId, operation, error)
    })
    this.applyService = new ApplyService({
      documents: this.documents,
      blueprintRoot: workflowId => this.blueprintRoot(workflowId),
      decode: definitionJson => this.decodeOrThrow(definitionJson),
      listDefinitions: () => this.definitions.listDefinitions()
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
      workspaceForRun: record => {
        const identity = record.context?.targetWorkspace ?? undefined
        const target = identity === undefined ? this.libraries.configuredTarget() : this.libraries.resolveTarget(identity.workspaceId)
        if (target === undefined) return undefined
        const root = realpathSync(target.root)
        if (identity !== undefined && createHash('sha256').update(root).digest('hex') !== identity.rootFingerprint) throw new Error('workspace-mismatch')
        return root
      },
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
    if (config.maxQueuedToolRuns !== undefined && (!Number.isSafeInteger(config.maxQueuedToolRuns) || config.maxQueuedToolRuns < 1))
      throw new TypeError('maxQueuedToolRuns must be a positive safe integer')
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
        await Promise.allSettled(this.retiring)
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
    // RPC callers pass a logical workflow ID. Reject path fragments before
    // resolving the workspace-owned workflow root.
    if (!isLogicalWorkflowId(blueprintId)) throw new RemoteError('blueprint/definition-not-found', 'definition not found', { blueprintId })
    try {
      const workflowRoot = this.workspaceWorkflowRoot()
      const root = workflowRoot && this.documents.libraryDocumentRoot(workflowRoot, blueprintId)
      // A canonical workspace workflow directory is also the mutation target
      // for a first save. Keep the root resolvable before blueprint.json
      // exists; read operations still fail through loadConfigured with the
      // typed definition-not-found error, while ApplyService can persist a
      // candidate and atomically create the first document.
      if (root) return root
    } catch (error) {
      throw this.documentFailure(blueprintId, 'load', error)
    }
    throw new RemoteError('blueprint/definition-not-found', 'definition not found', { blueprintId })
  }

  private hostWorkspaceRoot: string | undefined
  private resolvingWorkspace: Promise<void> | undefined

  /** Root of the library selected for this logical request. */
  private currentLibraryRoot(): string | undefined {
    const selected = CALLER_LIBRARY.getStore()
    if (selected !== undefined) {
      try {
        return this.libraries.resolveLibrary(selected).root
      } catch {
        return undefined
      }
    }
    const configured = this.libraries.configuredTarget()
    if (configured !== undefined) return resolve(configured.root, '.xuanling', 'workflows')
    const caller = CALLER_WORKSPACE.getStore()
    if (caller !== undefined) return resolve(caller, '.xuanling', 'workflows')
    if (this.hostWorkspaceRoot !== undefined) return resolve(this.hostWorkspaceRoot, '.xuanling', 'workflows')
    return this.libraries.globalRoot()
  }

  private workspaceWorkflowRoot(): string | undefined {
    return this.currentLibraryRoot()
  }

  /**
   * Resolve the DSH Workspace that owns `sessionId` (or, for sessions not in
   * any ownership account such as child step sessions, the registered
   * Workspace containing the session cwd). Only registered Workspaces are
   * eligible; a raw cwd never becomes a definition root by itself.
   */
  private sessionWorkspaceRoot(sessionId: string | undefined, cwd?: string): string | undefined {
    if (this.config?.workspaceRoot !== undefined || this.ctx === undefined) return undefined
    let workspaces: Array<{ path: string; sessionIds?: readonly string[] }> | undefined
    try {
      workspaces = (
        this.ctx.get('workspaceRegistry' as never) as unknown as { list(): Array<{ path: string; sessionIds?: readonly string[] }> } | undefined
      )?.list()
    } catch {
      return undefined
    }
    if (!workspaces?.length) return undefined
    if (sessionId !== undefined) {
      // Entries come from a duck-typed registry boundary: validate the two
      // fields used here so a malformed or older record cannot throw out of
      // every conversation tool.
      const owner = workspaces.find(
        workspace =>
          typeof workspace.path === 'string' && isAbsolute(workspace.path) && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)
      )
      if (owner) return resolve(owner.path)
      if (cwd === undefined) {
        try {
          const live = (
            this.ctx.get('agents' as never) as unknown as { get(id: unknown): { session?: { header?: { cwd?: string } } } | undefined } | undefined
          )?.get(sessionId)
          cwd = live?.session?.header?.cwd
        } catch {
          cwd = undefined
        }
      }
    }
    if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined
    const target = resolve(cwd)
    let best: string | undefined
    for (const workspace of workspaces) {
      if (typeof workspace.path !== 'string' || !isAbsolute(workspace.path)) continue
      const root = resolve(workspace.path)
      if ((target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)) && (best === undefined || root.length > best.length)) best = root
    }
    return best
  }

  /** Run `action` against the Workspace of the calling conversation; falls
   * back to the Host default Workspace when it cannot be attributed. */
  async withSessionWorkspace<T>(sessionId: string | undefined, action: () => Promise<T>, cwd?: string): Promise<T> {
    const scopedAction = () => (sessionId === undefined ? action() : CALLER_SESSION.run(sessionId, action))
    if (CALLER_WORKSPACE.getStore() !== undefined) return await scopedAction()
    const root = this.sessionWorkspaceRoot(sessionId, cwd)
    return root === undefined ? await scopedAction() : await CALLER_WORKSPACE.run(root, scopedAction)
  }

  /** Resolve the Host default Workspace lazily. Unlike the old
   * `ensureWorkspace`, an absent default is not an error: document operations
   * fall back to the profile-global library, while execution requires an
   * explicit target. */
  private async resolveHostWorkspace(): Promise<string | undefined> {
    if (this.hostWorkspaceRoot !== undefined) return this.hostWorkspaceRoot
    const controller = this.ctx.get('workspaceController' as never) as unknown as
      | {
          initializeDefault(signal: AbortSignal): Promise<{ workspace: { path: string } } | undefined>
        }
      | undefined
    this.resolvingWorkspace ??= (async () => {
      try {
        const value = await controller?.initializeDefault(new AbortController().signal)
        if (value?.workspace.path && isAbsolute(value.workspace.path)) this.hostWorkspaceRoot = resolve(value.workspace.path)
        if (this.hostWorkspaceRoot === undefined) {
          const registry = this.ctx.get('workspaceRegistry' as never) as unknown as { list(): Array<{ path: string }> } | undefined
          const workspaces = registry?.list()
          if (workspaces?.length === 1 && isAbsolute(workspaces[0]!.path)) this.hostWorkspaceRoot = resolve(workspaces[0]!.path)
        }
      } catch {
        // Dependency details may contain machine paths. Expose only capability state.
      }
    })().finally(() => {
      this.resolvingWorkspace = undefined
    })
    await this.resolvingWorkspace
    return this.hostWorkspaceRoot
  }

  private templateStore(): BlueprintTemplateStore {
    this.templateStoreInstance ??= new BlueprintTemplateStore(this.libraries.globalRoot())
    return this.templateStoreInstance
  }

  /** Extract a reusable template from the saved revision. The source package
   * is only read; extraction never rewrites the asset. */
  async extractTemplate(args: {
    blueprintId: string
    documentRevision?: string
    requestId: string
    library?: LibraryRef
  }): Promise<{ template: BlueprintTemplate; portable: boolean; residual: string[]; sourceDigest: string; templateDigest: string }> {
    return await this.withLibrary(args.library, async () => {
      const library = (await this.defaultLibrary()) as LibraryRef
      const root = this.blueprintRoot(args.blueprintId)
      const current = this.documents.loadConfigured(args.blueprintId, root)
      const revision = args.documentRevision ?? current.documentRevision
      let snapshot
      try {
        snapshot =
          revision === current.documentRevision
            ? this.documents.loadConfiguredPackage(args.blueprintId, root)
            : this.documents.loadRevisionPackage(args.blueprintId, root, revision)
      } catch (error) {
        if (error instanceof RemoteError) throw error
        throw new RemoteError('blueprint/revision-not-found', 'revision not found', { blueprintId: args.blueprintId, revision })
      }
      const definition = this.decodeOrThrow(snapshot.document.definitionJson)
      const hints: string[] = []
      if (library.kind === 'workspace') {
        const resolved = this.libraries.resolveLibrary(library)
        hints.push(resolved.title)
        const workspacePath = resolved.root === undefined ? undefined : resolve(resolved.root, '..', '..')
        if (workspacePath !== undefined) {
          hints.push(workspacePath)
          // Manifest identities are observed project facts, not guesses. They
          // catch names such as an npm/Cargo package that differ from the title.
          for (const entry of discoverProject(workspacePath)) {
            if (entry.kind !== 'manifest' || entry.status !== 'observed') continue
            const name = /^(?:package|cargo):(.+)$/.exec(entry.value)?.[1]
            if (name !== undefined && name !== 'unknown') hints.push(name)
          }
        }
      }
      const extracted = extractTemplate(definition, {
        sourceAsset: { library, blueprintId: args.blueprintId },
        sourceRevision: revision,
        files: snapshot.files,
        residualHints: hints,
        extractedAt: new Date().toISOString()
      })
      return extracted
    })
  }

  listTemplates(): TemplateSummary[] {
    return this.templateStore().list()
  }

  loadTemplate(args: { templateId: string }): BlueprintTemplate {
    return this.templateStore().load(args.templateId)
  }

  saveTemplate(args: { template: BlueprintTemplate; requestId: string }): { template: BlueprintTemplate; updatedAt: string } {
    const stored = this.templateStore().save(args.template, args.requestId)
    return stored
  }

  /** Instantiate a template into a registered project. Missing required
   * parameters return `needs_input` with a durable preparation manifest; a
   * completed instantiation publishes a concrete v2 definition, never the
   * template itself. */
  async instantiateTemplate(args: { templateId: string; workspaceId: string; requestId: string; parameters: Record<string, string> }): Promise<{
    status: 'needs_input' | 'ready'
    manifest: PreparationManifest
    instance: { asset: AssetRef; documentRevision: string; documentDigest: string } | null
  }> {
    const target = this.libraries.resolveTarget(args.workspaceId)
    const library: LibraryRef = { kind: 'workspace', workspaceId: target.workspaceId }
    return await this.withLibrary(
      library,
      async () =>
        await this.withTarget(target, async () => {
          const template = this.templateStore().load(args.templateId)
          const facts = discoverProject(target.root)
          const unresolved: string[] = []
          const bindings: PreparationManifest['bindings'] = []
          const values: Record<string, string> = {}
          for (const parameter of template.parameters) {
            const supplied = args.parameters[parameter.key]
            if (supplied !== undefined && supplied.length > 0) {
              values[parameter.key] = supplied
              bindings.push({ key: parameter.key, value: supplied, status: 'resolved' })
            } else if (parameter.default !== undefined) {
              values[parameter.key] = parameter.default
              bindings.push({ key: parameter.key, value: parameter.default, status: 'defaulted' })
            } else if (parameter.required) {
              unresolved.push(parameter.key)
              bindings.push({ key: parameter.key, value: '', status: 'missing' })
            }
          }
          const blueprintId = createdBlueprintId(JSON.stringify([args.requestId, args.templateId, target.workspaceId]))
          values.id = blueprintId
          const applied = applyTemplateParameters(template.pattern, values)
          for (const key of applied.missing) if (!unresolved.includes(key)) unresolved.push(key)
          const manifestId = preparationId(args.templateId, target.workspaceId, args.requestId)
          const preparationRoot = join(target.root, '.xuanling', 'preparations')
          if (unresolved.length > 0) {
            const manifest = BlueprintTemplateStore.writeManifest(preparationRoot, {
              schemaVersion: 1,
              preparationId: manifestId,
              target: { workspaceId: target.workspaceId },
              templateId: args.templateId,
              facts,
              bindings,
              unresolved: unresolved.sort(),
              generated: null,
              status: 'needs_input',
              revision: 1
            })
            return { status: 'needs_input', manifest, instance: null }
          }
          const candidate = this.decodeOrThrow(JSON.stringify(applied.definition))
          this.checkResources(candidate)
          const missingFileParameters = new Set<string>()
          const files = (template.files ?? []).map(file => {
            const bytes = Buffer.from(file.base64, 'base64')
            if (bytes.toString('base64') !== file.base64 || createHash('sha256').update(bytes).digest('hex') !== file.digest)
              throw new RemoteError('blueprint/template-invalid', 'template file integrity failed', { reason: 'file-digest' })
            const appliedPath = applyTemplateParameters(file.path, values)
            for (const key of appliedPath.missing) missingFileParameters.add(key)
            const text = bytes.toString('utf8')
            const appliedText = Buffer.from(text).equals(bytes) ? applyTemplateParameters(text, values) : undefined
            for (const key of appliedText?.missing ?? []) missingFileParameters.add(key)
            return { path: appliedPath.definition as string, text: appliedText === undefined ? bytes : Buffer.from(appliedText.definition as string) }
          })
          const catalog = (await this.listResources({ library, workspaceId: target.workspaceId })).resources
          const missingHost = Object.entries(candidate.resources)
            .filter(
              ([, ref]) =>
                ref.source?.kind === 'host' &&
                !catalog.some(item => item.kind === ref.kind && item.id === (ref.source as { id: string }).id && item.availability === 'available')
            )
            .map(([key]) => `host-resource:${key}`)
          const missingClosure = Object.entries(candidate.resources)
            .filter(([, ref]) => {
              const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
              return path !== undefined && !files.some(file => file.path === path || file.path.startsWith(`${path}/`))
            })
            .map(([key]) => `package-file:${key}`)
          const missingShared: string[] = []
          for (const [key, ref] of Object.entries(candidate.resources)) {
            if (ref.source?.kind !== 'shared') continue
            try {
              await resolveResource(key, { kind: ref.kind, source: ref.source }, { blueprintRoot: target.root, roots: this.config.skillRoots ?? [] })
            } catch {
              missingShared.push(`shared-resource:${key}`)
            }
          }
          if (missingClosure.length || missingHost.length || missingShared.length || missingFileParameters.size) {
            const manifest = BlueprintTemplateStore.writeManifest(preparationRoot, {
              schemaVersion: 1,
              preparationId: manifestId,
              target: { workspaceId: target.workspaceId },
              templateId: args.templateId,
              facts,
              bindings,
              unresolved: [...missingClosure, ...missingHost, ...missingShared, ...missingFileParameters].sort(),
              generated: null,
              status: 'needs_input',
              revision: 1
            })
            return { status: 'needs_input', manifest, instance: null }
          }
          const targetLibraryRoot = this.libraries.writableRoot(library, true)
          const documentRoot = this.documents.libraryDocumentRoot(targetLibraryRoot, blueprintId)
          if (documentRoot === undefined) throw new RemoteError('blueprint/library-invalid', 'template target escaped the library', { reason: 'path-escape' })
          return await this.documents.withDocument(
            documentRoot,
            async () => {
              // Idempotent retry: the target id is deterministic per request. An
              // existing identical instance returns its receipt; changed parameters
              // conflict instead of republishing or starting over.
              const existingLibraryRoot = this.libraries.resolveLibrary(library).root
              const existingDocumentRoot = existingLibraryRoot === undefined ? undefined : this.documents.libraryDocumentRoot(existingLibraryRoot, blueprintId)
              if (existingDocumentRoot !== undefined && existsSync(join(existingDocumentRoot, 'blueprint.json'))) {
                const existingPackage = this.documents.loadConfiguredPackage(blueprintId, existingDocumentRoot)
                const existing = existingPackage.document
                const existingDefinition = this.decodeOrThrow(existing.definitionJson)
                if (
                  canonicalJson(existingDefinition) !== canonicalJson(candidate) ||
                  existingPackage.files.size !== files.length ||
                  files.some(file => !existingPackage.files.get(file.path)?.equals(file.text))
                ) {
                  throw new RemoteError('blueprint/revision-conflict', 'template parameters conflict with the admitted instance', {
                    blueprintId,
                    expectedRevision: null,
                    actualRevision: existing.documentRevision
                  })
                }
                BlueprintTemplateStore.linkInstance(preparationRoot, blueprintId, manifestId)
                const digest = createHash('sha256').update(existing.definitionJson).digest('hex')
                const manifest = BlueprintTemplateStore.writeManifest(preparationRoot, {
                  schemaVersion: 1,
                  preparationId: manifestId,
                  target: { workspaceId: target.workspaceId },
                  templateId: args.templateId,
                  facts,
                  bindings,
                  unresolved: [],
                  generated: { definitionDigest: digest, instanceAsset: { library, blueprintId } },
                  status: 'ready',
                  revision: 1
                })
                return {
                  status: 'ready',
                  manifest,
                  instance: { asset: { library, blueprintId }, documentRevision: existing.documentRevision, documentDigest: digest }
                }
              }
              BlueprintTemplateStore.linkInstance(preparationRoot, blueprintId, manifestId)
              const saved = this.documents.publishPackage(documentRoot, candidate, files)
              const manifest = BlueprintTemplateStore.writeManifest(preparationRoot, {
                schemaVersion: 1,
                preparationId: manifestId,
                target: { workspaceId: target.workspaceId },
                templateId: args.templateId,
                facts,
                bindings,
                unresolved: [],
                generated: {
                  definitionDigest: createHash('sha256').update(saved.definitionJson).digest('hex'),
                  instanceAsset: { library, blueprintId: saved.blueprintId }
                },
                status: 'ready',
                revision: 1
              })
              return {
                status: 'ready',
                manifest,
                instance: {
                  asset: { library, blueprintId: saved.blueprintId },
                  documentRevision: saved.documentRevision,
                  documentDigest: manifest.generated!.definitionDigest
                }
              }
            },
            true
          )
        })
    )
  }

  /** Durable conversation plan store, rooted beside the global library. */
  private associationStore(): ConversationAssociationStore {
    if (this.associations !== undefined) return this.associations
    // Direct prototype fixtures may omit constructor-owned fields.
    const config = this.config as BlueprintConfig | undefined
    let root = config?.associationRoot
    if (root === undefined) {
      const profile = this.libraries?.globalRoot()
      if (profile !== undefined) root = resolve(dirname(profile), 'associations-v1')
    }
    this.associations = new ConversationAssociationStore(root === undefined ? undefined : resolve(root))
    return this.associations
  }

  /** Default library for a logical request. Explicit Host configuration wins,
   * then the caller session Workspace, then the Host default Workspace, then
   * the profile-global library. A raw cwd never becomes a library root. */
  private async defaultLibrary(): Promise<LibraryRef> {
    const selected = CALLER_LIBRARY.getStore()
    if (selected !== undefined) return selected
    if (this.config.workspaceRoot !== undefined) return { kind: 'workspace', workspaceId: this.libraries.configuredTarget()!.workspaceId }
    const caller = CALLER_WORKSPACE.getStore()
    if (caller !== undefined) return this.libraries.defaultLibrary(caller)
    return { kind: 'global' }
  }

  /** Run an action in the selected library. Unknown or mismatched workspace
   * identities fail before any document or runtime effect. */
  private async withLibrary<T>(library: LibraryRef | undefined, action: () => Promise<T>): Promise<T> {
    const selected = library ?? (await this.defaultLibrary())
    const resolved = this.libraries.resolveLibrary(selected)
    if (resolved.root === undefined)
      throw new RemoteError('blueprint/library-unavailable', 'library root is unavailable', {
        kind: selected.kind === 'global' ? 'global' : 'workspace'
      })
    if (selected.kind === 'workspace' && resolved.root !== undefined) {
      // Document reads/writes may create the library on an explicit save, but
      // they never require the workspace directory to pre-exist. Execution
      // separately requires a resolvable target.
      const workspaceRoot = resolve(resolved.root, '..', '..')
      return await CALLER_LIBRARY.run(selected, () => CALLER_WORKSPACE.run(workspaceRoot, action))
    }
    return await CALLER_LIBRARY.run(selected, action)
  }

  /** Run an action against an explicit execution target. Used by run admission
   * so the runtime root and every read stay on the selected Workspace. */
  private async withTarget<T>(target: ExecutionTarget, action: () => Promise<T>): Promise<T> {
    return await CALLER_WORKSPACE.run(target.root, action)
  }

  /** Route a Run read or lifecycle action to an explicit workspace when one is
   * selected, otherwise to the caller session's Workspace. */
  private async withRunTarget<T>(
    args: { workspaceId?: string | undefined; sessionId?: string | undefined },
    action: () => Promise<T>,
    cwd?: string
  ): Promise<T> {
    if (args.workspaceId !== undefined) {
      const target = this.libraries.resolveTarget(args.workspaceId)
      return await CALLER_LIBRARY.run({ kind: 'workspace', workspaceId: target.workspaceId }, () => CALLER_WORKSPACE.run(target.root, action))
    }
    return await this.withSessionWorkspace(args.sessionId, action, cwd)
  }

  /** In-process compatibility seam for existing document queue fixtures. The
   * queue implementation itself remains owned by BlueprintDocumentLibrary. */
  private withDocument<T>(root: string, action: () => T | Promise<T>, mutation = false): Promise<T> {
    return this.documents.withDocument(root, action, mutation)
  }

  private documentFailure(blueprintId: string, operation: string, error: unknown): RemoteError {
    if ((error as { code?: string })?.code === 'DEFINITION_COMMIT_PENDING')
      return new RemoteError('blueprint/definition-commit-pending', 'Definition commit requires recovery; reload to retry.', { operation })
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
    // Canonical workspaces own their runtime beside `workflows`; this keeps
    // the workspace-native directory backend at `.xuanling/runs/<runId>/`.
    if (this.config.workspaceRoot) return resolve(this.config.workspaceRoot, '.xuanling')
    const callerRoot = CALLER_WORKSPACE.getStore()
    if (callerRoot !== undefined) return resolve(callerRoot, '.xuanling')
    const selected = CALLER_LIBRARY.getStore()
    if (selected?.kind === 'workspace') {
      try {
        return resolve(this.libraries.resolveTarget(selected.workspaceId).root, '.xuanling')
      } catch {
        /* fall through to the global/profile runtime */
      }
    }
    const globalRoot = this.libraries.globalRoot()
    if (globalRoot !== undefined) return resolve(dirname(globalRoot), 'runtime-v2')
    if (this.ctx.baseUrl?.startsWith('file:')) return fileURLToPath(new URL('data/xuanling-blueprint/runtime-v2/', this.ctx.baseUrl))
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

  /** Cascade projection of every visible library. Read-only and bounded. */
  async listBlueprintLibraries(args: { sessionId?: string } = {}): Promise<ListBlueprintLibrariesValue> {
    return this.withSessionWorkspace(args.sessionId, () => this.listLibrariesInScope())
  }

  private async listLibrariesInScope(): Promise<ListBlueprintLibrariesValue> {
    const libraries = this.libraries.list(CALLER_WORKSPACE.getStore())
    // Browsing is read-only: project the default from explicit context instead
    // of calling `initializeDefault`, which may create a Host workspace record.
    const caller = CALLER_WORKSPACE.getStore()
    const defaultLibrary: LibraryRef =
      CALLER_LIBRARY.getStore() ??
      (this.config.workspaceRoot !== undefined
        ? { kind: 'workspace', workspaceId: this.libraries.configuredTarget()!.workspaceId }
        : caller !== undefined
          ? this.libraries.defaultLibrary(caller)
          : { kind: 'global' })
    return { libraries, defaultLibrary }
  }

  async listDefinitions(args: { library?: LibraryRef } = {}): Promise<{
    definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }>
  }> {
    return await this.withLibrary(args.library, async () => await this.definitions.listDefinitions())
  }

  async loadDefinition(args: LoadDefinitionArgs): Promise<DefinitionDocument> {
    return await this.withLibrary(args.library, async () => await this.definitions.loadDefinition(args))
  }

  async inspectBlueprintReference(args: BlueprintReferenceArgs): Promise<BlueprintReferenceView> {
    this.checkArgs('inspectBlueprintReference', args)
    return await this.withLibrary(args.library, async () => {
      try {
        if (args.ownerBlueprintId && args.documentRevision) {
          const ownerRoot = this.blueprintRoot(args.ownerBlueprintId)
          if (existsSync(join(ownerRoot, 'blueprint.json'))) {
            const owner = this.documents.loadConfiguredPackage(args.ownerBlueprintId, ownerRoot)
            const embedded = loadPackagedReference(owner, { blueprintId: args.blueprintId, documentRevision: args.documentRevision })
            if (embedded) {
              const definition = this.decodeOrThrow(embedded.document.definitionJson)
              return blueprintReferenceViewCodec().parse({
                blueprintId: args.blueprintId,
                name: definition.name,
                documentRevision: args.documentRevision,
                currentRevision: args.documentRevision,
                revisions: [{ documentRevision: args.documentRevision, createdAt: 0 }],
                ...blueprintInterface(definition),
                graph: projectDefinitionGraph(definition),
                ...(definition.presentation === undefined ? {} : { presentation: definition.presentation })
              })
            }
          }
        }
        const root = this.blueprintRoot(args.blueprintId)
        const current = this.documents.loadConfigured(args.blueprintId, root)
        const documentRevision = args.documentRevision ?? current.documentRevision
        const snapshot = this.documents.loadRevisionPackage(args.blueprintId, root, documentRevision)
        const definition = this.decodeOrThrow(snapshot.document.definitionJson)
        const history = await this.applyService.revisions(args.blueprintId)
        return blueprintReferenceViewCodec().parse({
          blueprintId: args.blueprintId,
          name: definition.name,
          documentRevision,
          currentRevision: current.documentRevision,
          revisions: history.revisions
            .map(entry => ({ documentRevision: entry.revision, createdAt: entry.createdAt }))
            .sort((a, b) => b.createdAt - a.createdAt),
          ...blueprintInterface(definition),
          graph: projectDefinitionGraph(definition),
          ...(definition.presentation === undefined ? {} : { presentation: definition.presentation })
        })
      } catch (error) {
        throw new RemoteError(
          error instanceof BlueprintCompositionError && error.code === 'blueprint-interface-ambiguous'
            ? 'blueprint/interface-ambiguous'
            : 'blueprint/reference-unavailable',
          'Blueprint reference unavailable',
          { blueprintId: args.blueprintId }
        )
      }
    })
  }

  async associateDefinition(args: AssociateDefinitionArgs): Promise<AssociationView> {
    this.checkArgs('associateDefinition', args)
    liveCaller(this.ctx, args.sessionId)
    return await this.withLibrary(args.asset.library, async () => {
      const root = this.blueprintRoot(args.asset.blueprintId)
      return await this.documents.withDocument(root, () => {
        const document = this.documents.loadConfigured(args.asset.blueprintId, root)
        if (document.documentRevision !== args.documentRevision)
          throw this.revisionConflict(args.asset.blueprintId, args.documentRevision, document.documentRevision)
        const associationId = associationIdFor(args.sessionId, JSON.stringify(args.asset))
        const current = this.associationStore().get(args.sessionId, associationId)
        if (current?.documentRevision === document.documentRevision) return associationView(current)
        return associationView(
          this.associationStore().put({
            schemaVersion: 1,
            associationId,
            sessionId: args.sessionId,
            asset: args.asset,
            name: this.decodeOrThrow(document.definitionJson).name,
            documentRevision: document.documentRevision,
            intent: 'design',
            status: 'saved',
            runId: null,
            requestId: JSON.stringify(args.asset),
            updatedAt: new Date().toISOString()
          })
        )
      })
    })
  }

  /** First save: request identity makes an uncertain response retryable after restart. */
  async createDefinition(args: CreateDefinitionArgs): Promise<DefinitionDocument> {
    return await this.withLibrary(args.library, async () => await this.definitions.createDefinition(args))
  }

  async deleteDefinition(args: DeleteDefinitionArgs): Promise<{ blueprintId: string; deleted: true }> {
    return await this.withLibrary(args.library, async () => await this.definitions.deleteDefinition(args))
  }

  async listResources(args: { library?: LibraryRef; workspaceId?: string; sessionId?: string } = {}): Promise<{ resources: HostResourceCatalogValue[] }> {
    const library = args.library ?? (await this.defaultLibrary())
    const context = resourceContextFor(this.ctx, {
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
      ...((args.sessionId ?? CALLER_SESSION.getStore()) === undefined ? {} : { sessionId: (args.sessionId ?? CALLER_SESSION.getStore())! }),
      library,
      ...(this.config.workspaceRoot === undefined ? {} : { workspaceRoot: this.config.workspaceRoot })
    })
    return await this.withLibrary(args.library, async () => await this.definitions.listResources(context.cwd ?? undefined, context.scope ?? undefined))
  }

  /** Read-only Agent Markdown catalog. Paths and raw frontmatter never enter
   * the response; importing copies bytes into the package. */
  async listAgentDocuments(args: { library?: LibraryRef; workspaceId?: string; sessionId?: string } = {}): Promise<{ documents: AgentDocumentSummary[] }> {
    const library = args.library ?? (await this.defaultLibrary())
    const resolved = this.libraries.resolveLibrary(library)
    const fallbackCwd = library.kind === 'workspace' && resolved.root !== undefined ? resolve(resolved.root, '..', '..') : undefined
    const context = resourceContextFor(this.ctx, {
      ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
      ...((args.sessionId ?? CALLER_SESSION.getStore()) === undefined ? {} : { sessionId: (args.sessionId ?? CALLER_SESSION.getStore())! }),
      library,
      ...(this.config.workspaceRoot === undefined ? {} : { workspaceRoot: this.config.workspaceRoot })
    })
    return { documents: listAgentDocuments(context.cwd ?? fallbackCwd ?? null) }
  }

  /** Copy one Agent Markdown document into the blueprint package as an ordinary
   * package Agent resource. The source document is never modified. */
  async importAgentDocument(args: {
    documentId: string
    blueprintId: string
    expectedRevision: string
    library?: LibraryRef
    workspaceId?: string
  }): Promise<{ blueprintId: string; documentRevision: string; resourceId: string; path: string; digest: string }> {
    return await this.withLibrary(args.library, async () => {
      const context = resourceContextFor(this.ctx, {
        ...(args.workspaceId === undefined ? {} : { workspaceId: args.workspaceId }),
        ...(args.library === undefined ? {} : { library: args.library }),
        ...(this.config.workspaceRoot === undefined ? {} : { workspaceRoot: this.config.workspaceRoot })
      })
      const document = readAgentDocument(args.documentId, context.cwd)
      if (document === undefined) throw new RemoteError('blueprint/asset-not-found', 'agent document not found', { blueprintId: args.documentId })
      const root = this.blueprintRoot(args.blueprintId)
      return await this.documents.withDocument(
        root,
        () => {
          const snapshot = this.documents.loadConfiguredPackage(args.blueprintId, root)
          const definition = this.decodeOrThrow(snapshot.document.definitionJson)
          const targetPath = importedAgentPath(document.summary.name, args.documentId)
          const existingKey = Object.entries(definition.resources).find(([, ref]) => ref.path === targetPath)?.[0]
          if (existingKey !== undefined) {
            const bytes = snapshot.files.get(targetPath)
            const digest = bytes === undefined ? undefined : createHash('sha256').update(bytes).digest('hex')
            if (digest === document.summary.digest) {
              return {
                blueprintId: args.blueprintId,
                documentRevision: snapshot.document.documentRevision,
                resourceId: existingKey,
                path: targetPath,
                digest
              }
            }
            throw new RemoteError('blueprint/revision-conflict', 'agent document changed', {
              blueprintId: args.blueprintId,
              expectedRevision: args.expectedRevision,
              actualRevision: snapshot.document.documentRevision
            })
          }
          const baseKey = targetPath.slice('agents/'.length, -'.md'.length).replace(/[^A-Za-z0-9._-]+/g, '-')
          let resourceId = baseKey
          let suffix = 2
          while (Object.hasOwn(definition.resources, resourceId)) resourceId = `${baseKey}-${suffix++}`
          const next = {
            ...definition,
            resources: { ...definition.resources, [resourceId]: { kind: 'agent' as const, path: targetPath } }
          }
          const validated = this.decodeOrThrow(JSON.stringify(next))
          this.checkResources(validated)
          const files = new Map(snapshot.files)
          files.set(targetPath, Buffer.from(document.content))
          const saved = this.documents.saveDefinitionDocumentWithHistory(
            root,
            validated,
            args.expectedRevision,
            { origin: 'canvas', message: 'agent document import' },
            files
          )
          return {
            blueprintId: args.blueprintId,
            documentRevision: saved.documentRevision,
            resourceId,
            path: targetPath,
            digest: document.summary.digest
          }
        },
        true
      )
    })
  }

  async describeBlueprint(blueprintId?: string, library?: LibraryRef) {
    return await this.withLibrary(library, async () => this.definitions.describeBlueprint(blueprintId, () => this.listResources()))
  }

  async validateBlueprint(candidate: AuthoringCandidate) {
    return await this.definitions.validateBlueprint(candidate)
  }

  async createBlueprint(candidate: AuthoringCandidate, requestId: string, source: RunSource, signal?: AbortSignal): Promise<DefinitionDocument> {
    return await this.withLibrary(undefined, async () => await this.definitions.createBlueprint(candidate, requestId, source, signal))
  }

  /** Conversation authoring receipt (C-04/C-05). A design request stops at a
   * durable saved plan; an execute request continues through admission or
   * reports the typed blocker without pretending the plan is complete. */
  async authorBlueprint(
    candidate: AuthoringCandidate,
    requestId: string,
    source: RunSource,
    intent: AssociationIntent,
    workspaceId?: string,
    signal?: AbortSignal,
    input?: unknown
  ): Promise<
    DefinitionDocument & {
      association: AssociationView | null
      intent: AssociationIntent
      status: string
      code?: string
      runId?: string
      state?: string
      replayed?: boolean
    }
  > {
    const library = await this.defaultLibrary()
    return await this.withLibrary(library, async () => {
      const document = await this.createBlueprint(candidate, requestId, source, signal)
      const associationId = associationIdFor(source.sessionId, requestId)
      const existingAssociation = this.associationStore().get(source.sessionId, associationId)
      let association: AssociationView | null = null
      try {
        association = associationView(
          this.associationStore().put({
            schemaVersion: 1,
            associationId,
            sessionId: source.sessionId,
            asset: { library, blueprintId: document.blueprintId },
            name: (() => {
              try {
                const parsed = JSON.parse(document.definitionJson) as { name?: unknown }
                return typeof parsed.name === 'string' ? parsed.name : document.blueprintId
              } catch {
                return document.blueprintId
              }
            })(),
            documentRevision: document.documentRevision,
            intent: existingAssociation?.runId ? existingAssociation.intent : intent,
            // A design retry must not erase an already linked Run.
            status: existingAssociation?.runId ? existingAssociation.status : 'saved',
            runId: existingAssociation?.runId ?? null,
            requestId,
            updatedAt: new Date().toISOString()
          })
        )
      } catch {
        // The document is already durable. A missing association is reported
        // as a repairable state, not hidden behind a failed create.
      }
      if (association === null) return { ...document, association, intent, status: 'association-pending' }
      if (intent === 'design') return { ...document, association, intent, status: association === null ? 'association-pending' : 'saved' }
      try {
        const target = this.resolveExecutionTarget(workspaceId, library)
        const executionLibrary = this.executionLibrary(target, library)
        const admitted = await this.startConfiguredRun(
          {
            blueprintId: document.blueprintId,
            expectedRevision: document.documentRevision,
            inputJson: JSON.stringify(input ?? {}),
            requestId: `${requestId}-run`,
            workspaceId: target.workspaceId,
            library: executionLibrary
          },
          source
        )
        const stored = this.associationStore().get(source.sessionId, associationIdFor(source.sessionId, requestId))
        return {
          ...document,
          association: stored === undefined ? association : associationView(stored),
          intent,
          status: admitted.state,
          runId: admitted.runId,
          state: admitted.state,
          replayed: admitted.replayed
        }
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'blueprint/preflight-blocked'
        try {
          this.associationStore().setStatus(source.sessionId, associationId, 'blocked')
        } catch {
          /* the saved plan and the typed blocker are still returned */
        }
        const stored = this.associationStore().get(source.sessionId, associationId)
        return { ...document, association: stored === undefined ? association : associationView(stored), intent, status: 'blocked', code }
      }
    })
  }

  async saveDefinition(args: SaveDefinitionArgs): Promise<DefinitionDocument> {
    this.checkArgs('saveDefinition', args)
    return await this.withLibrary(args.library, async () => this.saveDefinitionInLibrary(args))
  }

  private async saveDefinitionInLibrary(args: SaveDefinitionArgs): Promise<DefinitionDocument> {
    let result: WorkflowApplyResult
    try {
      result = await this.applyService.applyTrusted({
        workflowId: args.blueprintId,
        definitionJson: args.definitionJson,
        expectedRevision: args.expectedRevision,
        origin: 'canvas'
      })
    } catch (error) {
      if (error instanceof DocumentRevisionConflictError) throw this.revisionConflict(args.blueprintId, error.expected, error.actual)
      if (error instanceof RemoteError) throw error
      throw this.documentFailure(args.blueprintId, 'save', error)
    }
    if (result.status === 'applied' && result.document !== undefined) return result.document
    if (result.issues?.some(issue => issue.code === 'revision-conflict'))
      throw this.revisionConflict(args.blueprintId, args.expectedRevision, result.diff.from.documentRevision)
    throw new RemoteError('blueprint/definition-invalid', 'candidate rejected', {
      issues: result.issues?.map(issue => issue.code).join('; ') ?? 'candidate-rejected'
    })
  }

  /**
   * Canvas history restore: same trust as `saveDefinition` (a person clicked
   * in the Host UI), same CAS (`expectedRevision`), and the revision's frozen
   * package closure is restored with the document. Model tools keep using
   * `workflow_revert`, which requires Host approval.
   */
  async restoreDefinitionRevision(args: { blueprintId: string; revision: string; expectedRevision: string } & LibrarySelection): Promise<DefinitionDocument> {
    this.checkArgs('restoreDefinitionRevision', args)
    return await this.withLibrary(args.library, async () => this.restoreDefinitionRevisionInLibrary(args))
  }

  private async restoreDefinitionRevisionInLibrary(args: { blueprintId: string; revision: string; expectedRevision: string }): Promise<DefinitionDocument> {
    let result: WorkflowApplyResult
    try {
      result = await this.mutateWorkflow(args.blueprintId, () =>
        this.applyService.revertTrusted({
          workflowId: args.blueprintId,
          revision: args.revision,
          expectedRevision: args.expectedRevision,
          message: 'canvas restore'
        })
      )
    } catch (error) {
      if (error instanceof DocumentRevisionConflictError) throw this.revisionConflict(args.blueprintId, error.expected, error.actual)
      if (error instanceof RemoteError) throw error
      throw this.documentFailure(args.blueprintId, 'save', error)
    }
    if (result.status === 'applied' && result.document !== undefined) return result.document
    if (result.issues?.some(issue => issue.code === 'revision-conflict'))
      throw this.revisionConflict(args.blueprintId, args.expectedRevision, result.diff.from.documentRevision)
    // Restore-specific rejections keep their own typed wire codes; everything
    // else stays a rejected candidate.
    const issueCodes = result.issues?.map(issue => issue.code) ?? []
    if (issueCodes.includes('revision-not-found'))
      throw new RemoteError('blueprint/revision-not-found', 'revision not found', {
        blueprintId: args.blueprintId,
        revision: args.revision
      })
    if (issueCodes.includes('revision-package-unavailable'))
      throw new RemoteError('blueprint/revision-unavailable', 'revision package unavailable', {
        blueprintId: args.blueprintId,
        revision: args.revision
      })
    throw new RemoteError('blueprint/definition-invalid', 'revision restore rejected', {
      issues: issueCodes.join('; ') || 'revision-rejected'
    })
  }

  async workflowGet(args: { workflowId: string } & LibrarySelection): Promise<Awaited<ReturnType<ApplyService['get']>>> {
    this.checkArgs('workflowGet', args)
    return await this.withLibrary(args.library, async () => await this.applyService.get(args.workflowId))
  }

  async workflowValidate(args: { workflowId: string; definitionJson: string } & LibrarySelection): Promise<Awaited<ReturnType<ApplyService['validate']>>> {
    this.checkArgs('workflowValidate', args)
    return await this.withLibrary(args.library, async () => await this.applyService.validate(args.workflowId, args.definitionJson))
  }

  async workflowPropose(
    args: {
      workflowId: string
      definitionJson: string
      expectedRevision?: string | null
      origin?: 'canvas' | 'conversation' | 'import'
      message?: string
    } & LibrarySelection
  ): Promise<WorkflowCandidate> {
    this.checkArgs('workflowPropose', args)
    return await this.withLibrary(args.library, async () => await this.applyService.propose(args))
  }

  private async mutateWorkflow(workflowId: string, action: () => Promise<WorkflowApplyResult>): Promise<WorkflowApplyResult> {
    try {
      return await action()
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw this.documentFailure(workflowId, 'save', error)
    }
  }

  async workflowApply(
    args: {
      workflowId: string
      definitionJson: string
      expectedRevision: string
      origin?: 'canvas' | 'conversation' | 'import'
      message?: string
    } & LibrarySelection
  ): Promise<WorkflowApplyResult> {
    this.checkArgs('workflowApply', args)
    return await this.withLibrary(args.library, async () => {
      const result = await this.mutateWorkflow(args.workflowId, () => this.applyService.apply(args))
      if (result.status === 'rejected' && result.issues?.some(issue => issue.code === 'revision-conflict'))
        throw this.revisionConflict(args.workflowId, args.expectedRevision ?? null, result.diff.from.documentRevision)
      return result
    })
  }

  /** Internal conversation-tool seam. ToolRuntime invokes this only after
   * its `tools/pre-execute` approval waterfall has returned allowed-once. */
  async workflowApplyFromHost(
    args: {
      workflowId: string
      definitionJson: string
      expectedRevision: string
      origin?: 'canvas' | 'conversation' | 'import'
      message?: string
      approval: typeof WORKFLOW_HOST_APPROVAL
    } & LibrarySelection
  ): Promise<WorkflowApplyResult> {
    const { approval, ...publicArgs } = args
    this.checkArgs('workflowApply', publicArgs)
    if (approval !== WORKFLOW_HOST_APPROVAL) return await this.workflowApply(publicArgs)
    return await this.withLibrary(args.library, async () => {
      const result = await this.mutateWorkflow(args.workflowId, () => this.applyService.applyTrusted(publicArgs))
      if (result.status === 'rejected' && result.issues?.some(issue => issue.code === 'revision-conflict'))
        throw this.revisionConflict(args.workflowId, args.expectedRevision, result.diff.from.documentRevision)
      return result
    })
  }

  async workflowRevisions(args: { workflowId: string } & LibrarySelection): Promise<Awaited<ReturnType<ApplyService['revisions']>>> {
    this.checkArgs('workflowRevisions', args)
    return await this.withLibrary(args.library, async () => await this.applyService.revisions(args.workflowId))
  }

  async workflowRevert(
    args: { workflowId: string; revision: string; expectedRevision: string; message?: string } & LibrarySelection
  ): Promise<WorkflowApplyResult> {
    this.checkArgs('workflowRevert', args)
    return await this.withLibrary(args.library, async () => await this.mutateWorkflow(args.workflowId, () => this.applyService.revert(args)))
  }

  async workflowRevertFromHost(
    args: {
      workflowId: string
      revision: string
      expectedRevision: string
      message?: string
      approval: typeof WORKFLOW_HOST_APPROVAL
    } & LibrarySelection
  ): Promise<WorkflowApplyResult> {
    const { approval, ...publicArgs } = args
    this.checkArgs('workflowRevert', publicArgs)
    if (approval !== WORKFLOW_HOST_APPROVAL) return await this.workflowRevert(publicArgs)
    return await this.withLibrary(args.library, async () => await this.mutateWorkflow(args.workflowId, () => this.applyService.revertTrusted(publicArgs)))
  }

  async workflowList(args: { library?: LibraryRef } = {}): Promise<Awaited<ReturnType<BlueprintDefinitionUseCases['listDefinitions']>>> {
    return await this.withLibrary(args.library, async () => await this.applyService.list())
  }

  async workflowRun(args: StartRunArgs): Promise<RunAdmissionView> {
    this.checkArgs('workflowRun', args)
    return runAdmissionCodec().parse(await this.startRun(args))
  }

  async workflowInspect(args: InspectRunArgs): Promise<RunSnapshotView> {
    this.checkArgs('workflowInspect', args)
    return await this.inspectRun(args)
  }

  async workflowReport(args: InspectRunArgs): Promise<RunReport> {
    return await this.withRunTarget(args, () => this.workflowReportInScope(args))
  }

  private async workflowReportInScope(args: InspectRunArgs): Promise<RunReport> {
    try {
      this.checkArgs('workflowReport', args)
      const handle = await this.configuredRuntime()
      return await this.runReads(handle).reportRun(args.runId, args.sessionId)
    } catch (error) {
      if (error instanceof DurabilityFailureError)
        throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'workflowReport' })
      throw error
    }
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
    // The workspace-native directory is the sole Run persistence medium.
    mkdirSync(root, { recursive: true })
    const lease = WriterLease.acquire(root)
    const stopLeaseHeartbeat = lease.startHeartbeat(() => this.leaseLost(root, lease))
    let opened: RuntimeHandle['opened'] | undefined
    try {
      // Every durable Run mutation is fenced on the lease: a writer that lost
      // ownership (stale takeover, split brain) is refused before it can
      // record intent or dispatch another effect.
      opened = await openBlueprintDomain({ path: root, fence: () => lease.assertOwned() })
      const store = new RunStore(opened.domain)
      const query = new RunQuery(store)
      const backgroundFailures = new Map<string, Error>()
      const handle: RuntimeHandle = {
        managed: new ManagedNodeSessions(this.ctx, store),
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

  /** A heartbeat observed that another writer now owns this runtime root.
   * Stop coordinating it: forget the handle so later requests reopen and see
   * the current owner, abort in-flight node work, and close the store once
   * admitted work settles. Fenced writes already refuse durable mutations. */
  private leaseLost(root: string, lease: WriterLease): void {
    const handle = this.runtimes.get(root)
    // Still opening: the fenced store fails the open, which releases nothing
    // that is no longer ours.
    if (handle === undefined || handle.lease !== lease) return
    this.runtimes.delete(root)
    for (const controllers of handle.controllers.values()) for (const controller of controllers.values()) controller.abort()
    const retired = (async () => {
      await Promise.allSettled(handle.cancellationTails.values())
      await Promise.allSettled(handle.jobs.values())
      await handle.admissionTail
      await handle.opened.close()
    })().catch(() => {})
    this.retiring.add(retired)
    void retired.then(() => this.retiring.delete(retired))
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

  /** Trusted execution target: explicit ID, then Host configuration, then the
   * caller session's registered Workspace. No default/cwd guess. */
  private resolveExecutionTarget(workspaceId?: string, library?: LibraryRef): ExecutionTarget {
    if (workspaceId !== undefined) return this.libraries.resolveTarget(workspaceId)
    if (library?.kind === 'workspace') return this.libraries.resolveTarget(library.workspaceId)
    const configured = this.libraries.configuredTarget()
    if (configured !== undefined) return configured
    const caller = CALLER_WORKSPACE.getStore()
    if (caller !== undefined) {
      const registered = workspaceEntries(this.ctx).find(entry => resolve(entry.path) === resolve(caller))
      if (registered !== undefined) return this.libraries.resolveTarget(registered.id)
    }
    throw new RemoteError('blueprint/workspace-required', 'select a workspace before executing', {})
  }

  private executionLibrary(target: ExecutionTarget, library: LibraryRef | undefined): LibraryRef {
    const selected = library ?? { kind: 'workspace' as const, workspaceId: target.workspaceId }
    if (selected.kind === 'global')
      throw new RemoteError('blueprint/instance-required', 'save a project instance before executing a global blueprint', {
        blueprintId: ''
      })
    if (selected.workspaceId !== target.workspaceId)
      throw new RemoteError('blueprint/workspace-mismatch', 'selected library does not match the execution target', {
        workspaceId: selected.workspaceId
      })
    return selected
  }

  async preflightRun(args: PreflightRunArgs & LibrarySelection): Promise<PreflightRunValue> {
    this.checkArgs('preflightRun', args)
    return await this.withSessionWorkspace(undefined, async () => {
      const target = this.resolveExecutionTarget(args.workspaceId, args.library)
      const library = this.executionLibrary(target, args.library)
      return await this.withLibrary(library, async () => await this.withTarget(target, () => this.preflightRunInLibrary(args)))
    })
  }

  private async preflightRunInLibrary(args: PreflightRunArgs): Promise<PreflightRunValue> {
    const root = this.blueprintRoot(args.blueprintId)
    return await this.documents.withDocument(root, async () => {
      const snapshot = this.documents.loadConfiguredPackage(args.blueprintId, root)
      if (snapshot.document.documentRevision !== args.expectedRevision)
        throw this.revisionConflict(args.blueprintId, args.expectedRevision, snapshot.document.documentRevision)
      const input = this.parseInput(args.inputJson)
      this.configuredRuntimeRoot()
      const { report } = await collectCompositionPreflight(
        this.ctx,
        snapshot,
        ref => this.documents.loadRevisionPackage(ref.blueprintId, this.blueprintRoot(ref.blueprintId), ref.documentRevision),
        {
          input,
          ...(this.config.toolBindings === undefined ? {} : { toolBindings: this.config.toolBindings }),
          skillRoots: this.preflightSkillRoots(),
          ...(this.config.teamProviders === undefined ? {} : { teamProviders: this.config.teamProviders }),
          ...(CALLER_WORKSPACE.getStore() === undefined ? {} : { cwd: CALLER_WORKSPACE.getStore()! }),
          ...(scopeForSession(this.ctx, CALLER_SESSION.getStore()) === undefined ? {} : { scope: scopeForSession(this.ctx, CALLER_SESSION.getStore())! })
        }
      )
      return report
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
    return await this.withSessionWorkspace(args.sessionId, async () => await this.startConfiguredRun(args, { sessionId: caller.session.id, kind: 'ui' }))
  }

  /** Admit one durable TeamStage task from an exact root Lead. The Team id is
   * resolved from the live native Agent and never accepted from wire input. */
  async startTeamStage(args: StartTeamStageArgs): Promise<TeamStageActionView> {
    return await this.withSessionWorkspace(typeof args?.sessionId === 'string' ? args.sessionId : undefined, () => this.startTeamStageInScope(args))
  }

  private async startTeamStageInScope(args: StartTeamStageArgs): Promise<TeamStageActionView> {
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
    return await this.withSessionWorkspace(typeof args?.sessionId === 'string' ? args.sessionId : undefined, () => this.cancelTeamStageInScope(args))
  }

  private async cancelTeamStageInScope(args: CancelTeamStageArgs): Promise<TeamStageActionView> {
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
    return await this.withSessionWorkspace(typeof args?.sessionId === 'string' ? args.sessionId : undefined, () => this.acceptTeamStageOutputInScope(args))
  }

  private async acceptTeamStageOutputInScope(args: AcceptTeamStageOutputArgs): Promise<TeamStageActionView> {
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

  /** New instances keep a durable preparation pointer before package publication.
   * Legacy instances are discovered by a matching manifest. Missing/corrupt
   * evidence for a linked instance blocks admission rather than becoming unmanaged. */
  private preparationDigestFor(target: ExecutionTarget, blueprintId: string, document?: DefinitionDocument): string | null {
    const directory = join(target.root, '.xuanling', 'preparations')
    const pointer = join(directory, '.instances', `${blueprintId}.json`)
    const stale = (preparationId: string) =>
      new RemoteError('blueprint/preparation-stale', 'project evidence changed or unavailable; prepare the instance again', { preparationId })
    let expected: string | undefined
    let entries: string[]
    try {
      assertStoragePath(target.root, pointer)
      if (existsSync(pointer)) {
        const parsed = JSON.parse(readFileSync(pointer, 'utf8')) as { preparationId?: unknown }
        if (typeof parsed.preparationId !== 'string' || !/^prep-[a-f0-9]{32}$/.test(parsed.preparationId)) throw stale('unavailable')
        expected = parsed.preparationId
      }
      entries = expected === undefined ? readdirSync(directory).filter(name => name.endsWith('.json')) : [`${expected}.json`]
    } catch (error) {
      if (expected === undefined && !existsSync(pointer) && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw stale(expected ?? 'unavailable')
    }
    let latest: { at: number; raw: string; manifest: PreparationManifest } | undefined
    for (const entry of entries) {
      try {
        assertStoragePath(target.root, join(directory, entry))
        const raw = readFileSync(join(directory, entry), 'utf8')
        const preparation = preparationManifestCodec().parse(JSON.parse(raw))
        if (preparation.generated?.instanceAsset.blueprintId !== blueprintId) {
          if (expected !== undefined) throw stale(expected)
          continue
        }
        const at = lstatSync(join(directory, entry)).mtimeMs
        if (latest === undefined || at > latest.at) latest = { at, raw, manifest: preparation }
      } catch {
        if (expected !== undefined) throw stale(expected)
      }
    }
    if (latest === undefined) return null
    const preparation = latest.manifest
    if (
      document !== undefined &&
      (preparation.status !== 'ready' ||
        preparation.target.workspaceId !== target.workspaceId ||
        preparation.generated?.instanceAsset.library.kind !== 'workspace' ||
        preparation.generated.instanceAsset.library.workspaceId !== target.workspaceId ||
        preparation.generated.definitionDigest !== createHash('sha256').update(document.definitionJson).digest('hex') ||
        canonicalJson(preparation.facts) !== canonicalJson(discoverProject(target.root)))
    )
      throw stale(preparation.preparationId)
    return createHash('sha256').update(latest.raw).digest('hex')
  }

  private async startConfiguredRun(args: StartRunArgs, source?: RunSource) {
    const target = this.resolveExecutionTarget(args.workspaceId, args.library)
    const library = this.executionLibrary(target, args.library)
    const sourceParent = source === undefined ? undefined : captureNativeSourceParent(this.ctx, source.sessionId)
    return await this.withLibrary(
      library,
      async () =>
        await this.withTarget(target, async () => {
          const root = this.blueprintRoot(args.blueprintId)
          return await this.documents.withDocument(
            root,
            async () => {
              const snapshot = this.documents.loadConfiguredPackage(args.blueprintId, root)
              const { document } = snapshot
              if (document.documentRevision !== args.expectedRevision)
                throw this.revisionConflict(args.blueprintId, args.expectedRevision, document.documentRevision)
              this.parseInput(args.inputJson)
              const runtimeRoot = this.configuredRuntimeRoot()
              let staging: string | undefined
              try {
                const admittedRun = await this.admitRun(
                  { definitionJson: document.definitionJson, inputJson: args.inputJson, runtimeRoot, requestId: args.requestId },
                  document.semanticRevision,
                  async () => {
                    this.preparationDigestFor(target, args.blueprintId, document)
                    // Called under admissionTail, ONLY after a matching command replay
                    // has returned. A changed Host/shared Skill cannot reinterpret it.
                    const { report, closure } = await collectCompositionPreflight(
                      this.ctx,
                      snapshot,
                      ref => this.documents.loadRevisionPackage(ref.blueprintId, this.blueprintRoot(ref.blueprintId), ref.documentRevision),
                      {
                        input: this.parseInput(args.inputJson),
                        ...(this.config.toolBindings === undefined ? {} : { toolBindings: this.config.toolBindings }),
                        skillRoots: this.preflightSkillRoots(),
                        ...(this.config.teamProviders === undefined ? {} : { teamProviders: this.config.teamProviders }),
                        ...(CALLER_WORKSPACE.getStore() === undefined ? {} : { cwd: CALLER_WORKSPACE.getStore()! }),
                        ...(source === undefined
                          ? {}
                          : (() => {
                              const scope = scopeForSession(this.ctx, source.sessionId)
                              return scope === undefined ? {} : { scope }
                            })())
                      }
                    )
                    if (!report.canStart) throw new RemoteError('blueprint/preflight-blocked', 'new Run blocked by preflight', { checks: report.checks })
                    try {
                      staging = mkdtempSync(join(tmpdir(), 'bp-admission-bytes-'))
                      this.materializePackage(snapshot, staging)
                      return { rootDir: staging, children: [...closure.values()] }
                    } catch (error) {
                      throw this.documentFailure(args.blueprintId, 'admission-stage', error)
                    }
                  },
                  {
                    blueprintId: args.blueprintId,
                    documentRevision: document.documentRevision,
                    ...(source === undefined ? {} : { source }),
                    context: {
                      instanceAssetRef: { library, blueprintId: args.blueprintId },
                      originAssetRef: null,
                      targetWorkspace: {
                        workspaceId: target.workspaceId,
                        rootFingerprint: createHash('sha256').update(realpathSync(target.root)).digest('hex')
                      },
                      preparationDigest: this.preparationDigestFor(target, args.blueprintId)
                    }
                  },
                  sourceParent
                )
                if (source !== undefined) {
                  try {
                    this.associationStore().link(source.sessionId, { library, blueprintId: args.blueprintId }, document.documentRevision, admittedRun.runId)
                  } catch {
                    // The Run is durable; a missing link is repaired by the next
                    // explicit start or by inspectSession's association list.
                  }
                }
                return admittedRun
              } finally {
                if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
              }
            },
            true
          )
        })
    )
  }

  private async admitRun(
    args: InternalStartRunArgs,
    savedSemanticRevision?: string,
    beforeNewAdmission?: () => Promise<string | AdmissionPackage | undefined>,
    metadata: {
      blueprintId?: string
      documentRevision?: string
      source?: RunSource
      context?: NonNullable<RunRecord['context']>
    } = {},
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
    const targetFingerprint =
      metadata.context === undefined
        ? ''
        : `\u0000${JSON.stringify([
            metadata.context.instanceAssetRef === null ? null : libraryKey(metadata.context.instanceAssetRef.library),
            metadata.context.targetWorkspace?.workspaceId ?? null
          ])}`
    const payloadFingerprint = createHash('sha256')
      .update(`${args.definitionJson}\u0000${args.inputJson}${sourceFingerprint}${targetFingerprint}`)
      .digest('hex')
    const request = { scope: 'run', requestId, payloadFingerprint }
    const admitted = handle.admissionTail.then(async () => {
      const replay = await handle.store.replayRun(request)
      if (replay) return { runId: replay.runId, semanticRevision: replay.definitionRevision, state: replay.state, replayed: true }
      if (metadata.source?.kind === 'tool' && handle.jobs.size >= (this.config.maxQueuedToolRuns ?? DEFAULT_MAX_QUEUED_TOOL_RUNS))
        throw new RemoteError('blueprint/preflight-blocked', 'new Run blocked by preflight', { checks: [{ code: 'active-run-limit', status: 'block' }] })
      const preparedAdmission = beforeNewAdmission ? await beforeNewAdmission() : args.rootDir
      const rootDir = typeof preparedAdmission === 'object' ? preparedAdmission.rootDir : preparedAdmission
      if (definition.graph.nodes.some(node => node.kind === 'blueprintCall') && typeof preparedAdmission !== 'object')
        throw new RemoteError('blueprint/preflight-blocked', 'pinned closure required', {
          checks: [{ code: 'blueprint-revision-unavailable', status: 'block' }]
        })
      if (sourceParent !== undefined && metadata.source !== undefined) assertNativeSourceParent(this.ctx, sourceParent, metadata.source.sessionId)
      const admissionDefinitions = [
        definition,
        ...(typeof preparedAdmission === 'object' ? preparedAdmission.children.map(child => this.decodeOrThrow(child.document.definitionJson)) : [])
      ]
      for (const node of admissionDefinitions.flatMap(value => value.graph.nodes).filter(node => node.teamStage !== undefined)) {
        try {
          admitTeamDriver(this.ctx, node, sourceParent?.agent, this.config.teamProviders)
        } catch (error) {
          const code = error instanceof TeamDriverError ? error.issueCode : 'teamstage-executor-unavailable'
          throw new RemoteError('blueprint/preflight-blocked', 'new Run blocked by preflight', { checks: [{ code, status: 'block', nodeId: node.id }] })
        }
      }
      const created = await handle.store.createRun(request, semanticRevision, args.definitionJson, args.inputJson, {
        ...metadata,
        // Presence of this field makes an interrupted admission fail closed on
        // restart instead of silently accepting a later host binding.
        bindingDigests: {}
      })
      if (!created.replayed) {
        try {
          await handle.snapshots.freezePackage(created.runId, definition, rootDir)
          if (typeof preparedAdmission === 'object' && preparedAdmission.children.length) {
            const composition = await freezeBlueprintClosure(
              handle,
              preparedAdmission.children,
              (snapshot, root) => this.materializePackage(snapshot, root),
              (runtime, snapshotId, child) => this.captureBindingDigests(runtime, snapshotId, child, sourceParent?.agent)
            )
            await handle.store.transition(created.runId, draft => {
              draft.composition = composition
            })
          }
          const bindingSnapshot = await this.captureBindingDigests(handle, created.runId, definition, sourceParent?.agent)
          await handle.store.setBindingDigests(created.runId, bindingSnapshot.digests, bindingSnapshot.modelSelections)
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

  /** Resolve every declared binding once during admission. This uses the same
   * immutable package and Host registries as Attempt preparation, so an
   * Attempt can compare its live resolution to these facts before dispatch. */
  private async captureBindingDigests(
    handle: RuntimeHandle,
    runId: string,
    definition: ReturnType<typeof decodeDefinition>,
    scope?: object
  ): Promise<{ digests: Record<string, string>; modelSelections: Record<string, HostModelSelection | null> }> {
    const perNode: Array<Record<string, string>> = []
    const modelSelections: Record<string, HostModelSelection | null> = {}
    for (const node of definition.graph.nodes.filter(value => value.kind === 'agentTask')) {
      // TeamStage admission must resolve the same member closure that the
      // Attempt path uses.  The ordinary Agent preparation omits member agent
      // bindings, which would make every native Team Attempt appear to drift
      // before the Team driver can establish its durable stage.
      const preparation = {
        ...(scope === undefined ? {} : { scope }),
        ...(CALLER_WORKSPACE.getStore() === undefined ? {} : { cwd: CALLER_WORKSPACE.getStore()! })
      }
      const prepared =
        node.teamStage === undefined
          ? await handle.snapshots.prepare(runId, definition, node, preparation)
          : await handle.snapshots.prepareTeam(runId, definition, node, preparation)
      const inheritedModelSelection = node.teamStage === undefined && node.modelSelection === undefined ? captureAgentModelSelection(this.ctx) : undefined
      const modelSelection =
        node.teamStage === undefined
          ? node.modelSelection === undefined
            ? inheritedModelSelection
            : {
                provider: node.modelSelection.provider,
                model: node.modelSelection.model,
                ...(node.modelSelection.reasoningEffort === undefined ? {} : { reasoningEffort: node.modelSelection.reasoningEffort })
              }
          : undefined
      // Only inherited routes need persistence: pinned routes are already
      // part of the frozen definition and are reused directly by Attempts.
      if (node.teamStage === undefined && node.modelSelection === undefined)
        modelSelections[node.id] = inheritedModelSelection === undefined ? null : structuredClone(inheritedModelSelection)
      const effectiveToolNames = resolveEffectiveToolNames(this.ctx, definition, node, this.config.toolBindings)
      perNode.push(
        buildBindingFacts({
          nodeId: node.id,
          ...(node.agentRef === undefined ? {} : { agentRef: node.agentRef }),
          ...(node.skillRefs === undefined ? {} : { skillRefs: node.skillRefs }),
          ...(node.toolsetRefs === undefined ? {} : { toolsetRefs: node.toolsetRefs }),
          ...(node.toolAllowlist === undefined ? {} : { toolAllowlist: node.toolAllowlist }),
          resourceDigests: prepared.resourceDigests,
          effectiveToolNames,
          toolsetDigest: toolsetBindingDigest(this.ctx, effectiveToolNames),
          ...(modelSelection === undefined ? {} : { modelSelection }),
          ...(node.outputSchemaRef === undefined ? {} : { outputSchemaRef: node.outputSchemaRef })
        }).digests
      )
    }
    return { digests: aggregateBindingDigests(perNode), modelSelections }
  }

  private readonly runReads = (handle: RuntimeHandle): RunReadService => handle.reads

  // wire method (descriptor in ./typert.host.ts): inspectRun
  async inspectRun(args: InspectRunArgs & { runtimeRoot?: string; workspaceId?: string }): Promise<RunSnapshotView> {
    if (args?.runtimeRoot === undefined) return await this.withRunTarget(args, () => this.inspectRunInScope(args))
    return await this.inspectRunInScope(args)
  }

  private async inspectRunInScope(args: InspectRunArgs & { runtimeRoot?: string }): Promise<RunSnapshotView> {
    try {
      if (args.runtimeRoot === undefined) this.checkArgs('inspectRun', args)
      const handle = await this.configuredRuntime(args.runtimeRoot)
      return await this.runReads(handle).inspectRun(args.runId, args.sessionId)
    } catch (error) {
      if (error instanceof DurabilityFailureError) throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'inspectRun' })
      throw error
    }
  }

  async queryRuns(args: RunQueryArgs): Promise<RunQueryValue> {
    return await this.withRunTarget(args, () => this.queryRunsInScope(args))
  }

  private async queryRunsInScope(args: RunQueryArgs): Promise<RunQueryValue> {
    try {
      this.checkArgs('queryRuns', args)
      const handle = await this.configuredRuntime()
      return await this.runReads(handle).queryRuns(args)
    } catch (error) {
      if (error instanceof DurabilityFailureError) throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'queryRuns' })
      throw error
    }
  }

  private async setRunArchived(args: RunLifecycleActionArgs, archived: boolean): Promise<RunLifecycleActionValue> {
    return await this.withRunTarget(args, async () => {
      this.checkArgs(archived ? 'archiveRun' : 'restoreRun', args)
      const handle = await this.configuredRuntime()
      return await this.runReads(handle).setArchived(args, archived)
    })
  }

  async archiveRun(args: RunLifecycleActionArgs): Promise<RunLifecycleActionValue> {
    return await this.setRunArchived(args, true)
  }

  async restoreRun(args: RunLifecycleActionArgs): Promise<RunLifecycleActionValue> {
    return await this.setRunArchived(args, false)
  }

  async inspectSession(args: InspectSessionArgs): Promise<InspectSessionValue> {
    return await this.withRunTarget(args, () => this.inspectSessionInScope(args))
  }

  async inspectRunView(args: InspectRunViewArgs): Promise<InspectRunViewValue> {
    return await this.withRunTarget(args, async () => {
      this.checkArgs('inspectRunView', args)
      try {
        const handle = await this.configuredRuntime()
        return await this.runReads(handle).inspectRunView(args.runId, args.sessionId)
      } catch (error) {
        if (error instanceof DurabilityFailureError)
          throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'inspectRunView' })
        throw error
      }
    })
  }

  private async inspectSessionInScope(args: InspectSessionArgs): Promise<InspectSessionValue> {
    try {
      this.checkArgs('inspectSession', args)
      const handle = await this.configuredRuntime()
      const value = await this.runReads(handle).inspectSession(args)
      const store = this.associationStore()
      const records = await Promise.all((await handle.store.listRunIds()).map(id => handle.store.get(id)))
      for (const run of records.filter(run => run.source?.sessionId === args.sessionId && run.context?.instanceAssetRef && run.documentRevision)) {
        const asset = run.context!.instanceAssetRef!
        store.link(args.sessionId, asset, run.documentRevision!, run.runId, run.createdAt)
      }
      const associations = store.list(args.sessionId).map(association => {
        const run = records.find(record => record.runId === association.runId)
        const status =
          run === undefined
            ? association.status
            : TERMINAL_RUN_STATES.includes(run.state)
              ? 'settled'
              : run.state === 'recovery_required'
                ? 'blocked'
                : 'running'
        return associationView(status === association.status ? association : store.put({ ...association, status, updatedAt: new Date().toISOString() }))
      })
      return associations.length === 0 ? value : { ...value, associations }
    } catch (error) {
      if (error instanceof DurabilityFailureError)
        throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'inspectSession' })
      throw error
    }
  }

  // wire method (descriptor in ./typert.host.ts): cancelRun
  async inspectNodeSession(args: { sessionId: string }): Promise<NodeSessionView> {
    this.checkArgs('inspectNodeSession', args)
    return this.withSessionWorkspace(args.sessionId, async () => {
      const handle = await this.configuredRuntime()
      const view = await handle.reads.inspectSession(args)
      if (view.status !== 'bound') return { status: 'unmanaged' }
      const record = await handle.store.get(view.selected.run.runId)
      const attempt = record.attempts.find(item => item.sessionId === args.sessionId)
      return attempt === undefined ? { status: 'unmanaged' } : handle.managed.view(record, attempt)
    })
  }

  async messageNode(args: NodeMessageArgs): Promise<NodeMessageReceipt> {
    this.checkArgs('messageNode', args)
    return this.withSessionWorkspace(args.sessionId, async () => {
      if (this.closing) throw new RemoteError('blueprint/node-not-active', 'node-not-active', {})
      try {
        const handle = await this.configuredRuntime()
        return await handle.managed.message(args)
      } catch (error) {
        if (error instanceof ManagedNodeError) throw new RemoteError(`blueprint/${error.code}`, error.code, {})
        if (error instanceof RunNotFoundError) throw new RemoteError('blueprint/run-not-found', 'run-not-found', { runId: args.runId })
        throw new RemoteError('blueprint/durability-failed', 'Node message storage unavailable', { operation: 'messageNode' })
      }
    })
  }

  async cancelRun(args: CancelRunArgs & { runtimeRoot?: string; workspaceId?: string }): Promise<{ runId: string; state: string }> {
    try {
      if (args.runtimeRoot === undefined) this.checkArgs('cancelRun', args)
      return await this.withRunTarget(args, () => this.cancelRunInScope(args))
    } catch (error) {
      if (error instanceof DurabilityFailureError) throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'cancelRun' })
      throw error
    }
  }

  private async cancelRunInScope(args: CancelRunArgs & { runtimeRoot?: string }): Promise<{ runId: string; state: string }> {
    try {
      const handle = await this.configuredRuntime(args.runtimeRoot)
      const record = await handle.store.tryGet(args.runId)
      if (record === undefined) {
        throw new RemoteError('blueprint/run-not-found', `run ${args.runId} not found`, { runId: args.runId })
      }
      this.execution.closeTree(handle, args.runId)
      if (record.attempts.some(attempt => attempt.childRunId !== undefined)) {
        const after = await this.execution.cancelTree(handle, args.runId)
        return { runId: after.runId, state: after.state }
      }
      const afterRequest = await handle.store.requestCancel(args.runId)
      for (const controller of handle.controllers.get(args.runId)?.values() ?? []) controller.abort()
      const after = afterRequest.teamStage === undefined ? afterRequest : await this.cancelTeamRun(handle, afterRequest)
      if (after.teamStage === undefined && after.state === 'cancelling' && !handle.controllers.has(args.runId))
        this.execution.scheduleRun(handle, args.runId, undefined, after.parent !== undefined)
      return { runId: after.runId, state: after.state }
    } catch (error) {
      if (error instanceof DurabilityFailureError) throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'cancelRun' })
      throw error
    }
  }

  /**
   * Move a `recovery_required` Run to the terminal the operator confirmed.
   * The unknown effect is never re-dispatched; the note is the durable audit
   * evidence. Replaying the same resolution is idempotent; a stale review
   * (`expectedSeq`) or a TeamStage with unknown native effects is rejected.
   */
  async resolveRecovery(args: ResolveRecoveryArgs): Promise<ResolveRecoveryValue> {
    return await this.withRunTarget(args, async () => {
      this.checkArgs('resolveRecovery', args)
      const handle = await this.configuredRuntime()
      const record = await handle.store.tryGet(args.runId)
      if (record === undefined) throw new RemoteError('blueprint/run-not-found', 'Run not found', { runId: args.runId })
      const identity = record.context?.targetWorkspace
      const target = identity == null ? this.libraries.configuredTarget() : this.libraries.resolveTarget(identity.workspaceId)
      if (target === undefined) return await this.resolveRecoveryInScope(args)
      const root = realpathSync(target.root)
      if (identity != null && createHash('sha256').update(root).digest('hex') !== identity.rootFingerprint)
        throw new RemoteError('blueprint/run-lifecycle-conflict', 'Workspace changed since admission', { runId: args.runId, detail: 'workspace-mismatch' })
      try {
        return await WorkspaceWriteLease.reconcile(
          root,
          { runId: record.runId, attemptIds: record.attempts.map(a => a.attemptId) },
          { quiescent: args.workspaceQuiescent === true, note: args.note },
          () => this.resolveRecoveryInScope(args)
        )
      } catch (error) {
        if (error instanceof WorkspaceWriteError || (error as { code?: string }).code?.startsWith('COORDINATOR_'))
          throw new RemoteError('blueprint/run-lifecycle-conflict', 'Workspace effects require confirmed quiescence', {
            runId: args.runId,
            detail: 'workspace-recovery-required'
          })
        throw error
      }
    })
  }

  /** Idempotent replay: the same operator resolution (terminal state,
   * resolution and note) on an already-settled Run returns the durable
   * terminal without a second write. Auto reconciliation entries are never
   * accepted as a replay. */
  private recoveryReplay(record: RunRecord, resolution: ResolveRecoveryArgs['resolution'], note: string): ResolveRecoveryValue | undefined {
    if (record.state !== resolution) return undefined
    const last = [...record.log].reverse().find(event => event.kind === 'state' && typeof event.detail.recovery === 'string')
    if (last?.detail.recovery !== resolution || last.detail.evidence !== note || last.detail.actor !== 'operator') return undefined
    return { runId: record.runId, state: record.state, seq: record.seq, applied: false }
  }

  private teamStageNeedsCleanup(runId: string): RemoteError {
    return new RemoteError('blueprint/run-lifecycle-conflict', 'TeamStage recovery needs native Team cleanup', {
      runId,
      detail: 'teamstage-recovery-manual'
    })
  }

  private async resolveRecoveryInScope(args: ResolveRecoveryArgs): Promise<ResolveRecoveryValue> {
    try {
      this.checkArgs('resolveRecovery', args)
      const note = args.note.trim()
      if (note.length === 0) throw new RemoteError('blueprint/run-lifecycle-conflict', 'recovery note required', { runId: args.runId, detail: 'note-required' })
      const handle = await this.configuredRuntime()
      const record = await handle.store.tryGet(args.runId)
      if (record === undefined) throw new RemoteError('blueprint/run-not-found', 'Run not found', { runId: args.runId })
      if (record.state !== 'recovery_required') {
        const replay = this.recoveryReplay(record, args.resolution, note)
        if (replay !== undefined) return replay
        throw new RemoteError('blueprint/run-lifecycle-conflict', 'Run is not waiting for recovery', { runId: args.runId, detail: 'not-recovery-required' })
      }
      if (teamStageBlocksRecovery(record.teamStage?.state)) throw this.teamStageNeedsCleanup(args.runId)
      for (const attempt of record.attempts) {
        if (!attempt.childRunId) continue
        const child = await handle.store.tryGet(attempt.childRunId)
        const settled =
          child === undefined
            ? args.resolution !== 'succeeded'
            : child.parent?.runId === record.runId &&
              child.parent.attemptId === attempt.attemptId &&
              ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(child.state) &&
              (args.resolution !== 'succeeded' || child.state === 'succeeded')
        if (!settled)
          throw new RemoteError('blueprint/run-lifecycle-conflict', 'Child Run requires reconciliation', {
            runId: args.runId,
            detail: 'child-recovery-required'
          })
      }
      try {
        const after = await reconcile(handle.store, record, args.resolution, note, {
          expectedSeq: args.expectedSeq,
          operator: true,
          guardTeamStage: true
        })
        return { runId: after.runId, state: after.state, seq: after.seq, applied: true }
      } catch (error) {
        if (error instanceof RecoveryStaleError)
          throw new RemoteError('blueprint/run-lifecycle-conflict', 'Run changed since review', { runId: args.runId, detail: 'stale-review' })
        if (error instanceof IllegalTransitionError)
          throw new RemoteError('blueprint/run-lifecycle-conflict', 'Run is not waiting for recovery', { runId: args.runId, detail: 'not-recovery-required' })
        if (error instanceof TeamStageConflictError) throw this.teamStageNeedsCleanup(args.runId)
        if (error instanceof TerminalStateError || error instanceof RunNotFoundError) {
          // Lost the race to another settle (for example a duplicate submit of
          // the same review): re-read the committed cut and answer with the
          // idempotent replay instead of leaking a raw store/gateway failure.
          const current = await handle.store.tryGet(args.runId)
          const replay = current === undefined ? undefined : this.recoveryReplay(current, args.resolution, note)
          if (replay !== undefined) return replay
          throw new RemoteError('blueprint/run-lifecycle-conflict', 'Run is not waiting for recovery', {
            runId: args.runId,
            detail: 'not-recovery-required'
          })
        }
        throw error
      }
    } catch (error) {
      if (error instanceof DurabilityFailureError)
        throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'resolveRecovery' })
      throw error
    }
  }

  async decide(
    args: DecideArgs & { runtimeRoot?: string; workspaceId?: string; sessionId?: string }
  ): Promise<{ runId: string; decisionId: string; state: string; applied: boolean }> {
    return await this.withRunTarget(args, () => this.decideInScope(args))
  }

  private async decideInScope(
    args: DecideArgs & { runtimeRoot?: string; workspaceId?: string; sessionId?: string }
  ): Promise<{ runId: string; decisionId: string; state: string; applied: boolean }> {
    try {
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
        if (decision.applied && decision.record.state === 'running')
          this.execution.scheduleRun(handle, args.runId, undefined, decision.record.parent !== undefined)
        return { runId: args.runId, decisionId: args.decisionId, state: decision.record.state, applied: decision.applied }
      } catch (error) {
        if (error instanceof DecisionConflictError)
          throw new RemoteError('blueprint/decision-invalid', 'decision conflicts with durable Attempt', { detail: 'decision-conflict' })
        throw error
      }
    } catch (error) {
      if (error instanceof DurabilityFailureError) throw new RemoteError('blueprint/durability-failed', 'Run storage unavailable', { operation: 'decide' })
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
    return await this.withLibrary(args.library, async () => await this.portability.exportConfigured(args))
  }

  async importDefinition(args: ImportDefinitionArgs): Promise<{ blueprintId: string; filesWritten: number; closureDigest: string }>
  async importDefinition(args: { archivePath: string; targetDir?: string }): ReturnType<BlueprintPortabilityUseCases['importInternal']>
  async importDefinition(args: ImportDefinitionArgs | { archivePath: string; targetDir?: string }) {
    if ('archivePath' in args) return await this.portability.importInternal(args)
    return await this.withLibrary(args.library, async () => await this.portability.importConfigured(args))
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
