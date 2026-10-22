import assert from 'node:assert/strict'
import test from 'node:test'
import { searchBuiltinNodes } from '../../src/client/features/authoring/logic/graph/node-catalog.ts'
import { workflowHost } from './public-host-fixture.mjs'
import { echoDefinition, parentDefinition, save } from './child-fixtures.mjs'
import { managedBrowser } from './browser-fixture.mjs'
import { selectStyledOption } from '../../../../../test/blueprint/capabilities/styled-control-entry.mjs'

test('editor palette offers a discoverable child-blueprint call in both languages', () => {
  for (const query of ['blueprint', '子蓝图']) {
    assert.ok(
      searchBuiltinNodes(query).some(node => node.kind === 'blueprintCall'),
      `call palette entry missing for ${query}`
    )
  }
})

test('revision updates retain incompatible edges until explicit resolution and undo the whole change', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const first = await save(h.service, echoDefinition())
  await save(h.service, parentDefinition(first))
  const changed = echoDefinition()
  changed.graph.nodes[0].outputs = { next: 'number' }
  changed.graph.nodes[1].inputs = { next: 'number' }
  changed.graph.edges = [{ kind: 'data', from: 'in.next', to: 'out.next' }]
  const second = await save(h.service, changed, first.documentRevision)
  const { page, errors } = await managedBrowser(t, 'composition-ui.fixture.ts', h.service)
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), 'parent')
  await page.locator('.react-flow__node[data-id="call"] .bp-node-title').click()
  const read = () => page.evaluate(() => window.composition.state().definition)
  await page.locator(`[data-bp-child-candidate="${first.documentRevision}"]`).waitFor()
  const before = await read()
  await selectStyledOption(page, page.locator('[data-bp-child-revision]'), second.documentRevision)
  await page.locator(`[data-bp-child-candidate="${second.documentRevision}"]`).waitFor()
  assert.equal(await page.locator('[data-bp-child-apply]').isDisabled(), true)
  assert.equal((await read()).graph.edges.length, 2)
  assert.match(await page.locator('[data-bp-child-diff]').innerText(), /string.*∅/)
  await page.locator('[data-bp-child-cancel]').click()
  await page.locator(`[data-bp-child-candidate="${first.documentRevision}"]`).waitFor()
  assert.deepEqual(await read(), before)
  await selectStyledOption(page, page.locator('[data-bp-child-revision]'), second.documentRevision)
  await page.locator('[data-bp-child-disconnect]').check()
  await page.evaluate(() => window.composition.retainApply())
  await selectStyledOption(page, page.locator('[data-bp-child-revision]'), first.documentRevision)
  await page.locator(`[data-bp-child-candidate="${first.documentRevision}"]`).waitFor()
  await page.evaluate(() => window.composition.replayApply())
  assert.deepEqual(await read(), before, 'an old Apply callback cannot apply the previously selected revision')
  await selectStyledOption(page, page.locator('[data-bp-child-revision]'), second.documentRevision)
  await page.locator('[data-bp-child-disconnect]').check()
  await page.locator('[data-bp-child-apply]').click()
  const after = await read()
  assert.equal(after.graph.edges.length, 0)
  assert.equal(after.graph.nodes.find(n => n.id === 'call').blueprintRef.documentRevision, second.documentRevision)
  await page.locator('[data-bp-action="undo"]').click()
  assert.deepEqual((await read()).graph, before.graph)
  await page.locator('[data-bp-action="redo"]').click()
  assert.deepEqual((await read()).graph, after.graph)
  await page.locator('.react-flow__node[data-id="call"] .bp-node-title').click()
  await page.evaluate(() => window.composition.locale('zh'))
  await page.getByRole('button', { name: '预览子蓝图', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '预览子蓝图', exact: true }).waitFor()
  assert.deepEqual(errors, [])
})

test('a slow revision read cannot restore a deselected Inspector or edit another node', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const child = await save(h.service, echoDefinition())
  await save(h.service, parentDefinition(child))
  const { page, errors } = await managedBrowser(t, 'composition-ui.fixture.ts', h.service)
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), 'parent')
  const before = await page.evaluate(() => window.composition.state().definition)
  await page.evaluate(() => window.composition.delay())
  await page.locator('.react-flow__node[data-id="call"] .bp-node-title').click()
  await page.waitForFunction(() => window.composition.pending())
  await page.locator('.react-flow__node[data-id="out"] .bp-node-title').click()
  await page.evaluate(() => window.composition.release())
  await page.locator('[data-bp-node-inspector="out"]').waitFor()
  assert.equal(await page.locator('[data-bp-child-composition]').count(), 0)
  assert.deepEqual((await page.evaluate(() => window.composition.state().definition)).graph, before.graph)
  assert.deepEqual(errors, [])
})

test('reference inspection exposes exact historical ports and read-only graph without package contents', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const old = await save(h.service, echoDefinition())
  const changed = echoDefinition()
  changed.graph.nodes[0].outputs = { next: 'number' }
  changed.graph.nodes[1].inputs = { next: 'number' }
  changed.graph.edges = [{ kind: 'data', from: 'in.next', to: 'out.next' }]
  await save(h.service, changed, old.documentRevision)
  assert.equal(typeof h.service.inspectBlueprintReference, 'function', 'missing public exact-revision inspection')
  const view = await h.service.inspectBlueprintReference({ blueprintId: 'child', documentRevision: old.documentRevision })
  assert.equal(view.documentRevision, old.documentRevision)
  assert.deepEqual(view.inputs, { value: 'string' })
  assert.deepEqual(view.outputs, { value: 'string' })
  assert.equal(view.revisions.length, 2)
  assert.equal(view.graph.nodes.length, 2)
  for (const key of ['definitionJson', 'resources', 'packageFiles', 'files']) assert.equal(Object.hasOwn(view, key), false)
  await assert.rejects(h.service.inspectBlueprintReference({ blueprintId: 'child', documentRevision: '0'.repeat(64) }), {
    code: 'blueprint/reference-unavailable'
  })
})

test('hydrated production panel composes a pinned child with generated ports, undo, preview, save and reload', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  const child = await save(h.service, echoDefinition())
  const parent = echoDefinition('parent')
  parent.name = 'Parent'
  parent.graph.edges = []
  parent.presentation = { nodes: { in: { x: 50, y: 350 }, out: { x: 700, y: 350 } } }
  await save(h.service, parent)
  const { page, errors } = await managedBrowser(t, 'composition-ui.fixture.ts', h.service)
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), 'parent')
  await page.waitForFunction(() => window.composition?.state()?.id === 'parent')
  assert.equal(await page.locator('[data-bp-action="add-blueprintCall"]').count(), 1, 'child call must be addable in the production palette')
  await page.locator('[data-bp-action="add-blueprintCall"]').press('Enter')
  const inspector = page.locator('[data-bp-child-composition]')
  await inspector.waitFor()
  await selectStyledOption(page, inspector.locator('[data-bp-child-picker]'), 'child')
  await page.locator(`[data-bp-child-candidate="${child.documentRevision}"]`).waitFor()
  await inspector.locator('[data-bp-child-apply]').click()
  const read = () => page.evaluate(() => window.composition.state().definition)
  let current = await read()
  const node = current.graph.nodes.find(node => node.kind === 'blueprintCall')
  assert.deepEqual(node.blueprintRef, { blueprintId: 'child', documentRevision: child.documentRevision })
  assert.deepEqual(node.inputs, { value: 'string' })
  assert.deepEqual(node.outputs, { value: 'string' })
  await page.locator('[data-bp-action="undo"]').click()
  assert.equal((await read()).graph.nodes.find(n => n.id === node.id).blueprintRef, undefined, 'pin and ports undo together')
  await page.locator('[data-bp-action="redo"]').click()
  await page.locator(`.react-flow__node[data-id="${node.id}"] .bp-node-title`).click()
  await inspector.locator('[data-bp-child-preview]').click()
  await page.locator('[data-bp-child-preview-graph]').waitFor()
  assert.deepEqual(await read(), current, 'preview must never mutate the parent')
  await page.locator('[data-bp-child-preview-back]').click()
  const connect = async (from, to) => {
    const a = await from.boundingBox(),
      b = await to.boundingBox()
    assert.ok(a && b)
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 })
    await page.mouse.up()
  }
  const handle = (id, side) => page.locator(`.react-flow__node[data-id="${id}"] .react-flow__handle-${side}[data-handleid="data:value"]`)
  await connect(handle('in', 'right'), handle(node.id, 'left'))
  await connect(handle(node.id, 'right'), handle('out', 'left'))
  await page.waitForFunction(() => window.composition.state().definition.graph.edges.length === 2)
  await page.locator('[data-bp-action="save-layout"]').click()
  await page.locator('[data-bp-status-key="status.saved"]').waitFor()
  current = await read()
  const stored = await h.service.loadDefinition({ blueprintId: 'parent' })
  assert.deepEqual(JSON.parse(stored.definitionJson).graph, current.graph)
  await page.reload()
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), 'parent')
  await page.waitForFunction(() => window.composition?.state()?.id === 'parent')
  assert.deepEqual((await read()).graph, current.graph)
  await page.locator(`.react-flow__node[data-id="${node.id}"] .bp-node-title`).click()
  await page.locator('[data-bp-child-candidate]').waitFor()
  await page.screenshot({ path: '/tmp/dsh-blueprint-managed-composition-v1-evidence/w5-composition.png' })
  assert.deepEqual(errors, [])
})

test('new Agent nodes default to managed and the Inspector explicitly switches legacy behavior', async t => {
  const h = await workflowHost(t, { preset: 'danger-full-access' })
  await save(h.service, echoDefinition('parent'))
  const { page, errors } = await managedBrowser(t, 'composition-ui.fixture.ts', h.service)
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), 'parent')
  await page.locator('[data-bp-action="add-agentTask"]').press('Enter')
  const input = page.locator('[data-bp-field="interaction"]')
  await input.waitFor()
  const read = () => page.evaluate(() => window.composition.state().definition.graph.nodes.find(n => n.kind === 'agentTask'))
  assert.equal((await read()).interaction, 'managed')
  await selectStyledOption(page, input, 'legacy')
  assert.equal((await read()).interaction, undefined)
  await selectStyledOption(page, input, 'managed')
  assert.equal((await read()).interaction, 'managed')
  await page.locator('[data-bp-action="undo"]').click()
  assert.equal((await read()).interaction, undefined)
  assert.deepEqual(errors, [])
})
