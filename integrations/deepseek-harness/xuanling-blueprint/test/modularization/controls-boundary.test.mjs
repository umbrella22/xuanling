import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'vite/rolldown/parseAst'

const client = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/client')
function source(name) {
  const path = resolve(client, name)
  assert.ok(existsSync(path), `CONTROL_BOUNDARY_MODULE_MISSING: ${name}; centralized StyledSelect/ConfirmationDialog must delegate`)
  return readFileSync(path, 'utf8')
}
function imports(code, name) {
  return parseAst(code, { lang: 'tsx', sourceType: 'module' }, name)
    .body.filter(node => node.type === 'ImportDeclaration' && node.importKind !== 'type' && !node.specifiers.every(item => item.importKind === 'type'))
    .map(node => node.source.value)
}
function walk(value, visit) {
  if (!value || typeof value !== 'object') return
  if (typeof value.type === 'string') visit(value)
  for (const child of Object.values(value))
    if (Array.isArray(child)) child.forEach(item => walk(item, visit))
    else if (child && typeof child === 'object') walk(child, visit)
}
function assertViewBoundary(code) {
  const ast = parseAst(code, { lang: 'tsx', sourceType: 'module' }, 'styled-controls-view.tsx')
  walk(ast, node => {
    if (node.type === 'Identifier')
      assert.ok(
        !['document', 'window', 'MutationObserver', 'ResizeObserver', 'localStorage', 'GraphEditor', 'BlueprintWorkspace'].includes(node.name),
        `CONTROL_VIEW_EFFECT: ${node.name}`
      )
    if (node.type === 'MemberExpression' && !node.computed)
      assert.ok(
        ![
          'useEffect',
          'useLayoutEffect',
          'focus',
          'getBoundingClientRect',
          'querySelector',
          'querySelectorAll',
          'dispatch',
          'patchNode',
          'addNode',
          'removeNode',
          'setItem'
        ].includes(node.property.name),
        `CONTROL_VIEW_MUTATION: ${node.property.name}`
      )
  })
}

function assertAdapterWiring(adapter) {
  const runtime = imports(adapter, 'styled-controls.ts')
  for (const dependency of ['./control-session.ts', '../../adapters/browser/control-browser-effects.ts', './styled-controls-view.tsx'])
    assert.ok(runtime.includes(dependency), `CONTROL_PRODUCTION_WIRING_MISSING: ${dependency}`)
  const ast = parseAst(adapter, { lang: 'ts', sourceType: 'module' }, 'styled-controls.ts')
  for (const entry of ast.body.filter(
    node =>
      node.type === 'ImportDeclaration' &&
      node.importKind !== 'type' &&
      runtime.includes(node.source.value) &&
      /control-session|control-browser-effects|styled-controls-view/.test(node.source.value)
  )) {
    const names = entry.specifiers.filter(item => item.importKind !== 'type').map(item => item.local.name)
    const calls = new Set()
    walk(ast, node => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.add(node.callee.name)
    })
    assert.ok(
      names.some(name => calls.has(name)),
      `CONTROL_IMPORTED_BUT_UNUSED: ${entry.source.value}`
    )
  }
}

test('production compatibility controls delegate to session, browser effects, and explicit markup view', () => {
  const session = source('shared/controls/control-session.ts'),
    effects = source('adapters/browser/control-browser-effects.ts'),
    view = source('shared/controls/styled-controls-view.tsx'),
    adapter = source('shared/controls/styled-controls.ts')
  assertAdapterWiring(adapter)
  for (const dependency of imports(session, 'control-session.ts'))
    assert.doesNotMatch(dependency, /react|view|browser|remote|workspace|graph-editor/, 'CONTROL_SESSION_FRAMEWORK_DEPENDENCY')
  assert.doesNotMatch(session, /\b(document|window|HTMLElement|MutationObserver|ResizeObserver)\b/, 'CONTROL_SESSION_DOM_DEPENDENCY')
  assertViewBoundary(view)
  assert.ok(effects.length > 100, 'CONTROL_EFFECTS_EMPTY')
  assert.ok(view.includes('export ') && session.includes('export '), 'CONTROL_EMPTY_SPLIT')
})

test('boundary oracle rejects actual view DOM and controller mutations', () => {
  assert.throws(() => assertViewBoundary('export function Bad(){ document.activeElement.focus() }'), /CONTROL_VIEW_(EFFECT|MUTATION)/)
  assert.throws(() => assertViewBoundary('export function Bad(props){ props.editor.patchNode("n", {}) }'), /CONTROL_VIEW_MUTATION/)
})

test('public controls preserve exact option labels/values, disabled admission, and dialog ARIA through injected React seat', async () => {
  const { default: React } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { StyledSelect, ConfirmationDialog } = await import('../../src/client/shared/controls/styled-controls.ts')
  let rendered = 0
  const seat = {
    ...React,
    createElement: (...args) => {
      rendered++
      return React.createElement(...args)
    }
  }
  const html = renderToStaticMarkup(
    React.createElement(
      StyledSelect,
      { React: seat, value: ' exact / 中文 ', 'aria-label': 'Choose', onChange: () => assert.fail('render dispatched change') },
      React.createElement('option', { value: ' exact / 中文 ' }, React.createElement('strong', null, 'Rich label'))
    )
  )
  assert.ok(rendered > 0, 'CONTROL_INJECTED_REACT_SEAT_UNUSED')
  assert.match(html, /role="combobox"/)
  assert.match(html, /data-bp-value=" exact \/ 中文 "/)
  assert.match(html, /<strong>Rich label<\/strong>/)
  assert.match(html, /aria-expanded="false"/)
  const disabled = renderToStaticMarkup(
    React.createElement(StyledSelect, { React: seat, value: 'a' }, React.createElement('option', { value: 'a', disabled: true }, 'Unavailable'))
  )
  assert.match(disabled, /<button[^>]*disabled=""/)
  const dialog = renderToStaticMarkup(
    React.createElement(ConfirmationDialog, {
      React: seat,
      title: 'Exact title',
      description: 'Description',
      cancelLabel: 'Cancel',
      confirmLabel: 'Confirm',
      onCancel: () => assert.fail('render cancelled'),
      onConfirm: () => assert.fail('render confirmed')
    })
  )
  assert.match(dialog, /role="dialog"/)
  assert.match(dialog, /aria-modal="true"/)
  const labelled = dialog.match(/aria-labelledby="([^"]+)"/)[1],
    described = dialog.match(/aria-describedby="([^"]+)"/)[1]
  assert.ok(dialog.includes(`id="${labelled}"`))
  assert.ok(dialog.includes(`id="${described}"`))
  assert.ok(dialog.indexOf('data-bp-confirm-cancel') < dialog.indexOf('data-bp-confirm-accept'))
})

test('pure control session preserves keyboard admission, IME, and exact typeahead deadline', async () => {
  source('shared/controls/control-session.ts')
  const { initialSelectState, transitionSelect } = await import('../../src/client/shared/controls/control-session.ts')
  const context = {
    value: 'alpha',
    disabled: false,
    options: [
      { value: 'alpha', text: 'Alpha', disabled: false },
      { value: 'blocked', text: 'Beta', disabled: true },
      { value: ' exact ', text: 'Bravo', disabled: false }
    ]
  }
  const initial = initialSelectState()
  const opened = transitionSelect(initial, context, { type: 'key', key: 'ArrowDown', now: 0 }).state
  assert.equal(opened.open, true)
  const moved = transitionSelect(opened, context, { type: 'key', key: 'ArrowDown', now: 1 }).state
  assert.equal(moved.active, 2, 'disabled option must be skipped')
  const selected = transitionSelect(moved, context, { type: 'key', key: 'Enter', now: 2 })
  assert.equal(selected.chosen, ' exact ')
  assert.equal(selected.state.open, false)
  assert.equal(transitionSelect(moved, { ...context, disabled: true }, { type: 'choose', index: 2 }).chosen, undefined)
  assert.equal(transitionSelect(moved, context, { type: 'choose', index: 1 }).chosen, undefined)
  assert.deepEqual(transitionSelect(moved, context, { type: 'key', key: 'Enter', now: 3, composing: true }).state, moved)
  const escape = transitionSelect(moved, context, { type: 'key', key: 'Escape', now: 3 })
  assert.equal(escape.chosen, undefined)
  assert.equal(escape.state.open, false)
  assert.equal(escape.stopPropagation, true)
  assert.equal(transitionSelect(initial, context, { type: 'key', key: 'Escape', now: 3 }).stopPropagation, false)
  const prefix = transitionSelect(initial, context, { type: 'key', key: 'b', now: 1000 }).state
  assert.equal(transitionSelect(prefix, context, { type: 'key', key: 'r', now: 1699 }).state.searchText, 'br')
  assert.equal(transitionSelect(prefix, context, { type: 'key', key: 'r', now: 1700 }).state.searchText, 'r')
  assert.deepEqual(initial, initialSelectState(), 'input session state must remain unchanged')
})

test('production view mutation calibration rejects effects added to actual markup owner', () => {
  const actual = source('shared/controls/styled-controls-view.tsx')
  assert.throws(() => assertViewBoundary(`${actual}\nexport function injectedDomMutation(){document.activeElement?.focus()}`), /CONTROL_VIEW_(EFFECT|MUTATION)/)
  assert.throws(() => assertViewBoundary(`${actual}\nexport function injectedGraphMutation(props){props.editor.patchNode('n',{})}`), /CONTROL_VIEW_MUTATION/)
})

test('actual production adapter cannot pass with imported but uncalled view', () => {
  const actual = source('shared/controls/styled-controls.ts')
  const ast = parseAst(actual, { lang: 'ts', sourceType: 'module' }, 'styled-controls.ts')
  const viewImport = ast.body.find(
    node => node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.source.value === './styled-controls-view.tsx'
  )
  assert.ok(viewImport)
  const names = new Set(viewImport.specifiers.map(item => item.local.name))
  const ranges = []
  walk(ast, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && names.has(node.callee.name)) ranges.push([node.callee.start, node.callee.end])
  })
  let mutated = actual
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) mutated = mutated.slice(0, start) + 'unusedMarkup' + mutated.slice(end)
  assert.throws(() => assertAdapterWiring(mutated), /CONTROL_IMPORTED_BUT_UNUSED/)
})
