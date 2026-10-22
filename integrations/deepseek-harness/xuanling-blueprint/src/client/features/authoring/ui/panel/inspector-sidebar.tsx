/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import type { GraphEditor } from '../../logic/graph/graph-editor.ts'
import type { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import type { PanelWorkspaceBinding } from './panel-workspace-binding.ts'
import type { WorkspacePresentation } from '../../presenters/workspace-presenter.ts'
import type { HostLink } from '../../../../adapters/host/remote.ts'
import type { ModelCatalogSnapshot } from '../../../../adapters/host/model-catalog.ts'
import type { OpenExecutionChat } from '../../../conversation/logic/chat-navigation.ts'
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import { JsonEditor } from '../../logic/inspector/json-editor.ts'
import { NodeInspector } from '../inspector/inspector-composition.tsx'
import { BlueprintCallInspector } from '../inspector/blueprint-call-inspector.tsx'
import { RunHierarchyPreview } from '../../../conversation/ui/run-hierarchy-preview.tsx'
import type { InspectRunViewValue } from '../../../../../conversation/contracts.ts'
import { editorNodeDisplayTitle } from '../../logic/graph/graph-editor.ts'
import { runStateTitle } from '../../presenters/canvas-presentation.ts'
import { nodeKindTitle } from '../../logic/graph/node-catalog.ts'
import { renderAttemptDiagnostics } from '../../../../shared/diagnostics/diagnostics.ts'
import { preflightActionKey } from '../../../../shared/diagnostics/diagnostics-model.ts'
import type { BlueprintDefinition } from '../../../../../definition/types.ts'
import { nodeResourceRefs, ResourceProvenance, RevisionHistorySection, RunReportSection } from './run-insights.tsx'

export interface InspectorSidebarEnvironment {
  hostLink: HostLink | undefined
  openSession?: OpenExecutionChat
}

export interface InspectorSidebarProps extends BlueprintLocaleProps {
  id: string
  hidden: boolean
  workspace: BlueprintWorkspace
  workspaceView: WorkspacePresentation
  workspaceLease: ReturnType<PanelWorkspaceBinding['capture']>
  env: InspectorSidebarEnvironment
  editor: GraphEditor
  selectedNode: GraphEditor['nodes'][number] | undefined
  definition: BlueprintDefinition | null | undefined
  snapshot: ReturnType<BlueprintWorkspace['getSnapshot']>['run']['snapshot']
  overlayEligible: boolean
  modelCatalog: ModelCatalogSnapshot
  editable: boolean
  preflightWarningCount: number
  chatUnavailable: boolean
  perform: (action: () => Promise<unknown>) => void
  openChat: (sessionId: string, ownerId?: string) => void
  button: (key: BlueprintLocaleKey, action: string, onClick: () => void, disabled?: boolean, pressed?: boolean) => React.ReactElement
}

export function InspectorSidebar({
  t,
  id,
  hidden,
  workspace,
  workspaceView,
  workspaceLease,
  env,
  editor,
  selectedNode,
  definition,
  snapshot,
  overlayEligible,
  modelCatalog,
  editable,
  preflightWarningCount,
  chatUnavailable,
  perform,
  openChat,
  button
}: InspectorSidebarProps): React.ReactElement {
  const [previewRunId, setPreviewRunId] = React.useState<string | null>(null)
  const [frozenView, setFrozenView] = React.useState<InspectRunViewValue | null>(null)
  React.useEffect(() => {
    setPreviewRunId(null)
  }, [workspace.blueprintId, snapshot?.runId])
  React.useEffect(() => {
    let current = true
    setFrozenView(null)
    if (snapshot?.attempts.some(attempt => attempt.state === 'waiting_input')) {
      void env.hostLink?.inspectRunView?.({ runId: snapshot.runId }).then(
        view => {
          if (current && view.run.runId === snapshot.runId) setFrozenView(view)
        },
        () => {}
      )
    }
    return () => {
      current = false
    }
  }, [env.hostLink, snapshot?.runId, snapshot?.seq])
  const currentFrozen = frozenView?.run.runId === snapshot?.runId ? frozenView : null
  const chatWithoutSource = snapshot?.source === undefined && snapshot?.attempts.some(attempt => attempt.sessionId !== undefined)
  return (
    <aside className={'bp-inspector'} id={id} hidden={hidden} aria-label={t('inspector.ariaLabel')}>
      <h2>{t('inspector.title')}</h2>
      {selectedNode ? (
        <section>
          <h3>{editorNodeDisplayTitle(selectedNode, editor.nodes.indexOf(selectedNode), t)}</h3>
          <p className={'bp-node-id'} title={selectedNode.id}>
            {selectedNode.id}
          </p>
          <p className={'bp-help'}>{nodeKindTitle(selectedNode.kind, t)}</p>
          {selectedNode.kind === 'blueprintCall' && (
            <BlueprintCallInspector key={selectedNode.id} node={selectedNode} editor={editor} host={env.hostLink} disabled={!editable} t={t} />
          )}
          <fieldset className={'bp-inspector-guard'} disabled={!editable}>
            <NodeInspector
              key={selectedNode.id}
              node={selectedNode}
              disabled={!editable}
              editor={editor}
              resources={definition?.resources ?? {}}
              resourceCatalog={workspace.resourceCatalog}
              modelCatalog={modelCatalog.value ?? undefined}
              modelCatalogStatus={modelCatalog.status}
              t={t}
            />
          </fieldset>
          {definition?.graph.nodes.some(node => node.id === selectedNode.id) && (
            <ResourceProvenance
              key={`provenance-${selectedNode.id}`}
              t={t}
              nodeId={selectedNode.id}
              refs={nodeResourceRefs(definition.graph.nodes.find(node => node.id === selectedNode.id)!)}
              resources={definition.resources}
              bindingDigests={snapshot?.bindingDigests}
            />
          )}
        </section>
      ) : (
        <p className={'bp-help'}>{t('inspector.selectNode')}</p>
      )}
      <details data-bp-section={'preflight'} data-bp-disclosure={'preflight'} data-bp-preflight={workspaceView.preflight.status}>
        <summary data-bp-disclosure-toggle={'preflight'}>
          <strong>{t('preflight.title')}</strong>
          <span data-bp-summary-state={workspaceView.preflight.status}>{t(`preflight.${workspaceView.preflight.status}`)}</span>
          {preflightWarningCount > 0 && (
            <small data-bp-summary-warning={'warning'} data-bp-preflight-warning-count={preflightWarningCount}>
              {`${t('preflight.warning')} · ${preflightWarningCount}`}
            </small>
          )}
        </summary>
        {workspaceView.preflight.code && <p data-bp-preflight-code={true}>{workspaceView.preflight.code}</p>}
        {workspaceView.preflight.documentRevision && (
          <p data-bp-preflight-revision={workspaceView.preflight.documentRevision}>{workspaceView.preflight.documentRevision}</p>
        )}
        <ul>
          {workspaceView.preflight.checks.map((check, index) => (
            <li key={index} data-bp-check-status={check.status}>
              <strong>{t(`preflight.${check.status}`)}</strong>
              {' · '}
              {check.code}
              {[check.nodeId, check.resourceId, check.toolName].filter(value => value !== undefined).map(value => ` · ${value}`)}
              <small data-bp-check-action={true}>{t(preflightActionKey(check.code))}</small>
            </li>
          ))}
        </ul>
      </details>
      <details data-bp-section={'run'} data-bp-disclosure={'run'}>
        <summary data-bp-disclosure-toggle={'run'}>
          <strong>{t('run.title')}</strong>
          <span data-bp-summary-state={workspaceView.run.state ?? 'none'}>
            {workspaceView.run.state
              ? `${workspaceView.run.runId} · ${runStateTitle(workspaceView.run.state, t)}`
              : t(env.hostLink ? 'run.none' : 'status.hostUnavailable')}
          </span>
          {workspaceView.run.connectionState === 'stale' && <small>{t('run.stale')}</small>}
          {[
            ...new Set(
              (snapshot?.attempts ?? [])
                .filter(attempt => ['waiting_input', 'failed', 'timed_out', 'recovery_required'].includes(attempt.state))
                .map(attempt => attempt.state)
            )
          ].map(state => (
            <small key={state} data-bp-summary-warning={state}>
              {runStateTitle(state, t)}
            </small>
          ))}
        </summary>
        <label className={'bp-field'}>
          {t('run.inputJson')}
          <JsonEditor
            key={workspace.blueprintId}
            data-bp-run-input={true}
            label={t('run.inputJson')}
            t={t}
            value={workspaceView.inputJson}
            onChange={text => {
              workspaceLease.dispatch({ type: 'set-input', inputJson: text })
            }}
            rows={3}
          />
        </label>
        <form
          key={workspace.blueprintId}
          onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            const id = String(new FormData(event.currentTarget).get('runId'))
            if (id) {
              workspaceLease.dispatch({ type: 'bind-run', runId: id })
              perform(() => workspace.inspect())
            }
          }}
        >
          <input name={'runId'} aria-label={t('run.inspectId')} disabled={workspace.busy} placeholder={t('run.existingId')} />
          <button type={'submit'} data-bp-action={'inspect-run'} disabled={workspace.busy}>
            {t('run.inspectReconnect')}
          </button>
        </form>
        <p data-bp-run={snapshot?.state ?? 'none'}>
          {snapshot ? `${snapshot.runId} · ${runStateTitle(snapshot.state, t)}` : t(env.hostLink ? 'run.none' : 'status.hostUnavailable')}
        </p>
        {snapshot && (
          <p className={'bp-run-revision'} data-bp-run-revision={snapshot.definitionRevision}>
            <span>{t('run.definitionRevision')}</span>
            {' · '}
            {snapshot.definitionRevision}
          </p>
        )}
        {snapshot && !overlayEligible && <p className={'bp-overlay-notice'}>{t('run.overlayUnavailable')}</p>}
        <p data-bp-connection={workspace.model.connectionState}>{t(workspace.model.connectionState === 'stale' ? 'run.stale' : 'run.connected')}</p>
        {button('run.retryInspect', 'retry-inspect', () => perform(() => workspace.inspect()), !workspace.runId || workspace.busy)}
        {chatUnavailable && (
          <p role={'status'} data-bp-chat-unavailable={true}>
            {t('conversation.chatUnavailable')}
          </p>
        )}
        {env.openSession && chatWithoutSource && (
          <p className={'bp-help'} id={`${id}-chat-without-source`} data-bp-chat-unavailable-reason={'no-source'}>
            {t('conversation.chatWithoutSource')}
          </p>
        )}
        {env.openSession && snapshot?.source && (
          <button type={'button'} data-bp-source-chat={snapshot.source.sessionId} onClick={() => openChat(snapshot.source!.sessionId)}>
            {t('conversation.sourceChat')}
          </button>
        )}
        {(env.openSession ? (snapshot?.team?.members ?? []) : []).map(member => (
          <button
            key={member.memberId}
            type={'button'}
            data-bp-open-member={member.memberId}
            disabled={member.sessionId === undefined}
            onClick={() => {
              if (member.sessionId) openChat(member.sessionId, snapshot?.team?.leadSessionId)
            }}
          >
            {member.name ?? member.memberId}
            {' · '}
            {t('conversation.openChat')}
          </button>
        ))}
        <RunReportSection t={t} hostLink={env.hostLink} workspace={workspace} snapshot={snapshot} perform={perform} />
        {currentFrozen?.run.attempts.some(
          attempt => attempt.state === 'waiting_input' && currentFrozen.graph.nodes.some(node => node.id === attempt.nodeId && node.kind === 'humanDecision')
        ) && (
          <div>
            {button('run.approve', 'approve', () => perform(() => workspace.decide('approve')), workspace.busy)}
            {button('run.reject', 'reject', () => perform(() => workspace.decide('reject')), workspace.busy)}
          </div>
        )}
        {currentFrozen?.run.attempts.some(
          attempt => attempt.state === 'waiting_input' && currentFrozen.graph.nodes.some(node => node.id === attempt.nodeId && node.interaction === 'managed')
        ) && (
          <p className="bp-help" data-bp-managed-waiting>
            {t('conversation.managedWaiting')}
          </p>
        )}
        {snapshot && env.hostLink?.inspectRunView && (
          <button type="button" data-bp-run-preview-open={snapshot.runId} onClick={() => setPreviewRunId(snapshot.runId)}>
            {t('conversation.graph')}
          </button>
        )}
        {env.hostLink?.inspectRunView &&
          snapshot?.attempts
            .filter(attempt => attempt.childRunId !== undefined)
            .map(attempt => (
              <button key={attempt.attemptId} type="button" data-bp-run-preview-open={attempt.childRunId} onClick={() => setPreviewRunId(attempt.childRunId!)}>
                {attempt.nodeId} · {t('conversation.openChild')}
              </button>
            ))}
        {(snapshot?.attempts ?? []).map((attempt, index) => (
          <details key={`${attempt.nodeId}-${index}`} data-bp-attempt={attempt.nodeId}>
            <summary>{t('run.attempt', { nodeId: attempt.nodeId, attempt: attempt.attempt, state: runStateTitle(attempt.state, t) })}</summary>
            {attempt.outputJson !== undefined && <pre data-bp-output={attempt.nodeId}>{attempt.outputJson}</pre>}
            {attempt.errorCode && <p>{attempt.errorCode}</p>}
            {attempt.state === 'failed' && <p data-bp-failure-explanation={attempt.attemptId ?? attempt.nodeId}>{t('conversation.failedHistory')}</p>}
            {env.openSession && (
              <button
                type={'button'}
                data-bp-open-attempt={attempt.attemptId}
                disabled={snapshot?.source === undefined || attempt.attemptId === undefined || attempt.sessionId === undefined}
                aria-describedby={chatWithoutSource ? `${id}-chat-without-source` : undefined}
                onClick={() => {
                  if (snapshot?.source && attempt.attemptId && attempt.sessionId) openChat(attempt.sessionId, snapshot.source.sessionId)
                }}
              >
                {t('conversation.openChat')}
              </button>
            )}
            {renderAttemptDiagnostics(attempt.diagnostics, t)}
          </details>
        ))}
        <ol className={'bp-log'}>
          {(snapshot?.logTail ?? []).map(log => (
            <li key={log.seq}>{`${log.seq} · ${log.kind}`}</li>
          ))}
        </ol>
      </details>
      <RevisionHistorySection t={t} hostLink={env.hostLink} workspace={workspace} editable={editable} perform={perform} />
      {previewRunId && env.hostLink && (
        <RunHierarchyPreview
          key={previewRunId}
          runId={previewRunId}
          host={env.hostLink}
          t={t}
          onClose={() => setPreviewRunId(null)}
          openChat={env.openSession ? openChat : undefined}
        />
      )}
    </aside>
  )
}
