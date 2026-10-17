import { conversationCss } from '../../../shared/styles/conversation.ts'

export function installConversationStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('xuanling-blueprint-conversation-css')) return
  const style = document.createElement('style')
  style.id = 'xuanling-blueprint-conversation-css'
  style.textContent = conversationCss
  document.head.appendChild(style)
}
