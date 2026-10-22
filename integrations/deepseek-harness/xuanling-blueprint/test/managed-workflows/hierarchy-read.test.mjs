import test from 'node:test'
import assert from 'node:assert/strict'
import { RunReadService } from '../../src/service/run-read-service.ts'
import { RunQuery } from '../../src/persistence/run-query.ts'
import { echoDefinition } from './child-fixtures.mjs'

function reads(records) {
  const store = {
    listRunIds: async () => records.map(r => r.runId),
    get: async id => records.find(r => r.runId === id),
    tryGet: async id => records.find(r => r.runId === id),
    isArchived: async () => false
  }
  return new RunReadService({ store, query: new RunQuery(store), backgroundFailures: new Map(), decodeDefinition: JSON.parse, teamRuntime: () => undefined })
}
function root(runId, createdAt) {
  return {
    runId,
    createdAt,
    updatedAt: createdAt,
    seq: 1,
    state: 'running',
    source: { sessionId: 'main', kind: 'ui' },
    definitionRevision: 'fixed',
    definitionJson: JSON.stringify(echoDefinition()),
    attempts: [],
    log: []
  }
}
test('default root selection crosses history pages and never follows the root of the newest child', async () => {
  const older = root('older-root', 1),
    newer = root('newer-root', 2)
  const children = Array.from({ length: 21 }, (_, i) => ({ ...root(`child-${i}`, i + 3), parent: { runId: older.runId, attemptId: `call-${i}` } }))
  older.attempts = children.map((r, i) => ({ attemptId: `call-${i}`, nodeId: 'in', childRunId: r.runId, state: 'running', attempt: 1 }))
  const read = reads([older, newer, ...children])
  assert.equal((await read.inspectSession({ sessionId: 'main' })).selected.run.runId, newer.runId)
})
test('hierarchy inspection rejects one-sided links and cycles without widening Session scope', async () => {
  const parent = root('parent', 1),
    child = {
      ...root('child', 2),
      parent: { runId: 'parent', attemptId: 'call' },
      attempts: [{ attemptId: 'work', nodeId: 'out', sessionId: 'node', state: 'running', attempt: 1 }]
    }
  const read = reads([parent, child])
  await assert.rejects(read.inspectRunView('child'), { code: 'blueprint/hierarchy-unavailable' })
  parent.attempts = [{ attemptId: 'call', nodeId: 'in', childRunId: 'child', state: 'running', attempt: 1 }]
  assert.equal((await read.inspectSession({ sessionId: 'node', runId: 'parent' })).selected.run.runId, 'parent')
  await assert.rejects(read.inspectRunView('parent', 'stranger'), { code: 'blueprint/run-not-found' })
  parent.parent = { runId: 'child', attemptId: 'work' }
  child.attempts[0].childRunId = 'parent'
  await assert.rejects(read.inspectRunView('child'), { code: 'blueprint/hierarchy-unavailable' })
})
