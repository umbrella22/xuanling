import assert from 'node:assert/strict'
import test from 'node:test'
import { RunReadService } from '../../src/service/run-read-service.ts'
import { definition } from '../feedback-fixtures.mjs'

test('inspectRun with a caller session rejects records owned by another session', async () => {
  const record = {
    schemaVersion: 2,
    runId: 'run-session-scope',
    definitionRevision: 'revision-scope',
    definitionJson: JSON.stringify(definition()),
    inputRef: '{}',
    commandKey: 'session-scope',
    state: 'succeeded',
    attempts: [],
    log: [],
    seq: 0,
    createdAt: 1,
    updatedAt: 1,
    source: { sessionId: 'owner-session', kind: 'tool', callId: 'call-1' }
  }
  const reads = new RunReadService({
    store: { tryGet: async () => record },
    query: {},
    backgroundFailures: new Map(),
    decodeDefinition: () => definition(),
    teamRuntime: () => undefined
  })
  await assert.rejects(() => reads.inspectRun(record.runId, 'other-session'), { code: 'blueprint/run-not-found' })
  const own = await reads.inspectRun(record.runId, 'owner-session')
  assert.equal(own.runId, record.runId)
})
