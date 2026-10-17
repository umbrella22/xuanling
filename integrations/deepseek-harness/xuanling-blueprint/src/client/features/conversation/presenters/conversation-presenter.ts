/** Pure Conversation display projection. It reads detached controller state and owns no runtime effects. */
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import { en } from '../../../shared/i18n/locales.ts'
import type { ConversationSnapshot } from '../logic/conversation-controller.ts'

export function displayState(state: string, t: BlueprintLocaleProps['t']): string {
  const key = `state.${state}`
  if (Object.hasOwn(en, key)) return t(key as BlueprintLocaleKey)
  return state === 'idle' ? t('node.notRunning') : t('node.unknownState')
}

export function presentConversation(snapshot: ConversationSnapshot, sessionId: string, _t: BlueprintLocaleProps['t']) {
  const value = snapshot.sessionId === sessionId ? snapshot.value : null
  const connection = snapshot.sessionId === sessionId ? snapshot.connection : 'loading'
  const bound = value?.status === 'bound' ? value : null
  const status: BlueprintLocaleKey =
    connection === 'stale'
      ? 'conversation.stale'
      : connection === 'unavailable'
        ? 'conversation.unavailable'
        : value?.status === 'unbound'
          ? 'conversation.unbound'
          : value === null
            ? 'conversation.loading'
            : 'conversation.connected'
  return { value, connection, bound, status }
}
