import test from 'node:test'
import assert from 'node:assert/strict'

async function load(path) {
  return await import(path).catch(() => undefined)
}

test('W2 RED C-01/C-08: native adapter feature-detects TeamService and exact Lead identity', async () => {
  const mod = await load('../../src/teamstage/native-adapter.ts')
  assert.ok(mod, 'W2 native Team adapter is missing')
  assert.equal(typeof mod.TeamNativeAdapter, 'function')
  assert.equal(typeof mod.TeamCapabilityUnavailableError, 'function')
})

test('W2 RED C-02/C-03: task binding owns Lead create and revision-CAS updates', async () => {
  const mod = await load('../../src/teamstage/task-binding.ts')
  assert.ok(mod, 'W2 task binding seam is missing')
  assert.equal(typeof mod.createBoundTeamTask, 'function')
  assert.equal(typeof mod.updateBoundTeamTask, 'function')
})

test('W2 RED C-03/C-04: Team effects have durable intent/result provenance', async () => {
  const mod = await load('../../src/teamstage/runner.ts')
  assert.ok(mod, 'W2 Team effect runner is missing')
  assert.equal(typeof mod.TeamStageRunner, 'function')
  assert.equal(typeof mod.TeamEffectUnknownError, 'function')
})

test('W2 RED C-05/C-06: cancellation interrupts only owned resources and records recovery', async () => {
  const mod = await load('../../src/teamstage/cancellation.ts')
  assert.ok(mod, 'W2 owned cancellation seam is missing')
  assert.equal(typeof mod.cancelOwnedTeamStage, 'function')
})

test('W2 RED C-04/C-08: strict Team output acceptance rejects missing checks and raw fields', async () => {
  const mod = await load('../../src/teamstage/acceptance.ts')
  assert.ok(mod, 'W2 structured acceptance seam is missing')
  assert.equal(typeof mod.acceptTeamOutput, 'function')
  assert.equal(typeof mod.TeamAcceptanceRejectedError, 'function')
})
