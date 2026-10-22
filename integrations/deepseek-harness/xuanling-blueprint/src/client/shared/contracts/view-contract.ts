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
  'node.blueprintCall.title': undefined
  'node.blueprintCall.description': undefined
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
  'layout.apply': undefined
  'layout.unresolved': undefined
  'layout.locate': undefined
  'layout.unpin': undefined
  'port.visibilityHelp': undefined
  'port.visibility': undefined
  'port.visibility.control': undefined
  'port.visibility.inputs': undefined
  'port.visibility.outputs': undefined
  'port.connectedVisible': undefined
  'connection.portHidden': undefined
  'connection.portVisibilityConnected': { edgeCount: number }
}
export type ViewMessageKey = keyof ViewMessageParams
export type ViewMessage<K extends ViewMessageKey = ViewMessageKey> = {
  [P in K]: ViewMessageParams[P] extends undefined ? { readonly key: P } : { readonly key: P; readonly params: Readonly<ViewMessageParams[P]> }
}[K]
export type WorkspaceNotice = ViewMessage<Extract<ViewMessageKey, `status.${string}`>>
/** A renderer adapter to the host translator, not a locale service or dictionary. */
export type ViewTranslator = (key: ViewMessageKey, params?: Readonly<Record<string, string | number>>) => string

/** Immutable identity captured by a view before it emits an intent. */
export interface WorkspaceViewBinding {
  readonly instanceId: string
  readonly blueprintId: string | null
  readonly editorEpoch: number
  readonly documentRevision: string | null
}

export function isWorkspaceViewBinding(value: unknown): value is WorkspaceViewBinding {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.instanceId === 'string' &&
    item.instanceId.length > 0 &&
    (typeof item.blueprintId === 'string' || item.blueprintId === null) &&
    Number.isInteger(item.editorEpoch) &&
    (item.editorEpoch as number) >= 0 &&
    (typeof item.documentRevision === 'string' || item.documentRevision === null)
  )
}

export function sameWorkspaceViewBinding(a: unknown, b: unknown): boolean {
  return (
    isWorkspaceViewBinding(a) &&
    isWorkspaceViewBinding(b) &&
    a.instanceId === b.instanceId &&
    a.blueprintId === b.blueprintId &&
    a.editorEpoch === b.editorEpoch &&
    a.documentRevision === b.documentRevision
  )
}

export interface SelectOptionState {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}
export interface SelectViewState {
  readonly binding: WorkspaceViewBinding
  readonly value: string
  readonly disabled: boolean
  readonly options: readonly SelectOptionState[]
}
export interface SelectChangeIntent {
  readonly type: 'select-change'
  readonly binding: WorkspaceViewBinding
  readonly value: string
}
export function acceptsSelectIntent(state: SelectViewState, intent: unknown): intent is SelectChangeIntent {
  if (!intent || typeof intent !== 'object') return false
  const item = intent as Record<string, unknown>
  if (item.type !== 'select-change' || !sameWorkspaceViewBinding(state.binding, item.binding) || state.disabled || typeof item.value !== 'string') return false
  const option = state.options.find(candidate => candidate.value === item.value)
  return !!option && option.disabled !== true
}

export interface ConfirmationViewState {
  readonly action: ConfirmationAction
  readonly binding: WorkspaceViewBinding
  readonly title: string
  readonly description?: string
  readonly cancelLabel: string
  readonly confirmLabel: string
  readonly busy?: boolean
}
export type ConfirmationAction =
  | { readonly type: 'load-blueprint'; readonly blueprintId: string }
  | { readonly type: 'new-draft'; readonly name?: string }
  | { readonly type: 'delete-current' }
export interface ConfirmationIntent {
  readonly type: 'confirmation'
  readonly binding: WorkspaceViewBinding
  readonly action: ConfirmationAction
  readonly decision: 'confirm' | 'cancel'
}
export function acceptsConfirmationIntent(state: ConfirmationViewState, intent: unknown): intent is ConfirmationIntent {
  if (!intent || typeof intent !== 'object') return false
  const item = intent as Record<string, unknown>
  if (item.type !== 'confirmation' || !sameWorkspaceViewBinding(state.binding, item.binding) || state.busy === true) return false
  if (item.decision !== 'confirm' && item.decision !== 'cancel') return false
  const action = item.action
  if (!action || typeof action !== 'object' || typeof (action as Record<string, unknown>).type !== 'string') return false
  const type = (action as Record<string, unknown>).type
  const requested = action as Record<string, unknown>
  if (type !== state.action.type) return false
  if (type === 'delete-current') return true
  if (type === 'new-draft')
    return (requested.name === undefined || typeof requested.name === 'string') && state.action.type === 'new-draft' && requested.name === state.action.name
  return (
    type === 'load-blueprint' &&
    typeof requested.blueprintId === 'string' &&
    state.action.type === 'load-blueprint' &&
    requested.blueprintId === state.action.blueprintId
  )
}

export type OverlayViewState = {
  readonly commands?: readonly { readonly command: string; readonly enabled: boolean }[]
  readonly nodeKinds?: readonly string[]
  readonly importTargets?: readonly { readonly blueprintId: string; readonly nonempty: boolean }[]
  readonly importConfirmedId?: string
  readonly binding: WorkspaceViewBinding
  readonly kind: 'context-menu' | 'node-search' | 'rename' | 'shortcuts' | 'import' | 'more-menu'
  readonly disabled?: boolean
}
export type OverlayIntent =
  | { readonly type: 'overlay-close'; readonly binding: WorkspaceViewBinding }
  | { readonly type: 'overlay-command'; readonly binding: WorkspaceViewBinding; readonly command: string }
  | { readonly type: 'overlay-add-node'; readonly binding: WorkspaceViewBinding; readonly nodeKind: string }
  | { readonly type: 'overlay-rename'; readonly binding: WorkspaceViewBinding; readonly value: string }
  | {
      readonly type: 'overlay-import-ready'
      readonly binding: WorkspaceViewBinding
      readonly blueprintId: string
      readonly archiveBase64: string
      readonly confirmedId?: string
    }
export function acceptsOverlayIntent(state: OverlayViewState, intent: unknown): intent is OverlayIntent {
  if (!intent || typeof intent !== 'object') return false
  const item = intent as Record<string, unknown>
  if (!sameWorkspaceViewBinding(state.binding, item.binding) || typeof item.type !== 'string') return false
  if (item.type === 'overlay-close') return true
  if (state.disabled === true) return false
  if (item.type === 'overlay-command')
    return (
      (state.kind === 'context-menu' || state.kind === 'more-menu') && !!state.commands?.some(command => command.command === item.command && command.enabled)
    )
  if (item.type === 'overlay-add-node') return state.kind === 'node-search' && typeof item.nodeKind === 'string' && !!state.nodeKinds?.includes(item.nodeKind)
  return item.type === 'overlay-rename'
    ? state.kind === 'rename' && typeof item.value === 'string'
    : item.type === 'overlay-import-ready' &&
        state.kind === 'import' &&
        typeof item.blueprintId === 'string' &&
        !!state.importTargets?.some(
          target =>
            target.blueprintId === item.blueprintId &&
            !target.nonempty &&
            item.confirmedId === target.blueprintId &&
            state.importConfirmedId === target.blueprintId
        ) &&
        typeof item.archiveBase64 === 'string' &&
        item.archiveBase64.length > 0
}

export type JsonField = 'inputs' | 'outputs' | 'options'
export interface JsonViewNotice {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}
export interface JsonViewState {
  readonly binding: WorkspaceViewBinding
  readonly nodeId: string
  readonly field: JsonField
  readonly buffer: string
  readonly disabled: boolean
  readonly notice: JsonViewNotice | null
}
export type JsonIntent =
  | { readonly type: 'json-buffer-change'; readonly binding: WorkspaceViewBinding; readonly nodeId: string; readonly field: JsonField; readonly text: string }
  | { readonly type: 'json-commit'; readonly binding: WorkspaceViewBinding; readonly nodeId: string; readonly field: JsonField }
  | { readonly type: 'json-cancel'; readonly binding: WorkspaceViewBinding; readonly nodeId: string; readonly field: JsonField }
export function acceptsJsonIntent(state: JsonViewState, intent: unknown): intent is JsonIntent {
  if (!intent || typeof intent !== 'object' || state.disabled) return false
  const item = intent as Record<string, unknown>
  return (
    (item.type === 'json-buffer-change' || item.type === 'json-commit' || item.type === 'json-cancel') &&
    sameWorkspaceViewBinding(state.binding, item.binding) &&
    item.nodeId === state.nodeId &&
    item.field === state.field &&
    (item.type !== 'json-buffer-change' || typeof item.text === 'string')
  )
}

export type ConnectionVerdict =
  | { ok: true }
  | {
      ok: false
      reason: 'direction-mismatch' | 'self-loop' | 'edge-kind-mismatch' | 'unknown-node' | 'undeclared-port' | 'data-cycle' | 'duplicate-edge' | 'port-hidden'
    }
  | { ok: false; reason: 'type-conflict'; params: { fromType: string; toType: string } }

/** Preserve the reason code separately from its display parameters. */
export function connectionNotice(verdict: ConnectionVerdict): ViewMessage | null {
  if (verdict.ok) return null
  switch (verdict.reason) {
    case 'direction-mismatch':
      return { key: 'connection.directionMismatch' }
    case 'self-loop':
      return { key: 'connection.selfLoop' }
    case 'edge-kind-mismatch':
      return { key: 'connection.edgeKindMismatch' }
    case 'type-conflict':
      return { key: 'connection.typeConflict', params: verdict.params }
    case 'unknown-node':
      return { key: 'connection.unknownNode' }
    case 'undeclared-port':
      return { key: 'connection.undeclaredPort' }
    case 'data-cycle':
      return { key: 'connection.dataCycle' }
    case 'port-hidden':
      return { key: 'connection.portHidden' }
    case 'duplicate-edge':
      return { key: 'connection.duplicateEdge' }
  }
}
