/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import type { TeamStageProjection } from '../../../../conversation/contracts.ts'
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import { displayState } from '../presenters/conversation-presenter.ts'
import type { TeamMemberActivity } from './conversation-canvas.ts'

export function renderTeamStage(
  team: TeamStageProjection,
  activities: TeamMemberActivity[],
  connected: boolean,
  t: BlueprintLocaleProps['t'],
  openChat?: (sessionId: string) => void
): React.ReactElement {
  const fact = (label: BlueprintLocaleKey, value: string, attributes: Record<string, string | number | undefined> = {}) => (
    <div key={label} {...attributes}>
      <dt>{t(label)}</dt>
      <dd>
        <code>{value}</code>
      </dd>
    </div>
  )
  const stageState = ['provisioning', 'active'].includes(team.state)
    ? t(`conversation.team.state.${team.state}` as BlueprintLocaleKey)
    : displayState(team.state, t)
  return (
    <section
      className={'bp-team-stage'}
      aria-label={t('conversation.teamStage')}
      data-bp-team-stage={team.stageId}
      data-bp-team-run={team.runId}
      data-bp-team-state={team.state}
      data-bp-team-observation={connected ? 'current' : 'stale'}
    >
      <div className={'bp-team-heading'}>
        <strong>{t('conversation.teamStage')}</strong>
        <span className={'bp-team-state'}>{stageState}</span>
      </div>
      <code className={'bp-team-stage-id'}>{team.stageId}</code>
      {connected ? null : (
        <p className={'bp-team-stale'} role={'status'}>
          {t('conversation.team.stale')}
        </p>
      )}
      <dl className={'bp-team-facts'}>
        {fact('conversation.team.lead', team.leadSessionId)}
        {fact('conversation.team.run', team.runId)}
        {team.taskId === undefined
          ? []
          : [
              fact('conversation.team.task', team.taskId, {
                'data-bp-team-task-id': team.taskId,
                'data-bp-team-task-revision': team.taskRevision
              })
            ]}
      </dl>
      {team.taskRevision === undefined ? null : <small>{t('conversation.team.revision', { revision: team.taskRevision })}</small>}
      <div className={'bp-team-activity'} aria-label={t('conversation.teamActivity')}>
        <strong>{t('conversation.team.members')}</strong>
        {team.members.map(member => {
          const activity = activities.find(value => value.memberId === member.memberId)
          return (
            <div
              key={member.memberId}
              className={'bp-team-member'}
              data-bp-member-id={member.memberId}
              data-bp-member-phase={member.phase}
              data-bp-member-status={member.status}
              data-bp-member-session={member.sessionId}
              data-bp-activity={activity?.activity ?? 'unavailable'}
            >
              <span>{member.name ?? member.memberId}</span>
              <small>
                {t(`conversation.team.phase.${member.phase}`)}
                {' · '}
                {member.status === 'inactive' ? t('conversation.team.status.inactive') : displayState(member.status, t)}
              </small>
              <small>
                {t(`conversation.activity.${activity?.activity ?? 'unavailable'}`)}
                {activity?.elapsedSeconds === undefined ? '' : ` · ${t('conversation.activity.elapsed', { seconds: activity.elapsedSeconds })}`}
              </small>
              {member.sessionId === undefined ? null : <code>{member.sessionId}</code>}
              {openChat && (
                <button
                  type={'button'}
                  data-bp-open-member={member.memberId}
                  disabled={member.sessionId === undefined}
                  onClick={() => {
                    if (member.sessionId !== undefined) openChat(member.sessionId)
                  }}
                >
                  {t('conversation.openChat')}
                </button>
              )}
            </div>
          )
        })}
      </div>
      {team.outputAcceptance === undefined ? null : (
        <details className={'bp-team-evidence'} data-bp-team-acceptance={team.outputAcceptance.code}>
          <summary>
            {t('conversation.team.acceptance')}
            {' · '}
            {t(`conversation.team.acceptance.${team.outputAcceptance.code}`)}
          </summary>
          <dl className={'bp-team-facts'}>
            {fact('conversation.team.artifact', team.outputAcceptance.artifactId)}
            {fact('conversation.team.producer', team.outputAcceptance.sourceSessionId)}
            {fact('conversation.team.digest', team.outputAcceptance.digest)}
            {team.outputAcceptance.issueCode === undefined ? [] : [fact('conversation.team.reason', team.outputAcceptance.issueCode)]}
          </dl>
          <strong>{t('conversation.team.checks')}</strong>
          <ul>
            {team.outputAcceptance.checks.map(check => (
              <li key={check}>{check}</li>
            ))}
          </ul>
        </details>
      )}
      {team.recovery === undefined ? null : <dl className={'bp-team-facts'}>{fact('conversation.team.reason', team.recovery.code)}</dl>}
    </section>
  )
}
