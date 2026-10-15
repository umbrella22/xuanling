import { effectivePortVisibility, portSide } from './port-visibility.ts'
import type { NodeChange, EdgeChange } from '@xyflow/react'
import type { GraphEditor, CanvasPort } from './graph-editor.ts'
import type { GraphNode, XY } from '../definition/types.ts'
import { searchBuiltinNodes } from './node-catalog.ts'
import type { BuiltinNodeKind } from './node-catalog.ts'
import type { ViewTranslator } from './view-contract.ts'
import type { ClipboardFragment } from './clipboard.ts'

/** Controlled React Flow events are deltas, not an authoritative definition.
 * Selection stays transient; all layout gestures go through editor history. */
export function applyCanvasNodeChanges(editor: GraphEditor, changes: NodeChange[]): void {
  const selection = new Set(editor.selection)
  for (const change of changes) {
    if (change.type === 'position' && change.position) editor.moveNode(change.id, change.position.x, change.position.y)
    else if (change.type === 'select') {
      if (change.selected) selection.add(change.id)
      else selection.delete(change.id)
    }
  }
  editor.setSelection(selection)
}

export function applyCanvasEdgeSelection(current: string[], changes: EdgeChange[]): string[] {
  const selection = new Set(current)
  for (const change of changes) {
    if (change.type !== 'select') continue
    if (change.selected) selection.add(change.id)
    else selection.delete(change.id)
  }
  const next = [...selection]
  return next.length === current.length && next.every((id, index) => current[index] === id) ? current : next
}
/** React/native pointer and D3 resize events share the same screen coordinates. */
export function pointerPosition(event: unknown): XY | undefined {
  type Pointer = { clientX?: unknown; clientY?: unknown; changedTouches?: ArrayLike<Pointer>; sourceEvent?: unknown }
  const raw = event as Pointer | null
  const source = (raw?.sourceEvent ?? raw) as Pointer | null
  const pointer = source?.changedTouches?.[0] ?? source
  return typeof pointer?.clientX === 'number' && Number.isFinite(pointer.clientX) && typeof pointer.clientY === 'number' && Number.isFinite(pointer.clientY)
    ? { x: pointer.clientX, y: pointer.clientY }
    : undefined
}

/** The same declared template feeds palette/search and compatibility checks. */
export function searchNodeDeclaration(kind: BuiltinNodeKind, id: string): GraphNode {
  if (kind === 'condition')
    return {
      id,
      kind,
      inputs: { predicate: 'boolean' },
      branches: ['true', 'false'],
      condition: { inputPort: 'predicate', trueBranch: 'true', falseBranch: 'false' }
    }
  if (kind === 'join') return { id, kind, join: 'all' }
  return { id, kind, inputs: kind === 'input' ? {} : { input: 'string' }, outputs: kind === 'output' ? {} : { result: 'string' } }
}
export function declaredSearchPorts(node: GraphNode, direction: 'in' | 'out', kind: 'data' | 'control'): CanvasPort[] {
  if (kind === 'control')
    return (direction === 'in' ? ['control'] : node.branches?.length ? node.branches : ['control']).map(port => ({
      nodeId: node.id,
      port,
      direction,
      kind,
      type: 'control'
    }))
  return Object.entries(direction === 'in' ? (node.inputs ?? {}) : (node.outputs ?? {})).map(([port, type]) => ({
    nodeId: node.id,
    port,
    direction,
    kind,
    type
  }))
}
export function compatibleSearchNodes(query: string, origin?: CanvasPort, translate?: ViewTranslator) {
  return searchBuiltinNodes(query, translate).filter(
    meta =>
      !origin ||
      declaredSearchPorts(searchNodeDeclaration(meta.kind, 'candidate'), origin.direction === 'out' ? 'in' : 'out', origin.kind ?? 'data').some(
        port => port.type === origin.type
      )
  )
}
export interface InteractionContext {
  editor: GraphEditor
  blueprintId: string | null
  documentRevision?: string | null
  busy: boolean
  locked: boolean
  composing: boolean
  displayPositions?: ReadonlyMap<string, XY>
  measurements?: ReadonlyMap<string, { width: number; height: number }>
}
interface Binding {
  editor: GraphEditor
  blueprintId: string | null
  documentRevision?: string | null
  document: string
  selection: string
  generation: number
  sequence: number
}
export interface SystemClipboard {
  readText?: () => Promise<string>
  writeText?: (text: string) => Promise<void>
}
export type InteractionResult = { ok: boolean; code: string }
export type CanvasGesture =
  | { kind: 'drag'; binding: Binding; ids: string[]; positions: Map<string, XY>; dx: number; dy: number; clone?: ClipboardFragment }
  | { kind: 'resize'; binding: Binding; nodeId: string; size?: { width: number; height: number }; position?: XY }
  | { kind: 'route'; binding: Binding; edgeId: string; points: XY[] }

/** Browser side effects stay outside synchronous GraphEditor transactions.
 * Previews never alter canonical presentation; one validated commit adds history. */
export class CanvasInteractions {
  gesture: CanvasGesture | undefined
  private generation = 0
  private sequence = 0
  private observed: GraphEditor | undefined
  private off: (() => void) | undefined
  constructor(private readonly context: () => InteractionContext) {}
  private editable(): boolean {
    const c = this.context()
    return !!c.blueprintId && !c.busy && !c.locked && !c.composing
  }
  private bind(): Binding {
    const c = this.context()
    if (this.observed !== c.editor) {
      this.off?.()
      this.generation++
      this.observed = c.editor
      this.off = c.editor.subscribe(() => this.sequence++)
    }
    return {
      editor: c.editor,
      blueprintId: c.blueprintId,
      documentRevision: c.documentRevision ?? null,
      document: JSON.stringify(c.editor.exportDefinition()),
      selection: JSON.stringify([...c.editor.selection]),
      generation: this.generation,
      sequence: this.sequence
    }
  }
  private current(b: Binding, selection = true, allowLocked = false): boolean {
    const c = this.context()
    return (
      !!c.blueprintId &&
      !c.busy &&
      !c.composing &&
      (allowLocked || !c.locked) &&
      c.editor === b.editor &&
      c.blueprintId === b.blueprintId &&
      (c.documentRevision ?? null) === b.documentRevision &&
      b.generation === this.generation &&
      JSON.stringify(c.editor.exportDefinition()) === b.document &&
      (!selection || (b.sequence === this.sequence && JSON.stringify([...c.editor.selection]) === b.selection))
    )
  }
  cancel(): void {
    this.generation++
    this.gesture = undefined
    this.context().editor.cancelLayout()
  }
  dispose(): void {
    this.cancel()
    this.off?.()
    this.off = undefined
    this.observed = undefined
  }
  async clipboard(command: 'copy' | 'cut' | 'paste' | 'paste-with-incoming', clipboard: SystemClipboard | undefined, position: XY): Promise<InteractionResult> {
    const initial = this.context()
    if (!initial.blueprintId || initial.busy || initial.composing || (initial.locked && command !== 'copy')) return { ok: false, code: 'canvas-unavailable' }
    const binding = this.bind()
    const editor = binding.editor
    // A subsequent clipboard request cancels older callbacks, even A -> B -> A.
    binding.generation = ++this.generation
    try {
      if (command === 'copy' || command === 'cut') {
        if (typeof clipboard?.writeText !== 'function') return { ok: false, code: 'clipboard-unavailable' }
        const fragment = editor.createClipboard()
        await clipboard.writeText(JSON.stringify(fragment))
        if (!this.current(binding, true, command === 'copy')) return { ok: false, code: 'clipboard-stale' }
        if (command === 'cut') editor.transaction(() => editor.deleteItems([...editor.selection], []))
        return { ok: true, code: command === 'cut' ? 'clipboard-cut' : 'clipboard-copied' }
      }
      if (typeof clipboard?.readText !== 'function') return { ok: false, code: 'clipboard-unavailable' }
      const text = await clipboard.readText()
      if (!this.current(binding)) return { ok: false, code: 'clipboard-stale' }
      let result: ReturnType<GraphEditor['pasteClipboard']>
      editor.transaction(() => {
        result = editor.pasteClipboard(text, position, {
          withIncoming: command === 'paste-with-incoming',
          measurements: this.context().measurements,
          displayPositions: this.context().displayPositions
        })
      })
      return result!
    } catch (error) {
      return {
        ok: false,
        code: !this.current(binding, true, command === 'copy')
          ? 'clipboard-stale'
          : (error as { code?: string }).code === 'layout-collision-unresolved'
            ? 'layout-collision-unresolved'
            : (error as { code?: string }).code === 'clipboard-invalid'
              ? 'clipboard-invalid'
              : 'clipboard-unavailable'
      }
    }
  }
  private applyMeasuredLayout(editor: GraphEditor, groups: readonly (readonly string[])[] = []): void {
    const measurements = this.context().measurements
    // Newly created nodes have no DOM measurement yet: retain template placement
    // in this transaction and let the canvas project actual geometry on observation.
    if (measurements && editor.nodes.every(node => measurements.has(node.id))) editor.applyCollisionLayout(measurements, groups)
  }
  add(kind: BuiltinNodeKind, position: XY, origin?: CanvasPort): string | null {
    if (!this.editable()) return null
    const editor = this.context().editor
    if (origin) {
      const source = editor.nodes.find(n => n.id === origin.nodeId)
      if (!source || !effectivePortVisibility(source, editor.edges)[portSide(origin)]) return null
    }
    const id = `n-${crypto.randomUUID()}`
    const node = searchNodeDeclaration(kind, id)
    const port = origin && declaredSearchPorts(node, origin.direction === 'out' ? 'in' : 'out', origin.kind ?? 'data').find(p => p.type === origin.type)
    if (origin && !port) return null
    editor.transaction(() => {
      editor.addNode({
        id,
        definition: node,
        kind,
        label: kind,
        ...position,
        inputs: node.inputs ?? {},
        outputs: node.outputs ?? {},
        ...(origin?.kind === 'control' ? { presentation: { ports: { control: true } } } : {})
      })
      if (origin && port) {
        const result = origin.direction === 'out' ? editor.connect(origin, port) : editor.connect(port, origin)
        if (!result.ok) throw new Error(result.reason)
      }
      editor.settleCreatedNodes([id], this.context().measurements, this.context().displayPositions)
      editor.setSelection([id])
    })
    return id
  }
  beginDrag(ids: string[], clone: boolean): boolean {
    if (!this.editable() || !ids.length) return false
    const b = this.bind(),
      nodes = ids.map(id => b.editor.nodes.find(n => n.id === id))
    if (nodes.some(n => !n || n.presentation?.pinned)) return false
    const fragment = clone ? b.editor.createClipboard(ids) : undefined
    if (fragment)
      for (const id of ids) {
        const position = this.context().displayPositions?.get(id)
        const attrs = fragment.presentation.nodes[id]
        if (position && attrs) {
          attrs.x = position.x
          attrs.y = position.y
        }
      }
    this.gesture = {
      kind: 'drag',
      binding: b,
      ids,
      positions: new Map(nodes.map(n => [n!.id, this.context().displayPositions?.get(n!.id) ?? { x: n!.x, y: n!.y }])),
      dx: 0,
      dy: 0,
      ...(fragment ? { clone: fragment } : {})
    }
    return true
  }
  previewDrag(dx: number, dy: number): void {
    if (this.gesture?.kind !== 'drag' || !Number.isFinite(dx) || !Number.isFinite(dy)) return
    this.gesture.dx = dx
    this.gesture.dy = dy
  }
  beginResize(nodeId: string): boolean {
    if (!this.editable() || !this.context().editor.nodes.some(n => n.id === nodeId && !n.presentation?.pinned)) return false
    this.gesture = { kind: 'resize', binding: this.bind(), nodeId }
    return true
  }
  previewResize(size: { width: number; height: number }, position?: XY): void {
    if (this.gesture?.kind !== 'resize') return
    if (![size.width, size.height].every(v => Number.isFinite(v) && v > 0)) return
    this.gesture.size = size
    if (position) this.gesture.position = position
    else delete this.gesture.position
  }
  beginRoute(edgeId: string): boolean {
    if (!this.editable()) return false
    const b = this.bind(),
      edge = b.editor.edges.find(e => e.id === edgeId)
    if (!edge) return false
    this.gesture = { kind: 'route', binding: b, edgeId, points: structuredClone(edge.points ?? []) }
    return true
  }
  previewRoute(points: XY[]): void {
    if (this.gesture?.kind !== 'route' || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return
    this.gesture.points = structuredClone(points)
  }
  commitGesture(): boolean {
    const gesture = this.gesture
    this.gesture = undefined
    if (!gesture || !this.current(gesture.binding, false)) return false
    const editor = gesture.binding.editor
    editor.transaction(() => {
      if (gesture.kind === 'drag') {
        if (!gesture.dx && !gesture.dy) return
        if (gesture.clone) {
          const result = editor.pasteClipboard(
            gesture.clone,
            {
              x: Math.min(...[...gesture.positions.values()].map(p => p.x)) + gesture.dx,
              y: Math.min(...[...gesture.positions.values()].map(p => p.y)) + gesture.dy
            },
            { rigid: true, measurements: this.context().measurements, displayPositions: this.context().displayPositions }
          )
          if (!result.ok) throw new Error(result.code)
        } else for (const [id, p] of gesture.positions) editor.moveNode(id, p.x + gesture.dx, p.y + gesture.dy)
      } else if (gesture.kind === 'resize' && gesture.size) {
        editor.patchPresentation([gesture.nodeId], gesture.size)
        if (gesture.position) editor.moveNode(gesture.nodeId, gesture.position.x, gesture.position.y)
      } else if (gesture.kind === 'route') {
        const edge = editor.edges.find(e => e.id === gesture.edgeId)
        if (!edge) throw new Error('stale-selection')
        edge.points = structuredClone(gesture.points)
      }
      if (gesture.kind !== 'route' && !(gesture.kind === 'drag' && gesture.clone))
        this.applyMeasuredLayout(editor, gesture.kind === 'drag' && !gesture.clone ? [gesture.ids] : [])
    })
    return true
  }
  route(edgeId: string, points: XY[]): boolean {
    if (!this.beginRoute(edgeId)) return false
    this.previewRoute(points)
    return this.commitGesture()
  }
  reconnect(edgeId: string, from: CanvasPort, to: CanvasPort, copy: boolean) {
    if (!this.editable()) return { ok: false as const, reason: 'undeclared-port' as const }
    const editor = this.context().editor
    return copy ? editor.connect(from, to) : editor.reconnect(edgeId, from, to)
  }
}
