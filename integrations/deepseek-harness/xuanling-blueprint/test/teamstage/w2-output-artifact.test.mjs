import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, mkdtemp, rm, readFile, writeFile, symlink, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { createBackup, openBlueprintDomain, restoreBackup, RunStore } from '../../src/persistence/index.ts'
import { acceptTeamOutput } from '../../src/teamstage/acceptance.ts'
import { recordTeamEffectIntent, recordTeamEffectResult } from '../../src/teamstage/runner.ts'
import { TeamOutputArtifacts, TeamArtifactError } from '../../src/teamstage/output-artifact.ts'
import { canonicalJson, artifactDigest, captureEvidenceDigest } from '../../src/teamstage/artifact-contract.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { answer: { type: 'string' }, count: { type: 'integer' } },
  required: ['answer', 'count']
}
// Deliberate formatting makes raw schema resource bytes distinct from its canonical JSON.
const schemaBytes = JSON.stringify(schema, null, 2)
const resources = { agent: digest('frozen agent'), answer: digest(schemaBytes), $package: digest('package') }
const value = { count: 2, answer: '确认\nUnicode 🐱' }
const definition = {
  schemaVersion: 2,
  id: 'artifact-test',
  name: 'Artifact contract',
  resources: { agent: { kind: 'agent', path: 'lib/agents/agent.md' }, answer: { kind: 'schema', path: 'lib/schemas/answer.json' } },
  graph: {
    nodes: [
      {
        id: 'work',
        kind: 'agentTask',
        agentRef: 'agent',
        outputSchemaRef: 'answer',
        outputs: { answer: 'json', serialized: 'string' },
        teamStage: {
          task: { subject: 'Verify', description: 'Collaborate on output' },
          members: [
            { name: 'primary', description: 'Produce', agentRef: 'agent', context: 'fresh' },
            { name: 'reviewer', description: 'Review', agentRef: 'agent', context: 'fork' }
          ],
          requiredChecks: ['agreement']
        }
      }
    ],
    edges: []
  }
}

async function fixture(t, backend = 'directory', options = {}) {
  const frozenSchema = options.schema ?? schema
  const frozenResources = { ...resources, answer: digest(JSON.stringify(frozenSchema, null, 2)) }
  const root = await mkdtemp(join(tmpdir(), 'blueprint-output-artifact-'))
  let runtimeRoot = join(root, 'runtime')
  let opened, store, artifacts
  const open = async () => {
    await mkdir(join(runtimeRoot, 'store'), { recursive: true })
    opened = await openBlueprintDomain({ path: runtimeRoot })
    store = new RunStore(opened.domain)
    artifacts = new TeamOutputArtifacts(runtimeRoot)
  }
  const close = async () => {
    await opened?.close()
    opened = undefined
  }
  t.after(async () => {
    await close()
    await rm(root, { recursive: true, force: true })
  })
  await open()
  const { runId } = await store.createRun(
    { scope: 'artifact', requestId: 'test', payloadFingerprint: digest('request') },
    digest('definition'),
    JSON.stringify(definition),
    '{}'
  )
  const { attemptId } = await store.recordIntent(runId, {
    nodeId: 'work',
    kind: 'agentTask',
    resourceDigests: frozenResources,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics })
  })
  await store.bindTeamStage(runId, { stageId: 'work', teamId: 'lead', leadSessionId: 'lead', attemptId, taskSpecificationFingerprint: digest('task') })
  await store.bindTeamTask(runId, { taskId: 'task', taskRevision: 3 })
  const reservations = []
  for (const logicalName of ['primary', 'reviewer']) {
    reservations.push(
      await store.reserveTeamMember(runId, { attemptId, effectId: `spawn-${logicalName}`, logicalName, schema: frozenSchema, resourceDigests: frozenResources })
    )
  }
  const h = {
    root,
    runId,
    attemptId,
    reservations,
    get runtimeRoot() {
      return runtimeRoot
    },
    get store() {
      return store
    },
    get artifacts() {
      return artifacts
    },
    get opened() {
      return opened
    },
    task: { id: 'task', revision: 3, status: 'completed' },
    facts(reservation) {
      return {
        runId,
        stageId: 'work',
        teamId: 'lead',
        actorSessionId: 'lead',
        taskId: 'task',
        kind: 'spawn',
        effectId: reservation.effectId,
        memberName: reservation.nativeName,
        memberId: reservation.memberId
      }
    },
    evidence(reservation) {
      return {
        producerSessionId: `session-${reservation.logicalName}`,
        callId: `call-${reservation.logicalName}`,
        rootCallId: `root-${reservation.logicalName}`,
        turnId: `turn-${reservation.logicalName}`,
        completedTurnId: `turn-${reservation.logicalName}`,
        startLogSeq: 10,
        captureLogSeq: 12,
        endLogSeq: 15,
        completedAt: 100,
        flushedAt: 101,
        quiescentAt: 102
      }
    },
    async spawn(reservation) {
      const facts = h.facts(reservation)
      await store.transition(runId, draft => {
        assert.ok(draft.teamStage.reservations.some(r => r.nativeName === facts.memberName && r.reservationSeq < draft.seq + 1))
      })
      await recordTeamEffectIntent(store, facts)
      await store.bindTeamMemberReservation(runId, {
        attemptId,
        effectId: reservation.effectId,
        memberId: reservation.memberId,
        sessionId: `session-${reservation.logicalName}`
      })
      await recordTeamEffectResult(store, facts, { ok: true, memberId: `session-${reservation.logicalName}`, status: 'inactive' })
      const member = (await store.get(runId)).teamStage.members.find(m => m.memberId === reservation.memberId)
      await store.upsertTeamMember(runId, { ...member, phase: 'active', status: 'inactive' })
    },
    async capture(reservation, capturedValue = value, changes = {}) {
      return await artifacts.commitCapture({
        store,
        runId,
        attemptId,
        memberId: reservation.memberId,
        value: capturedValue,
        evidence: { ...h.evidence(reservation), ...changes }
      })
    },
    async complete() {
      // Non-primary creation order must not change frozen producer policy.
      for (const reservation of [...reservations].reverse()) await h.spawn(reservation)
      return await Promise.all(reservations.map(r => h.capture(r)))
    },
    async verify() {
      return await artifacts.verifyStage({ store, runId, task: h.task })
    },
    async acceptance(extra = {}) {
      const verified = await h.verify()
      const v = verified.hostVerdict
      const output = {
        code: 'accepted',
        schemaVersion: 1,
        runId,
        stageId: v.stageId,
        taskId: v.taskId,
        attemptId,
        sourceSessionId: v.producerSessionId,
        artifactId: v.artifactId,
        digest: v.digest,
        evidenceDigest: v.evidenceDigest,
        checks: ['schema', 'digest', 'artifact-digest', 'agreement']
      }
      return { store, runId, attemptId, task: h.task, output, artifacts, outputs: verified.outputs, ...extra }
    },
    async reopen() {
      const oldContext = opened.ctx
      const oldStore = store
      await close()
      await open()
      assert.notEqual(opened.ctx, oldContext)
      assert.notEqual(store, oldStore)
    },
    async restore() {
      await close()
      const backup = createBackup(runtimeRoot)
      assert.ok(
        Object.keys(backup.manifest.files).some(path => path.startsWith('store/team-output-artifacts/') && path.endsWith('/value.json')),
        'backup contains physical values'
      )
      assert.ok(
        Object.keys(backup.manifest.files).some(path => path.endsWith('/provenance.json')),
        'backup contains physical provenance'
      )
      runtimeRoot = join(root, 'restored')
      const result = restoreBackup(backup.archive, runtimeRoot)
      assert.deepEqual(result.filesRestored, Object.keys(backup.manifest.files).sort())
      assert.equal(result.resumed, false)
      await open()
    },
    path(ref, name = 'value.json') {
      return join(runtimeRoot, 'store', 'team-output-artifacts', digest(ref.artifactId), name)
    }
  }
  return h
}

for (const backend of ['directory']) {
  test(`W2.7.2 ${backend}: available success diagnostics settle accepted with the original Attempt`, async t => {
    const diagnostics = {
      status: 'available',
      input: { type: 'object', bytes: Buffer.byteLength('{}'), sha256: digest('{}') },
      resourceDigests: resources,
      tools: { effectiveNames: [] },
      acceptance: { code: 'pending' }
    }
    const h = await fixture(t, backend, { diagnostics })
    await h.complete()
    const before = await h.store.get(h.runId)
    assert.deepEqual(before.attempts[0].diagnostics, diagnostics, 'available pending facts were durably stored by the real recordIntent API')
    const accepted = await acceptTeamOutput(await h.acceptance())
    assert.equal(accepted.teamStage.state, 'succeeded')
    assert.equal(accepted.attempts[0].state, 'succeeded')
    assert.equal(accepted.attempts[0].result.seq, accepted.seq)
    assert.equal(accepted.seq, before.seq + 1, 'success, result and diagnostic acceptance are a single transition')
    assert.deepEqual(accepted.attempts[0].diagnostics, { ...diagnostics, acceptance: { code: 'accepted' } })
    assert.deepEqual(await acceptTeamOutput(await h.acceptance()), accepted)
    await h.reopen()
    assert.deepEqual(await h.store.get(h.runId), accepted)
    assert.deepEqual(await acceptTeamOutput(await h.acceptance()), accepted)
  })

  for (const diagnosticState of ['unavailable', 'absent']) {
    test(`W2.7.2 ${backend}: success preserves ${diagnosticState} diagnostics without inventing available facts`, async t => {
      const h = await fixture(t, backend, diagnosticState === 'unavailable' ? { diagnostics: { status: 'unavailable' } } : {})
      await h.complete()
      const before = await h.store.get(h.runId)
      const accepted = await acceptTeamOutput(await h.acceptance())
      assert.equal(accepted.teamStage.state, 'succeeded')
      assert.deepEqual(accepted.attempts[0].diagnostics, before.attempts[0].diagnostics)
      assert.equal(Object.hasOwn(accepted.attempts[0], 'diagnostics'), diagnosticState === 'unavailable')
      if (diagnosticState === 'unavailable') assert.deepEqual(accepted.attempts[0].diagnostics, { status: 'unavailable' })
    })
  }

  test(`W2.7.2 ${backend}: actual bytes, full provenance and original Attempt atomic settlement`, async t => {
    const h = await fixture(t, backend)
    const refs = await h.complete()
    const before = await h.store.get(h.runId)
    assert.deepEqual(
      before.teamStage.requiredMemberIds,
      h.reservations.map(r => r.memberId)
    )
    assert.equal(before.teamStage.primaryMemberId, h.reservations[0].memberId)
    for (const ref of refs) {
      const bytes = await readFile(h.path(ref))
      assert.equal(bytes.toString(), canonicalJson(value))
      assert.equal(ref.digest, digest(bytes))
      assert.equal(ref.byteLength, bytes.length)
      assert.notEqual(ref.schemaDigest, ref.schemaResourceDigest)
      assert.equal(ref.schemaResourceDigest, digest(schemaBytes))
      assert.equal(ref.nodeId, 'work')
      assert.equal(ref.teamId, 'lead')
      assert.equal(ref.definitionRevision, before.definitionRevision)
      assert.equal(ref.attemptId, h.attemptId)
      assert.match(ref.artifactId, /^ta-/)
      assert.deepEqual(JSON.parse(await readFile(h.path(ref, 'provenance.json'), 'utf8')), ref)
      assert.equal(JSON.stringify(ref).includes(h.runtimeRoot), false)
    }
    const input = await h.acceptance()
    const [accepted, replay] = await Promise.all([acceptTeamOutput(input), acceptTeamOutput(input)])
    assert.equal(accepted.seq, before.seq + 1)
    assert.deepEqual(replay, accepted)
    assert.equal(accepted.teamStage.state, 'succeeded')
    assert.equal(accepted.attempts.length, 1)
    assert.equal(accepted.attempts[0].attemptId, h.attemptId)
    assert.equal(accepted.attempts[0].state, 'succeeded')
    assert.equal(accepted.attempts[0].result.seq, accepted.seq)
    assert.deepEqual(accepted.attempts[0].result.outcome.outputs, { answer: value, serialized: canonicalJson(value) })
    assert.equal(accepted.teamStage.outputAcceptance.sourceSessionId, 'session-primary')
    assert.deepEqual(accepted.teamStage.captures, before.teamStage.captures)
  })

  test(`W2.7.2 ${backend}: real close/reopen and backup/restore verify references and bytes read-only`, async t => {
    const h = await fixture(t, backend)
    const refs = await h.complete()
    const accepted = await acceptTeamOutput(await h.acceptance())
    await h.store.transition(h.runId, draft => {
      draft.state = 'succeeded'
    })
    const terminal = await h.store.get(h.runId)
    await h.reopen()
    assert.deepEqual(await h.store.get(h.runId), terminal)
    assert.deepEqual((await h.verify()).primaryValue, value)
    assert.deepEqual(await acceptTeamOutput(await h.acceptance()), terminal)
    assert.equal(terminal.seq, accepted.seq + 1)
    await h.restore()
    assert.deepEqual(await h.store.get(h.runId), terminal)
    assert.deepEqual((await h.verify()).primaryValue, value)
    assert.deepEqual(await acceptTeamOutput(await h.acceptance()), terminal)
    for (const ref of refs) assert.equal(digest(await readFile(h.path(ref))), ref.digest)
  })

  test(`W2.7.2 ${backend}: actual reopened tamper refuses acceptance without rewriting accepted terminal`, async t => {
    const h = await fixture(t, backend)
    const refs = await h.complete()
    const accepted = await acceptTeamOutput(await h.acceptance())
    await h.reopen()
    await writeFile(h.path(refs[1]), canonicalJson({ ...value, answer: 'tampered' }))
    await assert.rejects(h.verify(), error => error.issueCode === 'artifact-digest-mismatch')
    assert.deepEqual(await h.store.get(h.runId), accepted)
  })

  for (const problem of ['missing-blob', 'tampered-bytes', 'foreign-binding']) {
    test(`W2.7.2 ${backend}: production acceptance rejects ${problem} with matching client/verdict digest`, async t => {
      const h = await fixture(t, backend)
      const refs = await h.complete()
      const input = await h.acceptance()
      const before = await h.store.get(h.runId)
      if (problem === 'missing-blob') await rm(h.path(refs[0]))
      if (problem === 'tampered-bytes') await writeFile(h.path(refs[0]), canonicalJson({ ...value, answer: 'different' }))
      if (problem === 'foreign-binding') {
        const provenance = { ...refs[0], runId: 'foreign' }
        await writeFile(h.path(refs[0], 'provenance.json'), canonicalJson(provenance))
      }
      input.hostVerdict = {
        status: 'verified',
        ...Object.fromEntries(
          [
            'artifactId',
            'digest',
            'byteLength',
            'schemaDigest',
            'evidenceDigest',
            'runId',
            'stageId',
            'taskId',
            'attemptId',
            'producerSessionId',
            'producerMemberId'
          ].map(key => [key, key === 'producerSessionId' ? 'session-primary' : refs[0][key]])
        )
      }
      await assert.rejects(
        acceptTeamOutput(input),
        error =>
          error.issueCode ===
          { 'missing-blob': 'artifact-bytes-missing', 'tampered-bytes': 'artifact-digest-mismatch', 'foreign-binding': 'artifact-provenance-mismatch' }[problem]
      )
      assert.deepEqual(await h.store.get(h.runId), before)
      assert.equal(before.attempts[0].result, undefined)
    })
  }

  test(`W2.7.2 ${backend}: schema-invalid capture never writes bytes or a reference`, async t => {
    const h = await fixture(t, backend)
    await h.spawn(h.reservations[0])
    const before = await h.store.get(h.runId)
    await assert.rejects(h.capture(h.reservations[0], { answer: 'invalid', count: 'not-an-integer' }), error => error.issueCode === 'artifact-schema-invalid')
    assert.deepEqual(await h.store.get(h.runId), before)
    assert.equal(fs.existsSync(join(h.runtimeRoot, 'store', 'team-output-artifacts')), false)
  })

  test(`W2.7.2 ${backend}: agreement compares all canonical member JSON bytes`, async t => {
    const h = await fixture(t, backend)
    for (const r of h.reservations) await h.spawn(r)
    await h.capture(h.reservations[0])
    await h.capture(h.reservations[1], { ...value, count: 3 })
    const before = await h.store.get(h.runId)
    await assert.rejects(h.verify(), error => error.issueCode === 'artifact-member-agreement-mismatch')
    assert.deepEqual(await h.store.get(h.runId), before)
    assert.equal(before.teamStage.outputAcceptance, undefined)
  })

  test(`W2.7.2 ${backend}: key order does not create false disagreement`, async t => {
    const h = await fixture(t, backend)
    for (const r of h.reservations) await h.spawn(r)
    await h.capture(h.reservations[0], { answer: value.answer, count: value.count })
    await h.capture(h.reservations[1], { count: value.count, answer: value.answer })
    assert.deepEqual((await h.verify()).primaryValue, value)
  })

  test(`W2.7.2 ${backend}: exact capture replay is read-only; different value/call cannot overwrite`, async t => {
    const h = await fixture(t, backend)
    const refs = await h.complete()
    const before = await h.store.get(h.runId)
    const directories = await readdir(join(h.runtimeRoot, 'store', 'team-output-artifacts'))
    assert.deepEqual(await h.capture(h.reservations[0]), refs[0])
    await assert.rejects(h.capture(h.reservations[0], { ...value, count: 4 }), error => error.issueCode === 'artifact-capture-conflict')
    await assert.rejects(h.capture(h.reservations[0], value, { callId: 'other-call' }), error => error.issueCode === 'artifact-capture-conflict')
    assert.deepEqual(await h.store.get(h.runId), before)
    assert.deepEqual(await readdir(join(h.runtimeRoot, 'store', 'team-output-artifacts')), directories)
    assert.equal(digest(await readFile(h.path(refs[0]))), refs[0].digest)
  })

  test(`W2.7.2 ${backend}: subset policy/client checks and changed downstream values cannot lower acceptance`, async t => {
    const h = await fixture(t, backend)
    await h.complete()
    const before = await h.store.get(h.runId)
    for (const extra of [
      { requiredMemberIds: [] },
      { requiredMemberIds: [h.reservations[0].memberId] },
      { requiredChecks: [] },
      { outputs: { answer: { ...value, count: 9 }, serialized: canonicalJson(value) } }
    ]) {
      await assert.rejects(acceptTeamOutput(await h.acceptance(extra)), error =>
        ['required-member-policy-override', 'required-check-policy-override', 'artifact-output-value-mismatch'].includes(error.issueCode)
      )
      assert.deepEqual(await h.store.get(h.runId), before)
    }
    await h.store.transition(h.runId, draft => {
      draft.teamStage.requiredMemberIds = [h.reservations[0].memberId]
    })
    const drifted = await h.store.get(h.runId)
    await assert.rejects(h.verify(), error => error.issueCode === 'artifact-required-policy-mismatch')
    assert.deepEqual(await h.store.get(h.runId), drifted)
  })

  test(`W2.7.2 ${backend}: artifact list drift after verification is rejected inside settlement RMW`, async t => {
    const h = await fixture(t, backend)
    await h.complete()
    const input = await h.acceptance()
    const ready = Promise.withResolvers(),
      release = Promise.withResolvers()
    const settle = h.store.settleTeamStageAttempt.bind(h.store)
    h.store.settleTeamStageAttempt = async (...args) => {
      ready.resolve()
      await release.promise
      return await settle(...args)
    }
    t.after(() => {
      release.resolve()
      h.store.settleTeamStageAttempt = settle
    })
    const rejected = assert.rejects(acceptTeamOutput(input), error => error.issueCode === 'artifact-current-capture-mismatch')
    await ready.promise
    await h.store.transition(h.runId, draft => {
      draft.teamStage.captures = [...draft.teamStage.captures].reverse()
    })
    const before = await h.store.get(h.runId)
    release.resolve()
    await rejected
    assert.deepEqual(await h.store.get(h.runId), before)
    assert.equal(before.attempts[0].result, undefined)
  })

  test(`W2.7.2 ${backend}: legacy missing refs and unreferenced blobs are not adopted`, async t => {
    const h = await fixture(t, backend)
    const refs = await h.complete()
    const input = await h.acceptance()
    await h.store.transition(h.runId, draft => {
      delete draft.teamStage.captures
      delete draft.teamStage.members[0].evidence
    })
    const before = await h.store.get(h.runId)
    await assert.rejects(acceptTeamOutput(input), error => error.issueCode === 'artifact-required-capture-missing')
    assert.deepEqual(await h.store.get(h.runId), before)
    assert.equal(digest(await readFile(h.path(refs[0]))), refs[0].digest, 'physical file alone gives no authority')
    await h.store.transition(h.runId, draft => {
      delete draft.teamStage.reservations
    })
    await assert.rejects(h.verify(), error => error.issueCode === 'artifact-required-reservation-missing')
  })

  test(`W2.7.2 ${backend}: missing current session and old completed turn cannot create capture`, async t => {
    const h = await fixture(t, backend)
    await h.spawn(h.reservations[0])
    const before = await h.store.get(h.runId)
    await assert.rejects(h.capture(h.reservations[0], value, { producerSessionId: 'lead' }), error => error.issueCode === 'artifact-producer-binding-mismatch')
    await assert.rejects(h.capture(h.reservations[0], value, { completedTurnId: 'old-turn' }), error => error.issueCode === 'artifact-capture-evidence-invalid')
    const member = { ...before.teamStage.members[0] }
    delete member.sessionId
    await h.store.updateTeamStage(h.runId, { members: [member] })
    const missing = await h.store.get(h.runId)
    await assert.rejects(h.capture(h.reservations[0]), error => error.issueCode === 'artifact-producer-binding-mismatch')
    assert.deepEqual(await h.store.get(h.runId), missing)
  })

  test(`W2.7.2 ${backend}: reservations retain logical names and opaque policy IDs across accepted replay`, async t => {
    const h = await fixture(t, backend)
    for (const r of h.reservations) {
      assert.match(r.nativeName, /^bp-[a-f0-9-]{36}$/)
      assert.ok(r.nativeName.length <= 64)
      assert.notEqual(r.memberId, `session-${r.logicalName}`)
      assert.equal(r.runId, h.runId)
      assert.equal(r.stageId, 'work')
      assert.equal(r.attemptId, h.attemptId)
    }
    await h.complete()
    const accepted = await acceptTeamOutput(await h.acceptance())
    const r = h.reservations[0]
    const replay = await h.store.reserveTeamMember(h.runId, {
      attemptId: h.attemptId,
      effectId: r.effectId,
      logicalName: r.logicalName,
      schema,
      resourceDigests: resources
    })
    assert.equal(replay.nativeName, r.nativeName)
    assert.equal(replay.memberId, r.memberId)
    assert.deepEqual(
      await h.store.bindTeamMemberReservation(h.runId, { attemptId: h.attemptId, effectId: r.effectId, memberId: r.memberId, sessionId: 'session-primary' }),
      accepted
    )
    for (const changed of [{ effectId: 'different-spawn' }, { resourceDigests: { ...resources, agent: digest('changed') } }]) {
      await assert.rejects(
        h.store.reserveTeamMember(h.runId, {
          attemptId: h.attemptId,
          effectId: r.effectId,
          logicalName: r.logicalName,
          schema,
          resourceDigests: resources,
          ...changed
        }),
        error => error.issueCode === 'artifact-reservation-conflict'
      )
    }
    await assert.rejects(
      h.store.bindTeamMemberReservation(h.runId, {
        attemptId: h.attemptId,
        effectId: r.effectId,
        memberId: 'replacement-native-session',
        sessionId: 'session-primary'
      }),
      error => error.issueCode === 'artifact-member-binding-conflict'
    )
    assert.deepEqual(await h.store.get(h.runId), accepted)
  })

  test(`W2.7.2 ${backend}: two stores with stale reservation reads commit one opaque identity`, async t => {
    const h = await fixture(t, backend)
    const { runId } = await h.store.createRun(
      { scope: 'artifact', requestId: 'race', payloadFingerprint: digest('race') },
      digest('definition'),
      JSON.stringify(definition),
      '{}'
    )
    const { attemptId } = await h.store.recordIntent(runId, { nodeId: 'work', kind: 'agentTask', resourceDigests: resources })
    await h.store.bindTeamStage(runId, { stageId: 'work', teamId: 'lead', leadSessionId: 'lead', attemptId, taskSpecificationFingerprint: digest('task') })
    await h.store.bindTeamTask(runId, { taskId: 'task', taskRevision: 1 })
    const other = new RunStore(h.opened.domain)
    const before = await h.store.get(runId)
    const ready = Promise.withResolvers(),
      release = Promise.withResolvers()
    const get = other.get.bind(other)
    other.get = async (...args) => {
      const record = await get(...args)
      ready.resolve()
      await release.promise
      return record
    }
    t.after(() => {
      release.resolve()
      other.get = get
    })
    const args = { attemptId, effectId: 'spawn-primary', logicalName: 'primary', schema, resourceDigests: resources }
    const second = other.reserveTeamMember(runId, args)
    await ready.promise
    const first = await h.store.reserveTeamMember(runId, args)
    release.resolve()
    assert.deepEqual(await second, first)
    const after = await h.store.get(runId)
    assert.equal(after.seq, before.seq + 1)
    assert.deepEqual(after.teamStage.reservations, [first])
  })

  test(`W2.7.2 ${backend}: concurrent exact capture publishes one blob and one canonical binding`, async t => {
    const h = await fixture(t, backend)
    await h.spawn(h.reservations[0])
    const before = await h.store.get(h.runId)
    const [first, second] = await Promise.all([h.capture(h.reservations[0]), h.capture(h.reservations[0])])
    assert.deepEqual(second, first)
    const after = await h.store.get(h.runId)
    assert.equal(after.seq, before.seq + 1)
    assert.deepEqual(after.teamStage.captures, [first])
    assert.deepEqual(await readdir(join(h.runtimeRoot, 'store', 'team-output-artifacts')), [digest(first.artifactId)])
  })

  test(`W2.7.2 ${backend}: reservation/capture/cancel drift before canonical bind leaves blob unclaimed`, async t => {
    const h = await fixture(t, backend)
    await h.spawn(h.reservations[0])
    const ready = Promise.withResolvers(),
      release = Promise.withResolvers()
    const bind = h.store.bindTeamCaptureArtifact.bind(h.store)
    h.store.bindTeamCaptureArtifact = async (...args) => {
      ready.resolve()
      await release.promise
      return await bind(...args)
    }
    t.after(() => {
      release.resolve()
      h.store.bindTeamCaptureArtifact = bind
    })
    const rejected = assert.rejects(h.capture(h.reservations[0]), error => error.issueCode === 'artifact-stage-not-writable')
    await ready.promise
    await h.store.requestCancel(h.runId)
    const before = await h.store.get(h.runId)
    release.resolve()
    await rejected
    assert.deepEqual(await h.store.get(h.runId), before)
    assert.equal(before.teamStage.captures, undefined)
    assert.equal(before.attempts[0].result, undefined)
    assert.equal((await readdir(join(h.runtimeRoot, 'store', 'team-output-artifacts'))).length, 1)
  })
}

for (const location of ['runtime-root', 'artifact-root', 'artifact-directory', 'value-file', 'provenance-file']) {
  test(`W2.7.2: ${location} symlink is rejected and external sentinel is untouched`, async t => {
    const h = await fixture(t)
    const refs = await h.complete()
    const before = await h.store.get(h.runId)
    const sentinel = join(h.root, 'sentinel')
    await mkdir(sentinel)
    await writeFile(join(sentinel, 'value.json'), 'external sentinel')
    await writeFile(join(sentinel, 'provenance.json'), 'external sentinel')
    const target =
      location === 'runtime-root'
        ? h.runtimeRoot
        : location === 'artifact-root'
          ? join(h.runtimeRoot, 'store', 'team-output-artifacts')
          : location === 'artifact-directory'
            ? join(h.runtimeRoot, 'store', 'team-output-artifacts', digest(refs[0].artifactId))
            : h.path(refs[0], location === 'value-file' ? 'value.json' : 'provenance.json')
    await rename(target, `${target}.saved`)
    await symlink(location.endsWith('file') ? join(sentinel, location === 'value-file' ? 'value.json' : 'provenance.json') : sentinel, target)
    await assert.rejects(h.verify(), error =>
      location === 'runtime-root' ? error.code === 'DURABILITY_FAILED' : error.issueCode === 'artifact-physical-path-rejected'
    )
    if (location !== 'runtime-root') assert.deepEqual(await h.store.get(h.runId), before)
    assert.equal(await readFile(join(sentinel, 'value.json'), 'utf8'), 'external sentinel')
    assert.equal(await readFile(join(sentinel, 'provenance.json'), 'utf8'), 'external sentinel')
  })
}

test('W2.7.2: traversal artifact identity is rejected at the durable boundary and cannot access an external file', async t => {
  const h = await fixture(t)
  await h.complete()
  const sentinel = join(h.root, 'external.json')
  await writeFile(sentinel, 'unchanged')
  const before = await h.store.get(h.runId)
  await assert.rejects(
    h.store.transition(h.runId, draft => {
      draft.teamStage.captures[0].artifactId = '../../external.json'
    }),
    error => error.code === 'DURABILITY_FAILED'
  )
  assert.deepEqual(await h.store.get(h.runId), before)
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged')
})

test('W2.7.2: every provenance binding is checked before acceptance', async t => {
  const h = await fixture(t)
  const refs = await h.complete()
  const before = await h.store.get(h.runId)
  const changes = {
    runId: 'foreign-run',
    definitionRevision: 'foreign-definition',
    nodeId: 'other',
    stageId: 'other',
    attemptId: 'other',
    taskId: 'other',
    teamId: 'other',
    producerMemberId: h.reservations[1].memberId,
    logicalName: 'foreign',
    nativeName: 'bp-foreign',
    effectId: 'other',
    reservationSeq: 999,
    schemaDigest: digest('other'),
    schemaResourceId: 'other',
    schemaResourceDigest: digest('other'),
    resourceDigests: { ...resources, agent: digest('other') },
    evidence: { ...refs[0].evidence, producerSessionId: 'lead' }
  }
  for (const [field, changed] of Object.entries(changes)) {
    const prior = await h.store.get(h.runId)
    const ref = { ...refs[0], [field]: changed }
    const { evidenceDigest: _, ...facts } = ref
    ref.evidenceDigest = captureEvidenceDigest(facts)
    let rejectedAtDurableBoundary = false
    try {
      await h.store.transition(h.runId, draft => {
        draft.teamStage.captures[0] = ref
      })
    } catch (error) {
      assert.equal(error.code, 'DURABILITY_FAILED', field)
      rejectedAtDurableBoundary = true
    }
    if (rejectedAtDurableBoundary) {
      assert.deepEqual(await h.store.get(h.runId), prior)
      continue
    }
    await writeFile(h.path(refs[0], 'provenance.json'), canonicalJson(ref))
    await assert.rejects(h.verify(), TeamArtifactError, field)
    assert.equal((await h.store.get(h.runId)).attempts[0].result, undefined)
  }
  await h.store.transition(h.runId, draft => {
    draft.teamStage.captures = before.teamStage.captures
  })
  await writeFile(h.path(refs[0], 'provenance.json'), canonicalJson(refs[0]))
  assert.deepEqual((await h.verify()).primaryValue, value)
})

test('W2.7.2: publication fsync order precedes canonical reference, and fsync failure leaves no claim', async t => {
  const h = await fixture(t)
  await h.spawn(h.reservations[0])
  const events = []
  const originalSync = fs.fsyncSync,
    originalRename = fs.renameSync
  fs.fsyncSync = fd => {
    events.push(fs.fstatSync(fd).isFile() ? 'file-fsync' : 'dir-fsync')
    return originalSync(fd)
  }
  fs.renameSync = (...args) => {
    events.push('rename')
    return originalRename(...args)
  }
  syncBuiltinESMExports()
  const bind = h.store.bindTeamCaptureArtifact.bind(h.store)
  h.store.bindTeamCaptureArtifact = async (...args) => {
    events.push('bind')
    return await bind(...args)
  }
  try {
    await h.capture(h.reservations[0])
    const renameIndex = events.indexOf('rename')
    assert.equal(events.slice(0, renameIndex).filter(event => event === 'file-fsync').length, 2)
    assert.deepEqual(events.slice(renameIndex, renameIndex + 3), ['rename', 'dir-fsync', 'bind'])
    const before = await h.store.get(h.runId)
    await h.spawn(h.reservations[1])
    const ready = await h.store.get(h.runId)
    let didRename = false
    fs.renameSync = (...args) => {
      didRename = true
      return originalRename(...args)
    }
    fs.fsyncSync = fd => {
      if (didRename && fs.fstatSync(fd).isDirectory()) throw new Error('synthetic directory sync failure')
      return originalSync(fd)
    }
    syncBuiltinESMExports()
    await assert.rejects(h.capture(h.reservations[1]), error => error.issueCode === 'artifact-write-failed')
    assert.deepEqual(await h.store.get(h.runId), ready)
    assert.equal(ready.teamStage.captures.length, before.teamStage.captures.length)
    assert.equal(
      ready.teamStage.captures.some(ref => ref.producerMemberId === h.reservations[1].memberId),
      false
    )
    const blobs = await readdir(join(h.runtimeRoot, 'store', 'team-output-artifacts'))
    assert.equal(blobs.length, 2, 'published unreferenced blob is retained but not claimed')
  } finally {
    fs.fsyncSync = originalSync
    fs.renameSync = originalRename
    syncBuiltinESMExports()
    h.store.bindTeamCaptureArtifact = bind
  }
})

test('W2.7.2: frozen schema is revalidated on actual bytes after forged hashes and bindings', async t => {
  const h = await fixture(t)
  const refs = await h.complete()
  const bytes = Buffer.from(canonicalJson({ answer: 'schema-invalid', count: 'bad' }))
  const ref = { ...refs[0], digest: artifactDigest(bytes), byteLength: bytes.length }
  const { evidenceDigest: _, ...facts } = ref
  ref.evidenceDigest = captureEvidenceDigest(facts)
  await writeFile(h.path(refs[0]), bytes)
  await writeFile(h.path(refs[0], 'provenance.json'), canonicalJson(ref))
  await h.store.transition(h.runId, draft => {
    draft.teamStage.captures[0] = ref
    draft.teamStage.members.find(member => member.memberId === ref.producerMemberId).evidence.valueDigest = ref.digest
  })
  const before = await h.store.get(h.runId)
  await assert.rejects(h.verify(), error => error.issueCode === 'artifact-schema-invalid')
  assert.deepEqual(await h.store.get(h.runId), before)
})

test('W2.7.2: canonical stored bytes preserve existing JSON/string port semantics for numeric keys', async t => {
  const h = await fixture(t, 'json', { schema: { ...schema, properties: { ...schema.properties, 2: { type: 'integer' }, 10: { type: 'integer' } } } })
  const numeric = { ...value, 2: 2, 10: 10 }
  for (const r of h.reservations) {
    await h.spawn(r)
    await h.capture(r, numeric)
  }
  const verified = await h.verify()
  assert.deepEqual(verified.primaryValue, numeric)
  assert.deepEqual(verified.outputs.answer, numeric)
  assert.equal(verified.outputs.serialized, JSON.stringify(verified.primaryValue), 'string ports use the existing structured output wire encoding')
  const ref = (await h.store.get(h.runId)).teamStage.captures[0]
  assert.equal((await readFile(h.path(ref))).toString(), canonicalJson(numeric), 'physical agreement uses canonical stored JSON bytes')
  const accepted = await acceptTeamOutput(await h.acceptance())
  assert.deepEqual(accepted.attempts[0].result.outcome.outputs, verified.outputs)
})
