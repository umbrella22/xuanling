import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'vite/rolldown/parseAst'
const client = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/client')
function source(name) {
  const path = resolve(client, name)
  assert.ok(existsSync(path), `INSPECTOR_VIEW_BOUNDARY_MISSING: ${name}; renderNodeInspector still mixes session and markup`)
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
function assertPure(code, file) {
  const ast = parse(code, file)
  for (const entry of runtimeImports(ast))
    assert.doesNotMatch(
      entry.source.value,
      /inspector-session|inspector\.ts$|graph-editor|workspace|remote|browser/,
      `INSPECTOR_VIEW_ADAPTER_DEPENDENCY: ${file}`
    )
  if (file === 'inspector-presenter.ts')
    for (const entry of runtimeImports(ast))
      assert.doesNotMatch(entry.source.value, /^(react|react-dom|@codemirror|@xyflow)/, 'INSPECTOR_PRESENTER_FRAMEWORK_DEPENDENCY')
  walk(ast, node => {
    if (node.type === 'Identifier')
      assert.ok(
        ![
          'window',
          'document',
          'localStorage',
          'GraphEditor',
          'InspectorSession',
          'BlueprintWorkspace',
          'fetch',
          'ResizeObserver',
          'MutationObserver'
        ].includes(node.name),
        `INSPECTOR_VIEW_EFFECT: ${node.name}`
      )
    if (node.type === 'MemberExpression')
      assert.ok(
        ![
          'useEffect',
          'useState',
          'useRef',
          'useLayoutEffect',
          'useMemo',
          'useSyncExternalStore',
          'saveDefinition',
          'loadDefinition',
          'startRun',
          'dispatch',
          'transaction',
          'updateNode',
          'updateResource',
          'patchPresentation',
          'bindResource',
          'applyJson',
          'setJson',
          'patch',
          'focus',
          'getBoundingClientRect',
          'setItem'
        ].includes(property(node.property)),
        `INSPECTOR_VIEW_MUTATION: ${property(node.property)}`
      )
  })
  return ast
}
function assertView(code) {
  const ast = assertPure(code, 'inspector-view.tsx')
  const exported = ast.body.find(
    node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id.name === 'inspectorView'
  )
  assert.ok(exported, 'INSPECTOR_VIEW_EXPORT_MISSING')
  let markup = false
  walk(exported.declaration.body, node => {
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') markup = true
  })
  assert.ok(markup, 'INSPECTOR_VIEW_MARKUP_MISSING')
  const intent = exported.declaration.params[2]
  let emits = false
  walk(exported.declaration.body, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === intent?.name) emits = true
  })
  assert.ok(emits, 'INSPECTOR_VIEW_INTENT_MISSING')
}
function assertWiring(code) {
  const ast = parse(code, 'inspector-composition.tsx'),
    imports = runtimeImports(ast)
  const renderer = ast.body.find(
    node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration' && node.declaration.id.name === 'renderNodeInspector'
  )
  assert.ok(renderer, 'INSPECTOR_COMPAT_RENDERER_MISSING')
  const calls = new Set()
  walk(renderer.declaration.body, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') calls.add(node.callee.name)
  })
  for (const dependency of ['../../presenters/inspector-presenter.ts', './inspector-view.tsx']) {
    const imported = imports.find(node => node.source.value === dependency)
    assert.ok(imported, `INSPECTOR_VIEW_PRODUCTION_WIRING_MISSING: ${dependency}`)
    assert.ok(
      imported.specifiers.some(item => item.importKind !== 'type' && calls.has(item.local.name)),
      `INSPECTOR_VIEW_IMPORTED_BUT_UNUSED: ${dependency}`
    )
  }
}

test('production Inspector uses a pure display projection and actual TSX intent view', () => {
  const presenter = source('features/authoring/presenters/inspector-presenter.ts'),
    view = source('features/authoring/ui/inspector/inspector-view.tsx')
  assertPure(presenter, 'inspector-presenter.ts')
  assertView(view)
  assertWiring(source('features/authoring/ui/inspector/inspector-composition.tsx'))
})

test('actual presenter and view reject controller, DOM and graph effects; null markup cannot pass', () => {
  for (const file of ['inspector-presenter.ts', 'inspector-view.tsx']) {
    const actual = source(
      file === 'inspector-presenter.ts' ? 'features/authoring/presenters/inspector-presenter.ts' : 'features/authoring/ui/inspector/inspector-view.tsx'
    )
    for (const bad of [
      '\nimport { InspectorSession } from "./inspector-session.ts"',
      '\nexport function bad(){document.activeElement?.focus()}',
      '\nexport function bad(props){props.host.saveDefinition("target","raw",null)}',
      '\nexport function bad(props){props.editor.updateNode("node",{})}',
      '\nexport function bad(props){props.session.applyJson("options")}'
    ])
      assert.throws(() => assertPure(actual + bad, file), /INSPECTOR_VIEW_(ADAPTER_DEPENDENCY|EFFECT|MUTATION)/)
  }
  assert.throws(() => assertView('export function inspectorView(){return null}'), /INSPECTOR_VIEW_MARKUP_MISSING/)
  const actualView = source('features/authoring/ui/inspector/inspector-view.tsx')
  const ast = parse(actualView, 'inspector-view.tsx'),
    ranges = []
  walk(ast, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'onIntent')
      ranges.push([node.callee.start, node.callee.end])
  })
  let noIntent = actualView
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) noIntent = noIntent.slice(0, start) + 'unusedIntent' + noIntent.slice(end)
  assert.throws(() => assertView(noIntent), /INSPECTOR_VIEW_INTENT_MISSING/)
})

test('actual renderer with imported but uncalled presenter or view cannot pass wiring', () => {
  const actual = source('features/authoring/ui/inspector/inspector-composition.tsx'),
    ast = parse(actual, 'inspector-composition.tsx')
  for (const dependency of ['../../presenters/inspector-presenter.ts', './inspector-view.tsx']) {
    const imported = runtimeImports(ast).find(node => node.source.value === dependency)
    assert.ok(imported)
    const names = new Set(imported.specifiers.map(item => item.local.name)),
      ranges = []
    walk(ast, node => {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && names.has(node.callee.name)) ranges.push([node.callee.start, node.callee.end])
    })
    let mutated = actual
    for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) mutated = mutated.slice(0, start) + 'unusedProjection' + mutated.slice(end)
    assert.throws(() => assertWiring(mutated), /INSPECTOR_VIEW_IMPORTED_BUT_UNUSED/)
  }
})

async function fixture() {
  source('features/authoring/presenters/inspector-presenter.ts')
  source('features/authoring/ui/inspector/inspector-view.tsx')
  const { default: React } = await import('react')
  const { GraphEditor } = await import('../../src/client/features/authoring/logic/graph/graph-editor.ts')
  const api = await import('../../src/client/features/authoring/ui/inspector/inspector-composition.tsx')
  const definition = {
    schemaVersion: 1,
    id: 'view',
    name: 'View',
    resources: { skill: { kind: 'skill', path: 'skills/中文.md', privateConfig: { token: 'REF_SECRET_SENTINEL' } } },
    graph: {
      nodes: [{ id: 'node', kind: 'agentTask', inputs: {}, outputs: {}, skillRefs: ['skill'], privateConfig: { token: 'NODE_SECRET_SENTINEL' } }],
      edges: []
    }
  }
  const editor = GraphEditor.fromDefinition(definition)
  const session = new api.InspectorSession(editor, 'node')
  const props = {
    editor,
    node: editor.nodes[0],
    resources: editor.exportDefinition().resources,
    resourceCatalog: [
      {
        id: 'host-agent',
        kind: 'agent',
        source: 'dsh',
        displayName: 'Public Agent',
        availability: 'available',
        provenance: 'builtin',
        rawConfig: { headers: { Authorization: 'CATALOG_SECRET_SENTINEL' } },
        env: 'CATALOG_PRIVATE_ENV'
      }
    ],
    t: key => key
  }
  const render = (overrides = {}) => api.renderNodeInspector({ ...props, ...overrides }, session, session.getSnapshot())
  const elements = tree => {
    if (Array.isArray(tree)) return tree.flatMap(elements)
    if (!React.isValidElement(tree)) return []
    return [tree, ...elements(tree.props.children)]
  }
  const find = (tree, attribute, value) => elements(tree).find(element => element.props[attribute] === value)
  return { React, api, editor, session, props, render, elements, find }
}

test('actual Inspector SSR and model props exclude private catalog/ref/node payloads without losing public controls', async () => {
  const { React, api, editor, session, props, render, elements } = await fixture()
  const { renderToStaticMarkup } = await import('react-dom/server')
  const before = editor.exportDefinition()
  const tree = render()
  const html = renderToStaticMarkup(React.createElement(api.NodeInspector, props))
  for (const secret of ['REF_SECRET_SENTINEL', 'NODE_SECRET_SENTINEL', 'CATALOG_SECRET_SENTINEL', 'CATALOG_PRIVATE_ENV'])
    assert.equal(html.includes(secret), false, secret)
  assert.ok(
    elements(tree).some(element => element.type === 'option' && String(element.props.children).includes('Public Agent')),
    'public catalog label remains available'
  )
  assert.match(html, /data-bp-node-inspector="node"/)
  assert.match(html, /data-bp-json-editor/)
  assert.match(html, /Skill · skill|inspector.skillBindings/)
  const displayProps = elements(tree).map(element =>
    Object.fromEntries(Object.entries(element.props).filter(([key]) => key !== 'children' && !key.startsWith('on')))
  )
  const serialized = JSON.stringify(displayProps)
  for (const secret of ['REF_SECRET_SENTINEL', 'NODE_SECRET_SENTINEL', 'CATALOG_SECRET_SENTINEL', 'CATALOG_PRIVATE_ENV'])
    assert.equal(serialized.includes(secret), false, `markup props leaked ${secret}`)
  assert.equal(
    elements(tree).some(element => ['editor', 'session', 'resourceCatalog', 'host'].some(key => Object.hasOwn(element.props, key))),
    false
  )
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.canUndo, false)
  assert.equal(session.getSnapshot().notice, null)
})

test('actual view handlers keep JSON drafts local until owner validation and route resource identity through adapter', async context => {
  const { editor, session, props, render, find } = await fixture()
  context.after(session.subscribe(() => {}))
  const tree = render()
  const json = find(tree, 'data-bp-json', 'outputs')
  assert.ok(json, 'actual JSON field must be wired')
  json.props.onChange('{PRIVATE_INVALID')
  json.props.onBlur('{PRIVATE_INVALID')
  assert.deepEqual(editor.exportDefinition().graph.nodes[0].outputs, {})
  assert.equal(editor.canUndo, false)
  assert.deepEqual(session.getSnapshot().notice, { key: 'inspector.invalidJsonRetained' })
  json.props.onChange('{" 结果 / port ":" wire type "}')
  json.props.onBlur('{" 结果 / port ":" wire type "}')
  assert.deepEqual(editor.exportDefinition().graph.nodes[0].outputs, { ' 结果 / port ': ' wire type ' })
  const picker = find(render(), 'data-bp-field', 'agentRef')
  assert.ok(picker)
  picker.props.onChange({ currentTarget: { value: 'host:agent:host-agent' } })
  const current = editor.exportDefinition()
  const selected = current.graph.nodes[0].agentRef
  assert.ok(selected)
  assert.deepEqual(current.resources[selected].source, { kind: 'host', id: 'host-agent' })
  assert.equal(JSON.stringify(current.resources[selected]).includes('CATALOG_SECRET_SENTINEL'), false)
  assert.equal(props.resourceCatalog[0].rawConfig.headers.Authorization, 'CATALOG_SECRET_SENTINEL', 'adapter must not mutate caller catalog')
})

test('actual presenter allowlists hostile option/snapshot extras and detaches display data from mutable inputs', async () => {
  const { editor, session } = await fixture()
  const { projectInspector } = await import('../../src/client/features/authoring/presenters/inspector-presenter.ts')
  const snapshot = structuredClone(session.getSnapshot())
  snapshot.privateRaw = { secret: 'SNAPSHOT_PRIVATE_SENTINEL' }
  snapshot.modelRoute.privateRaw = { secret: 'ROUTE_PRIVATE_SENTINEL' }
  snapshot.rows.inputs.push({ id: 1, name: ' exact port ', type: 'string', privateRaw: 'ROW_PRIVATE_SENTINEL' })
  snapshot.notice = { key: 'inspector.editApplied', privateRaw: 'NOTICE_PRIVATE_SENTINEL' }
  const choices = {
    agentRef: [{ key: 'host:agent:host-agent', label: 'Public Agent', checked: false, disabled: false, host: { rawConfig: 'OPTION_PRIVATE_SENTINEL' } }],
    outputSchemaRef: [],
    skillRefs: [],
    toolsetRefs: []
  }
  const input = { node: editor.nodes[0], edges: editor.edges, snapshot, disabled: false, choices }
  const before = JSON.stringify(input)
  const model = projectInspector(input)
  assert.equal(JSON.stringify(input), before, 'projection cannot mutate caller facts')
  for (const secret of [
    'SNAPSHOT_PRIVATE_SENTINEL',
    'ROUTE_PRIVATE_SENTINEL',
    'ROW_PRIVATE_SENTINEL',
    'NOTICE_PRIVATE_SENTINEL',
    'OPTION_PRIVATE_SENTINEL',
    'NODE_SECRET_SENTINEL'
  ])
    assert.equal(JSON.stringify(model).includes(secret), false, secret)
  assert.deepEqual(model.node, { id: 'node', kind: 'agentTask' })
  assert.equal(model.choices.agentRef[0].label, 'Public Agent')
  const stable = JSON.stringify(model)
  snapshot.rows.inputs[0].name = 'changed later'
  snapshot.modelRoute.provider = 'changed later'
  choices.agentRef[0].label = 'changed later'
  assert.equal(JSON.stringify(model), stable, 'later input mutation cannot alter already projected data')
})
