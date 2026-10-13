/** Client-only display vocabulary. Keys/params never enter definitions or wire commands. */
export interface ViewMessageParams {
  'status.loading': undefined
  'status.hostUnavailable': undefined
  'status.chooseBlueprint': undefined
  'status.noDefinitions': undefined
  'status.loadingDocument': undefined
  'status.loaded': undefined
  'status.newDocument': undefined
  'status.newDraft': undefined
  'status.draftRestored': undefined
  'status.draftStale': undefined
  'status.draftInvalid': undefined
  'status.saved': undefined
  'status.deleted': undefined
  'status.runAdmitted': { state: string }
  'status.recentRunUnavailable': undefined
  'status.draftUnavailable': undefined
  'status.error': { code: string }
  'status.invalidRunInput': { code: string; issue: 'invalid-input-json' }
  'node.input.title': undefined
  'node.input.description': undefined
  'node.agentTask.title': undefined
  'node.agentTask.description': undefined
  'node.humanDecision.title': undefined
  'node.humanDecision.description': undefined
  'node.output.title': undefined
  'node.output.description': undefined
  'node.condition.title': undefined
  'node.condition.description': undefined
  'node.join.title': undefined
  'node.join.description': undefined
  'node.defaultTitle': { title: string; index: number }
  'node.importedKind': { kind: string }
  'resource.availabilityUnchecked': undefined
  'connection.directionMismatch': undefined
  'connection.selfLoop': undefined
  'connection.edgeKindMismatch': undefined
  'connection.typeConflict': { fromType: string; toType: string }
  'connection.unknownNode': undefined
  'connection.undeclaredPort': undefined
  'connection.dataCycle': undefined
  'connection.duplicateEdge': undefined
}
export type ViewMessageKey = keyof ViewMessageParams
export type ViewMessage<K extends ViewMessageKey = ViewMessageKey> = {
  [P in K]: ViewMessageParams[P] extends undefined
    ? { readonly key: P }
    : { readonly key: P; readonly params: Readonly<ViewMessageParams[P]> }
}[K]
export type WorkspaceNotice = ViewMessage<Extract<ViewMessageKey, `status.${string}`>>
/** A renderer adapter to the host translator, not a locale service or dictionary. */
export type ViewTranslator = (key: ViewMessageKey, params?: Readonly<Record<string, string | number>>) => string

export type ConnectionVerdict =
  | { ok: true }
  | { ok: false; reason: 'direction-mismatch' | 'self-loop' | 'edge-kind-mismatch' | 'unknown-node' | 'undeclared-port' | 'data-cycle' | 'duplicate-edge' }
  | { ok: false; reason: 'type-conflict'; params: { fromType: string; toType: string } }

/** Preserve the reason code separately from its display parameters. */
export function connectionNotice(verdict: ConnectionVerdict): ViewMessage | null {
  if (verdict.ok) return null
  switch (verdict.reason) {
    case 'direction-mismatch': return { key: 'connection.directionMismatch' }
    case 'self-loop': return { key: 'connection.selfLoop' }
    case 'edge-kind-mismatch': return { key: 'connection.edgeKindMismatch' }
    case 'type-conflict': return { key: 'connection.typeConflict', params: verdict.params }
    case 'unknown-node': return { key: 'connection.unknownNode' }
    case 'undeclared-port': return { key: 'connection.undeclaredPort' }
    case 'data-cycle': return { key: 'connection.dataCycle' }
    case 'duplicate-edge': return { key: 'connection.duplicateEdge' }
  }
}
