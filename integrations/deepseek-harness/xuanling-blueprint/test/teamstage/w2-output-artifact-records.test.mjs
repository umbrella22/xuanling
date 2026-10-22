import test from 'node:test'
import assert from 'node:assert/strict'
import { runRecordSchema, teamMemberReservationSchema, teamCaptureArtifactRefSchema, teamCaptureEvidenceSchema } from '../../src/persistence/records.ts'
import { canonicalJson, artifactDigest, captureEvidenceDigest } from '../../src/teamstage/artifact-contract.ts'

const hash = artifactDigest('fixture')
const uuid = '00000000-0000-4000-8000-000000000000'
const reservation = {
  runId: 'run',
  stageId: 'work',
  definitionRevision: 'revision',
  attemptId: 'attempt',
  effectId: 'spawn',
  logicalName: 'logical-member',
  nativeName: `bp-${uuid}`,
  memberId: `member-${uuid}`,
  reservationSeq: 2,
  schemaCanonicalJson: '{"type":"object"}',
  schemaDigest: artifactDigest('{"type":"object"}'),
  schemaResourceId: 'schema',
  schemaResourceDigest: hash,
  resourceDigests: { schema: hash, agent: hash }
}
const evidence = {
  producerSessionId: 'session',
  callId: 'call',
  rootCallId: 'root',
  turnId: 'turn',
  completedTurnId: 'turn',
  startLogSeq: 1,
  captureLogSeq: 3,
  endLogSeq: 5,
  completedAt: 10,
  flushedAt: 11,
  quiescentAt: 12
}
const facts = {
  artifactId: `ta-${uuid}`,
  digest: hash,
  byteLength: 2,
  runId: 'run',
  definitionRevision: 'revision',
  nodeId: 'work',
  stageId: 'work',
  attemptId: 'attempt',
  taskId: 'task',
  teamId: 'lead',
  producerMemberId: reservation.memberId,
  logicalName: reservation.logicalName,
  nativeName: reservation.nativeName,
  effectId: 'spawn',
  reservationSeq: 2,
  schemaDigest: reservation.schemaDigest,
  schemaResourceId: 'schema',
  schemaResourceDigest: hash,
  resourceDigests: reservation.resourceDigests,
  evidence
}
const ref = { ...facts, evidenceDigest: captureEvidenceDigest(facts) }
const ordinary = {
  runId: 'run',
  definitionRevision: 'revision',
  definitionJson: '{}',
  inputRef: '{}',
  commandKey: 'key',
  state: 'succeeded',
  attempts: [],
  log: [],
  seq: 2,
  createdAt: 0,
  updatedAt: 0
}

test('W2.7.2 records: retained archive records remain parseable at the storage boundary', () => {
  assert.deepEqual(runRecordSchema.parse(ordinary), ordinary)
  assert.equal(Object.hasOwn(runRecordSchema.parse(ordinary), 'teamStage'), false)
})

test('W2.7.2 records: retained archive Team records remain parseable without fabricated artifact refs', () => {
  const legacy = {
    ...ordinary,
    attempts: [
      {
        attemptId: 'attempt',
        nodeId: 'work',
        attempt: 0,
        state: 'succeeded',
        result: { seq: 2, at: 0, ok: true, outcome: { outputs: {} }, evidence: 'historical-host-verdict' }
      }
    ],
    teamStage: {
      schemaVersion: 1,
      runId: 'run',
      stageId: 'work',
      teamId: 'lead',
      leadSessionId: 'lead',
      attemptId: 'attempt',
      taskSpecificationFingerprint: hash,
      taskId: 'task',
      taskRevision: 1,
      state: 'succeeded',
      members: [],
      updatedAt: 0,
      outputAcceptance: {
        code: 'accepted',
        schemaVersion: 1,
        runId: 'run',
        stageId: 'work',
        taskId: 'task',
        attemptId: 'attempt',
        sourceSessionId: 'lead',
        artifactId: 'historical-artifact',
        digest: hash,
        evidenceDigest: hash,
        checks: ['schema']
      }
    }
  }
  assert.deepEqual(runRecordSchema.parse(legacy), legacy)
  assert.equal(Object.hasOwn(runRecordSchema.parse(legacy).teamStage, 'captures'), false)
  assert.equal(Object.hasOwn(runRecordSchema.parse(legacy).teamStage, 'reservations'), false)
})

test('W2.7.2 records: additive reservations and captures preserve every provenance field', () => {
  const record = {
    ...ordinary,
    teamStage: {
      schemaVersion: 1,
      runId: 'run',
      stageId: 'work',
      teamId: 'lead',
      leadSessionId: 'lead',
      taskSpecificationFingerprint: hash,
      attemptId: 'attempt',
      taskId: 'task',
      taskRevision: 1,
      state: 'active',
      members: [],
      updatedAt: 0,
      reservations: [reservation],
      captures: [ref]
    }
  }
  assert.deepEqual(runRecordSchema.parse(record), record)
  assert.equal(reservation.memberId, teamMemberReservationSchema.parse({ ...reservation, sessionId: 'native-child' }).memberId)
})

for (const [name, changed] of [
  ['old turn', { completedTurnId: 'old' }],
  ['capture before dispatch', { captureLogSeq: 1 }],
  ['end before capture', { endLogSeq: 2 }],
  ['flush before completed turn', { flushedAt: 9 }],
  ['quiescence before flush', { quiescentAt: 10 }],
  ['negative seq', { startLogSeq: -1 }]
]) {
  test(`W2.7.2 records: strict current evidence rejects ${name}`, () => {
    assert.equal(teamCaptureEvidenceSchema.safeParse({ ...evidence, ...changed }).success, false)
  })
}

test('W2.7.2 records: unknown path/raw fields and nonopaque artifact identities are rejected', () => {
  for (const extra of [{ path: '/secret' }, { locator: '../outside' }, { providerBody: 'sentinel' }]) {
    assert.equal(teamCaptureArtifactRefSchema.safeParse({ ...ref, ...extra }).success, false)
    assert.equal(teamMemberReservationSchema.safeParse({ ...reservation, ...extra }).success, false)
  }
  for (const artifactId of ['../outside', '/tmp/value.json', 'client-chosen', 'ta-../../outside']) {
    assert.equal(teamCaptureArtifactRefSchema.safeParse({ ...ref, artifactId }).success, false)
  }
  assert.equal(teamCaptureArtifactRefSchema.safeParse({ ...ref, digest: hash.toUpperCase() }).success, false)
  assert.equal(teamCaptureArtifactRefSchema.safeParse({ ...ref, byteLength: 0 }).success, false)
})

test('W2.7.2 records: canonical JSON preserves awkward valid business identities without loss', () => {
  const value = JSON.parse('{"__proto__":{"valid":true},"constructor":"value","é":"é","2":2,"10":10,"quote":"\\\"","nested":[null,false,0]}')
  const bytes = canonicalJson(value)
  assert.deepEqual(JSON.parse(bytes), value)
  assert.equal(bytes.includes('é'), true)
  assert.equal(bytes.includes('é'), true)
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }))
})

test('W2.7.2 records: serialization rejects lossy values and never invokes accessors/toJSON', () => {
  const cycle = {}
  cycle.self = cycle
  for (const value of [undefined, NaN, Infinity, new Date(), Buffer.from('x'), { a: undefined }, [undefined], Array(1), cycle]) {
    assert.throws(
      () => canonicalJson(value),
      error => error.issueCode === 'artifact-json-invalid'
    )
  }
  let called = 0
  const accessor = Object.defineProperty({}, 'answer', {
    enumerable: true,
    get() {
      called++
      return 'secret'
    }
  })
  const custom = {
    toJSON() {
      called++
      return 'secret'
    }
  }
  assert.throws(
    () => canonicalJson(accessor),
    error => error.issueCode === 'artifact-json-invalid'
  )
  assert.throws(
    () => canonicalJson(custom),
    error => error.issueCode === 'artifact-json-invalid'
  )
  assert.equal(called, 0)
})
