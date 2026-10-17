import type React from 'react'
import type { XY } from '../../../definition/types.ts'
import { clampOverlay } from '../../features/authoring/logic/overlays/overlay-session.ts'
export function observeOverlay(
  element: HTMLDivElement | null,
  root: HTMLDivElement | null,
  overlay: { kind: string; screen: XY },
  setPosition: (position: XY) => void,
  onClose: () => void
): () => void {
  const isMenu = overlay.kind === 'context-menu' || overlay.kind === 'more-menu'
  if (!element) return () => {}
  const place = () => {
    const container = root?.getBoundingClientRect(),
      size = element.getBoundingClientRect()
    if (container) setPosition(clampOverlay(overlay.screen, size, container))
  }
  place()
  const focusSelector = isMenu
    ? '[role=menuitem]:not(:disabled)'
    : overlay.kind === 'node-search'
      ? '[data-bp-search-input]'
      : overlay.kind === 'rename'
        ? '[data-bp-rename-field]'
        : overlay.kind === 'import'
          ? '[data-bp-import-target]'
          : 'button:not(:disabled)'
  element.querySelector<HTMLElement>(focusSelector)?.focus()
  const outside = (e: PointerEvent) => {
    if (!element.contains(e.target as globalThis.Node)) onClose()
  }
  const resize = new ResizeObserver(place)
  resize.observe(element)
  if (root) resize.observe(root)
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('resize', place)
  return () => {
    resize.disconnect()
    document.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('resize', place)
  }
}
export function focusSubmenu(element: HTMLDivElement | null, submenu: string): void {
  element?.querySelector<HTMLElement>(`[data-bp-submenu="${submenu}"] [role=menuitem]:not(:disabled)`)?.focus()
}
export function returnOverlayParent(element: HTMLDivElement | null, parent: string | null): void {
  element?.querySelector<HTMLElement>(`[data-bp-menu-group="${parent}"]`)?.focus()
}
export function menuKeyboard(
  event: React.KeyboardEvent<HTMLDivElement>,
  element: HTMLDivElement | null,
  submenu: string | null,
  open: (group: string) => void,
  back: () => void,
  close: () => void
): void {
  const target = document.activeElement as HTMLElement | null
  const level = target?.closest?.('[data-bp-submenu]')?.getAttribute('data-bp-submenu') ?? 'root'
  const items = [...(element?.querySelectorAll<HTMLButtonElement>(`[role=menuitem][data-bp-menu-level="${level}"]:not(:disabled)`) ?? [])]
  const current = items.indexOf(target as HTMLButtonElement)
  const group = target?.getAttribute?.('data-bp-menu-group')
  if (event.key === 'ArrowRight' || (event.key === 'Enter' && group)) {
    event.preventDefault()
    if (group) {
      open(group)
    }
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (submenu) back()
    return
  }
  let next: number | undefined
  if (event.key === 'ArrowDown') next = (current + 1) % items.length
  if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length
  if (event.key === 'Home') next = 0
  if (event.key === 'End') next = items.length - 1
  if (next !== undefined) {
    event.preventDefault()
    items[next]?.focus()
  }
  if (event.key === 'Tab') close()
}
/** Binary wire conversion uses browser primitives, with no Node/ZIP codec closure. */
export function archiveBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
export function archiveBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
export function downloadBlueprint(bytes: Uint8Array | string, filename: string, mime: string): void {
  const blob = new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type: mime })
  const url = URL.createObjectURL(blob),
    anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

/** Native File ownership stops at this browser adapter; only encoded archive data leaves it. */
export function pickedOverlayFile(event: React.ChangeEvent<HTMLInputElement>): File | null {
  return event.currentTarget.files?.[0] ?? null
}
export async function readOverlayArchive(file: File): Promise<string> {
  return archiveBase64(new Uint8Array(await file.arrayBuffer()))
}
