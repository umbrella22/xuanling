import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
function sourceCopy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-modularization-structure-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
for (const boundary of ['resources', 'canvas', 'documents']) {
  test(`${boundary} structural result identifies actual production declarations and wiring`, () => {
    const result = checkModularization({ boundary })
    assert.equal(result.code, result.ok ? 'BOUNDARY_EXTRACTED' : 'BOUNDARY_STILL_CENTRALIZED', JSON.stringify(result))
    assert.ok(result.evidence.length)
    for (const entry of result.evidence) {
      assert.ok(existsSync(join(plugin, entry.path)))
      assert.ok(entry.line > 0 && entry.line <= readFileSync(join(plugin, entry.path), 'utf8').split('\n').length)
      assert.ok(entry.symbol)
    }
    if (!result.ok) {
      const path = boundary === 'documents' ? 'src/index.ts' : 'src/client/panel.ts'
      assert.ok(
        result.evidence.every(entry => entry.path === path),
        'centralization must locate the actual existing owner'
      )
      if (boundary === 'documents') {
        assert.ok(result.evidence.some(entry => entry.symbol === 'hostProbe' && entry.calls.at(-1) === 'this.loadConfigured'))
        assert.ok(result.evidence.some(entry => entry.symbol === 'startRun' && entry.calls.includes('startConfiguredRun')))
      }
    }
  })

  test(`${boundary} parse and missing-import failures cannot masquerade as expected structural red`, () => {
    sourceCopy(root => {
      const path = join(root, boundary === 'documents' ? 'src/index.ts' : 'src/client/panel.ts')
      const source = readFileSync(path, 'utf8')
      writeFileSync(path, `const = invalid syntax\n${source}`)
      assert.equal(checkModularization({ root, boundary }).code, 'SOURCE_PARSE_ERROR')
      writeFileSync(path, `import './missing-modularization-source.ts'\n${source}`)
      assert.equal(checkModularization({ root, boundary }).code, 'SOURCE_UNAVAILABLE')
      writeFileSync(path, `import 'missing-modularization-package'\n${source}`)
      assert.equal(checkModularization({ root, boundary }).code, 'IMPORT_UNAVAILABLE')
    })
  })

  test(`${boundary} empty target files cannot substitute for production extraction`, () => {
    sourceCopy(root => {
      const paths =
        boundary === 'resources'
          ? ['src/client/resource-library-model.ts', 'src/client/command-facts.ts']
          : boundary === 'canvas'
            ? ['src/client/canvas-renderers.ts']
            : ['src/service/document-library.ts']
      for (const relative of paths) {
        const path = join(root, relative)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, 'export {}\n')
      }
      const result = checkModularization({ root, boundary })
      assert.equal(result.ok, false, 'empty modules must never produce an extracted boundary')
      // Before extraction these files are unreferenced and centralization is
      // unchanged; after real extraction their missing bindings reject wiring.
      assert.ok(['BOUNDARY_STILL_CENTRALIZED', 'UNRESOLVED_BINDING', 'BOUNDARY_IMPLEMENTATION_INVALID'].includes(result.code), JSON.stringify(result))
    })
  })
}
