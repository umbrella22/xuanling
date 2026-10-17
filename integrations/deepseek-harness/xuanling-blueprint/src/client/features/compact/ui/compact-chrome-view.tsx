/** @jsxRuntime classic */
/** @jsx React.createElement */
import type React from 'react'
type ReactSeat = typeof React
import { blueprintIcon } from '../../../shared/icons/icons.ts'
import type { ChromeControl } from '../logic/compact-chrome.ts'
import type { BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
type Handlers = Pick<React.HTMLAttributes<HTMLSpanElement>, 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur' | 'onKeyDown'> & {
  onClick: React.MouseEventHandler<HTMLButtonElement>
}
/** Pure compact chrome markup; interaction decisions remain with its adapter. */
export function compactChromeView(
  React: ReactSeat,
  t: BlueprintLocaleProps['t'],
  control: ChromeControl,
  disabled: boolean,
  id: string,
  handlers: Handlers
): React.ReactElement {
  return (
    <span
      className="bp-icon-anchor"
      key={control.action}
      tabIndex={disabled ? 0 : undefined}
      role={disabled ? 'group' : undefined}
      aria-label={disabled ? `${t(control.labelKey)} · ${control.reason ? t(control.reason) : ''}` : undefined}
      aria-describedby={id}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
      onFocus={handlers.onFocus}
      onBlur={handlers.onBlur}
      onKeyDown={handlers.onKeyDown}
    >
      <button
        type="button"
        className={`bp-icon-button${control.action === 'start-run' ? ' bp-run-button' : ''}`}
        data-bp-action={control.action}
        aria-label={t(control.labelKey)}
        aria-describedby={id}
        aria-pressed={control.pressed}
        aria-disabled={disabled}
        disabled={disabled}
        aria-haspopup={control.menu ? 'menu' : undefined}
        aria-expanded={control.expanded}
        onClick={handlers.onClick}
      >
        {blueprintIcon(React, control.icon)}
      </button>
    </span>
  )
}
