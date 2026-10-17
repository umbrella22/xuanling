import type React from 'react'
type ReactSeat = typeof React
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../i18n/locales.ts'
import { installTooltipBrowserEffects } from '../../adapters/browser/tooltip-browser-effects.ts'
import { tooltipView } from './tooltip-view.tsx'
export interface TooltipContent {
  action: string
  labelKey: BlueprintLocaleKey
  /** Optional non-localized copy for dynamic content such as resource summaries. */
  text?: string
  shortcut?: string | undefined
  reason?: BlueprintLocaleKey | null | undefined
  anchor: HTMLElement
}
/** One ephemeral bubble, measured inside the workspace; no timers or animation loops. */
export function WorkspaceTooltip({
  React,
  root,
  content,
  t,
  onClose
}: {
  React: ReactSeat
  root: React.RefObject<HTMLDivElement | null>
  content: TooltipContent
  t: BlueprintLocaleProps['t']
  onClose: () => void
}): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null),
    [position, setPosition] = React.useState({ x: 0, y: 0 })
  React.useEffect(() => {
    const element = ref.current,
      container = root.current
    if (!element || !container) return
    return installTooltipBrowserEffects(element, container, content.anchor, setPosition, onClose)
  }, [root, content, onClose])
  return tooltipView(
    React,
    { action: content.action, labelKey: content.labelKey, text: content.text, shortcut: content.shortcut, reason: content.reason },
    t,
    ref,
    position
  )
}
