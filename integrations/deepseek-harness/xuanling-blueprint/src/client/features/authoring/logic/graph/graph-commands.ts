import type { ConnectionVerdict, ViewTranslator } from '../../../../shared/contracts/view-contract.ts'
import type { EditorCommandCode, CanvasPort, EditorEdge, EditorNode, GraphEditorState } from './graph-types.ts'
import { effectivePortVisibility, portSide } from './port-visibility.ts'
import { endpointNode } from './clipboard.ts'
import { nodeDisplayTitle } from './node-catalog.ts'

let identitySequence = 0

export function nextEdgeId(): string {
  return `e-${Math.random().toString(36).slice(2, 10)}-${++identitySequence}`
}

export function nextGroupId(): string {
  return `g-${Math.random().toString(36).slice(2, 10)}-${++identitySequence}`
}

export function nextNodeId(): string {
  return `n-${Math.random().toString(36).slice(2, 8)}-${++identitySequence}`
}

export function editorNodeDisplayTitle(node: EditorNode, index: number, translate: ViewTranslator): string {
  return node.presentation?.title ?? nodeDisplayTitle(node.definition ?? { kind: node.kind }, index, translate)
}

/** Port-type rule: data edges connect matching declared types; control edges
 * connect node/branch ids and never carry data. Resource bindings are not
 * edges — a skill wire is a binding, not a callable function. */
export function canConnect(from: CanvasPort, to: CanvasPort): ConnectionVerdict {
  if (from.direction !== 'out' || to.direction !== 'in') return { ok: false, reason: 'direction-mismatch' }
  if (from.nodeId === to.nodeId) return { ok: false, reason: 'self-loop' }
  if ((from.kind ?? 'data') !== (to.kind ?? 'data')) return { ok: false, reason: 'edge-kind-mismatch' }
  if (from.type !== to.type) return { ok: false, reason: 'type-conflict', params: { fromType: from.type, toType: to.type } }
  return { ok: true }
}

export class EditorCommandError extends Error {
  constructor(
    readonly code: EditorCommandCode,
    message: string = code,
    readonly params?: { edgeCount: number }
  ) {
    super(message)
  }
}

export function edgeEndpoints(
  state: Pick<GraphEditorState, 'nodes'>,
  from: CanvasPort,
  to: CanvasPort
): { source: string; target: string; kind: 'data' | 'control' } {
  const kind = from.kind ?? 'data'
  const source =
    kind === 'control'
      ? `${from.nodeId}${state.nodes.find(n => n.id === from.nodeId)?.definition?.branches?.length ? `@${from.port}` : ''}`
      : `${from.nodeId}.${from.port}`
  const target = kind === 'control' ? to.nodeId : `${to.nodeId}.${to.port}`
  return { source, target, kind }
}

export function portForEdge(state: Pick<GraphEditorState, 'nodes'>, edge: EditorEdge, side: 'from' | 'to'): CanvasPort {
  const value = edge[side]
  const nodeId = endpointNode(value, edge.kind)
  const node = state.nodes.find(n => n.id === nodeId)
  const port = edge.kind === 'control' ? (value.split('@')[1] ?? 'control') : value.slice(value.indexOf('.') + 1)
  return {
    nodeId,
    port,
    direction: side === 'from' ? 'out' : 'in',
    kind: edge.kind,
    type: edge.kind === 'control' ? 'control' : ((side === 'from' ? node?.outputs[port] : node?.inputs[port]) ?? '')
  }
}

/** Full connection admission remains a pure command against the one editor state. */
export function checkConnection(state: GraphEditorState, from: CanvasPort, to: CanvasPort, ignoreEdgeId?: string, canonicalRestore = false): ConnectionVerdict {
  const verdict = canConnect(from, to)
  if (!verdict.ok) return verdict
  const kind = from.kind ?? 'data'
  if (!state.nodes.some(n => n.id === from.nodeId) || !state.nodes.some(n => n.id === to.nodeId)) return { ok: false, reason: 'unknown-node' }
  if (kind === 'data') {
    if (state.nodes.find(n => n.id === from.nodeId)?.outputs[from.port] !== from.type || state.nodes.find(n => n.id === to.nodeId)?.inputs[to.port] !== to.type)
      return { ok: false, reason: 'undeclared-port' }
    const visited = new Set<string>()
    const stack = [to.nodeId]
    while (stack.length) {
      const id = stack.pop()!
      if (id === from.nodeId) return { ok: false, reason: 'data-cycle' }
      if (visited.has(id)) continue
      visited.add(id)
      for (const edge of state.edges.filter(edge => edge.id !== ignoreEdgeId && edge.kind === 'data' && edge.from.split('.')[0] === id))
        stack.push(edge.to.split('.')[0]!)
    }
  }
  if (kind === 'control') {
    const branches = state.nodes.find(n => n.id === from.nodeId)?.definition?.branches ?? []
    if (
      from.type !== 'control' ||
      to.type !== 'control' ||
      to.port !== 'control' ||
      (branches.length ? !branches.includes(from.port) : from.port !== 'control')
    )
      return { ok: false, reason: 'undeclared-port' }
  }
  if (
    !canonicalRestore &&
    [from, to].some(
      port =>
        !effectivePortVisibility(
          state.nodes.find(n => n.id === port.nodeId)!,
          state.edges
        )[portSide(port)]
    )
  )
    return { ok: false, reason: 'port-hidden' }
  const { source, target } = edgeEndpoints(state, from, to)
  if (state.edges.some(edge => edge.id !== ignoreEdgeId && edge.kind === kind && edge.from === source && edge.to === target))
    return { ok: false, reason: 'duplicate-edge' }
  return { ok: true }
}
