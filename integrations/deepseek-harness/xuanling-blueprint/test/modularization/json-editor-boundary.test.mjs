import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'vite/rolldown/parseAst'
const client = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/client')
function source(name) {
  const path = resolve(client, name)
  assert.ok(existsSync(path), `JSON_EDITOR_BOUNDARY_MODULE_MISSING: ${name}; production JsonEditor remains centralized`)
  return readFileSync(path, 'utf8')
}
const parse = (code, file) => parseAst(code, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts', sourceType: 'module' }, file)
function walk(value, visit) {
  if (!value || typeof value !== 'object') return
  if (typeof value.type === 'string') visit(value)
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, visit))
    else if (child && typeof child === 'object') walk(child, visit)
  }
}
function runtimeImports(ast) {
  return ast.body.filter(
    node =>
      node.type === 'ImportDeclaration' && node.importKind !== 'type' && (!node.specifiers.length || node.specifiers.some(item => item.importKind !== 'type'))
  )
}
const property = node => (node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? node.value : undefined)
function assertPureSession(code) {
  const ast = parse(code, 'json-editor-session.ts')
  for (const entry of runtimeImports(ast))
    assert.doesNotMatch(entry.source.value, /react|codemirror|browser|view|workspace|remote|graph-editor/, 'JSON_EDITOR_SESSION_DEPENDENCY')
  const exported = ast.body
    .filter(node => node.type === 'ExportNamedDeclaration')
    .flatMap(node => {
      const declaration = node.declaration
      if (declaration?.type === 'FunctionDeclaration') return [declaration.id.name]
      if (declaration?.type === 'VariableDeclaration')
        return declaration.declarations.filter(item => ['ArrowFunctionExpression', 'FunctionExpression'].includes(item.init?.type)).map(item => item.id.name)
      return []
    })
  for (const name of ['initialJsonBuffer', 'formatJsonBuffer', 'canSyncJsonBuffer'])
    assert.ok(exported.includes(name), `JSON_EDITOR_SESSION_CONTRACT_MISSING: ${name}`)
  walk(ast, node => {
    if (node.type === 'Identifier')
      assert.ok(
        ![
          'document',
          'window',
          'EditorView',
          'EditorState',
          'HTMLElement',
          'IntersectionObserver',
          'MutationObserver',
          'ResizeObserver',
          'fetch',
          'BlueprintWorkspace',
          'GraphEditor'
        ].includes(node.name),
        `JSON_EDITOR_SESSION_EFFECT: ${node.name}`
      )
    if (node.type === 'MemberExpression')
      assert.ok(
        !['dispatch', 'saveDefinition', 'setItem', 'patchNode'].includes(property(node.property)),
        `JSON_EDITOR_SESSION_MUTATION: ${property(node.property)}`
      )
  })
}
function assertPureView(code) {
  const ast = parse(code, 'json-editor-view.tsx')
  for (const entry of runtimeImports(ast))
    assert.doesNotMatch(entry.source.value, /codemirror|json-editor-browser|workspace|remote|graph-editor/, 'JSON_EDITOR_VIEW_ADAPTER_DEPENDENCY')
  walk(ast, node => {
    if (node.type === 'Identifier')
      assert.ok(
        ![
          'document',
          'window',
          'EditorView',
          'EditorState',
          'IntersectionObserver',
          'MutationObserver',
          'ResizeObserver',
          'localStorage',
          'fetch',
          'BlueprintWorkspace',
          'GraphEditor'
        ].includes(node.name),
        `JSON_EDITOR_VIEW_EFFECT: ${node.name}`
      )
    if (node.type === 'MemberExpression')
      assert.ok(
        ![
          'useEffect',
          'useLayoutEffect',
          'focus',
          'contains',
          'getBoundingClientRect',
          'querySelector',
          'querySelectorAll',
          'dispatch',
          'destroy',
          'saveDefinition',
          'startRun',
          'patchNode',
          'updateNode',
          'addNode',
          'removeNode',
          'setItem'
        ].includes(property(node.property)),
        `JSON_EDITOR_VIEW_MUTATION: ${property(node.property)}`
      )
  })
  const exported = ast.body.find(
    node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id.name === 'jsonEditorView'
  )
  assert.ok(exported, 'JSON_EDITOR_VIEW_EXPORT_MISSING')
  let markup = false
  walk(exported.declaration.body, node => {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') markup = true
  })
  assert.ok(markup, 'JSON_EDITOR_VIEW_MARKUP_MISSING')
}
function assertRuntimeCall(code, file, dependency) {
  const ast = parse(code, file)
  const imported = runtimeImports(ast).find(node => node.source.value === dependency)
  assert.ok(imported, `JSON_EDITOR_PRODUCTION_WIRING_MISSING: ${file} -> ${dependency}`)
  const calls = new Set()
  const scope =
    file === 'json-editor.ts'
      ? ast.body.find(
          node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id.name === 'JsonEditor'
        )?.declaration.body
      : ast
  assert.ok(scope, 'JSON_EDITOR_PUBLIC_ENTRY_MISSING')
  walk(scope, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.add(node.callee.name)
  })
  assert.ok(
    imported.specifiers.some(item => item.importKind !== 'type' && calls.has(item.local.name)),
    `JSON_EDITOR_IMPORTED_BUT_UNUSED: ${dependency}`
  )
}
function removeCalls(code, file, dependency) {
  const ast = parse(code, file)
  const imported = runtimeImports(ast).find(node => node.source.value === dependency)
  assert.ok(imported)
  const names = new Set(imported.specifiers.map(item => item.local.name)),
    ranges = []
  walk(ast, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && names.has(node.callee.name)) ranges.push([node.callee.start, node.callee.end])
  })
  let mutated = code
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) mutated = mutated.slice(0, start) + 'unusedBoundary' + mutated.slice(end)
  return mutated
}

test('production JSON editor actually routes through pure buffer session, browser integration and TSX markup', () => {
  const session = source('features/authoring/logic/inspector/json-editor-session.ts'),
    browser = source('features/authoring/ui/inspector/json-editor-browser.ts'),
    view = source('features/authoring/ui/inspector/json-editor-view.tsx'),
    adapter = source('features/authoring/logic/inspector/json-editor.ts')
  assertPureSession(session)
  assertPureView(view)
  assertRuntimeCall(adapter, 'json-editor.ts', '../../ui/inspector/json-editor-browser.ts')
  assertRuntimeCall(adapter, 'json-editor.ts', '../../ui/inspector/json-editor-view.tsx')
  assertRuntimeCall(browser, 'json-editor-browser.ts', '../../logic/inspector/json-editor-session.ts')
})

test('actual view and session mutation calibration rejects DOM, CodeMirror, Host and graph effects', () => {
  const view = source('features/authoring/ui/inspector/json-editor-view.tsx'),
    session = source('features/authoring/logic/inspector/json-editor-session.ts')
  for (const bad of [
    'export function bad(){document.activeElement?.focus()}',
    'export function bad(){return new EditorView({})}',
    'export function bad(props){props.editor.dispatch({})}',
    'export function bad(props){props.host.saveDefinition("target", "body", null)}',
    'export function bad(props){props.graph.updateNode("node", {})}'
  ])
    assert.throws(() => assertPureView(`${view}\n${bad}`), /JSON_EDITOR_VIEW_(EFFECT|MUTATION)/)
  assert.throws(() => assertPureView('export function jsonEditorView(){return null}'), /JSON_EDITOR_VIEW_MARKUP_MISSING/)
  assert.throws(() => assertPureSession(`${session}\nimport {EditorState} from '@codemirror/state'`), /JSON_EDITOR_SESSION_DEPENDENCY/)
  assert.throws(() => assertPureSession(`${session}\nexport function bad(){return window.location}`), /JSON_EDITOR_SESSION_EFFECT/)
  assert.throws(() => assertPureSession('export {}'), /JSON_EDITOR_SESSION_CONTRACT_MISSING/)
})

test('import-only facade and browser/session placeholders cannot pass as extraction', () => {
  for (const [file, dependency] of [
    ['json-editor.ts', '../../ui/inspector/json-editor-browser.ts'],
    ['json-editor.ts', '../../ui/inspector/json-editor-view.tsx'],
    ['json-editor-browser.ts', '../../logic/inspector/json-editor-session.ts']
  ])
    assert.throws(
      () =>
        assertRuntimeCall(
          removeCalls(
            source(file === 'json-editor.ts' ? 'features/authoring/logic/inspector/json-editor.ts' : 'features/authoring/ui/inspector/json-editor-browser.ts'),
            file,
            dependency
          ),
          file,
          dependency
        ),
      /JSON_EDITOR_IMPORTED_BUT_UNUSED/
    )
})

test('legacy JSON editor preserves raw default buffer, hidden form value, status and public browser exports', async () => {
  const { default: React } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const api = await import('../../src/client/features/authoring/logic/inspector/json-editor.ts')
  const html = renderToStaticMarkup(
    React.createElement(api.JsonEditor, {
      defaultValue: ' {raw / 中文} ',
      name: 'payload',
      label: 'Raw JSON',
      t: key => key,
      onChange: () => assert.fail('SSR must not emit change'),
      onBlur: () => assert.fail('SSR must not commit')
    })
  )
  assert.match(html, /role="group"/)
  assert.match(html, /aria-label="Raw JSON"/)
  assert.match(html, /name="payload" value=" \{raw \/ 中文\} "/)
  assert.match(html, /data-bp-json-valid="true"/)
  assert.match(html, /disabled=""[^>]*data-bp-action="format-json"|data-bp-action="format-json"[^>]*disabled=""/)
  assert.ok(Array.isArray(api.jsonEditorKeymap))
  assert.equal(typeof api.formatJson, 'function')
  source('features/authoring/ui/inspector/json-editor-browser.ts')
  const browser = await import('../../src/client/features/authoring/ui/inspector/json-editor-browser.ts')
  assert.equal(api.jsonEditorKeymap, browser.jsonEditorKeymap)
  assert.equal(api.formatJson, browser.formatJson)
})

test('actual pure session distinguishes untouched drafts, formatting and external synchronization', async () => {
  source('features/authoring/logic/inspector/json-editor-session.ts')
  const session = await import('../../src/client/features/authoring/logic/inspector/json-editor-session.ts')
  assert.equal(session.initialJsonBuffer('', 'fallback'), '')
  assert.equal(session.initialJsonBuffer(undefined, ' raw '), ' raw ')
  assert.deepEqual(session.formatJsonBuffer('{raw}', false, false), { accepted: false, text: '{raw}' })
  for (const [composing, readOnly] of [
    [true, false],
    [false, true]
  ])
    assert.deepEqual(session.formatJsonBuffer('{"value":0}', composing, readOnly), { accepted: false, text: '{"value":0}' })
  assert.deepEqual(session.formatJsonBuffer('{"value":0}', false, false), { accepted: true, text: '{\n  "value": 0\n}' })
  assert.equal(session.canSyncJsonBuffer('old', undefined, false), false)
  assert.equal(session.canSyncJsonBuffer('old', 'new', true), false)
  assert.equal(session.canSyncJsonBuffer('old', 'old', false), false)
  assert.equal(session.canSyncJsonBuffer('old', 'new', false), true)
})

test('typed wrapper forwards draft and commit requests while the actual Inspector rejects malformed graph changes', async () => {
  const { JsonEditorView } = await import('../../src/client/features/authoring/logic/inspector/json-editor.ts')
  const { BlueprintWorkspace } = await import('../../src/client/features/authoring/logic/workspace/workspace-controller.ts')
  const { InspectorSession } = await import('../../src/client/features/authoring/ui/inspector/inspector-composition.tsx')
  const workspace = new BlueprintWorkspace(undefined)
  workspace.newDraft('JSON owner')
  workspace.editor.addNode({ id: 'node', kind: 'input', label: 'Input', x: 0, y: 0, inputs: {}, outputs: {} })
  const session = new InspectorSession(workspace.editor, 'node')
  const state = { binding: workspace.getSnapshot().binding, nodeId: 'node', field: 'outputs', buffer: '{}', disabled: false, notice: null }
  const intents = []
  const onIntent = intent => {
    intents.push(intent)
    if (intent.type === 'json-buffer-change') session.setJson('outputs', intent.text)
    if (intent.type === 'json-commit') session.applyJson('outputs')
  }
  const element = JsonEditorView({ state, onIntent, label: 'JSON', t: key => key })
  const before = workspace.editor.exportDefinition()
  element.props.onChange('{raw / 中文}')
  assert.deepEqual(intents, [{ type: 'json-buffer-change', binding: state.binding, nodeId: 'node', field: 'outputs', text: '{raw / 中文}' }])
  element.props.onBlur('{raw / 中文}')
  assert.deepEqual(intents[1], { type: 'json-commit', binding: state.binding, nodeId: 'node', field: 'outputs' })
  assert.deepEqual(workspace.editor.exportDefinition(), before, 'owner parser rejects malformed patch')
  assert.equal(session.getSnapshot().json.outputs, '{raw / 中文}', 'invalid authored buffer is retained')
  assert.ok(session.getSnapshot().notice)
  assert.equal(JSON.stringify(session.getSnapshot().notice).includes('raw / 中文'), false, 'diagnostic cannot expose raw buffer')
  workspace.editor.undo()
  assert.equal(workspace.editor.nodes.length, 0, 'invalid commit cannot add an undo transaction after node creation')
  workspace.editor.redo()
  element.props.onChange('{"result":"string"}')
  element.props.onBlur('{"result":"string"}')
  assert.deepEqual(workspace.editor.nodes[0].outputs, { result: 'string' })
  const disabled = JsonEditorView({
    state: { ...state, disabled: true },
    onIntent: () => assert.fail('disabled wrapper emitted intent'),
    label: 'JSON',
    t: key => key
  })
  disabled.props.onChange('{}')
  disabled.props.onBlur('{}')
})
