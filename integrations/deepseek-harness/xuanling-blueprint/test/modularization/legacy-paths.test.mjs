import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import test from 'node:test'

const plugin = resolve(import.meta.dirname, '../..')
const repo = resolve(plugin, '../../..')
const executableRoots = [join(plugin, 'src'), join(plugin, 'test'), join(plugin, 'scripts'), join(repo, 'test', 'blueprint')]
const legacyFixture = resolve(plugin, 'test/modularization/source-graph-boundary.test.mjs')
const legacyNames = ['panel', 'workspace', 'graph-editor', 'inspector', 'locales', 'view-contract', 'styles', 'resource-dialog']
const clientRoot = ['src', 'client'].join('/')
const legacyPattern = new RegExp(`${clientRoot}/(?:${legacyNames.join('|')})\\.(?:tsx|ts)|${clientRoot}/panel-`, 'g')

function files(root) {
  if (!statSync(root).isDirectory()) return [root]
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => files(join(root, entry.name)))
}

export function scanLegacyPaths(roots = executableRoots, allowlist = new Set([legacyFixture])) {
  const findings = []
  for (const root of roots) {
    for (const path of files(root)) {
      if (!/\.(?:mjs|js|ts|tsx)$/.test(path) || allowlist.has(resolve(path))) continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(legacyPattern)) {
        findings.push({
          code: 'LEGACY_PATH_PRESENT',
          path: relative(repo, path),
          line: source.slice(0, match.index).split('\n').length,
          match: match[0]
        })
      }
    }
  }
  return findings
}

test('W3.3 executable source, tests, scripts and fixtures contain no legacy flat client paths', () => {
  assert.deepEqual(scanLegacyPaths(), [])
})

test('legacy path scanner classifies an isolated reintroduced fixture as LEGACY_PATH_PRESENT', () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-legacy-paths-'))
  try {
    const path = join(root, 'mutated-fixture.mjs')
    writeFileSync(path, `const oldPath = ${JSON.stringify(['src', 'client', 'panel.tsx'].join('/'))}\n`)
    const findings = scanLegacyPaths([root], new Set())
    assert.deepEqual(findings, [
      {
        code: 'LEGACY_PATH_PRESENT',
        path: relative(repo, path),
        line: 1,
        match: ['src', 'client', 'panel.tsx'].join('/')
      }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
