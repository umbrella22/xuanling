/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import type { BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import type { ManagedComposerController } from '../logic/managed-composer-controller.ts'
import { installCanvasStyles } from '../../../shared/styles/styles.ts'

export function ManagedNodeComposer({ matched, t }: BlueprintLocaleProps & { matched: { controller: ManagedComposerController } }) {
  const { controller } = matched
  const value = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  React.useEffect(() => {
    installCanvasStyles()
  }, [])
  const fieldId = React.useId()
  const closed = value.node?.status === 'managed' && !value.node.canMessage
  const writable = value.connection === 'ready' && value.node?.status === 'managed' && value.node.canMessage
  const busy = value.submission === 'sending'
  const uncertain = value.submission === 'uncertain'
  return (
    <form
      className="bp-workspace bp-managed-composer"
      data-bp-managed-composer={controller.sessionId}
      onSubmit={event => {
        event.preventDefault()
        void controller.send(uncertain)
      }}
    >
      <strong>{t('managed.title')}</strong>
      <p className="bp-help">{t('managed.help')}</p>
      {closed && <p data-bp-managed-closed>{t('managed.closed')}</p>}
      <label htmlFor={fieldId}>{t('managed.input')}</label>
      <textarea
        id={fieldId}
        data-bp-managed-input
        value={value.draft}
        disabled={closed}
        readOnly={busy || uncertain}
        onChange={event => controller.setDraft(event.currentTarget.value)}
      />
      <div className="bp-managed-actions">
        <label>
          <input
            type="radio"
            name={`${fieldId}-delivery`}
            checked={value.delivery === 'queue'}
            disabled={!writable || busy || uncertain}
            onChange={() => controller.setDelivery('queue')}
          />
          {t('managed.queue')}
        </label>
        <label>
          <input
            type="radio"
            name={`${fieldId}-delivery`}
            checked={value.delivery === 'steer'}
            disabled={!writable || busy || uncertain}
            onChange={() => controller.setDelivery('steer')}
          />
          {t('managed.steer')}
        </label>
        {uncertain ? (
          <button type="submit" data-bp-managed-retry disabled={!writable}>
            {t('managed.retry')}
          </button>
        ) : (
          <button type="submit" data-bp-managed-send disabled={!writable || busy || !value.draft.trim()}>
            {t(busy ? 'managed.sending' : 'managed.send')}
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {value.connection !== 'ready'
          ? t(value.connection === 'loading' ? 'managed.loading' : 'managed.unavailable')
          : uncertain || value.submission === 'rejected'
            ? t('managed.failed')
            : value.submission === 'sent'
              ? t('managed.sent')
              : ''}
      </p>
    </form>
  )
}
