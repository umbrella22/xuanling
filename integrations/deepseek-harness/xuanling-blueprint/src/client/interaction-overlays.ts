import type React from 'react'
import type { CanvasPort } from './graph-editor.ts'
import type { XY } from '../definition/types.ts'
import type { BlueprintLocaleProps } from './locales.ts'
import type { CanvasCommand, CommandDisabledReason, ContextCommand, ContextSurface } from './command-policy.ts'
import { compatibleSearchNodes } from './flow-interactions.ts'
import type { BuiltinNodeKind } from './node-catalog.ts'
import { blueprintIcon } from './icons.ts'
import { groupContextCommands, commandIcon, menuShortcut } from './menu-model.ts'
import type { MenuAction } from './menu-model.ts'

export type CanvasOverlay =
  | { kind: 'context-menu'; surface: ContextSurface; targetId?: string; screen: XY; position: XY }
  | { kind: 'node-search'; screen: XY; position: XY; origin?: CanvasPort }
  | { kind: 'rename'; screen: XY; targetId: string; group: boolean; value: string }
  | { kind: 'shortcuts'; screen: XY }
  | { kind: 'import'; screen: XY }
  | { kind: 'more-menu'; screen: XY }
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
interface OverlayProps {
  React: typeof React
  overlay: CanvasOverlay
  root: React.RefObject<HTMLDivElement | null>
  t: BlueprintLocaleProps['t']
  commands: ContextCommand[]
  moreActions?: MenuAction[]
  presentationState?: { allPinned: boolean; allCollapsed: boolean }
  onCommand: (command: CanvasCommand) => void
  onAdd: (kind: BuiltinNodeKind) => void
  onRename: (value: string) => void
  onClose: () => void
  importDisabledReason?: CommandDisabledReason | null
  importTargets: Array<{ blueprintId: string; name: string; nonempty: boolean }>
  onImportFile: (id: string, file: File) => void
}
/** Inject the panel's existing React seat; do not remount workspace/Inspector. */
export function InteractionOverlay(props: OverlayProps): React.ReactElement {
  const { React, overlay, root, t, onClose } = props,
    h = React.createElement
  const ref = React.useRef<HTMLDivElement>(null)
  const [position, setPosition] = React.useState(overlay.screen)
  const [query, setQuery] = React.useState('')
  const [active, setActive] = React.useState(0)
  const [name, setName] = React.useState(overlay.kind === 'rename' ? overlay.value : '')
  const [targetId, setTargetId] = React.useState(props.importTargets.find(t => !t.nonempty)?.blueprintId ?? '')
  const [confirmed, setConfirmed] = React.useState(false)
  const [file, setFile] = React.useState<File | null>(null)
  const [submenu, setSubmenu] = React.useState<string | null>(null)
  const submenuFocus = React.useRef(false)
  const isMenu = overlay.kind === 'context-menu' || overlay.kind === 'more-menu'
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const place = () => {
      const container = root.current?.getBoundingClientRect(),
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
    if (root.current) resize.observe(root.current)
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', place)
    return () => {
      resize.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', place)
    }
  }, [overlay, root, onClose])
  React.useEffect(() => {
    if (submenu && submenuFocus.current) {
      ref.current?.querySelector<HTMLElement>(`[data-bp-submenu="${submenu}"] [role=menuitem]:not(:disabled)`)?.focus()
      submenuFocus.current = false
    }
  }, [submenu])
  const returnToParent = () => {
    const parent = submenu
    submenuFocus.current = false
    setSubmenu(null)
    ref.current?.querySelector<HTMLElement>(`[data-bp-menu-group="${parent}"]`)?.focus()
  }
  const candidates = overlay.kind === 'node-search' ? compatibleSearchNodes(query, overlay.origin, t) : []
  const index = Math.min(active, Math.max(0, candidates.length - 1))
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (isMenu && submenu) returnToParent()
      else onClose()
      return
    }
    if (isMenu) {
      const target = document.activeElement as HTMLElement | null
      const level = target?.closest?.('[data-bp-submenu]')?.getAttribute('data-bp-submenu') ?? 'root'
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>(`[role=menuitem][data-bp-menu-level="${level}"]:not(:disabled)`) ?? [])]
      const current = items.indexOf(target as HTMLButtonElement)
      const group = target?.getAttribute?.('data-bp-menu-group')
      if (event.key === 'ArrowRight' || (event.key === 'Enter' && group)) {
        event.preventDefault()
        if (group) {
          submenuFocus.current = true
          setSubmenu(group)
        }
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (submenu) returnToParent()
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
      if (event.key === 'Tab') onClose()
    } else if (overlay.kind === 'node-search') {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        setActive(
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? candidates.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + candidates.length) % Math.max(1, candidates.length)
        )
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const candidate = candidates[index]
        if (candidate) props.onAdd(candidate.kind)
      }
    }
  }
  const grouped = groupContextCommands(props.commands)
  const renderCommand = (item: ContextCommand, level = 'root') => {
    const label =
      item.command === 'toggle-pin'
        ? t(props.presentationState?.allPinned ? 'compact.unpin' : 'compact.pin')
        : item.command === 'toggle-collapse'
          ? t(props.presentationState?.allCollapsed ? 'compact.expand' : 'compact.collapse')
          : t(item.labelKey)
    const shortcut = menuShortcut[item.command]
    return h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        key: item.command,
        className: 'bp-menu-item',
        'data-bp-menu-level': level,
        'data-bp-menu-command': item.command,
        'data-bp-action': item.command === 'group' ? 'group-selection' : item.command === 'delete' ? 'delete-selection' : undefined,
        disabled: !item.enabled,
        'aria-disabled': !item.enabled,
        'aria-label': label,
        onClick: () => {
          if (item.enabled) props.onCommand(item.command)
        }
      },
      blueprintIcon(React, commandIcon(item.command)),
      h(
        'span',
        { className: 'bp-menu-label' },
        label,
        item.disabledReason && h('small', { 'data-bp-disabled-reason': item.command }, t(`interaction.disabled.${item.disabledReason}`))
      ),
      shortcut && h('kbd', null, shortcut)
    )
  }
  const renderAction = (item: MenuAction) =>
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        key: item.action,
        className: 'bp-menu-item',
        'data-bp-menu-level': item.group,
        'data-bp-action': item.action,
        disabled: !item.enabled,
        'aria-disabled': !item.enabled,
        'aria-pressed': item.pressed,
        'aria-label': t(item.labelKey),
        onClick: () => {
          if (item.enabled) item.onSelect()
        }
      },
      blueprintIcon(React, item.icon),
      h('span', { className: 'bp-menu-label' }, t(item.labelKey), item.reason && h('small', { 'data-bp-disabled-reason': item.action }, item.reason)),
      item.shortcut && h('kbd', null, item.shortcut)
    )
  const renderGroup = (group: 'files' | 'view' | 'tools' | 'appearance' | 'layout', children: React.ReactElement[]) =>
    h(
      'div',
      { key: group, className: 'bp-menu-group' },
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          className: 'bp-menu-item',
          'data-bp-menu-level': 'root',
          'data-bp-menu-group': group,
          'aria-haspopup': 'menu',
          'aria-expanded': submenu === group,
          'aria-controls': `bp-submenu-${group}`,
          onClick: () => {
            submenuFocus.current = true
            setSubmenu(group)
          }
        },
        blueprintIcon(React, group),
        h('span', { className: 'bp-menu-label' }, t(`compact.${group}`)),
        blueprintIcon(React, 'chevron')
      ),
      submenu === group &&
        h(
          'div',
          { role: 'menu', className: 'bp-submenu', id: `bp-submenu-${group}`, 'aria-label': t(`compact.${group}`), 'data-bp-submenu': group },
          ...children
        )
    )
  const dialog = !isMenu
  return h(
    'div',
    {
      ref,
      className: `bp-interaction-overlay bp-${overlay.kind} nodrag nopan nowheel`,
      style: { left: position.x, top: position.y },
      'data-bp-overlay': overlay.kind,
      role: dialog ? 'dialog' : 'menu',
      'aria-label': t(`interaction.${overlay.kind}`),
      onKeyDown: keyDown,
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    dialog &&
      h(
        'header',
        null,
        h('strong', null, t(`interaction.${overlay.kind}`)),
        h('button', { type: 'button', onClick: onClose, 'aria-label': t('interaction.close') }, '×')
      ),
    overlay.kind === 'context-menu' &&
      h(
        React.Fragment,
        null,
        ...grouped.primary.map(item => renderCommand(item)),
        grouped.appearance.length > 0 &&
          renderGroup(
            'appearance',
            grouped.appearance.map(item => renderCommand(item, 'appearance'))
          ),
        grouped.layout.length > 0 &&
          renderGroup(
            'layout',
            grouped.layout.map(item => renderCommand(item, 'layout'))
          )
      ),
    overlay.kind === 'more-menu' &&
      (['files', 'view', 'tools'] as const).map(group => renderGroup(group, (props.moreActions ?? []).filter(item => item.group === group).map(renderAction))),
    overlay.kind === 'node-search' &&
      h(
        React.Fragment,
        null,
        h('input', {
          'data-bp-search-input': true,
          value: query,
          placeholder: t('palette.placeholder'),
          role: 'combobox',
          'aria-label': t('palette.search'),
          'aria-autocomplete': 'list',
          'aria-controls': 'bp-search-results',
          'aria-expanded': true,
          'aria-activedescendant': candidates[index] ? `bp-search-${candidates[index]!.kind}` : undefined,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            setQuery(e.currentTarget.value)
            setActive(0)
          }
        }),
        h(
          'div',
          { role: 'listbox', id: 'bp-search-results' },
          ...candidates.map((item, i) =>
            h(
              'button',
              {
                type: 'button',
                role: 'option',
                key: item.kind,
                id: `bp-search-${item.kind}`,
                'data-bp-search-kind': item.kind,
                'aria-selected': i === index,
                onClick: () => props.onAdd(item.kind),
                onMouseEnter: () => setActive(i)
              },
              t(item.titleKey)
            )
          )
        ),
        !candidates.length && h('p', null, t('palette.noMatches'))
      ),
    overlay.kind === 'rename' &&
      h(
        'form',
        {
          onSubmit: (e: React.FormEvent) => {
            e.preventDefault()
            props.onRename(name)
          }
        },
        h('input', {
          'data-bp-rename-field': true,
          value: name,
          'aria-label': t('command.rename'),
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setName(e.currentTarget.value)
        }),
        h('button', { type: 'submit', 'data-bp-action': 'rename-apply' }, t('interaction.apply'))
      ),
    overlay.kind === 'shortcuts' &&
      h(
        'dl',
        null,
        ...shortcutHelp.map(([chord, key]) => h('div', { key }, h('dt', null, h('kbd', null, chord)), h('dd', null, t(`interaction.help.${key}`))))
      ),
    overlay.kind === 'import' &&
      h(
        'form',
        {
          onSubmit: (e: React.FormEvent) => {
            e.preventDefault()
            if (!props.importDisabledReason && confirmed && file && props.importTargets.some(t => t.blueprintId === targetId && !t.nonempty))
              props.onImportFile(targetId, file)
          }
        },
        h('p', null, t('interaction.importHelp')),
        props.importDisabledReason && h('p', { role: 'status' }, t(`interaction.disabled.${props.importDisabledReason}`)),
        h(
          'select',
          {
            'data-bp-import-target': true,
            value: targetId,
            'aria-label': t('library.configuredBlueprint'),
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
              setTargetId(e.currentTarget.value)
              setConfirmed(false)
            }
          },
          h('option', { value: '', disabled: true }, t('library.chooseId')),
          ...props.importTargets.map(item =>
            h(
              'option',
              { key: item.blueprintId, value: item.blueprintId, disabled: item.nonempty },
              `${item.name} · ${item.blueprintId}${item.nonempty ? ` · ${t('interaction.nonempty')}` : ''}`
            )
          )
        ),
        h('input', {
          type: 'file',
          accept: '.zip,application/zip',
          'data-bp-import-file': true,
          'aria-label': t('interaction.chooseFile'),
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            setFile(e.currentTarget.files?.[0] ?? null)
            setConfirmed(false)
          }
        }),
        h(
          'label',
          { className: 'bp-checkbox' },
          h('input', {
            type: 'checkbox',
            checked: confirmed,
            'data-bp-import-confirm': true,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => setConfirmed(e.currentTarget.checked)
          }),
          t('interaction.confirmId', { id: targetId })
        ),
        h(
          'button',
          { type: 'submit', 'data-bp-action': 'import-apply', disabled: !!props.importDisabledReason || !confirmed || !file || !targetId },
          t('interaction.apply')
        )
      )
  )
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
