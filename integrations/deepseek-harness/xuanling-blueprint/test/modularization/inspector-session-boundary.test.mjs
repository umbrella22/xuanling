import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { parseAst } from 'vite/rolldown/parseAst'
const client = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/client')
function source(name) {
  const path = resolve(client, name)
  assert.ok(existsSync(path), `INSPECTOR_SESSION_BOUNDARY_MISSING: ${name}; InspectorSession still belongs to the mixed renderer`)
  return readFileSync(path, 'utf8')
}
const parse = (code, file) => parseAst(code, { lang: 'ts', sourceType: 'module' }, file)
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
function assertPureBoundary(code, file) {
  const ast = parse(code, file)
  for (const item of runtimeImports(ast))
    assert.doesNotMatch(
      item.source.value,
      /^(react|react-dom|@codemirror|@xyflow)|inspector\.ts$|styled-controls|json-editor|workspace|remote|graph-editor/,
      `INSPECTOR_PURE_DEPENDENCY: ${file}`
    )
  walk(ast, node => {
    if (node.type === 'Identifier')
      assert.ok(
        ![
          'document',
          'window',
          'localStorage',
          'HTMLElement',
          'MutationObserver',
          'ResizeObserver',
          'IntersectionObserver',
          'fetch',
          'BlueprintWorkspace'
        ].includes(node.name),
        `INSPECTOR_PURE_EFFECT: ${node.name}`
      )
    if (node.type === 'MemberExpression')
      assert.ok(
        ![
          'useEffect',
          'useMemo',
          'useSyncExternalStore',
          'focus',
          'getBoundingClientRect',
          'saveDefinition',
          'startRun',
          'importDefinition',
          'setItem'
        ].includes(property(node.property)),
        `INSPECTOR_PURE_MUTATION: ${property(node.property)}`
      )
  })
  if (file === 'inspector-commands.ts') {
    walk(ast, node => {
      if (node.type === 'MemberExpression')
        assert.ok(
          !['updateNode', 'patchPresentation', 'updateResource', 'transaction', 'addNode', 'removeNode'].includes(property(node.property)),
          `INSPECTOR_COMMAND_GRAPH_MUTATION: ${property(node.property)}`
        )
    })
    const names = ast.body
      .filter(node => node.type === 'ExportNamedDeclaration')
      .flatMap(node => (node.declaration?.type === 'FunctionDeclaration' ? [node.declaration.id.name] : []))
    for (const name of ['parseInspectorJson', 'deriveInspectorPatch', 'referenceMembership', 'hostResourceRefId', 'inspectorOptionDelta'])
      assert.ok(names.includes(name), `INSPECTOR_COMMAND_CONTRACT_MISSING: ${name}`)
  }
  if (file === 'inspector-session.ts') {
    const exported = ast.body.find(
      node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration' && node.declaration.id.name === 'InspectorSession'
    )
    assert.ok(exported, 'INSPECTOR_SESSION_EXPORT_MISSING')
    const members = new Set(exported.declaration.body.body.map(node => property(node.key)))
    for (const name of ['getSnapshot', 'subscribe', 'applyJson', 'patch', 'bindResource', 'applyPorts'])
      assert.ok(members.has(name), `INSPECTOR_SESSION_CONTRACT_MISSING: ${name}`)
  }
  return ast
}
function runtimeCallNames(ast) {
  const calls = new Set()
  walk(ast, node => {
    if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'Identifier') calls.add(node.callee.name)
  })
  return calls
}
function assertFacadeWiring(code) {
  const ast = parse(code, 'inspector-composition.tsx'),
    entries = runtimeImports(ast),
    calls = runtimeCallNames(ast)
  for (const dependency of ['../../logic/inspector/inspector-session.ts', '../../logic/inspector/inspector-commands.ts']) {
    const imported = entries.find(node => node.source.value === dependency)
    assert.ok(imported, `INSPECTOR_PRODUCTION_WIRING_MISSING: ${dependency}`)
    assert.ok(
      imported.specifiers.some(item => item.importKind !== 'type' && calls.has(item.local.name)),
      `INSPECTOR_IMPORTED_BUT_UNUSED: ${dependency}`
    )
  }
  assert.ok(
    !ast.body.some(
      node => node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'ClassDeclaration' && node.declaration.id.name === 'InspectorSession'
    ),
    'INSPECTOR_SESSION_STILL_CENTRALIZED'
  )
}

test('production Inspector actually delegates session and commands without moving renderer in W4.4', () => {
  const session = source('features/authoring/logic/inspector/inspector-session.ts'),
    commands = source('features/authoring/logic/inspector/inspector-commands.ts'),
    facade = source('features/authoring/ui/inspector/inspector-composition.tsx')
  assertPureBoundary(session, 'inspector-session.ts')
  assertPureBoundary(commands, 'inspector-commands.ts')
  assertFacadeWiring(facade)
})

test('actual extracted modules reject renderer, DOM and Host effects', () => {
  for (const file of ['inspector-session.ts', 'inspector-commands.ts']) {
    const actual = source(`features/authoring/logic/inspector/${file}`)
    for (const bad of [
      '\nimport React from "react"',
      '\nexport function bad(){document.activeElement?.focus()}',
      '\nexport function bad(props){props.host.saveDefinition("target", "raw", null)}'
    ])
      assert.throws(() => assertPureBoundary(actual + bad, file), /INSPECTOR_PURE_(DEPENDENCY|EFFECT|MUTATION)/)
  }
  assert.throws(() => assertPureBoundary('export {}', 'inspector-commands.ts'), /INSPECTOR_COMMAND_CONTRACT_MISSING/)
  assert.throws(() => assertPureBoundary('export class InspectorSession {}', 'inspector-session.ts'), /INSPECTOR_SESSION_CONTRACT_MISSING/)
  assert.throws(
    () =>
      assertPureBoundary(
        source('features/authoring/logic/inspector/inspector-commands.ts') + '\nexport function bad(editor){editor.updateNode("node",{})}',
        'inspector-commands.ts'
      ),
    /INSPECTOR_COMMAND_GRAPH_MUTATION/
  )
})

test('actual facade imports without production uses cannot pass the extraction oracle', () => {
  const actual = source('features/authoring/ui/inspector/inspector-composition.tsx'),
    ast = parse(actual, 'inspector-composition.tsx')
  for (const dependency of ['../../logic/inspector/inspector-session.ts', '../../logic/inspector/inspector-commands.ts']) {
    const imported = runtimeImports(ast).find(node => node.source.value === dependency)
    assert.ok(imported, `INSPECTOR_PRODUCTION_WIRING_MISSING: ${dependency}`)
    const names = new Set(imported.specifiers.map(item => item.local.name)),
      ranges = []
    walk(ast, node => {
      if (['CallExpression', 'NewExpression'].includes(node.type) && node.callee.type === 'Identifier' && names.has(node.callee.name))
        ranges.push([node.callee.start, node.callee.end])
    })
    let mutated = actual
    for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) mutated = mutated.slice(0, start) + 'unusedBoundary' + mutated.slice(end)
    assert.throws(() => assertFacadeWiring(mutated), /INSPECTOR_IMPORTED_BUT_UNUSED/)
  }
})

async function fixture() {
  source('features/authoring/logic/inspector/inspector-session.ts')
  source('features/authoring/logic/inspector/inspector-commands.ts')
  const facade = await import('../../src/client/features/authoring/ui/inspector/inspector-composition.tsx')
  const sessionApi = await import('../../src/client/features/authoring/logic/inspector/inspector-session.ts')
  const commands = await import('../../src/client/features/authoring/logic/inspector/inspector-commands.ts')
  const { GraphEditor } = await import('../../src/client/features/authoring/logic/graph/graph-editor.ts')
  const definition = {
    schemaVersion: 1,
    id: 'inspector',
    name: 'Exact / 中文',
    resources: {},
    graph: {
      nodes: [
        { id: 'node', kind: 'agentTask', inputs: { ' 原始 / port ': ' wire type ' }, outputs: {}, agentRef: ' Original / 中文 ', toolAllowlist: [' keep '] }
      ],
      edges: []
    }
  }
  const editor = GraphEditor.fromDefinition(definition)
  const session = new facade.InspectorSession(editor, 'node')
  return { facade, sessionApi, commands, editor, session }
}

test('legacy Inspector exports resolve to the actual extracted implementations', async () => {
  const { facade, sessionApi, commands } = await fixture()
  for (const name of ['InspectorSession', 'applyInspectorPatch']) assert.equal(facade[name], sessionApi[name], `legacy ${name} identity drift`)
  for (const name of ['parseInspectorJson', 'referenceMembership', 'hostResourceRefId'])
    assert.equal(facade[name], commands[name], `legacy ${name} identity drift`)
})

test('pure commands derive semantic patches without mutating source values or normalizing identities', async () => {
  const { commands, editor } = await fixture()
  const node = editor.nodes[0],
    before = structuredClone(node)
  const parsed = commands.parseInspectorJson(node, 'inputs', '{" 原始 / port ":" wire type "}')
  assert.equal(parsed.ok, true)
  const equivalent = commands.deriveInspectorPatch(node, parsed.patch)
  assert.equal(equivalent.ok, true)
  assert.equal(equivalent.changed, false)
  const change = commands.deriveInspectorPatch(node, { agentRef: ' Changed / 中文 ' })
  assert.equal(change.ok, true)
  assert.equal(change.changed, true)
  assert.deepEqual(change.changes, { agentRef: ' Changed / 中文 ' })
  assert.deepEqual(node, before)
  assert.deepEqual(commands.parseInspectorJson(node, 'options', '{"id":"other"}'), { ok: false, issue: 'identity-not-option' })
  assert.deepEqual(commands.parseInspectorJson(node, 'outputs', '{"port":3}'), { ok: false, issue: 'port-types-required' })
  assert.deepEqual(commands.referenceMembership([' Raw ', ' Raw '], 'other', true), [' Raw ', ' Raw ', 'other'])
  const entry = { kind: 'skill', id: ' 原始 / ID ' }
  const expected = `dsh-skill-${Buffer.from(entry.id).toString('hex')}`
  assert.equal(commands.hostResourceRefId(entry, {}), expected)
  assert.equal(commands.hostResourceRefId(entry, { [expected]: { kind: 'schema', path: 'other' } }), `${expected}-2`)
})

test('actual session preserves invalid drafts and applies only edited option deltas over concurrent changes', async context => {
  const { facade, editor, session } = await fixture()
  context.after(session.subscribe(() => {}))
  const original = editor.exportDefinition()
  session.setJson('outputs', '{PRIVATE_RAW_INVALID')
  session.applyJson('outputs')
  assert.deepEqual(editor.exportDefinition(), original)
  assert.equal(editor.canUndo, false)
  assert.equal(session.getSnapshot().json.outputs, '{PRIVATE_RAW_INVALID')
  assert.deepEqual(session.getSnapshot().notice, { key: 'inspector.invalidJsonRetained' })
  const options = JSON.parse(session.getSnapshot().json.options)
  options.agentRef = ' Draft / 中文 '
  session.setJson('options', JSON.stringify(options))
  editor.updateNode('node', { toolAllowlist: [' Concurrent / 中文 '] })
  session.applyJson('options')
  let current = editor.exportDefinition().graph.nodes[0]
  assert.equal(current.agentRef, ' Draft / 中文 ')
  assert.deepEqual(current.toolAllowlist, [' Concurrent / 中文 '])
  assert.deepEqual(session.getSnapshot().notice, { key: 'inspector.editApplied' })
  editor.undo()
  current = editor.exportDefinition().graph.nodes[0]
  assert.equal(current.agentRef, ' Original / 中文 ')
  assert.deepEqual(current.toolAllowlist, [' Concurrent / 中文 '], 'undo draft apply must retain the prior concurrent transaction')
  const before = editor.exportDefinition()
  assert.deepEqual(facade.applyInspectorPatch(editor, 'missing', {}), { ok: false, issue: 'node-unavailable' })
  assert.deepEqual(facade.applyInspectorPatch(editor, 'node', { id: 'overwrite' }), { ok: false, issue: 'node-options-shape' })
  assert.deepEqual(editor.exportDefinition(), before)
})
