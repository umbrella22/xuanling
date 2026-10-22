import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { BlueprintService } from '../../src/index.ts'
import { readRevision, readRevisionHistory, RETAINED_REVISIONS, saveDefinitionDocument } from '../../src/definition/persist.ts'
import { admitResourceRef, isPackageReservedPath } from '../../src/security/resource-admission.ts'
import { pruneCandidates } from '../../src/service/apply-service.ts'
import { toolsetBindingDigest } from '../../src/service/binding-facts.ts'
import { definition } from '../feedback-fixtures.mjs'

function scratch(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('revision history is bounded and retained layout-only entries keep their inherited package bytes', t => {
  const root = scratch(t, 'bp-revision-retention-')
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'lib', 'a.txt'), 'package bytes')
  const digest = createHash('sha256').update('package bytes').digest('hex')
  const at = x => ({ ...definition('retention'), presentation: { nodes: { input: { x, y: 0 } } } })
  const first = saveDefinitionDocument(root, at(0), null)
  let current = first
  // Every later save only moves a node: none stores its own package files.
  for (let x = 1; x <= 130; x += 1) current = saveDefinitionDocument(root, at(x), current.documentRevision)

  const history = readRevisionHistory(root)
  assert.ok(history.length >= RETAINED_REVISIONS && history.length <= RETAINED_REVISIONS + 20, `history length ${history.length}`)
  assert.equal(history.at(-1).revision, current.documentRevision)
  assert.equal(readRevision(root, first.documentRevision), undefined, 'the oldest revision was pruned')
  for (const entry of history) {
    const record = readRevision(root, entry.revision)
    assert.equal(record.packageFiles?.['lib/a.txt']?.digest, digest, `revision ${entry.revision} resolves its package bytes`)
  }
  const oldest = JSON.parse(readFileSync(join(root, '.revisions', `${history[0].revision}.json`), 'utf8'))
  assert.equal(oldest.packageFiles?.['lib/a.txt']?.digest, digest, 'the new oldest entry carries the files it used to inherit')
  const stored = readdirSync(join(root, '.revisions')).filter(name => name !== 'index.json')
  assert.deepEqual(stored.sort(), history.map(entry => `${entry.revision}.json`).sort(), 'pruned entry files are removed')
})

test('candidate retention keeps the newest proposals and always the one just written', t => {
  const directory = scratch(t, 'bp-candidate-retention-')
  const name = index => `${index.toString(16).padStart(64, '0')}.json`
  for (let index = 0; index < 8; index += 1) {
    const path = join(directory, name(index))
    writeFileSync(path, '{}')
    const time = new Date(1_000_000 + index * 1_000)
    utimesSync(path, time, time)
  }
  writeFileSync(join(directory, 'notes.json'), '{}')
  const current = join(directory, name(0))
  pruneCandidates(directory, 3, current)
  assert.deepEqual(readdirSync(directory).sort(), [name(0), name(6), name(7), 'notes.json'].sort())
})

test('package-reserved names match regardless of case, normalization or trailing dots and spaces', () => {
  for (const path of [
    'blueprint.json',
    'Blueprint.JSON',
    'blueprint.json.',
    'blueprint.json ',
    '.Revisions/index.json',
    '.CANDIDATES/x',
    '.library-state',
    '.blueprint-commit.json',
    '.Blueprint-anything'
  ])
    assert.equal(isPackageReservedPath(path), true, path)
  for (const path of ['lib/blueprint.json', 'blueprints.json', 'revisions/x', 'lib/.revisions']) assert.equal(isPackageReservedPath(path), false, path)
  const issues = admitResourceRef('r', { path: 'lib/notes.' })
  assert.deepEqual(
    issues.map(issue => issue.code),
    ['reserved-path']
  )
  assert.deepEqual(admitResourceRef('r', { path: 'lib/./notes.txt' }), [])
})

test('toolset binding digest ignores registry order and keeps an unreadable registry distinct', () => {
  const schemas = [
    { name: 'b', parameters: { type: 'object' } },
    { name: 'a', parameters: { type: 'string' } },
    { name: 'unselected', parameters: {} }
  ]
  const ctx = list => ({ get: service => (service === 'tools' ? { schemas: () => list } : undefined) })
  const forward = toolsetBindingDigest(ctx(schemas), ['a', 'b'])
  assert.equal(toolsetBindingDigest(ctx([...schemas].reverse()), ['b', 'a']), forward)
  assert.notEqual(toolsetBindingDigest(ctx([{ ...schemas[0], parameters: { type: 'array' } }, schemas[1]]), ['a', 'b']), forward)
  const broken = {
    get: () => {
      throw new Error('registry unavailable')
    }
  }
  const unavailable = toolsetBindingDigest(broken, ['b', 'a', 'b'])
  assert.equal(toolsetBindingDigest(broken, ['a', 'b']), unavailable)
  assert.notEqual(unavailable, toolsetBindingDigest(ctx([]), ['a', 'b']))
})

test('maxQueuedToolRuns accepts only a positive safe integer', async () => {
  for (const maxQueuedToolRuns of [0, -1, 1.5, NaN, Infinity, '2', null]) {
    const ctx = new Context()
    try {
      assert.throws(() => new BlueprintService(ctx, { maxQueuedToolRuns }), /maxQueuedToolRuns must be a positive safe integer/)
    } finally {
      await ctx.fiber.dispose()
    }
  }
  const ctx = new Context()
  try {
    assert.doesNotThrow(() => new BlueprintService(ctx, { maxQueuedToolRuns: 1 }))
  } finally {
    await ctx.fiber.dispose()
  }
})
