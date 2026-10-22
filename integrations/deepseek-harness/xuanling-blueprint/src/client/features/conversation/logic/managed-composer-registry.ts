import type React from 'react'
import type { ISessions, SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ComposerChainProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { BLUEPRINT_LOCALE } from '../../../shared/i18n/locales.ts'
import { ManagedComposerController } from './managed-composer-controller.ts'
import type { ManagedComposerHost } from './managed-composer-controller.ts'
import { ManagedNodeComposer } from '../ui/managed-node-composer.tsx'

interface ComposerSlots {
  register<Props>(options: Record<string, unknown>, component: React.ComponentType<Props>): () => void
}

/** Register only after Host membership is confirmed. Unmanaged one-shot Sessions retain the native seat. */
export function observeManagedComposers(sessions: ISessions, slots: ComposerSlots, host: ManagedComposerHost): () => void {
  const entries = new Map<SessionBinding, { controller: ManagedComposerController; dispose?: () => void }>()
  let active = true
  const current = (binding: SessionBinding) =>
    active &&
    sessions.binding(binding.sessionId) === binding &&
    !binding.session.getSnapshot().removed &&
    binding.session.getSnapshot().subagent?.address.mode === 'one-shot'
  const discover = () => {
    if (!active) return
    for (const [binding, entry] of entries)
      if (!current(binding)) {
        entry.controller.close()
        entry.dispose?.()
        entries.delete(binding)
      }
    for (const id of Object.keys(sessions.list.getSnapshot().byId)) {
      const binding = sessions.binding(id as SessionId)
      if (!binding || !current(binding)) continue
      let entry = entries.get(binding)
      if (!entry) {
        entry = { controller: new ManagedComposerController(host, id) }
        entries.set(binding, entry)
      }
      const owned = entry
      void owned.controller.refresh().then(() => {
        if (!current(binding) || entries.get(binding) !== owned) return
        const snapshot = owned.controller.getSnapshot()
        if (snapshot.connection !== 'ready') return
        if (snapshot.node?.status !== 'managed') {
          owned.dispose?.()
          delete owned.dispose
          return
        }
        owned.dispose ??= slots.register(
          {
            name: 'conversation.composer',
            priority: -20,
            locale: BLUEPRINT_LOCALE,
            select: (owner: ComposerChainProps) =>
              current(binding) && owner.sessionId === binding.sessionId && !owner.pendingInteraction && owner.session?.subagent?.address.mode === 'one-shot'
                ? { controller: owned.controller }
                : null
          },
          ManagedNodeComposer
        )
      })
    }
  }
  const unsubscribe = sessions.list.subscribe(discover)
  const timer = setInterval(discover, 1500)
  discover()
  return () => {
    active = false
    clearInterval(timer)
    unsubscribe()
    for (const entry of entries.values()) {
      entry.controller.close()
      entry.dispose?.()
    }
    entries.clear()
  }
}
