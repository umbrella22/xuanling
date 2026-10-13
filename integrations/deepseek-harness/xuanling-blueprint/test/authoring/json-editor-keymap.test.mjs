import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorState, EditorSelection } from '@codemirror/state'
import { history, isolateHistory } from '@codemirror/commands'
import { json } from '@codemirror/lang-json'
import { jsonEditorKeymap, formatJson } from '../../src/client/json-editor.ts'

function fixture(doc, selection = EditorSelection.cursor(0), readOnly = false) {
  const target = { state: EditorState.create({ doc, selection, extensions: [json(), history(), EditorState.readOnly.of(readOnly)] }), composing: false }
  target.dispatch = transaction => { target.state = transaction.state ?? target.state.update(transaction).state }
  return target
}
function key(target, name, shift = false) {
  const binding = jsonEditorKeymap.find(binding => binding.key === name)
  assert.ok(binding, `production JSON keymap must bind ${name}`)
  const run = shift ? binding.shift : binding.run
  assert.equal(typeof run, 'function', `production JSON keymap must handle ${shift ? 'Shift-' : ''}${name}`)
  return run(target)
}

test('JSON ordinary Enter retains language indentation and format stays undoable', () => {
  const target = fixture('{}', EditorSelection.cursor(1))
  assert.equal(key(target, 'Enter'), true)
  assert.equal(target.state.doc.toString(), '{\n  \n}')
  assert.equal(key(target, 'Mod-z'), true)
  assert.equal(target.state.doc.toString(), '{}')
  assert.equal(jsonEditorKeymap.find(binding => binding.key === 'Mod-y').mac, 'Mod-Shift-z')
  assert.equal(jsonEditorKeymap.find(binding => binding.linux === 'Ctrl-Shift-z').run, jsonEditorKeymap.find(binding => binding.key === 'Mod-y').run)
  assert.equal(key(target, 'Mod-y'), true)
  assert.equal(target.state.doc.toString(), '{\n  \n}')
  target.dispatch(target.state.update({ changes: { from: 0, to: target.state.doc.length, insert: '{"answer":1}' }, annotations: isolateHistory.of('full') }))
  assert.equal(formatJson(target), true)
  assert.equal(target.state.doc.toString(), '{\n  "answer": 1\n}')
  assert.equal(key(target, 'Mod-z'), true)
  assert.equal(target.state.doc.toString(), '{"answer":1}')
})

test('JSON Tab, Shift-Tab and bracket shortcuts keep selected-line indentation', () => {
  for (const [more, less, shift] of [['Tab', 'Tab', true], ['Mod-]', 'Mod-[', false]]) {
    const target = fixture('{\n"answer": 1\n}', EditorSelection.range(2, 13))
    assert.equal(key(target, more), true)
    assert.equal(target.state.doc.toString(), '{\n  "answer": 1\n}')
    assert.equal(key(target, less, shift), true)
    assert.equal(target.state.doc.toString(), '{\n"answer": 1\n}')
  }
})

test('JSON select-all and deletion retain ordinary document edits', () => {
  const target = fixture('{"answer":1}')
  assert.equal(key(target, 'Mod-a'), true)
  assert.equal(target.state.selection.main.from, 0)
  assert.equal(target.state.selection.main.to, target.state.doc.length)
  assert.equal(key(target, 'Backspace'), true)
  assert.equal(target.state.doc.toString(), '')
  assert.equal(key(target, 'Mod-z'), true)
  assert.equal(target.state.doc.toString(), '{"answer":1}')
})

test('JSON keyboard focus escape retains both platform bindings', () => {
  const binding = jsonEditorKeymap.find(binding => binding.key === 'Ctrl-m')
  assert.equal(binding.mac, 'Shift-Alt-m')
  const focusModes = []
  assert.equal(binding.run({ setTabFocusMode: value => focusModes.push(value) }), true)
  assert.deepEqual(focusModes, [undefined])
})

test('JSON readonly and IME format paths preserve authored buffers', () => {
  const readOnly = fixture('{"answer":1}', EditorSelection.cursor(1), true)
  assert.equal(key(readOnly, 'Enter'), false)
  assert.equal(key(readOnly, 'Tab'), false)
  assert.equal(formatJson(readOnly), false)
  const composing = fixture('{"answer":1}')
  composing.composing = true
  assert.equal(formatJson(composing), false)
  assert.equal(composing.state.doc.toString(), '{"answer":1}')
})
