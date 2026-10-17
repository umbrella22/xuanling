/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import type { InspectSessionValue } from '../../../../conversation/contracts.ts'
import type { BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import type { ConversationController, ConversationSnapshot } from '../logic/conversation-controller.ts'
import type { OpenExecutionChat } from '../logic/chat-navigation.ts'
import { renderTeamStage } from './conversation-team-stage.tsx'
import type { TeamMemberActivity } from './conversation-canvas.ts'
import { displayState } from '../presenters/conversation-presenter.ts'

export interface ConversationAttemptsProps {
  bound: Extract<InspectSessionValue, { status: 'bound' }>
  snapshot: ConversationSnapshot
  memberActivities: TeamMemberActivity[]
  controller: Pick<ConversationController, 'selectAttempt'>
  fit: (nodeIds: string[]) => void
  t: BlueprintLocaleProps['t']
  openSession: OpenExecutionChat | undefined
  openChat: (target: string) => void
}

export function renderConversationAttempts({
  bound,
  snapshot,
  memberActivities,
  controller,
  fit,
  t,
  openSession,
  openChat
}: ConversationAttemptsProps): React.ReactElement {
  return (
    <aside className={'bp-conversation-attempts'} aria-label={t('conversation.attempts')}>
      <strong>{t('conversation.attempts')}</strong>
      <span className={'bp-run-revision'}>{bound.selected.run.definitionRevision}</span>
      {bound.selected.run.team
        ? renderTeamStage(bound.selected.run.team, memberActivities, snapshot.connection === 'connected', t, openSession ? openChat : undefined)
        : null}
      {bound.selected.run.attempts.map((attempt, index) => (
        <div key={attempt.attemptId ?? `legacy-${index}`} className={'bp-conversation-attempt'}>
          <button
            type={'button'}
            data-bp-attempt-id={attempt.attemptId}
            data-bp-attempt-state={attempt.state}
            data-bp-focus={attempt.attemptId !== undefined && bound.selected.focusAttemptIds.includes(attempt.attemptId)}
            aria-pressed={attempt.attemptId !== undefined && attempt.attemptId === snapshot.selectedAttemptId}
            disabled={attempt.attemptId === undefined}
            onClick={() => {
              if (attempt.attemptId) {
                controller.selectAttempt(attempt.attemptId)
                fit([attempt.nodeId])
              }
            }}
          >
            {t('run.attempt', { nodeId: attempt.nodeId, attempt: attempt.attempt, state: displayState(attempt.state, t) })}
            <small>{attempt.attemptId ?? t('conversation.legacyAttempt')}</small>
          </button>
          {openSession && (
            <button
              type={'button'}
              data-bp-open-attempt={attempt.attemptId}
              disabled={
                attempt.attemptId === undefined ||
                attempt.sessionId === undefined ||
                !bound.selected.graph.nodes.some(node => node.id === attempt.nodeId && node.kind === 'agentTask')
              }
              onClick={() => {
                if (attempt.sessionId !== undefined && attempt.attemptId !== undefined) openChat(attempt.sessionId)
              }}
            >
              {t('conversation.openChat')}
            </button>
          )}
          {attempt.attemptId === snapshot.selectedAttemptId && attempt.state === 'failed' && (
            <div>
              <p data-bp-failure-explanation={attempt.attemptId}>{t('conversation.failedHistory')}</p>
              {bound.selected.source && openSession && (
                <button type={'button'} data-bp-source-chat={bound.selected.source.sessionId} onClick={() => openChat(bound.selected.source!.sessionId)}>
                  {t('conversation.sourceChat')}
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </aside>
  )
}
