import React from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { StyledSelect, ConfirmationDialog } from '../../src/client/shared/controls/styled-controls.ts'
import { InteractionOverlay } from '../../src/client/features/authoring/ui/overlays/interaction-overlays.tsx'
import type { CanvasOverlay } from '../../src/client/features/authoring/ui/overlays/interaction-overlays.tsx'
import { en } from '../../src/client/shared/i18n/locales.ts'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'

const h = React.createElement
const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
function observeListeners(target: EventTarget, types: string[]) {
  const add = target.addEventListener.bind(target),
    remove = target.removeEventListener.bind(target)
  target.addEventListener = (type, callback, options) => {
    if (callback && types.includes(type)) {
      const callbacks = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>()
      callbacks.add(callback)
      listeners.set(type, callbacks)
    }
    add(type, callback, options)
  }
  target.removeEventListener = (type, callback, options) => {
    if (callback && types.includes(type)) {
      listeners.get(type)?.delete(callback)
      if (!listeners.get(type)?.size) listeners.delete(type)
    }
    remove(type, callback, options)
  }
}
observeListeners(document, ['pointerdown'])
observeListeners(window, ['resize', 'scroll'])
const resizing = new Set<ResizeObserver>(),
  mutating = new Set<MutationObserver>()
const NativeResizeObserver = window.ResizeObserver,
  NativeMutationObserver = window.MutationObserver
window.ResizeObserver = class extends NativeResizeObserver {
  override observe(target: Element, options?: ResizeObserverOptions) {
    resizing.add(this)
    super.observe(target, options)
  }
  override disconnect() {
    resizing.delete(this)
    super.disconnect()
  }
}
window.MutationObserver = class extends NativeMutationObserver {
  override observe(target: Node, options?: MutationObserverInit) {
    // Count the control's disabled-fieldset observers, excluding Playwright's
    // document observers used to wait for rendered elements.
    if (target instanceof HTMLFieldSetElement) mutating.add(this)
    super.observe(target, options)
  }
  override disconnect() {
    mutating.delete(this)
    super.disconnect()
  }
}
let accepted = 0,
  cancelled = 0,
  changes = 0,
  root: Root | undefined
function Fixture() {
  const [confirmation, setConfirmation] = React.useState(false)
  return h(
    'section',
    { className: 'bp-workspace', style: { padding: 20 } },
    h(
      'fieldset',
      null,
      h(
        StyledSelect,
        { value: 'a', 'aria-label': 'Lifecycle select', onChange: () => changes++ },
        h('option', { value: 'a' }, 'Alpha'),
        h('option', { value: 'b' }, 'Beta')
      )
    ),
    h('button', { id: 'open-confirmation', onClick: () => setConfirmation(true) }, 'Open confirmation'),
    confirmation &&
      h(ConfirmationDialog, {
        React,
        title: 'Lifecycle confirmation',
        description: 'Fixture',
        cancelLabel: 'Cancel',
        confirmLabel: 'Confirm',
        onConfirm: () => {
          accepted++
          setConfirmation(false)
        },
        onCancel: () => {
          cancelled++
          setConfirmation(false)
        }
      })
  )
}
const overlayActions = { closed: 0, commands: [] as string[], added: [] as string[], names: [] as string[], imports: [] as string[] }
function OverlayFixture({ kind }: { kind: CanvasOverlay['kind'] }) {
  const container = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = React.useState(true)
  const overlay = React.useMemo<CanvasOverlay>(() => {
    const screen = { x: 20, y: 20 }
    if (kind === 'context-menu') return { kind, screen, surface: 'node', position: screen }
    if (kind === 'node-search') return { kind, screen, position: screen }
    if (kind === 'rename') return { kind, screen, targetId: 'n', group: false, value: 'initial' }
    return { kind, screen }
  }, [kind])
  return h(
    'div',
    { ref: container, className: 'bp-workspace', style: { position: 'relative', width: 800, height: 600 } },
    open &&
      h(InteractionOverlay, {
        React,
        root: container,
        overlay,
        t: (key, params = {}) => en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`)),
        commands: [
          { command: 'copy', labelKey: 'command.copy', enabled: true, disabledReason: null },
          { command: 'color-blue', labelKey: 'command.color-blue', enabled: true, disabledReason: null },
          { command: 'align-left', labelKey: 'command.align-left', enabled: true, disabledReason: null }
        ],
        moreActions: [
          {
            action: 'fixture-copy',
            group: 'files',
            labelKey: 'command.copy',
            icon: 'copy',
            enabled: true,
            reason: null,
            onSelect: () => overlayActions.commands.push('more-copy')
          }
        ],
        importTargets: [
          { blueprintId: 'used', name: 'Used', nonempty: true },
          { blueprintId: 'empty', name: 'Empty', nonempty: false }
        ],
        onCommand: command => overlayActions.commands.push(command),
        onAdd: kind => overlayActions.added.push(kind),
        onRename: name => overlayActions.names.push(name),
        onImportFile: (id, file) => overlayActions.imports.push(`${id}:${file.name}`),
        onClose: () => {
          overlayActions.closed++
          setOpen(false)
        }
      })
  )
}
installCanvasStyles()
Object.assign(window, {
  controlLifecycle: {
    mount(overlayKind?: CanvasOverlay['kind']) {
      root = createRoot(document.getElementById('mount')!)
      flushSync(() => root!.render(overlayKind ? h(OverlayFixture, { kind: overlayKind }) : h(Fixture)))
    },
    unmount() {
      flushSync(() => root?.unmount())
      root = undefined
    },
    resources() {
      return { listeners: [...listeners].flatMap(([type, callbacks]) => [...callbacks].map(() => type)).sort(), resize: resizing.size, mutation: mutating.size }
    },
    actions() {
      return { accepted, cancelled, changes }
    },
    overlayActions() {
      return structuredClone(overlayActions)
    }
  }
})
