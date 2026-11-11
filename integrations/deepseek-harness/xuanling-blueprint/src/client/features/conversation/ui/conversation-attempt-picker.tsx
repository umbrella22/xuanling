/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import type { BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import type { FrozenAttemptChoice, FrozenPickerProps } from './conversation-canvas.ts'
import { displayState } from '../presenters/conversation-presenter.ts'

/** Explicit multi-attempt selection. Ordinal order is the display order; the
 * picker never pre-selects, and legacy attempts stay visible but disabled.
 * Rendered outside the node's measured content box as an overlay popover. */
export function renderAttemptPicker(
  data: {
    nodeId: string
    attemptChoices?: FrozenAttemptChoice[]
    /** Visibility is CSS-only (is-open); the markup stays so the explicit
     * choice list is a stable DOM fact. */
    pickerOpen?: boolean
  } & FrozenPickerProps,
  t: BlueprintLocaleProps['t']
): React.ReactElement {
  const choices = data.attemptChoices ?? []
  return (
    <div
      className={`bp-attempt-picker${data.pickerOpen === true ? ' is-open' : ''}`}
      data-bp-attempt-picker={data.nodeId}
      role={'menu'}
      aria-label={t('conversation.attemptPicker')}
    >
      {choices.map(choice =>
        choice.attemptId === undefined ? (
          <button key={`legacy-${choice.attempt}`} type={'button'} className={'bp-attempt-choice'} data-bp-picker-legacy={choice.attempt} disabled={true}>
            {t('run.attempt', { nodeId: data.nodeId, attempt: choice.attempt, state: displayState(choice.state, t) })}
            <small>{t('conversation.legacyAttempt')}</small>
          </button>
        ) : (
          <div key={choice.attemptId} className={'bp-attempt-choice'} data-bp-picker-attempt={choice.attemptId} data-bp-picker-state={choice.state}>
            <button type={'button'} data-bp-attempt-id={choice.attemptId} onClick={() => data.onPickAttempt?.(choice.attemptId!)}>
              {t('run.attempt', { nodeId: data.nodeId, attempt: choice.attempt, state: displayState(choice.state, t) })}
            </button>
            {choice.sessionId !== undefined && data.onOpenAttemptChat !== undefined ? (
              <button type={'button'} disabled={false} data-bp-open-attempt={choice.attemptId} onClick={() => data.onOpenAttemptChat?.(choice.attemptId!)}>
                {t('conversation.openChat')}
              </button>
            ) : null}
            {choice.childRunId !== undefined && data.onOpenChildRun !== undefined ? (
              <button type={'button'} disabled={false} data-bp-open-child={choice.childRunId} onClick={() => data.onOpenChildRun?.(choice.childRunId!)}>
                {t('conversation.openChild')}
              </button>
            ) : null}
          </div>
        )
      )}
    </div>
  )
}
