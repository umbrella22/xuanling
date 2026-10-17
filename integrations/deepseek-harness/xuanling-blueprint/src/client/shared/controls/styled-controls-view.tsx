/** @jsxRuntime classic */
/** @jsx React.createElement */
import type React from 'react'
type ReactSeat = typeof React
export type SelectViewIntent = { type: 'toggle' } | { type: 'choose'; index: number } | { type: 'hover'; index: number }
export interface SelectMarkupProps {
  root: React.RefObject<HTMLDivElement | null>
  trigger: React.RefObject<HTMLButtonElement | null>
  list: React.RefObject<HTMLDivElement | null>
  id: string
  className: string
  value: string
  unavailable: boolean
  open: boolean
  selected: number
  activeIndex: number
  options: readonly { value: string; label: React.ReactNode; disabled: boolean }[]
  attributes: React.ButtonHTMLAttributes<HTMLButtonElement> & { [attribute: `data-${string}`]: string | boolean | undefined }
  onIntent: (intent: SelectViewIntent) => void
  onBlur: React.FocusEventHandler<HTMLDivElement>
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>
}
/** Markup only; no browser reads, hooks, domain objects or side effects. */
export function styledSelectView(React: ReactSeat, props: SelectMarkupProps): React.ReactElement {
  const { root, trigger, list, id, className, value, unavailable, open, selected, activeIndex, options, attributes, onIntent } = props
  return (
    <div ref={root} className={`bp-select ${className}`} onBlur={props.onBlur}>
      <button
        {...attributes}
        ref={trigger}
        type="button"
        role="combobox"
        disabled={unavailable}
        className="bp-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        data-bp-value={value}
        aria-activedescendant={open && activeIndex >= 0 ? `${id}-${activeIndex}` : undefined}
        onKeyDown={props.onKeyDown}
        onClick={() => onIntent({ type: 'toggle' })}
      >
        <span className="bp-select-value">{options[selected]?.label ?? ''}</span>
        <span className="bp-select-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          role="listbox"
          popover="manual"
          className="bp-select-list"
          aria-label={attributes['aria-label']}
          onPointerDown={event => event.preventDefault()}
          onKeyDown={event => event.stopPropagation()}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === selected}
              aria-disabled={option.disabled}
              data-bp-option-index={index}
              data-bp-option-value={option.value}
              data-bp-active={index === activeIndex}
              onPointerMove={() => onIntent({ type: 'hover', index })}
              onClick={event => {
                event.preventDefault()
                event.stopPropagation()
                onIntent({ type: 'choose', index })
              }}
            >
              <span className="bp-select-option-label">{option.label}</span>
              <span aria-hidden="true" className="bp-select-check">
                {index === selected ? '✓' : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
export interface ConfirmationMarkupProps {
  ref: React.RefObject<HTMLDivElement | null>
  id: string
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  busy?: boolean | undefined
  onIntent: (decision: 'confirm' | 'cancel') => void
  onBackdrop: React.PointerEventHandler<HTMLDivElement>
  onKeyDown: React.KeyboardEventHandler<HTMLDivElement>
}
export function confirmationDialogView(React: ReactSeat, props: ConfirmationMarkupProps): React.ReactElement {
  return (
    <div className="bp-confirm-backdrop" onPointerDown={props.onBackdrop}>
      <div
        ref={props.ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${props.id}-title`}
        aria-describedby={`${props.id}-description`}
        tabIndex={-1}
        className="bp-confirm-dialog"
        data-bp-confirm-dialog={true}
        onKeyDown={props.onKeyDown}
      >
        <h2 id={`${props.id}-title`}>{props.title}</h2>
        <p id={`${props.id}-description`}>{props.description}</p>
        <div className="bp-confirm-actions">
          <button type="button" data-bp-confirm-cancel={true} disabled={props.busy} onClick={() => props.onIntent('cancel')}>
            {props.cancelLabel}
          </button>
          <button type="button" data-bp-confirm-accept={true} disabled={props.busy} onClick={() => props.onIntent('confirm')}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
