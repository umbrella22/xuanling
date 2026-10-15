import type React from 'react'
type ReactSeat = typeof React
import type { BlueprintLocaleKey, BlueprintLocaleProps } from './locales.ts'
import { clampOverlay } from './interaction-overlays.ts'
export interface TooltipContent {
  action: string
  labelKey: BlueprintLocaleKey
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
    const place = () => {
      const bounds = container.getBoundingClientRect(),
        anchor = content.anchor.getBoundingClientRect(),
        size = element.getBoundingClientRect()
      const below = anchor.bottom - bounds.top + 6
      setPosition(
        clampOverlay(
          { x: anchor.left - bounds.left, y: below + size.height <= bounds.height ? below : anchor.top - bounds.top - size.height - 6 },
          size,
          bounds
        )
      )
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    observer.observe(container)
    const dismiss = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') onClose()
    }
    document.addEventListener('keydown', dismiss)
    document.addEventListener('pointerdown', onClose, true)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      document.removeEventListener('keydown', dismiss)
      document.removeEventListener('pointerdown', onClose, true)
      window.removeEventListener('resize', place)
    }
  }, [root, content, onClose])
  return React.createElement(
    'div',
    {
      ref,
      role: 'tooltip',
      className: 'bp-tooltip',
      id: `bp-tooltip-${content.action}`,
      'data-bp-tooltip': content.action,
      style: { left: position.x, top: position.y }
    },
    React.createElement('span', null, t(content.labelKey)),
    content.shortcut && React.createElement('kbd', null, content.shortcut),
    content.reason && React.createElement('small', null, t(content.reason))
  )
}
