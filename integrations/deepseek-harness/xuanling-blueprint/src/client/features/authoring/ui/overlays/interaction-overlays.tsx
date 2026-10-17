import { acceptsOverlayIntent, sameWorkspaceViewBinding } from '../../../../shared/contracts/view-contract.ts'
import type { OverlayViewState, OverlayIntent } from '../../../../shared/contracts/view-contract.ts'
import type React from 'react'
import type { CanvasPort } from '../../logic/graph/graph-editor.ts'
import type { XY } from '../../../../../definition/types.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import type { CanvasCommand, CommandDisabledReason, ContextCommand, ContextSurface } from '../../../../shared/controls/command-policy.ts'
import { compatibleSearchNodes } from '../../logic/graph/flow-interactions.ts'
import type { BuiltinNodeKind } from '../../logic/graph/node-catalog.ts'
import type { MenuAction } from '../../presenters/menu-model.ts'

export type CanvasOverlay =
  | { kind: 'context-menu'; surface: ContextSurface; targetId?: string; screen: XY; position: XY }
  | { kind: 'node-search'; screen: XY; position: XY; origin?: CanvasPort }
  | { kind: 'rename'; screen: XY; targetId: string; group: boolean; value: string }
  | { kind: 'shortcuts'; screen: XY }
  | { kind: 'import'; screen: XY }
  | { kind: 'more-menu'; screen: XY }
import { initialOverlaySession, transitionOverlay, searchActiveIndex, searchKeyIndex, importEligible } from '../../logic/overlays/overlay-session.ts'
import {
  observeOverlay,
  focusSubmenu,
  returnOverlayParent,
  menuKeyboard,
  pickedOverlayFile,
  readOverlayArchive
} from '../../../../adapters/browser/overlay-browser-effects.ts'
import { interactionOverlaysView } from './interaction-overlays-view.tsx'
import type { OverlayMarkupIntent } from './interaction-overlays-view.tsx'
export { clampOverlay, shortcutHelp } from '../../logic/overlays/overlay-session.ts'
export { archiveBase64, archiveBytes, downloadBlueprint } from '../../../../adapters/browser/overlay-browser-effects.ts'
interface OverlayProps {
  React: typeof React
  overlay: CanvasOverlay
  root: React.RefObject<HTMLDivElement | null>
  t: BlueprintLocaleProps['t']
  commands: ContextCommand[]
  moreActions?: MenuAction[] | undefined
  presentationState?: { allPinned: boolean; allCollapsed: boolean }
  onCommand: (command: CanvasCommand) => void
  onAdd: (kind: BuiltinNodeKind) => void
  onRename: (value: string) => void
  onClose: () => void
  importDisabledReason?: CommandDisabledReason | null
  importTargets: Array<{ blueprintId: string; name: string; nonempty: boolean }>
  onImportFile: (id: string, file: File) => void
  archiveIntent?: { state: OverlayViewState; onIntent: (intent: OverlayIntent) => void; onArchiveError: (code: 'blueprint/archive-read-failed') => void }
}
/** Compatibility adapter using the panel's existing React seat and callbacks. */
export function InteractionOverlay(props: OverlayProps): React.ReactElement {
  const { React, overlay, root, t, onClose } = props
  const ref = React.useRef<HTMLDivElement>(null)
  const readEpoch = React.useRef(0)
  const latest = React.useRef(props)
  latest.current = props
  const close = () => {
    readEpoch.current++
    onClose()
  }

  const [position, setPosition] = React.useState(overlay.screen)
  const [state, setState] = React.useState(() =>
    initialOverlaySession(overlay.kind, overlay.kind === 'rename' ? overlay.value : '', props.importTargets.find(target => !target.nonempty)?.blueprintId ?? '')
  )
  const [file, setFile] = React.useState<File | null>(null)
  const submenuFocus = React.useRef(false)
  const candidates = overlay.kind === 'node-search' ? compatibleSearchNodes(state.query, overlay.origin, t) : []
  const index = searchActiveIndex(state.active, candidates.length)
  const isMenu = overlay.kind === 'context-menu' || overlay.kind === 'more-menu'
  React.useEffect(() => observeOverlay(ref.current, root.current, overlay, setPosition, close), [overlay, root, onClose])
  React.useEffect(() => {
    if (state.submenu && submenuFocus.current) {
      focusSubmenu(ref.current, state.submenu)
      submenuFocus.current = false
    }
  }, [state.submenu])
  React.useEffect(
    () => () => {
      readEpoch.current++
    },
    []
  )
  const back = () => {
    submenuFocus.current = false
    setState(value => transitionOverlay(value, { type: 'submenu', submenu: null }))
    returnOverlayParent(ref.current, state.submenu)
  }
  const send = (intent: OverlayMarkupIntent) => {
    if (intent.type === 'command') {
      if (props.commands.some(item => item.command === intent.command && item.enabled)) props.onCommand(intent.command)
    } else if (intent.type === 'action') {
      const action = props.moreActions?.find(item => item.action === intent.action)
      if (action?.enabled) action.onSelect()
    } else if (intent.type === 'add') {
      if (candidates.some(item => item.kind === intent.kind)) props.onAdd(intent.kind)
    } else if (intent.type === 'rename') {
      if (overlay.kind === 'rename') props.onRename(intent.value)
    } else if (intent.type === 'import-submit') {
      if (file && importEligible(!!props.importDisabledReason, state.confirmed, !!file, state.targetId, props.importTargets)) {
        const typed = props.archiveIntent
        if (!typed) props.onImportFile(state.targetId, file)
        else if (
          typed.state.kind === 'import' &&
          importEligible(!!typed.state.disabled, state.confirmed, true, state.targetId, typed.state.importTargets ?? [])
        ) {
          const epoch = ++readEpoch.current,
            blueprintId = state.targetId
          // Explicit local confirmation is an event fact. The caller owns target eligibility and binding.
          const currentRead = () => {
            const current = latest.current,
              owner = current.archiveIntent
            return epoch === readEpoch.current &&
              owner &&
              !current.importDisabledReason &&
              !owner.state.disabled &&
              owner.state.kind === 'import' &&
              importEligible(false, true, true, blueprintId, owner.state.importTargets ?? []) &&
              sameWorkspaceViewBinding(owner.state.binding, typed.state.binding) &&
              importEligible(false, true, true, blueprintId, current.importTargets)
              ? owner
              : null
          }
          void readOverlayArchive(file).then(
            archiveBase64 => {
              const current = currentRead()
              if (!current) return
              const intent: OverlayIntent = {
                type: 'overlay-import-ready',
                binding: current.state.binding,
                blueprintId,
                archiveBase64,
                confirmedId: blueprintId
              }
              if (acceptsOverlayIntent({ ...current.state, importConfirmedId: blueprintId }, intent)) current.onIntent(intent)
            },
            () => {
              currentRead()?.onArchiveError('blueprint/archive-read-failed')
            }
          )
        }
      }
    } else {
      readEpoch.current++
      if (intent.type === 'submenu') submenuFocus.current = true
      setState(value => transitionOverlay(value, intent))
    }
  }
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape') {
      event.preventDefault()
      if (isMenu && state.submenu) back()
      else close()
      return
    }
    if (isMenu) menuKeyboard(event, ref.current, state.submenu, group => send({ type: 'submenu', submenu: group }), back, close)
    else if (overlay.kind === 'node-search') {
      const active = searchKeyIndex(event.key, index, candidates.length)
      if (active !== undefined) {
        event.preventDefault()
        send({ type: 'active', active })
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const candidate = candidates[index]
        if (candidate) send({ type: 'add', kind: candidate.kind })
      }
    }
  }
  return interactionOverlaysView(React, {
    overlay,
    position,
    state,
    elementRef: ref,
    t,
    commands: props.commands,
    moreActions: props.moreActions?.map(({ onSelect: _onSelect, ...item }) => item),
    presentationState: props.presentationState,
    importDisabledReason: props.importDisabledReason,
    importTargets: props.importTargets,
    hasFile: !!file,
    importDisabled: !!props.importDisabledReason || !!props.archiveIntent?.state.disabled,
    candidates,
    onIntent: send,
    onClose: close,
    onKeyDown: keyDown,
    onFileChange: event => {
      setFile(pickedOverlayFile(event))
      send({ type: 'file-changed' })
    }
  })
}

/** Typed consumer: caller owns binding/eligibility; the local session owns explicit import confirmation.
 * Changing target/file clears confirmation. Only a confirmed current read produces an archive intent.
 */
export interface BoundOverlayProps extends Omit<OverlayProps, 'onCommand' | 'onAdd' | 'onRename' | 'onClose' | 'onImportFile' | 'moreActions'> {
  state: OverlayViewState
  onIntent: (intent: OverlayIntent) => void
  onArchiveError: (code: 'blueprint/archive-read-failed') => void
  moreActions?: Array<Omit<MenuAction, 'onSelect'>>
}
export function OverlayView(props: BoundOverlayProps): React.ReactElement {
  const { state, onIntent, onArchiveError, ...legacy } = props
  const emit = (intent: OverlayIntent) => {
    if (acceptsOverlayIntent(state, intent)) onIntent(intent)
  }
  return props.React.createElement(InteractionOverlay, {
    ...legacy,
    moreActions: props.moreActions?.map(action => ({
      ...action,
      onSelect: () => emit({ type: 'overlay-command', binding: state.binding, command: action.action })
    })),
    onCommand: command => emit({ type: 'overlay-command', binding: state.binding, command }),
    onAdd: nodeKind => emit({ type: 'overlay-add-node', binding: state.binding, nodeKind }),
    onRename: value => emit({ type: 'overlay-rename', binding: state.binding, value }),
    onClose: () => emit({ type: 'overlay-close', binding: state.binding }),
    archiveIntent: { state, onIntent, onArchiveError },
    onImportFile: () => {}
  })
}
