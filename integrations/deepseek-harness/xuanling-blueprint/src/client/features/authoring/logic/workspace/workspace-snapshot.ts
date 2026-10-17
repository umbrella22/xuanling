/** Detached data contract for external-store consumers; no live controller objects. */
import type { BlueprintDefinition } from '../../../../../definition/types.ts'
import type { EditorNode, EditorEdge, EditorGroup } from '../graph/graph-editor.ts'
import type { ConnectionState, RunSnapshotView } from '../run/client-model.ts'
import type { CatalogValue, DefinitionDocument, HostResourceCatalogEntry } from '../../../../adapters/host/remote.ts'
import type { WorkspaceNotice } from '../../../../shared/contracts/view-contract.ts'
import type { WorkspaceViewBinding } from '../../../../shared/contracts/view-contract.ts'
import type { WorkspacePreflight } from './workspace-controller.ts'

export type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T
export interface WorkspaceSnapshotData {
  binding: WorkspaceViewBinding
  capabilities: { hostAvailable: boolean; canImport: boolean; canExport: boolean; canCreate: boolean; canPreflight: boolean }
  blueprintId: string | null
  isNewDraft: boolean
  document: Pick<DefinitionDocument, 'blueprintId' | 'documentRevision' | 'semanticRevision' | 'layoutRevision'> | null
  definition: BlueprintDefinition | null
  editor: { nodes: EditorNode[]; edges: EditorEdge[]; groups: EditorGroup[]; selection: string[]; canUndo: boolean; canRedo: boolean }
  catalog: CatalogValue['definitions']
  resources: { state: 'loading' | 'current' | 'unavailable'; entries: HostResourceCatalogEntry[] }
  inputJson: string
  notice: WorkspaceNotice
  busy: boolean
  dirty: boolean
  needsNavigationConfirmation: boolean
  preflight: WorkspacePreflight | null
  run: { runId: string | null; connectionState: ConnectionState; snapshot: RunSnapshotView | null; overlayEligible: boolean }
}
export type WorkspaceSnapshot = DeepReadonly<WorkspaceSnapshotData>

function equal(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length &&
    keys.every(key => Object.hasOwn(b, key) && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
  )
}
function freeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

/** Reuse equal published segments, while never freezing caller-owned values. */
export function snapshotValue<T>(value: T, previous?: DeepReadonly<T>): DeepReadonly<T> {
  return previous !== undefined && equal(value, previous) ? previous : freeze(structuredClone(value))
}
