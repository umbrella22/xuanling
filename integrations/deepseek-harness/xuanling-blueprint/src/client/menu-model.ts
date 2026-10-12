import type { BlueprintLocaleKey } from './locales.ts'
import type { CanvasCommand, ContextCommand } from './command-policy.ts'
export interface MenuAction {
  action: string
  group: 'files' | 'view' | 'tools'
  labelKey: BlueprintLocaleKey
  icon: string
  enabled: boolean
  reason: string | null
  shortcut?: string | undefined
  pressed?: boolean | undefined
  onSelect: () => void
}
export const menuShortcut: Partial<Record<CanvasCommand, string>> = {
  copy: 'Ctrl / ⌘ C', cut: 'Ctrl / ⌘ X', paste: 'Ctrl / ⌘ V', 'paste-with-incoming': 'Ctrl / ⌘ Shift V',
  undo: 'Ctrl / ⌘ Z', redo: 'Ctrl / ⌘ Shift Z · Ctrl Y', save: 'Ctrl / ⌘ S', open: 'Ctrl / ⌘ O',
  run: 'Ctrl / ⌘ Enter', cancel: 'Ctrl / ⌘ Alt Enter', 'select-all': 'Ctrl / ⌘ A', delete: 'Delete',
  'toggle-pin': 'P', 'toggle-collapse': 'C', 'fit-view': 'F', 'fit-selection': 'Shift F', 'toggle-minimap': 'M',
  'lock-canvas': 'H', 'unlock-canvas': 'V', 'zoom-in': '+', 'zoom-out': '−',
}
export function commandIcon(command: CanvasCommand): string {
  if (command.startsWith('color-')) return 'appearance'
  if (command.startsWith('align-') || command.startsWith('distribute-')) return 'layout'
  return ({ 'toggle-pin': 'pin', 'toggle-collapse': 'collapse', 'toggle-minimap': 'minimap', open: 'import', group: 'layout', ungroup: 'layout', 'refresh-definitions': 'refresh' } as Partial<Record<CanvasCommand, string>>)[command] ?? command
}
/** Group only presentation commands; admission/dispatch remain owned by command-policy/Panel. */
export function groupContextCommands(commands: ContextCommand[]) {
  return {
    primary: commands.filter(item => !/^(color-|align-|distribute-)/.test(item.command)),
    appearance: commands.filter(item => item.command.startsWith('color-')),
    layout: commands.filter(item => /^(align-|distribute-)/.test(item.command)),
  }
}
