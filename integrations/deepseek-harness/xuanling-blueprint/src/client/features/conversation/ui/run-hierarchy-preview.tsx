/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import React from 'react'
import { ReactFlow, Controls, Position } from '@xyflow/react'
import type { InspectRunViewValue } from '../../../../conversation/contracts.ts'
import type { HostLink } from '../../../adapters/host/remote.ts'
import type { BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import { displayState } from '../presenters/conversation-presenter.ts'

/** Frozen runtime navigation also works for canvas Runs with no source Session. */
export function RunHierarchyPreview({
  runId,
  host,
  t,
  onClose,
  openChat
}: BlueprintLocaleProps & {
  runId: string
  host: HostLink
  onClose: () => void
  openChat?: ((sessionId: string, ownerId?: string) => void) | undefined
}) {
  const dialog = React.useRef<HTMLDialogElement>(null)
  const [target, setTarget] = React.useState(runId)
  const [view, setView] = React.useState<InspectRunViewValue | null>(null)
  const [status, setStatus] = React.useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [refresh, setRefresh] = React.useState(0)
  React.useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  React.useEffect(() => {
    let active = true,
      pending = false
    setStatus('loading')
    const read = async () => {
      if (pending) return
      pending = true
      try {
        const next = await host.inspectRunView?.({ runId: target })
        if (!next || next.run.runId !== target) throw new Error('view-unavailable')
        if (active) {
          setView(next)
          setStatus('ready')
        }
      } catch {
        if (active) setStatus('unavailable')
      } finally {
        pending = false
      }
    }
    void read()
    const timer = setInterval(() => {
      void read()
    }, 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [host, target, refresh])
  const openNode = (nodeId: string) => {
    const attempts = view?.run.attempts.filter(attempt => attempt.nodeId === nodeId) ?? []
    if (attempts.length !== 1) return
    const attempt = attempts[0]!
    if (attempt.childRunId) setTarget(attempt.childRunId)
    else if (attempt.sessionId) openChat?.(attempt.sessionId, view?.run.source?.sessionId)
  }
  const nodes =
    view?.graph.nodes.map((node, index) => ({
      id: node.id,
      position: view.presentation?.nodes[node.id] ?? { x: index * 260, y: 40 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: (
          <>
            <strong>{view.presentation?.nodes[node.id]?.title ?? node.id}</strong>
            <p>{t(`conversation.kind.${node.kind}`)}</p>
            {view.run.attempts
              .filter(attempt => attempt.nodeId === node.id)
              .map(attempt => (
                <small key={attempt.attemptId}>{displayState(attempt.state, t)}</small>
              ))}
          </>
        )
      }
    })) ?? []
  const edges = view?.graph.edges.map((edge, index) => ({ id: String(index), source: edge.from.split(/[.@]/)[0]!, target: edge.to.split(/[.@]/)[0]! })) ?? []
  return (
    <dialog ref={dialog} className="bp-runtime-preview bp-workspace" aria-label={t('conversation.graph')} onCancel={onClose}>
      <button type="button" data-bp-preview-close onClick={onClose}>
        {t('composition.back')}
      </button>
      <p className="bp-help">{t('conversation.runtimeReadonly')}</p>
      <p role="status">
        {status === 'ready' && view ? displayState(view.run.state, t) : t(status === 'loading' ? 'conversation.loading' : 'conversation.unavailable')}
      </p>
      {status === 'unavailable' && (
        <button type="button" onClick={() => setRefresh(value => value + 1)}>
          {t('conversation.refresh')}
        </button>
      )}
      {view && (
        <section data-bp-run-preview={view.run.runId}>
          <nav className="bp-flow-breadcrumb" aria-label={t('conversation.breadcrumb')}>
            {view.ancestors.map(parent => (
              <button type="button" key={parent.runId} data-bp-breadcrumb={parent.runId} onClick={() => setTarget(parent.runId)}>
                {parent.blueprintId ?? parent.runId}
              </button>
            ))}
            <span aria-current="page">{view.run.runId}</span>
          </nav>
          <code className="bp-child-pin">{view.run.documentRevision ?? view.run.definitionRevision}</code>
          <div className="bp-child-preview-graph">
            <ReactFlow
              key={view.run.runId}
              nodes={nodes}
              edges={edges}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesReconnectable={false}
              deleteKeyCode={null}
              fitView
              minZoom={0.05}
              onNodeClick={(_event, node) => openNode(node.id)}
              aria-label={t('conversation.graph')}
            >
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <ol>
            {view.run.attempts.map((attempt, index) => (
              <li key={attempt.attemptId ?? index}>
                <span>
                  {attempt.nodeId} · {displayState(attempt.state, t)}
                </span>
                {attempt.childRunId && (
                  <button type="button" data-bp-open-child={attempt.childRunId} onClick={() => setTarget(attempt.childRunId!)}>
                    {t('conversation.openChild')}
                  </button>
                )}
                {attempt.sessionId && openChat && (
                  <button type="button" data-bp-open-attempt={attempt.attemptId} onClick={() => openChat(attempt.sessionId!, view.run.source?.sessionId)}>
                    {t('conversation.openChat')}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
    </dialog>
  )
}
