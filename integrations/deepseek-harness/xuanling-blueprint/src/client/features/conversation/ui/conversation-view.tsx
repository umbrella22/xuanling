/** @jsxRuntime classic */
/** @jsx React.createElement */
import type { AssetRef } from '../../../../definition/library-ref.ts'
import { StyledSelect } from '../../../shared/controls/styled-controls.ts'
import React from 'react'
import { nodeContentKey } from '../../authoring/logic/graph/node-geometry.ts'
import { ReactFlow, MiniMap } from '@xyflow/react'
import type { ReactFlowInstance } from '@xyflow/react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { BlueprintLocaleProps, BlueprintLocaleKey } from '../../../shared/i18n/locales.ts'
import { blueprintIcon } from '../../../shared/icons/icons.ts'
import { conversationFocusNodes } from '../logic/conversation-controller.ts'
import type { ConversationController } from '../logic/conversation-controller.ts'
import { conversationInspectableCall, conversationTeamMembers, projectFrozenCanvas } from './conversation-canvas.ts'
import { installCanvasStyles } from '../../../shared/styles/styles.ts'
import { installConversationStyles } from './conversation-styles.ts'
import { flowAriaLabels } from '../../authoring/presenters/canvas-presentation.ts'
import type { ChatNavigation, OpenExecutionChat } from '../logic/chat-navigation.ts'
import type { FrozenFlowEdge, FrozenNodeData } from './conversation-canvas.ts'
import { edgeTypes, frozenContentShape, nodeTypes } from './conversation-renderers.tsx'
import type { ConversationDisplayGroup, ConversationDisplayNode } from './conversation-renderers.tsx'
import { renderTeamStage } from './conversation-team-stage.tsx'
import { ConversationRecoverySection } from './conversation-recovery.tsx'
import { displayState, presentConversation } from '../presenters/conversation-presenter.ts'
export interface ConversationViewInjected {
  controller: ConversationController
  createPlanEditor?: (sessionId: string, asset?: AssetRef) => React.ComponentType<BlueprintLocaleProps>
  openSession?: OpenExecutionChat
  chatNavigation?: ChatNavigation
}
const planStatusKey = (status: string): BlueprintLocaleKey => {
  switch (status) {
    case 'saved':
      return 'conversation.planStatus.saved'
    case 'starting':
      return 'conversation.planStatus.starting'
    case 'running':
      return 'conversation.planStatus.running'
    case 'settled':
      return 'conversation.planStatus.settled'
    case 'blocked':
      return 'conversation.planStatus.blocked'
    default:
      return 'conversation.planStatus.association-pending'
  }
}
const planIntentKey = (intent: string): BlueprintLocaleKey => (intent === 'execute' ? 'conversation.planIntent.execute' : 'conversation.planIntent.design')
/** MiniMap paint is an SVG context: dark-first hex constants, one per kind. */
const miniMapKindColors: Record<string, string> = {
  input: '#94a3b8',
  output: '#22d3ee',
  agentTask: '#34d399',
  blueprintCall: '#fb923c',
  condition: '#fbbf24',
  humanDecision: '#fb7185',
  join: '#a78bfa'
}
const miniMapNodeColor = (node: DisplayFlowNode): string =>
  node.type === 'frozen' ? (miniMapKindColors[(node.data as FrozenNodeData).node.kind] ?? '#939aa4') : '#939aa4'
const noChatRequest = () => null
const noChatSubscription = () => () => {}
/** Read-only canvas: the graph is the subject, so fit it close to the frame edges
 * while reserving room for the floating legend above and minimap below. */
const conversationFitPadding = { top: 0.16, right: 0.06, bottom: 0.16, left: 0.06 } as const
type Props = ConvViewProps & BlueprintLocaleProps & ConversationViewInjected
type DisplayFlowNode = ConversationDisplayNode | ConversationDisplayGroup
/** DSH owns the resident composer and pendingInteraction. This seat only observes durable Runs. */
export function ConversationBlueprintView({
  controller,
  sessionId,
  t,
  inspectCall,
  openSession,
  chatNavigation,
  openView,
  createPlanEditor
}: Props): React.ReactElement {
  const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const plans = snapshot.value?.associations ?? []
  const chatRequest = React.useSyncExternalStore(chatNavigation?.subscribe ?? noChatSubscription, chatNavigation?.getSnapshot ?? noChatRequest, noChatRequest)
  const [chatUnavailable, setChatUnavailable] = React.useState(false)
  const [loadingMoreRuns, setLoadingMoreRuns] = React.useState(false)
  const [archiveConfirmRunId, setArchiveConfirmRunId] = React.useState<string | null>(null)
  const [planInputs, setPlanInputs] = React.useState<Record<string, string>>({})
  const [editing, setEditing] = React.useState<{ asset?: AssetRef } | null>(null)
  const Editor = React.useMemo(
    () => (createPlanEditor === undefined || editing === null ? null : createPlanEditor(sessionId, editing.asset)),
    [createPlanEditor, sessionId, editing]
  )
  const [planBusy, setPlanBusy] = React.useState<string | null>(null)
  /** Explicit multi-attempt picker target; single-attempt nodes never need it. */
  const [pickerNodeId, setPickerNodeId] = React.useState<string | null>(null)
  const [planError, setPlanError] = React.useState<{ associationId: string; code: string } | null>(null)
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
  // Run summaries carry the blueprint identity; the inspect payload only owns
  // the frozen facts for the selected Run itself.
  const selectedRunName = bound ? (bound.runs.find(run => run.runId === bound.selected.run.runId)?.blueprintId ?? bound.selected.run.runId) : ''
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
      // XYFlow's minimap only draws nodes whose user object carries measured
      // dimensions; this seat keeps measurements out of canonical node state,
      // so replay the observed content box as a hint. Never pass width/height:
      // that pins the wrapper and can stall the automatic Fit.
      ...(measurementCache.current.content.get(node.id) === undefined
        ? {}
        : { measured: { width: node.data.contentWidth, height: measurementCache.current.content.get(node.id)!.height } }),
      selected: node.data.attemptIds.includes(snapshot.selectedAttemptId ?? ''),
      data: {
        ...node.data,
        t,
        pickerOpen: pickerNodeId === node.id,
        onPickAttempt: (attemptId: string) => {
          setPickerNodeId(null)
          controller.selectAttempt(attemptId)
          fit([node.id])
        },
        onOpenAttemptChat: (attemptId: string) => {
          const attempt = bound?.selected.run.attempts.find(value => value.attemptId === attemptId)
          setPickerNodeId(null)
          if (attempt?.sessionId !== undefined) openChat(attempt.sessionId)
        },
        onOpenChildRun: (runId: string) => {
          setPickerNodeId(null)
          void controller.selectRun(runId)
        },
        onOpenSourceChat: (sessionId: string) => openChat(sessionId),
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
    if (nodeIds.length) void flow.current?.fitView({ nodes: nodeIds.map(id => ({ id })), padding: conversationFitPadding, duration: 0 })
  }
  /** Latest-attempt buckets per node; chips locate their group via fit. */
  const legendChips = (() => {
    if (!bound || graph.nodes.length === 0) return []
    const buckets: Record<'failed' | 'running' | 'waiting' | 'pending', string[]> = { failed: [], running: [], waiting: [], pending: [] }
    for (const node of graph.nodes) {
      const state = node.data.rawState
      buckets[
        state === 'failed' || state === 'timed_out'
          ? 'failed'
          : state === 'running' || state === 'preparing'
            ? 'running'
            : state === 'waiting_input' || state === 'recovery_required'
              ? 'waiting'
              : 'pending'
      ].push(node.id)
    }
    const labels = {
      failed: 'conversation.legendFailed',
      running: 'conversation.legendRunning',
      waiting: 'conversation.legendWaiting',
      pending: 'conversation.legendPending'
    } as const
    return (Object.keys(buckets) as Array<keyof typeof buckets>).map(bucket => ({ bucket, labelKey: labels[bucket], nodeIds: buckets[bucket]! }))
  })()
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
          return
        }
        // Exhausted the frame budget before XYFlow reported dimensions: re-arm
        // on the next poll cycle instead of waiting for a measurement event
        // that may never come. Bounded by the run identity and the Fit lock.
        if (typeof setTimeout === 'function') {
          setTimeout(() => {
            if (measurementCache.current.identity !== identity || fittedIdentity.current === identity || fittingIdentity.current !== null) return
            // When the flow container mounts before the first paint, XYFlow's
            // one-shot container measurement is consumed behind a visibility
            // gate and store width/height stay unset forever; a synthetic
            // resize re-runs that measurement before the next Fit attempt.
            globalThis.dispatchEvent?.(new Event('resize'))
            measurementTick(tick => tick + 1)
          }, 1500)
        }
        return
      }
      fittingIdentity.current = identity
      void Promise.resolve(instance.fitView({ nodes: fitTargets, padding: conversationFitPadding, duration: 0 })).then(
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
    // Headless boots can lag XYFlow node measurement past a few frames; a
    // 60-frame budget keeps the one-shot Fit racing nothing while staying
    // bounded. Measurement events re-trigger the effect independently.
    schedule(60)
  }, [fitTargetKey, identity, layoutReady, measurementVersion])
  const button = (key: BlueprintLocaleKey, icon: string, onClick: () => void, disabled = false) => (
    <button type={'button'} className={'bp-icon-button'} aria-label={t(key)} title={t(key)} onClick={onClick} disabled={disabled}>
      {blueprintIcon(React, icon)}
    </button>
  )
  /** Exactly one live status node per seat state; an unbound toolbar is hidden,
   * so its status stays outside the ribbon to remain announced. */
  const statusLine = (
    <p className={'bp-conversation-status'} role={'status'}>
      {t(status)}
    </p>
  )
  return (
    <section
      className={`bp-workspace bp-conversation${bound ? ' is-bound' : ' is-unbound'}${plans.length > 0 ? ' has-plans' : ''}${Editor ? ' is-editing' : ''}`}
      aria-label={t('conversation.ariaLabel')}
      data-bp-conversation={'root'}
      data-bp-conversation-state={bound ? 'bound' : plans.length > 0 ? 'plans' : 'empty'}
      data-bp-session={sessionId}
      data-bp-run-id={bound?.selected.run.runId ?? ''}
      data-bp-frozen-revision={bound?.selected.run.definitionRevision ?? ''}
      data-bp-connection={connection}
      data-bp-layout-ready={String(layoutReady)}
      data-bp-fit-ready={String(fittedIdentity.current === identity)}
    >
      <header className={'bp-toolbar bp-conversation-toolbar'}>
        <StyledSelect
          React={React}
          className={'bp-conversation-run'}
          aria-label={bound ? `${t('conversation.runSelector')}: ${selectedRunName}` : t('conversation.runSelector')}
          title={bound ? `${selectedRunName} · ${bound.selected.run.runId} · ${displayState(bound.selected.run.state, t)}` : undefined}
          value={bound?.selected.run.runId ?? ''}
          disabled={!bound}
          selectedLabel={
            bound ? (
              <span className={'bp-run-trigger'}>
                <span className={'bp-run-trigger-name'}>{selectedRunName}</span>
                <span className={'bp-run-trigger-dot'} data-bp-run-state={bound.selected.run.state} aria-hidden={'true'} />
                <span className={'bp-run-trigger-state'}>{displayState(bound.selected.run.state, t)}</span>
              </span>
            ) : undefined
          }
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
        {bound ? statusLine : null}
        <div className={'bp-toolbar-actions'}>
          {bound && controller.hasRunLifecycle() ? (
            <button
              type={'button'}
              className={`bp-conversation-archive${archiveConfirmRunId === bound.selected.run.runId ? ' is-confirming' : ''}`}
              title={archiveConfirmRunId === bound.selected.run.runId ? t('conversation.archiveConfirm') : t('conversation.archiveRun')}
              aria-label={archiveConfirmRunId === bound.selected.run.runId ? t('conversation.archiveConfirm') : t('conversation.archiveRun')}
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
              {archiveConfirmRunId === bound.selected.run.runId ? t('conversation.archiveConfirmShort') : t('conversation.archiveRunShort')}
            </button>
          ) : null}
          {bound && controller.hasRunLifecycle() ? <span className={'bp-toolbar-divider'} aria-hidden={'true'} /> : null}
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
      {bound ? null : statusLine}
      {bound && (bound.selected.ancestors?.length ?? 0) > 0 && (
        <nav className="bp-flow-breadcrumb" aria-label={t('conversation.breadcrumb')}>
          {bound.selected.ancestors!.map(parent => (
            <button
              key={parent.runId}
              type="button"
              data-bp-breadcrumb={parent.runId}
              onClick={() => {
                void controller.selectRun(parent.runId)
              }}
            >
              {parent.blueprintId ?? parent.runId}
            </button>
          ))}
          <span aria-current="page">{bound.selected.run.runId}</span>
        </nav>
      )}
      {Editor ? (
        <div className={'bp-conversation-editor'} data-bp-conversation-editor>
          <div className={'bp-conversation-editor-head'}>
            <button
              type={'button'}
              className={'bp-button bp-button-quiet'}
              onClick={() => {
                setEditing(null)
                void controller.refresh()
              }}
            >
              {t('conversation.closeEditor')}
            </button>
          </div>
          <div className={'bp-conversation-editor-body'}>
            <Editor t={t} />
          </div>
        </div>
      ) : !bound && plans.length === 0 ? (
        <div className={'bp-conversation-empty'}>
          {t(status === 'conversation.unbound' ? 'conversation.unboundHelp' : status)}
          <span className={'bp-conversation-empty-icon'} aria-hidden={'true'}>
            {blueprintIcon(React, 'library')}
          </span>
          {createPlanEditor && (
            <button type={'button'} className={'bp-button bp-button-primary'} onClick={() => setEditing({})}>
              {t('conversation.managePlans')}
            </button>
          )}
          {(connection === 'unavailable' || connection === 'stale') && (
            <button
              type={'button'}
              className={'bp-button bp-button-quiet'}
              onClick={() => {
                void controller.refresh()
              }}
            >
              {t('conversation.refresh')}
            </button>
          )}
        </div>
      ) : plans.length > 0 ? (
        <div className={'bp-conversation-scroll'}>
          <section className={'bp-conversation-plans'} data-bp-conversation-plans={String(plans.length)}>
            <div className={'bp-conversation-section-head'}>
              <div className={'bp-conversation-section-copy'}>
                <h3 className={'bp-conversation-plans-title'}>{t('conversation.plans')}</h3>
                {!bound && <p className={'bp-conversation-plans-help'}>{t('conversation.plansHelp')}</p>}
              </div>
              {createPlanEditor && (
                <button type={'button'} className={'bp-button bp-button-secondary bp-button-sm'} onClick={() => setEditing({})}>
                  {t('conversation.managePlans')}
                </button>
              )}
            </div>
            <ul className={'bp-conversation-plan-list'}>
              {plans.map(association => (
                <li
                  key={association.associationId}
                  className={`bp-conversation-plan is-${association.status}`}
                  data-bp-plan={association.associationId}
                  data-bp-plan-status={association.status}
                >
                  <div className={'bp-conversation-plan-head'}>
                    <div className={'bp-conversation-plan-title'}>
                      <span className={'bp-conversation-plan-name'}>{association.name}</span>
                      <span className={`bp-conversation-plan-status is-${association.status}`}>
                        <span className={'bp-conversation-plan-status-dot'} aria-hidden={'true'} />
                        {t(planStatusKey(association.status))}
                      </span>
                    </div>
                    <div className={'bp-conversation-plan-actions'}>
                      {createPlanEditor && (
                        <button type={'button'} className={'bp-button bp-button-quiet bp-button-sm'} onClick={() => setEditing({ asset: association.asset })}>
                          {t('conversation.editPlan')}
                        </button>
                      )}
                      {association.runId ? (
                        <button
                          type={'button'}
                          className={'bp-button bp-button-secondary bp-button-sm bp-conversation-plan-open'}
                          title={association.runId}
                          onClick={() => {
                            void controller.selectRun(association.runId!)
                          }}
                        >
                          <span className={'bp-conversation-plan-open-label'}>{association.runId}</span>
                        </button>
                      ) : null}
                      {!association.runId && (association.status === 'saved' || association.status === 'blocked') ? (
                        <button
                          type={'button'}
                          className={'bp-button bp-button-primary bp-conversation-plan-run-button bp-conversation-plan-run'}
                          disabled={planBusy === association.associationId}
                          data-bp-plan-run={association.associationId}
                          onClick={() => {
                            setPlanBusy(association.associationId)
                            setPlanError(null)
                            void controller
                              .runPlan(association, planInputs[association.associationId] ?? '{}')
                              .finally(() => setPlanBusy(null))
                              .catch(error => {
                                const code =
                                  typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'blueprint/remote-failed'
                                setPlanError({ associationId: association.associationId, code })
                              })
                          }}
                        >
                          {t('conversation.runPlan')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                  <div className={'bp-conversation-plan-meta'}>
                    <span>{t(planIntentKey(association.intent))}</span>
                    <span className={'bp-conversation-plan-meta-dot'} aria-hidden={'true'} />
                    <span>{t('conversation.planRevision', { revision: association.documentRevision.slice(0, 12) })}</span>
                    <span className={'bp-conversation-plan-meta-dot'} aria-hidden={'true'} />
                    <code className={'bp-conversation-plan-identity'} title={association.asset.blueprintId}>
                      {association.asset.blueprintId}
                    </code>
                  </div>
                  {!association.runId && createPlanEditor ? (
                    <details className={'bp-conversation-plan-input'}>
                      <summary>{t('conversation.planInput')}</summary>
                      <label className={'bp-conversation-plan-field'}>
                        <textarea
                          aria-label={t('conversation.planInput')}
                          rows={2}
                          spellCheck={false}
                          value={planInputs[association.associationId] ?? '{}'}
                          onChange={event => setPlanInputs({ ...planInputs, [association.associationId]: event.target.value })}
                        />
                      </label>
                    </details>
                  ) : null}
                  {planError?.associationId === association.associationId ? (
                    <p className={'bp-conversation-plan-error'} role={'alert'}>
                      {t('conversation.planRunFailed', { code: planError.code })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        </div>
      ) : null}
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
      {bound && !Editor ? (
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
              fitViewOptions={{ padding: conversationFitPadding, nodes: fitTargets }}
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
                if (ids.length > 1) {
                  setPickerNodeId(current => (current === node.id ? null : node.id))
                  return
                }
                setPickerNodeId(null)
                if (ids.length === 1) {
                  controller.selectAttempt(ids[0]!)
                  fit([node.id])
                  const attempt = bound.selected.run.attempts.find(value => value.attemptId === ids[0])
                  if (attempt?.childRunId) void controller.selectRun(attempt.childRunId)
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
            >
              <MiniMap
                pannable={false}
                zoomable={false}
                position={'bottom-right'}
                style={{ width: 148, height: 104 }}
                nodeColor={miniMapNodeColor}
                nodeStrokeWidth={2}
                nodeBorderRadius={2}
                ariaLabel={t('conversation.minimap')}
              />
            </ReactFlow>
            {legendChips.length > 0 ? (
              <div className={'bp-conversation-legend'} data-bp-legend={bound.selected.run.runId}>
                <span className={'bp-run-revision'} title={bound.selected.run.definitionRevision}>
                  <span className={'bp-run-revision-label'}>{t('conversation.revisionShort')}</span>
                  {bound.selected.run.definitionRevision.slice(0, 8)}
                </span>
                {legendChips.map(chip => (
                  <button
                    key={chip.bucket}
                    type={'button'}
                    className={`bp-legend-chip is-${chip.bucket}`}
                    data-bp-legend-chip={chip.bucket}
                    data-bp-legend-count={chip.nodeIds.length}
                    onClick={() => fit(chip.nodeIds)}
                  >
                    <span className={'bp-legend-label'}>{t(chip.labelKey)}</span>
                    <span className={'bp-legend-count'}>{chip.nodeIds.length}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {bound.selected.run.team ? (
              <details className={'bp-conversation-team-card'} open={true}>
                <summary>{t('conversation.teamCard')}</summary>
                {renderTeamStage(bound.selected.run.team, memberActivities, connection === 'connected', t, openSession ? openChat : undefined)}
              </details>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
