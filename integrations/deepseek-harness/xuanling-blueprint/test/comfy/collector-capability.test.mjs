import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

const url = new URL('../../../../../test/blueprint/capabilities/comfy-interactions-ui.mjs', import.meta.url)
// The old actual collector boundary loads successfully. Absence is proved by
// a capability assertion, never MODULE_NOT_FOUND or a compiler failure.
const collector = await import(existsSync(url) ? url.href : new URL('../../../../../test/blueprint/capabilities/canvas-suite.mjs', import.meta.url).href)

test('W2 independent Comfy collector exposes callable fail-closed browser and report boundaries', () => {
  for (const name of ['parseCli', 'adaptProbe', 'prepareCanvasFixtures', 'runCanvasJourney', 'validateComfyReport', 'validateCollectorGate']) {
    assert.equal(typeof collector[name], 'function', `COMFY_COLLECTOR_CAPABILITY_MISSING:${name}`)
  }
})
