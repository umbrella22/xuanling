import type React from 'react'
type ReactSeat = typeof React
import { compactChromeView } from '../ui/compact-chrome-view.tsx'
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import type { TooltipContent } from '../../../shared/controls/tooltips.ts'
export interface ChromeControl {
  action: string
  labelKey: BlueprintLocaleKey
  icon: string
  shortcut?: string | undefined
  reason?: BlueprintLocaleKey | null | undefined
  pressed?: boolean | undefined
  expanded?: boolean | undefined
  menu?: boolean | undefined
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
}
/** Disabled native controls keep a focusable explanation without allowing activation. */
export function iconControl(
  React: ReactSeat,
  t: BlueprintLocaleProps['t'],
  control: ChromeControl,
  show: (value: TooltipContent | null) => void
): React.ReactElement {
  const disabled = !!control.reason,
    id = `bp-tooltip-${control.action}`
  const reveal = (event: React.SyntheticEvent<HTMLElement>) =>
    show({ action: control.action, labelKey: control.labelKey, shortcut: control.shortcut, reason: control.reason, anchor: event.currentTarget })
  return compactChromeView(React, t, control, disabled, id, {
    onMouseEnter: reveal,
    onMouseLeave: (event: React.MouseEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(document.activeElement)) show(null)
    },
    onFocus: reveal,
    onBlur: () => show(null),
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        show(null)
      }
    },
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      show(null)
      if (!disabled) control.onClick(event)
    }
  })
}
