import { conversationCss } from '../../../shared/styles/conversation.ts'

export function installConversationStyles(): void {
  if (typeof document === 'undefined') return
  // A plugin update can swap JSX while an older style element survives a page
  // that did not reload; converge the sheet to this build instead of skipping.
  const existing = document.getElementById('xuanling-blueprint-conversation-css')
  if (existing) {
    if (existing.textContent !== conversationCss) existing.textContent = conversationCss
    return
  }
  const style = document.createElement('style')
  style.id = 'xuanling-blueprint-conversation-css'
  style.textContent = conversationCss
  document.head.appendChild(style)
}
