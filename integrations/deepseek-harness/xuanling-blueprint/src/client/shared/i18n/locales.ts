/** Product copy only. User names, refs, ports, prompts and unknown kinds stay verbatim. */
import type { LocaleDictOf, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ViewMessageKey } from '../contracts/view-contract.ts'
import { zh as conversationZh, en as conversationEn } from './conversation.ts'
import { zh as commandsZh, en as commandsEn } from './commands.ts'
import { zh as interactionZh, en as interactionEn } from './interaction.ts'
import { zh as resourcesZh, en as resourcesEn } from './resources.ts'
import { zh as inspectorZh, en as inspectorEn } from './inspector.ts'
import { zh as documentZh, en as documentEn } from './document.ts'
import { zh as historyZh, en as historyEn } from './history.ts'

export const BLUEPRINT_LOCALE = 'xuanlingBlueprint'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    xuanlingBlueprint: BlueprintLocaleKey
  }
}

/** Standard slot-injected translator seat; W3 passes it down, never through domain state. */
export type BlueprintLocaleProps = PropsLocale<typeof BLUEPRINT_LOCALE>

export const zh = {
  ...conversationZh,
  ...commandsZh,
  ...interactionZh,
  ...resourcesZh,
  ...inspectorZh,
  ...documentZh,
  ...historyZh
} satisfies Record<ViewMessageKey, string> & Record<string, string>

export type BlueprintLocaleKey = keyof typeof zh

/** Missing/extra English keys are compile errors, including every foundation descriptor. */
export const en = {
  ...conversationEn,
  ...commandsEn,
  ...interactionEn,
  ...resourcesEn,
  ...inspectorEn,
  ...documentEn,
  ...historyEn
} satisfies LocaleDictOf<typeof BLUEPRINT_LOCALE>
