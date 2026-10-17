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
    // Later waves may only treat this classification as a gate if it is exactly
    // reproducible; unstable evidence would invalidate every extraction gate.
    assert.deepEqual(checkModularization({ boundary }), result, 'structural classification must be exactly reproducible')
    assert.ok(result.evidence.length)
    for (const entry of result.evidence) {
      assert.ok(existsSync(join(plugin, entry.path)))
      assert.ok(entry.line > 0 && entry.line <= readFileSync(join(plugin, entry.path), 'utf8').split('\n').length)
      assert.ok(entry.symbol)
      const sourceLine = readFileSync(join(plugin, entry.path), 'utf8').split('\n')[entry.line - 1] ?? ''
      const anchor = entry.symbol.includes('→') ? entry.symbol.split('→').at(-1).trim() : entry.symbol.split(/\s+/)[0]
      assert.match(
        sourceLine,
        new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
        `evidence line ${entry.path}:${entry.line} must contain ${anchor}`
      )
    }
    if (!result.ok) {
      const path = boundary === 'documents' ? 'src/index.ts' : 'src/client/features/authoring/ui/panel/panel-composition.tsx'
      assert.ok(
        result.evidence.every(entry => entry.path === path),
        'centralization must locate the actual existing owner'
      )
      // O-01/O-02 red must cite the centralized implementation locations plus
      // the production wiring resolving into that owner, so a missing-import or
      // compile failure can never be relabeled as the intended structural red.
      const requiredWiring = {
        resources: ['resourceRows', 'Panel → resourceRows'],
        canvas: ['blueprint', 'presentationGroup', 'blueprintEdge', 'nodeTypes', 'edgeTypes', 'ReactFlow props'],
        documents: []
      }[boundary]
      for (const symbol of requiredWiring)
        assert.ok(
          result.evidence.some(entry => entry.symbol === symbol),
          `${boundary} structural red must cite '${symbol}' centralization wiring: ${JSON.stringify(result.evidence)}`
        )
      if (boundary === 'documents') {
        assert.ok(result.evidence.some(entry => entry.symbol === 'hostProbe' && entry.calls.at(-1) === 'this.loadConfigured'))
        assert.ok(result.evidence.some(entry => entry.symbol === 'startRun' && entry.calls.includes('startConfiguredRun')))
      }
    }
  })

  test(`${boundary} parse and missing-import failures cannot masquerade as expected structural red`, () => {
    sourceCopy(root => {
      const path = join(root, boundary === 'documents' ? 'src/index.ts' : 'src/client/features/authoring/ui/panel/panel-composition.tsx')
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
          ? ['src/client/features/authoring/logic/resources/resource-library-model.ts', 'src/client/shared/controls/command-facts.ts']
          : boundary === 'canvas'
            ? ['src/client/features/authoring/ui/canvas/canvas-renderers.tsx']
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

// A reachable JSX leaf preserves the real boundary classification, including
// after extraction, while its unresolved imports still fail the same oracle.
test('structural oracle parses reachable TSX without losing import checks', () => {
  sourceCopy(root => {
    const baseline = checkModularization({ root, boundary: 'resources' })
    const panelPath = join(root, 'src/client/features/authoring/ui/panel/panel-composition.tsx')
    const panel = readFileSync(panelPath, 'utf8')
    const leafPath = join(root, 'src/client/features/authoring/ui/panel/oracle-leaf.tsx')
    writeFileSync(panelPath, "import './oracle-leaf.tsx'\n" + panel)
    writeFileSync(leafPath, 'export const Leaf = () => <section />\n')
    assert.deepEqual(checkModularization({ root, boundary: 'resources' }), {
      ...baseline,
      evidence: baseline.evidence.map(entry =>
        entry.path === 'src/client/features/authoring/ui/panel/panel-composition.tsx' ? { ...entry, line: entry.line + 1 } : entry
      )
    })
    writeFileSync(leafPath, "import './missing-leaf.tsx'\nexport const Leaf = () => <section />\n")
    assert.equal(checkModularization({ root, boundary: 'resources' }).code, 'SOURCE_UNAVAILABLE')
  })
})

for (const source of ["import React from 'react'\n", 'void document\n']) {
  test(`extracted resource boundary rejects ${source.startsWith('import') ? 'React imports' : 'browser globals'} in the live pure model`, () => {
    sourceCopy(root => {
      assert.equal(checkModularization({ root, boundary: 'resources' }).code, 'BOUNDARY_EXTRACTED')
      const path = join(root, 'src/client/features/authoring/logic/resources/resource-library-model.ts')
      writeFileSync(path, source + readFileSync(path, 'utf8'))
      const result = checkModularization({ root, boundary: 'resources' })
      assert.equal(result.code, 'IMPURE_MODEL_DEPENDENCY', JSON.stringify(result))
      assert.ok(result.evidence.some(entry => entry.path === 'src/client/features/authoring/logic/resources/resource-library-model.ts' && entry.line === 1))
    })
  })
}
