import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const checker = path.resolve(import.meta.dirname, '../scripts/check-docs.mjs')
const archivedPath = 'docs/validation/history/snapshot.md'
const historicalBytes = '[old link](missing.md)\n```text\nTODO\n'
const entry = () => ({
  path: archivedPath,
  sha256: createHash('sha256').update(historicalBytes).digest('hex'),
  reason: 'Immutable historical preimage; links are relative to its original location.'
})

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xuanling-doc-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '--quiet', root])
  const write = (name, bytes) => {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    writeFileSync(path.join(root, name), bytes)
  }
  write('README.md', '# Active documentation\n')
  write('npm/scripts/check-docs.mjs', '')
  copyFileSync(checker, path.join(root, 'npm/scripts/check-docs.mjs'))
  write(archivedPath, historicalBytes)
  const manifest = (entries = [entry()]) => write('docs/validation/archive-manifest.json', JSON.stringify({ schema_version: 1, entries }))
  const run = () => {
    const result = spawnSync(process.execPath, ['npm/scripts/check-docs.mjs'], {
      cwd: root,
      encoding: 'utf8'
    })
    assert.ifError(result.error)
    return { status: result.status, output: result.stdout + result.stderr }
  }
  return { root, write, manifest, run }
}

test('verified historical bytes bypass live link, fence and placeholder checks', t => {
  const f = fixture(t)
  f.manifest()
  const result = f.run()
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /1 immutable evidence files verified/)
})

test('without a manifest, historical bytes still receive all live checks', t => {
  const result = fixture(t).run()
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /broken link/)
  assert.match(result.output, /unbalanced code fences/)
  assert.match(result.output, /placeholder/)
})

test('active broken documentation remains rejected alongside verified archives', t => {
  const f = fixture(t)
  f.manifest()
  f.write('docs/active.md', '[active](missing.md)\n```\nFIXME\n')
  const result = f.run()
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /docs\/active.md: broken link/)
  assert.match(result.output, /docs\/active.md: unbalanced code fences/)
  assert.match(result.output, /docs\/active.md: contains a/)
})

test('archive digest mismatch fails even when new bytes are valid markdown', t => {
  const f = fixture(t)
  f.manifest()
  f.write(archivedPath, '# Rewritten snapshot\n')
  const result = f.run()
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /archive digest mismatch/)
})

test('missing archived file fails', t => {
  const f = fixture(t)
  f.manifest()
  rmSync(path.join(f.root, archivedPath))
  const result = f.run()
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /archive file unreadable/)
})

test('unlisted sibling evidence still receives live checks', t => {
  const f = fixture(t)
  f.manifest()
  f.write('docs/validation/history/unlisted.md', '[broken](missing.md)\n')
  const result = f.run()
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /history\/unlisted.md: broken link/)
})

test('exact archive paths preserve Chinese and space-containing filenames', t => {
  const f = fixture(t)
  const unicodePath = 'docs/validation/历史记录/原始 副本.md'
  f.write(unicodePath, historicalBytes)
  f.manifest([entry(), { ...entry(), path: unicodePath }])
  const result = f.run()
  assert.equal(result.status, 0, result.output)
  assert.match(result.output, /2 immutable evidence files verified/)
})

test('archive paths are literal identities, never expanded as globs', t => {
  const f = fixture(t)
  f.manifest([{ ...entry(), path: 'docs/validation/history/*.md' }])
  const result = f.run()
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /archive file unreadable/)
  assert.match(result.output, /snapshot.md: broken link/)
})

test('active table and referenced-doc validation remain enforced', t => {
  const f = fixture(t)
  f.manifest()
  f.write('docs/active.md', 'docs/missing.md\n\n| A | B |\n| --- | --- |\n| a |\n')
  const result = f.run()
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /table row has/)
  assert.match(result.output, /references missing doc path docs\/missing.md/)
})

test('archive symlink indirection is rejected even with matching bytes', t => {
  const f = fixture(t)
  f.manifest()
  f.write('original.md', historicalBytes)
  rmSync(path.join(f.root, archivedPath))
  symlinkSync(path.join(f.root, 'original.md'), path.join(f.root, archivedPath))
  const result = f.run()
  assert.equal(result.status, 1, result.output)
  assert.match(result.output, /archive file unreadable or not a regular repository file/)
})

test('invalid archive manifests fail closed', async t => {
  const invalidEntries = [
    [{ ...entry(), path: 'docs/validation/../active.md' }],
    [{ ...entry(), path: '/docs/validation/snapshot.md' }],
    [{ ...entry(), path: 'README.md' }],
    [{ ...entry(), sha256: 'bad' }],
    [{ ...entry(), reason: ' ' }],
    [{ ...entry(), extra: true }],
    [entry(), entry()]
  ]
  for (const entries of invalidEntries) {
    await t.test(JSON.stringify(entries), sub => {
      const f = fixture(sub)
      f.manifest(entries)
      assert.match(f.run().output, /invalid archive manifest/)
      assert.equal(f.run().status, 1)
    })
  }
  for (const bytes of ['{', '{"schema_version":2,"entries":[]}', '[]']) {
    await t.test(bytes, sub => {
      const f = fixture(sub)
      f.write('docs/validation/archive-manifest.json', bytes)
      const result = f.run()
      assert.equal(result.status, 1, result.output)
      assert.match(result.output, /invalid archive manifest/)
    })
  }
})
