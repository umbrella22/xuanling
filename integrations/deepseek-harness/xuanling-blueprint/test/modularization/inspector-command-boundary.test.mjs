import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'
import { parseAst } from 'vite/rolldown/parseAst'
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function copy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-inspector-command-boundary-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
function walk(value, visit) {
  if (!value || typeof value !== 'object') return
  if (typeof value.type === 'string') visit(value)
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach(item => walk(item, visit))
    else if (child && typeof child === 'object') walk(child, visit)
  }
}
const check = root => checkModularization({ root, boundary: 'inspector' })
function mutate(relative, change, expected) {
  copy(root => {
    const path = join(root, relative),
      actual = readFileSync(path, 'utf8')
    writeFileSync(path, change(actual))
    const result = check(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, expected, JSON.stringify(result))
  })
}
test('Inspector source boundary resolves actual facade, projection, view and guarded command adapter', () => {
  const result = check(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.code, 'BOUNDARY_EXTRACTED')
  assert.deepEqual(check(plugin), result, 'evidence must be deterministic')
  for (const file of [
    'features/authoring/ui/inspector/inspector-composition.tsx',
    'features/authoring/presenters/inspector-presenter.ts',
    'features/authoring/ui/inspector/inspector-view.tsx',
    'features/authoring/logic/inspector/inspector-command-adapter.ts'
  ])
    assert.ok(
      result.evidence.some(entry => entry.path === `src/client/${file}`),
      `${file} actual owner missing`
    )
  for (const entry of result.evidence) {
    const lines = readFileSync(join(plugin, entry.path), 'utf8').split('\n')
    assert.ok(entry.line > 0 && entry.line <= lines.length)
  }
})

test('actual inspector view rejects runtime adapter dependencies, DOM, Host and direct graph mutations', () => {
  for (const [bad, expected] of [
    ['\nimport { InspectorSession } from "../../logic/inspector/inspector-session.ts"', 'INSPECTOR_VIEW_ADAPTER_DEPENDENCY'],
    ['\nexport function bad(){return document.title}', 'INSPECTOR_DIRECT_EFFECT'],
    ['\nexport function bad(props){props.host.saveDefinition("target","raw",null)}', 'INSPECTOR_DIRECT_MUTATION'],
    ['\nexport function bad(props){props.editor.updateNode("node",{})}', 'INSPECTOR_DIRECT_MUTATION']
  ])
    mutate('src/client/features/authoring/ui/inspector/inspector-view.tsx', actual => actual + bad, expected)
})

test('pure command and presenter owners reject actual framework or graph side effects', () => {
  for (const file of ['features/authoring/logic/inspector/inspector-commands.ts', 'features/authoring/presenters/inspector-presenter.ts']) {
    mutate(`src/client/${file}`, actual => `${actual}\nimport React from 'react'`, 'INSPECTOR_PURE_DEPENDENCY')
    mutate(`src/client/${file}`, actual => `${actual}\nexport function bad(editor){editor.updateNode('node',{})}`, 'INSPECTOR_DIRECT_MUTATION')
  }
})

test('actual facade imports without its adapter call cannot masquerade as typed dispatch extraction', () => {
  mutate(
    'src/client/features/authoring/ui/inspector/inspector-composition.tsx',
    actual => {
      const ast = parseAst(actual, { lang: 'ts', sourceType: 'module' })
      const imported = ast.body.find(
        node => node.type === 'ImportDeclaration' && node.source.value === '../../logic/inspector/inspector-command-adapter.ts' && node.importKind !== 'type'
      )
      assert.ok(imported, 'INSPECTOR_PRODUCTION_WIRING_MISSING')
      const names = new Set(imported.specifiers.map(item => item.local.name)),
        ranges = []
      walk(ast, node => {
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && names.has(node.callee.name))
          ranges.push([node.callee.start, node.callee.end])
      })
      assert.ok(ranges.length)
      let changed = actual
      for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) changed = changed.slice(0, start) + 'unusedDispatch' + changed.slice(end)
      return changed
    },
    'INSPECTOR_PRODUCTION_WIRING_MISSING'
  )
})

test('null view, empty projector and no-dispatch adapter stubs are rejected by their contracts', () => {
  mutate(
    'src/client/features/authoring/ui/inspector/inspector-view.tsx',
    () => 'export function inspectorView(model,t,onIntent){return null}',
    'INSPECTOR_VIEW_CONTRACT_MISSING'
  )
  mutate(
    'src/client/features/authoring/presenters/inspector-presenter.ts',
    () => 'export function projectInspector(){return {}}',
    'INSPECTOR_PROJECTION_CONTRACT_MISSING'
  )
  mutate(
    'src/client/features/authoring/logic/inspector/inspector-command-adapter.ts',
    () => 'export function dispatchInspectorIntent(){return {ok:true}}',
    'INSPECTOR_COMMAND_DISPATCH_MISSING'
  )
})

test('parse and missing-import errors cannot be reported as the intended Inspector structural red', () => {
  mutate('src/client/features/authoring/ui/inspector/inspector-composition.tsx', actual => `const = invalid syntax\n${actual}`, 'SOURCE_PARSE_ERROR')
  mutate(
    'src/client/features/authoring/ui/inspector/inspector-composition.tsx',
    actual => `import './missing-inspector-source.ts'\n${actual}`,
    'SOURCE_UNAVAILABLE'
  )
})

test('reintroduced inline renderer dispatch and non-emitting markup are exact structural reds', () => {
  mutate(
    'src/client/features/authoring/ui/inspector/inspector-composition.tsx',
    actual => {
      const ast = parseAst(actual, { lang: 'ts', sourceType: 'module' })
      const renderer = ast.body.find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'renderNodeInspector').declaration
      return actual.slice(0, renderer.body.start + 1) + '\nsession.patch({});\n' + actual.slice(renderer.body.start + 1)
    },
    'INSPECTOR_DISPATCH_STILL_CENTRALIZED'
  )
  mutate(
    'src/client/features/authoring/ui/inspector/inspector-view.tsx',
    actual => {
      const ast = parseAst(actual, { lang: 'tsx', sourceType: 'module' }),
        ranges = []
      walk(ast, node => {
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'onIntent')
          ranges.push([node.callee.start, node.callee.end])
      })
      assert.ok(ranges.length)
      let changed = actual
      for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) changed = changed.slice(0, start) + 'unusedIntent' + changed.slice(end)
      return changed
    },
    'INSPECTOR_VIEW_CONTRACT_MISSING'
  )
})
