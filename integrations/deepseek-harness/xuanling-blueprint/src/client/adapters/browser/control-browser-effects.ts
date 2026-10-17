/** Browser-only control effects. Every observer/listener has an owner cleanup. */
import type React from 'react'
import type { SelectSessionIntent } from '../../shared/controls/control-session.ts'
export const selectIsDisabled = (trigger: HTMLButtonElement | null): boolean => trigger?.matches(':disabled') ?? false
export const focusSelectTrigger = (trigger: HTMLButtonElement | null): void => {
  trigger?.focus()
}
export const focusLeavesControl = (root: HTMLDivElement | null, target: EventTarget | null): boolean => !root?.contains(target as Node)
export function selectKeyIntent(event: React.KeyboardEvent<HTMLButtonElement>): SelectSessionIntent {
  return {
    type: 'key',
    key: event.key,
    now: Date.now(),
    composing: event.nativeEvent.isComposing || event.keyCode === 229,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey
  }
}
export function scrollActiveOption(list: HTMLDivElement | null, index: number): void {
  list?.querySelector<HTMLElement>(`[data-bp-option-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
}
export function observeSelectPopover(
  root: HTMLDivElement | null,
  trigger: HTMLButtonElement | null,
  element: HTMLDivElement | null,
  close: () => void
): () => void {
  if (!element) return () => {}
  element.showPopover?.()
  const place = () => {
    const anchor = trigger?.getBoundingClientRect()
    if (!anchor) return
    const width = Math.min(Math.max(anchor.width, 220), window.innerWidth - 16)
    const below = window.innerHeight - anchor.bottom - 12,
      above = anchor.top - 12
    const up = below < Math.min(280, element.scrollHeight) && above > below
    Object.assign(element.style, {
      width: `${width}px`,
      left: `${Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))}px`,
      top: up ? 'auto' : `${anchor.bottom + 4}px`,
      bottom: up ? `${window.innerHeight - anchor.top + 4}px` : 'auto',
      maxHeight: `${Math.max(40, Math.min(320, up ? above : below))}px`
    })
  }
  place()
  const outside = (event: PointerEvent) => {
    if (!root?.contains(event.target as Node)) close()
  }
  const disabledObserver = new MutationObserver(() => {
    if (selectIsDisabled(trigger)) close()
  })
  for (let ancestor: HTMLElement | null = trigger?.parentElement ?? null; ancestor; ancestor = ancestor.parentElement)
    if (ancestor.tagName === 'FIELDSET') disabledObserver.observe(ancestor, { attributes: true, attributeFilter: ['disabled'] })
  const observer = new ResizeObserver(place)
  if (trigger) observer.observe(trigger)
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('resize', place)
  window.addEventListener('scroll', place, true)
  return () => {
    element.hidePopover?.()
    observer.disconnect()
    disabledObserver.disconnect()
    document.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('resize', place)
    window.removeEventListener('scroll', place, true)
  }
}
export function captureConfirmationFocus(element: HTMLDivElement | null): () => void {
  const previous = document.activeElement as HTMLElement | null
  element?.querySelector<HTMLButtonElement>('[data-bp-confirm-cancel]')?.focus()
  return () => {
    if (previous?.isConnected) previous.focus()
  }
}
export function handleConfirmationKey(event: React.KeyboardEvent, element: HTMLDivElement | null, cancel: () => void): void {
  event.stopPropagation()
  if (event.nativeEvent.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  }
  if (event.key === 'Tab') {
    const controls = Array.from(element?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    const first = controls[0],
      last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }
}
export function controlId(kind: 'select' | 'confirm'): string {
  return `bp-${kind}-${crypto.randomUUID()}`
}
