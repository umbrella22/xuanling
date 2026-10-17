/** Compatibility and React lifecycle adapters; state and browser effects live at explicit boundaries. */
import ReactSeat from 'react'
import type React from 'react'
import { activeSelectIndex, initialSelectState, transitionSelect } from './control-session.ts'
import type { SelectSessionIntent } from './control-session.ts'
import {
  captureConfirmationFocus,
  controlId,
  focusLeavesControl,
  focusSelectTrigger,
  handleConfirmationKey,
  observeSelectPopover,
  scrollActiveOption,
  selectIsDisabled,
  selectKeyIntent
} from '../../adapters/browser/control-browser-effects.ts'
import { confirmationDialogView, styledSelectView } from './styled-controls-view.tsx'
import type { SelectMarkupProps } from './styled-controls-view.tsx'
import { acceptsConfirmationIntent, acceptsSelectIntent } from '../contracts/view-contract.ts'
import type { ConfirmationIntent, ConfirmationViewState, SelectChangeIntent, SelectViewState } from '../contracts/view-contract.ts'

/** Options keep their original values and ReactNode labels; no domain normalization happens here. */
export interface StyledSelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'multiple' | 'size'> {
  React?: typeof ReactSeat
  [attribute: `data-${string}`]: string | boolean | undefined
}
export function StyledSelect({ React = ReactSeat, children, value, disabled, onChange, className = '', ...attributes }: StyledSelectProps): React.ReactElement {
  const root = React.useRef<HTMLDivElement>(null),
    trigger = React.useRef<HTMLButtonElement>(null),
    list = React.useRef<HTMLDivElement>(null)
  const [id] = React.useState(() => controlId('select'))
  const [state, setState] = React.useState(initialSelectState)
  const options: Array<{ value: string; label: React.ReactNode; text: string; disabled: boolean }> = []
  React.Children.forEach(children, child => {
    if (!React.isValidElement<React.OptionHTMLAttributes<HTMLOptionElement>>(child) || child.type !== 'option') return
    const props = child.props
    options.push({ value: String(props.value ?? ''), label: props.children, text: String(props.children ?? ''), disabled: !!props.disabled })
  })
  const unavailable = disabled || !options.some(option => !option.disabled)
  const context = { options, value: String(value ?? ''), disabled: !!disabled }
  const selected = options.findIndex(option => option.value === context.value)
  const activeIndex = activeSelectIndex(state, context)
  const send = (intent: SelectSessionIntent) => {
    // Recheck fieldset state at the event, not only at the last render.
    const result = transitionSelect(state, { ...context, disabled: !!disabled || selectIsDisabled(trigger.current) }, intent)
    setState(result.state)
    if (result.chosen !== undefined) {
      const target = { value: result.chosen }
      onChange?.({ target, currentTarget: target } as React.ChangeEvent<HTMLSelectElement>)
    }
    if (result.focusTrigger) focusSelectTrigger(trigger.current)
    return result
  }
  React.useEffect(() => {
    if (state.open) return observeSelectPopover(root.current, trigger.current, list.current, () => setState(previous => ({ ...previous, open: false })))
  }, [state.open])
  React.useEffect(() => {
    if (state.open) scrollActiveOption(list.current, activeIndex)
  }, [state.open, activeIndex])
  React.useEffect(() => {
    if (unavailable) setState(previous => (previous.open ? { ...previous, open: false } : previous))
  }, [unavailable])
  const { onBlur: _onBlur, onFocus: _onFocus, onKeyDown: _onKeyDown, ...rest } = attributes
  return styledSelectView(React, {
    root,
    trigger,
    list,
    id,
    className,
    value: context.value,
    unavailable: !!unavailable,
    open: state.open,
    selected,
    activeIndex,
    options,
    attributes: rest as SelectMarkupProps['attributes'],
    onIntent: intent => {
      if (intent.type === 'toggle') send({ type: state.open ? 'close' : 'open' })
      else send(intent)
    },
    onBlur: event => {
      if (focusLeavesControl(root.current, event.relatedTarget)) send({ type: 'close' })
    },
    onKeyDown: event => {
      const result = send(selectKeyIntent(event))
      if (result.stopPropagation) event.stopPropagation()
      if (result.preventDefault) event.preventDefault()
    }
  })
}
export interface ConfirmationDialogProps {
  React: typeof ReactSeat
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  busy?: boolean | undefined
  onCancel: () => void
  onConfirm: () => void
}
export function ConfirmationDialog({
  React,
  title,
  description,
  cancelLabel,
  confirmLabel,
  busy,
  onCancel,
  onConfirm
}: ConfirmationDialogProps): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null)
  const [id] = React.useState(() => controlId('confirm'))
  React.useEffect(() => captureConfirmationFocus(ref.current), [])
  return confirmationDialogView(React, {
    ref,
    id,
    title,
    description,
    cancelLabel,
    confirmLabel,
    busy,
    onIntent: decision => (decision === 'confirm' ? onConfirm() : onCancel()),
    onBackdrop: event => {
      event.stopPropagation()
      if (event.target === event.currentTarget) {
        event.preventDefault()
        onCancel()
      }
    },
    onKeyDown: event => handleConfirmationKey(event, ref.current, onCancel)
  })
}

/** Workspace-aware entry points require owner-supplied bindings; compatibility controls never invent them. */
export interface SelectViewProps {
  React?: typeof ReactSeat
  state: SelectViewState
  onIntent: (intent: SelectChangeIntent) => void
  'aria-label'?: string
  className?: string
}
export function SelectView({ React = ReactSeat, state, onIntent, ...attributes }: SelectViewProps): React.ReactElement {
  return React.createElement(
    StyledSelect,
    {
      ...attributes,
      React,
      value: state.value,
      disabled: state.disabled,
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
        const intent: SelectChangeIntent = { type: 'select-change', binding: state.binding, value: event.currentTarget.value }
        if (acceptsSelectIntent(state, intent)) onIntent(intent)
      }
    },
    ...state.options.map(option => React.createElement('option', { key: option.value, value: option.value, disabled: option.disabled }, option.label))
  )
}
export interface ConfirmationViewProps {
  React: typeof ReactSeat
  state: ConfirmationViewState
  onIntent: (intent: ConfirmationIntent) => void
}
export function ConfirmationView({ React, state, onIntent }: ConfirmationViewProps): React.ReactElement {
  const send = (decision: 'confirm' | 'cancel') => {
    const intent: ConfirmationIntent = { type: 'confirmation', binding: state.binding, action: state.action, decision }
    if (acceptsConfirmationIntent(state, intent)) onIntent(intent)
  }
  return React.createElement(ConfirmationDialog, {
    React,
    title: state.title,
    description: state.description ?? '',
    cancelLabel: state.cancelLabel,
    confirmLabel: state.confirmLabel,
    busy: state.busy,
    onCancel: () => send('cancel'),
    onConfirm: () => send('confirm')
  })
}
