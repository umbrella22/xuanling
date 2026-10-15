/** B-exclusive C-04/C-08 durable diagnostics: real JSON + SQLite, actual
 * RunStore spec APIs, process-equivalent reopen, backup/restore, legacy reads.
 * No mock store, skipped backend or body-bearing diagnostics. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as Domain from '@deepseek-ai/dsh-storage-domain'
import { openBlueprintDomain, RunStore, recordsSchema, createBackup, restoreBackup } from '../../src/persistence/index.ts'
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
const medium = (root, backend) => (backend === 'json' ? join(root, 'store') : join(root, 'store', 'runs.db'))
const unknownField = error => error?.name === 'ZodError' && error.issues.some(issue => issue.code === 'unrecognized_keys' && issue.keys.includes('rawBody'))
const attempt = record => record.attempts.find(item => item.nodeId === 'work')

async function fixture(t, backend) {
  const root = mkdtempSync(join(tmpdir(), `bp-diagnostics-${backend}-`))
  const runtimeRoot = join(root, 'runtime')
  mkdirSync(join(runtimeRoot, 'store'), { recursive: true })
  let opened
  const open = async (location = runtimeRoot) => {
    assert.equal(opened, undefined, 'fixture: previous real backend must be closed before reopening')
    opened = await openBlueprintDomain({ backend, path: medium(location, backend) })
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

for (const backend of ['json', 'sqlite']) {
  test(`C-04/C-08 ${backend}: intent pending and final acceptance survive reopen and backup with exact fields; legacy remains readable`, async t => {
    const h = await fixture(t, backend)
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

    const { runId: legacyId } = await admit(store, 'legacy-without-diagnostics')
    const legacyIntent = await store.recordIntent(legacyId, { nodeId: 'work', kind: 'agent', resourceDigests: digests })
    await store.recordResult(legacyId, legacyIntent.attemptId, { ok: true, outcome: { text: 'old explicit output' }, evidence: 'old-result' })
    const original = await store.get(runId)
    const legacy = await store.get(legacyId)
    assert.equal(Object.hasOwn(attempt(legacy), 'diagnostics'), false, 'C-08: optional addition must not rewrite old records')
    await h.close()
    store = await h.open()
    assert.deepEqual(await store.get(runId), original, 'C-04: reopen preserves the entire final record')
    assert.deepEqual(await store.get(legacyId), legacy, 'C-08: legacy record still reads without synthesis')
    await h.close() // SQLite backup is taken only after quiescent close/checkpoint.

    const backup = createBackup(h.runtimeRoot)
    assert.ok(
      Object.keys(backup.manifest.files).some(path => path.startsWith('store/')),
      'fixture: backup contains the real medium'
    )
    const restoredRoot = join(h.root, 'restored')
    restoreBackup(backup.archive, restoredRoot)
    store = await h.open(restoredRoot)
    assert.deepEqual(await store.get(runId), original, 'C-04/C-08: backup restores exact final diagnostic fields')
    assert.deepEqual(await store.get(legacyId), legacy, 'C-08: backup preserves diagnostic omission')
    const safe = JSON.stringify(attempt(await store.get(runId)).diagnostics)
    for (const raw of ['INPUT_RAW_SECRET_SENTINEL', 'AGENT_RAW_SECRET_SENTINEL', 'FROZEN_SCHEMA_BYTES', h.root]) {
      assert.equal(safe.includes(raw), false, 'C-04: diagnostics contain summaries, not raw resources/input/path')
    }
  })

  test(`C-04 ${backend}: unknown raw fields reject at intent/result without committing; resource/input/model/tools facts cannot drift`, async t => {
    const h = await fixture(t, backend)
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

  test(`C-04/C-08 ${backend}: persisted unknown raw diagnostic field fails closed at the real durable read boundary`, async t => {
    const h = await fixture(t, backend)
    const store = await h.open()
    const { runId } = await admit(store, 'strict-read-boundary')
    await store.recordIntent(runId, { nodeId: 'work', kind: 'agent', resourceDigests: digests, diagnostics: pending() })
    const corrupted = structuredClone(await store.get(runId))
    attempt(corrupted).diagnostics.input.rawBody = 'RAW_BODY_SECRET_SENTINEL'
    // Public domain writes are deliberately unvalidated; schema validation is
    // at reopen. This injects a bad stored record, not a malformed Run fixture.
    await h.table().put(runId, corrupted)
    await h.close()
    // Own the public stack for the rejecting open so even the failure path can
    // dispose the context/backend. Same recordsSchema as openBlueprintDomain.
    const ctx = new Context()
    try {
      await ctx.plugin(Storage)
      const adapter = backend === 'json' ? await import('@deepseek-ai/dsh-storage-json') : await import('@deepseek-ai/dsh-storage-sqlite')
      await ctx.plugin(adapter, backend === 'json' ? { root: medium(h.runtimeRoot, backend) } : { path: medium(h.runtimeRoot, backend) })
      await ctx.plugin(Domain, { backend })
      await assert.rejects(
        () =>
          ctx.storageDomain.open(
            Domain.defineDomain({
              name: 'blueprint_runs',
              version: 1,
              layout: 'per-record',
              tables: { runs: Domain.domainTable(recordsSchema.runs), commands: Domain.domainTable(recordsSchema.commands) }
            })
          ),
        error => error?.code === 'invalid-record' && error.detail?.table === 'runs' && error.detail?.key === runId && unknownField(error.cause),
        'C-04: actual persisted unknown field must be rejected, not silently stripped or quarantined'
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })
}
