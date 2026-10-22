import assert from 'node:assert/strict'
import test from 'node:test'
import { nestedManagedRun } from './nested-managed-fixture.mjs'
import { managedBrowser } from './browser-fixture.mjs'

test('the main Session defaults to the parent Run; a node can inspect its verified ancestors without changing them', async t => {
  const h = await nestedManagedRun(t)
  const root = await h.service.inspectSession({ sessionId: h.caller.session.id })
  assert.equal(root.selected.run.runId, h.rootRunId, 'the latest child must not displace the root workflow')
  const child = await h.service.inspectSession({ sessionId: h.agent.session.id })
  assert.equal(child.selected.run.runId, h.childRunId)
  assert.equal(child.selected.ancestors[0].runId, h.rootRunId)
  const before = await h.runtime.store.get(h.rootRunId)
  const parent = await h.service.inspectSession({ sessionId: h.agent.session.id, runId: h.rootRunId })
  assert.equal(parent.selected.run.runId, h.rootRunId)
  assert.deepEqual(await h.runtime.store.get(h.rootRunId), before)
  assert.equal(typeof h.service.inspectRunView, 'function', 'canvas requires a read-only frozen Run graph')
  const preview = await h.service.inspectRunView({ runId: h.childRunId })
  assert.equal(preview.graph.nodes.find(n => n.id === 'work').interaction, 'managed')
  assert.equal(preview.ancestors[0].runId, h.rootRunId)
  await assert.rejects(h.service.inspectSession({ sessionId: 'unrelated', runId: h.rootRunId }), { code: 'blueprint/run-not-found' })
})

test('hydrated runtime view follows the real child and Session, keeps breadcrumbs and never edits the graph', async t => {
  const h = await nestedManagedRun(t)
  const before = (await h.runtime.store.get(h.rootRunId)).definitionJson
  const { page, calls, errors } = await managedBrowser(t, 'runtime-navigation.fixture.ts', h.service, { sessionId: h.caller.session.id })
  await page.locator(`[data-bp-conversation][data-bp-run-id="${h.rootRunId}"]`).waitFor()
  await page.locator(`[data-bp-open-child="${h.childRunId}"]`).click()
  await page.locator(`[data-bp-conversation][data-bp-run-id="${h.childRunId}"]`).waitFor()
  await page.locator(`[data-bp-breadcrumb="${h.rootRunId}"]`).waitFor()
  const node = (await h.runtime.store.get(h.childRunId)).attempts.find(a => a.nodeId === 'work')
  await page.locator(`[data-bp-open-attempt="${node.attemptId}"]`).click()
  assert.deepEqual(await page.evaluate(() => window.runtimeView.openCalls), [h.agent.session.id])
  await page.locator(`[data-bp-breadcrumb="${h.rootRunId}"]`).click()
  await page.locator(`[data-bp-conversation][data-bp-run-id="${h.rootRunId}"]`).waitFor()
  assert.equal((await h.runtime.store.get(h.rootRunId)).definitionJson, before)
  assert.equal(
    calls.some(call => /save|start|message|apply|revert/i.test(call.method)),
    false
  )
  assert.deepEqual(errors, [])
})

test('canvas Inspector opens frozen child runtime and never offers human approval for managed waiting', async t => {
  const h = await nestedManagedRun(t)
  const { selectStyledOption } = await import('../../../../../test/blueprint/capabilities/styled-control-entry.mjs')
  const { page, calls, errors } = await managedBrowser(t, 'composition-ui.fixture.ts', h.service)
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), 'parent')
  await page.locator('[data-bp-disclosure-toggle="run"]').click()
  await page.locator('input[name="runId"]').fill(h.rootRunId)
  await page.locator('[data-bp-action="inspect-run"]').click()
  await page.locator(`[data-bp-run-preview-open="${h.childRunId}"]`).click()
  await page.locator(`[data-bp-run-preview="${h.childRunId}"]`).waitFor()
  await page.screenshot({ path: '/tmp/dsh-blueprint-managed-composition-v1-evidence/w5-runtime-preview.png' })
  await page.locator(`[data-bp-breadcrumb="${h.rootRunId}"]`).click()
  await page.locator(`[data-bp-run-preview="${h.rootRunId}"]`).waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('dialog[open]').count(), 0)
  await page.locator('input[name="runId"]').fill(h.childRunId)
  await page.locator('[data-bp-action="inspect-run"]').click()
  await page.locator('[data-bp-managed-waiting]').waitFor()
  assert.equal(await page.locator('[data-bp-action="approve"]').count(), 0)
  assert.equal(await page.locator('[data-bp-action="reject"]').count(), 0)
  assert.equal(
    calls.some(call => /save|start|message|apply|revert/i.test(call.method)),
    false
  )
  assert.deepEqual(errors, [])
})
