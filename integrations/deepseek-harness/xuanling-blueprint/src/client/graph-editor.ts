/**
 * Canvas graph editor (C-12/C-10, W6.2): local editing model behind the UI.
 * Pure data + commands — the React layer only renders and forwards gestures.
 * Semantic edits build definition revisions (host validates on save); layout
 * edits touch presentation ONLY and never a semantic revision or a running
 * node. Undo/redo is bounded; a stale save is refused by expectedRevision on
 * the host side, never by silently overwriting.
 */

import type { BlueprintDefinition, GraphEdge, GraphNode, ResourceRef, Presentation, PresentationNode, XY } from '../definition/types.ts'
import type { ConnectionVerdict, ViewTranslator } from './view-contract.ts'
import { decodeClipboard, ClipboardError, edgeKey, endpointNode, referencedResourceIds, validatePresentation, validateResourceReferences } from './clipboard.ts'
import type { ClipboardFragment, ClipboardPasteResult } from './clipboard.ts'
import { nodeDisplayTitle } from './node-catalog.ts'

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

/** Derived title follows locale; the legacy label is never mistaken for a name. */
export function editorNodeDisplayTitle(node: EditorNode, index: number, translate: ViewTranslator): string {
  return node.presentation?.title ?? nodeDisplayTitle(node.definition ?? { kind: node.kind }, index, translate)
}

export interface EditorEdge {
  id: string
  kind: 'data' | 'control'
  from: string // nodeId.port or nodeId@branch
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

let identitySequence = 0
function edgeId(): string {
  return `e-${Math.random().toString(36).slice(2, 10)}-${++identitySequence}`
}

function groupId(): string {
  return `g-${Math.random().toString(36).slice(2, 10)}-${++identitySequence}`
}

/** Port-type rule: data edges connect matching declared types; control edges
 * connect node/branch ids and never carry data. Resource bindings are NOT
 * edges — a skill wire is a binding, not a callable function (plan §1.1.7). */
export function canConnect(from: CanvasPort, to: CanvasPort): ConnectionVerdict {
  if (from.direction !== 'out' || to.direction !== 'in') return { ok: false, reason: 'direction-mismatch' }
  if (from.nodeId === to.nodeId) return { ok: false, reason: 'self-loop' }
  if ((from.kind ?? 'data') !== (to.kind ?? 'data')) return { ok: false, reason: 'edge-kind-mismatch' }
  if (from.type !== to.type) return { ok: false, reason: 'type-conflict', params: { fromType: from.type, toType: to.type } }
  return { ok: true }
}

interface HistoryEntry {
  definition?: BlueprintDefinition
  nodes: EditorNode[]
  edges: EditorEdge[]
  groups: EditorGroup[]
  selection: string[]
}

export type AlignmentMode = 'left' | 'right' | 'top' | 'bottom' | 'center-x' | 'center-y'
export type NodeMeasurements = ReadonlyMap<string, { width: number; height: number }>
export type EditorCommandCode = 'presentation-invalid' | 'stale-selection' | 'missing-measurement' | 'pinned-node' | 'invalid-position' | 'no-definition' | 'transaction-async' | 'transaction-history' | 'layout-pending' | 'clipboard-resource-conflict'
export class EditorCommandError extends Error {
  constructor(readonly code: EditorCommandCode, message: string = code) { super(message) }
}

const HISTORY_CAP = 100

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
    return {
      ...(this.definition ? { definition: structuredClone(this.definition) } : {}),
      nodes: this.nodes.map(n => ({ ...structuredClone(n), inputs: { ...n.inputs }, outputs: { ...n.outputs } })),
      edges: structuredClone(this.edges),
      groups: this.groups.map(g => ({ ...g, nodeIds: [...g.nodeIds] })),
      selection: [...this.selection],
    }
  }

  private pushHistory(): void {
    if (this.transactionDepth) return
    this.undoStack.push(this.layoutBefore ?? this.snap())
    this.layoutBefore = undefined
    if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift()
    this.redoStack = []
  }

  private graphNode(node: EditorNode): GraphNode {
    const result = { ...structuredClone(node.definition), id: node.id, kind: node.kind as GraphNode['kind'] }
    if (node.definition?.inputs !== undefined || Object.keys(node.inputs).length) result.inputs = structuredClone(node.inputs)
    if (node.definition?.outputs !== undefined || Object.keys(node.outputs).length) result.outputs = structuredClone(node.outputs)
    return result
  }

  private restore(entry: HistoryEntry): void {
    this.definition = entry.definition
    this.nodes = entry.nodes; this.edges = entry.edges; this.groups = entry.groups
    this.selection = new Set(entry.selection)
  }

  private checkLayout(layout: unknown, ids: Iterable<string> = this.nodes.map(n => n.id), edges = this.edges): void {
    try { validatePresentation(layout, ids, edges) }
    catch (error) {
      const message = error instanceof ClipboardError && /\/(x|y)$/.test(error.pointer) ? 'Invalid layout coordinates' : 'presentation-invalid'
      throw new EditorCommandError('presentation-invalid', message)
    }
  }

  private portFor(edge: EditorEdge, side: 'from' | 'to'): CanvasPort {
    const value = edge[side]; const nodeId = endpointNode(value, edge.kind)
    const node = this.nodes.find(n => n.id === nodeId)
    const port = edge.kind === 'control' ? value.split('@')[1] ?? 'control' : value.slice(value.indexOf('.') + 1)
    return { nodeId, port, direction: side === 'from' ? 'out' : 'in', kind: edge.kind, type: edge.kind === 'control' ? 'control' : (side === 'from' ? node?.outputs[port] : node?.inputs[port]) ?? '' }
  }

  /** Synchronous savepoints; only outer commit publishes or adds history.
   * A successful commit absorbs pending pointer layout into one history entry;
   * failure restores the current draft and leaves that gesture pending. */
  transaction<T>(fn: () => T): T {
    if (Object.prototype.toString.call(fn) === '[object AsyncFunction]') throw new EditorCommandError('transaction-async')
    const pending = this.layoutBefore
    const before = this.snap(); const undo = structuredClone(this.undoStack); const redo = structuredClone(this.redoStack)
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
      this.restore(before); this.undoStack = undo; this.redoStack = redo; this.layoutBefore = pending
      this.transactionDepth--
      throw error
    }
    this.transactionDepth--
    if (outer) {
      const after = this.snap()
      const historyBefore = pending ?? before
      const { selection: _oldSelection, ...oldState } = historyBefore
      this.layoutBefore = undefined
      const { selection: _newSelection, ...newState } = after
      if (JSON.stringify(oldState) !== JSON.stringify(newState)) {
        this.undoStack.push(historyBefore)
        if (this.undoStack.length > HISTORY_CAP) this.undoStack.shift()
        this.redoStack = []
      }
      if (JSON.stringify(before) !== JSON.stringify(after)) this.emit()
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
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch)) || Object.keys(patch).some(k => !['title', 'collapsed', 'pinned', 'width', 'height', 'color'].includes(k))) throw new EditorCommandError('presentation-invalid')
    const targets = this.requireNodes(nodeIds)
    const proposed = Object.fromEntries(targets.map(n => [n.id, { ...n.presentation, ...patch, x: n.x, y: n.y }]))
    this.checkLayout({ nodes: proposed })
    this.transaction(() => { for (const n of targets) n.presentation = { ...n.presentation, ...structuredClone(patch) } })
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
    this.transaction(() => { group.label = label })
  }

  renameDefinition(name: string): void {
    if (!this.definition) throw new EditorCommandError('no-definition')
    if (this.definition.name === name) return
    this.transaction(() => { this.definition!.name = name })
  }

  moveGroup(id: string, dx: number, dy: number): void {
    const group = this.groups.find(g => g.id === id)
    if (!group) throw new EditorCommandError('stale-selection')
    const nodes = this.requireNodes(group.nodeIds); this.movable(nodes)
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new EditorCommandError('invalid-position')
    this.transaction(() => { for (const n of nodes) this.moveNode(n.id, n.x + dx, n.y + dy) })
  }

  private measured(nodes: EditorNode[], measurements?: NodeMeasurements): Array<EditorNode & { width: number; height: number }> {
    return nodes.map(n => {
      const size = measurements?.get(n.id)
      const width = size?.width ?? n.presentation?.width; const height = size?.height ?? n.presentation?.height
      if (width === undefined || height === undefined || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw new EditorCommandError('missing-measurement')
      return { ...n, width, height }
    })
  }

  alignSelection(mode: AlignmentMode, measurements?: NodeMeasurements): void {
    if (!['left', 'right', 'top', 'bottom', 'center-x', 'center-y'].includes(mode)) throw new EditorCommandError('invalid-position')
    const selected = this.requireNodes(this.selection); if (selected.length < 2) return
    this.movable(selected)
    // Leading edges need positions only. Extents/centres need measured sizes.
    const nodes = mode === 'left' || mode === 'top' ? selected.map(n => ({ ...n, width: 0, height: 0 })) : this.measured(selected, measurements)
    const left = Math.min(...nodes.map(n => n.x)); const top = Math.min(...nodes.map(n => n.y))
    const right = Math.max(...nodes.map(n => n.x + n.width)); const bottom = Math.max(...nodes.map(n => n.y + n.height))
    this.transaction(() => { for (const n of nodes) this.moveNode(n.id,
      mode === 'left' ? left : mode === 'right' ? right - n.width : mode === 'center-x' ? (left + right - n.width) / 2 : n.x,
      mode === 'top' ? top : mode === 'bottom' ? bottom - n.height : mode === 'center-y' ? (top + bottom - n.height) / 2 : n.y) })
  }

  distributeSelection(axis: 'x' | 'y', measurements?: NodeMeasurements): void {
    if (axis !== 'x' && axis !== 'y') throw new EditorCommandError('invalid-position')
    const selected = this.requireNodes(this.selection); if (selected.length < 3) return
    this.movable(selected)
    const nodes = this.measured(selected, measurements).sort((a, b) => a[axis] - b[axis] || a.id.localeCompare(b.id))
    const size = axis === 'x' ? 'width' : 'height'
    const start = nodes[0]![axis]; const end = nodes[nodes.length - 1]![axis] + nodes[nodes.length - 1]![size]
    const gap = (end - start - nodes.reduce((sum, n) => sum + n[size], 0)) / (nodes.length - 1)
    this.transaction(() => {
      let position = start
      for (const [i, n] of nodes.entries()) {
        if (i > 0 && i < nodes.length - 1) this.moveNode(n.id, axis === 'x' ? position : n.x, axis === 'y' ? position : n.y)
        position += n[size] + gap
      }
    })
  }

  reconnect(id: string, from: CanvasPort, to: CanvasPort): ConnectionVerdict & { edge?: EditorEdge } {
    const edge = this.edges.find(e => e.id === id)
    if (!edge) return { ok: false, reason: 'unknown-node' }
    const verdict = this.connectionVerdict(from, to, id)
    if (!verdict.ok) return verdict
    const kind = from.kind ?? 'data'
    const source = kind === 'control' ? `${from.nodeId}${this.nodes.find(n => n.id === from.nodeId)?.definition?.branches?.length ? `@${from.port}` : ''}` : `${from.nodeId}.${from.port}`
    const target = kind === 'control' ? to.nodeId : `${to.nodeId}.${to.port}`
    this.transaction(() => { edge.kind = kind; edge.from = source; edge.to = target })
    return { ok: true, edge }
  }

  createClipboard(nodeIds: string[] = [...this.selection]): ClipboardFragment {
    if (!this.definition) throw new EditorCommandError('no-definition')
    const selected = this.requireNodes(nodeIds); const ids = new Set(selected.map(n => n.id))
    const nodes = selected.map(n => this.graphNode(n))
    const edges = this.edges.filter(e => ids.has(endpointNode(e.from, e.kind)) && ids.has(endpointNode(e.to, e.kind)))
    const incoming = this.edges.filter(e => !ids.has(endpointNode(e.from, e.kind)) && ids.has(endpointNode(e.to, e.kind)))
    const layout = this.exportLayout()
    const resources = Object.fromEntries([...referencedResourceIds(nodes)].map(id => [id, structuredClone(this.definition!.resources[id])]))
    return decodeClipboard({ version: 1, sourceBlueprintId: this.definition.id, nodes,
      edges: edges.map(({ kind, from, to }) => ({ kind, from, to })), incoming: incoming.map(({ kind, from, to }) => ({ kind, from, to })), resources,
      presentation: { nodes: Object.fromEntries(selected.map(n => [n.id, layout.nodes[n.id]])),
        groups: this.groups.map(g => ({ ...g, nodeIds: g.nodeIds.filter(id => ids.has(id)) })).filter(g => g.nodeIds.length),
        ...(layout.edges ? { edges: layout.edges.filter(e => [...edges, ...incoming].some(known => edgeKey(e) === edgeKey(known))) } : {}) },
    })
  }

  pasteClipboard(input: unknown, position: XY, options: { withIncoming?: boolean } = {}): ClipboardPasteResult {
    if (!this.definition) return { ok: false, code: 'no-definition', nodeIds: [] }
    let fragment: ClipboardFragment
    try { fragment = decodeClipboard(input) } catch { return { ok: false, code: 'clipboard-invalid', nodeIds: [] } }
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return { ok: false, code: 'clipboard-invalid', nodeIds: [] }
    const same = fragment.sourceBlueprintId === this.definition.id
    if (options.withIncoming && !same) return { ok: false, code: 'clipboard-incoming-cross-blueprint', nodeIds: [] }
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)
    for (const [id, ref] of Object.entries(fragment.resources)) {
      const target = this.definition.resources[id]
      if (!Object.hasOwn(this.definition.resources, id) || !target || canonical(target) !== canonical(ref) || (!same && !(ref.kind === 'mcp' || ref.kind === 'skill' && ref.source?.kind === 'shared'))) return { ok: false, code: 'clipboard-resource-conflict', nodeIds: [] }
    }
    const ids = new Set(this.nodes.map(n => n.id)); const groups = new Set(this.groups.map(g => g.id))
    const unique = (base: string, used: Set<string>): string => { let i = 1; while (used.has(`${base}_copy${i}`)) i++; const id = `${base}_copy${i}`; used.add(id); return id }
    const remap = new Map(fragment.nodes.map(n => [n.id, unique(n.id, ids)]))
    const endpoint = (value: string, kind: GraphEdge['kind']): string => {
      const id = endpointNode(value, kind); return (remap.get(id) ?? id) + value.slice(id.length)
    }
    const edge = (e: GraphEdge): GraphEdge => ({ kind: e.kind, from: endpoint(e.from, e.kind), to: endpoint(e.to, e.kind) })
    const left = Math.min(...fragment.nodes.map(n => fragment.presentation.nodes[n.id]?.x ?? 0))
    const top = Math.min(...fragment.nodes.map(n => fragment.presentation.nodes[n.id]?.y ?? 0))
    const dx = position.x - left; const dy = position.y - top
    const nodeIds = [...remap.values()]
    try {
      this.transaction(() => {
        for (const n of fragment.nodes) {
          const p = fragment.presentation.nodes[n.id] ?? { x: 0, y: 0 }; const { x, y, ...attrs } = p
          const id = remap.get(n.id)!
          this.addNode({ id, definition: { ...n, id }, kind: n.kind, label: n.kind, x: x + dx, y: y + dy, inputs: n.inputs ?? {}, outputs: n.outputs ?? {}, presentation: attrs })
        }
        for (const original of [...fragment.edges, ...(options.withIncoming ? fragment.incoming : [])]) {
          const mapped = edge(original)
          const temporary: EditorEdge = { ...mapped, id: '' }
          const result = this.connect(this.portFor(temporary, 'from'), this.portFor(temporary, 'to'))
          if (!result.ok || !result.edge) throw new ClipboardError('/edges')
          const route = fragment.presentation.edges?.find(e => edgeKey(e) === edgeKey(original))
          if (route) result.edge.points = route.points.map(p => ({ x: p.x + dx, y: p.y + dy }))
        }
        for (const g of fragment.presentation.groups ?? []) this.groups.push({ id: unique(g.id, groups), label: g.label ?? g.id, nodeIds: g.nodeIds.map(id => remap.get(id)!) })
        this.selection = new Set(nodeIds)
      })
      return { ok: true, code: 'clipboard-pasted', nodeIds }
    } catch { return { ok: false, code: 'clipboard-invalid', nodeIds: [] } }
  }

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  undo(): boolean {
    if (this.transactionDepth) throw new EditorCommandError('transaction-history')
    if (this.layoutBefore) throw new EditorCommandError('layout-pending')
    const previous = this.undoStack.pop()
    if (previous === undefined) return false
    this.redoStack.push(this.snap())
    this.definition = previous.definition
    this.nodes = previous.nodes
    this.edges = previous.edges
    this.groups = previous.groups
    this.selection.clear()
    this.emit()
    return true
  }

  redo(): boolean {
    if (this.transactionDepth) throw new EditorCommandError('transaction-history')
    if (this.layoutBefore) throw new EditorCommandError('layout-pending')
    const next = this.redoStack.pop()
    if (next === undefined) return false
    this.undoStack.push(this.snap())
    this.definition = next.definition
    this.nodes = next.nodes
    this.edges = next.edges
    this.groups = next.groups
    this.selection.clear()
    this.emit()
    return true
  }

  addNode(node: Omit<EditorNode, 'id'> & { id?: string }): EditorNode {
    const candidate = { ...node, id: node.id ?? `n-${Math.random().toString(36).slice(2, 8)}-${++identitySequence}` }
    if (this.nodes.some(n => n.id === candidate.id)) throw new EditorCommandError('stale-selection')
    try { validateResourceReferences([this.graphNode(candidate)], this.definition?.resources ?? {}) }
    catch { throw new EditorCommandError('clipboard-resource-conflict') }
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

  connectionVerdict(from: CanvasPort, to: CanvasPort, ignoreEdgeId?: string): ConnectionVerdict {
    const verdict = canConnect(from, to)
    if (!verdict.ok) return verdict
    const kind = from.kind ?? 'data'
    if (!this.nodes.some(n => n.id === from.nodeId) || !this.nodes.some(n => n.id === to.nodeId)) return { ok: false, reason: 'unknown-node' }
    if (kind === 'data') {
      if (this.nodes.find(n => n.id === from.nodeId)?.outputs[from.port] !== from.type || this.nodes.find(n => n.id === to.nodeId)?.inputs[to.port] !== to.type) return { ok: false, reason: 'undeclared-port' }
      const visited = new Set<string>()
      const stack = [to.nodeId]
      while (stack.length) {
        const id = stack.pop()!
        if (id === from.nodeId) return { ok: false, reason: 'data-cycle' }
        if (visited.has(id)) continue
        visited.add(id)
        for (const e of this.edges.filter(e => e.id !== ignoreEdgeId && e.kind === 'data' && e.from.split('.')[0] === id)) stack.push(e.to.split('.')[0]!)
      }
    }
    if (kind === 'control') {
      const branches = this.nodes.find(n => n.id === from.nodeId)?.definition?.branches ?? []
      if (from.type !== 'control' || to.type !== 'control' || to.port !== 'control' || (branches.length ? !branches.includes(from.port) : from.port !== 'control')) return { ok: false, reason: 'undeclared-port' }
    }
    const source = kind === 'control' ? `${from.nodeId}${this.nodes.find(n => n.id === from.nodeId)?.definition?.branches?.length ? `@${from.port}` : ''}` : `${from.nodeId}.${from.port}`
    const target = kind === 'control' ? to.nodeId : `${to.nodeId}.${to.port}`
    if (this.edges.some(e => e.id !== ignoreEdgeId && e.kind === kind && e.from === source && e.to === target)) return { ok: false, reason: 'duplicate-edge' }
    return { ok: true }
  }

  connect(from: CanvasPort, to: CanvasPort): ConnectionVerdict & { edge?: EditorEdge } {
    const verdict = this.connectionVerdict(from, to)
    if (!verdict.ok) return verdict
    const kind = from.kind ?? 'data'
    const source = kind === 'control' ? `${from.nodeId}${this.nodes.find(n => n.id === from.nodeId)?.definition?.branches?.length ? `@${from.port}` : ''}` : `${from.nodeId}.${from.port}`
    const target = kind === 'control' ? to.nodeId : `${to.nodeId}.${to.port}`
    this.pushHistory()
    const edge: EditorEdge = {
      id: edgeId(),
      kind,
      from: source,
      to: target,
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
    const group: EditorGroup = { id: groupId(), label, nodeIds: [...this.selection] }
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
    const nodes: Record<string, PresentationNode> = Object.fromEntries(this.nodes.map(node => [node.id, { ...structuredClone(node.presentation), x: node.x, y: node.y }]))
    const edges = this.edges.filter(e => e.points !== undefined).map(e => ({ kind: e.kind, from: e.from, to: e.to, points: structuredClone(e.points!) }))
    const layout: Presentation = { nodes, groups: structuredClone(this.groups), ...(edges.length ? { edges } : {}) }
    this.checkLayout(layout)
    return layout
  }

  importLayout(layout: Partial<Presentation>): void {
    // Restore is intentionally history-free, but validates every record first.
    if (this.layoutBefore) throw new EditorCommandError('layout-pending')
    if (!layout || typeof layout !== 'object' || Array.isArray(layout) || ![Object.prototype, null].includes(Object.getPrototypeOf(layout))) throw new EditorCommandError('presentation-invalid')
    const complete = { ...layout, nodes: layout.nodes ?? {} }
    this.checkLayout(complete)
    for (const node of this.nodes) {
      const position = complete.nodes[node.id]
      if (position !== undefined) {
        const { x, y, ...attrs } = structuredClone(position)
        node.x = x; node.y = y
        node.presentation = attrs
      }
    }
    if (layout.groups !== undefined) this.groups = layout.groups.map(g => ({ ...structuredClone(g), label: g.label ?? g.id }))
    const routing = new Map((layout.edges ?? []).map(e => [edgeKey(e), e.points]))
    for (const edge of this.edges) {
      const points = routing.get(edgeKey(edge))
      if (points !== undefined) edge.points = structuredClone(points)
      else delete edge.points
    }
    this.emit()
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

  updateResource(refId: string, ref: ResourceRef): void {
    if (!this.definition) return
    this.pushHistory()
    this.definition.resources[refId] = structuredClone(ref)
    this.emit()
  }

  exportDefinition(): BlueprintDefinition {
    if (!this.definition) throw new EditorCommandError('no-definition')
    const definition = structuredClone(this.definition)
    definition.graph.nodes = this.nodes.map(n => this.graphNode(n))
    definition.graph.edges = this.edges.map(({ kind, from, to }) => ({ kind, from, to }))
    definition.presentation = this.exportLayout()
    return definition
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
  static fromDefinition(definition: {
    graph: { nodes: Array<{ id: string; kind: string; name?: string; inputs?: Record<string, string>; outputs?: Record<string, string> }>; edges: Array<{ kind: string; from: string; to: string }> }
    presentation?: Partial<Presentation>
  }): GraphEditor {
    const presentation = definition.presentation?.nodes ?? {}
    const nodes = definition.graph.nodes.map((node, index) => ({
      definition: structuredClone(node) as GraphNode,
      id: node.id,
      kind: node.kind,
      label: node.name ?? `${node.kind} ${index + 1}`,
      x: presentation[node.id]?.x ?? 60 + (index % 4) * 220,
      y: presentation[node.id]?.y ?? 60 + Math.floor(index / 4) * 140,
      inputs: structuredClone(node.inputs ?? {}),
      outputs: structuredClone(node.outputs ?? {}),
      ...(presentation[node.id] ? { presentation: (({ x: _x, y: _y, ...attrs }) => attrs)(structuredClone(presentation[node.id]!)) } : {}),
    }))
    const edges = definition.graph.edges.map(e => ({ id: edgeId(), kind: e.kind === 'control' ? 'control' as const : 'data' as const, from: e.from, to: e.to }))
    const groups = (definition.presentation?.groups ?? []).map(g => ({ id: g.id, label: g.label ?? g.id, nodeIds: [...g.nodeIds] }))
    const editor = new GraphEditor(nodes, edges, groups)
    if (definition.presentation) editor.importLayout(definition.presentation)
    editor.definition = structuredClone(definition) as BlueprintDefinition
    return editor
  }
}
