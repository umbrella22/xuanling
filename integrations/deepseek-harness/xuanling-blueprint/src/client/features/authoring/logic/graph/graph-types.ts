import type {
  BlueprintDefinition,
  GraphEdge,
  GraphNode,
  Presentation,
  PresentationNode,
  PresentationResourceMetadata,
  ResourceRef,
  XY
} from '../../../../../definition/types.ts'
import type { ConnectionVerdict } from '../../../../shared/contracts/view-contract.ts'
import type { ClipboardFragment, ClipboardPasteResult } from './clipboard.ts'

export interface EditorNode {
  definition?: GraphNode
  id: string
  kind: string
  label: string
  x: number
  y: number
  inputs: Record<string, string>
  outputs: Record<string, string>
  presentation?: Omit<PresentationNode, 'x' | 'y'>
}

export interface EditorEdge {
  id: string
  kind: 'data' | 'control'
  from: string
  to: string
  points?: XY[]
}

export interface EditorGroup {
  id: string
  label: string
  nodeIds: string[]
}

export interface CanvasPort {
  nodeId: string
  port: string
  direction: 'in' | 'out'
  type: string
  kind?: 'data' | 'control'
}

export interface HistoryEntry {
  definition?: BlueprintDefinition
  nodes: EditorNode[]
  edges: EditorEdge[]
  groups: EditorGroup[]
  selection: string[]
}

export type AlignmentMode = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y'
export type NodeMeasurements = ReadonlyMap<string, { width: number; height: number }>
export type EditorCommandCode =
  | 'presentation-invalid'
  | 'stale-selection'
  | 'missing-measurement'
  | 'pinned-node'
  | 'invalid-position'
  | 'no-definition'
  | 'transaction-async'
  | 'transaction-history'
  | 'layout-pending'
  | 'clipboard-resource-conflict'
  | 'port-visibility-connected'
  | 'port-hidden'
  | 'layout-collision-unresolved'

export interface GraphDefinitionInput {
  graph: {
    nodes: Array<{ id: string; kind: string; name?: string; inputs?: Record<string, string>; outputs?: Record<string, string> }>
    edges: Array<{ kind: string; from: string; to: string }>
  }
  presentation?: Partial<Presentation>
}

/** Internal collaboration contract. GraphEditor is the sole owner of these fields. */
export interface GraphEditorState {
  nodes: EditorNode[]
  edges: EditorEdge[]
  groups: EditorGroup[]
  selection: Set<string>
  definition: BlueprintDefinition | undefined
  layoutBefore: HistoryEntry | undefined
  undoStack: HistoryEntry[]
  redoStack: HistoryEntry[]
  transactionDepth: number
  emit(): void
  snap(): HistoryEntry
  restore(entry: HistoryEntry): void
  pushHistory(): void
  checkLayout(layout: unknown, ids?: Iterable<string>, edges?: EditorEdge[]): void
  requireNodes(ids: Iterable<string>): EditorNode[]
  movable(nodes: EditorNode[]): void
  measured(nodes: EditorNode[], measurements?: NodeMeasurements): Array<EditorNode & { width: number; height: number }>
  portFor(edge: EditorEdge, side: 'from' | 'to'): CanvasPort
  checkedConnection(from: CanvasPort, to: CanvasPort, ignoreEdgeId?: string, canonicalRestore?: boolean): ConnectionVerdict
  connectionVerdict(from: CanvasPort, to: CanvasPort, ignoreEdgeId?: string): ConnectionVerdict
  transaction<T>(fn: () => T): T
  addNode(node: Omit<EditorNode, 'id'> & { id?: string }): EditorNode
  settleCreatedNodes(newIds: readonly string[], measurements?: NodeMeasurements, displayPositions?: ReadonlyMap<string, XY>, rigid?: boolean): void
  graphNode(node: EditorNode): GraphNode
  exportLayout(): Presentation
  updateResource(refId: string, ref: ResourceRef, metadata?: PresentationResourceMetadata): void
  exportDefinition(): BlueprintDefinition
  createClipboard(nodeIds?: string[]): ClipboardFragment
  pasteClipboard(
    input: unknown,
    position: XY,
    options?: {
      rigid?: boolean
      withIncoming?: boolean
      measurements?: NodeMeasurements
      displayPositions?: ReadonlyMap<string, XY>
    }
  ): ClipboardPasteResult
}

export type GraphEdgeInput = Pick<GraphEdge, 'kind' | 'from' | 'to'>
