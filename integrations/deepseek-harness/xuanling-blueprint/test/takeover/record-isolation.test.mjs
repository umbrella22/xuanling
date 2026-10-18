import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-record-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const opened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
  const store = new RunStore(opened.domain)
  const first = await store.createRun({ scope: 'test', requestId: 'first', payloadFingerprint: 'first' }, 'rev', '{}', '{}')
  const second = await store.createRun({ scope: 'test', requestId: 'second', payloadFingerprint: 'second' }, 'rev', '{}', '{}')
  await opened.close()
  return { root, first: first.runId, second: second.runId }
}

test('one semantically malformed RunRecord is backed up while valid records remain readable', async t => {
  const { root, first, second } = await fixture(t)
  const runsDir = join(root, 'store', 'blueprint_runs', 'runs')
  const target = join(runsDir, `${second}.json`)
  const document = JSON.parse(readFileSync(target, 'utf8'))
  document.record.state = 'not-a-run-state'
  writeFileSync(target, JSON.stringify(document))

  const reopened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
  try {
    const store = new RunStore(reopened.domain)
    assert.ok(await store.get(first))
    await assert.rejects(store.get(second), { code: 'RUN_NOT_FOUND' })
    const backups = readdirSync(runsDir).filter(name => name.startsWith(`${second}.json.bak.`))
    assert.equal(backups.length, 1)
  } finally {
    await reopened.close()
  }
})

test('raw malformed RunRecord is quarantined without hiding a valid sibling', async t => {
  const { root, first, second } = await fixture(t)
  const runsDir = join(root, 'store', 'blueprint_runs', 'runs')
  const target = join(runsDir, `${second}.json`)
  writeFileSync(target, '{"version":1,"record":')

  const reopened = await openBlueprintDomain({ backend: 'json', path: join(root, 'store') })
  try {
    const store = new RunStore(reopened.domain)
    assert.equal((await store.get(first)).schemaVersion, 1)
    await assert.rejects(store.get(second), { code: 'RUN_NOT_FOUND' })
    assert.equal(readdirSync(runsDir).filter(name => name.startsWith(`${second}.json.bak.`)).length, 1)
  } finally {
    await reopened.close()
  }
})

test('malformed command records fail closed before a runtime can admit a duplicate', async t => {
  const { root } = await fixture(t)
  const commandsDir = join(root, 'store', 'blueprint_runs', 'commands')
  const command = readdirSync(commandsDir).find(name => name.endsWith('.json'))
  assert.ok(command)
  writeFileSync(join(commandsDir, command), 'corrupt')
  await assert.rejects(openBlueprintDomain({ backend: 'json', path: join(root, 'store') }), { code: 'STORED_RECORD_INVALID' })
})

test('sqlite keeps canonical record corruption fail closed because the backend has no quarantine facet', async t => {
  const root = mkdtempSync(join(tmpdir(), 'bp-record-isolation-sqlite-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'runs.sqlite')
  const opened = await openBlueprintDomain({ backend: 'sqlite', path })
  const store = new RunStore(opened.domain)
  await store.createRun({ scope: 'test', requestId: 'first', payloadFingerprint: 'first' }, 'rev', '{}', '{}')
  await opened.close()
  const db = new DatabaseSync(path)
  const run = db.prepare('select key, value from u_blueprint_runs_runs limit 1').get()
  assert.ok(run)
  const value = JSON.parse(String(run.value))
  value.state = 'not-a-run-state'
  db.prepare('update u_blueprint_runs_runs set value = ? where key = ?').run(JSON.stringify(value), run.key)
  db.close()
  await assert.rejects(openBlueprintDomain({ backend: 'sqlite', path }), { code: 'invalid-record' })
})
