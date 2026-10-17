/** JSON-only editor; React is supplied by the same DSH shared module as the panel. */
import React from 'react'
import { Annotation, Compartment, EditorState, Transaction } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, Decoration, ViewPlugin } from '@codemirror/view'
import { standardKeymap, history, historyKeymap, indentWithTab, indentLess, indentMore, toggleTabFocusMode } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import type { JsonEditorProps } from '../../logic/inspector/json-editor.ts'
import type { JsonEditorMarkupProps } from './json-editor-view.tsx'
import { initialJsonBuffer, formatJsonBuffer, canSyncJsonBuffer } from '../../logic/inspector/json-editor-session.ts'

const { useEffect, useRef, useState } = React
export const jsonEditorKeymap = [
  ...standardKeymap,
  ...historyKeymap,
  indentWithTab,
  { key: 'Mod-[', run: indentLess },
  { key: 'Mod-]', run: indentMore },
  { key: 'Ctrl-m', mac: 'Shift-Alt-m', run: toggleTabFocusMode }
]

const external = Annotation.define<boolean>()
const parse = jsonParseLinter()
/** Formatting is one undoable edit; malformed buffers are never rewritten. */
export function formatJson(view: EditorView): boolean {
  const decision = formatJsonBuffer(view.state.doc.toString(), view.composing, view.state.readOnly)
  if (!decision.accepted) return false
  const text = decision.text
  if (text !== view.state.doc.toString())
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: Transaction.userEvent.of('input.format') })
  return true
}
export function useJsonEditorBrowser(props: JsonEditorProps): JsonEditorMarkupProps {
  const latest = useRef(props)
  latest.current = props
  const root = useRef<HTMLDivElement>(null),
    mount = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [text, setText] = useState(initialJsonBuffer(props.value, props.defaultValue))
  const [issue, setIssue] = useState<{ line: number; column: number } | null>(null)
  const [active, setActive] = useState(false)
  const [attributes] = useState(() => new Compartment())
  const [readOnly] = useState(() => new Compartment())
  const contentAttributes = () =>
    EditorView.contentAttributes.of({
      'aria-label': latest.current.label,
      ...(latest.current['data-bp-json'] ? { 'data-bp-json': latest.current['data-bp-json']! } : {}),
      ...(latest.current['data-bp-run-input'] ? { 'data-bp-run-input': 'true' } : {})
    })
  useEffect(() => {
    // Closed details do not allocate a view. Once opened, keep its undo/IME state.
    if (typeof IntersectionObserver === 'undefined') {
      setActive(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setActive(true)
        observer.disconnect()
      }
    })
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!active || !mount.current) return
    const editor = new EditorView({
      parent: mount.current,
      state: EditorState.create({
        doc: initialJsonBuffer(latest.current.value, latest.current.defaultValue),
        extensions: [
          json(),
          history(),
          lineNumbers(),
          bracketMatching(),
          indentOnInput(),
          syntaxHighlighting(
            HighlightStyle.define(
              defaultHighlightStyle.specs.map(spec => ({ ...spec, ...(spec.color ? { color: `color-mix(in srgb, ${spec.color} 65%, var(--bp-text))` } : {}) }))
            )
          ),
          keymap.of(jsonEditorKeymap),
          EditorView.lineWrapping,
          attributes.of(contentAttributes()),
          readOnly.of([EditorState.readOnly.of(!!latest.current.disabled), EditorView.editable.of(!latest.current.disabled)]),
          ViewPlugin.define(
            v => {
              const diagnose = () => {
                const diagnostics = parse(v)
                const first = diagnostics[0]
                const line = first ? v.state.doc.lineAt(first.from) : null
                const next = first && line ? { line: line.number, column: first.from - line.from + 1 } : null
                queueMicrotask(() => {
                  if (view.current === v) setIssue(next)
                })
                // Localized, body-free diagnostics; no JSON contents are sent to Host.
                return Decoration.set(
                  diagnostics.filter(d => d.to > d.from).map(d => Decoration.mark({ class: 'bp-json-error' }).range(d.from, d.to)),
                  true
                )
              }
              return {
                decorations: diagnose(),
                update(update) {
                  if (update.docChanged) this.decorations = diagnose()
                }
              }
            },
            { decorations: plugin => plugin.decorations }
          ),
          EditorView.updateListener.of(update => {
            if (!update.docChanged) return
            const value = update.state.doc.toString()
            setText(value)
            if (!update.transactions.some(tr => tr.annotation(external))) latest.current.onChange?.(value)
          })
        ]
      })
    })
    view.current = editor
    return () => {
      view.current = null
      editor.destroy()
    }
  }, [active])
  useEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({
      effects: [
        attributes.reconfigure(contentAttributes()),
        readOnly.reconfigure([EditorState.readOnly.of(!!props.disabled), EditorView.editable.of(!props.disabled)])
      ]
    })
  }, [active, props.label, props.disabled])
  useEffect(() => {
    if (props.value === undefined) return
    setText(props.value)
    const editor = view.current
    if (editor && canSyncJsonBuffer(editor.state.doc.toString(), props.value, editor.composing))
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: props.value },
        annotations: [external.of(true), Transaction.addToHistory.of(false)]
      })
  }, [active, props.value])
  return {
    root,
    mount,
    text,
    issue,
    active,
    label: props.label,
    t: props.t,
    rows: props.rows,
    name: props.name,
    disabled: props.disabled,
    onBlur: event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null) && !view.current?.composing)
        latest.current.onBlur?.(view.current?.state.doc.toString() ?? text)
    },
    onIntent: intent => {
      if (intent.type === 'format' && view.current) {
        formatJson(view.current)
        view.current.focus()
      }
    }
  }
}
