import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'
import { acceptTeamOutput } from '../../src/teamstage/acceptance.ts'

const digest = value => createHash('sha256').update(value).digest('hex')

// The verdict models host verification at this boundary. This fixture does
// not prove immutable artifact file creation or actual native member work.
async function fixture(t, backend) {
  const root = await mkdtemp(join(tmpdir(), 'blueprint-settlement-race-'))
  const opened = await openBlueprintDomain({ backend, path: join(root, backend === 'json' ? 'store' : 'store.sqlite') })
  t.after(async () => { await opened.close(); await rm(root, { recursive: true, force: true }) })
  let updates = 0
  const domain = {
    table(name) {
      const table = opened.domain.table(name)
      if (name !== 'runs') return table
      return {
        get: key => table.get(key), put: (key, value) => table.put(key, value), delete: key => table.delete(key),
        entries: () => table.entries(),
        update: (key, reducer) => { updates += 1; return table.update(key, reducer) },
      }
    },
  }
  const store = new RunStore(domain)
  const { runId } = await store.createRun({ scope: 'run', requestId: 'settlement', payloadFingerprint: digest('request') }, 'revision-1', '{}', '{}')
  const { attemptId } = await store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask' })
  await store.bindTeamStage(runId, { stageId: 'work', teamId: 'lead', leadSessionId: 'lead', taskSpecificationFingerprint: digest('task'), attemptId,
    primaryMemberId: 'primary', requiredMemberIds: ['primary', 'collaborator'], requiredChecks: ['agreement'] })
  await store.bindTeamTask(runId, { taskId: 'task-1', taskRevision: 1 })
  const outputs = { answer: { text: 'verified', nested: [1, 2] } }
  const bytes = JSON.stringify(outputs.answer)
  await store.updateTeamStage(runId, { members: ['primary', 'collaborator'].map(memberId => ({
    memberId, name: memberId, sessionId: `${memberId}-session`, phase: 'active', status: 'inactive',
    evidence: { runId, stageId: 'work', taskId: 'task-1', attemptId, captureId: `capture-${memberId}`, schemaDigest: digest('schema'),
      valueDigest: digest(bytes), completedTurnId: `turn-${memberId}`, flushedAt: 1, quiescentAt: 2 },
  })) })
  const output = { code: 'accepted', schemaVersion: 1, runId, stageId: 'work', taskId: 'task-1', attemptId,
    sourceSessionId: 'primary-session', artifactId: 'host-artifact', digest: digest(bytes), evidenceDigest: digest('evidence'),
    checks: ['schema', 'digest', 'artifact-digest', 'agreement'] }
  const hostVerdict = { status: 'verified', artifactId: output.artifactId, digest: output.digest, byteLength: Buffer.byteLength(bytes),
    schemaDigest: digest('schema'), evidenceDigest: output.evidenceDigest, runId, stageId: 'work', taskId: 'task-1', attemptId,
    producerSessionId: 'primary-session', producerMemberId: 'primary' }
  return { store, domain, runId, attemptId, updates: () => updates,
    input: { store, runId, attemptId, output, hostVerdict, outputs, task: { id: 'task-1', revision: 1, status: 'completed' } } }
}

function holdSettlement(t, store, count = 1) {
  const ready = Promise.withResolvers()
  const release = Promise.withResolvers()
  const original = store.settleTeamStageAttempt.bind(store)
  let entered = 0
  store.settleTeamStageAttempt = async (...args) => {
    entered += 1
    if (entered === count) ready.resolve()
    await release.promise
    return await original(...args)
  }
  t.after(() => { release.resolve(); store.settleTeamStageAttempt = original })
  return { ready: ready.promise, release: () => release.resolve() }
}

async function enteredSettlement(gate, result) {
  await Promise.race([gate.ready, result.then(() => assert.fail('acceptance finished before the settlement barrier'))])
}

for (const backend of ['json', 'sqlite']) {
  const prefix = `W2.7.1 ${backend} settlement`
  const drifts = [
    ['task revision', 'task-binding-unverified', async h => { await h.store.updateTeamTaskRevision(h.runId, 1, 2) }],
    ['member capture', 'required-member-policy-unsatisfied', async h => {
      const members = (await h.store.get(h.runId)).teamStage.members
      members[1].evidence.captureId = 'replacement-capture'
      await h.store.updateTeamStage(h.runId, { members })
    }],
    ['required members', 'required-member-policy-override', async h => {
      await h.store.transition(h.runId, draft => { draft.teamStage.requiredMemberIds = ['primary'] })
    }],
    ['required checks', 'required-check-policy-override', async h => {
      await h.store.transition(h.runId, draft => { draft.teamStage.requiredChecks = ['schema'] })
    }],
    ['primary producer', 'producer-policy-mismatch', async h => {
      await h.store.transition(h.runId, draft => { draft.teamStage.primaryMemberId = 'collaborator' })
    }],
  ]
  for (const [name, issueCode, mutate] of drifts) {
    test(`${prefix} rejects ${name} drift after host precheck`, async t => {
      const h = await fixture(t, backend)
      const gate = holdSettlement(t, h.store)
      const rejected = assert.rejects(acceptTeamOutput(h.input), error => error.issueCode === issueCode)
      await enteredSettlement(gate, rejected)
      await mutate(h)
      const before = await h.store.get(h.runId)
      assert.equal(before.teamStage.outputAcceptance, undefined)
      assert.equal(before.attempts[0].result, undefined)
      gate.release()
      await rejected
      assert.deepEqual(await h.store.get(h.runId), before, 'stale verification must not write either success fact or advance seq')
    })
  }

  for (const source of ['lead', 'collaborator-session']) {
    test(`${prefix} missing primary session cannot claim ${source} provenance`, async t => {
      const h = await fixture(t, backend)
      const members = (await h.store.get(h.runId)).teamStage.members
      delete members[0].sessionId
      await h.store.updateTeamStage(h.runId, { members })
      const before = await h.store.get(h.runId)
      const input = { ...h.input, output: { ...h.input.output, sourceSessionId: source },
        hostVerdict: { ...h.input.hostVerdict, producerSessionId: source } }
      await assert.rejects(acceptTeamOutput(input), error => error.issueCode === 'required-member-policy-unsatisfied')
      assert.deepEqual(await h.store.get(h.runId), before)
    })
  }

  test(`${prefix} every required collaborator needs an exact session identity`, async t => {
    const h = await fixture(t, backend)
    const members = (await h.store.get(h.runId)).teamStage.members
    delete members[1].sessionId
    await h.store.updateTeamStage(h.runId, { members })
    const before = await h.store.get(h.runId)
    await assert.rejects(acceptTeamOutput(h.input), error => error.issueCode === 'required-member-policy-unsatisfied')
    assert.deepEqual(await h.store.get(h.runId), before)
  })

  test(`${prefix} memberId/sessionId alias collision cannot substitute missing required evidence`, async t => {
    const h = await fixture(t, backend)
    const members = (await h.store.get(h.runId)).teamStage.members
    members[0].sessionId = 'collaborator'
    delete members[1].evidence
    await h.store.updateTeamStage(h.runId, { members })
    const before = await h.store.get(h.runId)
    const input = { ...h.input, output: { ...h.input.output, sourceSessionId: 'collaborator' },
      hostVerdict: { ...h.input.hostVerdict, producerSessionId: 'collaborator' } }
    await assert.rejects(acceptTeamOutput(input), error => error.issueCode === 'required-member-policy-unsatisfied')
    assert.deepEqual(await h.store.get(h.runId), before)
  })

  test(`${prefix} concurrent exact replay commits one stage and original Attempt without another update`, async t => {
    const h = await fixture(t, backend)
    const before = await h.store.get(h.runId)
    const writes = h.updates()
    const gate = holdSettlement(t, h.store, 2)
    const results = Promise.all([acceptTeamOutput(h.input), acceptTeamOutput(h.input)])
    await enteredSettlement(gate, results)
    gate.release()
    const [first, replay] = await results
    assert.equal(first.seq, before.seq + 1)
    assert.deepEqual(replay, first, 'replay must return the original accepted record, including timestamps and seq')
    assert.equal(h.updates(), writes + 1, 'exact replay must not issue a second storage update')
    assert.equal(first.teamStage.state, 'succeeded')
    assert.equal(first.attempts.length, 1)
    assert.equal(first.attempts[0].attemptId, h.attemptId)
    assert.equal(first.attempts[0].state, 'succeeded')
    assert.equal(first.attempts[0].result.seq, first.seq)
    assert.deepEqual(first.attempts[0].result.outcome.outputs, h.input.outputs)
    assert.deepEqual(await h.store.get(h.runId), first)
  })

  for (const conflict of ['none', 'outputs', 'provenance', 'cancelled']) {
    test(`${prefix} cross-store stale read ${conflict} preserves terminal facts and seq`, async t => {
      const h = await fixture(t, backend)
      const other = new RunStore(h.domain)
      const before = await h.store.get(h.runId)
      const settlement = {
        attemptId: h.attemptId, acceptance: h.input.output, outputs: h.input.outputs,
        verification: { definitionRevision: before.definitionRevision, stage: before.teamStage, hostVerdict: h.input.hostVerdict },
      }
      const stale = structuredClone(settlement)
      if (conflict === 'outputs') stale.outputs.answer.text = 'conflicting-output'
      if (conflict === 'provenance') stale.verification.hostVerdict.schemaDigest = digest('other-schema')
      const ready = Promise.withResolvers()
      const release = Promise.withResolvers()
      const get = other.get.bind(other)
      other.get = async (...args) => {
        const snapshot = await get(...args)
        assert.equal(snapshot.teamStage.outputAcceptance, undefined, 'the second store really read before acceptance')
        ready.resolve()
        await release.promise
        return snapshot
      }
      t.after(() => { release.resolve(); other.get = get })
      const result = other.settleTeamStageAttempt(h.runId, stale)
      const checked = conflict === 'none' ? result : assert.rejects(result, error => conflict === 'cancelled'
        ? error.code === 'TERMINAL_STATE_IMMUTABLE'
        : error.issueCode === (conflict === 'outputs' ? 'acceptance-conflict' : 'host-verdict-binding-mismatch'))
      await Promise.race([ready.promise, checked.then(() => assert.fail('second store skipped the stale-read barrier'))])
      if (conflict !== 'cancelled') {
        await h.store.settleTeamStageAttempt(h.runId, settlement)
        await h.store.transition(h.runId, draft => { draft.state = 'succeeded' })
      } else {
        await h.store.requestCancel(h.runId)
        await h.store.transition(h.runId, draft => { draft.state = 'cancelled'; draft.teamStage.state = 'cancelled' })
      }
      const terminal = await h.store.get(h.runId)
      release.resolve()
      const replay = await checked
      if (conflict === 'none') assert.deepEqual(replay, terminal, 'terminal exact replay returns the existing record')
      assert.deepEqual(await h.store.get(h.runId), terminal, 'two update attempts do not mean two committed writes')
      assert.equal(terminal.seq, before.seq + 2)
      if (conflict !== 'cancelled') assert.equal(terminal.attempts[0].result.seq, before.seq + 1)
      else assert.equal(terminal.attempts[0].result, undefined)
    })
  }

  for (const conflict of ['outputs', 'provenance']) {
    const change = input => conflict === 'outputs'
      ? { ...input, outputs: { answer: { text: 'different', nested: [1, 2] } } }
      : { ...input, hostVerdict: { ...input.hostVerdict, schemaDigest: digest('other-schema') } }
    const issueCode = conflict === 'outputs' ? 'acceptance-conflict' : 'host-verdict-binding-mismatch'
    test(`${prefix} rejects concurrent identical DTO with conflicting ${conflict}`, async t => {
      const h = await fixture(t, backend)
      const writes = h.updates()
      const gate = holdSettlement(t, h.store, 2)
      const results = Promise.allSettled([acceptTeamOutput(h.input), acceptTeamOutput(change(h.input))])
      await enteredSettlement(gate, results)
      gate.release()
      const [first, conflictResult] = await results
      assert.equal(first.status, 'fulfilled')
      assert.equal(conflictResult.status, 'rejected')
      assert.equal(conflictResult.reason.issueCode, issueCode)
      assert.equal(h.updates(), writes + 1)
      assert.deepEqual(await h.store.get(h.runId), first.value)
    })
    test(`${prefix} rejects settled identical DTO with conflicting ${conflict}`, async t => {
      const h = await fixture(t, backend)
      const accepted = await acceptTeamOutput(h.input)
      const writes = h.updates()
      await assert.rejects(acceptTeamOutput(change(h.input)), error => error.issueCode === issueCode)
      assert.equal(h.updates(), writes)
      assert.deepEqual(await h.store.get(h.runId), accepted)
    })
  }

  test(`${prefix} accepted member evidence is read-only while parent Run remains running`, async t => {
    const h = await fixture(t, backend)
    const accepted = await acceptTeamOutput(h.input)
    assert.equal(accepted.state, 'running')
    const members = structuredClone(accepted.teamStage.members)
    members[1].evidence.captureId = 'post-accept-replacement'
    await assert.rejects(h.store.updateTeamStage(h.runId, { members }), error => error.code === 'TEAM_STAGE_CONFLICT')
    assert.deepEqual(await h.store.get(h.runId), accepted)
  })

  test(`${prefix} exact accepted stage observation replay does not write or advance seq`, async t => {
    const h = await fixture(t, backend)
    const accepted = await acceptTeamOutput(h.input)
    const writes = h.updates()
    const replay = await h.store.updateTeamStage(h.runId, { state: 'succeeded', members: structuredClone(accepted.teamStage.members) })
    assert.deepEqual(replay, accepted)
    assert.equal(h.updates(), writes)
  })

  test(`${prefix} graph-bound accepted DTO cannot bypass atomic settlement`, async t => {
    const h = await fixture(t, backend)
    const before = await h.store.get(h.runId)
    await assert.rejects(h.store.recordTeamOutputAcceptance(h.runId, h.input.output), error => error.issueCode === 'accepted-settlement-required')
    await assert.rejects(h.store.updateTeamStage(h.runId, { state: 'succeeded' }), error => error.code === 'TEAM_STAGE_CONFLICT')
    assert.deepEqual(await h.store.get(h.runId), before, 'neither entry may persist partial accepted facts')
  })

  test(`${prefix} stage-success update cannot complete a legacy partial accepted graph snapshot`, async t => {
    const h = await fixture(t, backend)
    await h.store.transition(h.runId, draft => { draft.teamStage.outputAcceptance = structuredClone(h.input.output) })
    const before = await h.store.get(h.runId)
    await assert.rejects(h.store.updateTeamStage(h.runId, { state: 'succeeded' }), error => error.code === 'TEAM_STAGE_CONFLICT')
    assert.deepEqual(await h.store.get(h.runId), before)
    assert.equal(before.attempts[0].result, undefined)
  })

  for (const field of ['outputs', 'hostVerdict']) {
    test(`${prefix} freezes ${field} before its first awaited store read`, async t => {
      const h = await fixture(t, backend)
      const initialOutputs = structuredClone(h.input.outputs)
      const initialDigest = h.input.hostVerdict.digest
      const ready = Promise.withResolvers()
      const release = Promise.withResolvers()
      const get = h.store.get.bind(h.store)
      let reads = 0
      h.store.get = async (...args) => {
        const record = await get(...args)
        if (++reads === 1) { ready.resolve(); await release.promise }
        return record
      }
      t.after(() => { release.resolve(); h.store.get = get })
      const accepted = acceptTeamOutput(h.input)
      await Promise.race([ready.promise, accepted.then(() => assert.fail('acceptance skipped the read barrier'))])
      if (field === 'outputs') h.input.outputs.answer.text = 'changed-across-await'
      else h.input.hostVerdict.digest = digest('changed-across-await')
      release.resolve()
      const record = await accepted
      assert.equal(record.teamStage.outputAcceptance.digest, initialDigest)
      assert.deepEqual(record.attempts[0].result.outcome.outputs, initialOutputs)
    })
  }
}
