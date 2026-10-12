import assert from 'node:assert/strict'
import test from 'node:test'
import * as adapter from '../../src/host/tool-adapter.ts'
import { scriptPolicyCases } from './script-policy.mjs'

for (const c of scriptPolicyCases(adapter)) {
  test(`C-07 ${c.id}: ${c.title}`, async () => {
    const result = await c.run()
    assert.equal(result.ok, true)
  })
}

test('C-07 internal primitive pre-abort never serializes arguments or spawns', async () => {
  const controller = new AbortController(); controller.abort()
  const result = await adapter.runScript(Buffer.from('throw new Error("must not spawn")'), {
    get canary() { throw new Error('pre-abort must not serialize') },
  }, { signal: controller.signal })
  assert.equal(result.kind, 'cancelled')
  assert.equal(result.effect, 'not-started')
  assert.equal(result.ok, false)
})
