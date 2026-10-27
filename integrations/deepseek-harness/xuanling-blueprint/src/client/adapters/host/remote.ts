import type { BlueprintTemplate, TemplateSummary, PreparationManifest } from '../../../templates/contracts.ts'
import type { AssetRef } from '../../../definition/library-ref.ts'
import type { AssociateDefinitionArgs, AssociationView } from '../../../conversation/association-contracts.ts'
import type { StartSessionRunArgs } from '../../../conversation/contracts.ts'
import type { AgentDocumentSummary } from '../../../host/agent-documents.ts'
/** Browser wire adapter. IDs are opaque identities, never filesystem locators. */
import { BLUEPRINT_INVOCATIONS } from '../../../typert-descriptors.ts'
import type { BlueprintReferenceArgs, BlueprintReferenceView } from '../../../conversation/blueprint-reference-contracts.ts'
import type { NodeMessageArgs, NodeMessageReceipt, NodeSessionView } from '../../../conversation/managed-node-contracts.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PreflightRunValue } from '../../../host/preflight.ts'
import type { LibraryRef, ListBlueprintLibrariesValue } from '../../../definition/library-ref.ts'
export type { LibraryRef, LibrarySummary, ListBlueprintLibrariesValue } from '../../../definition/library-ref.ts'
export interface LibrarySelection {
  library?: LibraryRef
  workspaceId?: string
}
import type {
  AcceptTeamStageOutputArgs,
  CancelTeamStageArgs,
  RunLifecycleActionValue,
  RunQueryArgs,
  RunQueryValue,
  StartTeamStageArgs,
  TeamStageActionView
} from '../../../conversation/contracts.ts'
import type { InspectRunViewArgs, InspectRunViewValue } from '../../../conversation/contracts.ts'
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
  associateDefinition?(args: AssociateDefinitionArgs): Promise<AssociationView>
  startSessionRun?(args: StartSessionRunArgs): Promise<RunAdmission>
  listTemplates?(): Promise<TemplateSummary[]>
  loadTemplate?(templateId: string): Promise<BlueprintTemplate>
  extractTemplate?(args: {
    blueprintId: string
    documentRevision?: string
    requestId: string
    library?: LibraryRef
  }): Promise<{ template: BlueprintTemplate; portable: boolean; residual: string[]; sourceDigest: string; templateDigest: string }>
  saveTemplate?(template: BlueprintTemplate, requestId: string): Promise<{ template: BlueprintTemplate; updatedAt: string }>
  instantiateTemplate?(args: { templateId: string; workspaceId: string; requestId: string; parameters: Record<string, string> }): Promise<{
    status: 'ready' | 'needs_input'
    manifest: PreparationManifest
    instance: { asset: AssetRef; documentRevision: string; documentDigest: string } | null
  }>
  listAgentDocuments?(selection?: LibrarySelection): Promise<{ documents: AgentDocumentSummary[] }>
  importAgentDocument?(args: {
    documentId: string
    blueprintId: string
    expectedRevision: string
    library?: LibraryRef
  }): Promise<{ blueprintId: string; documentRevision: string; resourceId: string; path: string; digest: string }>

  inspectNodeSession?(args: { sessionId: string }): Promise<NodeSessionView>
  messageNode?(args: NodeMessageArgs): Promise<NodeMessageReceipt>
  inspectRunView?(args: InspectRunViewArgs): Promise<InspectRunViewValue>
  inspectBlueprintReference?(args: BlueprintReferenceArgs): Promise<BlueprintReferenceView>
  listBlueprintLibraries?(sessionId?: string): Promise<ListBlueprintLibrariesValue>
  listDefinitions(library?: LibraryRef): Promise<CatalogValue>
  listResources?(selection?: LibrarySelection): Promise<ResourceCatalogValue>
  loadDefinition(blueprintId: string, library?: LibraryRef): Promise<DefinitionDocument>
  createDefinition?(requestId: string, definitionJson: string, library?: LibraryRef): Promise<DefinitionDocument>
  deleteDefinition?(blueprintId: string, expectedRevision: string, requestId: string, library?: LibraryRef): Promise<{ blueprintId: string; deleted: true }>
  saveDefinition(blueprintId: string, definitionJson: string, expectedRevision: string | null, library?: LibraryRef): Promise<DefinitionDocument>
  restoreDefinitionRevision?(blueprintId: string, revision: string, expectedRevision: string, library?: LibraryRef): Promise<DefinitionDocument>
  validate(definitionJson: string): Promise<{ ok: true; semanticRevision: string }>
  preflightRun(blueprintId: string, expectedRevision: string, inputJson: string, selection?: LibrarySelection): Promise<PreflightRunValue>
  startRun(blueprintId: string, expectedRevision: string, inputJson: string, requestId: string, selection?: LibrarySelection): Promise<RunAdmission>
  inspectRun(runId: string, workspaceId?: string): Promise<RunSnapshotView>
  queryRuns(args: RunQueryArgs): Promise<RunQueryValue>
  archiveRun(runId: string, workspaceId?: string): Promise<RunLifecycleActionValue>
  restoreRun(runId: string, workspaceId?: string): Promise<RunLifecycleActionValue>
  cancelRun(runId: string, workspaceId?: string): Promise<{ runId: string; state: string }>
  resolveRecovery?(args: {
    workspaceQuiescent?: boolean
    runId: string
    workspaceId?: string | undefined
    resolution: 'failed' | 'succeeded' | 'cancelled'
    note: string
    expectedSeq: number
  }): Promise<{ runId: string; state: string; seq: number; applied: boolean }>
  decide(
    runId: string,
    decisionId: string,
    action: 'approve' | 'reject',
    workspaceId?: string
  ): Promise<{ runId: string; decisionId: string; state: string; applied: boolean }>
  startTeamStage(args: StartTeamStageArgs): Promise<TeamStageActionView>
  cancelTeamStage(args: CancelTeamStageArgs): Promise<TeamStageActionView>
  acceptTeamStageOutput(args: AcceptTeamStageOutputArgs): Promise<TeamStageActionView>
  exportDefinition?(blueprintId: string, library?: LibraryRef): Promise<BlueprintArchive>
  importDefinition?(blueprintId: string, archiveBase64: string, library?: LibraryRef): Promise<BlueprintImport>
  workflowList?(): Promise<CatalogValue>
  workflowGet?(workflowId: string, library?: LibraryRef): Promise<unknown>
  workflowValidate?(workflowId: string, definitionJson: string): Promise<unknown>
  workflowPropose?(args: Record<string, unknown>): Promise<unknown>
  workflowApply?(args: Record<string, unknown>): Promise<unknown>
  workflowRevisions?(workflowId: string, library?: LibraryRef): Promise<unknown>
  workflowRevert?(args: Record<string, unknown>): Promise<unknown>
  workflowRun?(args: Record<string, unknown>): Promise<unknown>
  workflowInspect?(runId: string): Promise<unknown>
  workflowReport?(runId: string, workspaceId?: string): Promise<unknown>
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
      method === 'inspectBlueprintReference' ||
      method === 'inspectNodeSession' ||
      method === 'messageNode' ||
      method === 'deleteDefinition' ||
      method === 'createDefinition' ||
      method === 'restoreDefinitionRevision' ||
      method === 'preflightRun' ||
      method === 'inspectRun' ||
      method === 'inspectRunView' ||
      method === 'queryRuns' ||
      method === 'archiveRun' ||
      method === 'restoreRun' ||
      method === 'resolveRecovery' ||
      method === 'exportDefinition' ||
      method === 'importDefinition' ||
      method === 'listResources' ||
      method === 'listBlueprintLibraries' ||
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
    inspectNodeSession: args => invoke('inspectNodeSession', args),
    messageNode: args => invoke('messageNode', args),
    inspectBlueprintReference: args => invoke('inspectBlueprintReference', args),
    listBlueprintLibraries: sessionId => invoke('listBlueprintLibraries', sessionId === undefined ? {} : { sessionId }),
    associateDefinition: args => invoke('associateDefinition', args),
    startSessionRun: args => invoke('startSessionRun', args),
    listTemplates: () => invoke('listTemplates'),
    loadTemplate: templateId => invoke('loadTemplate', { templateId }),
    extractTemplate: args => invoke('extractTemplate', args),
    saveTemplate: (template, requestId) => invoke('saveTemplate', { template, requestId }),
    instantiateTemplate: args => invoke('instantiateTemplate', args),
    listAgentDocuments: selection => invoke('listAgentDocuments', selection === undefined ? {} : { ...selection }),
    importAgentDocument: args => invoke('importAgentDocument', args),
    listDefinitions: library => invoke('listDefinitions', library === undefined ? {} : { library }),
    listResources: selection => invoke('listResources', (selection ?? {}) as Record<string, unknown>),
    exportDefinition: (blueprintId, library) => invoke('exportDefinition', library === undefined ? { blueprintId } : { blueprintId, library }),
    importDefinition: (blueprintId, archiveBase64, library) =>
      invoke('importDefinition', library === undefined ? { blueprintId, archiveBase64 } : { blueprintId, archiveBase64, library }),
    loadDefinition: (blueprintId, library) => invoke('loadDefinition', library === undefined ? { blueprintId } : { blueprintId, library }),
    createDefinition: (requestId, definitionJson, library) =>
      invoke('createDefinition', library === undefined ? { requestId, definitionJson } : { requestId, definitionJson, library }),
    deleteDefinition: (blueprintId, expectedRevision, requestId, library) =>
      invoke('deleteDefinition', library === undefined ? { blueprintId, expectedRevision, requestId } : { blueprintId, expectedRevision, requestId, library }),
    saveDefinition: (blueprintId, definitionJson, expectedRevision, library) =>
      invoke(
        'saveDefinition',
        library === undefined ? { blueprintId, definitionJson, expectedRevision } : { blueprintId, definitionJson, expectedRevision, library }
      ),
    restoreDefinitionRevision: (blueprintId, revision, expectedRevision, library) =>
      invoke(
        'restoreDefinitionRevision',
        library === undefined ? { blueprintId, revision, expectedRevision } : { blueprintId, revision, expectedRevision, library }
      ),
    validate: definitionJson => invoke('validate', { definitionJson }),
    preflightRun: (blueprintId, expectedRevision, inputJson, selection) =>
      invoke(
        'preflightRun',
        selection === undefined ? { blueprintId, expectedRevision, inputJson } : { blueprintId, expectedRevision, inputJson, ...selection }
      ),
    startRun: (blueprintId, expectedRevision, inputJson, requestId, selection) =>
      invoke(
        'startRun',
        selection === undefined
          ? { blueprintId, expectedRevision, inputJson, requestId }
          : { blueprintId, expectedRevision, inputJson, requestId, ...selection }
      ),
    inspectRun: (runId, workspaceId) => invoke('inspectRun', workspaceId === undefined ? { runId } : { runId, workspaceId }),
    inspectRunView: args => invoke('inspectRunView', args),
    queryRuns: args => invoke('queryRuns', args),
    archiveRun: (runId, workspaceId) => invoke('archiveRun', workspaceId === undefined ? { runId } : { runId, workspaceId }),
    restoreRun: (runId, workspaceId) => invoke('restoreRun', workspaceId === undefined ? { runId } : { runId, workspaceId }),
    cancelRun: (runId, workspaceId) => invoke('cancelRun', workspaceId === undefined ? { runId } : { runId, workspaceId }),
    resolveRecovery: args => invoke('resolveRecovery', args),
    decide: (runId, decisionId, action, workspaceId) => invoke('decide', { runId, decisionId, action, ...(workspaceId === undefined ? {} : { workspaceId }) }),
    startTeamStage: args => invoke('startTeamStage', args),
    cancelTeamStage: args => invoke('cancelTeamStage', args),
    acceptTeamStageOutput: args => invoke('acceptTeamStageOutput', args),
    workflowList: () => invoke('workflowList'),
    workflowGet: (workflowId, library) => invoke('workflowGet', { workflowId, ...(library === undefined ? {} : { library }) }),
    workflowValidate: (workflowId, definitionJson) => invoke('workflowValidate', { workflowId, definitionJson }),
    workflowPropose: args => invoke('workflowPropose', args),
    workflowApply: args => invoke('workflowApply', args),
    workflowRevisions: (workflowId, library) => invoke('workflowRevisions', { workflowId, ...(library === undefined ? {} : { library }) }),
    workflowRevert: args => invoke('workflowRevert', args),
    workflowRun: args => invoke('workflowRun', args),
    workflowInspect: runId => invoke('workflowInspect', { runId }),
    workflowReport: (runId, workspaceId) => invoke('workflowReport', { runId, ...(workspaceId === undefined ? {} : { workspaceId }) })
  }
}

/** Keep follow-up reads and controls in the same library as admission. The
 * scope is evaluated at dispatch; it is never cached across a library switch. */
export function scopeBlueprintHost(host: HostLink, selected: () => LibraryRef | undefined): HostLink {
  const workspaceId = () => {
    const library = selected()
    return library?.kind === 'workspace' ? library.workspaceId : undefined
  }
  const scoped: Partial<HostLink> = {
    listDefinitions: library => host.listDefinitions(library ?? selected()),
    loadDefinition: (id, library) => host.loadDefinition(id, library ?? selected()),
    queryRuns: args => host.queryRuns({ ...args, ...(workspaceId() === undefined ? {} : { workspaceId: workspaceId()! }) }),
    ...(host.workflowGet === undefined ? {} : { workflowGet: (id: string, library?: LibraryRef) => host.workflowGet!(id, library ?? selected()) }),
    ...(host.workflowRevisions === undefined
      ? {}
      : { workflowRevisions: (id: string, library?: LibraryRef) => host.workflowRevisions!(id, library ?? selected()) }),
    ...(host.workflowReport === undefined ? {} : { workflowReport: (id: string, target?: string) => host.workflowReport!(id, target ?? workspaceId()) }),
    inspectRun: (id, target) => host.inspectRun(id, target ?? workspaceId()),
    cancelRun: (id, target) => host.cancelRun(id, target ?? workspaceId()),
    archiveRun: (id, target) => host.archiveRun(id, target ?? workspaceId()),
    restoreRun: (id, target) => host.restoreRun(id, target ?? workspaceId()),
    decide: (id, decision, action, target) => host.decide(id, decision, action, target ?? workspaceId()),
    ...(host.inspectRunView === undefined
      ? {}
      : {
          inspectRunView: (args: InspectRunViewArgs) =>
            host.inspectRunView!({ ...args, ...(workspaceId() === undefined ? {} : { workspaceId: workspaceId()! }) })
        }),
    ...(host.resolveRecovery === undefined
      ? {}
      : {
          resolveRecovery: (args: Parameters<NonNullable<HostLink['resolveRecovery']>>[0]) =>
            host.resolveRecovery!({ ...args, ...(workspaceId() === undefined ? {} : { workspaceId: workspaceId()! }) })
        }),
    ...(host.inspectBlueprintReference === undefined
      ? {}
      : {
          inspectBlueprintReference: (args: BlueprintReferenceArgs) =>
            host.inspectBlueprintReference!({ ...args, ...(selected() === undefined ? {} : { library: selected()! }) })
        }),
    ...(host.restoreDefinitionRevision === undefined
      ? {}
      : {
          restoreDefinitionRevision: (id: string, revision: string, expected: string, library?: LibraryRef) =>
            host.restoreDefinitionRevision!(id, revision, expected, library ?? selected())
        })
  }
  const bound = new WeakMap<Function, Function>()
  return new Proxy(host, {
    get(target, key) {
      if (Object.hasOwn(scoped, key)) return Reflect.get(scoped, key)
      const member: unknown = Reflect.get(target, key, target)
      if (typeof member !== 'function') return member
      if (!bound.has(member)) bound.set(member, member.bind(target))
      return bound.get(member)
    }
  })
}

export function conversationAuthoringHost(host: HostLink, sessionId: string): HostLink {
  const associate = async (document: DefinitionDocument, library?: LibraryRef) => {
    if (host.associateDefinition === undefined || library === undefined) throw new BlueprintRemoteError('blueprint/capability-unavailable')
    await host.associateDefinition({ sessionId, asset: { library, blueprintId: document.blueprintId }, documentRevision: document.documentRevision })
    return document
  }
  return {
    ...host,
    listBlueprintLibraries: () => host.listBlueprintLibraries!(sessionId),
    loadDefinition: async (id, library) => associate(await host.loadDefinition(id, library), library),
    saveDefinition: async (id, json, revision, library) => associate(await host.saveDefinition(id, json, revision, library), library),
    ...(host.createDefinition === undefined
      ? {}
      : {
          createDefinition: async (request: string, json: string, library?: LibraryRef) =>
            associate(await host.createDefinition!(request, json, library), library)
        }),
    startRun: (blueprintId, expectedRevision, inputJson, requestId, selection) => {
      if (!host.startSessionRun) throw new BlueprintRemoteError('blueprint/capability-unavailable')
      return host.startSessionRun({ blueprintId, expectedRevision, inputJson, requestId, sessionId, ...selection })
    }
  }
}
