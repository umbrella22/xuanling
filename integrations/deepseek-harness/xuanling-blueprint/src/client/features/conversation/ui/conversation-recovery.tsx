/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import type { InspectSessionValue } from '../../../../conversation/contracts.ts'
import type { BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import type { ConversationController, ConversationSnapshot } from '../logic/conversation-controller.ts'
import { conversationRecoveryState } from '../logic/conversation-controller.ts'
import { displayState } from '../presenters/conversation-presenter.ts'

export interface ConversationRecoveryProps {
  bound: Extract<InspectSessionValue, { status: 'bound' }>
  snapshot: ConversationSnapshot
  controller: Pick<ConversationController, 'resolveRecovery' | 'getSnapshot'>
  t: BlueprintLocaleProps['t']
}

/** Human resolution of a \`recovery_required\` Run. The unknown effect is never
 * replayed here; the note is required because it becomes the audit evidence.
 * A TeamStage with an unknown native effect stays manual: the contract rejects
 * resolution until the native Team has been cleaned up.
 *
 * The refreshed Run is terminal after a successful resolution, so the recorded
 * status outlives the form until another Run is selected. */
export function ConversationRecoverySection({ bound, snapshot, controller, t }: ConversationRecoveryProps): React.ReactElement | null {
  const recovery = conversationRecoveryState(bound)
  const runId = bound.selected.run.runId
  const [note, setNote] = React.useState('')
  const [quiescent, setQuiescent] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [resolved, setResolved] = React.useState<string | null>(null)
  const [errorCode, setErrorCode] = React.useState<string | null>(null)
  React.useEffect(() => {
    setNote('')
    setQuiescent(false)
    setBusy(false)
    setResolved(null)
    setErrorCode(null)
  }, [runId])
  if (recovery === 'none' && resolved === null && errorCode === null) return null
  const resolve = (resolution: 'failed' | 'succeeded') => {
    setBusy(true)
    setErrorCode(null)
    void controller.resolveRecovery(resolution, note, quiescent).then(applied => {
      setBusy(false)
      if (applied) {
        setResolved(resolution)
        return
      }
      setErrorCode(controller.getSnapshot().errorCode ?? 'blueprint/remote-failed')
    })
  }
  const disabled = busy || snapshot.connection !== 'connected' || note.trim().length === 0
  return (
    <section className={'bp-conversation-recovery'} data-bp-recovery={runId} data-bp-recovery-kind={recovery}>
      {recovery === 'none' ? null : (
        <div>
          <strong>{t('recovery.title')}</strong>
          {recovery === 'team-manual' ? (
            <p className={'bp-help'} role={'status'} data-bp-recovery-manual={true}>
              {t('recovery.teamManual')}
            </p>
          ) : (
            <div>
              <p className={'bp-help'}>{t('recovery.help')}</p>
              <label className="bp-field">
                <input type="checkbox" checked={quiescent} onChange={event => setQuiescent(event.currentTarget.checked)} />
                {t('recovery.quiescent')}
              </label>
              <label className={'bp-field'}>
                {t('recovery.note')}
                <textarea
                  data-bp-recovery-note={true}
                  rows={3}
                  maxLength={500}
                  value={note}
                  disabled={busy}
                  onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setNote(event.currentTarget.value)}
                />
              </label>
              <button type={'button'} data-bp-action={'recovery-failed'} disabled={disabled} onClick={() => resolve('failed')}>
                {t('recovery.markFailed')}
              </button>
              <button type={'button'} data-bp-action={'recovery-succeeded'} disabled={disabled} onClick={() => resolve('succeeded')}>
                {t('recovery.markSucceeded')}
              </button>
            </div>
          )}
        </div>
      )}
      {resolved !== null && (
        <p role={'status'} data-bp-recovery-resolved={resolved}>
          {t('recovery.resolved', { state: displayState(resolved, t) })}
        </p>
      )}
      {errorCode !== null && (
        <p role={'alert'} data-bp-recovery-error={errorCode}>
          {t('status.error', { code: errorCode })}
        </p>
      )}
    </section>
  )
}
