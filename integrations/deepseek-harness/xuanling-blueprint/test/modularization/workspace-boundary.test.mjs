import assert from 'node:assert/strict'
import test from 'node:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkModularization } from '../../scripts/check-modularization.mjs'

const plugin = fileURLToPath(new URL('../../', import.meta.url))
const presenter = 'src/client/features/authoring/presenters/workspace-presenter.ts'
const controller = 'src/client/features/authoring/logic/workspace/workspace-controller.ts'
function sourceCopy(action) {
  const root = mkdtempSync(join(tmpdir(), 'bp-workspace-boundary-'))
  try {
    cpSync(join(plugin, 'src'), join(root, 'src'), { recursive: true })
    cpSync(join(plugin, 'package.json'), join(root, 'package.json'))
    symlinkSync(join(plugin, 'node_modules'), join(root, 'node_modules'), 'dir')
    return action(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
const check = root => checkModularization({ root, boundary: 'workspace' })
function prepend(root, file, text) {
  const path = join(root, file)
  writeFileSync(path, text + readFileSync(path, 'utf8'))
}

test('workspace boundary locates real cached subscription, dispatch and pure presenter declarations', () => {
  const result = check(plugin)
  assert.equal(result.code, 'BOUNDARY_EXTRACTED', JSON.stringify(result))
  assert.deepEqual(check(plugin), result)
  for (const symbol of ['getSnapshot', 'subscribe', 'dispatch', 'presentWorkspace']) assert.ok(result.evidence.some(item => item.symbol === symbol))
  for (const item of result.evidence) {
    const lines = readFileSync(join(plugin, item.path), 'utf8').split('\n')
    assert.ok(item.line > 0 && item.line <= lines.length)
    assert.ok(lines[item.line - 1].includes(item.symbol), `${item.path}:${item.line}: ${item.symbol}`)
  }
})

test('missing presentation boundary has a distinct structural red, not an import or parser failure', () => {
  sourceCopy(root => {
    rmSync(join(root, presenter))
    assert.equal(check(root).code, 'WORKSPACE_PRESENTER_MISSING')
    writeFileSync(join(root, presenter), 'export function presentWorkspace(snapshot) { return {} }\n')
    assert.equal(check(root).code, 'WORKSPACE_PRESENTER_CONTRACT_MISSING')
    writeFileSync(join(root, presenter), 'const = broken\n')
    assert.equal(check(root).code, 'SOURCE_PARSE_ERROR')
    writeFileSync(join(root, presenter), "import './absent-presenter.ts'\nexport function presentWorkspace(snapshot) { return snapshot }\n")
    assert.equal(check(root).code, 'SOURCE_UNAVAILABLE')
  })
})

for (const prefix of [
  "import React from 'react'\n",
  "import { BlueprintRemoteError } from '../../../adapters/host/remote.ts'\n",
  "import { GraphEditor } from '../logic/graph/graph-editor.ts'\n"
]) {
  test(`presenter rejects adapter import ${prefix.trim()}`, () => {
    sourceCopy(root => {
      prepend(root, presenter, prefix)
      assert.equal(check(root).code, 'IMPURE_PRESENTER_DEPENDENCY')
    })
  })
}
for (const prefix of ['void document.body\n', 'void window\n', 'void globalThis.navigator\n', 'setTimeout(() => {}, 0)\n']) {
  test(`presenter rejects browser effect ${prefix.trim()}`, () => {
    sourceCopy(root => {
      prepend(root, presenter, prefix)
      assert.equal(check(root).code, 'PRESENTER_BROWSER_ACCESS')
    })
  })
}
test('ordinary document data properties and local identifiers are not browser effects', () => {
  sourceCopy(root => {
    prepend(root, presenter, 'const document = { value: 1 }; void document.value; const data = { document: 2 }; void data.document\n')
    assert.equal(check(root).code, 'BOUNDARY_EXTRACTED')
  })
})
for (const body of [
  'snapshot.busy = false; return snapshot',
  'const current = snapshot.editor; current.nodes.push({}); return snapshot',
  'snapshot.editor.updateNode("x", {}); return snapshot'
]) {
  test(`presenter rejects snapshot or graph mutation: ${body}`, () => {
    sourceCopy(root => {
      writeFileSync(join(root, presenter), `export function presentWorkspace(snapshot) { ${body} }\n`)
      assert.equal(check(root).code, 'PRESENTER_MUTATION')
    })
  })
}
test('controller cannot acquire React through a side-effect import', () => {
  sourceCopy(root => {
    prepend(root, controller, "import 'react'\n")
    assert.equal(check(root).code, 'CONTROLLER_UI_DEPENDENCY')
  })
})
test('removing production intent validation cannot leave the workspace boundary green', () => {
  sourceCopy(root => {
    const path = join(root, controller)
    const source = readFileSync(path, 'utf8')
    assert.ok(source.includes('assertWorkspaceIntent(intent)'))
    writeFileSync(path, source.replace('assertWorkspaceIntent(intent)', 'void intent'))
    assert.equal(check(root).code, 'WORKSPACE_INTENT_VALIDATION_MISSING')
  })
})
