/** Browser wire adapter. IDs are opaque identities, never filesystem locators. */
import { BLUEPRINT_INVOCATIONS } from '../typert-descriptors.ts'
import type { PreflightRunValue } from '../host/preflight.ts'
import type {
  AcceptTeamStageOutputArgs,
  CancelTeamStageArgs,
  StartTeamStageArgs,
  TeamStageActionView,
} from '../conversation/contracts.ts'
export type { PreflightRunValue, PreflightCheck } from '../host/preflight.ts'
import type { RunSnapshotView } from './model.ts'

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
export interface RunAdmission { runId: string; semanticRevision: string; state: string; replayed: boolean }
export interface BlueprintArchive { blueprintId: string; closureDigest: string; files: number; archiveSha256: string; archiveBase64: string; requiredBindings: string[] }
export interface BlueprintImport { blueprintId: string; filesWritten: number; closureDigest: string }
export interface RemoteResult { ok: boolean; value?: unknown; error?: { code: string } }
export type RemoteNamespace = Record<string, ((args?: Record<string, unknown>) => Promise<RemoteResult>) | undefined>
export class BlueprintRemoteError extends Error {
  readonly code: string
  constructor(code: string) { super(code); this.name = 'BlueprintRemoteError'; this.code = code }
}
export interface HostLink {
  listDefinitions(): Promise<CatalogValue>
  loadDefinition(blueprintId: string): Promise<DefinitionDocument>
  saveDefinition(blueprintId: string, definitionJson: string, expectedRevision: string | null): Promise<DefinitionDocument>
  validate(definitionJson: string): Promise<{ ok: true; semanticRevision: string }>
  preflightRun(blueprintId: string, expectedRevision: string, inputJson: string): Promise<PreflightRunValue>
  startRun(blueprintId: string, expectedRevision: string, inputJson: string, requestId: string): Promise<RunAdmission>
  inspectRun(runId: string): Promise<RunSnapshotView>
  cancelRun(runId: string): Promise<{ runId: string; state: string }>
  decide(runId: string, decisionId: string, action: 'approve' | 'reject'): Promise<{ runId: string; decisionId: string; state: string; applied: boolean }>
  startTeamStage(args: StartTeamStageArgs): Promise<TeamStageActionView>
  cancelTeamStage(args: CancelTeamStageArgs): Promise<TeamStageActionView>
  acceptTeamStageOutput(args: AcceptTeamStageOutputArgs): Promise<TeamStageActionView>
  exportDefinition?(blueprintId: string): Promise<BlueprintArchive>
  importDefinition?(blueprintId: string, archiveBase64: string): Promise<BlueprintImport>
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
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') throw new BlueprintRemoteError('blueprint/dto-invalid')
    if (!result.ok) throw new BlueprintRemoteError(typeof result.error?.code === 'string' ? result.error.code : 'blueprint/remote-failed')
    if (method === 'preflightRun' || method === 'inspectRun' || method === 'exportDefinition' || method === 'importDefinition'
      || method === 'startTeamStage' || method === 'cancelTeamStage' || method === 'acceptTeamStageOutput') {
      const descriptor = BLUEPRINT_INVOCATIONS.find(item => item.method === method)!
      const parsed = descriptor.result.create().safeParse(result.value)
      if (!parsed.success) throw new BlueprintRemoteError('blueprint/dto-invalid')
      return parsed.data as T
    }
    return result.value as T
  }
  return {
    listDefinitions: () => invoke('listDefinitions'),
    exportDefinition: blueprintId => invoke('exportDefinition', { blueprintId }),
    importDefinition: (blueprintId, archiveBase64) => invoke('importDefinition', { blueprintId, archiveBase64 }),
    loadDefinition: blueprintId => invoke('loadDefinition', { blueprintId }),
    saveDefinition: (blueprintId, definitionJson, expectedRevision) => invoke('saveDefinition', { blueprintId, definitionJson, expectedRevision }),
    validate: definitionJson => invoke('validate', { definitionJson }),
    preflightRun: (blueprintId, expectedRevision, inputJson) => invoke('preflightRun', { blueprintId, expectedRevision, inputJson }),
    startRun: (blueprintId, expectedRevision, inputJson, requestId) => invoke('startRun', { blueprintId, expectedRevision, inputJson, requestId }),
    inspectRun: runId => invoke('inspectRun', { runId }),
    cancelRun: runId => invoke('cancelRun', { runId }),
    decide: (runId, decisionId, action) => invoke('decide', { runId, decisionId, action }),
    startTeamStage: args => invoke('startTeamStage', args),
    cancelTeamStage: args => invoke('cancelTeamStage', args),
    acceptTeamStageOutput: args => invoke('acceptTeamStageOutput', args),
  }
}
