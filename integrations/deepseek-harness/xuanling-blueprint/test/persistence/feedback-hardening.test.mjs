import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/recovery.ts'
import { RunExecutionService } from '../../src/service/run-execution.ts'
import { definition } from '../feedback-fixtures.mjs'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-feedback-store-'))
  let opened = await openBlueprintDomain({ path: root })
  t.after(async () => {
    await opened.close()
    rmSync(root, { recursive: true, force: true })
  })
  const reopen = async () => {
    await opened.close()
    opened = await openBlueprintDomain({ path: root })
    return new RunStore(opened.domain)
  }
  return { root, opened, store: new RunStore(opened.domain), reopen }
}
const request = id => ({ scope: 'feedback', requestId: id, payloadFingerprint: id })

test('pending admission survives reopen and cannot be dispatched or silently refilled', async t => {
  const f = await fixture(t)
  const { runId } = await f.store.createRun(request('pending'), 'revision', '{"schemaVersion":2}', '{}', { bindingDigests: {} })
  let store = await f.reopen()
  assert.equal((await store.get(runId)).bindingAdmission, 'pending')
  await reconcileOnStart(store)
  const pending = await store.get(runId)
  assert.equal(pending.state, 'recovery_required')
  assert.ok(pending.log.some(event => event.detail.reason === 'admission-incomplete'))
  await assert.rejects(() => store.setBindingDigests(runId, {}))
})

test('empty captured binding snapshot is immutable and exact fill is replayable', async t => {
  const { store } = await fixture(t)
  const { runId } = await store.createRun(request('capture'), 'revision', '{"schemaVersion":2}', '{}', { bindingDigests: {} })
  assert.equal((await store.setBindingDigests(runId, {})).bindingAdmission, 'captured')
  await store.setBindingDigests(runId, {})
  await assert.rejects(() => store.setBindingDigests(runId, { unexpected: 'a'.repeat(64) }), { code: 'ATTEMPT_SETTLED_CONFLICT' })
})

test('directory records preserve current and markerless Runs but fail closed on malformed current', async t => {
  const f = await fixture(t)
  const { runId } = await f.store.createRun(request('versions'), 'revision', '{"schemaVersion":2}', '{}')
  const path = join(f.root, 'runs', runId, 'run.json')
  const record = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(record.schemaVersion, 2)
  for (const marker of [undefined, 1, 2]) {
    const value = { ...record, schemaVersion: marker }
    writeFileSync(path, JSON.stringify(value))
    assert.equal((await f.store.get(runId)).runId, runId)
    await f.store.transition(runId, () => {})
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).schemaVersion, 2)
  }
  for (const text of ['{', JSON.stringify({ ...record, state: 'broken' }), JSON.stringify({ ...record, schemaVersion: 999 })]) {
    writeFileSync(path, text)
    await assert.rejects(() => f.store.tryGet(runId), { code: 'DURABILITY_FAILED' })
    await assert.rejects(() => f.store.listRunIds(), { code: 'DURABILITY_FAILED' })
  }
})

test('run traversal and symlinked directories never read or modify outside records', async t => {
  const f = await fixture(t)
  const { runId } = await f.store.createRun(request('paths'), 'revision', '{"schemaVersion":2}', '{}')
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  const bytes = readFileSync(join(f.root, 'runs', runId, 'run.json'))
  writeFileSync(join(outside, 'run.json'), bytes)
  for (const id of ['../outside', '../../outside', '/tmp/outside', '..\\outside', '%2e%2e%2foutside']) await assert.rejects(() => f.store.tryGet(id))
  symlinkSync(outside, join(f.root, 'runs', 'linked'), 'dir')
  await assert.rejects(() => f.store.tryGet('linked'), { code: 'DURABILITY_FAILED' })
  await assert.rejects(() => f.opened.domain.table('runs').put('linked', JSON.parse(bytes)))
  assert.deepEqual(readFileSync(join(outside, 'run.json')), bytes)
})

test('generic directory keys are encoded losslessly without imposing run ID grammar', async t => {
  const f = await fixture(t)
  const table = f.opened.domain.table('fixture')
  const key = 'namespace:valid key/with Unicode 文'
  await table.put(key, { ok: true })
  assert.deepEqual(await table.get(key), { ok: true })
  assert.deepEqual([...table.entries()], [[key, { ok: true }]])
})

test('run writes reject a symlinked event file before changing canonical or outside bytes', async t => {
  const f = await fixture(t)
  const { runId } = await f.store.createRun(request('event-path'), 'revision', '{"schemaVersion":2}', '{}')
  const outsideRoot = mkdtempSync(join(tmpdir(), 'bp-feedback-outside-'))
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true }))
  const outside = join(outsideRoot, 'events.jsonl')
  writeFileSync(outside, 'outside-sentinel')
  const recordPath = join(f.root, 'runs', runId, 'run.json')
  const before = readFileSync(recordPath)
  const events = join(f.root, 'runs', runId, 'events.jsonl')
  rmSync(events)
  symlinkSync(outside, events, 'file')
  await assert.rejects(() => f.store.transition(runId, () => {}), { code: 'DURABILITY_FAILED' })
  await assert.rejects(() => f.opened.domain.table('runs').put(runId, JSON.parse(before)))
  assert.deepEqual(readFileSync(recordPath), before)
  assert.equal(readFileSync(outside, 'utf8'), 'outside-sentinel')
})

test('the production driver refuses a pending admission before dispatching a node', async t => {
  const { store } = await fixture(t)
  const { runId } = await store.createRun(request('no-dispatch'), 'revision', JSON.stringify(definition()), '{}', { bindingDigests: {} })
  const execution = new RunExecutionService({ ctx: {}, config: {}, isClosing: () => false })
  await execution.driveRun({ store, controllers: new Map() }, runId, definition())
  const stopped = await store.get(runId)
  assert.equal(stopped.state, 'recovery_required')
  assert.deepEqual(stopped.attempts, [])
})
