/**
 * Canvas graph editor (C-12/C-10, W6.2): local editing model behind the UI.
 * Pure data + commands — the React layer only renders and forwards gestures.
 * Semantic edits build definition revisions (host validates on save); layout
 * edits touch presentation ONLY and never a semantic revision or a running
 * node. Undo/redo is bounded; a stale save is refused by expectedRevision on
 * the host side, never by silently overwriting.
 */

import type {
  BlueprintDefinition,
  GraphNode,
  Presentation,
  PresentationNode,
  PresentationResourceMetadata,
  ResourceRef,
  XY
} from '../../../../../definition/types.ts'
import type { ConnectionVerdict } from '../../../../shared/contracts/view-contract.ts'
import { ClipboardError, validatePresentation, validateResourceReferences } from './clipboard.ts'
import type { ClipboardFragment, ClipboardPasteResult } from './clipboard.ts'
import type {
  AlignmentMode,
  CanvasPort,
  EditorEdge,
  EditorGroup,
  EditorNode,
  GraphDefinitionInput,
  GraphEditorState,
  HistoryEntry,
  NodeMeasurements
} from './graph-types.ts'
import { checkConnection, edgeEndpoints, EditorCommandError, nextEdgeId, nextGroupId, nextNodeId, portForEdge } from './graph-commands.ts'
import { HISTORY_CAP, commitTransaction, pushHistory, redoGraph, restoreGraph, snapshotGraph, undoGraph } from './graph-history.ts'
import { alignNodes, applyCollisionProjection, defaultLayoutProjection, distributeNodes, placementRects, requireMeasurements } from './graph-layout.ts'
import { createClipboardFragment, pasteClipboardFragment } from './graph-clipboard.ts'
import { exportGraphDefinition, exportGraphLayout, graphNodeFromEditorNode, importGraphDefinition, importGraphLayout } from './graph-serialization.ts'
import { connectedPortEdges } from './port-visibility.ts'
import { projectLayoutCollisions } from './layout-collisions.ts'

export type { AlignmentMode, CanvasPort, EditorEdge, EditorGroup, EditorNode, EditorCommandCode, HistoryEntry, NodeMeasurements } from './graph-types.ts'
export { canConnect, editorNodeDisplayTitle, EditorCommandError } from './graph-commands.ts'

export class GraphEditor {
  nodes: EditorNode[] = []
  edges: EditorEdge[] = []
  groups: EditorGroup[] = []
  selection = new Set<string>()
  private definition: BlueprintDefinition | undefined
  private layoutBefore: HistoryEntry | undefined
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  private transactionDepth = 0
  private listeners = new Set<() => void>()

  constructor(nodes: EditorNode[] = [], edges: EditorEdge[] = [], groups: EditorGroup[] = []) {
    this.nodes = nodes
    this.edges = edges
    this.groups = groups
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    if (this.transactionDepth) return
    for (const listener of this.listeners) listener()
  }

  /** Selection is a transient canvas projection, never a history entry. */
  setSelection(nodeIds: Iterable<string>): void {
    const next = new Set(nodeIds)
    if (next.size === this.selection.size && [...next].every(id => this.selection.has(id))) return
    this.selection = next
    this.emit()
  }

  private snap(): HistoryEntry {
    return snapshotGraph(this as unknown as GraphEditorState)
  }

  private pushHistory(): void {
    pushHistory(this as unknown as GraphEditorState)
  }

  private graphNode(node: EditorNode): GraphNode {
    return graphNodeFromEditorNode(node)
  }

  private restore(entry: HistoryEntry): void {
    restoreGraph(this as unknown as GraphEditorState, entry)
  }

  private checkLayout(layout: unknown, ids: Iterable<string> = this.nodes.map(n => n.id), edges = this.edges): void {
    try {
      validatePresentation(layout, ids, edges, Object.keys(this.definition?.resources ?? {}))
    } catch (error) {
      const message = error instanceof ClipboardError && /\/(x|y)$/.test(error.pointer) ? 'Invalid layout coordinates' : 'presentation-invalid'
      throw new EditorCommandError('presentation-invalid', message)
    }
  }

  private portFor(edge: EditorEdge, side: 'from' | 'to'): CanvasPort {
    return portForEdge(this, edge, side)
  }

  /** Synchronous savepoints; only outer commit publishes or adds history.
   * A successful commit absorbs pending pointer layout into one history entry;
   * failure restores the current draft and leaves that gesture pending. */
  transaction<T>(fn: () => T): T {
    if (Object.prototype.toString.call(fn) === '[object AsyncFunction]') throw new EditorCommandError('transaction-async')
    const pending = this.layoutBefore
    const before = this.snap()
    const undo = structuredClone(this.undoStack)
    const redo = structuredClone(this.redoStack)
    const outer = this.transactionDepth === 0
    this.transactionDepth++
    let value: T
    try {
      value = fn()
      if (value && typeof (value as { then?: unknown }).then === 'function') throw new EditorCommandError('transaction-async')
      if (outer) {
        this.checkLayout(this.exportLayout())
      }
    } catch (error) {
      this.restore(before)
      this.undoStack = undo
      this.redoStack = redo
      this.layoutBefore = pending
      this.transactionDepth--
      throw error
    }
    this.transactionDepth--
    if (outer) {
      const after = this.snap()
      commitTransaction(this as unknown as GraphEditorState, before, pending, after)
    }
    return value
  }

  cancelLayout(): void {
    if (this.transactionDepth) throw new EditorCommandError('layout-pending')
    const before = this.layoutBefore
    if (!before) return
    this.layoutBefore = undefined
    this.restore(before)
    this.emit()
  }

  patchPresentation(nodeIds: string[], patch: Partial<Omit<PresentationNode, 'x' | 'y'>>): void {
    // Reject coordinates/unknown fields even when JS bypasses the static type.
    if (
      !patch ||
      typeof patch !== 'object' ||
      Array.isArray(patch) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(patch)) ||
      Object.keys(patch).some(k => !['title', 'collapsed', 'pinned', 'width', 'height', 'color', 'ports'].includes(k))
    )
      throw new EditorCommandError('presentation-invalid')
    const targets = this.requireNodes(nodeIds)
    // Validate the submitted ports object before merging; null/arrays must
    // not disappear through object spread into a seemingly valid preference.
    if (Object.hasOwn(patch, 'ports')) this.checkLayout({ nodes: Object.fromEntries(targets.map(n => [n.id, { x: n.x, y: n.y, ports: patch.ports }])) })
    const { ports: _ports, ...otherAttrs } = patch
    const attrs = (n: EditorNode) => ({
      ...n.presentation,
      ...otherAttrs,
      ...(patch.ports && Object.keys(patch.ports).length ? { ports: { ...n.presentation?.ports, ...patch.ports } } : {})
    })
    const proposed = Object.fromEntries(targets.map(n => [n.id, { ...attrs(n), x: n.x, y: n.y }]))
    this.checkLayout({ nodes: proposed })
    const affected = new Set<EditorEdge>()
    for (const node of targets)
      for (const side of ['control', 'inputs', 'outputs'] as const) {
        if (patch.ports?.[side] !== false) continue
        for (const edge of this.edges) if (connectedPortEdges(node.id, side, [edge])) affected.add(edge)
      }
    if (affected.size) throw new EditorCommandError('port-visibility-connected', 'port-visibility-connected', { edgeCount: affected.size })
    this.transaction(() => {
      for (const n of targets) n.presentation = structuredClone(attrs(n))
    })
  }

  collisionProjection(measurements: NodeMeasurements = new Map(), rigidGroups: readonly (readonly string[])[] = []) {
    return applyCollisionProjection(this, measurements, rigidGroups)
  }
  applyCollisionLayout(measurements: NodeMeasurements = new Map(), rigidGroups: readonly (readonly string[])[] = []): void {
    if (
      this.nodes.some(node => {
        const measured = measurements.get(node.id)
        return !measured || !Number.isFinite(measured.width) || !Number.isFinite(measured.height) || measured.width <= 0 || measured.height <= 0
      })
    )
      throw new EditorCommandError('missing-measurement')
    const projection = this.collisionProjection(measurements, rigidGroups)
    if (!projection.ok) throw new EditorCommandError('layout-collision-unresolved', projection.nodeIds.join(', '))
    if (!projection.changed) return
    this.transaction(() => {
      for (const [id, position] of projection.positions) this.moveNode(id, position.x, position.y)
    })
  }

  /** Placement templates may correct a newly-created node before it is measurable. */
  settleCreatedNodes(
    newIds: readonly string[],
    measurements: NodeMeasurements = new Map(),
    displayPositions: ReadonlyMap<string, XY> = new Map(),
    rigid = false
  ): void {
    const created = new Set(newIds)
    if (this.nodes.some(node => !created.has(node.id) && !measurements.has(node.id))) return
    const projection = projectLayoutCollisions(placementRects(this.nodes, this.edges, newIds, measurements, displayPositions), rigid ? [newIds] : [])
    if (!projection.ok) throw new EditorCommandError('layout-collision-unresolved', projection.nodeIds.join(', '))
    for (const id of newIds) {
      const position = projection.positions.get(id)!
      this.moveNode(id, position.x, position.y)
    }
  }

  private requireNodes(ids: Iterable<string>): EditorNode[] {
    const result = [...new Set(ids)].map(id => this.nodes.find(n => n.id === id))
    if (result.some(n => !n)) throw new EditorCommandError('stale-selection')
    return result as EditorNode[]
  }

  private movable(nodes: EditorNode[]): void {
    if (nodes.some(n => n.presentation?.pinned)) throw new EditorCommandError('pinned-node')
  }

  renameGroup(id: string, label: string): void {
    const group = this.groups.find(g => g.id === id)
    if (!group) throw new EditorCommandError('stale-selection')
    if (typeof label !== 'string') throw new EditorCommandError('presentation-invalid')
    this.transaction(() => {
      group.label = label
    })
  }

  renameDefinition(name: string): void {
    if (!this.definition) throw new EditorCommandError('no-definition')
    if (this.definition.name === name) return
    this.transaction(() => {
      this.definition!.name = name
    })
  }

  moveGroup(id: string, dx: number, dy: number): void {
    const group = this.groups.find(g => g.id === id)
    if (!group) throw new EditorCommandError('stale-selection')
    const nodes = this.requireNodes(group.nodeIds)
    this.movable(nodes)
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new EditorCommandError('invalid-position')
    this.transaction(() => {
      for (const n of nodes) this.moveNode(n.id, n.x + dx, n.y + dy)
    })
  }

  private measured(nodes: EditorNode[], measurements?: NodeMeasurements): Array<EditorNode & { width: number; height: number }> {
    return requireMeasurements(nodes, measurements)
  }

  alignSelection(mode: AlignmentMode, measurements?: NodeMeasurements): void {
    if (!['left', 'right', 'top', 'bottom', 'center-x', 'center-y'].includes(mode)) throw new EditorCommandError('invalid-position')
    const selected = this.requireNodes(this.selection)
    if (selected.length < 2) return
    this.movable(selected)
    // Leading edges need positions only. Extents/centres need measured sizes.
    const nodes = mode === 'left' || mode === 'top' ? selected.map(n => ({ ...n, width: 0, height: 0 })) : this.measured(selected, measurements)
    const positions = alignNodes(nodes, mode)
    this.transaction(() => {
      for (const n of nodes) this.moveNode(n.id, positions.get(n.id)!.x, positions.get(n.id)!.y)
    })
  }

  distributeSelection(axis: 'x' | 'y', measurements?: NodeMeasurements): void {
    if (axis !== 'x' && axis !== 'y') throw new EditorCommandError('invalid-position')
    const selected = this.requireNodes(this.selection)
    if (selected.length < 3) return
    this.movable(selected)
    const nodes = this.measured(selected, measurements)
    const positions = distributeNodes(nodes, axis)
    this.transaction(() => {
      for (const node of nodes) {
        const position = positions.get(node.id)!
        this.moveNode(node.id, position.x, position.y)
      }
    })
  }

  reconnect(id: string, from: CanvasPort, to: CanvasPort): ConnectionVerdict & { edge?: EditorEdge } {
    const edge = this.edges.find(e => e.id === id)
    if (!edge) return { ok: false, reason: 'unknown-node' }
    const verdict = this.connectionVerdict(from, to, id)
    if (!verdict.ok) return verdict
    const { kind, source, target } = edgeEndpoints(this, from, to)
    this.transaction(() => {
      edge.kind = kind
      edge.from = source
      edge.to = target
    })
    return { ok: true, edge }
  }

  createClipboard(nodeIds: string[] = [...this.selection]): ClipboardFragment {
    return createClipboardFragment(this as unknown as GraphEditorState, nodeIds)
  }

  pasteClipboard(
    input: unknown,
    position: XY,
    options: {
      rigid?: boolean
      withIncoming?: boolean
      measurements?: NodeMeasurements | undefined
      displayPositions?: ReadonlyMap<string, XY> | undefined
    } = {}
  ): ClipboardPasteResult {
    return pasteClipboardFragment(this as unknown as GraphEditorState, input, position, options)
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo(): boolean {
    return undoGraph(this as unknown as GraphEditorState)
  }

  redo(): boolean {
    return redoGraph(this as unknown as GraphEditorState)
  }

  addNode(node: Omit<EditorNode, 'id'> & { id?: string }): EditorNode {
    const candidate = { ...node, id: node.id ?? nextNodeId() }
    if (this.nodes.some(n => n.id === candidate.id)) throw new EditorCommandError('stale-selection')
    try {
      validateResourceReferences([this.graphNode(candidate)], this.definition?.resources ?? {})
    } catch {
      throw new EditorCommandError('clipboard-resource-conflict')
    }
    this.checkLayout({ nodes: { [candidate.id]: { ...candidate.presentation, x: candidate.x, y: candidate.y } } }, [candidate.id], [])
    this.pushHistory()
    const created: EditorNode = structuredClone(candidate)
    if (created.definition) created.definition.id = created.id
    this.nodes.push(created)
    this.emit()
    return created
  }

  removeSelected(): number {
    if (this.selection.size === 0) return 0
    this.pushHistory()
    const doomed = new Set(this.selection)
    this.nodes = this.nodes.filter(n => !doomed.has(n.id))
    this.edges = this.edges.filter(e => !doomed.has(e.from.split(/[.@]/)[0]!) && !doomed.has(e.to.split(/[.@]/)[0]!))
    this.groups = this.groups.map(g => ({ ...g, nodeIds: g.nodeIds.filter(id => !doomed.has(id)) })).filter(g => g.nodeIds.length > 0)
    const removed = doomed.size
    this.selection.clear()
    this.emit()
    return removed
  }

  moveNode(nodeId: string, x: number, y: number): void {
    const node = this.nodes.find(n => n.id === nodeId)
    if (node === undefined) return
    if (node.presentation?.pinned) return
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new EditorCommandError('invalid-position')
    if (node.x === x && node.y === y) return
    // Layout-only: no history noise per pointer move; the caller snapshots
    // once on gesture end via `commitLayout`.
    if (!this.transactionDepth) this.layoutBefore ??= this.snap()
    node.x = x
    node.y = y
    this.emit()
  }

  beginLayout(): void {
    if (this.transactionDepth) throw new EditorCommandError('layout-pending')
    this.layoutBefore ??= this.snap()
  }

  commitLayout(): void {
    if (this.transactionDepth) throw new EditorCommandError('layout-pending')
    this.checkLayout(this.exportLayout())
    const before = this.layoutBefore
    this.layoutBefore = undefined
    if (before && JSON.stringify(before.nodes) !== JSON.stringify(this.nodes)) {
      this.undoStack.push(before)
      if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift()
      this.redoStack = []
    }
    this.emit()
  }

  private checkedConnection(from: CanvasPort, to: CanvasPort, ignoreEdgeId?: string, canonicalRestore = false): ConnectionVerdict {
    return checkConnection(this as unknown as GraphEditorState, from, to, ignoreEdgeId, canonicalRestore)
  }

  connectionVerdict(from: CanvasPort, to: CanvasPort, ignoreEdgeId?: string): ConnectionVerdict {
    return this.checkedConnection(from, to, ignoreEdgeId)
  }

  connect(from: CanvasPort, to: CanvasPort): ConnectionVerdict & { edge?: EditorEdge } {
    const verdict = this.connectionVerdict(from, to)
    if (!verdict.ok) return verdict
    const kind = from.kind ?? 'data'
    const source =
      kind === 'control'
        ? `${from.nodeId}${this.nodes.find(n => n.id === from.nodeId)?.definition?.branches?.length ? `@${from.port}` : ''}`
        : `${from.nodeId}.${from.port}`
    const target = kind === 'control' ? to.nodeId : `${to.nodeId}.${to.port}`
    this.pushHistory()
    const edge: EditorEdge = {
      id: nextEdgeId(),
      kind,
      from: source,
      to: target
    }
    this.edges.push(edge)
    this.emit()
    return { ok: true, edge }
  }

  removeEdge(edgeId: string): boolean {
    const index = this.edges.findIndex(e => e.id === edgeId)
    if (index < 0) return false
    this.pushHistory()
    this.edges.splice(index, 1)
    this.emit()
    return true
  }

  toggleSelect(nodeId: string, additive: boolean): void {
    if (!additive) this.selection.clear()
    if (additive && this.selection.has(nodeId)) this.selection.delete(nodeId)
    else this.selection.add(nodeId)
    this.emit()
  }

  groupSelection(label: string): EditorGroup | null {
    if (this.selection.size === 0) return null
    this.requireNodes(this.selection)
    if (typeof label !== 'string') throw new EditorCommandError('presentation-invalid')
    this.pushHistory()
    const group: EditorGroup = { id: nextGroupId(), label, nodeIds: [...this.selection] }
    this.groups.push(group)
    this.emit()
    return group
  }

  ungroup(groupIdValue: string): boolean {
    const index = this.groups.findIndex(g => g.id === groupIdValue)
    if (index < 0) return false
    this.pushHistory()
    this.groups.splice(index, 1)
    this.emit()
    return true
  }

  /** Presentation-only export; edge routing binds the stable logical triple. */
  exportLayout(): Presentation {
    const layout = exportGraphLayout(this as unknown as GraphEditorState)
    this.checkLayout(layout)
    return layout
  }

  importLayout(layout: Partial<Presentation>): void {
    importGraphLayout(this as unknown as GraphEditorState, layout)
  }

  updateNode(nodeId: string, patch: Partial<GraphNode>): void {
    const node = this.nodes.find(n => n.id === nodeId)
    if (!node) return
    const candidate = { ...node, definition: { ...node.definition, id: node.id, kind: node.kind as GraphNode['kind'], ...structuredClone(patch) } }
    if (candidate.definition.id !== node.id || candidate.definition.kind !== node.kind) throw new EditorCommandError('stale-selection')
    this.pushHistory()
    node.definition = { ...node.definition, id: node.id, kind: node.kind as GraphNode['kind'], ...structuredClone(patch) }
    node.inputs = node.definition.inputs ?? {}
    node.outputs = node.definition.outputs ?? {}
    this.emit()
  }

  /** Update an executable reference and its optional display metadata as one
   * undoable transaction. Presentation metadata never enters ResourceRef. */
  updateResource(refId: string, ref: ResourceRef, metadata?: PresentationResourceMetadata): void {
    if (!this.definition) return
    this.transaction(() => {
      this.definition!.resources[refId] = structuredClone(ref)
      if (metadata !== undefined) {
        const presentation = this.definition!.presentation
        const resources = presentation?.resources ? structuredClone(presentation.resources) : {}
        if (Object.keys(metadata).length === 0) delete resources[refId]
        else resources[refId] = structuredClone(metadata)
        if (Object.keys(resources).length) {
          // A metadata edit needs a valid presentation container, but an empty
          // draft must not manufacture one when the definition had no
          // presentation state at all.
          this.definition!.presentation = { ...(presentation ?? { nodes: {} }), resources }
        } else if (presentation?.resources) {
          const { resources: _removed, ...withoutResources } = presentation
          if (Object.keys(withoutResources).length) this.definition!.presentation = withoutResources
          else delete this.definition!.presentation
        }
      }
    })
  }

  exportDefinition(): BlueprintDefinition {
    if (!this.definition) throw new EditorCommandError('no-definition')
    return exportGraphDefinition(this as unknown as GraphEditorState)
  }

  deleteItems(nodeIds: string[], edgeIds: string[]): void {
    if (!nodeIds.length && !edgeIds.length) return
    this.pushHistory()
    const doomed = new Set(nodeIds)
    this.nodes = this.nodes.filter(n => !doomed.has(n.id))
    this.edges = this.edges.filter(e => !edgeIds.includes(e.id) && !doomed.has(e.from.split(/[.@]/)[0]!) && !doomed.has(e.to.split(/[.@]/)[0]!))
    this.groups = this.groups.map(g => ({ ...g, nodeIds: g.nodeIds.filter(id => !doomed.has(id)) })).filter(g => g.nodeIds.length)
    this.selection.clear()
    this.emit()
  }

  /** Definition → editor nodes/edges (definition graph is JSON; the editor
   * keeps only what it renders). */
  static fromDefinition(definition: GraphDefinitionInput): GraphEditor {
    const presentation = definition.presentation?.nodes ?? {}
    const { nodes, edges, groups } = importGraphDefinition(definition)
    const editor = new GraphEditor(nodes, edges, groups)
    editor.definition = structuredClone(definition) as BlueprintDefinition
    if (definition.presentation) editor.importLayout(definition.presentation)
    // Only absent coordinates are authored here. Saved coordinates are immutable
    // display inputs, even when they overlap. Natural template heights vary by ports.
    const defaults = defaultLayoutProjection(editor.nodes, editor.edges, definition.presentation)
    if (defaults.ok)
      for (const node of editor.nodes) {
        const position = defaults.positions.get(node.id)!
        if (presentation[node.id]?.x === undefined) node.x = position.x
        if (presentation[node.id]?.y === undefined) node.y = position.y
      }
    return editor
  }
}
