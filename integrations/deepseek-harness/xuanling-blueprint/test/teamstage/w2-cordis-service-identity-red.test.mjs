import test from 'node:test'
import assert from 'node:assert/strict'
import { TeamNativeAdapter } from '../../src/teamstage/native-adapter.ts'

test('W2 red: Cordis ctx.get fresh service proxies preserve native Team operations', async () => {
  const lead = { id: 'lead' }
  const live = new Map([['lead', lead]])
  const calls = []
  let proxyReads = 0

  // Cordis may expose a fresh proxy for each public Context.get() lookup while
  // preserving one underlying Team service. Native authorization must follow
  // the stable service identity instead of comparing proxy object identity.
  const stableService = {
    membership: agent => ({ root: agent, id: 'team-1', role: 'lead', name: 'lead' }),
    listMembers: agent => {
      calls.push(['listMembers', agent])
      return [{ id: agent.id, role: 'lead' }]
    },
    spawnTeammate: async () => ({}),
    sendMessage: async () => ({}),
    createTask: async (agent, request) => {
      calls.push(['createTask', agent, request])
      return { id: 'task-1', revision: 1, status: 'pending' }
    },
    getTask: () => ({ id: 'task-1', revision: 1, status: 'pending' }),
    listTasks: () => [],
    updateTask: async () => ({ id: 'task-1', revision: 2, status: 'completed' }),
    waitForChange: async () => ({ timedOut: true }),
    interrupt: () => ({ previousStatus: 'inactive' })
  }

  const serviceProxy = () =>
    new Proxy(stableService, {
      get(target, property, receiver) {
        proxyReads++
        return Reflect.get(target, property, receiver)
      }
    })

  const context = {
    get(key) {
      if (key === 'agents') return { get: id => live.get(id) }
      if (key === 'agentTeams') return serviceProxy()
      return undefined
    }
  }

  const adapter = new TeamNativeAdapter(context)
  const handle = adapter.lead(lead)
  assert.equal(handle.teamId, 'team-1')

  assert.deepEqual(adapter.listMembers(handle), [{ id: 'lead', role: 'lead' }])
  const task = await adapter.createTask(handle, { subject: 'subject', description: 'description' })
  assert.deepEqual(task, { id: 'task-1', revision: 1, status: 'pending' })
  assert.deepEqual(calls, [
    ['listMembers', lead],
    ['createTask', lead, { subject: 'subject', description: 'description' }]
  ])
  assert.ok(proxyReads > 1, 'native operations should resolve agentTeams through ctx.get repeatedly')
})
