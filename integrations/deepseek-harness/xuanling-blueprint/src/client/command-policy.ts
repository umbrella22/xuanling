import { isEditingTarget } from './workspace.ts'

/** Intent only: the panel owns dispatch, clipboard, history and Host admission. */
export type CanvasCommand =
  | 'copy'
  | 'cut'
  | 'paste'
  | 'paste-with-incoming'
  | 'select-all'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'group'
  | 'save'
  | 'open'
  | 'fit-view'
  | 'fit-selection'
  | 'toggle-pin'
  | 'toggle-collapse'
  | 'move-left'
  | 'move-right'
  | 'move-up'
  | 'move-down'
  | 'zoom-in'
  | 'zoom-out'
  | 'toggle-minimap'
  | 'search'
  | 'run'
  | 'cancel'
  | 'pan-start'
  | 'clear-selection'
  | 'rename'
  | 'ungroup'
  | 'disconnect'
  | 'reroute'
  | 'lock-canvas'
  | 'unlock-canvas'
  | 'refresh-definitions'
  | 'align-left'
  | 'align-right'
  | 'align-top'
  | 'align-bottom'
  | 'align-center-x'
  | 'align-center-y'
  | 'distribute-x'
  | 'distribute-y'
  | 'color-default'
  | 'color-blue'
  | 'color-green'
  | 'color-amber'
  | 'color-red'
  | 'color-purple'
export type CommandLabelKey = `command.${CanvasCommand}`
export type CommandDisabledReason =
  | 'busy'
  | 'no-definition'
  | 'canvas-locked'
  | 'no-selection'
  | 'no-movable-selection'
  | 'clipboard-unavailable'
  | 'history-unavailable'
  | 'run-unavailable'
  | 'cancel-unavailable'
  | 'open-unavailable'
  | 'refresh-unavailable'

/** Facts are supplied afresh by the caller; no DOM queries or editor writes. */
export interface CommandFacts {
  canvasFocused: boolean
  hasDefinition: boolean
  busy: boolean
  canvasLocked: boolean
  selectedNodes: number
  selectedEdges: number
  selectedGroups: number
  movableNodes: number
  canUndo: boolean
  canRedo: boolean
  canPaste: boolean
  canRun: boolean
  canCancel: boolean
  canOpen: boolean
  canRefreshDefinitions: boolean
}
export interface ShortcutEvent {
  key: string
  target?: unknown
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  defaultPrevented?: boolean
}
export type ShortcutResult =
  | { kind: 'command'; command: CanvasCommand; preventDefault: true }
  | { kind: 'disabled'; command: CanvasCommand; reason: CommandDisabledReason; preventDefault: true }
  | { kind: 'ignored'; reason: 'editing-target' | 'composition' | 'outside-canvas' | 'handled' | 'unbound'; preventDefault: false }
  | { kind: 'ignored'; reason: 'repeat'; preventDefault: true }

const graphWrites = new Set<CanvasCommand>([
  'cut',
  'paste',
  'paste-with-incoming',
  'delete',
  'undo',
  'redo',
  'group',
  'toggle-pin',
  'toggle-collapse',
  'move-left',
  'move-right',
  'move-up',
  'move-down',
  'rename',
  'ungroup',
  'disconnect',
  'reroute',
  'search',
  'align-left',
  'align-right',
  'align-top',
  'align-bottom',
  'align-center-x',
  'align-center-y',
  'distribute-x',
  'distribute-y',
  'color-default',
  'color-blue',
  'color-green',
  'color-amber',
  'color-red',
  'color-purple'
])
const noRepeat = new Set<CanvasCommand>([
  ...[...graphWrites].filter(command => !command.startsWith('move-')),
  'copy',
  'save',
  'open',
  'run',
  'cancel',
  'toggle-minimap',
  'pan-start',
  'lock-canvas',
  'unlock-canvas',
  'refresh-definitions'
])
const viewCommands = new Set<CanvasCommand>([
  'fit-view',
  'fit-selection',
  'zoom-in',
  'zoom-out',
  'toggle-minimap',
  'pan-start',
  'select-all',
  'clear-selection',
  'lock-canvas',
  'unlock-canvas'
])

export function commandDisabledReason(command: CanvasCommand, facts: CommandFacts): CommandDisabledReason | null {
  if (facts.busy && !viewCommands.has(command)) return 'busy'
  if (!facts.hasDefinition && command !== 'open' && command !== 'refresh-definitions') return 'no-definition'
  if (facts.canvasLocked && (graphWrites.has(command) || command === 'open')) return 'canvas-locked'
  const selected = facts.selectedNodes + facts.selectedEdges + facts.selectedGroups > 0
  switch (command) {
    case 'copy':
    case 'cut':
    case 'delete':
    case 'fit-selection':
      return selected ? null : 'no-selection'
    case 'group':
    case 'toggle-pin':
    case 'toggle-collapse':
      return facts.selectedNodes > 0 ? null : 'no-selection'
    case 'rename':
      return facts.selectedNodes + facts.selectedGroups === 1 ? null : 'no-selection'
    case 'ungroup':
      return facts.selectedGroups > 0 ? null : 'no-selection'
    case 'disconnect':
      return facts.selectedEdges + facts.selectedNodes > 0 ? null : 'no-selection'
    case 'reroute':
      return facts.selectedEdges > 0 ? null : 'no-selection'
    case 'align-left':
    case 'align-right':
    case 'align-top':
    case 'align-bottom':
    case 'align-center-x':
    case 'align-center-y':
      return facts.selectedNodes < 2 ? 'no-selection' : facts.movableNodes === facts.selectedNodes ? null : 'no-movable-selection'
    case 'distribute-x':
    case 'distribute-y':
      return facts.selectedNodes < 3 ? 'no-selection' : facts.movableNodes === facts.selectedNodes ? null : 'no-movable-selection'
    case 'color-default':
    case 'color-blue':
    case 'color-green':
    case 'color-amber':
    case 'color-red':
    case 'color-purple':
      return facts.selectedNodes > 0 ? null : 'no-selection'
    case 'move-left':
    case 'move-right':
    case 'move-up':
    case 'move-down':
      return facts.movableNodes > 0 ? null : 'no-movable-selection'
    case 'paste':
    case 'paste-with-incoming':
      return facts.canPaste ? null : 'clipboard-unavailable'
    case 'undo':
      return facts.canUndo ? null : 'history-unavailable'
    case 'redo':
      return facts.canRedo ? null : 'history-unavailable'
    case 'run':
      return facts.canRun ? null : 'run-unavailable'
    case 'cancel':
      return facts.canCancel ? null : 'cancel-unavailable'
    case 'open':
      return facts.canOpen ? null : 'open-unavailable'
    case 'refresh-definitions':
      return facts.canRefreshDefinitions ? null : 'refresh-unavailable'
    default:
      return null
  }
}

function shortcutCommand(event: ShortcutEvent): CanvasCommand | null {
  const key = event.key.toLowerCase()
  const primary = !!(event.metaKey || event.ctrlKey)
  // Chords with both primaries, AltGr, or unsupported modifiers keep native behavior.
  if (event.metaKey && event.ctrlKey) return null
  if (primary) {
    if (key === 'enter' && !event.shiftKey) return event.altKey ? 'cancel' : 'run'
    if (event.altKey) return null
    if (event.shiftKey) {
      if (key === 'z') return 'redo'
      if (key === 'v') return 'paste-with-incoming'
      return null
    }
    const commands: Record<string, CanvasCommand> = {
      c: 'copy',
      x: 'cut',
      v: 'paste',
      a: 'select-all',
      z: 'undo',
      y: 'redo',
      g: 'group',
      s: 'save',
      o: 'open'
    }
    return Object.hasOwn(commands, key) ? commands[key]! : null
  }
  if (event.altKey) {
    if (event.shiftKey) return key === 'm' ? 'toggle-minimap' : key === '+' ? 'zoom-in' : null
    return key === 'c' ? 'toggle-collapse' : key === '+' || key === '=' ? 'zoom-in' : key === '-' ? 'zoom-out' : null
  }
  if (event.shiftKey) return key === 'f' ? 'fit-selection' : key === '+' ? 'zoom-in' : null
  const commands: Record<string, CanvasCommand> = {
    delete: 'delete',
    backspace: 'delete',
    escape: 'clear-selection',
    ' ': 'pan-start',
    tab: 'search',
    f: 'fit-view',
    '.': 'fit-view',
    p: 'toggle-pin',
    c: 'toggle-collapse',
    m: 'toggle-minimap',
    arrowleft: 'move-left',
    arrowright: 'move-right',
    arrowup: 'move-up',
    arrowdown: 'move-down',
    '+': 'zoom-in',
    '=': 'zoom-in',
    '-': 'zoom-out',
    h: 'lock-canvas',
    v: 'unlock-canvas',
    r: 'refresh-definitions'
  }
  return Object.hasOwn(commands, key) ? commands[key]! : null
}

export function resolveCanvasShortcut(event: ShortcutEvent, facts: CommandFacts): ShortcutResult {
  const ignored = (reason: 'editing-target' | 'composition' | 'outside-canvas' | 'handled' | 'unbound'): ShortcutResult => ({
    kind: 'ignored',
    reason,
    preventDefault: false
  })
  if (event.defaultPrevented) return ignored('handled')
  if (event.isComposing || event.keyCode === 229) return ignored('composition')
  if (isEditingTarget(event.target)) return ignored('editing-target')
  if (!facts.canvasFocused) return ignored('outside-canvas')
  const command = shortcutCommand(event)
  if (!command) return ignored('unbound')
  if (event.repeat && noRepeat.has(command)) return { kind: 'ignored', reason: 'repeat', preventDefault: true }
  const reason = commandDisabledReason(command, facts)
  return reason ? { kind: 'disabled', command, reason, preventDefault: true } : { kind: 'command', command, preventDefault: true }
}

export type ContextSurface = 'canvas' | 'node' | 'edge' | 'group'
export interface ContextCommand {
  command: CanvasCommand
  /** Deferred locale keys; never graph identifiers or translated captions. */
  labelKey: CommandLabelKey
  enabled: boolean
  disabledReason: CommandDisabledReason | null
}
const menuCommands: Record<ContextSurface, readonly CanvasCommand[]> = {
  canvas: [
    'search',
    'paste',
    'paste-with-incoming',
    'select-all',
    'undo',
    'redo',
    'group',
    'fit-view',
    'toggle-minimap',
    'lock-canvas',
    'unlock-canvas',
    'save',
    'open',
    'refresh-definitions',
    'run',
    'cancel'
  ],
  node: [
    'copy',
    'cut',
    'delete',
    'rename',
    'toggle-pin',
    'toggle-collapse',
    'group',
    'fit-selection',
    'disconnect',
    'color-default',
    'color-blue',
    'color-green',
    'color-amber',
    'color-red',
    'color-purple',
    'align-left',
    'align-right',
    'align-top',
    'align-bottom',
    'align-center-x',
    'align-center-y',
    'distribute-x',
    'distribute-y'
  ],
  edge: ['delete', 'disconnect', 'reroute'],
  group: ['copy', 'cut', 'delete', 'rename', 'ungroup', 'fit-selection']
}
/** Selection facts must describe the menu's target/selection, not a stale selection. */
export function contextCommands(surface: ContextSurface, facts: CommandFacts): ContextCommand[] {
  return menuCommands[surface].map(command => {
    const disabledReason = commandDisabledReason(command, facts)
    return { command, labelKey: `command.${command}`, enabled: disabledReason === null, disabledReason }
  })
}
