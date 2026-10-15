import type React from 'react'
type ReactSeat = typeof React
import { blueprintIcon } from './icons.ts'
import type { BlueprintLocaleKey, BlueprintLocaleProps } from './locales.ts'
import type { TooltipContent } from './tooltips.ts'
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
  const h = React.createElement,
    disabled = !!control.reason,
    id = `bp-tooltip-${control.action}`
  const reveal = (event: React.SyntheticEvent<HTMLElement>) =>
    show({ action: control.action, labelKey: control.labelKey, shortcut: control.shortcut, reason: control.reason, anchor: event.currentTarget })
  return h(
    'span',
    {
      className: 'bp-icon-anchor',
      key: control.action,
      tabIndex: disabled ? 0 : undefined,
      role: disabled ? 'group' : undefined,
      'aria-label': disabled ? `${t(control.labelKey)} · ${control.reason ? t(control.reason) : ''}` : undefined,
      'aria-describedby': id,
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
      }
    },
    h(
      'button',
      {
        type: 'button',
        className: `bp-icon-button${control.action === 'start-run' ? ' bp-run-button' : ''}`,
        'data-bp-action': control.action,
        'aria-label': t(control.labelKey),
        'aria-describedby': id,
        'aria-pressed': control.pressed,
        'aria-disabled': disabled,
        disabled,
        'aria-haspopup': control.menu ? 'menu' : undefined,
        'aria-expanded': control.expanded,
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          show(null)
          if (!disabled) control.onClick(event)
        }
      },
      blueprintIcon(React, control.icon)
    )
  )
}
