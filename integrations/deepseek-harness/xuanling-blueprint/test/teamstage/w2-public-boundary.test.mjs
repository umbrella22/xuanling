import test from 'node:test'
import assert from 'node:assert/strict'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'

const invocation = method => BLUEPRINT_INVOCATIONS.find(item => item.method === method)

test('W2.6 C-01/C-02: the host exposes a strict TeamStage admission mutation', () => {
  const descriptor = invocation('startTeamStage')
  assert.ok(descriptor, 'startTeamStage invocation is missing')
  assert.deepEqual(descriptor.parameters.map(parameter => parameter.name), ['args'])
  assert.equal(descriptor.parameters[0].codec.mode, 'strict')
  const argsCodec = descriptor.parameters[0].codec.create()
  assert.equal(argsCodec.safeParse({
    sessionId: 'lead-session', runId: 'run-1', stageId: 'stage-1',
    taskSpecificationFingerprint: 'a'.repeat(64), subject: 'review', description: 'Review the artifact',
  }).success, true)
})

test('W2.6 C-05: the host exposes owned TeamStage cancellation with no caller Team id', () => {
  const descriptor = invocation('cancelTeamStage')
  assert.ok(descriptor, 'cancelTeamStage invocation is missing')
  const argsCodec = descriptor.parameters[0].codec.create()
  assert.equal(argsCodec.safeParse({
    sessionId: 'lead-session', runId: 'run-1', memberNames: [],
  }).success, true)
  assert.equal(argsCodec.safeParse({
    sessionId: 'lead-session', runId: 'run-1', memberNames: [], teamId: 'forged-team',
  }).success, false)
})

test('W2.6 C-04/C-08: output acceptance derives source identity at the host boundary', () => {
  const descriptor = invocation('acceptTeamStageOutput')
  assert.ok(descriptor, 'acceptTeamStageOutput invocation is missing')
  const argsCodec = descriptor.parameters[0].codec.create()
  assert.equal(argsCodec.safeParse({
    sessionId: 'lead-session', runId: 'run-1', stageId: 'stage-1', taskId: 'task-1',
    code: 'accepted', schemaVersion: 1, artifactId: 'artifact-1', digest: 'b'.repeat(64),
    evidenceDigest: 'c'.repeat(64), checks: ['schema'],
  }).success, true)
  assert.equal(argsCodec.safeParse({
    sessionId: 'lead-session', runId: 'run-1', stageId: 'stage-1', taskId: 'task-1',
    sourceSessionId: 'forged-member', code: 'accepted', schemaVersion: 1, artifactId: 'artifact-1',
    digest: 'b'.repeat(64), evidenceDigest: 'c'.repeat(64), checks: ['schema'],
  }).success, false)
})
