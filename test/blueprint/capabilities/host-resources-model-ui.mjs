import { selectStyledOption } from './styled-control-entry.mjs'
/** Real isolated DSH registry, RPC, Edge UI and MCP acceptance; no remote model calls. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { prepareProfile, bootHost, stopHost, isolatedEnvironment, collectorOverlaySource } from './conversation-runtime.mjs'
import { launchOwnedEdge } from './comfy-motion-ui.mjs'
import { preparePublicAction } from './compact-ui-entry.mjs'
import { readZip } from '../../../integrations/deepseek-harness/xuanling-blueprint/src/portability/zip.ts'

if (process.argv.includes('--help')) {
  console.log('node --experimental-transform-types test/blueprint/capabilities/host-resources-model-ui.mjs --report-dir <fresh absolute directory>'); process.exit(0)
}
assert.equal(process.argv[2], '--report-dir')
const reportDir = resolve(process.argv[3]); mkdirSync(reportDir, { recursive: true })
const root = mkdtempSync(join(realpathSync(tmpdir()), 'bp-host-resources-model-'))
const receipt = { startedAt: new Date().toISOString(), providerEvidence: false, steps: [], checks: [], errors: [] }
let host, edge
const check = (name, value) => { assert.ok(value, name); receipt.checks.push(name); console.log(name) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const blueprintId = 'host-model-native'
const toolId = 'mcp__bp_host__record_side_effect'
const rpcFor = async authUrl => {
  const origin = new URL(authUrl).origin
  const auth = await fetch(authUrl, { redirect: 'manual' })
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  return async (method, args) => {
    assert.ok(['listResources', 'loadDefinition', 'saveDefinition', 'preflightRun', 'exportDefinition', 'importDefinition', 'mcpProbe'].includes(method))
    const response = await fetch(`${origin}/api/blueprint/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: `blueprint/${method}`, payload: { args: args === undefined ? {} : { args } } }), signal: AbortSignal.timeout(15000) })
    const body = await response.json()
    assert.equal(body.result?.ok, true, `${method}: ${body.result?.error?.code ?? response.status}`)
    return body.result.value
  }
}
try {
  const packageRoot = join(root, '.xuanling', 'workflows', blueprintId); mkdirSync(join(packageRoot, 'lib/agents'), { recursive: true })
  writeFileSync(join(packageRoot, 'lib/agents/local.md'), 'Local blueprint agent.\n')
  const definition = { schemaVersion: 2, id: blueprintId, name: 'Host resources and models',
    resources: { local: { kind: 'agent', path: 'lib/agents/local.md' }, builtin: { kind: 'agent', source: { kind: 'host', id: 'minimal' } } },
    graph: { nodes: [{ id: 'task', kind: 'agentTask', agentRef: 'local', outputs: { text: 'string' } }], edges: [] }, presentation: { nodes: { task: { x: 100, y: 120 } } } }
  writeFileSync(join(packageRoot, 'blueprint.json'), JSON.stringify(definition))
  const operator = join(root, 'host-preset-fixture.mjs')
  writeFileSync(operator, `export const inject=['agentPresets'];
export function apply(ctx){ctx.effect(()=>ctx.agentPresets.register({id:'host-review',name:'Host Review / QA',plugins:[{name:'@deepseek-ai/dsh-persona',config:{prefix:'Controlled host reviewer.',complete:true,includeRuntimeContext:false}}]}))}
`)
  const profile = await prepareProfile({ mode: 'keyless', installMode: 'linked' }, { prepare: async () => ({ workspaceRoot: root, runtimeRoot: join(root, '.xuanling'), operatorModules: [operator] }) }, root, receipt.steps)
  receipt.installMode = 'linked'; receipt.installedHost = digest(readFileSync(join(profile.installedPackage, 'lib/index.js')))
  receipt.installedClient = digest(readFileSync(join(profile.installedPackage, 'lib/client.js')))
  const skillDirectory = join(profile.home, 'dsh/skills')
  const skillRoot = join(skillDirectory, 'host-review-skill'); mkdirSync(join(skillRoot, 'references'), { recursive: true })
  writeFileSync(join(skillRoot, 'SKILL.md'), '---\nname: host-review-skill\ndescription: Controlled host skill.\n---\nReview the controlled fixture.\n')
  writeFileSync(join(skillRoot, 'references/checks.md'), 'Keep full directory assets.\n')
  const sideEffectFile = join(root, 'mcp-effects.txt')
  const server = fileURLToPath(new URL('./mcp-server.mjs', import.meta.url))
  const patch = join(profile.profileDir, 'cordis.patch.yml')
  writeFileSync(patch, collectorOverlaySource(readFileSync(patch, 'utf8'), `- id: skill-filesystem\n  disabled: false\n  config: ${JSON.stringify({ includeDefaultRoots: false, customSkillDirs: [skillDirectory], watch: false })}\n- insert:\n    - id: host-catalog-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: ${JSON.stringify({ transport: 'stdio', serverName: 'bp_host', command: process.execPath, args: [server], env: { BP_MCP_SIDE_EFFECT_FILE: sideEffectFile }, failOnStartupError: true })}`))
  host = bootHost(profile, receipt.steps); const authUrl = await host.ready; const rpc = await rpcFor(authUrl)
  const catalog = (await rpc('listResources')).resources
  receipt.catalog = catalog.map(({ id, kind, provenance, availability }) => ({ id, kind, provenance, availability }))
  check('installed public catalog exposes custom preset, filesystem Skill and connected MCP', ['host-review', 'host-review-skill', toolId].every(id => catalog.some(row => row.id === id && row.availability === 'available')))
  check('official minimal preset has current installed artifact provenance', catalog.find(row => row.id === 'minimal')?.provenance === 'builtin')
  check('catalog DTO carries no locator, config or internal merge fields', catalog.every(row => Object.keys(row).every(key => ['id', 'kind', 'displayName', 'description', 'source', 'availability', 'provenance', 'bindingId'].includes(key))))
  const pw = createRequire(new URL('../package.json', import.meta.url))('playwright')
  edge = await launchOwnedEdge(pw, isolatedEnvironment(profile.home), root); receipt.browser = edge.evidence
  const page = await edge.context.newPage(); page.setDefaultTimeout(15000); await page.setViewportSize({ width: 1600, height: 1000 })
  page.on('pageerror', error => receipt.errors.push(error.message))
  await page.goto(authUrl, { waitUntil: 'domcontentloaded' })
  const preview = page.getByRole('dialog', { name: /^(?:预览版说明|Preview Notice)$/ })
  await preview.waitFor({ state: 'visible' }); await preview.getByRole('button', { name: /^(?:继续|Continue)$/ }).click()
  await page.getByRole('button', { name: /XuanLing Blueprint|玄灵蓝图/ }).click()
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), blueprintId)
  await page.locator('.react-flow__node-blueprint').click()
  const presetSelect = page.locator('[data-bp-field="agentRef"]')
  await presetSelect.click()
  const options = await page.locator('.bp-select-list [role=option]').evaluateAll(rows => rows.map(row => ({ value: row.getAttribute('data-bp-option-value'), text: row.textContent?.replace(/✓$/, '') })))
  await presetSelect.press('Escape')
  const hostOption = options.find(row => row.text?.includes('Host Review / QA'))
  check('Inspector renders DSH choices before local blueprint resource', hostOption && options.indexOf(hostOption) < options.findIndex(row => row.value === 'local'))
  await selectStyledOption(page, presetSelect, hostOption.value)
  for (const [field, text] of [['skillRefs', 'host-review-skill'], ['toolsetRefs', toolId]]) {
    const label = page.locator('.bp-resource-bindings label').filter({ hasText: text })
    await label.locator(`input[data-bp-field="${field}"]`).check()
  }
  await selectStyledOption(page, page.locator('[data-bp-field="model-mode"]'), 'explicit')
  for (const [field, value] of [['provider', 'unconfigured-provider'], ['model', 'fixture-model'], ['reasoningEffort', 'high']]) await page.locator(`[data-bp-field="modelSelection.${field}"]`).fill(value)
  await page.locator('[data-bp-action="apply-model-route"]').click()
  await page.locator('[data-bp-action="save-layout"]').click()
  let document = await rpc('loadDefinition', { blueprintId }); let saved = JSON.parse(document.definitionJson); const node = saved.graph.nodes[0]
  check('native Save preserves exact host identities and explicit model route', saved.resources[node.agentRef].source.id === 'host-review' && saved.resources[node.skillRefs[0]].source.id === 'host-review-skill' && saved.resources[node.toolsetRefs[0]].source.id === toolId && node.modelSelection.provider === 'unconfigured-provider' && node.modelSelection.model === 'fixture-model' && node.modelSelection.reasoningEffort === 'high')
  await page.locator('.react-flow__node-blueprint').click()
  const nodeSummary = await page.locator('.bp-node-summary').innerText()
  const hostRefs = [node.agentRef, node.skillRefs[0], node.toolsetRefs[0]]
  check('node summary uses Host display names and hides generated reference keys', nodeSummary === `Host Review / QA · host-review-skill · ${toolId}` && hostRefs.every(id => !nodeSummary.includes(id)))
  for (const id of hostRefs) {
    const label = catalog.find(row => row.kind === saved.resources[id].kind && row.id === saved.resources[id].source.id).displayName
    const ref = saved.resources[id]
    const title = await page.locator(`[data-bp-resource-row="dsh:${ref.kind}:${ref.source.id}"] [data-bp-resource-title]`).innerText()
    check(`resource title displays Host label for ${ref.kind}`, title.startsWith(`${label} - `) && !title.includes(id))
  }
  await page.screenshot({ path: join(reportDir, 'host-model-desktop.png'), fullPage: true })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: /XuanLing Blueprint|玄灵蓝图/ }).click()
  await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), blueprintId)
  await page.locator('.react-flow__node-blueprint').click()
  check('native reload restores provider, model and reasoning route', await page.locator('[data-bp-field="modelSelection.model"]').inputValue() === 'fixture-model' && await page.locator('[data-bp-field="modelSelection.reasoningEffort"]').inputValue() === 'high')
  await page.setViewportSize({ width: 800, height: 900 })
  await page.locator('[data-bp-action="toggle-inspector"]').click()
  check('narrow viewport has no horizontal document overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: join(reportDir, 'host-model-narrow.png'), fullPage: true })
  const browserCdp = await edge.browser.newBrowserCDPSession()
  const downloads = join(root, 'downloads'); mkdirSync(downloads)
  await browserCdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true })
  await preparePublicAction(page, 'export-blueprint')
  const downloadEvent = new Promise(resolveDownload => {
    let started
    const timer = setTimeout(() => resolveDownload({ error: 'Native export download did not complete', started }), 15000)
    browserCdp.on('Browser.downloadWillBegin', event => { started = { guid: event.guid, filename: event.suggestedFilename } })
    browserCdp.on('Browser.downloadProgress', event => {
      if (!started || event.guid !== started.guid || event.state === 'inProgress') return
      clearTimeout(timer); resolveDownload({ ...started, state: event.state, receivedBytes: event.receivedBytes })
    })
  })
  const exportResponseEvent = page.waitForResponse(response => /\/api\/blueprint\/exportDefinition(?:\?|$)/.test(response.url()) && response.request().method() === 'POST')
  await page.locator('[data-bp-action="export-blueprint"]').click()
  const exportResponse = await exportResponseEvent, exportWire = await exportResponse.json()
  receipt.exportRpc = { status: exportResponse.status(), ok: exportWire.result?.ok, code: exportWire.result?.error?.code }
  assert.equal(exportWire.result?.ok, true)
  const archiveValue = exportWire.result.value, download = await downloadEvent
  receipt.nativeDownload = download
  assert.equal(download.state, 'completed', download.error)
  assert.match(download.guid, /^[A-Za-z0-9-]+$/)
  const archive = readFileSync(join(downloads, download.guid))
  check('native download matches exact public export RPC bytes', archive.equals(Buffer.from(archiveValue.archiveBase64, 'base64')) && digest(archive) === archiveValue.archiveSha256)
  writeFileSync(join(reportDir, 'host-model.zip'), archive)
  const entries = readZip(archive); const byName = new Map(entries.map(entry => [entry.name, entry.data]))
  const packaged = JSON.parse(byName.get('blueprint.json')); const packagedNode = packaged.graph.nodes[0]
  check('official builtin remains logical while custom preset and MCP use explicit packaged formats', packaged.resources.builtin.source.id === 'minimal' && packaged.resources[packagedNode.agentRef].format === 'agent-preset' && packaged.resources[packagedNode.toolsetRefs[0]].format === 'mcp-definition')
  const skillPath = packaged.resources[packagedNode.skillRefs[0]].path
  check('custom Skill full directory is bundled', byName.has(`${skillPath}/SKILL.md`) && byName.has(`${skillPath}/references/checks.md`))
  check('archive excludes machine locators and retains MCP destination binding requirements', entries.every(entry => !entry.data.toString('utf8').includes(root) && !entry.data.toString('utf8').includes(server)) && archiveValue.requiredBindings.includes(toolId))
  receipt.archive = { files: entries.map(entry => entry.name), sha256: digest(archive), requiredBindings: archiveValue.requiredBindings }
  check('real MCP negotiation created no side effect', !existsSync(sideEffectFile))
  // Only replace this collector's own physical package, never an external root.
  assert.equal(resolve(packageRoot), join(root, 'blueprint'))
  assert.equal(realpathSync(packageRoot), packageRoot)
  rmSync(packageRoot, { recursive: true })
  const imported = await rpc('importDefinition', { blueprintId, archiveBase64: archiveValue.archiveBase64 })
  const importedDocument = await rpc('loadDefinition', { blueprintId }), importedDefinition = JSON.parse(importedDocument.definitionJson)
  check('public import preserves packaged identities and explicit model route', imported.blueprintId === blueprintId
    && importedDefinition.resources.builtin.source.id === 'minimal'
    && importedDefinition.resources[node.agentRef].format === 'agent-preset'
    && importedDefinition.resources[node.toolsetRefs[0]].format === 'mcp-definition'
    && JSON.stringify(importedDefinition.graph.nodes[0].modelSelection) === JSON.stringify(node.modelSelection))
  const reexported = await rpc('exportDefinition', { blueprintId })
  const reexportEntries = readZip(Buffer.from(reexported.archiveBase64, 'base64')), reexportFiles = new Map(reexportEntries.map(entry => [entry.name, entry.data]))
  assert.deepEqual([...reexported.requiredBindings].sort(), [...archiveValue.requiredBindings].sort())
  for (const [path, bytes] of byName) if (path.startsWith('lib/')) assert.deepEqual(reexportFiles.get(path), bytes, `re-export resource bytes: ${path}`)
  check('public import and re-export retain all resource bytes and destination bindings', true)
  check('import and re-export never connect or dispatch MCP side effects', !existsSync(sideEffectFile))
  receipt.importRoundtrip = { blueprintId: imported.blueprintId, closureDigest: imported.closureDigest, filesWritten: imported.filesWritten, reexportFiles: reexportEntries.map(entry => entry.name), requiredBindings: reexported.requiredBindings }
  const probe = await rpc('mcpProbe', { serverName: 'bp_host', toolName: 'record_side_effect', args: { tag: 'host-catalog' } })
  check('real public MCP probe dispatches exactly one controlled side effect', probe.available && probe.dispatched && !probe.isError && readFileSync(sideEffectFile, 'utf8') === 'host-catalog\n')
  check('native browser emitted no errors', receipt.errors.length === 0)
  receipt.ok = true
} catch (error) {
  receipt.ok = false; receipt.failure = error.code ?? error.name; receipt.failedAssertion = error.message
  console.error(receipt.failure, receipt.failedAssertion); process.exitCode = 1
} finally {
  await edge?.close(); await stopHost(host?.child)
  receipt.finishedAt = new Date().toISOString(); receipt.cleaned = true
  writeFileSync(join(reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  rmSync(root, { recursive: true, force: true })
}
