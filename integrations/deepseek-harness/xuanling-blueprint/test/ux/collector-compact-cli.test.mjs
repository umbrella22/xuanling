import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseCli as comfy, PLAN_ID as oldPlan } from '../../../../../test/blueprint/capabilities/comfy-interactions-ui.mjs'
import { parseCli as motion, validateMotionCase } from '../../../../../test/blueprint/capabilities/comfy-motion-ui.mjs'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '')
const compact = 'dsh-blueprint-compact-ux-v1'
for (const [name, parse] of [['Comfy', comfy], ['motion', motion]]) {
  test(`${name} actual callable CLI accepts the explicit compact plan and its new confined W2 output`, () => {
    const reportDir = `${root}/docs/validation/blueprint/current/compact-ux/w2/new-${name}`
    assert.deepEqual(parse(['--plan-id', compact, '--report-dir', reportDir]), { planId: compact, reportDir })
  })
  test(`${name} keeps old mode and refuses cross-plan report paths`, () => {
    const reportDir = `${root}/docs/validation/blueprint/current/comfy-interactions/${name === 'motion' ? 'w3' : 'w2'}/fresh-native`
    assert.deepEqual(parse(['--plan-id', oldPlan, '--report-dir', reportDir]), { planId: oldPlan, reportDir })
    assert.throws(() => parse(['--plan-id', compact, '--report-dir', reportDir]))
    assert.throws(() => parse(['--plan-id', oldPlan, '--report-dir', `${root}/docs/validation/blueprint/current/compact-ux/w2/native`]))
    for (const path of [`${root}/test/blueprint/reports/compact-ux/w2/native`, `${root}/docs/validation/blueprint/archives/compact-ux/w2/native`,
      `${root}/docs/validation/blueprint/current/compact-ux/w2`, `${root}/docs/validation/blueprint/current/compact-ux/w2/../w1/collector-b`,
      `${root}/docs/validation/blueprint/current/compact-ux/w1/collector-b`, `${root}/docs/validation/blueprint/current/compact-ux/w2/native\n`])
      assert.throws(() => parse(['--plan-id', compact, '--report-dir', path]))
  })
}
test('loaded existing motion validator rejects missing and wrong cases rather than accepting an unverified compact receipt', () => {
  assert.throws(() => validateMotionCase({ passed: true, facts: {} }), /unknown motion case/)
  assert.throws(() => validateMotionCase({ id: 'UX-RETENTION', passed: true, facts: { before: { graph: {} }, after: { graph: {} } } }), /unknown motion case/)
  assert.throws(() => validateMotionCase({ id: 'CM-DIRECTED', passed: true, facts: {} }), /motion raw fixture/)
})
