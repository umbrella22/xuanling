import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BlueprintService } from '../../src/index.ts'
import { openBlueprintDomain, RunStore } from '../../src/persistence/index.ts'

const digest = value => createHash('sha256').update(value).digest('hex')
let fixtureNumber = 0

test('W2.7.3 red: cancelRun settles the source Team through owned drain and task CAS', async () => {
  const root = await mkdtemp(join(tmpdir(), `xuanling-w273-wiring-${fixtureNumber++}-`))
  const opened = await openBlueprintDomain({ path: join(root, 'store') })
  const store = new RunStore(opened.domain)
  const lead = { id: 'lead-session', session: { id: 'lead-session', header: { origin: 'root' } } }
  const members = [
    {
      memberId: 'member-owned',
      name: 'owned-a',
      sessionId: 'child-a',
      phase: 'active',
      status: 'running'
    }
  ]
  const calls = { interrupts: [], drains: [], taskUpdates: [] }
  const task = { id: 'task-owned', revision: 7, status: 'in_progress' }
  const team = {
    membership(agent) {
      return { root: agent, id: 'team-owned', role: 'lead', name: 'lead' }
    },
    listMembers() {
      return members.map(member => ({ id: member.sessionId, name: member.name, role: 'teammate', status: member.status }))
    },
    spawnTeammate() {
      return Promise.reject(new Error('unused'))
    },
    sendMessage() {
      return Promise.reject(new Error('unused'))
    },
    createTask() {
      return Promise.reject(new Error('unused'))
    },
    getTask(_agent, taskId) {
      assert.equal(taskId, task.id)
      return structuredClone(task)
    },
    listTasks() {
      return [structuredClone(task)]
    },
    updateTask(_agent, request) {
      calls.taskUpdates.push({ ...request })
      assert.equal(request.taskId, task.id)
      assert.equal(request.expectedRevision, task.revision)
      task.revision++
      task.status = 'deleted'
      return Promise.resolve(structuredClone(task))
    },
    waitForChange() {
      return Promise.resolve({ timedOut: true })
    },
    interrupt(_agent, name) {
      calls.interrupts.push(name)
      return { previousStatus: 'running' }
    }
  }
  const subagents = {
    drainChildren(_agent, childIds) {
      calls.drains.push([...childIds])
      return Promise.resolve()
    }
  }
  const values = new Map([
    ['agents', { get: id => (id === lead.id ? lead : undefined) }],
    ['agentTeams', team],
    ['subagents', subagents]
  ])
  const service = Object.create(BlueprintService.prototype)
  service.ctx = { get: key => values.get(key) }
  service.checkArgs = () => {}
  service.configuredRuntime = async () => ({ store, controllers: new Map(), cancellationTails: new Map() })

  try {
    const { runId } = await store.createRun(
      { scope: 'teamstage', requestId: `w2-7-3-wiring-${fixtureNumber}`, payloadFingerprint: digest(root) },
      digest('definition'),
      '{}',
      '{}',
      { source: { sessionId: lead.id, kind: 'ui' } }
    )
    await store.bindTeamStage(runId, {
      stageId: 'stage-owned',
      teamId: 'team-owned',
      leadSessionId: lead.id,
      taskSpecificationFingerprint: digest('task')
    })
    await store.bindTeamTask(runId, { taskId: task.id, taskRevision: task.revision })
    await store.updateTeamStage(runId, { state: 'active', members })

    const result = await service.cancelRun({ runId })

    assert.equal(result.state, 'cancelled')
    assert.deepEqual(calls.interrupts, ['owned-a'])
    assert.deepEqual(calls.drains, [['child-a']])
    assert.deepEqual(calls.taskUpdates, [{ taskId: task.id, expectedRevision: 7, action: 'delete' }])
    const record = await store.get(runId)
    assert.equal(record.state, 'cancelled')
    assert.equal(record.teamStage?.state, 'cancelled')
    assert.equal(record.teamStage?.cancel !== undefined, true)
  } finally {
    await opened.close()
    await rm(root, { recursive: true, force: true })
  }
})
