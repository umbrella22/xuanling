import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { WriterLease } from '../../src/persistence/lease.ts'

const run = promisify(execFile)
const LEASE_MODULE = pathToFileURL(fileURLToPath(new URL('../../src/persistence/lease.ts', import.meta.url))).href
const DEAD_PID = 2 ** 22 + 4242

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-lease-fencing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, file: join(root, 'coordinator-lease.json') }
}

function plantLease(file, root, { ownerId, pid, ageMs }) {
  writeFileSync(file, `${JSON.stringify({ ownerId, pid, startedAt: 1, runtimeRoot: root })}\n`)
  const at = new Date(Date.now() - ageMs)
  utimesSync(file, at, at)
}

test('a stale lease recorded under this pid by an earlier incarnation is taken over', t => {
  const { root, file } = scratch(t)
  plantLease(file, root, { ownerId: 'previous-incarnation', pid: process.pid, ageMs: 3_600_000 })
  const lease = WriterLease.acquire(root, { takeoverThresholdMs: 1_000 })
  t.after(() => lease.release())
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ownerId, lease.ownerId)
})

test('a fresh heartbeat from an unknown owner under this pid still blocks acquisition', t => {
  const { root, file } = scratch(t)
  plantLease(file, root, { ownerId: 'previous-incarnation', pid: process.pid, ageMs: 0 })
  assert.throws(() => WriterLease.acquire(root, { takeoverThresholdMs: 60_000 }), { code: 'COORDINATOR_ALREADY_ACTIVE' })
})

test('a lease held by this process is never taken over, however old its heartbeat', t => {
  const { root, file } = scratch(t)
  const held = WriterLease.acquire(root)
  t.after(() => held.release())
  const at = new Date(Date.now() - 3_600_000)
  utimesSync(file, at, at)
  assert.throws(() => WriterLease.acquire(root, { takeoverThresholdMs: 1_000 }), { code: 'COORDINATOR_ALREADY_ACTIVE' })
  held.assertOwned()
})

test('assertOwned fences writes once another owner holds the file, and release leaves that owner intact', t => {
  const { root, file } = scratch(t)
  const lease = WriterLease.acquire(root)
  lease.assertOwned()
  plantLease(file, root, { ownerId: 'successor', pid: DEAD_PID, ageMs: 0 })
  assert.throws(() => lease.assertOwned(), { code: 'COORDINATOR_LEASE_LOST' })
  assert.equal(lease.isLost, true)
  // Loss is sticky: even if the file reverted, this handle no longer writes.
  assert.throws(() => lease.assertOwned(), { code: 'COORDINATOR_LEASE_LOST' })
  lease.release()
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ownerId, 'successor')
})

test('the heartbeat reports loss exactly once when the lease is replaced', async t => {
  const { root, file } = scratch(t)
  const lease = WriterLease.acquire(root, { heartbeatIntervalMs: 10 })
  let lost = 0
  lease.startHeartbeat(() => {
    lost += 1
  })
  t.after(() => lease.release())
  plantLease(file, root, { ownerId: 'successor', pid: DEAD_PID, ageMs: 0 })
  const deadline = Date.now() + 5_000
  while (lost === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(lost, 1)
  assert.equal(lease.isLost, true)
})

test('a fresh takeover guard defers to the contender holding it; a stale guard is reclaimed', t => {
  const { root, file } = scratch(t)
  const options = { takeoverThresholdMs: 1_000, isProcessAlive: pid => pid !== DEAD_PID }
  plantLease(file, root, { ownerId: 'crashed', pid: DEAD_PID, ageMs: 3_600_000 })
  const guard = `${file}.takeover`
  writeFileSync(guard, 'another-contender')
  assert.throws(() => WriterLease.acquire(root, options), { code: 'COORDINATOR_LEASE_INVALID', reason: 'takeover-in-progress' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ownerId, 'crashed')

  const old = new Date(Date.now() - 3_600_000)
  utimesSync(guard, old, old)
  const lease = WriterLease.acquire(root, options)
  t.after(() => lease.release())
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ownerId, lease.ownerId)
  assert.equal(existsSync(guard), false)
  assert.deepEqual(
    readdirSync(root).filter(name => name !== 'coordinator-lease.json'),
    [],
    'takeover leaves no guard or temporary files'
  )
})

test('concurrent processes taking over one stale lease produce exactly one owner', { timeout: 120_000 }, async t => {
  const { root } = scratch(t)
  const child = join(root, 'contender.mjs')
  writeFileSync(
    child,
    [
      `import { WriterLease } from ${JSON.stringify(LEASE_MODULE)}`,
      'const [root, startAt] = [process.argv[2], Number(process.argv[3])]',
      'while (Date.now() < startAt) {}',
      'try {',
      '  const lease = WriterLease.acquire(root, { takeoverThresholdMs: 1000 })',
      "  console.log('OK ' + lease.ownerId)",
      '} catch (error) {',
      "  console.log('ERR ' + error.code)",
      '}'
    ].join('\n')
  )
  for (let round = 0; round < 8; round += 1) {
    const runtime = join(root, `round-${round}`)
    mkdirSync(runtime)
    const file = join(runtime, 'coordinator-lease.json')
    plantLease(file, runtime, { ownerId: 'crashed', pid: DEAD_PID, ageMs: 3_600_000 })
    const startAt = Date.now() + 1_500
    const results = await Promise.all(
      Array.from({ length: 3 }, () => run(process.execPath, ['--experimental-transform-types', '--no-warnings', child, runtime, String(startAt)]))
    )
    const lines = results.map(result => result.stdout.trim())
    const winners = lines.filter(line => line.startsWith('OK '))
    assert.equal(winners.length, 1, `round ${round}: ${lines.join(' | ')}`)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).ownerId, winners[0].slice(3), `round ${round}: the winner owns the file`)
  }
})
