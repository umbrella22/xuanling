import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = resolve(import.meta.dirname, '../..')

function sourceCopy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-source-graph-boundary-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('W3.1 canonical client source graph resolves all modules and local edges', () => {
  const result = checkModularization({ root: plugin, boundary: 'source-graph' })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.code, 'BOUNDARY_EXTRACTED', JSON.stringify(result))
  assert.equal(result.evidence.length, 1)
  assert.match(result.evidence[0].symbol, /^canonical source graph \(\d+ modules, \d+ local edges\)$/)
})

test('reintroduced direct client root implementation is a legacy path red', () => {
  sourceCopy(root => {
    writeFileSync(join(root, 'src/client/panel.tsx'), 'export const legacyPanel = null\n')
    const result = checkModularization({ root, boundary: 'source-graph' })
    assert.equal(result.code, 'LEGACY_PATH_PRESENT', JSON.stringify(result))
    assert.ok(result.evidence.some(entry => entry.path === 'src/client/panel.tsx'))
  })
})

test('stale flat imports, missing sources, missing packages and parse failures stay distinct', () => {
  sourceCopy(root => {
    const index = join(root, 'src/client/index.ts')
    const source = readFileSync(index, 'utf8')

    writeFileSync(index, `import './panel.tsx'\n${source}`)
    assert.equal(checkModularization({ root, boundary: 'source-graph' }).code, 'SOURCE_PATH_STALE')

    writeFileSync(index, `import './features/missing-source.ts'\n${source}`)
    assert.equal(checkModularization({ root, boundary: 'source-graph' }).code, 'SOURCE_UNAVAILABLE')

    writeFileSync(index, `import 'missing-source-graph-package'\n${source}`)
    assert.equal(checkModularization({ root, boundary: 'source-graph' }).code, 'IMPORT_UNAVAILABLE')

    writeFileSync(index, `const = invalid syntax\n${source}`)
    assert.equal(checkModularization({ root, boundary: 'source-graph' }).code, 'SOURCE_PARSE_ERROR')
  })
})

test('runtime client import cycles are reported separately from source failures', () => {
  sourceCopy(root => {
    const a = join(root, 'src/client/shared/source-graph-cycle-a.ts')
    const b = join(root, 'src/client/shared/source-graph-cycle-b.ts')
    writeFileSync(a, "import './source-graph-cycle-b.ts'\nexport const cycleA = true\n")
    writeFileSync(b, "import './source-graph-cycle-a.ts'\nexport const cycleB = true\n")
    const result = checkModularization({ root, boundary: 'source-graph' })
    assert.equal(result.code, 'IMPORT_CYCLE', JSON.stringify(result))
  })
})
