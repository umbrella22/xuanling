import assert from 'node:assert/strict'
import test from 'node:test'
import { projectRunSnapshot } from '../../src/conversation/run-projection.ts'
import { runSnapshotCodec } from '../../src/conversation/contracts.ts'

test('run navigation projection exposes only durable source and execution identities and reads legacy snapshots unchanged', () => {
  const record = {
    runId: 'run',
    state: 'failed',
    definitionRevision: 'frozen',
    seq: 3,
    log: [],
    source: { sessionId: 'real-source', kind: 'tool', callId: 'call', turn: 1 },
    attempts: [{ attemptId: 'attempt', nodeId: 'agent', state: 'failed', attempt: 1, sessionId: 'real-child' }]
  }
  const snapshot = projectRunSnapshot(record)
  assert.deepEqual(snapshot.source, record.source)
  assert.equal(snapshot.attempts[0].sessionId, 'real-child')
  assert.equal(runSnapshotCodec().safeParse(snapshot).success, true)
  snapshot.source.sessionId = 'changed-projection'
  assert.equal(record.source.sessionId, 'real-source', 'browser projection cannot mutate canonical source lineage')
  delete record.source
  delete record.attempts[0].sessionId
  const legacy = projectRunSnapshot(record)
  assert.equal(Object.hasOwn(legacy, 'source'), false)
  assert.equal(Object.hasOwn(legacy.attempts[0], 'sessionId'), false)
  assert.equal(runSnapshotCodec().safeParse(legacy).success, true)
})
