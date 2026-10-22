/** C-04/C-08 durable diagnostics on the workspace-native directory domain.
 * The old JSON/SQLite adapter matrix was removed with the destructive storage
 * contract cutover; this suite exercises the real directory reopen and
 * backup boundaries instead. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore, createBackup, restoreBackup } from '../../src/persistence/index.ts'
import { attemptDiagnosticsCodec } from '../../src/host/runtime-diagnostics.ts'

const hash = text => createHash('sha256').update(text).digest('hex')
const input = JSON.stringify({ task: 'INPUT_RAW_SECRET_SENTINEL' })
const digests = { worker: hash('AGENT_RAW_SECRET_SENTINEL'), schema: hash('FROZEN_SCHEMA_BYTES') }
const pending = () => ({
  status: 'available',
  input: { type: 'object', bytes: Buffer.byteLength(input), sha256: hash(input) },
  resourceDigests: { ...digests },
  modelSelection: { provider: 'storage-provider', model: 'storage-model', reasoningEffort: 'adapter-owned-effort' },
  tools: { effectiveNames: ['read_allowed'] },
  acceptance: { code: 'pending' }
})
const final = () => ({
  ...pending(),
  tools: { effectiveNames: ['read_allowed'], denials: [{ toolName: 'write_other', code: 'tool-not-permitted' }] },
  acceptance: { code: 'output-invalid', issueCount: 2 },
  recovery: { code: 'known-result' }
})
const medium = root => root
const unknownField = error => error?.name === 'ZodError' && error.issues.some(issue => issue.code === 'unrecognized_keys' && issue.keys.includes('rawBody'))
const attempt = record => record.attempts.find(item => item.nodeId === 'work')

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-diagnostics-directory-'))
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(runtimeRoot, { recursive: true })
  let opened
  const open = async (location = runtimeRoot) => {
    assert.equal(opened, undefined, 'fixture: previous real backend must be closed before reopening')
    opened = await openBlueprintDomain({ path: medium(location) })
    return new RunStore(opened.domain)
  }
  const close = async () => {
    if (!opened) return
    const owned = opened
    opened = undefined
    await owned.close()
  }
  t.after(async () => {
    await close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, runtimeRoot, open, close, table: () => opened.domain.table('runs') }
}
const admit = (store, requestId) =>
  store.createRun({ scope: 'run', requestId, payloadFingerprint: hash(requestId) }, 'frozen-revision', '{"frozen":true}', '{}')

test('C-04 directory: intent pending and final acceptance survive reopen and backup with exact fields', async t => {
  const h = await fixture(t)
  let store = await h.open()
  const { runId } = await admit(store, 'new-diagnostics')
  const expectedPending = pending()
  const dispatch = await store.recordIntent(runId, { nodeId: 'work', kind: 'agent', resourceDigests: digests, diagnostics: expectedPending })
  const beforeEffect = await store.get(runId)
  assert.deepEqual(attempt(beforeEffect).diagnostics, expectedPending, 'C-04: pending facts must be durable before effects')
  assert.deepEqual(dispatch.intent.resourceDigests, attempt(beforeEffect).diagnostics.resourceDigests)
  assert.equal(attempt(beforeEffect).result, undefined, 'C-04: pending diagnostics do not fabricate settlement')
  assert.equal(beforeEffect.log.at(-1).seq, dispatch.seq, 'C-04: intent and diagnostics use the same aggregate transition')
  // Changing the caller-owned object cannot alter the committed snapshot.
  expectedPending.modelSelection.model = 'mutated-after-commit'
  expectedPending.tools.effectiveNames.push('write_other')
  assert.deepEqual(attempt(await store.get(runId)).diagnostics, pending())
  await h.close()
  store = await h.open()
  assert.deepEqual(attempt(await store.get(runId)).diagnostics, pending(), 'C-04: reopen retains pending, not current Host facts')

  const expectedFinal = final()
  const settled = await store.recordResult(runId, dispatch.attemptId, {
    ok: false,
    outcome: { kind: 'output-invalid' },
    evidence: 'schema-rejected',
    diagnostics: expectedFinal
  })
  assert.deepEqual(attempt(settled).diagnostics, expectedFinal)
  assert.equal(attempt(settled).result.seq, settled.seq)
  assert.equal(settled.log.at(-1).kind, 'result', 'C-04: result and final diagnostics commit in one transition')
  assert.equal(attempt(settled).state, 'failed')
  expectedFinal.acceptance.issueCount = 999
  assert.deepEqual(attempt(await store.get(runId)).diagnostics, final(), 'C-04: final facts are detached')

  const original = await store.get(runId)
  await h.close()
  store = await h.open()
  assert.deepEqual(await store.get(runId), original, 'C-04: reopen preserves the entire final record')
  await h.close()

  const backup = createBackup(h.runtimeRoot)
  assert.ok(
    Object.keys(backup.manifest.files).some(path => path.startsWith('runs/')),
    'fixture: backup contains the directory Run medium'
  )
  const restoredRoot = join(h.root, 'restored')
  restoreBackup(backup.archive, restoredRoot)
  store = await h.open(restoredRoot)
  assert.deepEqual(await store.get(runId), original, 'C-04/C-08: backup restores exact final diagnostic fields')
  const safe = JSON.stringify(attempt(await store.get(runId)).diagnostics)
  for (const raw of ['INPUT_RAW_SECRET_SENTINEL', 'AGENT_RAW_SECRET_SENTINEL', 'FROZEN_SCHEMA_BYTES', h.root]) {
    assert.equal(safe.includes(raw), false, 'C-04: diagnostics contain summaries, not raw resources/input/path')
  }
})

test('C-04 directory: unknown raw fields reject at intent/result without committing; resource/input/model/tools facts cannot drift', async t => {
  const h = await fixture(t)
  let store = await h.open()
  const { runId } = await admit(store, 'strict-diagnostics')
  const clean = await store.get(runId)
  const injectors = [
    value => {
      value.rawBody = 'RAW_BODY_SECRET_SENTINEL'
    },
    value => {
      value.input.rawBody = 'RAW_BODY_SECRET_SENTINEL'
    },
    value => {
      value.modelSelection.rawBody = 'RAW_BODY_SECRET_SENTINEL'
    },
    value => {
      value.tools.rawBody = 'RAW_BODY_SECRET_SENTINEL'
    },
    value => {
      value.tools.denials = [{ toolName: 'other', code: 'tool-rejected', rawBody: 'RAW_BODY_SECRET_SENTINEL' }]
    },
    value => {
      value.acceptance.rawBody = 'RAW_BODY_SECRET_SENTINEL'
    },
    value => {
      value.recovery = { code: 'unknown', rawBody: 'RAW_BODY_SECRET_SENTINEL' }
    }
  ]
  for (const inject of injectors) {
    const bad = pending()
    inject(bad)
    assert.throws(() => attemptDiagnosticsCodec().parse(bad), unknownField, 'C-04: strict codec must reject, not strip unknown raw fields')
    await assert.rejects(() => store.recordIntent(runId, { nodeId: 'work', kind: 'agent', resourceDigests: digests, diagnostics: bad }), unknownField)
    assert.deepEqual(await store.get(runId), clean, 'C-04: invalid intent must not append an Attempt or log')
  }
  await assert.rejects(
    () => store.recordIntent(runId, { nodeId: 'work', kind: 'agent', resourceDigests: { worker: hash('different') }, diagnostics: pending() }),
    error => error?.code === 'ATTEMPT_SETTLED_CONFLICT',
    'C-04: diagnostics resource digests must equal the intent'
  )
  assert.deepEqual(await store.get(runId), clean)
  const dispatch = await store.recordIntent(runId, { nodeId: 'work', kind: 'agent', resourceDigests: digests, diagnostics: pending() })
  const beforeResult = await store.get(runId)
  for (const inject of injectors) {
    const bad = final()
    inject(bad)
    await assert.rejects(
      () => store.recordResult(runId, dispatch.attemptId, { ok: false, outcome: { kind: 'output-invalid' }, evidence: 'invalid', diagnostics: bad }),
      unknownField
    )
    assert.deepEqual(await store.get(runId), beforeResult, 'C-04: invalid result leaves pending facts and settlement untouched')
  }
  const changes = [
    value => {
      value.resourceDigests.worker = hash('different')
    },
    value => {
      value.input.sha256 = hash('different')
    },
    value => {
      value.modelSelection.model = 'silent-model-switch'
    },
    value => {
      value.tools.effectiveNames.push('write_other')
    }
  ]
  for (const change of changes) {
    const bad = final()
    change(bad)
    await assert.rejects(
      () => store.recordResult(runId, dispatch.attemptId, { ok: false, outcome: { kind: 'output-invalid' }, evidence: 'invalid', diagnostics: bad }),
      error => error?.code === 'ATTEMPT_SETTLED_CONFLICT',
      'C-04: final diagnostics cannot reinterpret captured dispatch facts'
    )
    assert.deepEqual(await store.get(runId), beforeResult)
  }
  await h.close()
  store = await h.open()
  assert.deepEqual(await store.get(runId), beforeResult, 'C-04: rejected raw fields and drift are absent after restart')
})

test('C-04/C-08 directory: persisted unknown raw diagnostic field fails closed at the real durable read boundary', async t => {
  const h = await fixture(t)
  const store = await h.open()
  const { runId } = await admit(store, 'strict-read-boundary')
  await store.recordIntent(runId, { nodeId: 'work', kind: 'agent', resourceDigests: digests, diagnostics: pending() })
  const corrupted = structuredClone(await store.get(runId))
  attempt(corrupted).diagnostics.input.rawBody = 'RAW_BODY_SECRET_SENTINEL'
  // Direct bytes bypass the table codec to simulate corruption at the durable
  // boundary. A malformed current Run must remain a diagnostic failure.
  await h.close()
  const path = join(h.runtimeRoot, 'runs', runId, 'run.json')
  writeFileSync(path, `${JSON.stringify(corrupted)}\n`)
  const reopened = await h.open()
  await assert.rejects(() => reopened.get(runId), { code: 'DURABILITY_FAILED' }, 'C-04: corrupt current diagnostics cannot be presented as an absent Run')
  await h.close()
})
