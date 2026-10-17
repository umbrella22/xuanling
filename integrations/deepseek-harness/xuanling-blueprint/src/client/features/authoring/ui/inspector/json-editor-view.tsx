/** @jsxRuntime classic */
/** @jsx React.createElement */
import type React from 'react'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
type ReactSeat = typeof React
export type JsonEditorMarkupIntent = { readonly type: 'format' }
export interface JsonEditorMarkupProps {
  root: React.RefObject<HTMLDivElement | null>
  mount: React.RefObject<HTMLDivElement | null>
  text: string
  issue: { line: number; column: number } | null
  active: boolean
  label: string
  t: BlueprintLocaleProps['t']
  rows?: number | undefined
  name?: string | undefined
  disabled?: boolean | undefined
  onBlur: (event: React.FocusEvent<HTMLDivElement>) => void
  onIntent: (intent: JsonEditorMarkupIntent) => void
}
export function jsonEditorView(React: ReactSeat, props: JsonEditorMarkupProps): React.ReactElement {
  return (
    <div
      ref={props.root}
      className="bp-json-editor nodrag nowheel nopan"
      data-bp-json-editor={true}
      role="group"
      aria-label={props.label}
      onBlur={props.onBlur}
    >
      <div ref={props.mount} className="bp-json-surface" style={{ minHeight: `${(props.rows ?? 3) * 1.5 + 1}em` }} />
      {props.name && <input type="hidden" name={props.name} value={props.text} />}
      <div className="bp-json-footer">
        <span role="status" aria-live="polite" data-bp-json-valid={String(!props.issue)}>
          {props.issue ? props.t('json.errorLocation', props.issue) : 'JSON'}
        </span>
        <button
          type="button"
          disabled={props.disabled || !props.active}
          data-bp-action="format-json"
          onMouseDown={event => event.preventDefault()}
          onClick={() => props.onIntent({ type: 'format' })}
        >
          {props.t('json.format')}
        </button>
      </div>
    </div>
  )
}
