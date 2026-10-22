import test from 'node:test'
import assert from 'node:assert/strict'
import { nestedManagedRun } from './nested-managed-fixture.mjs'
import { textResponse, toolResponse } from './public-host-fixture.mjs'
import { managedBrowser } from './browser-fixture.mjs'

test('hydrated managed composer retains an uncertain draft, retries one request and closes at completion', async t => {
  const h = await nestedManagedRun(t, [
    textResponse('Please clarify'),
    textResponse('I will focus on cancellation'),
    toolResponse('structured_output', { text: 'reviewed' })
  ])
  const { page, calls, errors } = await managedBrowser(t, 'managed-composer.fixture.ts', h.service, { sessionId: h.agent.session.id })
  await page.locator('[data-bp-managed-composer]').waitFor()
  await page.locator('[data-bp-managed-input]').fill('Focus on cancellation')
  await page.evaluate(() => window.composer.select('unrelated'))
  await page.locator('[data-native-composer]').waitFor()
  await page.evaluate(id => window.composer.select(id), h.agent.session.id)
  assert.equal(await page.locator('[data-bp-managed-input]').inputValue(), 'Focus on cancellation')
  await page.evaluate(() => window.composer.dropReceipt())
  await page.locator('[data-bp-managed-send]').click()
  await page.locator('[data-bp-managed-retry]').waitFor()
  assert.equal(await page.locator('[data-bp-managed-input]').inputValue(), 'Focus on cancellation')
  await page.locator('[data-bp-managed-retry]').click()
  await page.waitForFunction(() => document.querySelector('[data-bp-managed-input]').value === '')
  const sent = calls.filter(call => call.method === 'messageNode')
  assert.equal(sent.length, 2)
  assert.deepEqual(sent[0].args, sent[1].args)
  const record = await h.runtime.store.get(h.childRunId)
  assert.equal(record.attempts.find(a => a.nodeId === 'work').messages.length, 1)
  await page.screenshot({ path: '/tmp/dsh-blueprint-managed-composition-v1-evidence/w5-managed-composer.png' })
  await page.evaluate(() => window.composer.locale('zh'))
  await page.getByLabel('给当前节点的消息').fill('完成这次审查')
  await page.locator('[data-bp-managed-send]').click()
  await h.runtime.jobs.get(h.rootRunId)
  await page.locator('[data-bp-managed-closed]').waitFor()
  assert.equal(await page.locator('[data-bp-managed-input]').isDisabled(), true)
  assert.equal((await h.runtime.store.get(h.rootRunId)).state, 'succeeded')
  await page.evaluate(() => window.composer.select('unrelated'))
  await page.locator('[data-native-composer]').waitFor()
  assert.deepEqual(errors, [])
})
