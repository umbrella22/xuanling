import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = resolve(import.meta.dirname, '../..')
const check = root => checkModularization({ root, boundary: 'roles' })

function sourceCopy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-role-boundary-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('W3.2 canonical role graph resolves pure owners and props-only views', () => {
  const result = check(plugin)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.code, 'BOUNDARY_EXTRACTED', JSON.stringify(result))
  assert.deepEqual(check(plugin), result, 'role evidence must be deterministic')
  for (const file of [
    'features/authoring/logic/resources/resource-library-model.ts',
    'shared/controls/command-facts.ts',
    'features/authoring/presenters/inspector-presenter.ts',
    'features/conversation/presenters/conversation-presenter.ts',
    'features/authoring/ui/panel/panel-view.tsx',
    'features/compact/ui/compact-chrome-view.tsx',
    'shared/controls/styled-controls-view.tsx',
    'shared/controls/tooltip-view.tsx',
    'shared/diagnostics/diagnostics-view.tsx',
    'shared/icons/icons-view.tsx',
    'features/authoring/ui/inspector/inspector-view.tsx',
    'features/conversation/ui/conversation-renderers.tsx'
  ])
    assert.ok(
      result.evidence.some(entry => entry.path === `src/client/${file}`),
      `${file} role missing`
    )
})

test('pure roles reject runtime imports from UI owners with a role-specific error', () => {
  sourceCopy(root => {
    const path = join(root, 'src/client/features/authoring/logic/resources/resource-library-model.ts')
    const source = readFileSync(path, 'utf8')
    writeFileSync(path, `import { panelView as uiPanelView } from '../../ui/panel/panel-view.tsx'\n${source}`)
    const result = check(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'IMPURE_MODEL_DEPENDENCY', JSON.stringify(result))
    assert.ok(result.evidence.some(entry => entry.path.endsWith('resource-library-model.ts')))
  })
})

test('props-only views reject runtime imports from nested controller owners', () => {
  sourceCopy(root => {
    const path = join(root, 'src/client/features/authoring/ui/panel/panel-view.tsx')
    const source = readFileSync(path, 'utf8')
    writeFileSync(path, `import { isEditingTarget } from '../../logic/workspace/workspace-controller.ts'\n${source}`)
    const result = check(root)
    assert.equal(result.ok, false, JSON.stringify(result))
    assert.equal(result.code, 'VIEW_DIRECT_EFFECT', JSON.stringify(result))
    assert.ok(result.evidence.some(entry => entry.path.endsWith('panel-view.tsx')))
  })
})

test('role parse, missing-import and empty-owner failures remain distinct', () => {
  sourceCopy(root => {
    const path = join(root, 'src/client/features/authoring/logic/resources/resource-library-model.ts')
    const source = readFileSync(path, 'utf8')
    writeFileSync(path, `const = invalid syntax\n${source}`)
    assert.equal(check(root).code, 'SOURCE_PARSE_ERROR')
    writeFileSync(path, `import './missing-role-source.ts'\n${source}`)
    assert.equal(check(root).code, 'SOURCE_UNAVAILABLE')
    writeFileSync(path, 'export {}\n')
    assert.equal(check(root).code, 'UNRESOLVED_BINDING')
  })
})
