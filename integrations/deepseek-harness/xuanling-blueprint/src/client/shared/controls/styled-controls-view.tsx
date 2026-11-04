/** @jsxRuntime classic */
/** @jsx React.createElement */
import type React from 'react'
type ReactSeat = typeof React
export type SelectViewIntent = { type: 'toggle' } | { type: 'choose'; index: number } | { type: 'hover'; index: number }
export interface SelectOptionMarkup {
  value: string
  label: React.ReactNode
  disabled: boolean
  /** Library/group heading this option belongs to; rendered ahead of the first option of each group. */
  group?: string | undefined
}
export interface SelectSearchMarkup {
  ref: React.RefObject<HTMLInputElement | null>
  value: string
  placeholder: string
  inputLabel: string
  onChange: React.ChangeEventHandler<HTMLInputElement>
  onKeyDown: React.KeyboardEventHandler<HTMLInputElement>
}
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
  selectedLabel?: React.ReactNode
  activeIndex: number
  options: readonly SelectOptionMarkup[]
  attributes: React.ButtonHTMLAttributes<HTMLButtonElement> & { [attribute: `data-${string}`]: string | boolean | undefined }
  onIntent: (intent: SelectViewIntent) => void
  onBlur: React.FocusEventHandler<HTMLDivElement>
  onKeyDown: React.KeyboardEventHandler<HTMLButtonElement>
  search?: SelectSearchMarkup | undefined
  emptyLabel?: string | undefined
}
/** Markup only; no browser reads, hooks, domain objects or side effects. */
export function styledSelectView(React: ReactSeat, props: SelectMarkupProps): React.ReactElement {
  const { root, trigger, list, id, className, value, unavailable, open, selected, activeIndex, options, attributes, onIntent, search, emptyLabel } = props
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
        <span className="bp-select-value">{props.selectedLabel ?? options[selected]?.label ?? ''}</span>
        <span className="bp-select-chevron" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width={16}
            height={16}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable={false}
          >
            <path d="m7 10 5 5 5-5" />
          </svg>
        </span>
      </button>
      {open && (
        <div
          ref={list}
          id={id}
          role="listbox"
          popover="manual"
          className={`bp-select-list${search ? ' is-filterable' : ''}`}
          aria-label={attributes['aria-label']}
          onPointerDown={event => event.preventDefault()}
          onKeyDown={event => event.stopPropagation()}
        >
          {search && (
            <div className="bp-select-search" role="presentation" onPointerDown={event => event.stopPropagation()}>
              <input
                ref={search.ref}
                type="search"
                className="bp-select-search-field"
                value={search.value}
                placeholder={search.placeholder}
                aria-label={search.inputLabel ?? search.placeholder}
                autoComplete="off"
                spellCheck={false}
                onChange={search.onChange}
                onKeyDown={search.onKeyDown}
                onPointerDown={event => event.stopPropagation()}
              />
            </div>
          )}
          {options.map((option, index) => {
            const heading = option.group !== undefined && option.group !== options[index - 1]?.group
            return (
              <React.Fragment key={`${option.value}-${index}`}>
                {heading && (
                  <div className="bp-select-group" role="presentation" data-bp-option-group={option.group} title={option.group}>
                    <span>{option.group}</span>
                  </div>
                )}
                <div
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={index === selected}
                  aria-disabled={option.disabled}
                  data-bp-option-index={index}
                  data-bp-option-value={option.value}
                  data-bp-option-group={option.group}
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
                    {index === selected && (
                      <svg
                        viewBox="0 0 24 24"
                        width={14}
                        height={14}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        focusable={false}
                      >
                        <path d="m5 12 4 4L19 6" />
                      </svg>
                    )}
                  </span>
                </div>
              </React.Fragment>
            )
          })}
          {options.length === 0 && emptyLabel !== undefined && (
            <p className="bp-select-empty" role="presentation">
              {emptyLabel}
            </p>
          )}
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
