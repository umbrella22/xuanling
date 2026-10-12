/** Frozen DTO -> XYFlow projection. Never load a live definition or write layout. */
import type { Edge, Node } from '@xyflow/react'
import type { FrozenGraphView, InspectSessionValue } from '../conversation/contracts.ts'
import type { TeamStageRuntime } from '../host/teamstage-diagnostics.ts'
import type { ConversationSnapshot } from './conversation-controller.ts'
import { flowEdgeEndpoints } from './flow-geometry.ts'
import { projectRuntimeMotion } from './runtime-motion.ts'
import { PALETTE_NODE_FOOTPRINT } from './node-placement.ts'

export type FrozenNodeData = {
  node: FrozenGraphView['nodes'][number]
  title: string
  state: string
  rawState: string
  motion: 'static' | 'pulse'
  focused: boolean
  attemptIds: string[]
  collapsed: boolean
  color: string
  controlOutputs: string[]
  memberActivities: TeamMemberActivity[]
}
export type TeamMemberActivity = { memberId: string; label: string; activity: TeamStageRuntime['members'][number]['activity'] | 'unavailable'; elapsedSeconds?: number }
export type FrozenFlowNode = Node<FrozenNodeData, 'frozen'>
export type FrozenEdgeData = { points: Array<{ x: number; y: number }> }
export type FrozenFlowEdge = Edge<FrozenEdgeData, 'frozen'>
export type FrozenGroupNode = Node<{ groupId: string; label: string; nodeIds: string[] }, 'frozenGroup'>

/** Ordinals are facts; array position is not a tie-breaker for latest state. */
function latestNodeAttempt(attempts: Extract<InspectSessionValue, { status: 'bound' }>['selected']['run']['attempts']) {
  if (attempts.length === 1) return attempts[0]
  const valid = attempts.filter(attempt => Number.isSafeInteger(attempt.attempt) && attempt.attempt > 0)
  const highest = Math.max(...valid.map(attempt => attempt.attempt))
  const latest = valid.filter(attempt => attempt.attempt === highest)
  return latest.length === 1 ? latest[0] : undefined
}

export function projectFrozenCanvas(snapshot: ConversationSnapshot, reducedMotion: boolean, visible: boolean): {
  nodes: FrozenFlowNode[]; edges: FrozenFlowEdge[]; groups: FrozenGroupNode[]
} {
  const value = snapshot.value
  if (value?.status !== 'bound') return { nodes: [], edges: [], groups: [] }
  const { graph, presentation, run, focusAttemptIds } = value.selected
  // The frozen codec's optional fields permit explicit undefined; the legacy
  // motion projection uses exact optional types. Adapt only fields it reads.
  const motionNodes = graph.nodes.map(node => ({ id: node.id, kind: node.kind,
    ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
    ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
    ...(node.branches === undefined ? {} : { branches: node.branches }) }))
  const latest = new Map(graph.nodes.map(node => {
    const attempts = run.attempts.filter(attempt => attempt.nodeId === node.id)
    return [node.id, { attempts, attempt: latestNodeAttempt(attempts) }] as const
  }))
  const motionRun = { ...run, attempts: graph.nodes.flatMap(node => {
    const { attempts, attempt } = latest.get(node.id)!
    return attempt ? [{ nodeId: node.id, state: attempt.state, attempt: attempt.attempt,
      ...(attempt.outputJson === undefined ? {} : { outputJson: attempt.outputJson }) }]
      : attempts.length ? [{ nodeId: node.id, state: 'unknown', attempt: 1 }] : []
  }) }
  const motion = projectRuntimeMotion({ nodes: motionNodes, edges: graph.edges, snapshot: motionRun,
    overlayEligible: true, connectionState: snapshot.connection === 'connected' ? 'connected' : 'stale',
    visible, reducedMotion, userMotion: 'on' })
  const focuses = new Set(focusAttemptIds)
  const memberActivities = conversationTeamMembers(snapshot)
  const nodes: FrozenFlowNode[] = graph.nodes.map((node, index) => {
    const layout = presentation?.nodes[node.id]
    const { attempts, attempt } = latest.get(node.id)!
    const projected = motion.nodes[index]!
    return { id: node.id, type: 'frozen', position: layout ? { x: layout.x, y: layout.y } : { x: index * 280, y: 80 },
      draggable: false, connectable: false, deletable: false,
      style: { width: layout?.width && layout.width > 0 ? layout.width : 220,
        ...(layout?.height && layout.height > 0 ? { height: layout.height } : {}) },
      data: { node, title: layout?.title ?? node.id, state: projected.state,
        rawState: attempt?.state ?? (attempts.length ? 'unknown' : 'idle'), motion: projected.motion,
        focused: attempts.some(attempt => attempt.attemptId !== undefined && focuses.has(attempt.attemptId)),
        attemptIds: attempts.flatMap(attempt => attempt.attemptId === undefined ? [] : [attempt.attemptId]),
        collapsed: layout?.collapsed ?? false, color: layout?.color ?? 'default',
        memberActivities: run.team?.stageId === node.id && run.team.attemptId === attempt?.attemptId ? memberActivities : [],
        controlOutputs: [...new Set(['control', ...(node.branches ?? []), ...graph.edges.flatMap(edge => {
          if (edge.kind !== 'control') return []
          const endpoint = flowEdgeEndpoints(edge)
          return endpoint.source === node.id ? [endpoint.sourceHandle.slice('control:'.length)] : []
        })])] } }
  })
  const edges: FrozenFlowEdge[] = graph.edges.map((edge, index) => {
    const route = presentation?.edges?.find(item => item.kind === edge.kind && item.from === edge.from && item.to === edge.to)
    return { id: `frozen-edge-${index}`, ...flowEdgeEndpoints(edge), type: 'frozen',
      selectable: false, deletable: false, animated: false, className: edge.kind === 'control' ? 'bp-edge-control' : '',
      data: { points: route?.points ?? [] } }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const used = new Set(nodes.map(node => node.id))
  const groups: FrozenGroupNode[] = []
  for (const group of presentation?.groups ?? []) {
    const members = [...new Set(group.nodeIds)].flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
    if (!members.length) continue
    const left = Math.min(...members.map(node => node.position.x)), top = Math.min(...members.map(node => node.position.y))
    const right = Math.max(...members.map(node => node.position.x + Number(node.style!.width)))
    const bottom = Math.max(...members.map(node => {
      const dataRows = Math.max(1, Object.keys(node.data.node.inputs ?? {}).length, Object.keys(node.data.node.outputs ?? {}).length)
      const controlRows = Math.max(1, node.data.controlOutputs.length)
      return node.position.y + Number(node.style!.height ?? PALETTE_NODE_FOOTPRINT.height + (dataRows + controlRows - 2) * 40)
    }))
    let id = `bp:frozen-group:${group.id}`
    while (used.has(id)) id += ':'
    used.add(id)
    // Same display margin/header as workspace group frames; no domain budget changes.
    groups.push({ id, type: 'frozenGroup', position: { x: left - 24, y: top - 68 },
      style: { width: right - left + 48, height: bottom - top + 92, pointerEvents: 'none' }, zIndex: -1,
      draggable: false, connectable: false, deletable: false, selectable: false, focusable: false,
      data: { groupId: group.id, label: group.label ?? group.id, nodeIds: members.map(node => node.id) } })
  }
  return { nodes, edges, groups }
}

/** Missing/stale observations never imply a model is thinking or a member is idle. */
export function conversationTeamMembers(snapshot: ConversationSnapshot): TeamMemberActivity[] {
  if (snapshot.value?.status !== 'bound') return []
  const run = snapshot.value.selected.run
  const team = run.team
  if (!team) return []
  const attempt = run.attempts.find(value => value.attemptId === team.attemptId && value.nodeId === team.stageId)
  const live = snapshot.connection === 'connected' && run.state === 'running' && team.state === 'active'
    && attempt?.state === 'running' && team.runtime?.attemptId === team.attemptId
  return team.members.map(member => {
    const observation = live && member.phase === 'active' ? team.runtime?.members.find(value => value.memberId === member.memberId && value.sessionId === member.sessionId) : undefined
    return { memberId: member.memberId, label: member.name ?? member.memberId, activity: observation?.activity ?? 'unavailable',
      ...(observation?.requestStartedAt === undefined || observation.activity === 'idle' ? {} : {
        elapsedSeconds: Math.max(0, Math.floor((team.runtime!.observedAt - observation.requestStartedAt) / 1000)),
      }) }
  })
}

/** Tool inspector is owner-scoped. A Call from another Session cannot be addressed by this seat. */
export function conversationInspectableCall(value: InspectSessionValue | null, sessionId: string): string | undefined {
  if (value?.status !== 'bound') return undefined
  const source = value.selected.source
  return source?.kind === 'tool' && source.sessionId === sessionId ? source.callId : undefined
}
