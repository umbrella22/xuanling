/** @jsxRuntime classic */
/** @jsx React.createElement */
import type React from 'react'
type ReactSeat = typeof React
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../i18n/locales.ts'
export interface TooltipViewContent {
  action: string
  labelKey: BlueprintLocaleKey
  text?: string | undefined
  shortcut?: string | undefined
  reason?: BlueprintLocaleKey | null | undefined
}
/** Pure markup rendered with the caller's injected host React seat. */
export function tooltipView(
  React: ReactSeat,
  content: TooltipViewContent,
  t: BlueprintLocaleProps['t'],
  ref: React.RefObject<HTMLDivElement | null>,
  position: { x: number; y: number }
): React.ReactElement {
  return (
    <div
      ref={ref}
      role="tooltip"
      className="bp-tooltip"
      id={`bp-tooltip-${content.action}`}
      data-bp-tooltip={content.action}
      style={{ left: position.x, top: position.y }}
    >
      <span>{content.text ?? t(content.labelKey)}</span>
      {content.shortcut && <kbd>{content.shortcut}</kbd>}
      {content.reason && <small>{t(content.reason)}</small>}
    </div>
  )
}
