/** @jsxRuntime classic */
/** @jsx React.createElement */
import { StyledSelect } from '../../../shared/controls/styled-controls.ts'
import React from 'react'
import { nodeContentKey } from '../../authoring/logic/graph/node-geometry.ts'
import { ReactFlow } from '@xyflow/react'
import type { ReactFlowInstance } from '@xyflow/react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { BlueprintLocaleProps, BlueprintLocaleKey } from '../../../shared/i18n/locales.ts'
import { blueprintIcon } from '../../../shared/icons/icons.ts'
import { conversationFocusNodes } from '../logic/conversation-controller.ts'
import type { ConversationController } from '../logic/conversation-controller.ts'
import { conversationInspectableCall, conversationTeamMembers, projectFrozenCanvas } from './conversation-canvas.ts'
import type { FrozenFlowEdge } from './conversation-canvas.ts'
import { installCanvasStyles } from '../../../shared/styles/styles.ts'
import { installConversationStyles } from './conversation-styles.ts'
import { flowAriaLabels } from '../../authoring/presenters/canvas-presentation.ts'
import type { ChatNavigation, OpenExecutionChat } from '../logic/chat-navigation.ts'
import { edgeTypes, frozenContentShape, nodeTypes } from './conversation-renderers.tsx'
import type { ConversationDisplayGroup, ConversationDisplayNode } from './conversation-renderers.tsx'
import { renderConversationAttempts } from './conversation-attempts.tsx'
import { ConversationRecoverySection } from './conversation-recovery.tsx'
import { displayState, presentConversation } from '../presenters/conversation-presenter.ts'
export interface ConversationViewInjected {
  controller: ConversationController
  openSession?: OpenExecutionChat
  chatNavigation?: ChatNavigation
}
const noChatRequest = () => null
const noChatSubscription = () => () => {}
type Props = ConvViewProps & BlueprintLocaleProps & ConversationViewInjected
type DisplayFlowNode = ConversationDisplayNode | ConversationDisplayGroup
/** DSH owns the resident composer and pendingInteraction. This seat only observes durable Runs. */
export function ConversationBlueprintView({ controller, sessionId, t, inspectCall, openSession, chatNavigation, openView }: Props): React.ReactElement {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const chatRequest = React.useSyncExternalStore(chatNavigation?.subscribe ?? noChatSubscription, chatNavigation?.getSnapshot ?? noChatRequest, noChatRequest)
  const [chatUnavailable, setChatUnavailable] = React.useState(false)
  const [loadingMoreRuns, setLoadingMoreRuns] = React.useState(false)
  const [archiveConfirmRunId, setArchiveConfirmRunId] = React.useState<string | null>(null)
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
  const { value, connection, bound, status } = presentConversation(snapshot, sessionId, t)
  const measurementCache = React.useRef<{
    identity: string
    shapes: Map<string, string>
    content: Map<
      string,
      {
        width: number
        height: number
      }
    >
    flow: Map<
      string,
      {
        width: number
        height: number
      }
    >
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
  const button = (key: BlueprintLocaleKey, icon: string, onClick: () => void, disabled = false) => (
    <button type={'button'} className={'bp-icon-button'} aria-label={t(key)} title={t(key)} onClick={onClick} disabled={disabled}>
      {blueprintIcon(React, icon)}
    </button>
  )
  return (
    <section
      className={'bp-workspace bp-conversation'}
      aria-label={t('conversation.ariaLabel')}
      data-bp-conversation={'root'}
      data-bp-session={sessionId}
      data-bp-run-id={bound?.selected.run.runId ?? ''}
      data-bp-frozen-revision={bound?.selected.run.definitionRevision ?? ''}
      data-bp-connection={connection}
      data-bp-layout-ready={String(layoutReady)}
      data-bp-fit-ready={String(fittedIdentity.current === identity)}
    >
      <header className={'bp-toolbar'}>
        <StyledSelect
          React={React}
          className={'bp-conversation-run'}
          aria-label={t('conversation.runSelector')}
          value={bound?.selected.run.runId ?? ''}
          disabled={!bound}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
            void controller.selectRun(event.currentTarget.value)
          }}
        >
          {bound
            ? bound.runs.map(run => (
                <option key={run.runId} value={run.runId}>{`${run.blueprintId ?? run.runId} · ${run.runId} · ${displayState(run.state, t)}`}</option>
              ))
            : [
                <option key={'empty'} value={''}>
                  {t(status)}
                </option>
              ]}
        </StyledSelect>
        <div className={'bp-toolbar-actions'}>
          {button('conversation.refresh', 'refresh', () => {
            void controller.refresh()
          })}
          {button(
            'conversation.focus',
            'view',
            () => {
              fit(conversationFocusNodes(value))
            },
            conversationFocusNodes(value).length === 0
          )}
          {button(
            'conversation.fit',
            'layout',
            () => {
              fit(fitTargets.map(node => node.id))
            },
            !bound
          )}
          {button(
            'conversation.inspectCall',
            'tools',
            () => {
              if (callId) inspectCall?.(callId)
            },
            !callId || !inspectCall
          )}
        </div>
      </header>
      <p className={'bp-conversation-status'} role={'status'}>
        {t(status)}
      </p>
      {bound && bound.nextCursor && controller.hasRunQuery() ? (
        <button
          type={'button'}
          className={'bp-conversation-load-more'}
          disabled={loadingMoreRuns}
          onClick={() => {
            setLoadingMoreRuns(true)
            void controller.loadMoreRuns().finally(() => setLoadingMoreRuns(false))
          }}
        >
          {t(loadingMoreRuns ? 'conversation.loadingMoreRuns' : 'conversation.loadMoreRuns')}
        </button>
      ) : null}
      {bound && controller.hasRunLifecycle() ? (
        <button
          type={'button'}
          className={'bp-conversation-load-more'}
          onClick={() => {
            const runId = bound.selected.run.runId
            if (archiveConfirmRunId !== runId) {
              setArchiveConfirmRunId(runId)
              return
            }
            setArchiveConfirmRunId(null)
            void controller.archiveSelectedRun()
          }}
        >
          {archiveConfirmRunId === bound.selected.run.runId ? t('conversation.archiveConfirm') : t('conversation.archiveRun')}
        </button>
      ) : null}
      {bound ? <ConversationRecoverySection key={bound.selected.run.runId} bound={bound} snapshot={snapshot} controller={controller} t={t} /> : null}
      {chatUnavailable && (
        <p role={'status'} data-bp-chat-unavailable={true}>
          {t('conversation.chatUnavailable')}
        </p>
      )}
      {graph.collisionNodeIds ? (
        <p role={'alert'} data-bp-layout-error={'layout-collision-unresolved'}>
          {t('layout.unresolved')} {graph.collisionNodeIds.join(', ')}
          <button type={'button'} onClick={() => fit(graph.collisionNodeIds!)}>
            {t('layout.locate')}
          </button>
        </p>
      ) : null}
      {bound ? (
        <div className={'bp-conversation-body'}>
          <div className={'bp-conversation-canvas'}>
            <ReactFlow<DisplayFlowNode, FrozenFlowEdge>
              key={`${sessionId}:${bound.selected.run.runId}:${bound.selected.run.definitionRevision}`}
              nodes={nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesReconnectable={false}
              deleteKeyCode={null}
              disableKeyboardA11y={true}
              elementsSelectable={true}
              edgesFocusable={false}
              nodesFocusable={false}
              minZoom={0.001}
              maxZoom={2}
              fitView={false}
              fitViewOptions={{ padding: 0.25, nodes: fitTargets }}
              onNodesChange={changes => {
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
              }}
              onInit={instance => {
                if (measurementCache.current.identity !== identity) return
                flow.current = instance
                flowIdentity.current = identity
                measurementTick(value => value + 1)
              }}
              onNodeClick={(_event, node) => {
                if (node.type !== 'frozen') return
                const ids = (node as ConversationDisplayNode).data.attemptIds
                // A node with several Attempts requires an explicit list choice;
                // array position is not an authority for selecting the latest one.
                if (ids.length === 1) {
                  controller.selectAttempt(ids[0]!)
                  const attempt = bound.selected.run.attempts.find(value => value.attemptId === ids[0])
                  if ((node as ConversationDisplayNode).data.node.kind === 'agentTask' && attempt?.sessionId !== undefined) openChat(attempt.sessionId)
                }
              }}
              aria-label={t('conversation.graph')}
              ariaLabelConfig={{
                ...flowAriaLabels(t),
                'node.a11yDescription.default': t('conversation.nodeReadonly'),
                'node.a11yDescription.keyboardDisabled': t('conversation.nodeReadonly'),
                'edge.a11yDescription.default': t('conversation.edgeReadonly')
              }}
            />
          </div>
          {renderConversationAttempts({
            bound,
            snapshot,
            memberActivities,
            controller,
            fit,
            t,
            openSession,
            openChat
          })}
        </div>
      ) : (
        <div className={'bp-conversation-empty'}>{t(status === 'conversation.unbound' ? 'conversation.unboundHelp' : status)}</div>
      )}
    </section>
  )
}
