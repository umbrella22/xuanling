import React from 'react'
import { createRoot } from 'react-dom/client'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'
import { composerSlot } from './composer-slot-fixture.ts'
const initial = (window as any).fixtureInitial as { sessionId: string }
let dropReceipt = false
const namespace = Object.fromEntries(
  BLUEPRINT_INVOCATIONS.map(({ method }) => [
    method,
    async (args = {}) => {
      const response = await fetch(`/rpc/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
      const result = await response.json()
      if (method === 'messageNode' && dropReceipt) {
        dropReceipt = false
        throw new Error('transport unavailable')
      }
      return result
    }
  ])
)
const fixture = await composerSlot(namespace, [initial.sessionId, 'unrelated'])
const root = createRoot(document.getElementById('root')!)
let selected = initial.sessionId
const render = () => {
  const found = fixture.choose(selected)
  root.render(found ? React.createElement(found.entry.component as any, { matched: found.matched, t: fixture.t }) : null)
}
fixture.slots.subscribe('conversation.composer', render)
Object.assign(window, {
  composer: {
    dropReceipt: () => {
      dropReceipt = true
    },
    select: (id: string) => {
      selected = id
      render()
    },
    locale: (lang: 'en' | 'zh') => {
      fixture.locale(lang)
      render()
    },
    dispose: () => fixture.dispose()
  }
})
render()
