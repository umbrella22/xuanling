import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore, createBackup, restoreBackup } from '../../src/persistence/index.ts'
import { reconcileOnStart } from '../../src/orchestration/index.ts'
import { runSourceCodec } from '../../src/conversation/contracts.ts'

const source = { sessionId: 'caller:α / unusual valid identity', kind: 'tool', callId: 'call:1', turn: 4 }
const request = id => ({ scope: 'run', requestId: id, payloadFingerprint: `fp:${id}` })
const metadata = () => ({ blueprintId: 'bp-logical', source: { ...source } })
const admit = (store, id, meta = metadata()) => store.createRun(request(id), 'frozen-revision', '{}', '{}', meta)
async function fixture(t, backend) {
  const root = mkdtempSync(join(tmpdir(), `bp-conversation-${backend}-`))
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(join(runtimeRoot, 'store'), { recursive: true })
  let opened
  const close = async () => {
    if (opened) {
      const own = opened
      opened = undefined
      await own.close()
    }
  }
  const open = async (location = runtimeRoot) => {
    assert.equal(opened, undefined)
    opened = await openBlueprintDomain({ path: join(location, 'store') })
    return new RunStore(opened.domain)
  }
  t.after(async () => {
    await close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, runtimeRoot, open, close, domain: () => opened.domain, table: name => opened.domain.table(name) }
}
for (const backend of ['directory']) {
  test(`host ${backend}: source/intent survive reopen, recovery and backup/restore without synthesized lineage`, async t => {
    const h = await fixture(t, backend)
    let store = await h.open()
    const meta = metadata()
    const { runId } = await admit(store, 'durable', meta)
    meta.source.sessionId = 'later-caller-mutation'
    assert.deepEqual((await store.get(runId)).source, source)
    const intent = await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask', sessionId: 'reserved-native-agent' })
    assert.equal((await store.get(runId)).attempts[0].sessionId, 'reserved-native-agent')
    assert.equal((await store.get(runId)).attempts[0].intent.seq, intent.seq)
    const { runId: legacyId } = await store.createRun(request('legacy'), 'legacy-revision', JSON.stringify({ schemaVersion: 1, id: 'legacy' }), '{}')
    assert.equal(await store.tryGet(legacyId), undefined, 'v1 Runs remain lazy archives and never enter the runtime')
    await assert.rejects(() => store.get(legacyId), { code: 'RUN_NOT_FOUND' })
    await h.close()
    store = await h.open()
    assert.deepEqual((await store.get(runId)).source, source)
    assert.equal((await store.get(runId)).attempts[0].sessionId, 'reserved-native-agent')
    await reconcileOnStart(store)
    const recovered = await store.get(runId)
    assert.equal(recovered.state, 'recovery_required')
    assert.equal(recovered.attempts[0].result, undefined, 'unknown effect is not replayed or invented')
    assert.equal(recovered.attempts[0].sessionId, 'reserved-native-agent')
    await h.close()
    store = await h.open()
    assert.deepEqual(await store.get(runId), recovered)
    await assert.rejects(() => store.get(legacyId), { code: 'RUN_NOT_FOUND' })
    await h.close()
    const backup = createBackup(h.runtimeRoot)
    const restored = join(h.root, 'restored')
    restoreBackup(backup.archive, restored)
    store = await h.open(restored)
    assert.deepEqual(await store.get(runId), recovered)
    await assert.rejects(() => store.get(legacyId), { code: 'RUN_NOT_FOUND' })
  })
  test(`host ${backend}: admission and intent failures dispatch no effects; bind-crash replay retains original source`, async t => {
    const h = await fixture(t, backend)
    const store = await h.open()
    const runs = h.table('runs'),
      commands = h.table('commands')
    const put = runs.put.bind(runs)
    const failPut = t.mock.method(runs, 'put', async () => {
      throw new Error('PRIVATE_PATH/provider-secret')
    })
    await assert.rejects(
      () => admit(store, 'fail-put'),
      error => error.code === 'DURABILITY_FAILED'
    )
    assert.deepEqual(await store.listRunIds(), [])
    failPut.mock.restore()
    // Source is included in the first durable put, even if command binding crashes.
    let firstPut
    t.mock.method(runs, 'put', async (id, value) => {
      firstPut = structuredClone(value)
      return put(id, value)
    })
    const failedBind = t.mock.method(commands, 'update', async () => {
      throw new Error('binding disk failure')
    })
    await assert.rejects(
      () => admit(store, 'fail-bind'),
      error => error.code === 'DURABILITY_FAILED'
    )
    assert.deepEqual(firstPut.source, source)
    assert.equal(firstPut.blueprintId, 'bp-logical')
    failedBind.mock.restore()
    const replay = await admit(store, 'fail-bind')
    assert.equal(replay.replayed, true)
    assert.equal(replay.runId, firstPut.runId)
    assert.equal((await store.listRunIds()).length, 1)
    const original = await store.get(replay.runId)
    const update = t.mock.method(runs, 'update', async () => {
      throw new Error('intent disk full')
    })
    await assert.rejects(
      () => store.recordIntent(replay.runId, { nodeId: 'work', kind: 'agentTask', sessionId: 'never-dispatched' }),
      error => error.code === 'DURABILITY_FAILED'
    )
    update.mock.restore()
    assert.deepEqual(await store.get(replay.runId), original)
    await assert.rejects(
      () =>
        store.createRun({ ...request('fail-bind'), payloadFingerprint: 'cross-source-fingerprint' }, 'revision', '{}', '{}', {
          source: { ...source, sessionId: 'foreign' }
        }),
      error => error.code === 'COMMAND_CONFLICT'
    )
    assert.deepEqual(await store.get(replay.runId), original)
  })
  test(`host ${backend}: source strict validation precedes any durable admission and concurrent replay admits once`, async t => {
    const h = await fixture(t, backend),
      store = await h.open()
    for (const bad of [
      { ...source, rawBody: 'secret' },
      { ...source, sessionId: '' },
      { ...source, kind: 'made-up' },
      { ...source, turn: -1 }
    ]) {
      assert.equal(runSourceCodec().safeParse(bad).success, false)
      await assert.rejects(
        () => admit(store, 'invalid', { source: bad }),
        error => error.name === 'ZodError'
      )
      assert.deepEqual(await store.listRunIds(), [])
      assert.equal(await h.table('commands').get(store.admission.constructor.commandKey('run', 'invalid')), undefined)
    }
    const replies = await Promise.all(Array.from({ length: 8 }, () => admit(store, 'concurrent')))
    assert.equal(new Set(replies.map(reply => reply.runId)).size, 1)
    assert.equal(replies.filter(reply => !reply.replayed).length, 1)
    const runId = replies[0].runId
    const intent = await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask', sessionId: 'cancelled-agent' })
    await Promise.all([
      store.requestCancel(runId),
      store.recordResult(runId, intent.attemptId, { ok: true, outcome: { kind: 'succeeded' }, evidence: 'known-effect' })
    ])
    const run = await store.get(runId)
    assert.equal(run.state, 'cancelled')
    assert.equal(run.attempts[0].sessionId, 'cancelled-agent')
    assert.deepEqual(run.source, source)
    await h.close()
    const reopened = await h.open()
    assert.deepEqual(await reopened.get(runId), run)
    assert.equal((await reopened.requestCancel(runId)).seq, run.seq)
  })
}
