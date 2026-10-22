import assert from 'node:assert/strict'
import fs, { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { mkdirDurable } from '../../src/persistence/durable-fs.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

const request = id => ({ scope: 'hardening', requestId: id, payloadFingerprint: id })

async function fixture(t, spec = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bp-directory-hardening-'))
  let opened = await openBlueprintDomain({ path: root, ...spec })
  t.after(async () => {
    await opened.close()
    rmSync(root, { recursive: true, force: true })
  })
  const reopen = async () => {
    await opened.close()
    opened = await openBlueprintDomain({ path: root, ...spec })
    return { domain: opened.domain, store: new RunStore(opened.domain) }
  }
  return { root, domain: () => opened.domain, store: new RunStore(opened.domain), reopen }
}

function age(path, ms) {
  const at = new Date(Date.now() - ms)
  utimesSync(path, at, at)
}

test('enumeration skips names a table could not have written', async t => {
  const f = await fixture(t)
  const { runId } = await f.store.createRun(request('kept'), 'revision', '{"schemaVersion":2}', '{}')
  const foreignRun = join(f.root, 'runs', 'run copy (1)')
  mkdirSync(foreignRun)
  writeFileSync(join(foreignRun, 'run.json'), '{ not json')
  mkdirSync(join(f.root, 'runs', 'bad%zz'))
  writeFileSync(join(f.root, 'runs', '.DS_Store'), 'finder metadata')
  mkdirSync(join(f.root, 'commands'), { recursive: true })
  for (const name of ['._kept.json', 'bad%zz.json', '%41.json', 'notes.txt']) writeFileSync(join(f.root, 'commands', name), '{ not json')
  const { domain, store } = await f.reopen()
  assert.deepEqual(await store.listRunIds(), [runId])
  assert.doesNotThrow(() => [...domain.table('commands').entries()])
})

test('an unreadable record a table owns still fails closed and names the file', async t => {
  const f = await fixture(t)
  mkdirSync(join(f.root, 'commands'), { recursive: true })
  writeFileSync(join(f.root, 'commands', 'broken.json'), '{"truncated":')
  mkdirSync(join(f.root, 'lifecycle'), { recursive: true })
  writeFileSync(join(f.root, 'lifecycle', 'broken.json'), '{"truncated":')
  const { domain } = await f.reopen()
  assert.throws(
    () => [...domain.table('commands').entries()],
    error => /commands\/broken\.json/.test(error.message) && error.cause instanceof SyntaxError
  )
  assert.throws(() => [...domain.table('run_lifecycle').entries()], /lifecycle\/broken\.json/)
})

test('opening sweeps abandoned temporary records and keeps fresh ones', async t => {
  const f = await fixture(t)
  const { runId } = await f.store.createRun(request('sweep'), 'revision', '{"schemaVersion":2}', '{}')
  mkdirSync(join(f.root, 'commands'), { recursive: true })
  const abandoned = [join(f.root, 'runs', runId, 'run.json.123.456.tmp'), join(f.root, 'commands', 'c.json.123.456.tmp')]
  const fresh = join(f.root, 'commands', 'd.json.123.789.tmp')
  const unrelated = join(f.root, 'commands', 'keep-me.tmp')
  for (const path of [...abandoned, fresh, unrelated]) writeFileSync(path, '{')
  for (const path of [...abandoned, unrelated]) age(path, 3_600_000)
  const { store } = await f.reopen()
  for (const path of abandoned) assert.equal(existsSync(path), false, path)
  assert.equal(existsSync(fresh), true)
  assert.equal(existsSync(unrelated), true)
  assert.deepEqual(await store.listRunIds(), [runId])
})

test('every mutation passes the ownership fence first', async t => {
  let owned = true
  const fence = () => {
    if (!owned) throw Object.assign(new Error('writer lease lost'), { code: 'COORDINATOR_LEASE_LOST' })
  }
  const f = await fixture(t, { fence })
  const { runId } = await f.store.createRun(request('before'), 'revision', '{"schemaVersion":2}', '{}')
  const runs = f.domain().table('runs')
  const record = await runs.get(runId)
  const before = readdirSync(join(f.root, 'runs', runId))
  owned = false
  await assert.rejects(() => runs.put(runId, { ...record, seq: record.seq + 1 }), /writer lease lost/)
  await assert.rejects(() => runs.update(runId, value => value), /writer lease lost/)
  await assert.rejects(() => runs.delete(runId), /writer lease lost/)
  await assert.rejects(() => f.store.createRun(request('after'), 'revision', '{"schemaVersion":2}', '{}'))
  assert.deepEqual(readdirSync(join(f.root, 'runs', runId)), before)
  assert.deepEqual(await f.store.listRunIds(), [runId])
})

test('mkdirDurable accepts a directory created concurrently but not a file', t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-mkdir-race-'))
  const original = fs.mkdirSync
  t.after(() => {
    fs.mkdirSync = original
    syncBuiltinESMExports()
    rmSync(root, { recursive: true, force: true })
  })
  const racedDirectory = join(root, 'raced-directory')
  const racedFile = join(root, 'raced-file')
  fs.mkdirSync = (path, options) => {
    // Another writer creates the entry between the existence check and ours.
    if (path === racedDirectory) original(path, options)
    if (path === racedFile) writeFileSync(path, '')
    return original(path, options)
  }
  syncBuiltinESMExports()
  assert.doesNotThrow(() => mkdirDurable(racedDirectory))
  assert.throws(() => mkdirDurable(racedFile), { code: 'EEXIST' })
})
