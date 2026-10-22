import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openBlueprintDomain, RunStore, createBackup, restoreBackup } from '../../src/persistence/index.ts'

const request = requestId => ({ scope: 'directory-test', requestId, payloadFingerprint: `fingerprint-${requestId}` })

test('P3 directory RunStore keeps one run per directory, scans after reopen, and restores durable events', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-directory-domain-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  let opened = await openBlueprintDomain({ path: root })
  let store = new RunStore(opened.domain)
  const admitted = await store.createRun(request('one'), 'revision-one', '{"schemaVersion":2}', '{}')
  const intent = await store.recordIntent(admitted.runId, {
    nodeId: 'step',
    kind: 'input',
    resourceDigests: { $package: 'a'.repeat(64) }
  })
  await store.recordResult(admitted.runId, intent.attemptId, {
    ok: true,
    outcome: { kind: 'succeeded', outputs: { value: 'directory' } },
    evidence: 'directory-test'
  })
  await store.settleTerminal(admitted.runId, 'succeeded')
  await opened.close()

  assert.equal(existsSync(join(root, 'runs', admitted.runId, 'run.json')), true)
  assert.equal(existsSync(join(root, 'runs', admitted.runId, 'events.jsonl')), true)
  assert.equal(existsSync(join(root, 'commands')), true)

  opened = await openBlueprintDomain({ path: root })
  store = new RunStore(opened.domain)
  assert.deepEqual(await store.listRunIds(), [admitted.runId])
  const reopened = await store.get(admitted.runId)
  assert.equal(reopened.state, 'succeeded')
  assert.equal(reopened.attempts[0].result.outcome.outputs.value, 'directory')
  assert.deepEqual((await store.rebuildProjection()).byState, { succeeded: 1 })

  const backup = createBackup(root)
  const restoredRoot = join(root, 'restored')
  restoreBackup(backup.archive, restoredRoot)
  await opened.close()
  opened = await openBlueprintDomain({ path: restoredRoot })
  store = new RunStore(opened.domain)
  assert.deepEqual(await store.get(admitted.runId), reopened)
  await opened.close()
})

test('P3 directory RunStore serializes concurrent transitions for one run', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-directory-serial-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const opened = await openBlueprintDomain({ path: root })
  t.after(() => opened.close())
  const store = new RunStore(opened.domain)
  const { runId } = await store.createRun(request('serial'), 'revision-one', '{"schemaVersion":2}', '{}')
  await Promise.all([
    store.transition(runId, draft => {
      draft.log.push({ seq: draft.seq + 1, at: Date.now(), kind: 'state', detail: { writer: 'a' } })
    }),
    store.transition(runId, draft => {
      draft.log.push({ seq: draft.seq + 1, at: Date.now(), kind: 'state', detail: { writer: 'b' } })
    })
  ])
  const record = await store.get(runId)
  assert.equal(record.seq, 2)
  assert.equal(record.log.length, 3)
})

test('P4 directory RunStore leaves explicit v1 Runs as lazy archives', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-directory-legacy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const opened = await openBlueprintDomain({ path: root })
  t.after(() => opened.close())
  const store = new RunStore(opened.domain)
  const archived = {
    schemaVersion: 1,
    runId: 'legacy-run',
    definitionRevision: 'legacy-revision',
    definitionJson: JSON.stringify({ schemaVersion: 1, id: 'legacy-workflow' }),
    inputRef: '{}',
    commandKey: 'directory-test:legacy',
    state: 'succeeded',
    attempts: [],
    log: [],
    seq: 0,
    createdAt: 1,
    updatedAt: 1
  }
  await opened.domain.table('runs').put(archived.runId, archived)
  assert.equal(existsSync(join(root, 'runs', archived.runId, 'run.json')), true)
  assert.equal(await store.tryGet(archived.runId), undefined)
  await assert.rejects(() => store.get(archived.runId), { code: 'RUN_NOT_FOUND' })
  assert.deepEqual(await store.listRunIds(), [])
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'runs', archived.runId, 'run.json'), 'utf8')).definitionJson, archived.definitionJson)
})

test('P3 directory backup contains only the durable Run boundary and excludes lease/workspace config', () => {
  const root = mkdtempSync(join(tmpdir(), 'bp-directory-backup-boundary-'))
  try {
    const durable = [
      ['runs/run-1/run.json', '{"state":"succeeded"}\n'],
      ['runs/run-1/events.jsonl', '{"seq":1}\n'],
      ['commands/c-1.json', '{"runId":"run-1"}\n'],
      ['lifecycle/run-1.json', '{"state":"succeeded"}\n'],
      ['snapshots/run-1/package.json', '{"version":1}\n'],
      ['store/team-output-artifacts/a/value.json', '{"value":true}\n']
    ]
    for (const [path, value] of durable) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), value)
    }
    writeFileSync(join(root, 'coordinator-lease.json'), '{"ownerId":"live"}\n')
    writeFileSync(join(root, 'root-bindings.json'), '{"roots":[]}\n')
    mkdirSync(join(root, 'workflows', 'legacy'), { recursive: true })
    writeFileSync(join(root, 'workflows', 'legacy', 'blueprint.json'), '{"schemaVersion":1}\n')

    const backup = createBackup(root)
    const files = Object.keys(backup.manifest.files).sort()
    assert.deepEqual(files, durable.map(([path]) => path).sort())
    assert.equal(
      files.some(path => path.includes('coordinator-lease')),
      false
    )
    assert.equal(
      files.some(path => path.startsWith('workflows/')),
      false
    )
    assert.equal(files.includes('root-bindings.json'), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
