#!/usr/bin/env node
import { selectStyledOption, styledSelectValue } from './styled-control-entry.mjs'
/** W3 C-05/06/07/08/10 mounted UI collector. Run only after main review/build.
 * Reuses the real isolated DSH probe, gateway, native Settings and React Flow.
 * No default profile or credential access. Transport fixtures below prove UI
 * compatibility/races only, NEVER real provider/schema/tool execution.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { prepareCanvasFixtures as baseFixtures, fixtureEvidence } from './canvas-fixtures.mjs'
import { measureCanvasPerformance } from './canvas-journey.mjs'
import { HOST_ASSERTIONS } from './canvas-suite.mjs'
import { setNativeLocale, setNativeTheme } from './i18n-workspace-journey.mjs'
import { dismissOnboardingDialogs } from './onboarding-journey.mjs'
import { redactProbeEvidenceText, stringifyProbeEvidence } from './probe-evidence.mjs'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
export { measureCanvasPerformance }
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const PLUGIN = join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint')
const PLAN_ID = 'dsh-blueprint-runtime-contracts-v1'
export const UI_ASSERTIONS = Object.freeze(['RC-PALETTE', 'RC-INSPECTOR', 'RC-CHECK', 'RC-STALE', 'RC-ASYNC', 'RC-RUN', 'RC-HOST-RECHECK', 'RC-BLOCK', 'RC-SEVERITIES', 'RC-DIAGNOSTICS', 'RC-LEGACY', 'RC-CAPABILITY', 'RC-STRICT', 'RC-RETRY', 'RC-PRESERVE', 'RC-THEMES', 'RC-RELOAD'])
const sha = data => createHash('sha256').update(data).digest('hex')
const action = (page, id) => page.locator(`[data-bp-action="${id}"]`)
const root = page => page.locator('[data-bp-canvas="root"]')
const node = (page, id) => page.locator(`.react-flow__node[data-id="${id}"]`)
const input = page => page.locator('[data-bp-run-input]')
const check = page => page.locator('[data-bp-section="preflight"]')
const rpcPattern = method => new RegExp(`/api/blueprint/${method}(?:\\?|$)`)
function value(response, label) {
  if (response?.status !== 200 || response?.body?.result?.ok !== true) throw new Error(`${label}: real RPC failed (${response?.body?.result?.error?.code ?? response?.status})`)
  return response.body.result.value
}
function ensure(passed, label) { if (!passed) throw new Error(label) }
const requestArgs = request => { const body = request.postDataJSON(); return body?.payload?.args?.args ?? body?.payload?.args }

function flowDefinition(id, configured = true) {
  return { schemaVersion: 1, id, name: `UI · ${id}`, resources: {}, graph: {
    nodes: [
      { id: 'ui-gate', kind: 'condition', inputs: { predicate: 'boolean' }, branches: ['yes', 'no'], ...(configured ? { condition: { inputPort: 'predicate', trueBranch: 'yes', falseBranch: 'no' } } : {}) },
      { id: 'yesPath', kind: 'output' }, { id: 'noPath', kind: 'output' }, { id: 'merge', kind: 'join' },
    ], edges: [{ kind: 'control', from: 'ui-gate@yes', to: 'yesPath' }, { kind: 'control', from: 'ui-gate@no', to: 'noPath' },
      { kind: 'control', from: 'yesPath', to: 'merge' }, { kind: 'control', from: 'noPath', to: 'merge' }],
  }, presentation: { nodes: { 'ui-gate': { x: 70, y: 100 }, yesPath: { x: 380, y: 30 }, noPath: { x: 380, y: 270 }, merge: { x: 680, y: 130 } } } }
}
export function prepareCanvasFixtures(tempRoot, decode, validate) {
  const fixtures = baseFixtures(tempRoot, decode, validate)
  // Empty explicit binding proves warning/info presentation, not MCP reachability.
  fixtures.config.toolBindings = { 'ui-empty-binding': { tools: [] } }
  const severities = flowDefinition('runtime-ui-severities', false)
  severities.resources = { agent: { kind: 'agent', path: 'lib/agents/ui.md' }, mcp: { kind: 'mcp', bindingId: 'ui-empty-binding' }, schema: { kind: 'schema', path: 'lib/schemas/ui.json' } }
  severities.graph.nodes.push({ id: 'ui-agent', kind: 'agentTask', agentRef: 'agent', toolsetRefs: ['mcp'], toolAllowlist: [], outputSchemaRef: 'schema' })
  severities.presentation.nodes['ui-agent'] = { x: 70, y: 420 }
  const any = flowDefinition('runtime-ui-any'); any.graph.nodes.find(n => n.kind === 'join').join = 'any'
  for (const definition of [flowDefinition('runtime-ui-flow'), flowDefinition('runtime-ui-legacy', false), severities, any]) {
    validate(decode(JSON.stringify(definition))) // Broken fixtures are harness failures.
    const packageRoot = join(tempRoot, 'blueprints', definition.id)
    mkdirSync(packageRoot, { recursive: true }); fixtures.config.blueprints[definition.id] = packageRoot
    writeFileSync(join(packageRoot, 'blueprint.json'), JSON.stringify(definition))
    if (definition.resources.agent) {
      mkdirSync(join(packageRoot, 'lib/agents'), { recursive: true }); mkdirSync(join(packageRoot, 'lib/schemas'), { recursive: true })
      writeFileSync(join(packageRoot, 'lib/agents/ui.md'), '---\nname: UI-only fixture\ndescription: Never invoked by this collector\n---\nNo provider acceptance is claimed.\n')
      writeFileSync(join(packageRoot, 'lib/schemas/ui.json'), '{"type":"object","properties":{"value":{"type":"string"}}}')
    }
    fixtures.evidence.push({ ...fixtureEvidence(definition), generator: 'runtime-contracts-ui.mjs:flowDefinition/ui-only-v1', providerEvidence: false })
  }
  return fixtures
}
async function idle(page) { await page.waitForFunction(() => !document.querySelector('[data-bp-action="refresh-library"]')?.disabled) }
async function choose(page, id, count = 4) {
  await idle(page); await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), id)
  await page.waitForFunction(({ id, count }) => document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-blueprint') === id && document.querySelectorAll('[data-bp-node]').length === count, { id, count })
  await idle(page)
}
async function waitCheck(page, state) { await page.locator(`[data-bp-preflight="${state}"]`).waitFor({ state: 'visible' }) }
async function clickCheck(page) { await action(page, 'check-run').click(); await idle(page); await waitCheck(page, 'current') }
async function runSnapshot(page, api) {
  const runId = (await page.locator('[data-bp-run]').textContent()).split(' · ')[0].trim()
  ensure(runId !== '' && await page.locator('[data-bp-run]').getAttribute('data-bp-run') !== 'none', 'Run binding missing')
  return value(await api('inspectRun', { runId }), 'inspect bound Run')
}
async function settle(page, api) {
  let snapshot = await runSnapshot(page, api)
  for (let i = 0; i < 60 && !['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required', 'waiting_input'].includes(snapshot.state); i++) snapshot = value(await api('inspectRun', { runId: snapshot.runId }), 'bounded real inspect')
  ensure(snapshot.state === 'succeeded', `structural fixture did not succeed: ${snapshot.state}`)
  await action(page, 'retry-inspect').click(); await idle(page)
  await page.locator('[data-bp-run="succeeded"]').waitFor({ state: 'visible' })
  return snapshot
}
async function reopen(page) {
  await dismissOnboardingDialogs(page)
  if (!await root(page).isVisible()) await page.getByRole('button', { name: /^(XuanLing Blueprint|XuanLing 蓝图|玄灵蓝图)$/ }).click()
  await root(page).waitFor({ state: 'visible' })
}
async function preservation(page, api) {
  const ui = await root(page).evaluate(el => ({
    id: el.getAttribute('data-bp-blueprint'), input: el.querySelector('[data-bp-run-input]')?.value,
    selection: [...el.querySelectorAll('.react-flow__node.selected')].map(n => n.dataset.id).sort(),
    viewport: el.querySelector('.react-flow__viewport')?.getAttribute('style'),
    undo: el.querySelector('[data-bp-action="undo"]')?.disabled, redo: el.querySelector('[data-bp-action="redo"]')?.disabled,
    dirty: el.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty'),
    draft: localStorage.getItem(`xuanling-blueprint:draft:${encodeURIComponent(el.getAttribute('data-bp-blueprint'))}`),
    binding: localStorage.getItem(`xuanling-blueprint:recent-run:${encodeURIComponent(el.getAttribute('data-bp-blueprint'))}`),
    fields: [...el.querySelectorAll('[data-bp-field],[data-bp-json]')].map(el => [el.getAttribute('data-bp-field') ?? el.getAttribute('data-bp-json'), el.getAttribute('data-bp-value') ?? el.value]),
    runId: el.querySelector('[data-bp-run]')?.textContent?.split(' · ')[0].trim(),
  }))
  return { ui, document: value(await api('loadDefinition', { blueprintId: ui.id }), 'preservation document'), run: await runSnapshot(page, api) }
}

export async function runCanvasJourney(page, record, api) {
  const evidenceDir = process.env.BP_RUNTIME_UI_ARTIFACT_DIR
  ensure(evidenceDir && isAbsolute(evidenceDir), 'fresh explicit UI artifact directory required')
  await page.setViewportSize({ width: 1700, height: 1100 })
  const requests = []
  const observe = request => {
    if (request.method() !== 'POST' || !/\/api\/blueprint\//.test(request.url())) return
    const method = new URL(request.url()).pathname.split('/').at(-1)
    if (['saveDefinition', 'preflightRun', 'startRun'].includes(method)) requests.push({ method, args: requestArgs(request) })
  }
  page.on('request', observe)
  const assert = (id, description, ok, detail = '') => { record(id, description, ok, detail); ensure(ok, `${id}: ${description}`) }
  const receipt = { planId: PLAN_ID, keyRead: false, providerEvidence: false, transportFixtures: [], themes: [], bindings: [] }
  try {
    await setNativeLocale(page, 'en'); await choose(page, 'runtime-ui-flow')
    const palette = await page.locator('.bp-palette-entry').evaluateAll(items => items.map(el => el.getAttribute('data-bp-action')).sort())
    assert('RC-PALETTE', 'only accepted executors appear in the mounted palette', isDeepStrictEqual(palette, ['add-input', 'add-output', 'add-agentTask', 'add-humanDecision', 'add-condition', 'add-join'].sort()))
    await node(page, 'ui-gate').locator('.bp-node-title').click()
    ensure(await styledSelectValue(page.locator('[data-bp-field="condition.inputPort"]')) === 'predicate', 'condition boolean port identity changed')
    await selectStyledOption(page, page.locator('[data-bp-field="condition.trueBranch"]'), 'no')
    await page.waitForFunction(() => !document.querySelector('[data-bp-action="undo"]').disabled)
    await action(page, 'undo').click()
    ensure(await styledSelectValue(page.locator('[data-bp-field="condition.trueBranch"]')) === 'yes', 'condition undo lost exact branch')
    await node(page, 'merge').locator('.bp-node-title').click()
    ensure(await styledSelectValue(page.locator('[data-bp-field="join"]')) === 'all', 'omitted join did not display default all')
    assert('RC-INSPECTOR', 'real condition selectors and default-all join are editable and undoable without translating identifiers', true)
    const payload = '{ "predicate": true, "用户.payload": "unchanged" }'
    await input(page).fill(payload); await clickCheck(page)
    const doc = value(await api('loadDefinition', { blueprintId: 'runtime-ui-flow' }), 'saved check document')
    const checked = requests.filter(r => r.method === 'preflightRun').at(-1)
    const saved = requests.filter(r => r.method === 'saveDefinition').at(-1)
    assert('RC-CHECK', 'Check saves first and sends the exact saved revision and captured input to real Host', saved?.args.blueprintId === doc.blueprintId && checked?.args.expectedRevision === doc.documentRevision && checked?.args.inputJson === payload && await page.locator('[data-bp-preflight-revision]').getAttribute('data-bp-preflight-revision') === doc.documentRevision)
    await input(page).fill('{"predicate":false}'); await waitCheck(page, 'stale'); await input(page).fill(payload)
    ensure(await check(page).getAttribute('data-bp-preflight') === 'stale', 'input roundtrip resurrected old check')
    await clickCheck(page); await node(page, 'ui-gate').locator('.bp-node-title').click(); await action(page, 'clear-condition').click(); await waitCheck(page, 'stale'); await action(page, 'undo').click()
    ensure(await check(page).getAttribute('data-bp-preflight') === 'stale', 'semantic undo resurrected old check')
    await choose(page, 'runtime-ui-any'); await waitCheck(page, 'stale'); await choose(page, 'runtime-ui-flow')
    assert('RC-STALE', 'input, semantic edits/undo and blueprint generation invalidate old reports', await check(page).getAttribute('data-bp-preflight') === 'stale')

    // Hold a REAL canStart response until after native input changes. No sleep,
    // no injected workspace object, no old result converted into a permission.
    const ready = Promise.withResolvers(), release = Promise.withResolvers()
    const handler = async route => {
      try { const response = await route.fetch(); const body = await response.json(); ensure(body.result?.value?.canStart === true, 'held response must be real canStart'); ready.resolve(); await release.promise; await route.fulfill({ response }) }
      catch (error) { ready.reject(error); throw error }
    }
    await page.route(rpcPattern('preflightRun'), handler)
    const startsBefore = requests.filter(r => r.method === 'startRun').length
    try {
      await action(page, 'start-run').click(); await ready.promise
      await input(page).fill('{"predicate":false,"race":"new"}'); release.resolve(); await idle(page); await waitCheck(page, 'stale')
    } finally { release.resolve(); await page.unroute(rpcPattern('preflightRun'), handler) }
    assert('RC-ASYNC', 'late real canStart cannot overwrite stale state or cause admission', requests.filter(r => r.method === 'startRun').length === startsBefore)
    receipt.transportFixtures.push({ kind: 'delay-only-real-response', providerEvidence: false })

    await input(page).fill(payload); await action(page, 'start-run').click(); await idle(page)
    const run = await settle(page, api), start = requests.filter(r => r.method === 'startRun').at(-1)
    const admittedDoc = value(await api('loadDefinition', { blueprintId: 'runtime-ui-flow' }), 'admitted document')
    assert('RC-RUN', 'native Run rechecks and admits captured saved revision/input; condition and selected-only join settle durably', start?.args.expectedRevision === admittedDoc.documentRevision && start?.args.inputJson === payload && run.definitionRevision === admittedDoc.semanticRevision && run.attempts.some(a => a.nodeId === 'ui-gate' && a.state === 'succeeded') && run.attempts.some(a => a.nodeId === 'noPath' && a.state === 'skipped') && run.attempts.some(a => a.nodeId === 'merge' && a.state === 'succeeded'))
    receipt.bindings.push({ runId: run.runId, documentRevision: admittedDoc.documentRevision, semanticRevision: run.definitionRevision, inputSha256: sha(payload) })
    const actual = run.attempts.find(a => a.nodeId === 'ui-gate')?.diagnostics
    ensure(actual?.status === 'available', 'real durable structural diagnostics absent')
    await page.locator('[data-bp-attempt="ui-gate"] > summary').click()
    const durableText = await page.locator('[data-bp-attempt="ui-gate"] [data-bp-diagnostics]').textContent()
    assert('RC-DIAGNOSTICS', 'existing Attempt details display real durable whitelist digests, not raw input or errors', durableText.includes(actual.input.sha256) && durableText.includes(actual.acceptance.code) && !durableText.includes('unchanged') && !durableText.includes('rawBody'))

    // Real Host stale-revision command, not a client-supplied canStart token.
    const rejected = await api('startRun', { blueprintId: admittedDoc.blueprintId, expectedRevision: 'stale-ui-revision', inputJson: payload, requestId: `ui-stale-${crypto.randomUUID()}` })
    assert('RC-HOST-RECHECK', 'Host independently rejects stale saved revision rather than trusting UI report', rejected.body?.result?.ok === false && rejected.body.result.error?.code === 'blueprint/revision-conflict')

    // Synthetic transport compatibility has explicit provenance; old records
    // themselves are tested by the separate real storage contracts.
    const legacy = async route => {
      const response = await route.fetch(), body = await response.json()
      for (const attempt of body.result.value.attempts) delete attempt.diagnostics
      await route.fulfill({ response, json: body })
    }
    await page.route(rpcPattern('inspectRun'), legacy)
    try {
      await action(page, 'retry-inspect').click(); await idle(page)
      await page.locator('[data-bp-attempt="ui-gate"] [data-bp-diagnostics="unavailable"]').waitFor({ state: 'visible' })
      assert('RC-LEGACY', 'mounted UI explicitly renders legacy absence unavailable, never fabricates durable facts', true)
    } finally { await page.unroute(rpcPattern('inspectRun'), legacy) }
    receipt.transportFixtures.push({ kind: 'legacy-diagnostics-absence', providerEvidence: false })
    const raw = async route => {
      const response = await route.fetch(), body = await response.json()
      body.result.value.attempts.find(a => a.diagnostics?.status === 'available').diagnostics.rawBody = 'UI_PRIVATE_RAW_SENTINEL'
      await route.fulfill({ response, json: body })
    }
    await page.route(rpcPattern('inspectRun'), raw)
    try {
      await action(page, 'retry-inspect').click(); await idle(page)
      assert('RC-STRICT', 'strict remote rejects unknown raw diagnostics and preserves the previous unavailable projection', !(await root(page).textContent()).includes('UI_PRIVATE_RAW_SENTINEL') && await page.locator('[data-bp-attempt="ui-gate"] [data-bp-diagnostics]').getAttribute('data-bp-diagnostics') === 'unavailable' && (await page.locator('[data-bp-status="message"]').textContent()).includes('blueprint/'))
    } finally { await page.unroute(rpcPattern('inspectRun'), raw) }
    receipt.transportFixtures.push({ kind: 'unknown-raw-field-rejection', providerEvidence: false })
    await action(page, 'retry-inspect').click(); await idle(page)

    await choose(page, 'runtime-ui-severities', 5); await clickCheck(page)
    const statuses = await page.locator('[data-bp-check-status]').evaluateAll(items => [...new Set(items.map(el => el.getAttribute('data-bp-check-status')))].sort())
    assert('RC-SEVERITIES', 'real Host report renders block/warning/info/pass without translating static codes', isDeepStrictEqual(statuses, ['block', 'info', 'pass', 'warning']))
    await node(page, 'ui-agent').locator('.bp-node-title').click()
    ensure(await styledSelectValue(page.locator('[data-bp-field="outputSchemaRef"]')) === 'schema', 'W2 schema binding lost')
    await page.locator('[data-bp-inspector-advanced]').click()
    ensure(JSON.parse(await page.locator('[data-bp-json="options"]').inputValue()).toolAllowlist.length === 0, 'W2 allowlist field not retained')
    let before = requests.filter(r => r.method === 'startRun').length
    await action(page, 'start-run').click(); await idle(page)
    ensure(requests.filter(r => r.method === 'startRun').length === before, 'blocked report fell through to Host start')
    await choose(page, 'runtime-ui-any'); await action(page, 'start-run').click(); await idle(page)
    assert('RC-BLOCK', 'missing condition config and join-any remain readable but native Run refuses admission', requests.filter(r => r.method === 'startRun').length === before && (await check(page).textContent()).includes('node-executor-unavailable'))

    const unsupportedDoc = value(await api('loadDefinition', { blueprintId: 'runtime-ui-any' }), 'unsupported saved document')
    const unsupported = await api('startRun', { blueprintId: unsupportedDoc.blueprintId, expectedRevision: unsupportedDoc.documentRevision, inputJson: payload, requestId: 'runtime-ui-host-recheck' })
    ensure(unsupported.body?.result?.ok === false && unsupported.body.result.error?.code === 'blueprint/preflight-blocked', 'fresh unsupported Host admission bypassed preflight')

    await choose(page, 'runtime-ui-flow'); await input(page).fill(payload)
    const capability = async route => {
      const response = await route.fetch(), body = await response.json()
      await route.fulfill({ response, json: { ...body, result: { ok: false, error: { code: 'blueprint/capability-unavailable', message: 'preflight capability unavailable', details: {} } } } })
    }
    const startsBeforeUnavailable = requests.filter(r => r.method === 'startRun').length
    await page.route(rpcPattern('preflightRun'), capability)
    try {
      await action(page, 'start-run').click(); await idle(page); await waitCheck(page, 'unavailable')
      assert('RC-CAPABILITY', 'old Host typed capability-unavailable is visible and fails closed without admission', requests.filter(r => r.method === 'startRun').length === startsBeforeUnavailable && (await check(page).textContent()).includes('blueprint/capability-unavailable'))
    } finally { await page.unroute(rpcPattern('preflightRun'), capability) }
    receipt.transportFixtures.push({ kind: 'legacy-host-capability-unavailable', providerEvidence: false })

    // Ambiguous transport loss AFTER actual Host admission. Retry must replay
    // the same id/payload, not create a second Run. No model fixture involved.
    await choose(page, 'runtime-ui-flow'); await input(page).fill(payload)
    let lostRunId
    const lost = async route => {
      const response = await route.fetch(), body = await response.json()
      ensure(body.result?.ok === true, 'lost admission must originate at real Host'); lostRunId = body.result.value.runId
      await route.fulfill({ response, json: { ...body, result: { ok: false, error: { code: 'blueprint/transport-unavailable', message: 'admission transport unavailable', details: {} } } } })
    }
    await page.route(rpcPattern('startRun'), lost)
    try { await action(page, 'start-run').click(); await idle(page) } finally { await page.unroute(rpcPattern('startRun'), lost) }
    const ambiguous = requests.filter(r => r.method === 'startRun').at(-1)
    await action(page, 'start-run').click(); await idle(page); const replay = await settle(page, api)
    const retry = requests.filter(r => r.method === 'startRun').at(-1)
    assert('RC-RETRY', 'same captured payload reuses pending requestId and replays the actual lost Host admission', lostRunId === replay.runId && isDeepStrictEqual(ambiguous.args, retry.args))
    receipt.transportFixtures.push({ kind: 'lost-real-admission-ui-retry', providerEvidence: false })

    // Native pointer movement makes real history/draft; zoom makes real viewport.
    await node(page, 'ui-gate').locator('.bp-node-title').click()
    const title = node(page, 'ui-gate').locator('.bp-node-title'), box = await title.boundingBox()
    ensure(box && box.width > 0, 'selected condition is not hit-testable')
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 36, y + 24, { steps: 6 }); await page.mouse.up()
    await page.waitForFunction(() => !document.querySelector('[data-bp-action="undo"]').disabled)
    const viewport = await page.locator('.react-flow__viewport').getAttribute('style')
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
    await page.waitForFunction(before => document.querySelector('.react-flow__viewport').getAttribute('style') !== before, viewport)
    const stable = await preservation(page, api)
    ensure(stable.ui.input === payload && stable.ui.undo === false && stable.ui.selection.includes('ui-gate') && stable.ui.runId === replay.runId && stable.ui.dirty === 'true', 'preservation preconditions lack actual input/selection/history/run/draft')
    const style = page.locator('#xuanling-blueprint-canvas-css'), css = await style.textContent()
    for (const locale of ['zh', 'en']) for (const scheme of ['light', 'dark']) {
      await setNativeLocale(page, locale); await setNativeTheme(page, scheme)
      const current = await preservation(page, api)
      ensure(isDeepStrictEqual(current, stable), `native ${locale}/${scheme} changed selection/input/viewport/history/draft/Run or canonical payload/revision`)
      const dimensions = await root(page).evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height,
        scheme: getComputedStyle(document.documentElement).colorScheme, overflow: document.documentElement.scrollWidth > innerWidth,
        background: getComputedStyle(el).backgroundColor, bodyBackground: getComputedStyle(document.body).backgroundColor }))
      ensure(dimensions.width >= 800 && dimensions.height >= 500 && !dimensions.overflow && dimensions.scheme === scheme && dimensions.background === dimensions.bodyBackground && await style.textContent() === css, 'native theme/layout contract failed')
      const screenshot = join(evidenceDir, `${locale}-${scheme}.png`)
      await page.screenshot({ path: screenshot, fullPage: false })
      receipt.themes.push({ locale, scheme, screenshot, ...dimensions })
    }
    assert('RC-PRESERVE', 'native locale/theme roundtrips preserve actual input, selection, viewport, history, draft and Run binding plus canonical document/run', true)
    assert('RC-THEMES', 'actual zh/en × light/dark Settings and React Flow render in the existing DSH theme', receipt.themes.length === 4)
    await action(page, 'save-layout').click(); await idle(page)
    const finalDoc = value(await api('loadDefinition', { blueprintId: 'runtime-ui-flow' }), 'save before reload')
    ensure(finalDoc.semanticRevision === admittedDoc.semanticRevision, 'layout-only save changed payload semantics')
    const startsBeforeReload = requests.filter(r => r.method === 'startRun').length
    await page.reload({ waitUntil: 'domcontentloaded' }); await reopen(page); await choose(page, 'runtime-ui-flow')
    const reloaded = await runSnapshot(page, api), loadedDoc = value(await api('loadDefinition', { blueprintId: 'runtime-ui-flow' }), 'reload document')
    assert('RC-RELOAD', 'saved condition/default-all join and durable Run rebind on real browser reload without issuing a new command', isDeepStrictEqual(loadedDoc, finalDoc) && reloaded.runId === replay.runId && await page.locator('[data-bp-run]').getAttribute('data-bp-run') === 'succeeded' && requests.filter(r => r.method === 'startRun').length === startsBeforeReload && requests.filter(r => r.method === 'startRun').at(-1)?.args.requestId === retry.args.requestId)
    writeFileSync(join(evidenceDir, 'runtime-ui-evidence.json'), stringifyProbeEvidence(receipt))
    return { provenance: 'real DSH boot graph / gateway / native settings / React Flow; transport fixtures are UI-only', binding: receipt.bindings, runtimeContracts: receipt }
  } finally { page.off('request', observe);  }
}

function replaceOnce(source, before, after) {
  ensure(source.split(before).length === 2, `probe adapter anchor absent/ambiguous: ${before}`)
  return source.replace(before, after)
}
function confined(dir, path) { if (!isAbsolute(path ?? '')) return false; const rel = relative(dir, path); return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') }
function validateReport(report, output, invokedAt, finishedAt, planId) {
  ensure(report?.passed === true && report.plan_id === planId && report.environment?.canvas_test === 'browser', 'probe plan/mode/failure mismatch')
  ensure(Date.parse(report.started_at) >= invokedAt && Date.parse(report.finished_at) >= Date.parse(report.started_at) && Date.parse(report.finished_at) <= finishedAt, 'stale probe timestamps')
  ensure(Array.isArray(report.assertions), 'assertions missing')
  const ids = new Set()
  for (const assertion of report.assertions) { ensure(assertion.passed === true && !ids.has(assertion.id), `failed/duplicate assertion: ${assertion.id}`); ids.add(assertion.id) }
  for (const id of [...HOST_ASSERTIONS, ...UI_ASSERTIONS]) ensure(ids.has(id), `required assertion missing: ${id}`)
  ensure(report.environment.dsh_version_output === '0.2.1-alpha.1' && report.environment.browser_version, 'real DSH/browser provenance absent')
  const tools = report.artifacts?.host_tools_contract
  ensure(confined(output, report.artifacts?.sidebar_screenshot) && existsSync(report.artifacts.sidebar_screenshot) && confined(join(output, 'tools'), tools?.reportPath) && existsSync(tools.reportPath), 'isolated screenshot/security report absent')
  const nested = JSON.parse(readFileSync(tools.reportPath, 'utf8'))
  ensure(tools.status === 0 && nested.passed === true && nested.plan_id === planId && isDeepStrictEqual(nested, tools.report), 'nested real Tools gate missing/failed')
  for (const name of ['lib/index.js', 'lib/client.js', 'lib/typert.host.js']) ensure(report.artifacts?.plugin_source?.[name] === sha(readFileSync(join(PLUGIN, name))), `stale packed artifact: ${name}`)
  const journey = report.artifacts?.canvas_journey
  ensure(journey?.provenance?.startsWith('real DSH boot graph') && journey.binding?.length > 0 && journey.runtimeContracts?.keyRead === false && journey.runtimeContracts?.providerEvidence === false && journey.runtimeContracts?.themes?.length === 4, 'mounted UI receipt absent/mislabeled')
  for (const theme of journey.runtimeContracts.themes) ensure(confined(output, theme.screenshot) && existsSync(theme.screenshot), 'native theme screenshot absent')
  return { ok: true, assertions: report.assertions.length }
}
async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') { console.log('node runtime-contracts-ui.mjs --report-dir <absolute-new-parent> [--plan-id dsh-blueprint-runtime-contracts-v1]\nMain review/build required. Boots real isolated DSH/browser/gateway; transport fixtures are UI-only.'); return }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split('=')
    ensure(['--report-dir', '--plan-id'].includes(flag) && options[flag] === undefined, `unknown/duplicate option: ${flag}`)
    const val = inline ?? args[++i]; ensure(val && !val.startsWith('--'), `${flag} requires a value`); options[flag] = val
  }
  ensure(isAbsolute(options['--report-dir'] ?? ''), '--report-dir must explicitly name an absolute isolated report parent')
  const planId = options['--plan-id'] ?? PLAN_ID
  ensure(planId === PLAN_ID, 'collector is frozen to the runtime-contracts plan')
  const reports = resolve(options['--report-dir']); mkdirSync(reports, { recursive: true })
  const output = mkdtempSync(join(reports, 'runtime-ui-'))
  const probePath = join(HERE, 'probe.mjs'), original = readFileSync(probePath, 'utf8'), self = pathToFileURL(fileURLToPath(import.meta.url)).href
  let adapted = original.replace(/from '\.\/([^']+\.mjs)'/g, (_, name) => `from '${pathToFileURL(join(HERE, name)).href}'`)
    .replace(/import\('\.\/([^']+\.mjs)'\)/g, (_, name) => `import('${pathToFileURL(join(HERE, name)).href}')`)
  adapted = replaceOnce(adapted, 'const HERE = dirname(fileURLToPath(import.meta.url))', `const HERE = ${JSON.stringify(HERE)}`)
  adapted = replaceOnce(adapted, pathToFileURL(join(HERE, 'canvas-journey.mjs')).href, self)
  adapted = replaceOnce(adapted, pathToFileURL(join(HERE, 'canvas-fixtures.mjs')).href, self)
  adapted = replaceOnce(adapted, "const pw = await import('playwright')", `const pw = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'test/blueprint/node_modules/playwright/index.mjs')).href)})`)
  const driver = join(output, 'isolated-probe.mjs'); writeFileSync(driver, adapted)
  writeFileSync(join(output, 'driver-provenance.json'), stringifyProbeEvidence({ planId, probeSha256: sha(original), adapterSha256: sha(adapted), collectorSha256: sha(readFileSync(fileURLToPath(import.meta.url))), originalProbe: probePath, keyRead: false, providerEvidence: false }))
  const fingerprint = captureEvidenceFingerprint(), invokedAt = Date.now(), env = { BP_RUNTIME_UI_ARTIFACT_DIR: output }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key]
  const run = spawnSync(process.execPath, [driver, `--plugin-dir=${PLUGIN}`, '--expect=blueprint', '--canvas-test=browser', `--report-dir=${output}`, `--plan-id=${planId}`], { cwd: join(ROOT, 'test/blueprint'), env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 30 * 1024 * 1024 })
  writeFileSync(join(output, 'driver.stdout.log'), redactProbeEvidenceText(run.stdout ?? ''))
  writeFileSync(join(output, 'driver.stderr.log'), redactProbeEvidenceText(run.stderr ?? ''))
  const fingerprintAfter = captureEvidenceFingerprint()
  let gate, report
  try { report = JSON.parse(readFileSync(join(output, 'w0.2-probe-report.json'), 'utf8')); gate = validateReport(report, output, invokedAt, Date.now(), planId) }
  catch (error) { gate = { ok: false, error: redactProbeEvidenceText(error.message) } }
  const passed = run.status === 0 && !run.signal && !run.error && gate.ok && isDeepStrictEqual(fingerprint, fingerprintAfter)
  writeFileSync(join(output, 'runtime-ui-gate.json'), stringifyProbeEvidence({ planId, passed, exitCode: run.status, signal: run.signal, processError: run.error?.code, gate, fingerprint, fingerprintAfter, keyRead: false, providerEvidence: false, reportDir: output }))
  console.log(stringifyProbeEvidence({ passed, exitCode: run.status, gate, browserError: report?.artifacts?.browser_error ?? null, reportDir: output }))
  process.exitCode = passed ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
