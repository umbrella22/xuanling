import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repositoryRoot = fileURLToPath(new URL('../../../../../', import.meta.url))
const collectorPath = resolve(repositoryRoot, 'test/blueprint/capabilities/teamstage-live-collector.mjs')

test('public Team graph collector guards live mode before fixture fallback in a clean checkout', () => {
  const source = readFileSync(collectorPath, 'utf8')
  assert.match(source, /teamstage-live\.mjs/)
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BP_LIVE_TEAM_')))
  const child = spawnSync(process.execPath, [collectorPath, '--mode', 'live'], { env, encoding: 'utf8' })
  assert.equal(child.error, undefined)
  assert.equal(child.signal, null)
  assert.equal(child.status, 1)
  assert.deepEqual(JSON.parse(child.stdout), {
    status: 'not_run', failure: 'LIVE_TEAM_CONFIGURATION_MISSING', key_read: false, provider_calls: 0,
  })
})
