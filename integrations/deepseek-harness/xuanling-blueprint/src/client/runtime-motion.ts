import type { GraphEdge, GraphNode } from '../definition/types.ts'
import type { AttemptState, RunState } from '../persistence/records.ts'
import type { ConnectionState, RunAttemptView, RunSnapshotView } from './model.ts'

export type MotionMode = 'static' | 'pulse'
export type NodeRelation = 'none' | 'anchor' | 'neighbor'
export interface RuntimeMotionInput {
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  snapshot: RunSnapshotView | null
  /** Workspace authority: run ID, semantic revision and local semantic edits match. */
  overlayEligible: boolean
  connectionState: ConnectionState
  visible: boolean
  reducedMotion: boolean
  userMotion: 'on' | 'off'
  hoveredNodeId?: string | null
  focusedNodeId?: string | null
}
export interface NodeMotion {
  nodeId: string
  state: AttemptState | 'idle' | 'unknown'
  motion: MotionMode
  relation: NodeRelation
}
export interface EdgeMotion {
  /** Position in the supplied graph, independent of transient editor edge IDs. */
  edgeIndex: number
  motion: MotionMode
  related: boolean
}
export interface RuntimeMotionProjection {
  runState: RunState | 'unknown' | 'idle'
  loopsAllowed: boolean
  nodes: NodeMotion[]
  edges: EdgeMotion[]
}

// Type-only imports keep the projection free of storage/codecs/Host side effects.
const attemptStates: readonly AttemptState[] = ['preparing', 'ready', 'running', 'waiting_input', 'cancelling', 'recovery_required', 'succeeded', 'failed', 'cancelled', 'timed_out', 'skipped']
const runStates: readonly RunState[] = ['queued', 'running', 'waiting_input', 'cancelling', 'recovery_required', 'succeeded', 'failed', 'cancelled', 'timed_out']
const active = (state: string | undefined): boolean => state === 'running' || state === 'preparing'

/** Highest attempt number wins; equal ordinals use the later durable array
 * entry (recordIntent currently appends ordinal 1). Invalid ordinals are static. */
function latestAttempts(attempts: readonly RunAttemptView[]): Map<string, RunAttemptView | null> {
  const latest = new Map<string, RunAttemptView | null>()
  for (const attempt of attempts) {
    const previous = latest.get(attempt.nodeId)
    if (!Number.isSafeInteger(attempt.attempt) || attempt.attempt < 1) { latest.set(attempt.nodeId, null); continue }
    if (previous === null) continue
    if (!previous || attempt.attempt >= previous.attempt) latest.set(attempt.nodeId, attempt)
  }
  return latest
}

interface ResolvedEdge { from: GraphNode; to: GraphNode; branch?: string }
function resolveEdge(edge: GraphEdge, nodes: ReadonlyMap<string, GraphNode>): ResolvedEdge | null {
  if (edge.kind === 'data') {
    const fromDot = edge.from.indexOf('.'), toDot = edge.to.indexOf('.')
    if (fromDot <= 0 || toDot <= 0) return null
    const source = nodes.get(edge.from.slice(0, fromDot)), target = nodes.get(edge.to.slice(0, toDot))
    const output = edge.from.slice(fromDot + 1), input = edge.to.slice(toDot + 1)
    if (!source || !target || !Object.hasOwn(source.outputs ?? {}, output) || !Object.hasOwn(target.inputs ?? {}, input)
      || source.outputs?.[output] !== target.inputs?.[input]) return null
    return { from: source, to: target }
  }
  const at = edge.from.indexOf('@')
  const source = nodes.get(at === -1 ? edge.from : edge.from.slice(0, at)), target = nodes.get(edge.to)
  const branch = at === -1 ? undefined : edge.from.slice(at + 1)
  if (!source || !target || (branch !== undefined && !source.branches?.includes(branch))) return null
  return { from: source, to: target, ...(branch === undefined ? {} : { branch }) }
}

/** Actual inspectRun DTO exposes outputs/value, NOT outcome.branch. Only a
 * succeeded condition's durable boolean value proves its configured branch.
 * humanDecision, malformed outputs and unknown decisions remain unproven. */
function provenControlPath(edge: ResolvedEdge, source: RunAttemptView): boolean {
  if (source.state !== 'succeeded') return false
  if (edge.branch === undefined) return true
  if (edge.from.kind !== 'condition' || !edge.from.condition || source.outputJson === undefined) return false
  try {
    const output: unknown = JSON.parse(source.outputJson)
    if (!output || typeof output !== 'object' || Array.isArray(output) || !Object.hasOwn(output, 'value')) return false
    const value = (output as { value: unknown }).value
    if (typeof value !== 'boolean') return false
    return edge.branch === (value ? edge.from.condition.trueBranch : edge.from.condition.falseBranch)
  } catch { return false }
}

/** Pure projection, with no scheduler, timers,
 * translated captions, geometry changes, editor writes or persisted facts. */
export function projectRuntimeMotion(input: RuntimeMotionInput): RuntimeMotionProjection {
  const matching = input.overlayEligible && input.snapshot !== null
  const runState = !matching ? 'idle' : runStates.includes(input.snapshot!.state as RunState) ? input.snapshot!.state as RunState : 'unknown'
  const loopsAllowed = matching && runState === 'running' && input.connectionState === 'connected'
    && input.visible && !input.reducedMotion && input.userMotion === 'on'
  const latest = latestAttempts(matching ? input.snapshot!.attempts : [])
  const nodeById = new Map(input.nodes.map(node => [node.id, node]))
  const anchors = new Set([input.hoveredNodeId, input.focusedNodeId].filter((id): id is string => typeof id === 'string' && nodeById.has(id)))
  const neighbors = new Set<string>()
  const edges = input.edges.map((edge, edgeIndex): EdgeMotion => {
    const resolved = resolveEdge(edge, nodeById)
    const related = !!resolved && (anchors.has(resolved.from.id) || anchors.has(resolved.to.id))
    if (related && resolved) { neighbors.add(resolved.from.id); neighbors.add(resolved.to.id) }
    const from = resolved ? latest.get(resolved.from.id) : undefined
    const to = resolved ? latest.get(resolved.to.id) : undefined
    const proven = !!resolved && !!from && !!to && active(to.state)
      && (edge.kind === 'data' ? from.state === 'succeeded' || from.state === 'running' : provenControlPath(resolved, from))
    return { edgeIndex, motion: loopsAllowed && proven ? 'pulse' : 'static', related }
  })
  const nodes = input.nodes.map((node): NodeMotion => {
    const attempt = latest.get(node.id)
    const state = attempt === null ? 'unknown' : !attempt ? 'idle'
      : attemptStates.includes(attempt.state as AttemptState) ? attempt.state as AttemptState : 'unknown'
    return { nodeId: node.id, state, motion: loopsAllowed && active(state) ? 'pulse' : 'static',
      relation: anchors.has(node.id) ? 'anchor' : neighbors.has(node.id) ? 'neighbor' : 'none' }
  })
  return { runState, loopsAllowed, nodes, edges }
}
