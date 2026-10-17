import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const panel = 'src/client/features/authoring/ui/panel/panel-controller.tsx'
const shell = 'src/client/features/authoring/ui/panel/panel-view.tsx'
const check = root => checkModularization({ root, boundary: 'panel-composition' })

function mutate(file, change, expected) {
  const root = mkdtempSync(join(tmpdir(), 'bp-panel-composition-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    const path = join(root, file)
    writeFileSync(path, change(readFileSync(path, 'utf8')))
    const result = check(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, expected, JSON.stringify(result))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('Panel uses the pure TSX composition shell with explicit props', () => {
  const result = check(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(check(plugin), result)
  for (const entry of result.evidence) {
    assert.ok(entry.line > 0)
    assert.ok(entry.line <= readFileSync(join(plugin, entry.path), 'utf8').split('\n').length)
  }
})

test('runtime import, props, and shell purity are required', () => {
  mutate(panel, source => source.replace("import { panelView } from './panel-view.tsx'\n", ''), 'PANEL_COMPOSITION_BOUNDARY_MISSING')
  mutate(panel, source => source.replace('rootProps: {', 'missingRootProps: {'), 'PANEL_COMPOSITION_PROPS_MISSING')
  mutate(panel, source => source.replace('children: [', 'missingChildren: ['), 'PANEL_COMPOSITION_PROPS_MISSING')
  mutate(
    shell,
    source =>
      source.replace(
        'return <div {...props.rootProps}>{props.children}</div>',
        'const current = window; return <div {...props.rootProps}>{props.children}</div>'
      ),
    'PANEL_COMPOSITION_EFFECT_LEAK'
  )
})

test('source failures retain independent classifications', () => {
  mutate(shell, source => `${source}\nexport function {`, 'SOURCE_PARSE_ERROR')
  mutate(panel, source => `${source}\nimport './missing-panel-view.tsx'`, 'SOURCE_UNAVAILABLE')
})
