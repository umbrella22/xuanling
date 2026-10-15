import assert from 'node:assert/strict'
import test from 'node:test'
import { ConversationController } from '../../src/client/conversation-controller.ts'
import { inspectSessionCodec } from '../../src/conversation/contracts.ts'

const clone = value => structuredClone(value)
function bound(seq = 1) {
  const team = {
    schemaVersion: 1,
    runId: 'run',
    stageId: 'work',
    teamId: 'lead',
    leadSessionId: 'lead',
    attemptId: 'attempt',
    taskId: 'task',
    taskRevision: 2,
    taskSpecificationFingerprint: 'a'.repeat(64),
    state: 'active',
    updatedAt: seq,
    members: [{ memberId: 'producer', name: 'producer', phase: 'active', status: 'running', sessionId: 'child' }]
  }
  return {
    status: 'bound',
    sessionId: 'lead',
    runs: [{ runId: 'run', state: 'running', createdAt: 1, definitionRevision: 'frozen' }],
    selected: {
      run: {
        runId: 'run',
        state: 'running',
        definitionRevision: 'frozen',
        seq,
        logTail: [],
        attempts: [{ attemptId: 'attempt', nodeId: 'work', attempt: 1, state: 'running' }],
        team
      },
      source: { sessionId: 'lead', kind: 'tool', callId: 'start-call', turn: 1 },
      graph: {
        nodes: [
          { id: 'work', kind: 'agentTask' },
          { id: 'output', kind: 'output' }
        ],
        edges: []
      },
      focusAttemptIds: ['attempt'],
      team: clone(team)
    }
  }
}
function acceptance(team) {
  return {
    schemaVersion: 1,
    code: 'accepted',
    runId: team.runId,
    stageId: team.stageId,
    taskId: team.taskId,
    attemptId: team.attemptId,
    sourceSessionId: 'child',
    artifactId: 'artifact',
    digest: 'b'.repeat(64),
    evidenceDigest: 'c'.repeat(64),
    checks: ['schema', 'digest']
  }
}
function mutateTeam(value, change) {
  change(value.selected.run.team)
  value.selected.team = clone(value.selected.run.team)
}
async function reader() {
  let response = bound()
  const reads = []
  const host = new Proxy(
    {
      async inspectSession(args) {
        reads.push(args)
        return response
      }
    },
    {
      get(target, key) {
        assert.equal(key, 'inspectSession', 'navigation must remain read-only')
        return target[key]
      }
    }
  )
  const controller = new ConversationController(host, 'lead')
  await controller.refresh()
  assert.equal(controller.getSnapshot().connection, 'connected', 'valid aggregate control')
  return {
    controller,
    reads,
    set(value) {
      response = value
    }
  }
}

for (const [name, change] of [
  [
    'foreign Run',
    value =>
      mutateTeam(value, team => {
        team.runId = 'other-run'
      })
  ],
  [
    'missing stage',
    value =>
      mutateTeam(value, team => {
        team.stageId = 'absent'
      })
  ],
  [
    'non-Agent stage',
    value => {
      value.selected.graph.nodes[0].kind = 'input'
    }
  ],
  [
    'foreign Attempt',
    value =>
      mutateTeam(value, team => {
        team.attemptId = 'other-attempt'
      })
  ],
  [
    'Attempt on another node',
    value => {
      value.selected.run.attempts[0].nodeId = 'output'
    }
  ],
  [
    'foreign Lead',
    value =>
      mutateTeam(value, team => {
        team.leadSessionId = 'other-lead'
      })
  ],
  [
    'divergent selected Team',
    value => {
      value.selected.team.taskId = 'other-task'
    }
  ],
  [
    'foreign output task',
    value =>
      mutateTeam(value, team => {
        team.outputAcceptance = { ...acceptance(team), taskId: 'other-task' }
      })
  ],
  [
    'foreign output Attempt',
    value =>
      mutateTeam(value, team => {
        team.outputAcceptance = { ...acceptance(team), attemptId: 'other-attempt' }
      })
  ],
  [
    'foreign output producer',
    value =>
      mutateTeam(value, team => {
        team.outputAcceptance = { ...acceptance(team), sourceSessionId: 'other-child' }
      })
  ]
]) {
  test(`W3 C-07/C-08: structurally valid ${name} cannot replace the selected canonical aggregate`, async () => {
    const f = await reader(),
      previous = f.controller.getSnapshot().value
    const invalid = bound(2)
    change(invalid)
    assert.equal(inspectSessionCodec().safeParse(invalid).success, true, 'the red must concern aggregate binding, not shape parsing')
    f.set(invalid)
    await f.controller.refresh()
    assert.equal(f.controller.getSnapshot().connection, 'stale', name)
    assert.equal(f.controller.getSnapshot().errorCode, 'blueprint/dto-invalid')
    assert.deepEqual(f.controller.getSnapshot().value, previous, 'retain the previous canonical cut')
    assert.equal(f.reads.length, 2)
  })
}

for (const [name, change] of [
  [
    'task revision regression',
    team => {
      team.taskRevision = 1
    }
  ],
  [
    'task replacement',
    team => {
      team.taskId = 'replacement'
    }
  ],
  [
    'task specification replacement',
    team => {
      team.taskSpecificationFingerprint = 'd'.repeat(64)
    }
  ]
]) {
  test(`W3 C-07: newer Run sequence cannot conceal ${name}`, async () => {
    const f = await reader(),
      previous = f.controller.getSnapshot().value
    const invalid = bound(2)
    mutateTeam(invalid, change)
    f.set(invalid)
    await f.controller.refresh()
    assert.equal(f.controller.getSnapshot().connection, 'stale')
    assert.deepEqual(f.controller.getSnapshot().value, previous)
  })
}

test('W3 C-03/C-09: member lifecycle, accepted output and native child selection remain distinct and readable', async () => {
  const f = await reader(),
    value = bound(2)
  mutateTeam(value, team => {
    team.state = 'succeeded'
    team.members[0].status = 'inactive'
    team.outputAcceptance = acceptance(team)
  })
  value.selected.run.state = 'succeeded'
  value.selected.run.attempts[0].state = 'succeeded'
  f.set(value)
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().connection, 'connected')
  assert.equal(f.controller.getSnapshot().value.selected.run.team.state, 'succeeded')
  const child = clone(value)
  child.sessionId = 'child'
  f.controller.setSession('child')
  f.set(child)
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().connection, 'connected', 'Lead identity binds to source, not the inspected child')
})

test('W3 C-09: ordinary Run with no Team remains readable without Team capability', async () => {
  const f = await reader(),
    value = bound(2)
  delete value.selected.run.team
  delete value.selected.team
  f.controller.setSession('plain')
  value.sessionId = 'plain'
  f.set(value)
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().connection, 'connected')
  assert.equal(f.controller.getSnapshot().value.selected.run.team, undefined)
})

test('W3 C-07: a wall-clock change does not override the newer canonical sequence', async () => {
  const f = await reader(),
    value = bound(2)
  mutateTeam(value, team => {
    team.updatedAt = 0
  })
  f.set(value)
  await f.controller.refresh()
  assert.equal(f.controller.getSnapshot().connection, 'connected')
  assert.equal(f.controller.getSnapshot().value.selected.run.seq, 2)
})
