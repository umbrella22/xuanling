/** Compatible JSON editor adapter. Malformed draft buffers still reach the legacy owner unchanged. */
import React from 'react'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import { useJsonEditorBrowser } from '../../ui/inspector/json-editor-browser.ts'
import { jsonEditorView } from '../../ui/inspector/json-editor-view.tsx'
import { acceptsJsonIntent } from '../../../../shared/contracts/view-contract.ts'
import type { JsonViewState, JsonIntent } from '../../../../shared/contracts/view-contract.ts'
export { formatJson, jsonEditorKeymap } from '../../ui/inspector/json-editor-browser.ts'
export interface JsonEditorProps {
  value?: string
  defaultValue?: string
  onChange?: (text: string) => void
  onBlur?: (text: string) => void
  label: string
  t: BlueprintLocaleProps['t']
  rows?: number
  name?: string
  disabled?: boolean
  'data-bp-json'?: string
  'data-bp-run-input'?: boolean
}

export function JsonEditor(props: JsonEditorProps): React.ReactElement {
  return jsonEditorView(React, useJsonEditorBrowser(props))
}
export type JsonEditorViewState = JsonViewState
export type JsonEditorIntent = JsonIntent
export interface BoundJsonEditorProps extends Omit<JsonEditorProps, 'value' | 'defaultValue' | 'disabled' | 'onChange' | 'onBlur'> {
  state: JsonEditorViewState
  onIntent: (intent: JsonEditorIntent) => void
}
/** Buffer edits remain unvalidated drafts; commit is a separate request validated by its semantic owner.
 * Inspector/Workspace owns semantic validation and current-binding admission.
 */
export function JsonEditorView({ state, onIntent, ...props }: BoundJsonEditorProps): React.ReactElement {
  const emit = (intent: JsonIntent) => {
    if (acceptsJsonIntent(state, intent)) onIntent(intent)
  }
  const identity = { binding: state.binding, nodeId: state.nodeId, field: state.field }
  return React.createElement(JsonEditor, {
    ...props,
    value: state.buffer,
    disabled: state.disabled,
    onChange: text => emit({ type: 'json-buffer-change', ...identity, text }),
    onBlur: () => emit({ type: 'json-commit', ...identity })
  })
}
