import test from 'node:test'
import assert from 'node:assert/strict'
import { TeamNativeAdapter, TeamCapabilityUnavailableError } from '../../src/teamstage/native-adapter.ts'

test('W2.6 C-01/C-08 optional native Team capability resolves through Context.get without undeclared service property reads', () => {
  const lead = { id: 'lead' }
  const team = {
    membership: agent => ({ root: agent, id: 'lead', role: 'lead', name: 'lead' }),
    listMembers() {},
    spawnTeammate() {},
    sendMessage() {},
    createTask() {},
    getTask() {},
    listTasks() {},
    updateTask() {},
    waitForChange() {},
    interrupt() {}
  }
  const agents = { get: id => (id === lead.id ? lead : undefined) }
  const values = new Map([
    ['agents', agents],
    ['agentTeams', team]
  ])
  const context = {
    get: key => values.get(key),
    get agents() {
      throw new Error('UNDECLARED_SERVICE_PROPERTY')
    },
    get agentTeams() {
      throw new Error('UNDECLARED_SERVICE_PROPERTY')
    }
  }
  const adapter = new TeamNativeAdapter(context)
  assert.equal(adapter.lead(lead).teamId, 'lead')
  values.delete('agentTeams')
  assert.throws(() => adapter.lead(lead), TeamCapabilityUnavailableError)
})
