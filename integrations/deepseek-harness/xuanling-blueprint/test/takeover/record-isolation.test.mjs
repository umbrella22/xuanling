import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bp-record-isolation-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'runtime')
  const opened = await openBlueprintDomain({ path })
  const store = new RunStore(opened.domain)
  const first = await store.createRun({ scope: 'test', requestId: 'first', payloadFingerprint: 'first' }, 'rev', '{"schemaVersion":2}', '{}')
  const second = await store.createRun({ scope: 'test', requestId: 'second', payloadFingerprint: 'second' }, 'rev', '{"schemaVersion":2}', '{}')
  await opened.close()
  return { root, path, first: first.runId, second: second.runId }
}

test('a malformed current Run fails closed while valid siblings stay directly readable', async t => {
  const { root, path, first, second } = await fixture(t)
  const target = join(path, 'runs', second, 'run.json')
  const document = JSON.parse(readFileSync(target, 'utf8'))
  document.state = 'not-a-run-state'
  writeFileSync(target, JSON.stringify(document))

  const reopened = await openBlueprintDomain({ path })
  try {
    const store = new RunStore(reopened.domain)
    assert.ok(await store.get(first))
    await assert.rejects(store.get(second), { code: 'DURABILITY_FAILED' })
    await assert.rejects(store.listRunIds(), { code: 'DURABILITY_FAILED' })
    assert.equal(existsSync(target), true, 'corrupt current bytes remain intact for diagnosis and recovery')
  } finally {
    await reopened.close()
  }
  assert.equal(existsSync(join(root, 'runtime', 'runs', second)), true)
})

test('invalid JSON cannot masquerade as a legacy archive', async t => {
  const { path, first, second } = await fixture(t)
  const target = join(path, 'runs', second, 'run.json')
  writeFileSync(target, '{"schemaVersion":1,"record":')

  const reopened = await openBlueprintDomain({ path })
  try {
    const store = new RunStore(reopened.domain)
    assert.equal((await store.get(first)).schemaVersion, 2)
    await assert.rejects(store.get(second), { code: 'DURABILITY_FAILED' })
    await assert.rejects(store.listRunIds(), { code: 'DURABILITY_FAILED' })
    assert.equal(existsSync(target), true)
  } finally {
    await reopened.close()
  }
})

test('malformed command records fail closed before a runtime can admit a duplicate', async t => {
  const { path } = await fixture(t)
  const commandsDir = join(path, 'commands')
  const command = readdirSync(commandsDir).find(name => name.endsWith('.json'))
  assert.ok(command)
  writeFileSync(join(commandsDir, command), 'corrupt')

  const reopened = await openBlueprintDomain({ path })
  try {
    const store = new RunStore(reopened.domain)
    await assert.rejects(store.createRun({ scope: 'test', requestId: 'first', payloadFingerprint: 'first' }, 'rev', '{"schemaVersion":2}', '{}'), {
      code: 'DURABILITY_FAILED'
    })
  } finally {
    await reopened.close()
  }
})
