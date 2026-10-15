import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { harness, definition, runSaved, records } from '../runtime-contracts/agent-fixtures.mjs'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

test('host: source and blueprint logical ID commit in the same admission aggregate', async t => {
  const h = await harness(t)
  const opened = await openBlueprintDomain({ backend: 'json', path: join(h.root, 'isolated-store') })
  t.after(() => opened.close())
  const store = new RunStore(opened.domain)
  const source = { sessionId: 'caller-live', kind: 'tool', callId: 'call-live', turn: 3 }
  const { runId } = await store.createRun(
    { scope: 'run', requestId: 'source-red', payloadFingerprint: 'source-fingerprint' },
    'revision',
    JSON.stringify(definition()),
    '{}',
    { blueprintId: 'runtime-contracts', source }
  )
  const saved = await store.get(runId)
  assert.deepEqual(saved.source, source, 'source is durable at admission, never added by a later projection')
  assert.equal(saved.blueprintId, 'runtime-contracts')
})

test('host: reserved Agent session ID is durable before native create and inspectRun exposes it', async t => {
  let beforeCreate
  const h = await harness(t)
  const create = h.host.registry.create.bind(h.host.registry)
  t.mock.method(h.host.registry, 'create', async options => {
    beforeCreate = (await records(h))[0]
    assert.equal(
      beforeCreate.attempts[0].sessionId,
      options.sessionId,
      'the production intent must contain the exact execution session before the Agent effect'
    )
    return create(options)
  })
  const { record } = await runSaved(h)
  assert.ok(beforeCreate)
  assert.equal(record.state, 'succeeded', 'creation-time lineage assertion must not become driver failure')
  assert.ok(record.attempts[0].sessionId, 'production driver reserves a durable session identity')
  const view = await h.service.inspectRun({ runId: record.runId })
  assert.equal(view.attempts[0].sessionId, record.attempts[0].sessionId)
})
