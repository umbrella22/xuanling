import { StyledSelect } from './styled-controls.ts'
import React from 'react'
import { nodeContentKey, nodeContentMinimum, useNodeContentMeasurement } from './node-geometry.ts'
import { ReactFlow, Handle, Position, BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps, NodeProps, ReactFlowInstance } from '@xyflow/react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { BlueprintLocaleProps, BlueprintLocaleKey } from './locales.ts'
import { en } from './locales.ts'
import { blueprintIcon } from './icons.ts'
import { conversationFocusNodes } from './conversation-controller.ts'
import type { ConversationController } from './conversation-controller.ts'
import { conversationInspectableCall, conversationTeamMembers, projectFrozenCanvas } from './conversation-canvas.ts'
import type { FrozenFlowNode, FrozenFlowEdge, FrozenNodeData, FrozenGroupNode } from './conversation-canvas.ts'
import type { TeamMemberActivity } from './conversation-canvas.ts'
import type { TeamStageProjection } from '../conversation/contracts.ts'
import { installCanvasStyles } from './styles.ts'
import { installConversationStyles } from './conversation-styles.ts'
import { flowAriaLabels } from './presentation.ts'
import type { ChatNavigation, OpenExecutionChat } from './chat-navigation.ts'

export interface ConversationViewInjected {
  controller: ConversationController
  openSession?: OpenExecutionChat
  chatNavigation?: ChatNavigation
}
const noChatRequest = () => null
const noChatSubscription = () => () => {}
type Props = ConvViewProps & BlueprintLocaleProps & ConversationViewInjected
type DisplayNode = FrozenFlowNode & { data: FrozenNodeData & { t: BlueprintLocaleProps['t']; onContentMeasure?: (height: number) => void } }
type DisplayGroup = FrozenGroupNode & { data: FrozenGroupNode['data'] & { t: BlueprintLocaleProps['t'] } }
type DisplayFlowNode = DisplayNode | DisplayGroup

function frozenContentShape(data: FrozenNodeData & { t: BlueprintLocaleProps['t'] }) {
  const { node, t } = data
  return {
    title: `${t(`conversation.kind.${node.kind}`)} ${data.title}`,
    ...(data.portEdgePriority.length ? { note: t('port.connectedVisible') } : {}),
    state: displayState(data.state, t),
    members: data.memberActivities.map(member => `${member.label} · ${t(`conversation.activity.${member.activity}`)}`),
    inputs: node.inputs ?? {},
    outputs: node.outputs ?? {},
    controlOutputs: data.controlOutputs,
    visibility: data.portVisibility
  }
}

function FrozenNode({ data, selected }: NodeProps<DisplayNode>): React.ReactElement {
  const { node, t } = data
  const shape = frozenContentShape(data)
  const content = useNodeContentMeasurement(nodeContentKey(shape, data.contentWidth), React, data.onContentMeasure)
  const port = (name: string, kind: 'data' | 'control', direction: 'input' | 'output') =>
    React.createElement(
      'div',
      {
        key: `${kind}:${name}`,
        className: `bp-port-row ${direction === 'output' ? 'bp-port-out' : ''}`
      },
      React.createElement(Handle, {
        type: direction === 'input' ? 'target' : 'source',
        position: direction === 'input' ? Position.Left : Position.Right,
        id: `${kind}:${name}`,
        isConnectable: false,
        className: kind === 'control' ? 'bp-handle-control' : '',
        'aria-label': t('node.portAria', { nodeId: node.id, direction: t(`port.${direction}`), kind: t(`port.${kind}`), port: name })
      }),
      React.createElement('span', null, name)
    )
  return React.createElement(
    'article',
    {
      className: `bp-node ${selected ? 'bp-node-selected' : ''}`,
      'data-bp-node': node.id,
      'data-bp-raw-state': data.rawState,
      'data-bp-state': data.state,
      'data-bp-motion': data.motion,
      'data-bp-focus': data.focused,
      'data-bp-color': data.color,
      'data-bp-collapsed': data.collapsed,
      style: { height: 'auto', minHeight: Math.max(nodeContentMinimum(shape).height, data.minimumHeight, content.height ?? 0) }
    },
    React.createElement(
      'div',
      { ref: content.ref, 'data-bp-node-content': node.id },
      React.createElement(
        'div',
        { className: 'bp-node-title' },
        React.createElement('strong', null, data.title),
        React.createElement('small', { className: 'bp-kind' }, t(`conversation.kind.${node.kind}`))
      ),
      React.createElement('div', { className: 'bp-node-state' }, displayState(data.state, t)),
      ...data.memberActivities.map(member =>
        React.createElement(
          'div',
          { key: member.memberId, className: 'bp-member-activity', 'data-bp-node-member': member.memberId, 'data-bp-activity': member.activity },
          `${member.label} · ${t(`conversation.activity.${member.activity}`)}`
        )
      ),
      data.portEdgePriority.length > 0 &&
        React.createElement('div', { 'data-bp-port-edge-priority': data.portEdgePriority.join(','), className: 'bp-node-note' }, t('port.connectedVisible')),
      (data.portVisibility.inputs || data.portVisibility.outputs) &&
        React.createElement(
          'div',
          { className: 'bp-port-columns' },
          React.createElement('div', null, ...Object.keys(data.portVisibility.inputs ? (node.inputs ?? {}) : {}).map(name => port(name, 'data', 'input'))),
          React.createElement('div', null, ...Object.keys(data.portVisibility.outputs ? (node.outputs ?? {}) : {}).map(name => port(name, 'data', 'output')))
        ),
      data.portVisibility.control &&
        React.createElement(
          'div',
          { className: 'bp-port-columns bp-control-ports' },
          React.createElement('div', null, port('control', 'control', 'input')),
          React.createElement('div', null, ...data.controlOutputs.map(name => port(name, 'control', 'output')))
        )
    ),
    data.motion === 'pulse' ? React.createElement('div', { className: 'bp-node-emphasis', 'aria-hidden': true }) : null
  )
}

function FrozenGroup({ data }: NodeProps<DisplayGroup>): React.ReactElement {
  return React.createElement(
    'div',
    { className: 'bp-group-frame', 'data-bp-group': data.groupId, role: 'group', 'aria-label': data.t('group.ariaLabel', { label: data.label }) },
    React.createElement(
      'div',
      { className: 'bp-group-header' },
      React.createElement('strong', { title: data.label, tabIndex: 0, style: { pointerEvents: 'auto' } }, data.label),
      React.createElement('span', null, data.t('group.memberCount', { count: data.nodeIds.length }))
    )
  )
}

function FrozenEdge(props: EdgeProps<FrozenFlowEdge>): React.ReactElement {
  const points = props.data?.points ?? []
  const path = points.length
    ? `M ${props.sourceX} ${props.sourceY} ${points.map(point => `L ${point.x} ${point.y}`).join(' ')} L ${props.targetX} ${props.targetY}`
    : getSmoothStepPath(props)[0]
  return React.createElement(BaseEdge, { id: props.id, path, style: props.style, interactionWidth: 0 })
}
const nodeTypes = { frozen: FrozenNode, frozenGroup: FrozenGroup }
const edgeTypes = { frozen: FrozenEdge }

function displayState(state: string, t: BlueprintLocaleProps['t']): string {
  const key = `state.${state}`
  if (Object.hasOwn(en, key)) return t(key as BlueprintLocaleKey)
  return state === 'idle' ? t('node.notRunning') : t('node.unknownState')
}

function renderTeamStage(
  team: TeamStageProjection,
  activities: TeamMemberActivity[],
  connected: boolean,
  t: BlueprintLocaleProps['t'],
  openChat?: (sessionId: string) => void
): React.ReactElement {
  const fact = (label: BlueprintLocaleKey, value: string, attributes: Record<string, string | number | undefined> = {}) =>
    React.createElement(
      'div',
      { key: label, ...attributes },
      React.createElement('dt', null, t(label)),
      React.createElement('dd', null, React.createElement('code', null, value))
    )
  const stageState = ['provisioning', 'active'].includes(team.state)
    ? t(`conversation.team.state.${team.state}` as BlueprintLocaleKey)
    : displayState(team.state, t)
  return React.createElement(
    'section',
    {
      className: 'bp-team-stage',
      'aria-label': t('conversation.teamStage'),
      'data-bp-team-stage': team.stageId,
      'data-bp-team-run': team.runId,
      'data-bp-team-state': team.state,
      'data-bp-team-observation': connected ? 'current' : 'stale'
    },
    React.createElement(
      'div',
      { className: 'bp-team-heading' },
      React.createElement('strong', null, t('conversation.teamStage')),
      React.createElement('span', { className: 'bp-team-state' }, stageState)
    ),
    React.createElement('code', { className: 'bp-team-stage-id' }, team.stageId),
    connected ? null : React.createElement('p', { className: 'bp-team-stale', role: 'status' }, t('conversation.team.stale')),
    React.createElement(
      'dl',
      { className: 'bp-team-facts' },
      fact('conversation.team.lead', team.leadSessionId),
      fact('conversation.team.run', team.runId),
      ...(team.taskId === undefined
        ? []
        : [
            fact('conversation.team.task', team.taskId, {
              'data-bp-team-task-id': team.taskId,
              'data-bp-team-task-revision': team.taskRevision
            })
          ])
    ),
    team.taskRevision === undefined ? null : React.createElement('small', null, t('conversation.team.revision', { revision: team.taskRevision })),
    React.createElement(
      'div',
      { className: 'bp-team-activity', 'aria-label': t('conversation.teamActivity') },
      React.createElement('strong', null, t('conversation.team.members')),
      ...team.members.map(member => {
        const activity = activities.find(value => value.memberId === member.memberId)
        return React.createElement(
          'div',
          {
            key: member.memberId,
            className: 'bp-team-member',
            'data-bp-member-id': member.memberId,
            'data-bp-member-phase': member.phase,
            'data-bp-member-status': member.status,
            'data-bp-member-session': member.sessionId,
            'data-bp-activity': activity?.activity ?? 'unavailable'
          },
          React.createElement('span', null, member.name ?? member.memberId),
          React.createElement(
            'small',
            null,
            t(`conversation.team.phase.${member.phase}`),
            ' · ',
            member.status === 'inactive' ? t('conversation.team.status.inactive') : displayState(member.status, t)
          ),
          React.createElement(
            'small',
            null,
            t(`conversation.activity.${activity?.activity ?? 'unavailable'}`),
            activity?.elapsedSeconds === undefined ? '' : ` · ${t('conversation.activity.elapsed', { seconds: activity.elapsedSeconds })}`
          ),
          member.sessionId === undefined ? null : React.createElement('code', null, member.sessionId),
          openChat &&
            React.createElement(
              'button',
              {
                type: 'button',
                'data-bp-open-member': member.memberId,
                disabled: member.sessionId === undefined,
                onClick: () => {
                  if (member.sessionId !== undefined) openChat(member.sessionId)
                }
              },
              t('conversation.openChat')
            )
        )
      })
    ),
    team.outputAcceptance === undefined
      ? null
      : React.createElement(
          'details',
          { className: 'bp-team-evidence', 'data-bp-team-acceptance': team.outputAcceptance.code },
          React.createElement('summary', null, t('conversation.team.acceptance'), ' · ', t(`conversation.team.acceptance.${team.outputAcceptance.code}`)),
          React.createElement(
            'dl',
            { className: 'bp-team-facts' },
            fact('conversation.team.artifact', team.outputAcceptance.artifactId),
            fact('conversation.team.producer', team.outputAcceptance.sourceSessionId),
            fact('conversation.team.digest', team.outputAcceptance.digest),
            ...(team.outputAcceptance.issueCode === undefined ? [] : [fact('conversation.team.reason', team.outputAcceptance.issueCode)])
          ),
          React.createElement('strong', null, t('conversation.team.checks')),
          React.createElement('ul', null, ...team.outputAcceptance.checks.map(check => React.createElement('li', { key: check }, check)))
        ),
    team.recovery === undefined ? null : React.createElement('dl', { className: 'bp-team-facts' }, fact('conversation.team.reason', team.recovery.code))
  )
}

/** DSH owns the resident composer and pendingInteraction. This seat only observes durable Runs. */
export function ConversationBlueprintView({ controller, sessionId, t, inspectCall, openSession, chatNavigation, openView }: Props): React.ReactElement {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const chatRequest = React.useSyncExternalStore(chatNavigation?.subscribe ?? noChatSubscription, chatNavigation?.getSnapshot ?? noChatRequest, noChatRequest)
  const [chatUnavailable, setChatUnavailable] = React.useState(false)
  React.useEffect(() => {
    if (chatRequest?.sessionId === sessionId && openView && chatNavigation?.consume(sessionId, chatRequest.requestId)) openView('chat', '')
  }, [chatRequest, chatNavigation, sessionId, openView])
  const openChat = (target: string) => {
    void Promise.resolve(openSession?.(target, snapshot.value?.status === 'bound' ? snapshot.value.selected.source?.sessionId : undefined)).then(
      opened => setChatUnavailable(opened !== true),
      () => setChatUnavailable(true)
    )
  }
  const flow = React.useRef<ReactFlowInstance<DisplayFlowNode, FrozenFlowEdge> | null>(null)
  const [reducedMotion, setReducedMotion] = React.useState(() => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [visible, setVisible] = React.useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  React.useEffect(() => {
    installCanvasStyles()
    installConversationStyles()
    controller.setSession(sessionId)
    controller.resume()
    const refresh = () => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        controller.markStale()
        return
      }
      void controller.poll()
    }
    refresh()
    const timer = setInterval(refresh, 1500)
    const offline = () => {
      controller.markStale()
    }
    const visibility = () => {
      setVisible(document.visibilityState !== 'hidden')
    }
    const media = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-reduced-motion: reduce)')
    const motion = () => {
      setReducedMotion(media?.matches ?? false)
    }
    globalThis.addEventListener?.('offline', offline)
    globalThis.addEventListener?.('online', refresh)
    document.addEventListener('visibilitychange', visibility)
    media?.addEventListener('change', motion)
    return () => {
      clearInterval(timer)
      controller.pause()
      globalThis.removeEventListener?.('offline', offline)
      globalThis.removeEventListener?.('online', refresh)
      document.removeEventListener('visibilitychange', visibility)
      media?.removeEventListener('change', motion)
    }
  }, [controller, sessionId])

  // Guard the render before effect cleanup when the host replaces the scope.
  const value = snapshot.sessionId === sessionId ? snapshot.value : null
  const connection = snapshot.sessionId === sessionId ? snapshot.connection : 'loading'
  const bound = value?.status === 'bound' ? value : null
  const measurementCache = React.useRef<{
    identity: string
    shapes: Map<string, string>
    content: Map<string, { width: number; height: number }>
    flow: Map<string, { width: number; height: number }>
  }>({ identity: '', shapes: new Map(), content: new Map(), flow: new Map() })
  const flowIdentity = React.useRef<string | null>(null)
  const fittedIdentity = React.useRef<string | null>(null)
  const fittingIdentity = React.useRef<string | null>(null)
  const [measurementVersion, measurementTick] = React.useState(0)
  const identity = bound ? JSON.stringify([sessionId, bound.selected.run.runId, bound.selected.run.definitionRevision]) : ''
  if (measurementCache.current.identity !== identity) {
    measurementCache.current = { identity, shapes: new Map(), content: new Map(), flow: new Map() }
    flow.current = null
    flowIdentity.current = null
    fittedIdentity.current = null
    fittingIdentity.current = null
  }
  const scoped = snapshot.sessionId === sessionId ? snapshot : { ...snapshot, value: null }
  const preliminary = projectFrozenCanvas(scoped, reducedMotion, visible)
  let shapeChanged = false
  for (const node of preliminary.nodes) {
    const key = nodeContentKey(frozenContentShape({ ...node.data, t }), node.data.contentWidth)
    if (measurementCache.current.shapes.get(node.id) !== key) {
      measurementCache.current.content.delete(node.id)
      shapeChanged = true
    }
    measurementCache.current.shapes.set(node.id, key)
  }
  // A shape change can resize a group frame and all of its descendants.  Flow
  // dimensions from the previous projection must not unlock a new Fit.
  if (shapeChanged) measurementCache.current.flow.clear()
  // Flow dimensions remain a useful display fallback for deterministic
  // projection/geometry updates, but only the natural content observer can
  // satisfy contentReady below and unlock the first automatic Fit.
  const projectionMeasurements = new Map(measurementCache.current.flow)
  for (const [id, size] of measurementCache.current.content) projectionMeasurements.set(id, size)
  const graph = projectFrozenCanvas(scoped, reducedMotion, visible, projectionMeasurements)
  const fitTargets = [...graph.nodes.map(node => ({ id: node.id })), ...graph.groups.map(group => ({ id: group.id }))]
  const fitTargetIds = new Set(fitTargets.map(target => target.id))
  const fitTargetKey = fitTargets.map(target => target.id).join('\u0000')
  // A frozen node's DOM is the measurement authority.  Do not ask XYFlow to
  // fit from the saved DTO dimensions before every node has reported a real
  // content box; that is the source of the first-paint clipping regression.
  const contentReady = bound !== null && graph.nodes.length > 0 && graph.nodes.every(node => measurementCache.current.content.has(node.id))
  const flowDimensionsReady =
    contentReady &&
    [...fitTargetIds].every(id => {
      const size = measurementCache.current.flow.get(id)
      return size !== undefined && size.width > 0 && size.height > 0
    })
  const layoutReady = contentReady && flowDimensionsReady
  const measuredShapeKeys = new Map(measurementCache.current.shapes)
  const nodes: DisplayFlowNode[] = [
    ...graph.groups.map(node => ({ ...node, data: { ...node.data, t } })),
    ...graph.nodes.map(node => ({
      ...node,
      selected: node.data.attemptIds.includes(snapshot.selectedAttemptId ?? ''),
      data: {
        ...node.data,
        t,
        onContentMeasure: (height: number) => {
          if (measurementCache.current.identity !== identity || measurementCache.current.shapes.get(node.id) !== measuredShapeKeys.get(node.id)) return
          const value = { width: node.data.contentWidth, height: Math.max(node.data.minimumHeight, height) }
          const old = measurementCache.current.content.get(node.id)
          if (old?.width !== value.width || old.height !== value.height) {
            measurementCache.current.content.set(node.id, value)
            measurementTick(tick => tick + 1)
          }
        }
      }
    }))
  ]
  const callId = conversationInspectableCall(value, sessionId)
  const memberActivities = conversationTeamMembers(snapshot.sessionId === sessionId ? snapshot : { ...snapshot, value: null })
  const fit = (nodeIds: string[]) => {
    if (nodeIds.length) void flow.current?.fitView({ nodes: nodeIds.map(id => ({ id })), padding: 0.25, duration: 0 })
  }
  React.useEffect(() => {
    if (
      !layoutReady ||
      !identity ||
      !flow.current ||
      flowIdentity.current !== identity ||
      fittedIdentity.current === identity ||
      fittingIdentity.current === identity
    )
      return
    if (!fitTargets.length) return
    const instance = flow.current
    const measuredTargets = () =>
      [...fitTargetIds].every(id => {
        const observed = measurementCache.current.flow.get(id)
        // Older controlled seats may not expose getInternalNode at all.  Their
        // dimensions callback is still an explicit measurement signal.  Once
        // the XYFlow API is present, a missing internal node is a real partial
        // graph and must keep the automatic Fit locked.
        if (typeof instance.getInternalNode !== 'function') {
          return observed !== undefined && observed.width > 0 && observed.height > 0
        }
        const internal = instance.getInternalNode(id)
        if (!internal) return false
        const measured = internal.measured
        if (measured?.width !== undefined && measured?.height !== undefined) {
          return measured.width !== undefined && measured.width > 0 && measured.height !== undefined && measured.height > 0
        }
        // The dimensions callback is emitted after XYFlow has measured the DOM,
        // while some node versions leave `measured` undefined for a frame.  Keep
        // that callback as the explicit fallback instead of fitting empty bounds.
        return observed !== undefined && observed.width > 0 && observed.height > 0
      })
    const schedule = (remaining: number) => {
      if (measurementCache.current.identity !== identity || fittedIdentity.current === identity || fittingIdentity.current === identity) return
      if (!measuredTargets()) {
        if (remaining > 0 && typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => schedule(remaining - 1))
        }
        return
      }
      fittingIdentity.current = identity
      void Promise.resolve(instance.fitView({ nodes: fitTargets, padding: 0.25, duration: 0 })).then(
        result => {
          if (measurementCache.current.identity !== identity || flow.current !== instance) return
          fittingIdentity.current = null
          if (result === false) {
            measurementTick(tick => tick + 1)
            return
          }
          fittedIdentity.current = identity
          measurementTick(tick => tick + 1)
        },
        () => {
          if (measurementCache.current.identity !== identity || flow.current !== instance) return
          fittingIdentity.current = null
          measurementTick(tick => tick + 1)
        }
      )
    }
    schedule(4)
  }, [fitTargetKey, identity, layoutReady, measurementVersion])
  const button = (key: BlueprintLocaleKey, icon: string, onClick: () => void, disabled = false) =>
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'bp-icon-button',
        'aria-label': t(key),
        title: t(key),
        onClick,
        disabled
      },
      blueprintIcon(React, icon)
    )
  const status =
    connection === 'stale'
      ? 'conversation.stale'
      : connection === 'unavailable'
        ? 'conversation.unavailable'
        : value?.status === 'unbound'
          ? 'conversation.unbound'
          : value === null
            ? 'conversation.loading'
            : 'conversation.connected'
  return React.createElement(
    'section',
    {
      className: 'bp-workspace bp-conversation',
      'aria-label': t('conversation.ariaLabel'),
      'data-bp-conversation': 'root',
      'data-bp-session': sessionId,
      'data-bp-run-id': bound?.selected.run.runId ?? '',
      'data-bp-frozen-revision': bound?.selected.run.definitionRevision ?? '',
      'data-bp-connection': connection,
      'data-bp-layout-ready': String(layoutReady),
      'data-bp-fit-ready': String(fittedIdentity.current === identity)
    },
    React.createElement(
      'header',
      { className: 'bp-toolbar' },
      React.createElement(
        StyledSelect,
        {
          React,
          className: 'bp-conversation-run',
          'aria-label': t('conversation.runSelector'),
          value: bound?.selected.run.runId ?? '',
          disabled: !bound,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
            void controller.selectRun(event.currentTarget.value)
          }
        },
        ...(bound
          ? bound.runs.map(run =>
              React.createElement(
                'option',
                { key: run.runId, value: run.runId },
                `${run.blueprintId ?? run.runId} · ${run.runId} · ${displayState(run.state, t)}`
              )
            )
          : [React.createElement('option', { key: 'empty', value: '' }, t(status))])
      ),
      React.createElement(
        'div',
        { className: 'bp-toolbar-actions' },
        button('conversation.refresh', 'refresh', () => {
          void controller.refresh()
        }),
        button(
          'conversation.focus',
          'view',
          () => {
            fit(conversationFocusNodes(value))
          },
          conversationFocusNodes(value).length === 0
        ),
        button(
          'conversation.fit',
          'layout',
          () => {
            fit(fitTargets.map(node => node.id))
          },
          !bound
        ),
        button(
          'conversation.inspectCall',
          'tools',
          () => {
            if (callId) inspectCall?.(callId)
          },
          !callId || !inspectCall
        )
      )
    ),
    React.createElement('p', { className: 'bp-conversation-status', role: 'status' }, t(status)),
    chatUnavailable && React.createElement('p', { role: 'status', 'data-bp-chat-unavailable': true }, t('conversation.chatUnavailable')),
    graph.collisionNodeIds
      ? React.createElement(
          'p',
          { role: 'alert', 'data-bp-layout-error': 'layout-collision-unresolved' },
          t('layout.unresolved'),
          ' ',
          graph.collisionNodeIds.join(', '),
          React.createElement('button', { type: 'button', onClick: () => fit(graph.collisionNodeIds!) }, t('layout.locate'))
        )
      : null,
    bound
      ? React.createElement(
          'div',
          { className: 'bp-conversation-body' },
          React.createElement(
            'div',
            { className: 'bp-conversation-canvas' },
            React.createElement(ReactFlow<DisplayFlowNode, FrozenFlowEdge>, {
              key: `${sessionId}:${bound.selected.run.runId}:${bound.selected.run.definitionRevision}`,
              nodes,
              edges: graph.edges,
              nodeTypes,
              edgeTypes,
              nodesDraggable: false,
              nodesConnectable: false,
              edgesReconnectable: false,
              deleteKeyCode: null,
              disableKeyboardA11y: true,
              elementsSelectable: true,
              edgesFocusable: false,
              nodesFocusable: false,
              minZoom: 0.001,
              maxZoom: 2,
              fitView: false,
              fitViewOptions: { padding: 0.25, nodes: fitTargets },
              onNodesChange: changes => {
                if (measurementCache.current.identity !== identity) return
                let changed = false
                for (const change of changes) {
                  if (change.type !== 'dimensions' || !change.dimensions || !fitTargetIds.has(change.id)) continue
                  const { width, height } = change.dimensions
                  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
                  const old = measurementCache.current.flow.get(change.id)
                  if (old?.width !== width || old.height !== height) {
                    measurementCache.current.flow.set(change.id, { width, height })
                    changed = true
                  }
                }
                if (changed) measurementTick(value => value + 1)
              },
              // ReactFlow can invoke onInit after the render whose content measurements
              // made layoutReady true.  A state tick here lets the fit effect observe
              // the initialized instance instead of silently returning with a null ref.
              onInit: instance => {
                if (measurementCache.current.identity !== identity) return
                flow.current = instance
                flowIdentity.current = identity
                measurementTick(value => value + 1)
              },
              onNodeClick: (_event, node) => {
                if (node.type !== 'frozen') return
                const ids = (node as DisplayNode).data.attemptIds
                // A node with several Attempts requires an explicit list choice;
                // array position is not an authority for selecting the latest one.
                if (ids.length === 1) {
                  controller.selectAttempt(ids[0]!)
                  const attempt = bound.selected.run.attempts.find(value => value.attemptId === ids[0])
                  if ((node as DisplayNode).data.node.kind === 'agentTask' && attempt?.sessionId !== undefined) openChat(attempt.sessionId)
                }
              },
              'aria-label': t('conversation.graph'),
              ariaLabelConfig: {
                ...flowAriaLabels(t),
                'node.a11yDescription.default': t('conversation.nodeReadonly'),
                'node.a11yDescription.keyboardDisabled': t('conversation.nodeReadonly'),
                'edge.a11yDescription.default': t('conversation.edgeReadonly')
              }
            })
          ),
          React.createElement(
            'aside',
            { className: 'bp-conversation-attempts', 'aria-label': t('conversation.attempts') },
            React.createElement('strong', null, t('conversation.attempts')),
            React.createElement('span', { className: 'bp-run-revision' }, bound.selected.run.definitionRevision),
            bound.selected.run.team
              ? renderTeamStage(bound.selected.run.team, memberActivities, snapshot.connection === 'connected', t, openSession ? openChat : undefined)
              : null,
            ...bound.selected.run.attempts.map((attempt, index) =>
              React.createElement(
                'div',
                {
                  key: attempt.attemptId ?? `legacy-${index}`,
                  className: 'bp-conversation-attempt'
                },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    'data-bp-attempt-id': attempt.attemptId,
                    'data-bp-attempt-state': attempt.state,
                    'data-bp-focus': attempt.attemptId !== undefined && bound.selected.focusAttemptIds.includes(attempt.attemptId),
                    'aria-pressed': attempt.attemptId !== undefined && attempt.attemptId === snapshot.selectedAttemptId,
                    disabled: attempt.attemptId === undefined,
                    onClick: () => {
                      if (attempt.attemptId) {
                        controller.selectAttempt(attempt.attemptId)
                        fit([attempt.nodeId])
                      }
                    }
                  },
                  t('run.attempt', { nodeId: attempt.nodeId, attempt: attempt.attempt, state: displayState(attempt.state, t) }),
                  React.createElement('small', null, attempt.attemptId ?? t('conversation.legacyAttempt'))
                ),
                openSession &&
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      'data-bp-open-attempt': attempt.attemptId,
                      disabled:
                        attempt.attemptId === undefined ||
                        attempt.sessionId === undefined ||
                        !bound.selected.graph.nodes.some(node => node.id === attempt.nodeId && node.kind === 'agentTask'),
                      onClick: () => {
                        if (attempt.sessionId !== undefined && attempt.attemptId !== undefined) openChat(attempt.sessionId)
                      }
                    },
                    t('conversation.openChat')
                  ),
                attempt.attemptId === snapshot.selectedAttemptId &&
                  attempt.state === 'failed' &&
                  React.createElement(
                    'div',
                    null,
                    React.createElement('p', { 'data-bp-failure-explanation': attempt.attemptId }, t('conversation.failedHistory')),
                    bound.selected.source &&
                      openSession &&
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          'data-bp-source-chat': bound.selected.source.sessionId,
                          onClick: () => openChat(bound.selected.source!.sessionId)
                        },
                        t('conversation.sourceChat')
                      )
                  )
              )
            )
          )
        )
      : React.createElement('div', { className: 'bp-conversation-empty' }, t(status === 'conversation.unbound' ? 'conversation.unboundHelp' : status))
  )
}
