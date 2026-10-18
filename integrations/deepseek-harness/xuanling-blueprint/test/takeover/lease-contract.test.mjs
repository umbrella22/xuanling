import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriterLease } from '../../src/persistence/lease.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-lease-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('stale malformed lease with a recoverable dead owner can be taken over', t => {
  const root = fixture(t)
  const file = join(root, WriterLease.LEASE_FILE)
  writeFileSync(file, '{"ownerId":"old","pid":4242')
  const stale = new Date(1_000)
  utimesSync(file, stale, stale)

  const lease = WriterLease.acquire(root, { now: () => 60_000, takeoverThresholdMs: 10_000, isProcessAlive: pid => pid !== 4242 })
  assert.notEqual(lease.ownerId, 'old')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).ownerId, lease.ownerId)
  lease.release()
})

test('malformed lease without proof is a typed invalid lease failure', t => {
  const root = fixture(t)
  const file = join(root, WriterLease.LEASE_FILE)
  writeFileSync(file, 'corrupt')
  assert.throws(() => WriterLease.acquire(root), { code: 'COORDINATOR_LEASE_INVALID' })
})

test('heartbeat and release never mutate or remove a foreign owner lease', t => {
  const root = fixture(t)
  const first = WriterLease.acquire(root)
  const file = join(root, WriterLease.LEASE_FILE)
  const foreign = { ownerId: 'foreign', pid: process.pid, startedAt: Date.now(), runtimeRoot: root }
  writeFileSync(file, JSON.stringify(foreign))
  assert.throws(() => first.heartbeat(), { code: 'COORDINATOR_LEASE_LOST' })
  first.release()
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), foreign)
})

test('lease acquisition leaves one durable file and no temporary writer files', t => {
  const root = fixture(t)
  const lease = WriterLease.acquire(root)
  const names = readdirSync(root)
  assert.deepEqual(names, [WriterLease.LEASE_FILE])
  assert.ok(statSync(join(root, WriterLease.LEASE_FILE)).size > 0)
  lease.release()
})
