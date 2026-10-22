/** Browser wire adapter. IDs are opaque identities, never filesystem locators. */
import { BLUEPRINT_INVOCATIONS } from '../../../typert-descriptors.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PreflightRunValue } from '../../../host/preflight.ts'
import type {
  AcceptTeamStageOutputArgs,
  CancelTeamStageArgs,
  RunLifecycleActionValue,
  RunQueryArgs,
  RunQueryValue,
  StartTeamStageArgs,
  TeamStageActionView
} from '../../../conversation/contracts.ts'
export type { PreflightRunValue, PreflightCheck } from '../../../host/preflight.ts'
import type { RunSnapshotView } from '../../features/authoring/logic/run/client-model.ts'

export interface DefinitionDocument {
  blueprintId: string
  definitionJson: string
  documentRevision: string
  semanticRevision: string
  layoutRevision: string
}
export interface CatalogValue {
  definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }>
}
export type HostResourceKind = 'agent' | 'skill' | 'mcp'
export interface HostResourceCatalogEntry {
  id: string
  kind: HostResourceKind
  displayName: string
  description: string
  source: 'dsh'
  availability: 'available' | 'unavailable'
  provenance: 'builtin' | 'custom' | 'unknown'
  bindingId?: string
}
export interface ResourceCatalogValue {
  resources: HostResourceCatalogEntry[]
}
/** DSH's Host-generation model directory, exposed through the existing Session Remote. */
export interface ModelCatalogLink {
  modelCatalog(): Promise<{
    ok: boolean
    value?: ModelCatalog
    error?: { code: string; message?: string }
  }>
}
export type ModelCatalogStatus = 'unavailable' | 'loading' | 'ready'
export interface RunAdmission {
  runId: string
  semanticRevision: string
  state: string
  replayed: boolean
}
export interface BlueprintArchive {
  blueprintId: string
  closureDigest: string
  files: number
  archiveSha256: string
  archiveBase64: string
  requiredBindings: string[]
}
export interface BlueprintImport {
  blueprintId: string
  filesWritten: number
  closureDigest: string
}
export interface RemoteResult {
  ok: boolean
  value?: unknown
  error?: { code: string }
}
export type RemoteNamespace = Record<string, ((args?: Record<string, unknown>) => Promise<RemoteResult>) | undefined>
export class BlueprintRemoteError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.name = 'BlueprintRemoteError'
    this.code = code
  }
}
export interface HostLink {
  listDefinitions(): Promise<CatalogValue>
  listResources?(): Promise<ResourceCatalogValue>
  loadDefinition(blueprintId: string): Promise<DefinitionDocument>
  createDefinition?(requestId: string, definitionJson: string): Promise<DefinitionDocument>
  deleteDefinition?(blueprintId: string, expectedRevision: string, requestId: string): Promise<{ blueprintId: string; deleted: true }>
  saveDefinition(blueprintId: string, definitionJson: string, expectedRevision: string | null): Promise<DefinitionDocument>
  restoreDefinitionRevision?(blueprintId: string, revision: string, expectedRevision: string): Promise<DefinitionDocument>
  validate(definitionJson: string): Promise<{ ok: true; semanticRevision: string }>
  preflightRun(blueprintId: string, expectedRevision: string, inputJson: string): Promise<PreflightRunValue>
  startRun(blueprintId: string, expectedRevision: string, inputJson: string, requestId: string): Promise<RunAdmission>
  inspectRun(runId: string): Promise<RunSnapshotView>
  queryRuns(args: RunQueryArgs): Promise<RunQueryValue>
  archiveRun(runId: string): Promise<RunLifecycleActionValue>
  restoreRun(runId: string): Promise<RunLifecycleActionValue>
  cancelRun(runId: string): Promise<{ runId: string; state: string }>
  resolveRecovery?(args: {
    runId: string
    resolution: 'failed' | 'succeeded' | 'cancelled'
    note: string
    expectedSeq: number
  }): Promise<{ runId: string; state: string; seq: number; applied: boolean }>
  decide(runId: string, decisionId: string, action: 'approve' | 'reject'): Promise<{ runId: string; decisionId: string; state: string; applied: boolean }>
  startTeamStage(args: StartTeamStageArgs): Promise<TeamStageActionView>
  cancelTeamStage(args: CancelTeamStageArgs): Promise<TeamStageActionView>
  acceptTeamStageOutput(args: AcceptTeamStageOutputArgs): Promise<TeamStageActionView>
  exportDefinition?(blueprintId: string): Promise<BlueprintArchive>
  importDefinition?(blueprintId: string, archiveBase64: string): Promise<BlueprintImport>
  workflowList?(): Promise<CatalogValue>
  workflowGet?(workflowId: string): Promise<unknown>
  workflowValidate?(workflowId: string, definitionJson: string): Promise<unknown>
  workflowPropose?(args: Record<string, unknown>): Promise<unknown>
  workflowApply?(args: Record<string, unknown>): Promise<unknown>
  workflowRevisions?(workflowId: string): Promise<unknown>
  workflowRevert?(args: Record<string, unknown>): Promise<unknown>
  workflowRun?(args: Record<string, unknown>): Promise<unknown>
  workflowInspect?(runId: string): Promise<unknown>
  workflowReport?(runId: string): Promise<unknown>
}
export function resolveBlueprintHost(context: { get?: (key: string) => unknown }): HostLink | undefined {
  // Native Cordis authorizes the declared namespace, not a nested root read.
  const namespace = context.get?.('remote.blueprint') as RemoteNamespace | undefined
  if (!namespace) return undefined
  async function invoke<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    const fn = namespace?.[method]
    if (typeof fn !== 'function') throw new BlueprintRemoteError('blueprint/capability-unavailable')
    // Preserve method receiver: the host may implement namespace methods on a proxy.
    const result = args === undefined ? await fn.call(namespace) : await fn.call(namespace, args)
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean')
      throw new BlueprintRemoteError('blueprint/dto-invalid')
    if (!result.ok) throw new BlueprintRemoteError(typeof result.error?.code === 'string' ? result.error.code : 'blueprint/remote-failed')
    if (
      method === 'deleteDefinition' ||
      method === 'createDefinition' ||
      method === 'restoreDefinitionRevision' ||
      method === 'preflightRun' ||
      method === 'inspectRun' ||
      method === 'queryRuns' ||
      method === 'archiveRun' ||
      method === 'restoreRun' ||
      method === 'resolveRecovery' ||
      method === 'exportDefinition' ||
      method === 'importDefinition' ||
      method === 'listResources' ||
      method === 'startTeamStage' ||
      method === 'cancelTeamStage' ||
      method === 'acceptTeamStageOutput' ||
      method.startsWith('workflow')
    ) {
      const descriptor = BLUEPRINT_INVOCATIONS.find(item => item.method === method)!
      const parsed = descriptor.result.create().safeParse(result.value)
      if (!parsed.success) throw new BlueprintRemoteError('blueprint/dto-invalid')
      return parsed.data as T
    }
    return result.value as T
  }
  return {
    listDefinitions: () => invoke('listDefinitions'),
    listResources: () => invoke('listResources'),
    exportDefinition: blueprintId => invoke('exportDefinition', { blueprintId }),
    importDefinition: (blueprintId, archiveBase64) => invoke('importDefinition', { blueprintId, archiveBase64 }),
    loadDefinition: blueprintId => invoke('loadDefinition', { blueprintId }),
    createDefinition: (requestId, definitionJson) => invoke('createDefinition', { requestId, definitionJson }),
    deleteDefinition: (blueprintId, expectedRevision, requestId) => invoke('deleteDefinition', { blueprintId, expectedRevision, requestId }),
    saveDefinition: (blueprintId, definitionJson, expectedRevision) => invoke('saveDefinition', { blueprintId, definitionJson, expectedRevision }),
    restoreDefinitionRevision: (blueprintId, revision, expectedRevision) => invoke('restoreDefinitionRevision', { blueprintId, revision, expectedRevision }),
    validate: definitionJson => invoke('validate', { definitionJson }),
    preflightRun: (blueprintId, expectedRevision, inputJson) => invoke('preflightRun', { blueprintId, expectedRevision, inputJson }),
    startRun: (blueprintId, expectedRevision, inputJson, requestId) => invoke('startRun', { blueprintId, expectedRevision, inputJson, requestId }),
    inspectRun: runId => invoke('inspectRun', { runId }),
    queryRuns: args => invoke('queryRuns', args),
    archiveRun: runId => invoke('archiveRun', { runId }),
    restoreRun: runId => invoke('restoreRun', { runId }),
    cancelRun: runId => invoke('cancelRun', { runId }),
    resolveRecovery: args => invoke('resolveRecovery', args),
    decide: (runId, decisionId, action) => invoke('decide', { runId, decisionId, action }),
    startTeamStage: args => invoke('startTeamStage', args),
    cancelTeamStage: args => invoke('cancelTeamStage', args),
    acceptTeamStageOutput: args => invoke('acceptTeamStageOutput', args),
    workflowList: () => invoke('workflowList'),
    workflowGet: workflowId => invoke('workflowGet', { workflowId }),
    workflowValidate: (workflowId, definitionJson) => invoke('workflowValidate', { workflowId, definitionJson }),
    workflowPropose: args => invoke('workflowPropose', args),
    workflowApply: args => invoke('workflowApply', args),
    workflowRevisions: workflowId => invoke('workflowRevisions', { workflowId }),
    workflowRevert: args => invoke('workflowRevert', args),
    workflowRun: args => invoke('workflowRun', args),
    workflowInspect: runId => invoke('workflowInspect', { runId }),
    workflowReport: runId => invoke('workflowReport', { runId })
  }
}
