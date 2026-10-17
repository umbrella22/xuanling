import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = resolve(import.meta.dirname, '../..')
function sourceCopy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-graph-boundary-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('GraphEditor role oracle resolves the extracted state owner and pure roles', () => {
  const result = checkModularization({ boundary: 'graph' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.code, 'BOUNDARY_EXTRACTED', JSON.stringify(result))
  assert.ok(result.evidence.some(entry => entry.symbol === 'GraphEditor'))
  for (const role of ['types.', 'history.', 'commands.', 'layout.', 'clipboard.', 'serialization.'])
    assert.ok(
      result.evidence.some(entry => entry.symbol.startsWith(role)),
      `${role} role missing: ${JSON.stringify(result.evidence)}`
    )
})

test('GraphEditor oracle keeps parse, missing-import and empty-role failures distinct', () => {
  sourceCopy(root => {
    const editor = join(root, 'src/client/features/authoring/logic/graph/graph-editor.ts')
    const source = readFileSync(editor, 'utf8')
    writeFileSync(editor, `const = invalid syntax\n${source}`)
    assert.equal(checkModularization({ root, boundary: 'graph' }).code, 'SOURCE_PARSE_ERROR')
    writeFileSync(editor, `import './missing-graph-role.ts'\n${source}`)
    assert.equal(checkModularization({ root, boundary: 'graph' }).code, 'SOURCE_UNAVAILABLE')
    writeFileSync(editor, source)
    const history = join(root, 'src/client/features/authoring/logic/graph/graph-history.ts')
    writeFileSync(history, 'export {}\n')
    assert.equal(checkModularization({ root, boundary: 'graph' }).code, 'GRAPH_ROLE_EXPORT_MISSING')
    assert.equal(existsSync(history), true)
  })
})
