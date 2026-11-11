/** Frozen DTO -> XYFlow projection. Never load a live definition or write layout. */
import { projectLayoutCollisions, avoidGroupHeaders } from '../../authoring/logic/graph/layout-collisions.ts'
import { nodeContentMinimum, runtimeNodeMetrics } from '../../authoring/logic/graph/node-geometry.ts'
import type { NodeContentShape } from '../../authoring/logic/graph/node-geometry.ts'
import { effectivePortVisibility, connectedPortEdges } from '../../authoring/logic/graph/port-visibility.ts'
import type { Edge, Node } from '@xyflow/react'
import type { FrozenGraphView, InspectSessionValue } from '../../../../conversation/contracts.ts'
import type { TeamStageRuntime } from '../../../../host/teamstage-diagnostics.ts'
import type { ConversationSnapshot } from '../logic/conversation-controller.ts'
import { flowEdgeEndpoints } from '../../authoring/logic/graph/flow-geometry.ts'
import { projectRuntimeMotion } from '../../../shared/styles/runtime-motion.ts'
import type { MotionMode } from '../../../shared/styles/runtime-motion.ts'

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
  contentWidth: number
  minimumHeight: number
  portVisibility: { control: boolean; inputs: boolean; outputs: boolean }
  portEdgePriority: string[]
  controlOutputs: string[]
  memberActivities: TeamMemberActivity[]
  /** Present only for a single-attempt agentTask whose attempt owns a session:
   * the whole node then acts as the chat entry. Multi-attempt nodes go through
   * the explicit attempt picker instead. */
  chatSessionId?: string
  /** Every durable attempt by ordinal; the explicit picker is the only surface
   * that may select among them. Present when a node owns several attempts. */
  attemptChoices?: FrozenAttemptChoice[]
  /** Selected failed attempt fact rendered at node level; never a live retry. */
  failureNotice?: { attemptId: string; sessionId?: string; sourceSessionId?: string }
  /** Managed interaction waiting for input, surfaced without opening the picker. */
  managedWaiting?: boolean
}
export type FrozenAttemptChoice = {
  attemptId?: string
  attempt: number
  state: string
  sessionId?: string
  childRunId?: string
}
/** View-injected picker state and navigation callbacks; never persisted. */
export type FrozenPickerProps = {
  pickerOpen?: boolean
  onPickAttempt?: (attemptId: string) => void
  onOpenAttemptChat?: (attemptId: string) => void
  onOpenChildRun?: (runId: string) => void
  onOpenSourceChat?: (sessionId: string) => void
}
export type TeamMemberActivity = {
  memberId: string
  label: string
  activity: TeamStageRuntime['members'][number]['activity'] | 'unavailable'
  elapsedSeconds?: number
}
export type FrozenFlowNode = Node<FrozenNodeData, 'frozen'>
export type FrozenEdgeData = { points: Array<{ x: number; y: number }>; motion: MotionMode; traversed: boolean }
export type FrozenFlowEdge = Edge<FrozenEdgeData, 'frozen'>
export type FrozenGroupNode = Node<{ groupId: string; label: string; nodeIds: string[] }, 'frozenGroup'>

/** Read-only nodes are not wiring targets: the runtime seat measures the dense
 * caption geometry instead of the authoring 40 px port rows. */
export const frozenNodeMinimum = (shape: NodeContentShape): { width: number; height: number } => nodeContentMinimum(shape, runtimeNodeMetrics)

/** Ordinals are facts; array position is not a tie-breaker for latest state. */
function latestNodeAttempt(attempts: Extract<InspectSessionValue, { status: 'bound' }>['selected']['run']['attempts']) {
  if (attempts.length === 1) return attempts[0]
  const valid = attempts.filter(attempt => Number.isSafeInteger(attempt.attempt) && attempt.attempt > 0)
  const highest = Math.max(...valid.map(attempt => attempt.attempt))
  const latest = valid.filter(attempt => attempt.attempt === highest)
  return latest.length === 1 ? latest[0] : undefined
}

export function projectFrozenCanvas(
  snapshot: ConversationSnapshot,
  reducedMotion: boolean,
  visible: boolean,
  measurements: ReadonlyMap<string, { width: number; height: number }> = new Map()
): {
  nodes: FrozenFlowNode[]
  edges: FrozenFlowEdge[]
  groups: FrozenGroupNode[]
  collisionNodeIds?: string[]
} {
  const value = snapshot.value
  if (value?.status !== 'bound') return { nodes: [], edges: [], groups: [] }
  const { graph, presentation, run, focusAttemptIds } = value.selected
  // The frozen codec's optional fields permit explicit undefined; the legacy
  // motion projection uses exact optional types. Adapt only fields it reads.
  const motionNodes = graph.nodes.map(node => ({
    id: node.id,
    kind: node.kind,
    ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
    ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
    ...(node.branches === undefined ? {} : { branches: node.branches })
  }))
  const latest = new Map(
    graph.nodes.map(node => {
      const attempts = run.attempts.filter(attempt => attempt.nodeId === node.id)
      return [node.id, { attempts, attempt: latestNodeAttempt(attempts) }] as const
    })
  )
  const motionRun = {
    ...run,
    attempts: graph.nodes.flatMap(node => {
      const { attempts, attempt } = latest.get(node.id)!
      return attempt
        ? [{ nodeId: node.id, state: attempt.state, attempt: attempt.attempt, ...(attempt.outputJson === undefined ? {} : { outputJson: attempt.outputJson }) }]
        : attempts.length
          ? [{ nodeId: node.id, state: 'unknown', attempt: 1 }]
          : []
    })
  }
  const motion = projectRuntimeMotion({
    nodes: motionNodes,
    edges: graph.edges,
    snapshot: motionRun,
    overlayEligible: true,
    connectionState: snapshot.connection === 'connected' ? 'connected' : 'stale',
    visible,
    reducedMotion,
    userMotion: 'on'
  })
  const focuses = new Set(focusAttemptIds)
  const memberActivities = conversationTeamMembers(snapshot)
  // Latest-attempt failure facts feed edge marker semantics; a stale/unknown
  // attempt never counts as failed.
  const motionFailure = new Map(
    graph.nodes.map(node => {
      const { attempt } = latest.get(node.id)!
      return [node.id, attempt?.state === 'failed' || attempt?.state === 'timed_out'] as const
    })
  )
  const nodes: FrozenFlowNode[] = graph.nodes.map((node, index) => {
    const layout = presentation?.nodes[node.id]
    const { attempts, attempt } = latest.get(node.id)!
    const projected = motion.nodes[index]!
    const visibility = effectivePortVisibility(
      {
        id: node.id,
        kind: node.kind,
        ...(node.inputs ? { inputs: node.inputs } : {}),
        ...(node.outputs ? { outputs: node.outputs } : {}),
        ...(node.branches ? { branches: node.branches } : {}),
        ...(layout?.ports
          ? {
              presentation: {
                ports: {
                  ...(layout.ports.control === undefined ? {} : { control: layout.ports.control }),
                  ...(layout.ports.inputs === undefined ? {} : { inputs: layout.ports.inputs }),
                  ...(layout.ports.outputs === undefined ? {} : { outputs: layout.ports.outputs })
                }
              }
            }
          : {})
      },
      graph.edges
    )
    const minimum = frozenNodeMinimum({
      title: layout?.title ?? node.id,
      state: projected.state,
      inputs: node.inputs ?? {},
      outputs: node.outputs ?? {},
      controlOutputs: node.branches ?? ['control'],
      visibility
    })
    return {
      id: node.id,
      type: 'frozen',
      position: layout ? { x: layout.x, y: layout.y } : { x: index * 280, y: 80 },
      draggable: false,
      connectable: false,
      deletable: false,
      style: { width: Math.max(220, layout?.width ?? 220), minHeight: Math.max(minimum.height, layout?.height ?? 0) },
      data: {
        contentWidth: Math.max(220, layout?.width ?? 220),
        minimumHeight: layout?.height ?? 0,
        node,
        title: layout?.title ?? node.id,
        state: projected.state,
        rawState: attempt?.state ?? (attempts.length ? 'unknown' : 'idle'),
        motion: projected.motion,
        focused: attempts.some(attempt => attempt.attemptId !== undefined && focuses.has(attempt.attemptId)),
        attemptIds: attempts.flatMap(attempt => (attempt.attemptId === undefined ? [] : [attempt.attemptId])),
        collapsed: layout?.collapsed ?? false,
        color: layout?.color ?? 'default',
        memberActivities: run.team?.stageId === node.id && run.team.attemptId === attempt?.attemptId ? memberActivities : [],
        portVisibility: effectivePortVisibility(
          {
            id: node.id,
            kind: node.kind,
            ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
            ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
            ...(node.branches === undefined ? {} : { branches: node.branches }),
            ...(layout?.ports === undefined
              ? {}
              : {
                  presentation: {
                    ports: {
                      ...(layout.ports.control === undefined ? {} : { control: layout.ports.control }),
                      ...(layout.ports.inputs === undefined ? {} : { inputs: layout.ports.inputs }),
                      ...(layout.ports.outputs === undefined ? {} : { outputs: layout.ports.outputs })
                    }
                  }
                })
          },
          graph.edges
        ),
        portEdgePriority: (['control', 'inputs', 'outputs'] as const).filter(
          side => layout?.ports?.[side] === false && connectedPortEdges(node.id, side, graph.edges) > 0
        ),
        controlOutputs: [
          ...new Set([
            'control',
            ...(node.branches ?? []),
            ...graph.edges.flatMap(edge => {
              if (edge.kind !== 'control') return []
              const endpoint = flowEdgeEndpoints(edge)
              return endpoint.source === node.id ? [endpoint.sourceHandle.slice('control:'.length)] : []
            })
          ])
        ],
        ...(node.kind === 'agentTask' && attempts.length === 1 && attempt?.attemptId !== undefined && attempt.sessionId !== undefined
          ? { chatSessionId: attempt.sessionId }
          : {}),
        ...(attempts.length > 1
          ? {
              attemptChoices: [...attempts]
                .filter(choice => Number.isSafeInteger(choice.attempt) && choice.attempt > 0)
                .sort((a, b) => a.attempt - b.attempt)
                .map(choice => ({
                  ...(choice.attemptId === undefined ? {} : { attemptId: choice.attemptId }),
                  attempt: choice.attempt,
                  state: choice.state,
                  ...(choice.sessionId === undefined ? {} : { sessionId: choice.sessionId }),
                  ...(choice.childRunId === undefined ? {} : { childRunId: choice.childRunId })
                }))
            }
          : {}),
        ...(attempt?.attemptId !== undefined &&
        attempt.attemptId === snapshot.selectedAttemptId &&
        (attempt.state === 'failed' || attempt.state === 'timed_out')
          ? {
              failureNotice: {
                attemptId: attempt.attemptId,
                ...(attempt.sessionId === undefined ? {} : { sessionId: attempt.sessionId }),
                ...(value.selected.source?.sessionId === undefined ? {} : { sourceSessionId: value.selected.source.sessionId })
              }
            }
          : {}),
        ...(node.interaction === 'managed' && attempt?.state === 'waiting_input' ? { managedWaiting: true } : {})
      }
    }
  })
  const collision = projectLayoutCollisions(
    nodes.map(node => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: measurements.get(node.id)?.width ?? Number(node.style!.width),
      height: Math.max(Number(node.style!.minHeight), measurements.get(node.id)?.height ?? 0),
      pinned: presentation?.nodes[node.id]?.pinned ?? false
    }))
  )
  if (collision.ok) for (const node of nodes) node.position = collision.positions.get(node.id)!
  const edges: FrozenFlowEdge[] = graph.edges.map((edge, index) => {
    const route = presentation?.edges?.find(item => item.kind === edge.kind && item.from === edge.from && item.to === edge.to)
    const motionEdge = motion.edges[index]!
    // Marker color is a concrete SVG paint, not a CSS variable context: use the
    // dark-first token fallbacks. Semantics: active flow > traversed > failed source.
    const markerColor =
      motionEdge.motion === 'pulse' ? '#679abc' : motionEdge.traversed ? '#34d399' : motionFailure.get(flowEdgeEndpoints(edge).source) ? '#c46b6b' : '#939aa4'
    return {
      id: `frozen-edge-${index}`,
      ...flowEdgeEndpoints(edge),
      type: 'frozen',
      selectable: false,
      deletable: false,
      animated: false,
      markerEnd: { type: 'arrowclosed', width: 14, height: 14, color: markerColor },
      className: [
        edge.kind === 'control' ? 'bp-edge-control' : '',
        motionEdge.motion === 'pulse' ? 'bp-edge-motion' : '',
        motionEdge.traversed ? 'bp-edge-traversed' : ''
      ]
        .filter(Boolean)
        .join(' '),
      data: { points: collision.ok && collision.changed ? [] : (route?.points ?? []), motion: motionEdge.motion, traversed: motionEdge.traversed }
    }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  const used = new Set(nodes.map(node => node.id))
  const groups: FrozenGroupNode[] = []
  for (const group of presentation?.groups ?? []) {
    const members = [...new Set(group.nodeIds)].flatMap(id => (byId.has(id) ? [byId.get(id)!] : []))
    if (!members.length) continue
    const left = Math.min(...members.map(node => node.position.x)),
      top = Math.min(...members.map(node => node.position.y))
    const right = Math.max(...members.map(node => node.position.x + Math.max(Number(node.style!.width), measurements.get(node.id)?.width ?? 0)))
    const bottom = Math.max(
      ...members.map(node => {
        const minimum = frozenNodeMinimum({
          title: node.data.title,
          state: node.data.state,
          inputs: node.data.node.inputs ?? {},
          outputs: node.data.node.outputs ?? {},
          controlOutputs: node.data.controlOutputs,
          visibility: node.data.portVisibility,
          members: node.data.memberActivities.map(member => member.label)
        })
        return node.position.y + Math.max(node.data.minimumHeight, minimum.height, measurements.get(node.id)?.height ?? 0)
      })
    )
    let id = `bp:frozen-group:${group.id}`
    while (used.has(id)) id += ':'
    used.add(id)
    // Same display margin/header as workspace group frames; no domain budget changes.
    groups.push({
      id,
      type: 'frozenGroup',
      position: { x: left - 24, y: top - 68 },
      style: { width: right - left + 48, height: bottom - top + 92, pointerEvents: 'none' },
      zIndex: -1,
      draggable: false,
      connectable: false,
      deletable: false,
      selectable: false,
      focusable: false,
      data: { groupId: group.id, label: group.label ?? group.id, nodeIds: members.map(node => node.id) }
    })
  }
  const headers = avoidGroupHeaders(
    groups.map(group => ({
      id: group.id,
      nodeIds: group.data.nodeIds,
      x: group.position.x,
      y: group.position.y,
      width: Number(group.style!.width),
      height: Number(group.style!.height)
    })),
    nodes.map(node => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: measurements.get(node.id)?.width ?? Number(node.style!.width),
      height: Math.max(Number(node.style!.minHeight), measurements.get(node.id)?.height ?? 0)
    }))
  )
  for (const group of groups) {
    const frame = headers.find(header => header.id === group.id)!
    group.position = { x: frame.x, y: frame.y }
    group.style = { ...group.style, height: frame.height }
  }
  return { nodes, edges, groups, ...(!collision.ok ? { collisionNodeIds: collision.nodeIds } : {}) }
}

/** Missing/stale observations never imply a model is thinking or a member is idle. */
export function conversationTeamMembers(snapshot: ConversationSnapshot): TeamMemberActivity[] {
  if (snapshot.value?.status !== 'bound') return []
  const run = snapshot.value.selected.run
  const team = run.team
  if (!team) return []
  const attempt = run.attempts.find(value => value.attemptId === team.attemptId && value.nodeId === team.stageId)
  const live =
    snapshot.connection === 'connected' &&
    run.state === 'running' &&
    team.state === 'active' &&
    attempt?.state === 'running' &&
    team.runtime?.attemptId === team.attemptId
  return team.members.map(member => {
    const observation =
      live && member.phase === 'active'
        ? team.runtime?.members.find(value => value.memberId === member.memberId && value.sessionId === member.sessionId)
        : undefined
    return {
      memberId: member.memberId,
      label: member.name ?? member.memberId,
      activity: observation?.activity ?? 'unavailable',
      ...(observation?.requestStartedAt === undefined || observation.activity === 'idle'
        ? {}
        : {
            elapsedSeconds: Math.max(0, Math.floor((team.runtime!.observedAt - observation.requestStartedAt) / 1000))
          })
    }
  })
}

/** Tool inspector is owner-scoped. A Call from another Session cannot be addressed by this seat. */
export function conversationInspectableCall(value: InspectSessionValue | null, sessionId: string): string | undefined {
  if (value?.status !== 'bound') return undefined
  const source = value.selected.source
  return source?.kind === 'tool' && source.sessionId === sessionId ? source.callId : undefined
}
