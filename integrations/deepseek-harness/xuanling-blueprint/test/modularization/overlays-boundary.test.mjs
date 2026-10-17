import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'vite/rolldown/parseAst'

const client = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/client')
function source(name) {
  const path = resolve(client, name)
  assert.ok(existsSync(path), `OVERLAY_BOUNDARY_MODULE_MISSING: ${name}; production InteractionOverlay remains centralized`)
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
function property(node) {
  return node?.type === 'Identifier' ? node.name : node?.type === 'Literal' ? node.value : undefined
}
function assertSessionBoundary(code) {
  const ast = parse(code, 'overlay-session.ts')
  for (const entry of runtimeImports(ast))
    assert.doesNotMatch(entry.source.value, /react|view|browser|remote|workspace|graph-editor/, 'OVERLAY_SESSION_FRAMEWORK_DEPENDENCY')
  walk(ast, node => {
    if (node.type === 'Identifier')
      assert.ok(
        !['document', 'window', 'File', 'FileReader', 'Blob', 'HTMLElement', 'ResizeObserver', 'MutationObserver', 'fetch'].includes(node.name),
        `OVERLAY_SESSION_EFFECT: ${node.name}`
      )
  })
}
function assertViewBoundary(code) {
  const ast = parse(code, 'interaction-overlays-view.tsx')
  for (const entry of runtimeImports(ast))
    assert.doesNotMatch(entry.source.value, /overlay-browser-effects|workspace|remote|graph-editor/, 'OVERLAY_VIEW_ADAPTER_DEPENDENCY')
  walk(ast, node => {
    if (node.type === 'Identifier')
      assert.ok(
        ![
          'document',
          'window',
          'File',
          'FileReader',
          'Blob',
          'localStorage',
          'ResizeObserver',
          'MutationObserver',
          'BlueprintWorkspace',
          'GraphEditor',
          'fetch'
        ].includes(node.name),
        `OVERLAY_VIEW_EFFECT: ${node.name}`
      )
    if (node.type === 'MemberExpression')
      assert.ok(
        ![
          'useEffect',
          'useLayoutEffect',
          'focus',
          'getBoundingClientRect',
          'querySelector',
          'querySelectorAll',
          'arrayBuffer',
          'files',
          'saveDefinition',
          'loadDefinition',
          'startRun',
          'importDefinition',
          'dispatch',
          'patchNode',
          'updateNode',
          'addNode',
          'removeNode',
          'setItem',
          'onSelect'
        ].includes(property(node.property)),
        `OVERLAY_VIEW_MUTATION: ${property(node.property)}`
      )
  })
  const exported = ast.body.find(
    node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id.name === 'interactionOverlaysView'
  )
  assert.ok(exported, 'OVERLAY_VIEW_EXPORT_MISSING')
  let markup = false
  walk(exported.declaration.body, node => {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') markup = true
  })
  assert.ok(markup, 'OVERLAY_VIEW_MARKUP_MISSING')
}
function assertAdapterWiring(code) {
  const ast = parse(code, 'interaction-overlays.ts')
  const entries = runtimeImports(ast)
  const calls = new Set()
  walk(ast, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.add(node.callee.name)
  })
  for (const dependency of [
    '../../logic/overlays/overlay-session.ts',
    '../../../../adapters/browser/overlay-browser-effects.ts',
    './interaction-overlays-view.tsx'
  ]) {
    const imported = entries.find(node => node.source.value === dependency)
    assert.ok(imported, `OVERLAY_PRODUCTION_WIRING_MISSING: ${dependency}`)
    assert.ok(
      imported.specifiers.some(item => item.importKind !== 'type' && calls.has(item.local.name)),
      `OVERLAY_IMPORTED_BUT_UNUSED: ${dependency}`
    )
  }
  assert.ok(
    ast.body.some(
      node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id.name === 'InteractionOverlay'
    ),
    'OVERLAY_COMPAT_EXPORT_MISSING'
  )
}

test('production InteractionOverlay delegates to pure session, browser effects and actual TSX markup', () => {
  const session = source('features/authoring/logic/overlays/overlay-session.ts'),
    effects = source('adapters/browser/overlay-browser-effects.ts'),
    view = source('features/authoring/ui/overlays/interaction-overlays-view.tsx'),
    adapter = source('features/authoring/ui/overlays/interaction-overlays.tsx')
  assertSessionBoundary(session)
  assertViewBoundary(view)
  assertAdapterWiring(adapter)
  const ast = parse(effects, 'overlay-browser-effects.ts')
  assert.ok(
    ast.body.some(node => node.type === 'ExportNamedDeclaration' && node.declaration),
    'OVERLAY_EFFECTS_EMPTY'
  )
})

test('view oracle calibrates DOM, File, Host and graph effects on the actual production view', () => {
  const actual = source('features/authoring/ui/overlays/interaction-overlays-view.tsx')
  for (const bad of [
    'export function bad(){document.activeElement?.focus()}',
    'export function bad(){return new File([], "payload")}',
    'export function bad(props){return props.file.arrayBuffer()}',
    'export function bad(props){return props.host.importDefinition("target", "body")}',
    'export function bad(props){props.editor.updateNode("node", {})}',
    'export function bad(props){props.moreActions[0].onSelect()}'
  ])
    assert.throws(() => assertViewBoundary(`${actual}\n${bad}`), /OVERLAY_VIEW_(EFFECT|MUTATION)/)
  assert.throws(() => assertViewBoundary('export function interactionOverlaysView(){return null}'), /OVERLAY_VIEW_MARKUP_MISSING/)
  assert.throws(() => assertSessionBoundary('export function bad(){return window.location}'), /OVERLAY_SESSION_EFFECT/)
})

test('imported but uncalled view cannot masquerade as production extraction', () => {
  const actual = source('features/authoring/ui/overlays/interaction-overlays.tsx')
  const ast = parse(actual, 'interaction-overlays.ts')
  const imported = runtimeImports(ast).find(node => node.source.value === './interaction-overlays-view.tsx')
  assert.ok(imported, 'OVERLAY_PRODUCTION_WIRING_MISSING')
  const names = new Set(imported.specifiers.map(item => item.local.name)),
    ranges = []
  walk(ast, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && names.has(node.callee.name)) ranges.push([node.callee.start, node.callee.end])
  })
  let mutated = actual
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) mutated = mutated.slice(0, start) + 'unusedMarkup' + mutated.slice(end)
  assert.throws(() => assertAdapterWiring(mutated), /OVERLAY_IMPORTED_BUT_UNUSED/)
})

test('legacy overlay keeps injected React seat, raw rename and dialog/menu semantics without render side effects', async () => {
  const { default: React } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { InteractionOverlay, archiveBase64, archiveBytes } = await import('../../src/client/features/authoring/ui/overlays/interaction-overlays.tsx')
  const { en } = await import('../../src/client/shared/i18n/locales.ts')
  let renders = 0
  const seat = {
    ...React,
    createElement: (...args) => {
      renders++
      return React.createElement(...args)
    }
  }
  const forbidden = () => assert.fail('render cannot dispatch browser or application action')
  const props = {
    React: seat,
    root: { current: null },
    t: key => en[key],
    commands: [],
    importTargets: [],
    onCommand: forbidden,
    onAdd: forbidden,
    onRename: forbidden,
    onClose: forbidden,
    onImportFile: forbidden
  }
  const html = renderToStaticMarkup(
    React.createElement(InteractionOverlay, {
      ...props,
      overlay: { kind: 'rename', screen: { x: 8, y: 12 }, targetId: 'node', group: false, value: ' exact / 中文 ' }
    })
  )
  assert.ok(renders > 0, 'OVERLAY_INJECTED_REACT_SEAT_UNUSED')
  assert.match(html, /role="dialog"/)
  assert.match(html, /data-bp-overlay="rename"/)
  assert.match(html, /value=" exact \/ 中文 "/)
  assert.match(html, /data-bp-action="rename-apply"/)
  const menu = renderToStaticMarkup(React.createElement(InteractionOverlay, { ...props, overlay: { kind: 'more-menu', screen: { x: 0, y: 0 } } }))
  assert.match(menu, /role="menu"/)
  const binary = new Uint8Array([0, 255, 1, 128, 32])
  assert.deepEqual(archiveBytes(archiveBase64(binary)), binary, 'legacy archive facade retains exact binary payload')
})
