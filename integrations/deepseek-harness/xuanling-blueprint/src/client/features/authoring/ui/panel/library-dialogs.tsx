/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import React from 'react'
import type { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import { LibraryReuseBody } from './library-actions.tsx'
import { blueprintIcon } from '../../../../shared/icons/icons.ts'

export interface LibraryReuseDialogProps {
  React: typeof React
  t: BlueprintLocaleProps['t']
  workspace: BlueprintWorkspace
  onClose: () => void
}

/** Modal shell for the existing share/reuse body. Modal state lives in the panel;
 * the body keeps its own workspace-owned action state and Host checks.
 * Exported as a hook-free wrapper so the panel can either render it as JSX or call
 * it like the other markup helpers without borrowing the panel's hook slots. */
const dialogFocusables = (root: HTMLElement | null): HTMLElement[] => {
  if (!root) return []
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter(element => !element.hasAttribute('hidden'))
}
/** Keep Tab inside the modal and restore the opener's focus on close. */
const trapDialogTab = (event: React.KeyboardEvent<HTMLDivElement>, root: HTMLElement | null) => {
  if (event.key !== 'Tab' || !root) return
  const items = dialogFocusables(root)
  if (items.length === 0) {
    event.preventDefault()
    return
  }
  const first = items[0]!,
    last = items[items.length - 1]!,
    active = document.activeElement
  if (event.shiftKey) {
    if (active === first || !root.contains(active)) {
      event.preventDefault()
      last.focus()
    }
  } else if (active === last || !root.contains(active)) {
    event.preventDefault()
    first.focus()
  }
}

export function LibraryReuseDialog(props: LibraryReuseDialogProps): React.ReactElement {
  return <LibraryReuseDialogView t={props.t} workspace={props.workspace} onClose={props.onClose} />
}

function LibraryReuseDialogView({ t, workspace, onClose }: Omit<LibraryReuseDialogProps, 'React'>): React.ReactElement {
  const dialog = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return (
    <div
      className={'bp-dialog-backdrop'}
      onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        role={'dialog'}
        aria-modal={'true'}
        aria-labelledby={'bp-library-dialog-title'}
        tabIndex={-1}
        className={'bp-dialog'}
        data-bp-library-dialog={true}
        onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onClose()
            return
          }
          trapDialogTab(event, dialog.current)
        }}
      >
        <header className={'bp-dialog-head'}>
          <h2 id={'bp-library-dialog-title'} className={'bp-dialog-title'}>
            {t('library.reuse')}
          </h2>
          <button type={'button'} className={'bp-dialog-close'} data-bp-dialog-close={true} aria-label={t('dialog.cancel')} onClick={onClose}>
            {blueprintIcon(React, 'close')}
          </button>
        </header>
        <div className={'bp-dialog-content'} data-bp-library-actions={true}>
          <p>{t('library.shareHelp')}</p>
          <LibraryReuseBody workspace={workspace} t={t} />
        </div>
      </div>
    </div>
  )
}

export interface RenameBlueprintDialogProps {
  React: typeof React
  t: BlueprintLocaleProps['t']
  initialValue: string
  onCancel: () => void
  onConfirm: (value: string) => void
}

/** Small single-field rename prompt. Confirming reports a trimmed, non-empty
 * value that differs from the initial name; the panel owns the actual rename.
 * Hook-free wrapper for the same JSX-or-call flexibility as the reuse dialog. */
export function RenameBlueprintDialog(props: RenameBlueprintDialogProps): React.ReactElement {
  return <RenameBlueprintDialogView t={props.t} initialValue={props.initialValue} onCancel={props.onCancel} onConfirm={props.onConfirm} />
}

function RenameBlueprintDialogView({ t, initialValue, onCancel, onConfirm }: Omit<RenameBlueprintDialogProps, 'React'>): React.ReactElement {
  const [value, setValue] = React.useState(initialValue)
  const dialog = React.useRef<HTMLDivElement>(null)
  const input = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = input.current
    element?.focus()
    element?.select()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  const trimmed = value.trim()
  const canConfirm = trimmed !== '' && trimmed !== initialValue.trim()
  const confirm = () => {
    if (canConfirm) onConfirm(trimmed)
  }
  return (
    <div
      className={'bp-dialog-backdrop'}
      onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        ref={dialog}
        role={'dialog'}
        aria-modal={'true'}
        aria-labelledby={'bp-rename-dialog-title'}
        className={'bp-dialog bp-dialog-sm'}
        data-bp-rename-dialog={true}
        onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            onCancel()
            return
          }
          trapDialogTab(event, dialog.current)
        }}
      >
        <header className={'bp-dialog-head'}>
          <h2 id={'bp-rename-dialog-title'} className={'bp-dialog-title'}>
            {t('document.name')}
          </h2>
        </header>
        <div className={'bp-dialog-content'}>
          <input
            ref={input}
            className={'bp-dialog-text'}
            data-bp-rename-input={true}
            aria-label={t('document.name')}
            value={value}
            onChange={event => setValue(event.target.value)}
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                confirm()
              }
            }}
          />
        </div>
        <div className={'bp-dialog-actions'}>
          <button type={'button'} className={'bp-dialog-button'} data-bp-rename-cancel={true} onClick={onCancel}>
            {t('dialog.cancel')}
          </button>
          <button
            type={'button'}
            className={'bp-dialog-button bp-dialog-button-primary'}
            data-bp-rename-confirm={true}
            disabled={!canConfirm}
            onClick={confirm}
          >
            {t('dialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
