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
  console.log('node --experimental-transform-types test/blueprint/capabilities/authoring-ui.mjs --report-dir <fresh absolute directory>\nInstalls current artifact in an isolated DSH profile; tests JSON editor, current exports, deletion and restart. No provider calls.'); process.exit(0)
}
assert.equal(process.argv[2], '--report-dir')
const reportDir = resolve(process.argv[3]); mkdirSync(reportDir, { recursive: true })
const root = mkdtempSync(join(realpathSync(tmpdir()), 'bp-authoring-ui-'))
const receipt = { planId: 'dsh-blueprint-agent-authoring-v1', startedAt: new Date().toISOString(), providerEvidence: false, steps: [], checks: [], errors: [] }
let host, edge, page
const check = (name, value) => { assert.ok(value, name); receipt.checks.push(name); console.log(name) }
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const definition = id => ({ schemaVersion: 1, id, name: `JSON editor ${id}`, resources: { tools: { kind: 'mcp', bindingId: 'fixture' } }, graph: { nodes: [
  { id: 'input', kind: 'input', outputs: { result: 'json' } }, { id: 'output', kind: 'output', inputs: { result: 'json' } },
], edges: [{ kind: 'data', from: 'input.result', to: 'output.result' }] }, presentation: { nodes: { input: { x: 30, y: 70 }, output: { x: 350, y: 70 } } } })
const apiFor = async authUrl => {
  const url = new URL(authUrl); const auth = await fetch(authUrl, { redirect: 'manual' }); const cookie = auth.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
  return async (method, args) => {
    assert.ok(['createDefinition','listDefinitions','loadDefinition','preflightRun','startRun','inspectRun','deleteDefinition'].includes(method))
    const response = await fetch(`${url.origin}/api/blueprint/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: `blueprint/${method}`, payload: { args: args === undefined ? {} : { args } } }) })
    const body = await response.json(); assert.equal(body.result?.ok, true, JSON.stringify(body)); return body.result.value
  }
}
try {
  const performance = performanceDefinition()
  const performanceRoot = join(root, 'performance')
  mkdirSync(join(performanceRoot, 'lib/agents'), { recursive: true })
  writeFileSync(join(performanceRoot, 'blueprint.json'), JSON.stringify(performance))
  for (const ref of Object.values(performance.resources)) writeFileSync(join(performanceRoot, ref.path), 'Performance fixture agent.\n')
  const config = { blueprints: { [performance.id]: performanceRoot } }
  const profile = await prepareProfile({ mode: 'keyless', installMode: 'cli', pnpmExecutable: process.env.BP_AUTHORING_PNPM }, { prepare: async () => config }, root, receipt.steps)
  // Exercise the actual profile fallback used by a fresh ordinary install.
  const patch = join(profile.profileDir, 'cordis.patch.yml'); const source = readFileSync(patch, 'utf8')
  writeFileSync(patch, source.replace(/(- id: xuanling-blueprint\n  config:) [^\n]+/, `$1 ${JSON.stringify(config)}`))
  receipt.installedClient = digest(join(profile.installedPackage, 'lib/client.js'))
  receipt.installedHost = digest(join(profile.installedPackage, 'lib/index.js'))
  receipt.profile = profile.profile; receipt.installMode = 'cli'
  host = bootHost(profile, receipt.steps); let authUrl = await host.ready; let api = await apiFor(authUrl)
  const a = await api('createDefinition', { requestId: 'a', definitionJson: JSON.stringify(definition('a')) })
  const b = await api('createDefinition', { requestId: 'b', definitionJson: JSON.stringify(definition('b')) })
  const c = await api('createDefinition', { requestId: 'c', definitionJson: JSON.stringify(definition('c')) })
  const pw = createRequire(new URL('../package.json', import.meta.url))('playwright')
  edge = await launchOwnedEdge(pw, isolatedEnvironment(profile.home), root); receipt.browser = edge.evidence
  page = await edge.context.newPage(); page.setDefaultTimeout(15000); await page.setViewportSize({ width: 1600, height: 1000 })
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
  await select.selectOption(a.blueprintId)
  await page.locator('[data-bp-disclosure-toggle="run"]').click()
  const runInput = page.locator('[data-bp-run-input]')
  await runInput.waitFor({ state: 'visible' })
  await runInput.fill('{"message":"中文","n":2}')
  const runEditor = page.locator('.bp-json-editor').filter({ has: runInput })
  await runEditor.locator('[data-bp-action="format-json"]').click()
  check('format produces multiline JSON', (await runInput.innerText()).includes('\n'))
  await runInput.press('Meta+z')
  check('format is one undoable edit', await runInput.innerText() === '{"message":"中文","n":2}')
  check('syntax highlighting rendered', await runInput.locator('span').count() > 0)
  const count = await page.locator('.react-flow__node-blueprint').count()
  await runInput.press('Meta+a'); await runInput.press('Backspace')
  check('editor delete does not delete canvas nodes', await page.locator('.react-flow__node-blueprint').count() === count)
  await runInput.fill('{ invalid')
  await runEditor.locator('[data-bp-json-valid="false"]').waitFor()
  await runEditor.locator('[data-bp-action="format-json"]').click()
  check('invalid JSON retained with location', await runInput.innerText() === '{ invalid' && /1/.test(await runEditor.innerText()))
  await runInput.fill('{}')
  // Trusted composition protocol, same input path used by the existing canvas suite.
  await runInput.press('Meta+a'); const cdp = await edge.context.newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '中文输入', selectionStart: 4, selectionEnd: 4 })
  await cdp.send('Input.insertText', { text: '中文输入' })
  check('IME text retained', (await runInput.innerText()).includes('中文输入'))
  await runInput.fill('{}')
  await page.locator('[data-bp-resource="tools"] summary').click()
  const resource = page.locator('[data-bp-resource="tools"] .cm-content')
  await resource.waitFor({ state: 'visible' }); await resource.fill('{"kind":"mcp","bindingId":"edited"}')
  await select.focus(); await page.locator('[data-bp-action="save-layout"]').click()
  check('resource editor blur applies exact value', JSON.parse((await api('loadDefinition', { blueprintId: a.blueprintId })).definitionJson).resources.tools.bindingId === 'edited')
  await page.locator('.react-flow__node-blueprint').first().click()
  await page.locator('[data-bp-inspector-advanced]').click()
  await page.locator('.bp-node-inspector .bp-json-editor').last().scrollIntoViewIfNeeded()
  const options = page.locator('[data-bp-json="options"]'); await options.waitFor({ state: 'visible' }); await options.fill('{ unfinished')
  check('advanced editor retains incomplete buffer', await options.innerText() === '{ unfinished')
  await preparePublicAction(page, 'export-blueprint')
  check('legacy export absent from file menu', await page.locator('[data-bp-action="export-legacy"]').count() === 0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await setNativeTheme(page, 'dark')
  check('dark theme preserves unfinished JSON', await options.innerText() === '{ unfinished')
  await page.screenshot({ path: join(reportDir, 'editor-dark.png'), fullPage: true })
  await page.getByRole('button', { name: /^(设置|Settings)$/ }).click()
  const settings = page.locator('[data-shortcut-modal="settings"]')
  await settings.getByRole('button', { name: '中文', exact: true }).click()
  await page.getByRole('menuitem', { name: 'English', exact: true }).click()
  await settings.getByRole('button', { name: 'Close', exact: true }).click()
  check('locale switch preserves unfinished JSON and selection', await options.innerText() === '{ unfinished' && await page.locator('.react-flow__node.selected').count() === 1)
  await setNativeTheme(page, 'light')
  await page.screenshot({ path: join(reportDir, 'editor.png'), fullPage: true })
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('[data-bp-action="delete-blueprint"]').click()
  check('delete cancel preserves document', await select.inputValue() === a.blueprintId)
  const current = await api('loadDefinition', { blueprintId: a.blueprintId })
  const preflight = await api('preflightRun', { blueprintId: a.blueprintId, expectedRevision: current.documentRevision, inputJson: '{}' })
  check('fresh profile default runtime preflight', preflight.canStart)
  const run = await api('startRun', { blueprintId: a.blueprintId, expectedRevision: current.documentRevision, inputJson: '{}', requestId: 'before-delete' })
  page.once('dialog', dialog => dialog.accept()); await page.locator('[data-bp-action="delete-blueprint"]').click()
  await page.waitForFunction(id => ![...document.querySelectorAll('[data-bp-select="blueprint"] option')].some(o => o.value === id), a.blueprintId)
  check('delete removes host catalog identity', !(await api('listDefinitions')).definitions.some(d => d.blueprintId === a.blueprintId))
  check('delete preserves run history', (await api('inspectRun', { runId: run.runId })).runId === run.runId)
  await select.selectOption(b.blueprintId)
  await page.locator('[data-bp-section="resources"] summary').filter({ hasText: /^Add resource$/ }).click()
  await page.getByRole('textbox', { name: 'New resource ID', exact: true }).fill('added')
  const newResource = page.getByRole('textbox', { name: 'New resource JSON', exact: true })
  await newResource.fill('{"kind":"mcp","bindingId":"added"}')
  await page.getByRole('button', { name: 'Add resource', exact: true }).click()
  await page.locator('[data-bp-action="save-layout"]').click()
  check('new resource FormData uses editor value', JSON.parse((await api('loadDefinition', { blueprintId: b.blueprintId })).definitionJson).resources.added.bindingId === 'added')
  await page.screenshot({ path: join(reportDir, 'after-delete.png'), fullPage: true })
  const listenerCounts = async () => {
    // Dismiss DSH's one-shot pointer listener installed by focus/menu changes
    // with the same genuine event before both snapshots.
    await page.mouse.move(5, 5); await page.mouse.move(10, 5)
    const counts = {}
    for (const expression of ['window', 'document']) {
      const { result } = await cdp.send('Runtime.evaluate', { expression })
      const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })
      counts[expression] = listeners.map(l => `${l.type}:${l.useCapture}`).sort()
      await cdp.send('Runtime.releaseObject', { objectId: result.objectId })
    }
    return counts
  }
  // Each library switch changes the run editor's React key and destroys its view.
  const switchEditor = async id => {
    await select.selectOption(id)
    await page.waitForFunction(expected => document.querySelector('[data-bp-blueprint]')?.getAttribute('data-bp-blueprint') === expected, id)
    const input = page.locator('[data-bp-run-input]'); await input.waitFor({ state: 'attached' }); await input.scrollIntoViewIfNeeded()
    await input.waitFor({ state: 'visible' })
    await page.waitForFunction(() => !document.querySelector('[data-bp-action="save-layout"]').disabled)
    const before = await input.innerText()
    assert.equal(before, '{}', 'newly mounted editor retains the current input')
    await input.press('End'); await input.press('x')
    check('one key produces one edit', await input.innerText() === '{}x')
    await input.press('Meta+z')
    check('one undo reverses one edit', await input.innerText() === before)
    await input.fill('{}'); await select.focus()
    check('one mounted view per JSON editor', await page.locator('[data-bp-json-editor]').evaluateAll(els => els.every(el => el.querySelectorAll('.cm-editor').length <= 1)))
  }
  await switchEditor(c.blueprintId); await switchEditor(b.blueprintId)
  const listenersBefore = await listenerCounts()
  for (let n = 0; n < 10; n++) await switchEditor(n % 2 ? b.blueprintId : c.blueprintId)
  const listenersAfter = await listenerCounts()
  assert.deepEqual(listenersAfter, listenersBefore)
  receipt.editorLifecycle = { cycles: 10, listenersBefore, listenersAfter }
  check('10 mount/unmount cycles retain listener counts', true)
  receipt.performance = await measureCanvasPerformance(page, (id, description, ok, detail) => { check(id, ok); receipt.steps.push({ id, description, detail }) }, fixtureEvidence(performance), async (method, args) => ({ status: 200, body: { result: { ok: true, value: await api(method, args) } } }))
  await page.screenshot({ path: join(reportDir, 'performance.png'), fullPage: true })
  const browserCdp = await edge.browser.newBrowserCDPSession()
  await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: join(root, 'downloads'), eventsEnabled: true })
  await preparePublicAction(page, 'export-blueprint')
  const downloadEvent = new Promise(resolve => {
    let started
    const timer = setTimeout(() => resolve({ error: 'CDP download did not complete within 15000ms', started }), 15000)
    browserCdp.on('Browser.downloadWillBegin', event => { started = { guid: event.guid, filename: event.suggestedFilename } })
    browserCdp.on('Browser.downloadProgress', event => {
      if (!started || event.guid !== started.guid || event.state === 'inProgress') return
      clearTimeout(timer); resolve({ ...started, state: event.state, receivedBytes: event.receivedBytes })
    })
  })
  const exportResponseEvent = page.waitForResponse(response => /\/api\/blueprint\/exportDefinition(?:\?|$)/.test(response.url()) && response.request().method() === 'POST')
  await page.locator('[data-bp-action="export-blueprint"]').click()
  const exportResponse = await exportResponseEvent
  const exportWire = { status: exportResponse.status(), body: await exportResponse.json() }
  receipt.exportRpc = { status: exportWire.status, ok: exportWire.body.result?.ok, code: exportWire.body.result?.error?.code }
  assert.equal(exportWire.body.result?.ok, true)
  const download = await downloadEvent
  receipt.nativeDownload = download
  if (download.error) throw new Error(`Host export succeeded but download not observed: ${download.error}`)
  assert.equal(download.state, 'completed')
  const archivePath = join(reportDir, 'canvas-performance.zip'); writeFileSync(archivePath, readFileSync(join(root, 'downloads', download.guid)))
  const exported = verifyArchiveDownload(readFileSync(archivePath), exportWire, performance.id)
  receipt.download = { file: 'canvas-performance.zip', sha256: exported.archiveSha256, files: exported.files, blueprintId: exported.blueprintId }
  check('current ZIP downloaded with Host-identical bytes', true)
  for (let n = 1; n <= 3; n++) {
    await stopHost(host.child); host = bootHost(profile, receipt.steps, `restart-${n}`); authUrl = await host.ready; api = await apiFor(authUrl)
    check(`restart ${n} retains deletion and history`, !(await api('listDefinitions')).definitions.some(d => d.blueprintId === a.blueprintId) && (await api('inspectRun', { runId: run.runId })).runId === run.runId)
  }
  check('no browser errors', receipt.errors.length === 0)
  receipt.ok = true
} catch (error) { receipt.ok = false; receipt.failure = error.stack; console.error(error.stack); if (page) await page.screenshot({ path: join(reportDir, 'failure.png'), fullPage: true }).catch(() => {}) }
finally {
  await edge?.close(); await stopHost(host?.child)
  receipt.finishedAt = new Date().toISOString(); writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2)); rmSync(root, { recursive: true, force: true })
}
process.exitCode = receipt.ok ? 0 : 1
