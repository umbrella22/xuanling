import { selectStyledOption, styledSelectValue } from './styled-control-entry.mjs'
/** Isolated installed DSH UI acceptance. No ambient provider or user data. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { prepareProfile, bootHost, stopHost, isolatedEnvironment } from './conversation-runtime.mjs'
import { launchOwnedEdge } from './comfy-motion-ui.mjs'
import { setNativeTheme } from './i18n-workspace-journey.mjs'
import { preparePublicAction } from './compact-ui-entry.mjs'
import { performanceDefinition, fixtureEvidence } from './canvas-fixtures.mjs'
import { measureCanvasPerformance } from './canvas-journey.mjs'
import { verifyArchiveDownload } from './comfy-interactions-ui.mjs'

if (process.argv.includes('--help')) {
  console.log(
    'node --experimental-transform-types test/blueprint/capabilities/authoring-ui.mjs --report-dir <fresh absolute directory>\nInstalls current artifact in an isolated DSH profile; tests JSON editor, current exports, deletion and restart. No provider calls.'
  )
  process.exit(0)
}
assert.equal(process.argv[2], '--report-dir')
const reportDir = resolve(process.argv[3])
mkdirSync(reportDir, { recursive: true })
const root = mkdtempSync(join(realpathSync(tmpdir()), 'bp-authoring-ui-'))
const receipt = {
  planId: 'dsh-blueprint-agent-authoring-v1',
  startedAt: new Date().toISOString(),
  providerEvidence: false,
  steps: [],
  checks: [],
  errors: []
}
let host, edge, page
const check = (name, value) => {
  assert.ok(value, name)
  receipt.checks.push(name)
  console.log(name)
}
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const resourceDescription = '用于代码审查的工具集，支持依赖检查、变更追踪和证据整理；完整简介应通过悬停提示展示，卡片内仅显示单行，过长内容使用省略号隐藏。 '.repeat(3).trim()
const definition = id => ({
  schemaVersion: 1,
  id,
  name: `JSON editor ${id}`,
  resources: { tools: { kind: 'mcp', bindingId: 'fixture' } },
  graph: {
    nodes: [
      { id: 'input', kind: 'input', outputs: { result: 'json' } },
      { id: 'output', kind: 'output', inputs: { result: 'json' } }
    ],
    edges: [{ kind: 'data', from: 'input.result', to: 'output.result' }]
  },
  presentation: {
    nodes: { input: { x: 30, y: 70 }, output: { x: 350, y: 70 } },
    resources: { tools: { title: '审查工具', description: resourceDescription } }
  }
})
const apiFor = async authUrl => {
  const url = new URL(authUrl)
  const auth = await fetch(authUrl, { redirect: 'manual' })
  const cookie = auth.headers
    .getSetCookie()
    .map(c => c.split(';')[0])
    .join('; ')
  return async (method, args) => {
    assert.ok(['createDefinition', 'listDefinitions', 'loadDefinition', 'preflightRun', 'startRun', 'inspectRun', 'deleteDefinition'].includes(method))
    const response = await fetch(`${url.origin}/api/blueprint/${method}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: `blueprint/${method}`,
        payload: { args: args === undefined ? {} : { args } }
      })
    })
    const body = await response.json()
    assert.equal(body.result?.ok, true, JSON.stringify(body))
    return body.result.value
  }
}
try {
  const performance = performanceDefinition()
  const performanceRoot = join(root, 'performance')
  mkdirSync(join(performanceRoot, 'lib/agents'), { recursive: true })
  writeFileSync(join(performanceRoot, 'blueprint.json'), JSON.stringify(performance))
  for (const ref of Object.values(performance.resources)) writeFileSync(join(performanceRoot, ref.path), 'Performance fixture agent.\n')
  const config = { blueprints: { [performance.id]: performanceRoot } }
  const profile = await prepareProfile(
    { mode: 'keyless', installMode: 'cli', pnpmExecutable: process.env.BP_AUTHORING_PNPM },
    { prepare: async () => config },
    root,
    receipt.steps
  )
  // Exercise the actual profile fallback used by a fresh ordinary install.
  const patch = join(profile.profileDir, 'cordis.patch.yml')
  const source = readFileSync(patch, 'utf8')
  writeFileSync(patch, source.replace(/(- id: xuanling-blueprint\n  config:) [^\n]+/, `$1 ${JSON.stringify(config)}`))
  receipt.installedClient = digest(join(profile.installedPackage, 'lib/client.js'))
  receipt.installedHost = digest(join(profile.installedPackage, 'lib/index.js'))
  receipt.profile = profile.profile
  receipt.installMode = 'cli'
  host = bootHost(profile, receipt.steps)
  let authUrl = await host.ready
  let api = await apiFor(authUrl)
  const a = await api('createDefinition', {
    requestId: 'a',
    definitionJson: JSON.stringify(definition('a'))
  })
  const b = await api('createDefinition', {
    requestId: 'b',
    definitionJson: JSON.stringify(definition('b'))
  })
  const c = await api('createDefinition', {
    requestId: 'c',
    definitionJson: JSON.stringify(definition('c'))
  })
  const pw = createRequire(new URL('../package.json', import.meta.url))('playwright')
  edge = await launchOwnedEdge(pw, isolatedEnvironment(profile.home), root)
  receipt.browser = edge.evidence
  page = await edge.context.newPage()
  page.setDefaultTimeout(15000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  page.on('pageerror', error => receipt.errors.push(error.message))
  const open = async url => {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const preview = page.getByRole('dialog', { name: /^(?:预览版说明|Preview Notice)$/ })
    await preview.waitFor({ state: 'visible' })
    await preview.getByRole('button', { name: /^(?:继续|Continue)$/ }).click()
    await preview.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: /XuanLing Blueprint|玄灵蓝图/ }).click()
    await page.locator('[data-bp-select="blueprint"]').waitFor()
  }
  await open(authUrl)
  const select = page.locator('[data-bp-select="blueprint"]')
  await selectStyledOption(page, select, a.blueprintId)
  // Raw option clicks are essential here: automatic confirmation would hide regressions.
  const requestNavigation = async id => {
    await select.click()
    const listId = await select.getAttribute('aria-controls')
    await page.locator(`[id=${JSON.stringify(listId)}] [role="option"][data-bp-option-value=${JSON.stringify(id)}]`).click()
  }
  const waitNavigation = id => page.waitForFunction(expected => document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-blueprint') === expected, id)
  const nameInput = () => page.getByRole('textbox', { name: /^(?:Blueprint name|蓝图名称)$/, exact: true })
  await nameInput().fill('Unsaved semantic navigation probe')
  await requestNavigation(b.blueprintId)
  await page.locator('[data-bp-confirm-dialog]').waitFor({ state: 'visible' })
  await page.locator('[data-bp-confirm-cancel]').click()
  check('semantic edit navigation Cancel retains the current document and exact title', await styledSelectValue(select) === a.blueprintId && await nameInput().inputValue() === 'Unsaved semantic navigation probe')
  await page.locator('[data-bp-action="undo"]').click()
  await requestNavigation(b.blueprintId)
  check('undo to semantic baseline navigates without confirmation', await page.locator('[data-bp-confirm-dialog]').count() === 0)
  await waitNavigation(b.blueprintId)
  await requestNavigation(a.blueprintId)
  check('saved unchanged document navigates without confirmation', await page.locator('[data-bp-confirm-dialog]').count() === 0)
  await waitNavigation(a.blueprintId)
  const nodeBounds = await page.locator('.react-flow__node-blueprint').first().boundingBox()
  await page.mouse.move(nodeBounds.x + 60, nodeBounds.y + 18)
  await page.mouse.down()
  await page.mouse.move(nodeBounds.x + 110, nodeBounds.y + 65, { steps: 8 })
  await page.mouse.up()
  await page.locator('[data-bp-dirty="true"]').waitFor()
  await requestNavigation(b.blueprintId)
  check('presentation-only canvas movement leaves Save dirty but does not prompt navigation', await page.locator('[data-bp-confirm-dialog]').count() === 0)
  await waitNavigation(b.blueprintId)
  await requestNavigation(a.blueprintId)
  await waitNavigation(a.blueprintId)
  check('recovered layout draft remains dirty without a discard dialog', await page.locator('[data-bp-dirty]').getAttribute('data-bp-dirty') === 'true' && await page.locator('[data-bp-confirm-dialog]').count() === 0)
  await page.locator('[data-bp-action="new-blueprint"]').click()
  check('new editing ignores layout-only dirtiness', await page.locator('[data-bp-confirm-dialog]').count() === 0)
  await nameInput().fill('Empty renamed navigation probe')
  await requestNavigation(a.blueprintId)
  check('empty renamed draft switches directly without confirmation', await page.locator('[data-bp-confirm-dialog]').count() === 0)
  await waitNavigation(a.blueprintId)
  await page.setViewportSize({ width: 2239, height: 1514 })
  const categorySnapshot = async () => ({
    dirty: await page.locator('[data-bp-dirty]').getAttribute('data-bp-dirty'),
    undo: await page.locator('[data-bp-action="undo"]').isDisabled(),
    drafts: await page.evaluate(() => JSON.stringify(Object.entries(localStorage).filter(([key]) => key.startsWith('xuanling-blueprint:')).sort()))
  })
  const categoryBefore = await categorySnapshot()
  for (const category of ['agent', 'skill', 'mcp', 'other']) {
    const toggle = page.locator(`[data-bp-resource-toggle="${category}"]`)
    check(`${category} resource category is expanded by default`, await toggle.getAttribute('aria-expanded') === 'true')
    const title = await toggle.innerText(), target = await toggle.getAttribute('aria-controls')
    await toggle.click()
    check(`${category} category collapses independently and keeps its count`, await toggle.getAttribute('aria-expanded') === 'false' && await toggle.innerText() === title && !(await page.locator(`[id="${target}"]`).isVisible()))
    for (const other of ['agent', 'skill', 'mcp', 'other'].filter(value => value !== category)) assert.equal(await page.locator(`[data-bp-resource-toggle="${other}"]`).getAttribute('aria-expanded'), 'true')
    await toggle.press('Enter')
    await toggle.press('Space')
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    await toggle.press('Enter')
  }
  check('resource category pointer/keyboard toggles preserve dirty, draft bytes and history', JSON.stringify(await categorySnapshot()) === JSON.stringify(categoryBefore))
  const resourceRow = page.locator('[data-bp-resource-row="blueprint:tools"]')
  await resourceRow.waitFor({ state: 'visible' })
  const resourceLayout = await resourceRow.evaluate(row => {
    const title = row.querySelector('[data-bp-resource-title]')
    const description = row.querySelector('[data-bp-resource-description]')
    const heading = document.querySelector('.bp-resource-heading h2')
    const plus = document.querySelector('[data-bp-action="add-resource"]')
    const titleRect = title.getBoundingClientRect(), descriptionRect = description.getBoundingClientRect()
    const headingRect = heading.getBoundingClientRect(), plusRect = plus.getBoundingClientRect()
    const style = getComputedStyle(description)
    const rows = [...document.querySelectorAll('[data-bp-resource-row]')]
    return {
      title: title.textContent,
      belowTitle: descriptionRect.top >= titleRect.bottom,
      ellipsis: style.textOverflow === 'ellipsis' && style.whiteSpace === 'nowrap' && description.scrollWidth > description.clientWidth,
      sameHeadingRow: Math.abs(headingRect.top + headingRect.height / 2 - plusRect.top - plusRect.height / 2) < 2,
      plusOnly: plus.textContent === '+' && getComputedStyle(plus).borderTopWidth === '0px',
      legacyCount: document.querySelectorAll('[data-bp-section="resources"] details,[data-bp-resource]').length,
      uniqueCards: new Set(rows.map(element => element.dataset.bpResourceRow)).size === rows.length,
      mcpCategory: row.closest('[data-bp-resource-category]')?.dataset.bpResourceCategory
    }
  })
  receipt.resourceLayout = resourceLayout
  check('resource title is name - source with single-line description underneath', ['审查工具 - Blueprint', '审查工具 - 蓝图资源'].includes(resourceLayout.title) && resourceLayout.belowTitle && resourceLayout.ellipsis)
  check('resource + is borderless and aligned with its heading', resourceLayout.sameHeadingRow && resourceLayout.plusOnly)
  check('historical resources have one category card with no legacy list or Add resource form', resourceLayout.legacyCount === 0 && resourceLayout.uniqueCards && resourceLayout.mcpCategory === 'mcp')
  await resourceRow.hover()
  const resourceTooltip = page.locator('[data-bp-tooltip="resource-blueprint:tools"]')
  await resourceTooltip.waitFor({ state: 'visible' })
  check('resource hover tooltip contains the complete untruncated description', (await resourceTooltip.innerText()) === resourceDescription)
  await page.screenshot({ path: join(reportDir, 'resource-cards-tooltip-2239.png'), fullPage: true })
  await resourceRow.focus()
  check('resource keyboard focus also reveals full description', (await resourceTooltip.innerText()) === resourceDescription)
  await page.keyboard.press('Escape')
  await resourceTooltip.waitFor({ state: 'detached' })
  const canvasBeforeDialog = await page.locator('[data-bp-canvas="surface"]').boundingBox()
  await page.locator('[data-bp-action="add-resource"]').click()
  const resourceDialog = page.locator('[data-bp-resource-dialog]')
  const canvasDuringDialog = await page.locator('[data-bp-canvas="surface"]').boundingBox()
  check('resource dialog overlays the workspace without changing canvas size', canvasDuringDialog.width === canvasBeforeDialog.width && canvasDuringDialog.height === canvasBeforeDialog.height)
  await resourceDialog.getByRole('textbox', { name: /^(New resource ID|新资源 ID)$/, exact: true }).fill('cancelled-resource')
  await page.locator('[data-bp-action="resource-cancel"]').focus()
  await page.keyboard.press('Tab')
  check('resource dialog Tab stays inside the modal', await resourceDialog.evaluate(element => element.contains(document.activeElement)))
  const formGeometry = async () => resourceDialog.evaluate(element => {
    const rect = element.getBoundingClientRect()
    const fields = [...element.querySelectorAll('.bp-resource-fields>label')].map(field => { const box = field.getBoundingClientRect(); return { x: box.x, y: box.y, bottom: box.bottom, width: box.width } })
    return { width: rect.width, fields, overflow: element.scrollWidth > element.clientWidth }
  })
  const wideForm = await formGeometry()
  receipt.resourceForm = { wide: wideForm }
  check('resource dialog uses 720px and pairs type/ID then name/description', wideForm.width >= 710 && wideForm.width <= 730 && wideForm.fields.length === 4 && Math.abs(wideForm.fields[0].y - wideForm.fields[1].y) < 1 && Math.abs(wideForm.fields[2].y - wideForm.fields[3].y) < 1 && wideForm.fields[1].x > wideForm.fields[0].x && !wideForm.overflow)
  await page.screenshot({ path: join(reportDir, 'resource-dialog-2239.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 900 })
  const narrowForm = await formGeometry()
  receipt.resourceForm.narrow = narrowForm
  check('narrow resource dialog stacks all four fields without horizontal overflow', narrowForm.width <= 358 && narrowForm.fields.every((field, index, fields) => index === 0 || field.y >= fields[index - 1].bottom) && !narrowForm.overflow)
  check('narrow resource dialog retains CodeMirror', await resourceDialog.locator('.cm-editor').count() === 1)
  await page.locator('[data-bp-action="resource-cancel"]').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(reportDir, 'resource-dialog-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 2239, height: 1514 })
  await page.locator('[data-bp-action="resource-cancel"]').click()
  check('resource dialog Cancel adds no card and restores + focus', (await page.locator('[data-bp-resource-row="blueprint:cancelled-resource"]').count()) === 0 && await page.locator('[data-bp-action="add-resource"]').evaluate(element => element === document.activeElement))
  if (await page.locator('[data-bp-action="toggle-inspector"]').getAttribute('aria-expanded') === 'false')
    await page.locator('[data-bp-action="toggle-inspector"]').click()
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.locator('[data-bp-disclosure-toggle="run"]').click()
  const runInput = page.locator('[data-bp-run-input]')
  await runInput.waitFor({ state: 'visible' })
  await runInput.fill('{"message":"中文","n":2}')
  const runEditor = page.locator('.bp-json-editor').filter({ has: runInput })
  await runEditor.locator('[data-bp-action="format-json"]').click()
  check('format produces multiline JSON', (await runInput.innerText()).includes('\n'))
  await runInput.press('Meta+z')
  check('format is one undoable edit', (await runInput.innerText()) === '{"message":"中文","n":2}')
  check('syntax highlighting rendered', (await runInput.locator('span').count()) > 0)
  const count = await page.locator('.react-flow__node-blueprint').count()
  await runInput.press('Meta+a')
  await runInput.press('Backspace')
  check('editor delete does not delete canvas nodes', (await page.locator('.react-flow__node-blueprint').count()) === count)
  await runInput.fill('{ invalid')
  await runEditor.locator('[data-bp-json-valid="false"]').waitFor()
  await runEditor.locator('[data-bp-action="format-json"]').click()
  check('invalid JSON retained with location', (await runInput.innerText()) === '{ invalid' && /1/.test(await runEditor.innerText()))
  await runInput.fill('{}')
  // Trusted composition protocol, same input path used by the existing canvas suite.
  await runInput.press('Meta+a')
  const cdp = await edge.context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition', {
    text: '中文输入',
    selectionStart: 4,
    selectionEnd: 4
  })
  await cdp.send('Input.insertText', { text: '中文输入' })
  check('IME text retained', (await runInput.innerText()).includes('中文输入'))
  await runInput.fill('{}')
  await page.locator('[data-bp-resource-row="blueprint:tools"]').click()
  const resource = page.locator('[data-bp-resource-dialog] .cm-content')
  await resource.waitFor({ state: 'visible' })
  await resource.fill('{"kind":"mcp","bindingId":"edited"}')
  await page.locator('[data-bp-action="resource-apply"]').click()
  await page.locator('[data-bp-action="save-layout"]').click()
  check(
    'resource dialog Apply preserves exact editor value',
    JSON.parse((await api('loadDefinition', { blueprintId: a.blueprintId })).definitionJson).resources.tools.bindingId === 'edited'
  )
  await page.locator('.react-flow__node-blueprint').first().click()
  await page.locator('[data-bp-inspector-advanced]').click()
  await page.locator('.bp-node-inspector .bp-json-editor').last().scrollIntoViewIfNeeded()
  const options = page.locator('[data-bp-json="options"]')
  await options.waitFor({ state: 'visible' })
  await options.fill('{ unfinished')
  check('advanced editor retains incomplete buffer', (await options.innerText()) === '{ unfinished')
  await preparePublicAction(page, 'export-blueprint')
  check('legacy export absent from file menu', (await page.locator('[data-bp-action="export-legacy"]').count()) === 0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await setNativeTheme(page, 'dark', true)
  check('dark theme preserves unfinished JSON', (await options.innerText()) === '{ unfinished')
  await page.screenshot({ path: join(reportDir, 'editor-dark.png'), fullPage: true })
  const settingsTrigger = page.getByRole('button', { name: /^(设置|Settings)$/ })
  if ((await settingsTrigger.count()) && (await settingsTrigger.isVisible().catch(() => false))) await settingsTrigger.click()
  else await page.keyboard.press('Meta+Alt+,')
  const settings = page.locator('[data-shortcut-modal="settings"]')
  await settings.getByRole('button', { name: '中文', exact: true }).click()
  await page.getByRole('menuitem', { name: 'English', exact: true }).click()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  check(
    'locale switch preserves unfinished JSON and selection',
    (await options.innerText()) === '{ unfinished' && (await page.locator('.react-flow__node.selected').count()) === 1
  )
  await setNativeTheme(page, 'light', true)
  await page.screenshot({ path: join(reportDir, 'editor.png'), fullPage: true })
  await page.locator('[data-bp-action="delete-blueprint"]').click()
  await page.locator('[data-bp-confirm-cancel]').click()
  check('delete cancel preserves document', (await styledSelectValue(select)) === a.blueprintId)
  const current = await api('loadDefinition', { blueprintId: a.blueprintId })
  const preflight = await api('preflightRun', {
    blueprintId: a.blueprintId,
    expectedRevision: current.documentRevision,
    inputJson: '{}'
  })
  check('fresh profile default runtime preflight', preflight.canStart)
  const run = await api('startRun', {
    blueprintId: a.blueprintId,
    expectedRevision: current.documentRevision,
    inputJson: '{}',
    requestId: 'before-delete'
  })
  await page.locator('[data-bp-action="delete-blueprint"]').click()
  await page.locator('[data-bp-confirm-accept]').click()
  await page.waitForFunction(id => document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-blueprint') !== id, a.blueprintId)
  check('delete removes host catalog identity', !(await api('listDefinitions')).definitions.some(d => d.blueprintId === a.blueprintId))
  check('delete preserves run history', (await api('inspectRun', { runId: run.runId })).runId === run.runId)
  await selectStyledOption(page, select, b.blueprintId)
  await page.waitForFunction(id => document.querySelector('[data-bp-blueprint]')?.getAttribute('data-bp-blueprint') === id, b.blueprintId)
  await page.locator('[data-bp-action="add-resource"]').click()
  await page.getByRole('textbox', { name: 'New resource ID', exact: true }).fill('added')
  await selectStyledOption(page, page.getByRole('combobox', { name: 'Resource type', exact: true }), 'mcp')
  const newResource = page.getByRole('textbox', { name: 'New resource JSON', exact: true })
  await newResource.fill('{"kind":"mcp","bindingId":"added"}')
  await page.locator('[data-bp-action="resource-apply"]').click()
  await page.locator('[data-bp-action="save-layout"]').click()
  check(
    'new resource dialog Apply uses editor value',
    JSON.parse((await api('loadDefinition', { blueprintId: b.blueprintId })).definitionJson).resources.added.bindingId === 'added'
  )
  await page.screenshot({ path: join(reportDir, 'after-delete.png'), fullPage: true })
  const listenerCounts = async () => {
    // Dismiss DSH's one-shot pointer listener installed by focus/menu changes
    // with the same genuine event before both snapshots.
    await page.mouse.move(5, 5)
    await page.mouse.move(10, 5)
    const counts = {}
    for (const expression of ['window', 'document']) {
      const { result } = await cdp.send('Runtime.evaluate', { expression })
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', {
        objectId: result.objectId
      })
      counts[expression] = listeners.map(l => `${l.type}:${l.useCapture}`).sort()
      await cdp.send('Runtime.releaseObject', { objectId: result.objectId })
    }
    return counts
  }
  // Each library switch changes the run editor's React key and destroys its view.
  const switchEditor = async id => {
    await selectStyledOption(page, select, id)
    await page.waitForFunction(expected => document.querySelector('[data-bp-blueprint]')?.getAttribute('data-bp-blueprint') === expected, id)
    const input = page.locator('[data-bp-run-input]')
    await input.waitFor({ state: 'attached' })
    await input.scrollIntoViewIfNeeded()
    await input.waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('[data-bp-action="save-layout"]').disabled)
    const before = await input.innerText()
    assert.equal(before, '{}', 'newly mounted editor retains the current input')
    await input.press('End')
    await input.press('x')
    check('one key produces one edit', (await input.innerText()) === '{}x')
    await input.press('Meta+z')
    check('one undo reverses one edit', (await input.innerText()) === before)
    await input.fill('{}')
    await select.focus()
    check(
      'one mounted view per JSON editor',
      await page.locator('[data-bp-json-editor]').evaluateAll(els => els.every(el => el.querySelectorAll('.cm-editor').length <= 1))
    )
  }
  await switchEditor(c.blueprintId)
  await switchEditor(b.blueprintId)
  const listenersBefore = await listenerCounts()
  for (let n = 0; n < 10; n++) await switchEditor(n % 2 ? b.blueprintId : c.blueprintId)
  const listenersAfter = await listenerCounts()
  assert.deepEqual(listenersAfter, listenersBefore)
  receipt.editorLifecycle = { cycles: 10, listenersBefore, listenersAfter }
  check('10 mount/unmount cycles retain listener counts', true)
  receipt.performance = await measureCanvasPerformance(
    page,
    (id, description, ok, detail) => {
      check(id, ok)
      receipt.steps.push({ id, description, detail })
    },
    fixtureEvidence(performance),
    async (method, args) => ({
      status: 200,
      body: { result: { ok: true, value: await api(method, args) } }
    })
  )
  await page.screenshot({ path: join(reportDir, 'performance.png'), fullPage: true })
  const browserCdp = await edge.browser.newBrowserCDPSession()
  await browserCdp.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: join(root, 'downloads'),
    eventsEnabled: true
  })
  await preparePublicAction(page, 'export-blueprint')
  const downloadEvent = new Promise(resolve => {
    let started
    const timer = setTimeout(() => resolve({ error: 'CDP download did not complete within 15000ms', started }), 15000)
    browserCdp.on('Browser.downloadWillBegin', event => {
      started = { guid: event.guid, filename: event.suggestedFilename }
    })
    browserCdp.on('Browser.downloadProgress', event => {
      if (!started || event.guid !== started.guid || event.state === 'inProgress') return
      clearTimeout(timer)
      resolve({ ...started, state: event.state, receivedBytes: event.receivedBytes })
    })
  })
  const exportResponseEvent = page.waitForResponse(
    response => /\/api\/blueprint\/exportDefinition(?:\?|$)/.test(response.url()) && response.request().method() === 'POST'
  )
  await page.locator('[data-bp-action="export-blueprint"]').click()
  const exportResponse = await exportResponseEvent
  const exportWire = { status: exportResponse.status(), body: await exportResponse.json() }
  receipt.exportRpc = {
    status: exportWire.status,
    ok: exportWire.body.result?.ok,
    code: exportWire.body.result?.error?.code
  }
  assert.equal(exportWire.body.result?.ok, true)
  const download = await downloadEvent
  receipt.nativeDownload = download
  if (download.error) throw new Error(`Host export succeeded but download not observed: ${download.error}`)
  assert.equal(download.state, 'completed')
  const archivePath = join(reportDir, 'canvas-performance.zip')
  writeFileSync(archivePath, readFileSync(join(root, 'downloads', download.guid)))
  const exported = verifyArchiveDownload(readFileSync(archivePath), exportWire, performance.id)
  receipt.download = {
    file: 'canvas-performance.zip',
    sha256: exported.archiveSha256,
    files: exported.files,
    blueprintId: exported.blueprintId
  }
  check('current ZIP downloaded with Host-identical bytes', true)
  for (let n = 1; n <= 3; n++) {
    await stopHost(host.child)
    host = bootHost(profile, receipt.steps, `restart-${n}`)
    authUrl = await host.ready
    api = await apiFor(authUrl)
    check(
      `restart ${n} retains deletion and history`,
      !(await api('listDefinitions')).definitions.some(d => d.blueprintId === a.blueprintId) &&
        (await api('inspectRun', { runId: run.runId })).runId === run.runId
    )
  }
  check('no browser errors', receipt.errors.length === 0)
  receipt.ok = true
} catch (error) {
  receipt.ok = false
  receipt.failure = error.stack
  console.error(error.stack)
  if (page) await page.screenshot({ path: join(reportDir, 'failure.png'), fullPage: true }).catch(() => {})
} finally {
  await edge?.close()
  await stopHost(host?.child)
  receipt.finishedAt = new Date().toISOString()
  writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  rmSync(root, { recursive: true, force: true })
}
process.exitCode = receipt.ok ? 0 : 1
