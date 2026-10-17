import type { XY } from '../../../../../definition/types.ts'
export function clampOverlay(position: XY, size: { width: number; height: number }, bounds: { width: number; height: number }): XY {
  return { x: Math.max(0, Math.min(position.x, bounds.width - size.width)), y: Math.max(0, Math.min(position.y, bounds.height - size.height)) }
}
export const shortcutHelp = [
  ['Ctrl / ⌘ C, X, V', 'clipboard'],
  ['Ctrl / ⌘ Shift V', 'incoming'],
  ['Alt + drag', 'clone'],
  ['Ctrl / ⌘ A · Delete', 'selection'],
  ['Arrow keys', 'move'],
  ['Ctrl / ⌘ Z · Shift Z · Y', 'history'],
  ['Tab · double click', 'search'],
  ['Space · middle drag', 'pan'],
  ['Wheel ↕ · wheel ↔ · Ctrl / pinch', 'wheel'],
  ['F · . · Shift F', 'fit'],
  ['P · C · Alt C', 'presentation'],
  ['H · V', 'lock'],
  ['M · Alt Shift M', 'minimap'],
  ['+ / − · Alt + / −', 'zoom'],
  ['Ctrl / ⌘ S · O', 'files'],
  ['Ctrl / ⌘ Enter · Ctrl / ⌘ Alt Enter', 'run']
] as const

export interface OverlaySessionState {
  readonly query: string
  readonly active: number
  readonly name: string
  readonly targetId: string
  readonly confirmed: boolean
  readonly submenu: string | null
}
export type OverlaySessionIntent =
  | { type: 'query'; query: string }
  | { type: 'active'; active: number }
  | { type: 'rename-buffer'; name: string }
  | { type: 'target'; targetId: string }
  | { type: 'confirm-import'; confirmed: boolean }
  | { type: 'file-changed' }
  | { type: 'submenu'; submenu: string | null }
export function initialOverlaySession(kind: string, name: string, targetId: string): OverlaySessionState {
  return { query: '', active: 0, name: kind === 'rename' ? name : '', targetId, confirmed: false, submenu: null }
}
export function transitionOverlay(state: OverlaySessionState, intent: OverlaySessionIntent): OverlaySessionState {
  switch (intent.type) {
    case 'query':
      return { ...state, query: intent.query, active: 0 }
    case 'active':
      return { ...state, active: intent.active }
    case 'rename-buffer':
      return { ...state, name: intent.name }
    case 'target':
      return { ...state, targetId: intent.targetId, confirmed: false }
    case 'confirm-import':
      return { ...state, confirmed: intent.confirmed }
    case 'file-changed':
      return { ...state, confirmed: false }
    case 'submenu':
      return { ...state, submenu: intent.submenu }
  }
}
export function searchActiveIndex(active: number, count: number): number {
  return Math.min(active, Math.max(0, count - 1))
}
export function searchKeyIndex(key: string, index: number, count: number): number | undefined {
  return key === 'Home'
    ? 0
    : key === 'End'
      ? count - 1
      : key === 'ArrowDown' || key === 'ArrowUp'
        ? (index + (key === 'ArrowDown' ? 1 : -1) + count) % Math.max(1, count)
        : undefined
}
export function importEligible(
  disabled: boolean,
  confirmed: boolean,
  hasFile: boolean,
  targetId: string,
  targets: readonly { blueprintId: string; nonempty: boolean }[]
): boolean {
  return !disabled && confirmed && hasFile && targets.some(target => target.blueprintId === targetId && !target.nonempty)
}
