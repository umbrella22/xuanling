import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConversationController, resolveConversationHost } from '../../src/client/features/conversation/logic/conversation-controller.ts'
import { ConversationBlueprintView } from '../../src/client/features/conversation/ui/conversation-view.tsx'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'
import { en, zh } from '../../src/client/shared/i18n/locales.ts'
const initial = (window as any).fixtureInitial as { sessionId: string }
const namespace = Object.fromEntries(
  BLUEPRINT_INVOCATIONS.map(({ method }) => [
    method,
    async (args = {}) => (await fetch(`/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })).json()
  ])
)
const controller = new ConversationController(resolveConversationHost({ get: () => namespace }), initial.sessionId)
const openCalls: string[] = []
const root = createRoot(document.getElementById('root')!)
let language: 'en' | 'zh' = 'en'
const render = () =>
  root.render(
    React.createElement(ConversationBlueprintView, {
      controller,
      sessionId: initial.sessionId as any,
      t: (key, params = {}) => (language === 'en' ? en : zh)[key].replace(/\{(\w+)\}/g, (_, name) => String(params[name as keyof typeof params])),
      openSession: async id => {
        openCalls.push(id)
        return true
      }
    } as any)
  )
Object.assign(window, {
  runtimeView: {
    state: controller.getSnapshot,
    openCalls,
    locale: (value: 'en' | 'zh') => {
      language = value
      render()
    }
  }
})
document.body.style.margin = '0'
render()
