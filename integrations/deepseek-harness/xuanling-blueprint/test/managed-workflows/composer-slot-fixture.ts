import React from 'react'
import { Context } from '@deepseek-ai/cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../../src/client/index.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
export async function composerSlot(namespace: any, sessionIds: string[]) {
  const ctx = new Context(),
    slots = new SlotCore()
  slots.register(
    {
      name: 'root',
      children: {
        'conversation.composer': { kind: 'chain', scope: 'session' },
        'conversation.view': { kind: 'list', scope: 'session' },
        main: { kind: 'keyed', scope: 'global' },
        'sidebar.panellist': { kind: 'list', scope: 'global' }
      }
    } as any,
    () => null
  )
  const native = () => React.createElement('p', { 'data-native-composer': true }, 'Native composer')
  slots.register({ name: 'conversation.composer', priority: -10, select: () => ({}) } as any, native)
  const listeners = new Set<() => void>()
  const bindings = new Map(
    sessionIds.map(sessionId => [
      sessionId,
      {
        sessionId,
        session: {
          getSnapshot: () => ({ sessionId, removed: false, subagent: { address: { mode: 'one-shot', childSessionId: sessionId, parentSessionId: 'parent' } } }),
          subscribe: (fn: () => void) => {
            listeners.add(fn)
            return () => listeners.delete(fn)
          }
        }
      }
    ])
  )
  const list = {
    getSnapshot: () => ({ byId: Object.fromEntries([...bindings.keys()].map(id => [id, { id }])) }),
    subscribe: (fn: () => void) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }
  }
  ctx.provide('sessions', { list, binding: (id: string) => bindings.get(id) } as any)
  ctx.provide('uiSession', {} as any)
  ctx.provide('uiWorkspace', {} as any)
  let language: 'en' | 'zh' = 'en'
  const t = (key: string, params: Record<string, unknown> = {}) =>
    (language === 'en' ? en : zh)[key as keyof typeof en]?.replace(/\{(\w+)\}/g, (_, name) => String(params[name])) ?? key
  ctx.provide('locale', { register: () => () => {}, bind: () => t } as any)
  ctx.provide('slots', { register: slots.register.bind(slots), inject: (_key: string, register: () => () => void) => register() } as any)
  ctx.provide('remote', { $mount: async () => ctx.provide('remote.blueprint', namespace) } as any)
  const fiber = ctx.plugin({ inject, apply })
  await fiber
  const owner = (sessionId: string, pendingInteraction?: unknown) => ({
    sessionId,
    session: bindings.get(sessionId)?.session.getSnapshot(),
    pendingInteraction
  })
  const choose = (sessionId: string, pendingInteraction?: unknown) => {
    const props = owner(sessionId, pendingInteraction)
    for (const entry of slots.entriesOfSlot('conversation.composer')) {
      const matched = entry.select?.(props as any)
      if (matched != null) return { entry, matched }
    }
    return undefined
  }
  return {
    ctx,
    slots,
    native,
    t,
    choose,
    bindings,
    locale: (value: 'en' | 'zh') => {
      language = value
    },
    notify: () => listeners.forEach(fn => fn()),
    dispose: () => fiber.dispose()
  }
}
