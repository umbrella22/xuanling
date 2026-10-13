#!/usr/bin/env node
/** W2 collector. Only main may launch after review, official build and freeze.
 * Adapts an isolated COPY of the actual DSH probe; original Host assertions,
 * gateway, boot graph, credentials isolation and timing budgets stay intact.
 * Synthetic tests validate this oracle; they never count as mounted evidence.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { prepareCanvasFixtures as originalFixtures, fixtureEvidence } from './canvas-fixtures.mjs'
import { runCanvasJourney as originalJourney, measureCanvasPerformance, BROWSER_ASSERTIONS, PERFORMANCE_BUDGET } from './canvas-journey.mjs'
import { HOST_ASSERTIONS, validateCanvasReport } from './canvas-suite.mjs'
import { setNativeTheme } from './i18n-workspace-journey.mjs'
import { dismissOnboardingDialogs } from './onboarding-journey.mjs'
import { redactProbeEvidenceText, stringifyProbeEvidence } from './probe-evidence.mjs'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
import { BLUEPRINT_PACKAGE } from '../../../integrations/deepseek-harness/xuanling-blueprint/src/typert-descriptors.ts'
import { HOST_CONTROLS_PLAN_ID, COMPACT_PLAN_ID, reportPathAllowed, preparePublicAction, closePublicMore, preparePublicCommand, prepareRunInput, setPublicNativeLocale as setNativeLocale } from './compact-ui-entry.mjs'
export { measureCanvasPerformance, HOST_CONTROLS_PLAN_ID }
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const PLUGIN = join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint')
export const PLAN_ID = 'dsh-blueprint-comfy-interactions-v1'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const ensure = (condition, message) => { if (!condition) throw new Error(message) }
const repeated = prefix => [1, 2, 3].map(i => `${prefix}-${i}`)
export const UI_ASSERTIONS = Object.freeze([
  'CI-MENU-FOCUS', 'CI-MENU-KEYBOARD', 'CI-SEARCH', 'CI-SEARCH-CANCEL',
  'CI-SPACE-PAN', 'CI-MIDDLE-PAN', 'CI-HORIZONTAL-WHEEL', 'CI-BOX-SELECTION', 'CI-SELECT-ALL', 'CI-GESTURE-CANCEL', 'CI-OVERLAY-OUTSIDE',
  'CI-DROP-COMPATIBLE', 'CI-DROP-INCOMPATIBLE', 'CI-DROP-CANCEL',
  'CI-COPY-PASTE', 'CI-CUT', 'CI-CLIPBOARD-DENIED', ...repeated('CI-CLIPBOARD-LATE'), 'CI-INCOMING', 'CI-ALT-CLONE',
  ...repeated('CI-RECONNECT-INVALID'), ...repeated('CI-RECONNECT-VALID'), 'CI-RECONNECT-CANCEL', 'CI-SHIFT-COPY', 'CI-BULK-DISCONNECT',
  'CI-REROUTE-ADD', 'CI-REROUTE-MOVE', 'CI-REROUTE-DELETE', 'CI-PIN', 'CI-COLLAPSE', 'CI-RENAME', 'CI-RESIZE', 'CI-COLOR',
  'CI-GROUP', 'CI-GROUP-RENAME', 'CI-GROUP-MOVE', 'CI-GROUP-COPY', 'CI-GROUP-FIT', 'CI-UNGROUP', 'CI-ALIGN', 'CI-DISTRIBUTE',
  'CI-VIEWPORT-PREFERENCES', 'CI-VIEWPORT-SWITCH', 'CI-VIEWPORT-RELOAD', 'CI-TYPING', 'CI-IME', 'CI-CAS',
  ...repeated('CI-SAVE-LOAD'), 'CI-ARCHIVE-DOWNLOAD', 'CI-IMPORT-LOCK', 'CI-ARCHIVE-EMPTY', 'CI-ARCHIVE-NONEMPTY', 'CI-CURRENT-EXPORT',
  'CI-THEMES', 'CI-ZERO-PROVIDER',
])
export const REQUIRED_ASSERTIONS = Object.freeze([...new Set([...HOST_ASSERTIONS, ...BROWSER_ASSERTIONS, ...UI_ASSERTIONS])])
export const SELECTORS = Object.freeze({
  root: '[data-bp-canvas="root"]', surface: '[data-bp-canvas="surface"]', select: '[data-bp-select="blueprint"]',
  menu: '[data-bp-overlay="context-menu"]', search: '[data-bp-overlay="node-search"]', searchInput: '[data-bp-search-input]',
  rename: '[data-bp-overlay="rename"]', renameInput: '[data-bp-rename-field]', file: '[data-bp-import-file]',
})
const action = (page, id) => page.locator(`[data-bp-action="${id}"]`)
const node = (page, id) => page.locator(`.react-flow__node[data-id="${id}"]`)
const port = (page, id, direction) => page.locator(`[data-bp-port="${id}"].${direction}`)
const menuCommand = (page, command) => page.locator(`[data-bp-menu-command="${command}"]`)
const same = isDeepStrictEqual
function value(response, label) {
  ensure(response?.status === 200 && response?.body?.result?.ok === true, `${label}: real RPC failed (${response?.body?.result?.error?.code ?? response?.status})`)
  return response.body.result.value
}
function confined(dir, path) {
  if (!isAbsolute(path ?? '')) return false
  const rel = relative(resolve(dir), resolve(path))
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\')
}
function realFile(dir, path) {
  return confined(dir, path) && existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()
    && confined(realpathSync(dir), realpathSync(path))
}
export function assertEmptyImportFixture(fixture) {
  const message = 'empty import fixture escapes disposable root'
  ensure(fixture.initiallyEmpty === true && isAbsolute(fixture.tempRoot ?? '') && fixture.tempRoot === resolve(fixture.tempRoot)
    && fixture.empty === join(fixture.tempRoot, 'blueprints', 'comfy-empty') && confined(fixture.tempRoot, fixture.empty), message)
  // Reject links in owned components before resolving the target; /var's OS alias remains valid.
  for (const path of [fixture.tempRoot, join(fixture.tempRoot, 'blueprints'), fixture.empty]) {
    const stat = lstatSync(path)
    ensure(stat.isDirectory() && !stat.isSymbolicLink(), message)
  }
  const canonicalRoot = realpathSync(fixture.tempRoot), canonicalEmpty = realpathSync(fixture.empty)
  ensure(confined(canonicalRoot, canonicalEmpty) && canonicalEmpty === join(canonicalRoot, 'blueprints', 'comfy-empty'), message)
}
export function verifyArchiveDownload(bytes, response, blueprintId) {
  const archive = value(response, 'same real Host archive response')
  ensure(archive.blueprintId === blueprintId && bytes.length > 0 && sha256(bytes) === archive.archiveSha256
    && bytes.equals(Buffer.from(archive.archiveBase64 ?? '', 'base64')), 'download bytes/hash/configured identity differ from same export response')
  return archive
}
function importLockWitness({ before, stages, keys } = {}) {
  const names = ['locked', 'control-o', 'meta-o', 'unlocked', 'ordinary-import']
  return !!before?.definition && !!before.hostDocument && typeof before.history?.undo === 'boolean' && typeof before.history.redo === 'boolean'
    && ['true', 'false'].includes(before.history.dirty) && before.locked === false && before.importButtonVisible === true && before.importDisabled === false && before.importVisible === false
    && Array.isArray(stages) && stages.length === names.length && stages.every((state, index) => state.kind === names[index]
      && same(state.definition, before.definition) && same(state.hostDocument, before.hostDocument) && same(state.history, before.history)
      && state.importButtonVisible === true && state.locked === (index < 3) && state.importDisabled === (index < 3) && state.importVisible === (index === 4)
      && (![1, 2].includes(index) || (state.noticeVisible === true && state.noticeKey === 'interaction.disabled.canvas-locked' && typeof state.noticeText === 'string' && state.noticeText.trim().length > 0)))
    && Array.isArray(keys) && keys.length === 4 && keys.every((event, index) => event.key === ['h', 'o', 'o', 'v'][index] && event.trusted === true && event.canvasFocused === true
      && event.ctrlKey === (index === 1) && event.metaKey === (index === 2) && event.altKey === false && event.shiftKey === false)
}
function fixtureDefinition(id, resources = true) {
  return { schemaVersion: 1, id, name: `Comfy · ${id}`, resources: resources ? {
    agent: { kind: 'agent', path: 'lib/agents/comfy.md' },
    shared: { kind: 'skill', source: { kind: 'shared', rootId: 'probe-skills', path: 'sample' } },
    mcp: { kind: 'mcp', bindingId: 'comfy-zero' },
  } : {}, graph: { nodes: [
    { id: 'source', kind: 'input', outputs: { value: 'string', number: 'number', 'part.中文': 'string' } },
    { id: 'sink', kind: 'output', inputs: { value: 'string', 'part.中文': 'string' } },
    { id: 'spare', kind: 'output', inputs: { value: 'string', 'part.中文': 'string' } },
    { id: 'wrong', kind: 'output', inputs: { value: 'boolean' } },
    { id: 'sharedTask', kind: resources ? 'agentTask' : 'output', inputs: { input: 'string' }, outputs: { result: 'string' }, ...(resources ? { agentRef: 'agent', skillRefs: ['shared'], toolsetRefs: ['mcp'], toolAllowlist: [] } : {}) },
    { id: 'zeroTask', kind: resources ? 'agentTask' : 'output', inputs: { input: 'string' }, outputs: { result: 'string' }, ...(resources ? { agentRef: 'agent', toolAllowlist: [] } : {}) },
  ], edges: [{ kind: 'data', from: 'source.part.中文', to: 'sink.part.中文' }] }, presentation: {
    nodes: { source: { x: 40, y: 70 }, sink: { x: 360, y: 70 }, spare: { x: 360, y: 340 }, wrong: { x: 670, y: 70 }, sharedTask: { x: 40, y: 370 }, zeroTask: { x: 670, y: 350 } },
    groups: [{ id: 'edit-group', label: 'Fixture group 中文', nodeIds: ['sink', 'spare'] }],
  } }
}
export function prepareCanvasFixtures(tempRoot, decode, validate) {
  const fixtures = originalFixtures(tempRoot, decode, validate)
  fixtures.config.toolBindings = { 'comfy-zero': { tools: [] } }
  for (const definition of [fixtureDefinition('comfy-edit'), fixtureDefinition('comfy-other'), fixtureDefinition('comfy-files', false)]) {
    validate(decode(JSON.stringify(definition)))
    const root = join(tempRoot, 'blueprints', definition.id)
    mkdirSync(root, { recursive: true }); fixtures.config.blueprints[definition.id] = root
    writeFileSync(join(root, 'blueprint.json'), JSON.stringify(definition))
    if (definition.resources.agent) {
      mkdirSync(join(root, 'lib/agents'), { recursive: true })
      writeFileSync(join(root, 'lib/agents/comfy.md'), '---\nname: comfy-fixture\ndescription: Operator-owned declaration, never run\n---\nThis collector never invokes this Agent.\n')
    }
    fixtures.evidence.push({ ...fixtureEvidence(definition), generator: 'comfy-interactions-ui.mjs:fixtureDefinition/w2', keyRead: false, providerCalls: 0 })
  }
  const empty = join(tempRoot, 'blueprints', 'comfy-empty')
  mkdirSync(empty); fixtures.config.blueprints['comfy-empty'] = empty
  const seed = fixtureDefinition('comfy-empty', false)
  validate(decode(JSON.stringify(seed)))
  const reportDir = process.env.BP_COMFY_ARTIFACT_DIR
  ensure(reportDir && reportPathAllowed(process.env.BP_COLLECTOR_PLAN_ID ?? PLAN_ID, 'comfy', reportDir), 'fresh W2 fixture manifest directory required')
  writeFileSync(join(reportDir, 'comfy-fixtures.json'), stringifyProbeEvidence({ tempRoot, empty, seed, config: fixtures.config,
    initiallyEmpty: true, keyRead: false, providerCalls: 0, provenance: 'operator-owned filesystem fixture; archive operations use real Host' }))
  return fixtures
}

export function parseCli(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const equal = args[i].indexOf('='), flag = equal < 0 ? args[i] : args[i].slice(0, equal)
    ensure(['--report-dir', '--plan-id'].includes(flag) && options[flag] === undefined, `unknown/duplicate option: ${flag}`)
    const val = equal < 0 ? args[++i] : args[i].slice(equal + 1)
    ensure(typeof val === 'string' && val.length > 0 && !val.startsWith('--') && !/[\u0000-\u001f]/.test(val), `${flag} requires a valid value`)
    options[flag] = val
  }
  const planId = options['--plan-id']
  ensure([PLAN_ID, COMPACT_PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(planId), `explicit --plan-id ${PLAN_ID} or ${COMPACT_PLAN_ID} required`)
  ensure(reportPathAllowed(planId, 'comfy', options['--report-dir']), '--report-dir must explicitly name a NEW absolute directory under the selected plan W2')
  return { planId, reportDir: resolve(options['--report-dir']) }
}
function replaceOnce(source, before, after) {
  ensure(source.split(before).length === 2, `probe adapter anchor absent/ambiguous: ${before}`)
  return source.replace(before, after)
}
export function adaptProbe(original, { here = HERE, collector = fileURLToPath(import.meta.url), playwright = join(ROOT, 'test/blueprint/node_modules/playwright/index.mjs') } = {}) {
  let source = original.replace(/from '\.\/([^']+\.mjs)'/g, (_, name) => `from '${pathToFileURL(join(here, name)).href}'`)
    .replace(/import\('\.\/([^']+\.mjs)'\)/g, (_, name) => `import('${pathToFileURL(join(here, name)).href}')`)
  source = replaceOnce(source, 'const HERE = dirname(fileURLToPath(import.meta.url))', `const HERE = ${JSON.stringify(here)}`)
  for (const name of ['canvas-journey.mjs', 'canvas-fixtures.mjs']) source = replaceOnce(source, pathToFileURL(join(here, name)).href, pathToFileURL(collector).href)
  source = replaceOnce(source, "const pw = await import('playwright')", `const pw = await import(${JSON.stringify(pathToFileURL(playwright).href)})`)
  return source
}

async function settle(page) { await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))) }
async function renderedViewport(page) {
  return page.locator('.react-flow__viewport').evaluate(el => {
    const matrix = new DOMMatrix(getComputedStyle(el).transform)
    return { x: matrix.m41, y: matrix.m42, zoom: Math.hypot(matrix.m11, matrix.m12) }
  })
}
/** Diagnostic projection only. The CI-SPACE-PAN oracle still requires the
 * ordinary drag's exact style and entire definition/Host/history unchanged. */
export function spacePanDiagnosticFacts({ before, postSpace, postOrdinary, targets, input }) {
  const project = state => ({ style: state.style, viewport: state.viewport, paneBounds: state.paneBounds, focus: state.focus,
    history: state.history, definitionSha256: sha256(JSON.stringify(state.definition)), hostDocumentSha256: sha256(JSON.stringify(state.hostDocument)) })
  return { before: before.style, after: postSpace.style, baseline: project(before), postSpace: project(postSpace), postOrdinary: project(postOrdinary), targets, input,
    invariants: { spaceMoved: before.style !== postSpace.style, ordinaryViewportUnchanged: postSpace.style === postOrdinary.style,
      historyUnchanged: same(before.history, postOrdinary.history), definitionUnchanged: same(before.definition, postOrdinary.definition),
      hostUnchanged: same(before.hostDocument, postOrdinary.hostDocument) } }
}
export function searchCancelDiagnosticFacts(baseline, stages) {
  const project = state => ({ style: state.style, viewport: state.viewport, history: state.history,
    definitionSha256: sha256(JSON.stringify(state.definition)), hostDocumentSha256: sha256(JSON.stringify(state.hostDocument)),
    focus: state.focus, searchVisible: state.searchVisible })
  return { baseline: project(baseline), stages: stages.map(state => ({ kind: state.kind, ...project(state) })),
    invariants: { viewportUnchanged: stages.every(state => state.style === baseline.style && same(state.viewport, baseline.viewport)),
      historyUnchanged: stages.every(state => same(state.history, baseline.history)),
      definitionUnchanged: stages.every(state => same(state.definition, baseline.definition)),
      hostUnchanged: stages.every(state => same(state.hostDocument, baseline.hostDocument)) } }
}
/** Self-contained browser CSS codec, also passed directly to waitForFunction.
 * The owned zero-size reference is attached so getComputedStyle applies the
 * same browser serialization as the actual viewport. DOMMatrix(inline) alone
 * can choose a different representation. Remove the reference on every exit.
 */
export function viewportCssProbe(args) {
  const finish = result => args.action === 'wait' ? result.passed : result
  const equal = (a, b) => a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object'
    && Array.isArray(a) === Array.isArray(b) && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key])))
  const root = document.querySelector('[data-bp-canvas="root"]'), id = args.blueprintId
  const key = `xuanling-blueprint:viewport:${encodeURIComponent(id)}`
  const publicPrefs = { blueprintId: id, key, raw: null, state: null, status: 'missing' }
  const result = { passed: false, publicPrefs, actual: null, expected: null }
  if (!root || root.getAttribute('data-bp-blueprint') !== id) return finish(result)
  try { publicPrefs.raw = localStorage.getItem(key); if (publicPrefs.raw !== null) { publicPrefs.state = JSON.parse(publicPrefs.raw); publicPrefs.status = 'present' } }
  catch (error) { publicPrefs.status = error instanceof SyntaxError ? 'corrupt' : 'unavailable'; return finish(result) }
  const state = publicPrefs.state, expectedState = args.expectedPrefs ?? state, expectedViewport = expectedState?.viewport
  if (!state?.viewport || !expectedViewport || ![state.viewport.x, state.viewport.y, state.viewport.zoom, expectedViewport.x, expectedViewport.y, expectedViewport.zoom].every(Number.isFinite)
    || state.viewport.zoom <= 0 || expectedViewport.zoom <= 0) return finish(result)
  const el = root.querySelector('.react-flow__viewport')
  if (!el) return finish(result)
  const matrixValues = matrix => ({ m11: matrix.m11, m12: matrix.m12, m21: matrix.m21, m22: matrix.m22, m41: matrix.m41, m42: matrix.m42 })
  const actualCss = getComputedStyle(el).transform
  result.actual = { computedTransform: actualCss, matrix: matrixValues(new DOMMatrix(actualCss)) }
  const reference = document.createElement('div')
  try {
    Object.assign(reference.style, { position: 'fixed', width: '0', height: '0', visibility: 'hidden', pointerEvents: 'none' })
    reference.style.transform = `translate(${expectedViewport.x}px, ${expectedViewport.y}px) scale(${expectedViewport.zoom})`
    document.body.appendChild(reference)
    const expectedCss = getComputedStyle(reference).transform
    result.expected = { provenance: 'attached owned hidden reference / getComputedStyle / DOMMatrix', viewport: { ...expectedViewport },
      computedTransform: expectedCss, matrix: matrixValues(new DOMMatrix(expectedCss)) }
    const components = ['m11', 'm12', 'm21', 'm22', 'm41', 'm42']
    result.passed = components.every(name => Number.isFinite(result.actual.matrix[name]) && result.actual.matrix[name] === result.expected.matrix[name])
      && (!Object.hasOwn(args, 'beforeZoom') || (Number.isFinite(args.beforeZoom) && state.viewport.zoom !== args.beforeZoom))
      && (!args.expectedPrefs || equal(state, args.expectedPrefs))
    return finish(result)
  } finally { reference.remove() }
}
/** Recompute the receipt oracle independently from its browser pass flag.
 * Full prefs equality is separate from exact browser-encoded matrix equality.
 */
export function viewportStateOracle(browser, options = {}) {
  const prefs = browser?.publicPrefs, state = prefs?.state, viewport = state?.viewport
  const invalid = reason => ({ passed: false, reason })
  if (prefs?.status !== 'present' || typeof prefs.raw !== 'string' || !viewport || ![viewport.x, viewport.y, viewport.zoom].every(Number.isFinite) || viewport.zoom <= 0) return invalid('viewport public state missing/invalid')
  try { if (!same(JSON.parse(prefs.raw), state)) return invalid('viewport raw/full state mismatch') } catch { return invalid('viewport raw state corrupt') }
  const expectedViewport = options.expectedPrefs?.viewport ?? viewport, expected = browser.expected, actual = browser.actual
  if (expected?.provenance !== 'attached owned hidden reference / getComputedStyle / DOMMatrix' || !same(expected.viewport, expectedViewport)
    || !expected.computedTransform || !actual?.computedTransform) return invalid('viewport browser CSS encoding missing/stale')
  const components = ['m11', 'm12', 'm21', 'm22', 'm41', 'm42']
  const invariants = { renderedExactlyEncoded: components.every(name => Number.isFinite(actual.matrix?.[name]) && Number.isFinite(expected.matrix?.[name]) && actual.matrix[name] === expected.matrix[name]),
    storedZoomChanged: !Object.hasOwn(options, 'beforeZoom') || (Number.isFinite(options.beforeZoom) && viewport.zoom !== options.beforeZoom),
    preferencesExactlyExpected: !options.expectedPrefs || same(state, options.expectedPrefs) }
  return { passed: Object.values(invariants).every(Boolean), invariants, storedViewport: viewport, actualMatrix: actual.matrix, expectedMatrix: expected.matrix,
    rawStateSha256: sha256(prefs.raw), fullStateSha256: sha256(JSON.stringify(state)) }
}
/** Diagnostic only: retain the historical waits' exact 1e-8 comparison, including
 * a null result when the second wait argument was never reached. No rounding,
 * tolerance adjustment or inference that a wheel succeeded from storage alone.
 */
export function viewportDiagnosticFacts(baseline, stages, { zoomBefore, zoomAfter, expectedPrefs }) {
  const finite = Number.isFinite, precision = number => finite(number) ? number.toPrecision(17) : null
  const project = state => {
    const stored = state.browser.publicPrefs.state?.viewport?.zoom, rendered = state.browser.viewport.rendered?.zoom
    const argumentAvailable = finite(zoomAfter), difference = finite(stored) && finite(rendered) ? stored - rendered : null
    const waitDifference = finite(stored) && argumentAvailable ? stored - zoomAfter : null
    return { kind: state.kind, at: state.at, publicPrefs: state.browser.publicPrefs, viewport: state.browser.viewport, target: state.browser.target, css: state.browser.css ?? null,
      seat: state.browser.seat ?? null, rootMounted: state.browser.rootMounted ?? null, expectedPrefs: expectedPrefs ?? null,
      cssOracle: expectedPrefs ? viewportStateOracle(state.browser.css, { expectedPrefs }) : null,
      document: state.definition, hostDocument: state.hostDocument, history: state.history,
      documentSha256: sha256(JSON.stringify(state.definition)), hostDocumentSha256: sha256(JSON.stringify(state.hostDocument)),
      precision: { storedZoom: precision(stored), renderedZoom: precision(rendered), waitArgument: precision(zoomAfter) },
      differences: { renderedMinusBeforeZoom: finite(rendered) && finite(zoomBefore) ? rendered - zoomBefore : null,
        storedMinusRenderedZoom: difference, absoluteStoredMinusRenderedZoom: difference === null ? null : Math.abs(difference),
        storedMinusWaitArgument: waitDifference, absoluteStoredMinusWaitArgument: waitDifference === null ? null : Math.abs(waitDifference) },
      predicates: { renderedZoomChanged: finite(rendered) && finite(zoomBefore) ? rendered !== zoomBefore : null,
        waitArgumentAvailable: argumentAvailable,
        storedZoomMatchesWaitArgument: argumentAvailable ? !!state.browser.publicPrefs.raw && Math.abs(stored - zoomAfter) < 1e-8 : null } }
  }
  return { baseline: project(baseline), stages: stages.map(project), waitArguments: { zoomBefore, zoomAfter },
    invariants: { documentUnchanged: stages.every(state => same(state.definition, baseline.definition)),
      hostUnchanged: stages.every(state => same(state.hostDocument, baseline.hostDocument)), historyUnchanged: stages.every(state => same(state.history, baseline.history)) } }
}
/** Read-only actual DOM/public-state projection and disposable passive wheel
 * observer. defaultPrevented is observed at capture, never called final state.
 */
export function viewportBrowserProbe(root, args) {
  // page.evaluate can read the current seat even when reload has unmounted it;
  // locator.evaluate callers retain their original mounted-root behavior.
  if (root?.action) { args = root; root = document.querySelector('[data-bp-canvas="root"]') }
  const describe = element => {
    const ancestors = []
    for (let current = element; current && ancestors.length < 7; current = current.parentElement) ancestors.push({ tag: current.tagName,
      className: current.getAttribute('class'), canvas: current.getAttribute('data-bp-canvas'), dataId: current.getAttribute('data-id'),
      port: current.getAttribute('data-bp-port'), groupHeader: current.getAttribute('data-bp-group-header'), action: current.getAttribute('data-bp-action') })
    return { tag: element?.tagName ?? null, className: element?.getAttribute?.('class') ?? null, ancestors }
  }
  if (args.action === 'observe') {
    const state = { pending: [], listener: null }
    state.listener = event => {
      state.pending.push(window.__bpComfyViewportWheelObserve({ type: event.type, observationPhase: 'document-capture', trusted: event.isTrusted,
        clientX: event.clientX, clientY: event.clientY, deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey, shiftKey: event.shiftKey, altKey: event.altKey, metaKey: event.metaKey, timeStamp: event.timeStamp,
        defaultPrevented: event.defaultPrevented, eventPhase: event.eventPhase, target: describe(event.composedPath?.()[0] ?? event.target),
        hit: describe(document.elementFromPoint(event.clientX, event.clientY)) }))
    }
    document.addEventListener('wheel', state.listener, { capture: true, passive: true })
    window.__bpComfyViewportWheelTracing = state
    return
  }
  if (args.action === 'stop') {
    const state = window.__bpComfyViewportWheelTracing
    if (!state) return
    document.removeEventListener('wheel', state.listener, true)
    delete window.__bpComfyViewportWheelTracing
    return Promise.all(state.pending)
  }
  const viewport = root?.querySelector('.react-flow__viewport'), computedTransform = viewport ? getComputedStyle(viewport).transform : null
  const matrix = viewport ? new DOMMatrix(computedTransform) : null
  const blueprintId = args.blueprintId ?? root?.getAttribute('data-bp-blueprint') ?? null, key = blueprintId ? `xuanling-blueprint:viewport:${encodeURIComponent(blueprintId)}` : null
  const publicPrefs = { provenance: 'public per-blueprint persisted UI state', blueprintId, key, raw: null, state: null, status: 'missing' }
  try { publicPrefs.raw = key ? localStorage.getItem(key) : null; if (publicPrefs.raw !== null) { publicPrefs.state = JSON.parse(publicPrefs.raw); publicPrefs.status = 'present' } }
  catch (error) { publicPrefs.status = error instanceof SyntaxError ? 'corrupt' : 'unavailable' }
  return { publicPrefs, rootMounted: !!root,
    seat: { blueprintId: root?.getAttribute('data-bp-blueprint') ?? null, mode: root?.getAttribute('data-bp-mode') ?? null,
      motion: root?.getAttribute('data-bp-motion') ?? null, canvasLocked: root?.getAttribute('data-bp-canvas-locked') ?? null },
    history: { undo: root?.querySelector('[data-bp-action="undo"]')?.disabled ?? null, redo: root?.querySelector('[data-bp-action="redo"]')?.disabled ?? null,
      dirty: root?.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty') ?? null },
    viewport: { inlineStyle: viewport?.getAttribute('style') ?? null, inlineTransform: viewport?.style.transform ?? null, computedTransform,
    matrix: matrix ? { m11: matrix.m11, m12: matrix.m12, m21: matrix.m21, m22: matrix.m22, m41: matrix.m41, m42: matrix.m42 } : null,
    rendered: matrix ? { x: matrix.m41, y: matrix.m42, zoom: Math.hypot(matrix.m11, matrix.m12) } : null },
    target: { ...args.point, hit: describe(args.point ? document.elementFromPoint(args.point.x, args.point.y) : null) } }
}
export function reconnectDiagnosticFacts(before, after) {
  const project = state => state ? { document: state.definition, graph: state.definition.graph, history: state.history, edgeId: state.edgeId, edgeIds: state.edgeIds,
    documentSha256: sha256(JSON.stringify(state.definition)), graphSha256: sha256(JSON.stringify(state.definition.graph)),
    hostDocumentSha256: sha256(JSON.stringify(state.hostDocument)), notices: state.notices, selection: state.selection } : null
  return { before: project(before), after: project(after), comparisons: after ? {
    documentUnchanged: same(before.definition, after.definition), graphUnchanged: same(before.definition.graph, after.definition.graph),
    historyUnchanged: same(before.history, after.history), hostUnchanged: same(before.hostDocument, after.hostDocument) } : null }
}
export function groupMoveDiagnosticFacts(before, after, group) {
  const firstId = group.nodeIds[0], firstBefore = before.definition.presentation.nodes[firstId], firstAfter = after?.definition.presentation.nodes[firstId]
  const firstDelta = firstAfter ? { x: firstAfter.x - firstBefore.x, y: firstAfter.y - firstBefore.y } : null
  const precision = value => Number.isFinite(value) ? value.toPrecision(17) : null
  return { ...reconnectDiagnosticFacts(before, after), groupId: group.id, newGroup: group,
    groupBefore: before.definition.presentation.groups.find(item => item.id === group.id) ?? null,
    groupAfter: after?.definition.presentation.groups.find(item => item.id === group.id) ?? null,
    members: group.nodeIds.map(id => {
      const from = before.definition.presentation.nodes[id], to = after?.definition.presentation.nodes[id]
      const delta = from && to ? { x: to.x - from.x, y: to.y - from.y } : null
      return { id, before: from ?? null, after: to ?? null, pinnedBefore: from?.pinned === true, pinnedAfter: to?.pinned === true,
        delta, precision: delta ? { x: precision(delta.x), y: precision(delta.y) } : null,
        negativeZero: delta ? { x: Object.is(delta.x, -0), y: Object.is(delta.y, -0) } : null,
        differenceFromFirst: delta && firstDelta ? { x: delta.x - firstDelta.x, y: delta.y - firstDelta.y } : null,
        exactDeltaMatchesFirst: delta && firstDelta ? same(delta, firstDelta) : null }
    }) }
}
/** Independent position oracle. CSS serializes the rendered transform with
 * reduced precision; only the public persisted viewport supplies full values.
 * Convert both trusted client points separately, then apply ONE shared delta
 * to the complete pre-gesture document. Never reverse-subtract member positions
 * to decide equality: adding a shared IEEE value can round differently by node.
 */
export function groupMoveOracle(facts) {
  const reject = reason => ({ passed: false, reason })
  const { before, after, newGroup, geometry, geometryAfter, trace } = facts ?? {}
  if (!before?.document || !after?.document || !newGroup?.id || !geometry || !geometryAfter || !Array.isArray(trace)) return reject('group move full witness missing')
  if (![before, after].every(state => state.documentSha256 === sha256(JSON.stringify(state.document))
    && state.graphSha256 === sha256(JSON.stringify(state.document.graph)) && same(state.graph, state.document.graph))) return reject('group move document/graph digest stale')
  const group = before.document.presentation?.groups?.find(item => item.id === newGroup.id)
  if (!group || !Array.isArray(group.nodeIds) || group.nodeIds.length === 0 || !same(group.nodeIds, newGroup.nodeIds)) return reject('group move canonical membership missing')
  const prefs = geometry.uiViewportPrefs, viewport = prefs?.state?.viewport, bounds = geometry.renderer?.rect
  if (prefs?.status !== 'present' || prefs.provenance !== 'public per-blueprint persisted UI state'
    || prefs.blueprintId !== before.document.id || prefs.key !== `xuanling-blueprint:viewport:${encodeURIComponent(before.document.id)}`
    || !viewport || ![viewport.x, viewport.y, viewport.zoom, bounds?.left, bounds?.top, bounds?.width, bounds?.height].every(Number.isFinite)
    || viewport.zoom <= 0 || bounds.width <= 0 || bounds.height <= 0) return reject('group move public viewport/renderer invalid')
  const rendered = geometry.viewport
  if (!rendered?.inlineTransform || !rendered.computedTransform || ![rendered.rendered?.x, rendered.rendered?.y, rendered.rendered?.zoom].every(Number.isFinite)
    || !same(prefs, geometryAfter.uiViewportPrefs) || !same(bounds, geometryAfter.renderer?.rect)
    || !same(rendered, geometryAfter.viewport)) return reject('group move viewport/renderer changed or stale')
  const capture = trace.filter(event => event.observationPhase === 'document-capture')
  const downs = capture.filter(event => event.type === 'pointerdown'), ups = capture.filter(event => event.type === 'pointerup')
  if (downs.length !== 1 || ups.length !== 1 || capture.some(event => event.type === 'pointercancel')) return reject('group move trusted down/up missing')
  const down = downs[0], up = ups[0], startIndex = capture.indexOf(down), endIndex = capture.indexOf(up)
  const moves = capture.slice(startIndex + 1, endIndex).filter(event => event.type === 'pointermove' && event.buttons === 1), lastMove = moves.at(-1)
  const headerHit = hit => hit?.groupHeader === group.id && hit.button == null && !hit.ancestors?.some(item => item.tag === 'BUTTON')
  const genuine = event => event.trusted === true && event.pointerId === down.pointerId && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
    && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && headerHit(event.target) && headerHit(event.hit)
  const pointMatches = (event, point) => event.clientX === point?.x && event.clientY === point?.y
  if (endIndex <= startIndex || !lastMove || !Number.isFinite(down.pointerId) || ![down, ...moves, up].every(genuine)
    || down.buttons !== 1 || down.button !== 0 || up.buttons !== 0 || up.button !== 0
    || !headerHit(geometry.from?.hit) || !pointMatches(down, geometry.from) || !pointMatches(lastMove, geometry.to) || !pointMatches(up, geometry.to)) return reject('group move mis-hit/untrusted/incomplete header gesture')
  const flowPoint = event => ({ x: (event.clientX - bounds.left - viewport.x) / viewport.zoom, y: (event.clientY - bounds.top - viewport.y) / viewport.zoom })
  const startFlow = flowPoint(down), endFlow = flowPoint(lastMove), delta = { x: endFlow.x - startFlow.x, y: endFlow.y - startFlow.y }
  if (![delta.x, delta.y].every(Number.isFinite) || (delta.x === 0 && delta.y === 0)) return reject('group move zero/nonfinite shared delta')
  const expected = structuredClone(before.document)
  let movedMembers = 0
  for (const id of group.nodeIds) {
    const position = expected.presentation?.nodes?.[id]
    if (!position || ![position.x, position.y].every(Number.isFinite)) return reject('group move member position invalid')
    if (position.pinned === true) continue
    position.x += delta.x; position.y += delta.y; movedMembers++
  }
  const invariants = { documentExactlyExpected: same(expected, after.document), hostUnchanged: /^[a-f0-9]{64}$/.test(before.hostDocumentSha256 ?? '') && before.hostDocumentSha256 === after.hostDocumentSha256,
    graphUnchanged: same(before.document.graph, after.document.graph), movedUnpinnedMembers: movedMembers > 0, viewportUnchanged: true, trustedHeaderGesture: true }
  return { passed: Object.values(invariants).every(Boolean), invariants, delta, startFlow, endFlow, movedMembers,
    expectedDocumentSha256: sha256(JSON.stringify(expected)), actualDocumentSha256: sha256(JSON.stringify(after.document)),
    provenance: 'trusted document-capture client points / actual renderer bounds / public persisted viewport; exact whole-document equality' }
}
// Self-contained browser reader shared by geometry and passive pointer trace.
// It observes actual DOM/events; it never changes selection or input routing.
function reconnectBrowserProbe(root, args) {
  if (root?.action === 'stop') { args = root; root = null }
  const rect = el => {
    const r = el?.getBoundingClientRect()
    return r ? { x: r.x, y: r.y, left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null
  }
  const describe = el => {
    const ancestors = []
    for (let current = el; current && ancestors.length < 7; current = current.parentElement) ancestors.push({ tag: current.tagName,
      className: current.getAttribute('class'), port: current.getAttribute('data-bp-port'), dataId: current.getAttribute('data-id'), canvas: current.getAttribute('data-bp-canvas'),
      groupHeader: current.getAttribute('data-bp-group-header'), group: current.getAttribute('data-bp-group'), action: current.getAttribute('data-bp-action') })
    return { tag: el?.tagName ?? null, className: el?.getAttribute?.('class') ?? null,
      port: el?.closest?.('[data-bp-port]')?.getAttribute('data-bp-port') ?? null,
      edgeId: el?.closest?.('.react-flow__edge')?.getAttribute('data-id') ?? null,
      updater: el?.closest?.('[class*="edgeupdater"]')?.getAttribute('class') ?? null,
      nodeId: el?.closest?.('.react-flow__node')?.getAttribute('data-id') ?? null, noKey: !!el?.closest?.('.nokey'),
      groupHeader: el?.closest?.('[data-bp-group-header]')?.getAttribute('data-bp-group-header') ?? null,
      group: el?.closest?.('[data-bp-group]')?.getAttribute('data-bp-group') ?? null,
      button: el?.closest?.('button')?.getAttribute('data-bp-action') ?? null, ancestors }
  }
  const notices = () => Array.from(root.querySelectorAll('[data-bp-status]')).map(el => ({ key: el.getAttribute('data-bp-status-key'), text: el.textContent }))
  const selection = () => {
    const pane = root.querySelector('.react-flow__pane'), userRect = root.querySelector('.react-flow__selection'), nodesRect = root.querySelector('.react-flow__nodesselection-rect')
    // These are actual DOM projections, not an inferred/private store read.
    return { provenance: 'actual ReactFlow DOM projection', paneClassName: pane?.getAttribute('class') ?? null,
      paneSelectionClassActive: pane?.classList.contains('selection') ?? false, userSelectionRectMounted: !!userRect,
      userSelectionRect: userRect ? { rect: rect(userRect), inlineStyle: userRect.getAttribute('style') } : null,
      nodesSelectionRectMounted: !!nodesRect, nodesSelectionRect: nodesRect ? { rect: rect(nodesRect), inlineStyle: nodesRect.getAttribute('style') } : null }
  }
  if (args.action === 'state') return { notices: notices(), selection: selection() }
  if (args.action === 'observe') {
    const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mouseup', 'keydown', 'keyup']
    const state = { pending: [], stop: null, sequence: 0 }, ids = new WeakMap(), observers = []
    const emit = (event, observationPhase) => {
      if (!ids.has(event)) ids.set(event, ++state.sequence)
      const entry = { type: event.type, eventId: ids.get(event), observationPhase, eventPhase: event.eventPhase,
        defaultPrevented: event.defaultPrevented, cancelBubble: event.cancelBubble,
        shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey,
        key: event.key ?? null, code: event.code ?? null, trusted: event.isTrusted, timeStamp: event.timeStamp,
        clientX: event.clientX ?? null, clientY: event.clientY ?? null, button: event.button ?? null, buttons: event.buttons ?? null, pointerId: event.pointerId ?? null,
        target: describe(event.composedPath?.()[0] ?? event.target),
        hit: describe(Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? document.elementFromPoint(event.clientX, event.clientY) : null),
        notices: notices(), selection: selection() }
      state.pending.push(window.__bpComfyReconnectObserve(entry))
    }
    const pane = root.querySelector('.react-flow__pane')
    for (const [target, capture, phase] of [[document, true, 'document-capture'], [pane, true, 'pane-capture'], [pane, false, 'pane-bubble'], [document, false, 'document-bubble']]) {
      if (!target) continue
      const listener = event => {
        emit(event, phase)
        // Observe the same native event at this microtask checkpoint. Native
        // listener boundaries may run it before dispatch finishes, so this
        // value does not establish the final defaultPrevented state.
        if (phase === 'document-capture') queueMicrotask(() => emit(event, 'microtask-checkpoint'))
      }
      for (const type of types) { target.addEventListener(type, listener, { capture, passive: true }); observers.push({ target, type, listener, capture }) }
    }
    state.stop = () => observers.forEach(({ target, type, listener, capture }) => target.removeEventListener(type, listener, capture))
    window.__bpComfyReconnectTracing = state
    return
  }
  if (args.action === 'stop') {
    const state = window.__bpComfyReconnectTracing
    state?.stop(); delete window.__bpComfyReconnectTracing
    return Promise.resolve().then(() => Promise.all(state?.pending ?? []))
  }
  if (args.action === 'group-geometry') {
    const header = Array.from(root.querySelectorAll('[data-bp-group-header]')).find(el => el.getAttribute('data-bp-group-header') === args.groupId)
    const frame = header?.closest('[data-bp-group]'), wrapper = header?.closest('.react-flow__node')
    const item = el => ({ rect: rect(el), element: describe(el), text: el?.textContent ?? null, inlineStyle: el?.getAttribute('style') ?? null })
    const at = p => ({ ...p, hit: describe(document.elementFromPoint(p.x, p.y)) })
    const renderer = root.querySelector('.react-flow__renderer'), viewport = root.querySelector('.react-flow__viewport')
    const computedTransform = viewport ? getComputedStyle(viewport).transform : null, matrix = viewport ? new DOMMatrix(computedTransform) : null
    const rendered = matrix ? { x: matrix.m41, y: matrix.m42, zoom: Math.hypot(matrix.m11, matrix.m12) } : null
    const blueprintId = root.getAttribute('data-bp-blueprint'), key = blueprintId ? `xuanling-blueprint:viewport:${encodeURIComponent(blueprintId)}` : null
    const uiViewportPrefs = { provenance: 'public per-blueprint persisted UI state', blueprintId, key, raw: null, state: null, status: 'missing' }
    try {
      uiViewportPrefs.raw = key ? localStorage.getItem(key) : null
      if (uiViewportPrefs.raw !== null) { uiViewportPrefs.state = JSON.parse(uiViewportPrefs.raw); uiViewportPrefs.status = 'present' }
    } catch (error) { uiViewportPrefs.status = error instanceof SyntaxError ? 'corrupt' : 'unavailable' }
    const pointerCssDelta = { x: args.to.x - args.from.x, y: args.to.y - args.from.y }
    return { groupId: args.groupId, header: item(header), frame: item(frame), wrapper: item(wrapper),
      children: Array.from(header?.children ?? []).map(item), buttons: Array.from(header?.querySelectorAll('button') ?? []).map(item),
      renderer: { rect: rect(renderer), element: describe(renderer) },
      viewport: { rect: rect(viewport), inlineStyle: viewport?.getAttribute('style') ?? null, inlineTransform: viewport?.style.transform ?? null,
        computedTransform, rendered, matrix: matrix ? { m11: matrix.m11, m12: matrix.m12, m21: matrix.m21, m22: matrix.m22, m41: matrix.m41, m42: matrix.m42 } : null },
      uiViewportPrefs, pointerCssDelta, flowDeltaFromRenderedZoom: rendered && rendered.zoom > 0 ? { x: pointerCssDelta.x / rendered.zoom, y: pointerCssDelta.y / rendered.zoom } : null,
      from: at(args.from), to: at(args.to), notices: notices(), selection: selection() }
  }
  const edge = Array.from(root.querySelectorAll('.react-flow__edge')).find(el => el.getAttribute('data-id') === args.edgeId)
  const circle = edge?.querySelector('.react-flow__edgeupdater-target')
  const cx = circle ? Number(circle.getAttribute('cx')) : null, cy = circle ? Number(circle.getAttribute('cy')) : null
  const matrix = circle?.getScreenCTM(), center = matrix ? new DOMPoint(cx, cy).matrixTransform(matrix) : null
  const handles = ['source:data:part.中文', 'sink:data:part.中文', 'spare:data:part.中文'].map(id => {
    const el = Array.from(root.querySelectorAll('[data-bp-port]')).find(item => item.getAttribute('data-bp-port') === id)
    const pseudo = el ? getComputedStyle(el, '::before') : null
    return { id, rect: rect(el), element: describe(el), beforePseudo: pseudo ? { top: pseudo.top, right: pseudo.right, bottom: pseudo.bottom,
      left: pseudo.left, width: pseudo.width, height: pseudo.height, pointerEvents: pseudo.pointerEvents } : null }
  })
  const at = p => ({ ...p, hit: describe(document.elementFromPoint(p.x, p.y)) })
  return { edgeId: args.edgeId, updater: { cx, cy, r: circle ? Number(circle.getAttribute('r')) : null, rect: rect(circle),
    renderedCenter: center ? { x: center.x, y: center.y } : null, element: describe(circle) }, handles,
    from: at(args.from), to: at(args.to), notices: notices(), selection: selection() }
}
async function navigationGeometry(page) {
  return page.locator(SELECTORS.surface).evaluate(el => {
    const pane = el.querySelector('.react-flow__pane'), r = pane?.getBoundingClientRect(), focus = document.activeElement
    if (!r) throw new Error('navigation diagnostic pane bounds missing')
    return { paneBounds: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
      focus: { tag: focus?.tagName ?? null, className: focus?.getAttribute('class') ?? null, canvas: focus?.getAttribute('data-bp-canvas') ?? null } }
  })
}
async function navigationTargets(page, from, to) {
  return page.locator(SELECTORS.surface).evaluate((el, points) => {
    const pane = el.querySelector('.react-flow__pane'), r = pane?.getBoundingClientRect()
    if (!r) throw new Error('navigation diagnostic target pane bounds missing')
    const describe = ({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return { x, y, panePosition: { x: x - r.left, y: y - r.top },
        edgeDistances: { left: x - r.left, right: r.right - x, top: y - r.top, bottom: r.bottom - y },
        hit: { tag: hit?.tagName ?? null, className: hit?.getAttribute('class') ?? null, inPane: !!hit?.closest('.react-flow__pane'),
          nodeId: hit?.closest('.react-flow__node')?.getAttribute('data-id') ?? null, inControls: !!hit?.closest('.react-flow__controls,.react-flow__minimap'),
          canvas: hit?.closest('[data-bp-canvas]')?.getAttribute('data-bp-canvas') ?? null } }
    }
    return { from: describe(points.from), to: describe(points.to) }
  }, { from, to })
}
async function idle(page) {
  if (await page.locator('[data-bp-action="more-actions"]').count()) {
    await page.waitForFunction(() => { const selector = document.querySelector('[data-bp-select="blueprint"]'); return selector && !selector.disabled })
    await closePublicMore(page)
    return
  }
  await preparePublicAction(page, 'refresh-library')
  await page.waitForFunction(() => { const button = document.querySelector('[data-bp-action="refresh-library"]'); return button && !button.disabled })
  await closePublicMore(page)
}
async function choose(page, id) {
  await idle(page); await page.locator(SELECTORS.select).selectOption(id)
  await page.waitForFunction(id => document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-blueprint') === id, id)
  await idle(page); await settle(page)
}
async function readDefinition(page, api, id) {
  const draft = await page.evaluate(id => localStorage.getItem(`xuanling-blueprint:draft:${encodeURIComponent(id)}`), id)
  if (draft) {
    const parsed = JSON.parse(draft)
    ensure(typeof parsed.definitionJson === 'string', 'draft has no canonical definitionJson')
    return JSON.parse(parsed.definitionJson)
  }
  return JSON.parse(value(await api('loadDefinition', { blueprintId: id }), 'read real definition').definitionJson)
}
async function point(locator) {
  const box = await locator.boundingBox()
  ensure(box && box.width > 0 && box.height > 0, 'required control is not hit-testable')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
/** Preserve the original point policy first. Only its all-obstructed branch
 * searches actual pane interior; no viewport or DOM/input manipulation.
 * Self-contained for locator.evaluate and isolated policy oracle tests.
 */
export async function blankCanvasPoint(el) {
  const r = el.getBoundingClientRect(), pane = el.querySelector('.react-flow__pane'), p = pane?.getBoundingClientRect(), margin = 64
  const facts = { strategy: null, surfaceBounds: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height },
    paneBounds: p ? { left: p.left, right: p.right, top: p.top, bottom: p.bottom, width: p.width, height: p.height } : null,
    marginCssPx: margin, oldAttempts: [], fallbackAttempts: [], chosen: null }
  const describe = hit => {
    const ancestors = []
    for (let current = hit; current && ancestors.length < 7; current = current.parentElement) ancestors.push({ tag: current.tagName,
      className: current.getAttribute('class'), dataId: current.getAttribute('data-id'), group: current.getAttribute('data-bp-group'),
      groupHeader: current.getAttribute('data-bp-group-header'), overlay: current.getAttribute('data-bp-overlay'), port: current.getAttribute('data-bp-port'),
      canvas: current.getAttribute('data-bp-canvas'), action: current.getAttribute('data-bp-action') })
    return { tag: hit?.tagName ?? null, className: hit?.getAttribute?.('class') ?? null, equalsPane: !!pane && hit === pane, ancestors }
  }
  const attempt = (x, y, original) => {
    const hit = document.elementFromPoint(x, y)
    const accepted = original ? !!hit?.closest('.react-flow__pane') && !hit.closest('.react-flow__node,.react-flow__controls,.react-flow__minimap') : !!pane && hit === pane
    const result = { x, y, accepted, hit: describe(hit), edgeDistances: p ? { left: x - p.left, right: p.right - x, top: y - p.top, bottom: p.bottom - y } : null }
    const attempts = original ? facts.oldAttempts : facts.fallbackAttempts
    attempts.push(result)
    if (accepted) { facts.strategy = original ? 'original-four' : 'interior-grid'; facts.chosen = result }
    return accepted
  }
  for (const [x, y] of [[r.right - 30, r.bottom - 30], [r.right - 30, r.top + 35], [r.left + 35, r.top + 35], [r.left + r.width / 2, r.bottom - 28]]) {
    if (attempt(x, y, true)) break
  }
  if (!facts.chosen && p && [p.left, p.right, p.top, p.bottom, p.width, p.height].every(Number.isFinite) && p.width >= margin * 2 && p.height >= margin * 2) {
    const fractions = [0.5, ...Array.from({ length: 17 }, (_, i) => i / 16).filter(f => f !== 0.5)]
    search: for (const fy of fractions) for (const fx of fractions) {
      const x = p.left + margin + (p.width - margin * 2) * fx, y = p.top + margin + (p.height - margin * 2) * fy
      if (attempt(x, y, false)) break search
    }
  }
  // Await the disposable binding so even a thrown all-obstructed failure has
  // its old four hits and bounded fallback attempts persisted in this run.
  if (typeof window.__bpComfyBlankObserve === 'function') await window.__bpComfyBlankObserve(facts)
  if (!facts.chosen) throw new Error('no genuine unobstructed canvas point')
  return { x: facts.chosen.x, y: facts.chosen.y }
}
async function blank(page) { return page.locator(SELECTORS.surface).evaluate(blankCanvasPoint) }
/** Invariance gestures must avoid XYFlow's intentional edge selection
 * auto-pan. Search real pane hits; never override auto-pan or input events. */
export async function interiorNavigationDrag(page, delta) {
  ensure(Number.isFinite(delta?.x) && Number.isFinite(delta?.y), 'navigation interior delta must be finite')
  return page.locator(SELECTORS.surface).evaluate((el, delta) => {
    const pane = el.querySelector('.react-flow__pane'), r = pane?.getBoundingClientRect(), margin = 64, steps = 8
    if (!r || ![r.left, r.right, r.top, r.bottom, r.width, r.height].every(Number.isFinite)) throw new Error('navigation interior pane bounds missing/invalid')
    const minX = r.left + margin + Math.max(0, -delta.x), maxX = r.right - margin - Math.max(0, delta.x)
    const minY = r.top + margin + Math.max(0, -delta.y), maxY = r.bottom - margin - Math.max(0, delta.y)
    if (minX > maxX || minY > maxY) throw new Error('pane too small for navigation interior path')
    // 17 x 17 candidates maximum, nine real hit tests per candidate. Start
    // centrally, then cover the feasible rectangle deterministically.
    const fractions = [0.5, ...Array.from({ length: 17 }, (_, i) => i / 16).filter(f => f !== 0.5)]
    for (const fy of fractions) for (const fx of fractions) {
      const from = { x: minX + (maxX - minX) * fx, y: minY + (maxY - minY) * fy }
      const to = { x: from.x + delta.x, y: from.y + delta.y }, samples = []
      for (let i = 0; i <= steps; i++) {
        const x = from.x + delta.x * i / steps, y = from.y + delta.y * i / steps
        const hit = document.elementFromPoint(x, y)
        // Requiring the pane itself excludes nodes, edges, groups, overlays,
        // controls and minimap, including an obstruction midway through.
        if (hit !== pane) break
        samples.push({ x, y, edgeDistances: { left: x - r.left, right: r.right - x, top: y - r.top, bottom: r.bottom - y },
          hit: { tag: hit.tagName ?? null, className: hit.getAttribute?.('class') ?? null, inPane: true } })
      }
      if (samples.length === steps + 1) return { from, to, samples, marginCssPx: margin, steps }
    }
    throw new Error('no genuine unobstructed interior navigation path')
  }, delta)
}
async function drag(page, from, to, modifiers = []) {
  for (const key of modifiers) await page.keyboard.down(key)
  try { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up() }
  finally { for (const key of [...modifiers].reverse()) await page.keyboard.up(key) }
  await settle(page)
}
async function focusCanvas(page) { const p = await blank(page); await page.mouse.click(p.x, p.y); await page.locator(SELECTORS.surface).focus() }
async function selectNodes(page, ids) {
  await focusCanvas(page)
  for (let i = 0; i < ids.length; i++) await node(page, ids[i]).locator('.bp-node-title').click(i ? { modifiers: ['ControlOrMeta'] } : {})
  await settle(page)
  const selected = await page.locator('.react-flow__node.selected[data-id]').evaluateAll(items => items.map(el => el.getAttribute('data-id')).sort())
  ensure(same(selected, [...ids].sort()), 'trusted selection did not select the intended nodes')
}
async function context(page, target, command) {
  await target.click({ button: 'right' }); await page.locator(SELECTORS.menu).waitFor({ state: 'visible' })
  await preparePublicCommand(page, command); await menuCommand(page, command).click(); await settle(page)
}
async function canvasContext(page, command) {
  const p = await blank(page); await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.locator(SELECTORS.menu).waitFor({ state: 'visible' }); await preparePublicCommand(page, command); await menuCommand(page, command).click(); await settle(page)
}
async function save(page) {
  await action(page, 'save-layout').click(); await idle(page)
  await page.waitForFunction(() => document.querySelector('[data-bp-status-key]')?.getAttribute('data-bp-status-key') === 'status.saved')
}
async function reopen(page) {
  // This keyless reload fixture must reach credential-missing after loading's blank DOM.
  await page.getByRole('dialog', { name: /^(Add an API key to get started|添加一个 API Key 开始使用)$/ }).waitFor({ state: 'visible', timeout: 15000 })
  await dismissOnboardingDialogs(page)
  if (!await page.locator(SELECTORS.root).isVisible()) await page.getByRole('button', { name: /^(XuanLing Blueprint|XuanLing 蓝图|玄灵蓝图)$/ }).click()
  await page.locator(SELECTORS.root).waitFor({ state: 'visible' })
}

/** Explicit permission seam on one disposable page; never invokes the OS
 * clipboard. Genuine menu/keyboard handlers still call navigator.clipboard.
 * This is UI race evidence, not native clipboard bridge acceptance. */
async function clipboardSeam(page) {
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    window.__bpComfyClipboard = { descriptor, text: '', mode: 'normal', writes: 0, reads: 0, pending: null, release: null }
    const state = window.__bpComfyClipboard
    const wait = async () => {
      if (state.mode === 'denied') throw new DOMException('Isolated clipboard denied', 'NotAllowedError')
      if (state.mode === 'hold') await new Promise(resolve => { state.pending = true; state.release = resolve })
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(text) { state.writes++; await wait(); state.text = text },
      async readText() { state.reads++; await wait(); return state.text },
    } })
  })
}
async function restoreClipboard(page) {
  await page.evaluate(() => {
    const state = window.__bpComfyClipboard
    if (!state) return
    state.release?.()
    if (state.descriptor) Object.defineProperty(navigator, 'clipboard', state.descriptor)
    else delete navigator.clipboard
    delete window.__bpComfyClipboard
  })
}
/** Stop disposable observers without waiting for a mounted canvas after navigation. */
export async function cleanupComfyJourney(page, receipt, primaryError) {
  let firstError
  for (const [step, cleanup] of [
    ['reconnect-observer', () => page.evaluate(reconnectBrowserProbe, { action: 'stop' })],
    ['viewport-observer', () => page.evaluate(viewportBrowserProbe, { action: 'stop' })],
    ['space-observer', () => page.evaluate(() => { window.__bpComfySpaceDiagnostic?.stop(); delete window.__bpComfySpaceDiagnostic })],
    ['clipboard-seam', () => restoreClipboard(page)],
  ]) {
    try { await cleanup() }
    catch (error) {
      firstError ??= error
      receipt.cleanupErrors ??= []
      receipt.cleanupErrors.push({ step, message: error.message, stack: error.stack })
    }
  }
  if (!primaryError && firstError) throw firstError
}
async function clipboardMode(page, mode) { await page.evaluate(mode => { window.__bpComfyClipboard.mode = mode }, mode) }
async function clipboardText(page) { return page.evaluate(() => window.__bpComfyClipboard.text) }
const edgeLocator = page => page.locator('.react-flow__edge').filter({ has: page.locator('path.react-flow__edge-path') }).first()
async function edgePoint(page) {
  return edgeLocator(page).locator('path.react-flow__edge-path').evaluate(el => {
    const p = el.getPointAtLength(el.getTotalLength() / 2), matrix = el.getScreenCTM()
    if (!matrix) throw new Error('edge path has no mounted transform')
    const mapped = new DOMPoint(p.x, p.y).matrixTransform(matrix)
    return { x: mapped.x, y: mapped.y }
  })
}

export async function runCanvasJourney(page, assert, api) {
  const dir = process.env.BP_COMFY_ARTIFACT_DIR
  ensure(dir && reportPathAllowed(process.env.BP_COLLECTOR_PLAN_ID ?? PLAN_ID, 'comfy', dir), 'new W2 evidence directory required')
  // Retain every original browser contract, not merely its screenshot.
  await setNativeLocale(page, 'en')
  const base = await originalJourney(page, assert, api)
  const receipt = { planId: process.env.BP_COLLECTOR_PLAN_ID ?? PLAN_ID, wave: 'W2', startedAt: new Date().toISOString(), keyRead: false, providerCalls: 0,
    providerEvidence: false, nativeClipboardEvidence: false, transportFixtures: [],
    clipboardSeams: [{ kind: 'disposable-page-permission-and-late-result', scope: 'UI-only', osClipboardRead: false, osClipboardWrite: false }],
    cases: [], themes: [], rpc: [], downloads: [], trustedEvents: { pointerdown: 0, pointerup: 0, keydown: 0, wheel: 0, compositionstart: 0 }, untrustedEvents: 0,
    phase: 'comfy-journey', browserMessages: [] }
  let primaryError = null
  const browserMessage = entry => { receipt.browserMessages.push({ at: new Date().toISOString(), ...entry }) }
  const onPageError = error => browserMessage({ kind: 'pageerror', message: error.message, stack: error.stack })
  const onConsole = message => browserMessage({ kind: 'console', type: message.type(), text: message.text(), location: message.location() })
  page.on('pageerror', onPageError); page.on('console', onConsole)
  await page.exposeFunction('__bpComfyBlankObserve', facts => {
    receipt.blankPointDiagnostics ??= []
    receipt.blankPointDiagnostics.push({ at: new Date().toISOString(), ...facts })
    writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
  })
  await page.exposeFunction('__bpComfyObserve', ({ type, trusted }) => {
    if (trusted) receipt.trustedEvents[type]++
    else receipt.untrustedEvents++
  })
  const installObserver = () => {
    if (window.__bpComfyObserving) return
    window.__bpComfyObserving = true
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'wheel', 'compositionstart']) document.addEventListener(type, event => {
      void window.__bpComfyObserve({ type, trusted: event.isTrusted })
    }, { capture: true, passive: true })
  }
  await page.addInitScript(installObserver); await page.evaluate(installObserver)
  const requests = [], observe = request => {
    if (/\/api\/llm\/(?:stream|request)/.test(request.url())) receipt.providerCalls++
    if (!request.url().includes('/api/blueprint/') || request.method() !== 'POST') return
    const body = request.postDataJSON(), args = body?.payload?.args?.args ?? body?.payload?.args
    requests.push({ method: body?.method?.replace(/^blueprint\//, ''), args })
  }
  page.on('request', observe)
  const realApi = async (method, args) => {
    const response = await api(method, args)
    receipt.rpc.push({ method, blueprintId: args?.blueprintId, status: response.status, ok: response.body?.result?.ok === true,
      code: response.body?.result?.error?.code ?? null, at: new Date().toISOString(), provenance: 'real DSH gateway',
      ...(response.body?.result?.value?.documentRevision ? { documentRevision: response.body.result.value.documentRevision } : {}) })
    return response
  }
  const doc = (id = 'comfy-edit') => readDefinition(page, realApi, id)
  const history = () => page.locator(SELECTORS.root).evaluate(el => ({ undo: el.querySelector('[data-bp-action="undo"]').disabled, redo: el.querySelector('[data-bp-action="redo"]').disabled, dirty: el.querySelector('[data-bp-dirty]').getAttribute('data-bp-dirty') }))
  const check = (id, description, passed, facts = {}) => {
    const evidence = { id, description, passed: passed === true, at: new Date().toISOString(), facts }
    receipt.cases.push(evidence); assert(id, description, passed === true, stringifyProbeEvidence(facts, 0))
    writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
    ensure(passed === true, `${id}: ${description}`)
  }
  const undoRoundtrip = async (before, after, blueprintId = 'comfy-edit') => {
    ensure(!same(before, after), 'operation made no observable document change')
    await action(page, 'undo').click(); await settle(page); ensure(same(await doc(blueprintId), before), 'one Undo did not restore entire document')
    await action(page, 'redo').click(); await settle(page); ensure(same(await doc(blueprintId), after), 'one Redo did not restore entire document')
    await action(page, 'undo').click(); await settle(page)
  }
  const cancelledDrags = async (control, prepare, previousDocument) => {
    const evidence = []
    const snapshot = async () => ({ document: await doc(), history: await history(),
      hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'cancelled gesture Host invariant') })
    const digest = state => ({ documentSha256: sha256(JSON.stringify(state.document)), hostDocumentSha256: sha256(JSON.stringify(state.hostDocument)), history: state.history })
    for (const kind of ['escape', 'outside-release']) {
      await prepare()
      const baseline = await snapshot(), from = await point(control), bounds = await page.locator(SELECTORS.root).boundingBox()
      ensure(bounds, 'cancelled gesture workspace bounds missing')
      await page.mouse.move(from.x, from.y); await page.mouse.down()
      try {
        await page.mouse.move(kind === 'escape' ? from.x + 35 : bounds.x + bounds.width + 20, from.y + 25, { steps: 8 })
        if (kind === 'escape') await page.keyboard.press('Escape')
      } finally { await page.mouse.up() }
      await settle(page)
      const afterCancel = await snapshot()
      ensure(same(baseline, afterCancel), `${kind} changed full document/Host/history after cancelled gesture`)
      // Availability alone cannot detect an extra no-op Undo entry. Traverse
      // the known preceding edit and return to the exact baseline via Redo.
      await action(page, 'undo').click(); await settle(page); const undone = await doc()
      ensure(same(undone, previousDocument), `${kind} introduced a spurious cancelled gesture history entry`)
      await action(page, 'redo').click(); await settle(page); const restored = await snapshot()
      ensure(same(restored, baseline), `${kind} changed the preceding edit or Redo/history state`)
      evidence.push({ kind, before: digest(baseline), after: digest(afterCancel),
        priorDocumentSha256: sha256(JSON.stringify(previousDocument)), undoDocumentSha256: sha256(JSON.stringify(undone)), redoDocumentSha256: sha256(JSON.stringify(restored.document)) })
    }
    return evidence
  }
  try {
    await choose(page, 'comfy-edit')
    const initial = await doc()
    ensure(initial.graph.nodes.length === 6 && initial.resources.shared && initial.resources.mcp && initial.graph.nodes.find(n => n.id === 'source').outputs['part.中文'] === 'string', 'typed Unicode/resource fixture preconditions missing')
    const navDocument = value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'navigation baseline')
    const navHistory = await history(), viewStyle = () => page.locator('.react-flow__viewport').getAttribute('style')
    const navigationUnchanged = async () => same(navHistory, await history()) && same(navDocument, value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'navigation document invariant')) && same(initial, await doc())
    await action(page, 'mode-select').click(); await focusCanvas(page)
    let navBefore = await viewStyle(), navPoint
    const spacePath = await interiorNavigationDrag(page, { x: -45, y: -25 })
    const navigationSnapshot = async () => ({ style: await viewStyle(), viewport: await renderedViewport(page), ...await navigationGeometry(page),
      history: await history(), definition: await doc(), hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'Space diagnostic complete Host invariant') })
    const spaceBaseline = { style: navBefore, viewport: await renderedViewport(page), ...await navigationGeometry(page), history: navHistory, definition: initial, hostDocument: navDocument }
    const spaceTargets = { space: { ...await navigationTargets(page, spacePath.from, spacePath.to), path: spacePath } }
    await page.evaluate(() => {
      const events = [], types = ['pointerdown', 'pointermove', 'pointerup', 'keydown', 'keyup']
      const listener = event => {
        const hit = event.composedPath?.()[0] ?? event.target
        events.push({ type: event.type, trusted: event.isTrusted, timeStamp: event.timeStamp, key: event.key ?? null, code: event.code ?? null,
          button: event.button ?? null, buttons: event.buttons ?? null, clientX: event.clientX ?? null, clientY: event.clientY ?? null,
          target: { tag: hit?.tagName ?? null, className: hit?.getAttribute?.('class') ?? null, inPane: !!hit?.closest?.('.react-flow__pane'),
            nodeId: hit?.closest?.('.react-flow__node')?.getAttribute('data-id') ?? null, canvas: hit?.closest?.('[data-bp-canvas]')?.getAttribute('data-bp-canvas') ?? null } })
      }
      window.__bpComfySpaceDiagnostic = { events, stop: () => types.forEach(type => document.removeEventListener(type, listener, true)) }
      types.forEach(type => document.addEventListener(type, listener, { capture: true, passive: true }))
    })
    await page.keyboard.down('Space')
    try { await drag(page, spacePath.from, spacePath.to) } finally { await page.keyboard.up('Space') }
    await settle(page); const postSpace = await navigationSnapshot(), spaceAfter = postSpace.style
    const ordinaryPath = await interiorNavigationDrag(page, { x: -20, y: -15 })
    spaceTargets.ordinary = { ...await navigationTargets(page, ordinaryPath.from, ordinaryPath.to), path: ordinaryPath }
    await drag(page, ordinaryPath.from, ordinaryPath.to)
    const postOrdinary = await navigationSnapshot(), spaceInput = await page.evaluate(() => {
      const state = window.__bpComfySpaceDiagnostic; state.stop(); delete window.__bpComfySpaceDiagnostic; return state.events
    })
    const spaceFacts = spacePanDiagnosticFacts({ before: spaceBaseline, postSpace, postOrdinary, targets: spaceTargets, input: spaceInput })
    check('CI-SPACE-PAN', 'selection mode Space temporarily pans; keyup releases and ordinary drag does not pan or write document/history',
      navBefore !== spaceAfter && spaceAfter === postOrdinary.style && spaceFacts.invariants.historyUnchanged && spaceFacts.invariants.hostUnchanged && spaceFacts.invariants.definitionUnchanged, spaceFacts)
    navBefore = await viewStyle(); navPoint = await blank(page)
    await page.mouse.move(navPoint.x, navPoint.y); await page.mouse.down({ button: 'middle' }); await page.mouse.move(navPoint.x - 35, navPoint.y - 25, { steps: 8 }); await page.mouse.up({ button: 'middle' }); await settle(page)
    check('CI-MIDDLE-PAN', 'trusted middle-button drag pans in selection mode with canonical/history unchanged', navBefore !== await viewStyle() && await navigationUnchanged())
    navBefore = await viewStyle(); const horizontalBefore = await renderedViewport(page)
    navPoint = await blank(page); await page.mouse.move(navPoint.x, navPoint.y); await page.mouse.wheel(120, 0)
    await page.waitForFunction(before => document.querySelector('.react-flow__viewport').getAttribute('style') !== before, navBefore)
    const horizontalAfter = await renderedViewport(page)
    check('CI-HORIZONTAL-WHEEL', 'trusted horizontal wheel pans with fixed zoom and no graph/document/history writes', horizontalBefore.x !== horizontalAfter.x && horizontalBefore.zoom === horizontalAfter.zoom && await navigationUnchanged(), { before: horizontalBefore, after: horizontalAfter })
    await page.locator(SELECTORS.surface).focus(); await page.keyboard.press('f'); await settle(page)
    const sourceBounds = await node(page, 'source').boundingBox(); ensure(sourceBounds, 'source box is not measured')
    await drag(page, { x: sourceBounds.x - 10, y: sourceBounds.y - 10 }, { x: sourceBounds.x + sourceBounds.width + 10, y: sourceBounds.y + sourceBounds.height + 10 })
    const boxSelected = await page.locator('.react-flow__node.selected[data-id]').evaluateAll(items => items.map(el => el.getAttribute('data-id')))
    check('CI-BOX-SELECTION', 'trusted selection-mode box selects intended executable node without history/document mutation', same(boxSelected, ['source']) && await navigationUnchanged())
    await page.locator(SELECTORS.surface).focus(); await page.keyboard.press('ControlOrMeta+a'); await settle(page)
    const allSelected = await page.locator('.react-flow__node.selected[data-id]').evaluateAll(items => items.map(el => el.getAttribute('data-id')).sort())
    check('CI-SELECT-ALL', 'canvas Ctrl/Meta+A selects all six executable nodes and excludes presentation frame', same(allSelected, initial.graph.nodes.map(n => n.id).sort()) && await navigationUnchanged())
    await focusCanvas(page); await selectNodes(page, ['source'])
    const startDrag = await point(node(page, 'source').locator('.bp-node-title'))
    await page.mouse.move(startDrag.x, startDrag.y); await page.mouse.down(); await page.mouse.move(startDrag.x + 45, startDrag.y + 25, { steps: 6 }); await page.keyboard.press('Escape'); await page.mouse.up(); await settle(page)
    const escaped = await doc()
    const outsideStart = await point(node(page, 'source').locator('.bp-node-title')), rootBox = await page.locator(SELECTORS.root).boundingBox()
    await drag(page, outsideStart, { x: rootBox.x + rootBox.width + 20, y: outsideStart.y })
    check('CI-GESTURE-CANCEL', 'Escape and release outside workspace cancel node gesture without pending history or draft', same(initial, escaped) && await navigationUnchanged())
    await action(page, 'mode-pan').click(); await focusCanvas(page)
    await focusCanvas(page)
    const focused = await page.evaluate(() => document.activeElement === document.querySelector('[data-bp-canvas="surface"]'))
    const p = await blank(page); await page.mouse.click(p.x, p.y, { button: 'right' })
    await page.locator(SELECTORS.menu).waitFor({ state: 'visible' })
    const bounded = await page.locator(SELECTORS.menu).evaluate(el => {
      const a = el.getBoundingClientRect(), b = el.closest('[data-bp-canvas="root"]').getBoundingClientRect()
      return a.left >= b.left && a.top >= b.top && a.right <= b.right + 1 && a.bottom <= b.bottom + 1 && el.contains(document.activeElement)
    })
    await page.keyboard.press('Escape'); await settle(page)
    check('CI-MENU-FOCUS', 'canvas menu stays within workspace and Escape restores focused canvas without mutation', focused && bounded && !await page.locator(SELECTORS.menu).isVisible() && await page.evaluate(() => document.activeElement === document.querySelector('[data-bp-canvas="surface"]')) && same(initial, await doc()))
    await page.mouse.click(p.x, p.y, { button: 'right' }); await page.locator(SELECTORS.menu).waitFor({ state: 'visible' })
    await page.keyboard.press('End'); const last = await page.evaluate(() => document.activeElement?.getAttribute('data-bp-menu-command'))
    await page.keyboard.press('Home'); const first = await page.evaluate(() => document.activeElement?.getAttribute('data-bp-menu-command'))
    await page.keyboard.press('ArrowDown'); const next = await page.evaluate(() => document.activeElement?.getAttribute('data-bp-menu-command'))
    await page.keyboard.press('Home'); await page.keyboard.press('Enter')
    await page.locator(SELECTORS.search).waitFor({ state: 'visible' })
    check('CI-MENU-KEYBOARD', 'Home/End/arrows/Enter operate the same menu commands and open node search', first === 'search' && last && next && next !== first && await page.locator(SELECTORS.searchInput).evaluate(el => el === document.activeElement))
    await page.locator(SELECTORS.searchInput).fill('输出'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await settle(page)
    let after = await doc(), before = initial
    const created = after.graph.nodes.filter(n => !before.graph.nodes.some(old => old.id === n.id))
    check('CI-SEARCH', 'bilingual keyboard search creates exactly one declared output with one Undo', created.length === 1 && created[0].kind === 'output')
    await undoRoundtrip(before, after)
    await focusCanvas(page)
    const searchBaseline = await navigationSnapshot(), searchStages = [], searchInputBefore = { ...receipt.trustedEvents }
    receipt.searchCancelDiagnostic = searchCancelDiagnosticFacts(searchBaseline, searchStages)
    const recordSearch = async kind => {
      searchStages.push({ kind, ...await navigationSnapshot(), searchVisible: await page.locator(SELECTORS.search).isVisible() })
      receipt.searchCancelDiagnostic = searchCancelDiagnosticFacts(searchBaseline, searchStages)
    }
    await page.keyboard.press('Tab'); await page.locator(SELECTORS.search).waitFor({ state: 'visible' }); await recordSearch('tab-open')
    await page.locator(SELECTORS.searchInput).fill('condition'); await page.keyboard.press('Escape'); await settle(page)
    await recordSearch('tab-cancel')
    const q = await blank(page), searchTarget = await navigationTargets(page, q, q)
    await page.mouse.dblclick(q.x, q.y); await settle(page)
    // Capture native zoom/propagation effects before waiting for search; a
    // timeout retains this partial witness in the existing failure receipt.
    await recordSearch('doubleclick-open')
    await page.locator(SELECTORS.search).waitFor({ state: 'visible' }); await page.keyboard.press('Escape'); await settle(page)
    await recordSearch('doubleclick-cancel')
    const searchFacts = { ...receipt.searchCancelDiagnostic, doubleclickTarget: searchTarget,
      trustedInput: { before: searchInputBefore, after: { ...receipt.trustedEvents }, untrusted: receipt.untrustedEvents } }
    check('CI-SEARCH-CANCEL', 'Tab and double-click search cancel without viewport, full document, Host or history changes',
      searchStages.length === 4 && Object.values(searchFacts.invariants).every(Boolean) && same(before, searchStages.at(-1).definition) && !await page.locator(SELECTORS.search).isVisible(), searchFacts)
    const outsideMenuPoint = await blank(page); await page.mouse.click(outsideMenuPoint.x, outsideMenuPoint.y, { button: 'right' }); await page.locator(SELECTORS.menu).waitFor({ state: 'visible' })
    await preparePublicAction(page, 'shortcuts')
    await action(page, 'shortcuts').click(); await page.locator('[data-bp-overlay="shortcuts"]').waitFor({ state: 'visible' })
    await page.mouse.click(outsideMenuPoint.x, outsideMenuPoint.y); await settle(page)
    check('CI-OVERLAY-OUTSIDE', 'genuine outside pointer closes overlay and leaves definition/history intact', !await page.locator('[data-bp-overlay="shortcuts"]').isVisible() && same(before, await doc()))

    before = await doc()
    await drag(page, await point(port(page, 'source:data:part.中文', 'source')), await blank(page))
    await page.locator(SELECTORS.search).waitFor({ state: 'visible' }); await page.locator(SELECTORS.searchInput).fill('output')
    await page.locator('[data-bp-search-kind="output"]').click(); await settle(page); after = await doc()
    const dropNode = after.graph.nodes.find(n => !before.graph.nodes.some(old => old.id === n.id))
    check('CI-DROP-COMPATIBLE', 'string dotted Unicode source drop creates a compatible node and complete logical edge atomically', !!dropNode && after.graph.edges.length === before.graph.edges.length + 1 && after.graph.edges.some(e => e.from === 'source.part.中文' && e.to.startsWith(`${dropNode.id}.`)))
    await undoRoundtrip(before, after)
    await drag(page, await point(port(page, 'source:data:number', 'source')), await blank(page))
    await page.locator(SELECTORS.search).waitFor({ state: 'visible' }); await page.locator(SELECTORS.searchInput).fill('output')
    check('CI-DROP-INCOMPATIBLE', 'number drop does not advertise string output or invent its port', await page.locator('[data-bp-search-kind="output"]').count() === 0 && same(before, await doc()))
    await page.keyboard.press('Escape'); await settle(page)
    await drag(page, await point(port(page, 'source:data:value', 'source')), await blank(page))
    await page.locator(SELECTORS.search).waitFor({ state: 'visible' }); await page.keyboard.press('Escape'); await settle(page)
    check('CI-DROP-CANCEL', 'cancelled compatible and incompatible drop-search leave original document intact', same(before, await doc()))

    await clipboardSeam(page)
    await selectNodes(page, ['source', 'sink', 'sharedTask', 'zeroTask'])
    await page.keyboard.press('ControlOrMeta+c'); await page.waitForFunction(() => window.__bpComfyClipboard.text.length > 0); await idle(page)
    const fragment = JSON.parse(await clipboardText(page))
    before = await doc(); await focusCanvas(page); await page.keyboard.press('ControlOrMeta+v'); await idle(page); await settle(page); after = await doc()
    const pasted = after.graph.nodes.filter(n => !before.graph.nodes.some(old => old.id === n.id))
    check('CI-COPY-PASTE', 'trusted copy/paste through disposable clipboard remaps IDs, exact dotted ports, declarations and internal edge in one Undo', fragment.version === 1 && fragment.nodes.length === 4 && pasted.length === 4 && new Set(after.graph.nodes.map(n => n.id)).size === after.graph.nodes.length && pasted.some(n => n.outputs?.['part.中文'] === 'string') && same(before.resources, after.resources) && after.graph.edges.length === before.graph.edges.length + 1 && !/archiveBase64|outputJson|diagnostics|CONTENT-H1/.test(JSON.stringify(fragment)), { clipboardProvenance: 'UI-only permission seam', fragmentSha256: sha256(JSON.stringify(fragment)) })
    await undoRoundtrip(before, after)
    await selectNodes(page, ['spare']); before = await doc(); await page.keyboard.press('ControlOrMeta+x'); await idle(page); await settle(page); after = await doc()
    check('CI-CUT', 'cut deletes only after successful isolated clipboard write and is a single undo', !after.graph.nodes.some(n => n.id === 'spare') && JSON.parse(await clipboardText(page)).nodes[0].id === 'spare')
    await undoRoundtrip(before, after)
    await selectNodes(page, ['sink']); before = await doc(); const oldText = await clipboardText(page)
    await clipboardMode(page, 'denied'); await page.keyboard.press('ControlOrMeta+x'); await idle(page); await settle(page)
    check('CI-CLIPBOARD-DENIED', 'denied write preserves selected node and old clipboard with visible failure', same(before, await doc()) && await clipboardText(page) === oldText && /clipboard|剪贴板/i.test(await page.locator('[data-bp-status="message"]').textContent()))
    await clipboardMode(page, 'normal')
    for (let pass = 1; pass <= 3; pass++) {
      await choose(page, 'comfy-edit'); await selectNodes(page, ['sink']); const sourceBefore = await doc()
      const targetBefore = await doc('comfy-other'); await clipboardMode(page, 'hold'); await page.keyboard.press('ControlOrMeta+x')
      await page.waitForFunction(() => window.__bpComfyClipboard.pending === true)
      await choose(page, 'comfy-other')
      await page.evaluate(() => { const s = window.__bpComfyClipboard; s.mode = 'normal'; s.pending = false; s.release() }); await idle(page); await settle(page)
      check(`CI-CLIPBOARD-LATE-${pass}`, 'late successful cut after blueprint switch cannot delete source or mutate target', same(sourceBefore, await doc('comfy-edit')) && same(targetBefore, await doc('comfy-other')), { pass, clipboardProvenance: 'UI-only held permission seam' })
    }
    await choose(page, 'comfy-edit'); await selectNodes(page, ['sink']); await page.keyboard.press('ControlOrMeta+c'); await idle(page); await settle(page)
    before = await doc(); await focusCanvas(page); await page.keyboard.press('ControlOrMeta+Shift+v'); await idle(page); await settle(page); after = await doc()
    const incoming = after.graph.nodes.find(n => !before.graph.nodes.some(old => old.id === n.id))
    check('CI-INCOMING', 'same-blueprint incoming paste preserves valid external source and exact Unicode endpoint', !!incoming && after.graph.edges.some(e => e.from === 'source.part.中文' && e.to === `${incoming.id}.part.中文`))
    await undoRoundtrip(before, after)
    await selectNodes(page, ['source']); before = await doc(); const a = await point(node(page, 'source').locator('.bp-node-title'))
    await drag(page, a, { x: a.x + 65, y: a.y + 42 }, ['Alt']); after = await doc()
    check('CI-ALT-CLONE', 'Alt drag produces one independent declaration clone without moving original', after.graph.nodes.length === before.graph.nodes.length + 1 && same(after.presentation.nodes.source, before.presentation.nodes.source))
    await undoRoundtrip(before, after)
    await restoreClipboard(page)
    receipt.reconnectDiagnostics = []
    let reconnectInFlight = null
    await page.exposeFunction('__bpComfyReconnectObserve', entry => {
      if (!reconnectInFlight) return
      reconnectInFlight.trace.push(entry)
      // Stream the actual mouse-down target before a wrong path or later
      // browser failure can prevent the final case assertion.
      writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
    })
    const reconnectSnapshot = async () => ({ definition: await doc(), history: await history(),
      hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'reconnect complete Host diagnostic'),
      edgeId: await edgeLocator(page).count() ? await edgeLocator(page).getAttribute('data-id') : null,
      edgeIds: await page.locator('.react-flow__edge').evaluateAll(items => items.map(el => el.getAttribute('data-id'))),
      ...await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'state' }) })
    for (let pass = 1; pass <= 3; pass++) {
      before = await doc(); const oldId = await edgeLocator(page).getAttribute('data-id'), ep = await edgePoint(page); await page.mouse.click(ep.x, ep.y)
      const baseline = await reconnectSnapshot()
      const from = await point(edgeLocator(page).locator('.react-flow__edgeupdater-target')), to = await point(port(page, 'spare:data:part.中文', 'target'))
      const geometry = await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'geometry', from, to, edgeId: oldId })
      const facts = { pass, edgeId: oldId, ...reconnectDiagnosticFacts(baseline, null), geometry, trace: [], phase: 'prepared' }
      receipt.reconnectDiagnostics.push(facts); reconnectInFlight = facts
      writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
      await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'observe' })
      try { facts.phase = 'dragging'; await drag(page, from, to) }
      catch (error) { facts.failure = redactProbeEvidenceText(String(error)); throw error }
      finally {
        await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'stop' })
        reconnectInFlight = null
        writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
      }
      after = await doc()
      Object.assign(facts, reconnectDiagnosticFacts(baseline, await reconnectSnapshot()), { phase: 'after-drag' })
      facts.geometryAfter = await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'geometry', from, to, edgeId: oldId })
      check(`CI-RECONNECT-VALID-${pass}`, 'valid reconnect changes endpoint preserving edge identity, original-edge exclusion and one Undo', await edgeLocator(page).getAttribute('data-id') === oldId && after.graph.edges.length === before.graph.edges.length && after.graph.edges[0].from === 'source.part.中文' && after.graph.edges[0].to === 'spare.part.中文', facts)
      await undoRoundtrip(before, after)
    }
    for (let pass = 1; pass <= 3; pass++) {
      before = await doc(); const e = await edgePoint(page); await page.mouse.click(e.x, e.y)
      await drag(page, await point(edgeLocator(page).locator('.react-flow__edgeupdater-target')), await point(port(page, 'wrong:data:value', 'target')))
      after = await doc()
      check(`CI-RECONNECT-INVALID-${pass}`, 'incompatible target reconnect retains original edge, points and graph', same(before, after), { pass })
    }
    before = await doc(); let e = await edgePoint(page); await page.mouse.click(e.x, e.y)
    await drag(page, await point(edgeLocator(page).locator('.react-flow__edgeupdater-target')), await blank(page))
    check('CI-RECONNECT-CANCEL', 'reconnect to blank preserves old complete edge and no pending presentation', same(before, await doc()))
    e = await edgePoint(page); await page.mouse.click(e.x, e.y)
    const shiftBaseline = await reconnectSnapshot()
    const shiftFrom = await point(edgeLocator(page).locator('.react-flow__edgeupdater-target')), shiftTo = await point(port(page, 'spare:data:part.中文', 'target'))
    const shiftGeometry = await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'geometry', from: shiftFrom, to: shiftTo, edgeId: shiftBaseline.edgeId })
    const shiftFacts = { kind: 'shift-copy', ...reconnectDiagnosticFacts(shiftBaseline, null), geometry: shiftGeometry, trace: [], phase: 'prepared' }
    receipt.reconnectDiagnostics.push(shiftFacts); reconnectInFlight = shiftFacts
    writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
    await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'observe' })
    try { shiftFacts.phase = 'dragging'; await drag(page, shiftFrom, shiftTo, ['Shift']) }
    catch (error) { shiftFacts.failure = redactProbeEvidenceText(String(error)); throw error }
    finally {
      await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'stop' })
      reconnectInFlight = null
      writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
    }
    after = await doc()
    Object.assign(shiftFacts, reconnectDiagnosticFacts(shiftBaseline, await reconnectSnapshot()), { phase: 'after-drag' })
    shiftFacts.geometryAfter = await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'geometry', from: shiftFrom, to: shiftTo, edgeId: shiftBaseline.edgeId })
    check('CI-SHIFT-COPY', 'Shift reconnect copies a valid typed edge and retains original identity/endpoints', after.graph.edges.length === before.graph.edges.length + 1 && before.graph.edges.every(old => after.graph.edges.some(edge => same(old, edge))) && after.graph.edges.some(edge => edge.from === 'source.part.中文' && edge.to === 'spare.part.中文'), shiftFacts)
    // Both selected incident edges are disconnected by one command/history.
    const shifted = after
    await selectNodes(page, ['source']); await context(page, node(page, 'source').locator('.bp-node-title'), 'disconnect'); after = await doc()
    check('CI-BULK-DISCONNECT', 'one incident-edge disconnect removes both edges and one Undo restores all', after.graph.edges.length === 0 && shifted.graph.edges.length === 2)
    await undoRoundtrip(shifted, after)
    await action(page, 'undo').click(); await settle(page); ensure(same(await doc(), before), 'Shift copy undo did not restore original graph')

    before = await doc(); e = await edgePoint(page); await page.keyboard.down('Alt')
    try { await page.mouse.click(e.x, e.y) } finally { await page.keyboard.up('Alt') }
    await settle(page); after = await doc()
    const reroute = page.locator('[data-bp-reroute]').first()
    check('CI-REROUTE-ADD', 'Alt edge click adds presentation point bound to complete logical edge, graph unchanged', same(before.graph, after.graph) && after.presentation.edges?.[0]?.points?.length === 1 && await reroute.count() === 1)
    const withPoint = after, routeCancellations = await cancelledDrags(reroute, () => reroute.focus(), before)
    const rp = await point(reroute)
    await drag(page, rp, { x: rp.x + 35, y: rp.y + 25 }); after = await doc()
    check('CI-REROUTE-MOVE', 'Escape/outside point drags retain full document/history before valid presentation-only drag', same(after.graph, withPoint.graph) && !same(after.presentation.edges, withPoint.presentation.edges), { cancellations: routeCancellations })
    await undoRoundtrip(withPoint, after)
    await reroute.click(); await reroute.focus(); await page.keyboard.press('Delete'); await settle(page); after = await doc()
    check('CI-REROUTE-DELETE', 'focused point Delete removes the point while retaining complete edge', same(after.graph, withPoint.graph) && !after.presentation.edges?.some(edge => edge.points.length))
    await undoRoundtrip(withPoint, after)
    await action(page, 'undo').click(); await settle(page); ensure(same(await doc(), before), 'reroute Undo changed graph or left points')

    await selectNodes(page, ['source']); before = await doc(); await context(page, node(page, 'source').locator('.bp-node-title'), 'toggle-pin')
    let pinned = await doc(); const titlePoint = await point(node(page, 'source').locator('.bp-node-title'))
    await drag(page, titlePoint, { x: titlePoint.x + 60, y: titlePoint.y + 30 }); await page.locator(SELECTORS.surface).focus(); await page.keyboard.press('ArrowRight'); after = await doc()
    check('CI-PIN', 'pinned node ignores genuine drag and keyboard movement but retains selection', pinned.presentation.nodes.source.pinned === true && same(after, pinned) && await node(page, 'source').locator('[data-bp-pinned="true"]').count() > 0)
    await action(page, 'undo').click(); await settle(page); ensure(same(await doc(), before), 'pin undo polluted history')
    await selectNodes(page, ['source']); before = await doc(); const handles = await node(page, 'source').locator('[data-bp-port]').evaluateAll(items => items.map(el => el.getAttribute('data-bp-port')).sort())
    await context(page, node(page, 'source').locator('.bp-node-title'), 'toggle-collapse'); after = await doc()
    const collapsedHandles = await node(page, 'source').locator('[data-bp-port]').evaluateAll(items => items.map(el => el.getAttribute('data-bp-port')).sort())
    check('CI-COLLAPSE', 'collapse persists explicit presentation, keeping every typed/Unicode handle and graph', after.presentation.nodes.source.collapsed === true && same(before.graph, after.graph) && same(handles, collapsedHandles))
    await undoRoundtrip(before, after)
    before = await doc(); await node(page, 'source').locator('.bp-node-title').dblclick()
    await page.locator(SELECTORS.rename).waitFor({ state: 'visible' }); await page.locator(SELECTORS.renameInput).fill(' 标题.中文 🐳 '); await action(page, 'rename-apply').click(); await settle(page); after = await doc()
    check('CI-RENAME', 'double-click title rename preserves raw Unicode/spaces and writes only presentation title', after.presentation.nodes.source.title === ' 标题.中文 🐳 ' && same(before.graph, after.graph) && !Object.hasOwn(after.graph.nodes.find(n => n.id === 'source'), 'name'))
    // Keep this presentation for real save/load and current export later.
    const beforeRename = before
    before = after; await selectNodes(page, ['source'])
    const resizer = node(page, 'source').locator('[data-bp-resize="source"] .react-flow__resize-control.handle').last()
    const resizeCancellations = await cancelledDrags(resizer, async () => { await selectNodes(page, ['source']); await page.locator(SELECTORS.surface).focus() }, beforeRename)
    await selectNodes(page, ['source'])
    const resizePoint = await point(resizer); await drag(page, resizePoint, { x: resizePoint.x + 48, y: resizePoint.y + 35 }); after = await doc()
    check('CI-RESIZE', 'Escape/outside resize drags retain full document/history before valid finite size commit', Number.isFinite(after.presentation.nodes.source.width) && Number.isFinite(after.presentation.nodes.source.height) && after.presentation.nodes.source.width > 0 && after.presentation.nodes.source.height > 0 && !same(before.presentation.nodes.source, after.presentation.nodes.source) && same(before.graph, after.graph), { cancellations: resizeCancellations })
    await action(page, 'undo').click(); await settle(page); ensure(same(await doc(), before), 'resize undo did not restore presentation'); await action(page, 'redo').click(); await settle(page)
    before = await doc(); await context(page, node(page, 'source').locator('.bp-node-title'), 'color-blue'); after = await doc()
    check('CI-COLOR', 'color command uses the frozen token and affects presentation only', after.presentation.nodes.source.color === 'blue' && same(before.graph, after.graph))

    await selectNodes(page, ['source', 'wrong', 'zeroTask']); before = await doc(); await page.keyboard.press('ControlOrMeta+g'); await settle(page); after = await doc()
    const newGroup = after.presentation.groups.find(g => !before.presentation.groups.some(old => old.id === g.id))
    check('CI-GROUP', 'multi-selection Group produces one presentation group and preserves graph', !!newGroup && same([...newGroup.nodeIds].sort(), ['source', 'wrong', 'zeroTask'].sort()) && same(before.graph, after.graph))
    await action(page, 'undo').click(); await settle(page); ensure(same(await doc(), before), 'group undo did not restore document'); await action(page, 'redo').click(); await settle(page)
    const header = page.locator(`[data-bp-group-header="${newGroup.id}"]`)
    const beforeGroupRename = await doc()
    before = beforeGroupRename; await context(page, header, 'rename'); await page.locator(SELECTORS.renameInput).fill('组.中文'); await action(page, 'rename-apply').click(); await settle(page); after = await doc()
    check('CI-GROUP-RENAME', 'group header rename addresses the group independently of member count', after.presentation.groups.find(g => g.id === newGroup.id)?.label === '组.中文' && same(before.graph, after.graph))
    before = after
    const groupCancellations = await cancelledDrags(header, () => header.focus(), beforeGroupRename)
    // Undo/Redo can remount the header. Take fresh document and actual geometry
    // after both cancellations, before the unchanged valid (+40,+25) gesture.
    const groupBaseline = await reconnectSnapshot()
    ensure(same(groupBaseline.definition, before), 'group cancellation lost valid-drag baseline')
    const hp = await point(header)
    const groupGeometry = await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'group-geometry', groupId: newGroup.id, from: hp, to: { x: hp.x + 40, y: hp.y + 25 } })
    const groupFacts = { kind: 'group-move', ...groupMoveDiagnosticFacts(groupBaseline, null, newGroup), cancellations: groupCancellations, geometry: groupGeometry, trace: [], phase: 'prepared' }
    receipt.reconnectDiagnostics.push(groupFacts); reconnectInFlight = groupFacts
    writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
    await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'observe' })
    try { groupFacts.phase = 'dragging'; await drag(page, hp, { x: hp.x + 40, y: hp.y + 25 }) }
    catch (error) { groupFacts.failure = redactProbeEvidenceText(String(error)); throw error }
    finally {
      await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'stop' })
      reconnectInFlight = null
      writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
    }
    after = await doc()
    Object.assign(groupFacts, groupMoveDiagnosticFacts(groupBaseline, await reconnectSnapshot(), newGroup), { phase: 'after-drag' })
    groupFacts.geometryAfter = await page.locator(SELECTORS.root).evaluate(reconnectBrowserProbe, { action: 'group-geometry', groupId: newGroup.id, from: hp, to: { x: hp.x + 40, y: hp.y + 25 } })
    groupFacts.oracle = groupMoveOracle(groupFacts)
    check('CI-GROUP-MOVE', 'group drag applies the independently captured shared finite delta to the exact entire document atomically', groupFacts.oracle.passed, groupFacts)
    await undoRoundtrip(before, after)
    before = await doc(); const groupView = await viewStyle()
    await context(page, header, 'fit-selection'); await settle(page)
    check('CI-GROUP-FIT', 'group fit-selection changes rendered viewport only, without modifying document', groupView !== await viewStyle() && same(before, await doc()))
    await clipboardSeam(page)
    try {
      await context(page, header, 'copy'); await page.waitForFunction(() => window.__bpComfyClipboard.text.length > 0)
      const groupFragment = JSON.parse(await clipboardText(page)); await canvasContext(page, 'paste'); await idle(page); await settle(page); after = await doc()
      check('CI-GROUP-COPY', 'group copy/paste remaps member IDs and presentation frame atomically', groupFragment.presentation.groups.some(g => g.id === newGroup.id) && after.graph.nodes.length === before.graph.nodes.length + 3 && after.presentation.groups.length === before.presentation.groups.length + 1 && new Set(after.presentation.groups.map(g => g.id)).size === after.presentation.groups.length, { clipboardProvenance: 'UI-only permission seam' })
      await undoRoundtrip(before, after)
    } finally { await restoreClipboard(page) }
    before = await doc(); await context(page, header, 'ungroup'); after = await doc()
    check('CI-UNGROUP', 'group menu ungroup removes only presentation frame and one Undo restores exact group/members', !after.presentation.groups.some(g => g.id === newGroup.id) && same(before.graph, after.graph))
    await undoRoundtrip(before, after)
    await selectNodes(page, ['source', 'wrong', 'zeroTask']); before = await doc(); await context(page, node(page, 'source').locator('.bp-node-title'), 'align-left'); after = await doc()
    const xs = ['source', 'wrong', 'zeroTask'].map(id => after.presentation.nodes[id].x)
    check('CI-ALIGN', 'measured multi-node align-left affects only positions and is one undo', xs.every(x => x === xs[0]) && same(before.graph, after.graph))
    await undoRoundtrip(before, after)
    await selectNodes(page, ['source', 'wrong', 'zeroTask']); before = await doc(); await context(page, node(page, 'source').locator('.bp-node-title'), 'distribute-y'); after = await doc()
    const bounds = await page.locator('.react-flow__node.selected').evaluateAll(items => items.map(el => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom } }).sort((a, b) => a.top - b.top))
    const gaps = bounds.slice(1).map((r, i) => r.top - bounds[i].bottom)
    check('CI-DISTRIBUTE', 'measured vertical distribution gives equal visible gaps with graph unchanged', bounds.length === 3 && Math.abs(gaps[0] - gaps[1]) < 2 && same(before.graph, after.graph))
    await undoRoundtrip(before, after)

    // Save dirty presentation before viewport/IME/CAS so their no-write oracle
    // compares full canonical Host documents, not only a projected screenshot.
    await save(page)
    const saved = value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'saved presentation')
    before = JSON.parse(saved.definitionJson)
    const uiBefore = await page.locator(SELECTORS.root).evaluate(el => ({ dirty: el.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty'), undo: el.querySelector('[data-bp-action="undo"]')?.disabled }))
    await action(page, 'mode-select').click(); await preparePublicAction(page, 'motion-toggle')
    await action(page, 'motion-toggle').click(); await focusCanvas(page); await page.keyboard.press('m')
    const bp = await blank(page), zoomBefore = (await renderedViewport(page)).zoom
    let zoomAfter = null, viewState, storedZoomBefore
    const viewportFacts = { kind: 'viewport-preferences', phase: 'before-wheel', renderedZoomBefore: zoomBefore, renderedZoomAfter: null, wheel: [], stages: [] }
    receipt.viewportDiagnostics = [viewportFacts]
    const persistViewport = () => writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
    const viewportStages = [], recordViewport = async kind => {
      // Read actual browser values first, before the full real Host RPC read.
      const browser = await page.locator(SELECTORS.root).evaluate(viewportBrowserProbe, { action: 'state', point: bp })
      browser.css = await page.evaluate(viewportCssProbe, { blueprintId: 'comfy-edit' })
      const state = { kind, at: new Date().toISOString(), browser, history: await history(), definition: await doc(),
        hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'viewport diagnostic full Host') }
      viewportStages.push(state)
      Object.assign(viewportFacts, viewportDiagnosticFacts(viewportStages[0], viewportStages, { zoomBefore, zoomAfter }))
      persistViewport()
    }
    let viewportWheelTarget = viewportFacts.wheel
    await page.exposeFunction('__bpComfyViewportWheelObserve', entry => { viewportWheelTarget.push(entry); persistViewport() })
    await page.locator(SELECTORS.root).evaluate(viewportBrowserProbe, { action: 'observe' })
    try {
      await recordViewport('before-wheel')
      storedZoomBefore = viewportStages[0].browser.publicPrefs.state?.viewport?.zoom
      ensure(Number.isFinite(storedZoomBefore), 'pre-wheel full public zoom missing')
      viewportFacts.storedZoomBefore = storedZoomBefore
      await page.mouse.move(bp.x, bp.y); await page.mouse.wheel(0, -120)
      await recordViewport('after-wheel-before-wait')
      viewportFacts.phase = 'wait-stored-zoom-change-and-css-match'; persistViewport()
      await page.waitForFunction(viewportCssProbe, { action: 'wait', blueprintId: 'comfy-edit', beforeZoom: storedZoomBefore })
      zoomAfter = (await renderedViewport(page)).zoom
      viewportFacts.renderedZoomAfter = zoomAfter
      await recordViewport('after-stored-zoom-css-wait')
      viewState = await page.evaluate(() => JSON.parse(localStorage.getItem('xuanling-blueprint:viewport:comfy-edit')))
      viewportFacts.expectedPrefs = viewState
      const uiAfter = await page.locator(SELECTORS.root).evaluate(el => ({ dirty: el.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty'), undo: el.querySelector('[data-bp-action="undo"]')?.disabled }))
      await recordViewport('before-case-assertion')
      viewportFacts.css = await page.evaluate(viewportCssProbe, { blueprintId: 'comfy-edit', expectedPrefs: viewState })
      viewportFacts.oracle = viewportStateOracle(viewportFacts.css, { beforeZoom: storedZoomBefore, expectedPrefs: viewState })
      viewportFacts.phase = 'case-assertion'; persistViewport()
      check('CI-VIEWPORT-PREFERENCES', 'pan/select, minimap, motion and plain vertical wheel zoom persist only dedicated UI state, not history or document', zoomBefore !== zoomAfter && viewportFacts.oracle.passed && viewState.mode === 'select' && viewState.motion === 'off' && viewState.minimap === false && same(uiBefore, uiAfter) && Object.values(viewportFacts.invariants).every(Boolean) && same(saved, value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'viewport document unchanged')), viewportFacts)
      viewportFacts.phase = 'complete'
    } catch (error) {
      viewportFacts.failure = { phase: viewportFacts.phase, message: redactProbeEvidenceText(String(error)) }
      persistViewport(); throw error
    } finally {
      try { await recordViewport(viewportFacts.failure ? 'failure-finally' : 'complete-finally') }
      catch (error) {
        viewportFacts.finalStateReadError = redactProbeEvidenceText(String(error))
        if (!viewportFacts.failure) throw error
      }
      finally { await page.locator(SELECTORS.root).evaluate(viewportBrowserProbe, { action: 'stop' }); persistViewport() }
    }
    const viewportBaseline = viewportStages[0]
    await choose(page, 'comfy-other'); await action(page, 'mode-pan').click(); const otherPoint = await blank(page)
    const otherSnapshot = async () => ({ definition: await doc('comfy-other'), history: await history(),
      hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-other' }), 'other viewport full Host') })
    const otherBefore = await otherSnapshot(), otherCssBefore = await page.evaluate(viewportCssProbe, { blueprintId: 'comfy-other' })
    const otherZoomBefore = otherCssBefore.publicPrefs.state?.viewport?.zoom
    ensure(Number.isFinite(otherZoomBefore), 'other pre-wheel full public zoom missing')
    const otherFacts = { kind: 'other-viewport-wheel', phase: 'before-wheel', storedZoomBefore: otherZoomBefore, wheel: [], stages: [], before: otherBefore }
    receipt.viewportDiagnostics.push(otherFacts); viewportWheelTarget = otherFacts.wheel
    const otherStages = [], recordOtherViewport = async kind => {
      const browser = await page.locator(SELECTORS.root).evaluate(viewportBrowserProbe, { action: 'state', point: otherPoint })
      browser.css = await page.evaluate(viewportCssProbe, { blueprintId: 'comfy-other' })
      const state = { kind, at: new Date().toISOString(), browser, ...await otherSnapshot() }
      otherStages.push(state)
      Object.assign(otherFacts, viewportDiagnosticFacts(otherStages[0], otherStages, { zoomBefore: otherCssBefore.actual?.matrix.m11, zoomAfter: null }))
      persistViewport()
    }
    await page.locator(SELECTORS.root).evaluate(viewportBrowserProbe, { action: 'observe' })
    try {
      await recordOtherViewport('before-wheel')
      await page.mouse.move(otherPoint.x, otherPoint.y); await page.mouse.wheel(0, 120)
      await recordOtherViewport('after-wheel-before-wait')
      otherFacts.phase = 'wait-stored-zoom-change-and-css-match'; persistViewport()
      await page.waitForFunction(viewportCssProbe, { action: 'wait', blueprintId: 'comfy-other', beforeZoom: otherZoomBefore })
      otherFacts.css = await page.evaluate(viewportCssProbe, { blueprintId: 'comfy-other' })
      otherFacts.oracle = viewportStateOracle(otherFacts.css, { beforeZoom: otherZoomBefore })
      ensure(otherFacts.oracle.passed, 'other wheel did not change full stored zoom and match actual browser CSS')
      otherFacts.phase = 'complete'
    } catch (error) { otherFacts.failure = { phase: otherFacts.phase, message: redactProbeEvidenceText(String(error)) }; persistViewport(); throw error }
    finally {
      try { await recordOtherViewport(otherFacts.failure ? 'failure-finally' : 'complete-finally') }
      catch (error) { otherFacts.finalStateReadError = redactProbeEvidenceText(String(error)); if (!otherFacts.failure) throw error }
      finally { await page.locator(SELECTORS.root).evaluate(viewportBrowserProbe, { action: 'stop' }); persistViewport() }
    }
    const otherAfter = await otherSnapshot()
    ensure(same(otherBefore, otherAfter), 'other wheel changed full document/Host/history')
    otherFacts.after = otherAfter
    const otherState = await page.evaluate(() => JSON.parse(localStorage.getItem('xuanling-blueprint:viewport:comfy-other')))
    await choose(page, 'comfy-edit')
    await page.waitForFunction(viewportCssProbe, { action: 'wait', blueprintId: 'comfy-edit', expectedPrefs: viewState })
    const switchedCss = await page.evaluate(viewportCssProbe, { blueprintId: 'comfy-edit', expectedPrefs: viewState })
    const switched = { definition: await doc(), history: await history(), hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'switch document unchanged') }
    const switchOracle = viewportStateOracle(switchedCss, { expectedPrefs: viewState })
    const switchInvariants = { documentUnchanged: same(viewportBaseline.definition, switched.definition), hostUnchanged: same(saved, switched.hostDocument),
      historyUnchanged: same(viewportBaseline.history, switched.history), otherUnchanged: same(otherBefore, otherAfter) }
    check('CI-VIEWPORT-SWITCH', 'blueprint switch restores independent preferences without cross-document viewport leakage', switchOracle.passed && !same(viewState, otherState) && Object.values(switchInvariants).every(Boolean)
      && same(otherState, await page.evaluate(() => JSON.parse(localStorage.getItem('xuanling-blueprint:viewport:comfy-other')))),
    { css: switchedCss, expectedPrefs: viewState, oracle: switchOracle, invariants: switchInvariants, before: viewportBaseline, after: switched, otherWheel: otherFacts })
    const reloadFacts = { kind: 'viewport-reload', phase: 'before-reload', expectedPrefs: viewState, stages: [] }
    receipt.viewportDiagnostics.push(reloadFacts)
    const reloadStages = [], recordReloadViewport = async kind => {
      const browser = await page.evaluate(viewportBrowserProbe, { action: 'state', blueprintId: 'comfy-edit', point: bp })
      browser.css = await page.evaluate(viewportCssProbe, { blueprintId: 'comfy-edit', expectedPrefs: viewState })
      const state = { kind, at: new Date().toISOString(), browser, history: browser.history, definition: await doc(),
        hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'reload diagnostic full Host') }
      reloadStages.push(state)
      Object.assign(reloadFacts, viewportDiagnosticFacts(viewportBaseline, reloadStages, { zoomBefore: zoomAfter, zoomAfter: null, expectedPrefs: viewState }))
      persistViewport()
    }
    try {
      await recordReloadViewport('before-reload')
      reloadFacts.phase = 'reload-navigation'; persistViewport()
      await page.reload({ waitUntil: 'domcontentloaded' })
      reloadFacts.phase = 'after-reload'; await recordReloadViewport('after-reload')
      reloadFacts.phase = 'reopen'; persistViewport(); await reopen(page)
      reloadFacts.phase = 'after-reopen'; await recordReloadViewport('after-reopen')
      reloadFacts.phase = 'choose'; persistViewport(); await choose(page, 'comfy-edit')
      reloadFacts.phase = 'after-choose'; await recordReloadViewport('after-choose')
      reloadFacts.phase = 'wait-reload-exact-css'; persistViewport()
      await page.waitForFunction(viewportCssProbe, { action: 'wait', blueprintId: 'comfy-edit', expectedPrefs: viewState })
      await recordReloadViewport('after-exact-wait')
      const reloadedView = await page.evaluate(() => JSON.parse(localStorage.getItem('xuanling-blueprint:viewport:comfy-edit')))
      const actualViewport = await renderedViewport(page)
      const reloadedCss = await page.evaluate(viewportCssProbe, { blueprintId: 'comfy-edit', expectedPrefs: viewState })
      const reloaded = { definition: await doc(), history: await history(), hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'reload document unchanged') }
      const reloadOracle = viewportStateOracle(reloadedCss, { expectedPrefs: viewState })
      const reloadInvariants = { documentUnchanged: same(viewportBaseline.definition, reloaded.definition), hostUnchanged: same(saved, reloaded.hostDocument), historyUnchanged: same(viewportBaseline.history, reloaded.history) }
      reloadFacts.phase = 'case-assertion'; persistViewport()
      check('CI-VIEWPORT-RELOAD', 'actual DSH reload restores saved preferences and rendered zoom with canonical document unchanged', same(viewState, reloadedView) && reloadOracle.passed && Object.values(reloadInvariants).every(Boolean)
        && same(otherState, await page.evaluate(() => JSON.parse(localStorage.getItem('xuanling-blueprint:viewport:comfy-other')))),
      { renderedViewport: actualViewport, css: reloadedCss, expectedPrefs: viewState, oracle: reloadOracle, invariants: reloadInvariants, before: viewportBaseline, after: reloaded })
      reloadFacts.phase = 'complete'
    } catch (error) { reloadFacts.failure = { phase: reloadFacts.phase, message: redactProbeEvidenceText(String(error)) }; persistViewport(); throw error }
    finally {
      try { await recordReloadViewport(reloadFacts.failure ? 'failure-finally' : 'complete-finally') }
      catch (error) { reloadFacts.finalStateReadError = redactProbeEvidenceText(String(error)); if (!reloadFacts.failure) throw error }
      finally { persistViewport() }
    }

    await selectNodes(page, ['source']); before = await doc()
    await prepareRunInput(page)
    const typing = page.locator('[data-bp-run-input]'); await typing.fill('native input untouched'); await typing.focus(); await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Delete'); await page.keyboard.type('typing stays input')
    check('CI-TYPING', 'native textbox selection/Delete/text bypass canvas selection/delete/history shortcuts', await typing.inputValue() === 'typing stays input' && same(before, await doc()) && await node(page, 'source').count() === 1)
    const cdp = await page.context().newCDPSession(page)
    try {
      await typing.focus(); await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 0, selectionEnd: 2 }); await page.keyboard.press('ArrowLeft'); await cdp.send('Input.insertText', { text: '中文' }); await settle(page)
      check('CI-IME', 'browser IME composition/arrow/commit preserves graph and emits trusted composition', receipt.trustedEvents.compositionstart > 0 && (await typing.inputValue()).includes('中文') && same(before, await doc()), { source: 'CDP Input.imeSetComposition in disposable Chromium, not JS dispatchEvent' })
    } finally { await cdp.detach() }
    const concurrent = structuredClone(before); concurrent.presentation.nodes.wrong.title = 'Host concurrent title'
    const hostNew = value(await realApi('saveDefinition', { blueprintId: 'comfy-edit', definitionJson: JSON.stringify(concurrent), expectedRevision: saved.documentRevision }), 'real concurrent CAS writer')
    await selectNodes(page, ['source']); await page.locator(SELECTORS.surface).focus(); await page.keyboard.press('ArrowRight'); await settle(page)
    const retainedDraft = await doc(); await action(page, 'save-layout').click(); await idle(page)
    const denied = requests.filter(r => r.method === 'saveDefinition').at(-1)
    check('CI-CAS', 'stale mounted Save fails revision conflict, retaining draft and independently written Host document', denied?.args.expectedRevision === saved.documentRevision && (await page.locator('[data-bp-status="message"]').textContent()).includes('blueprint/revision-conflict') && same(retainedDraft, await doc()) && same(hostNew, value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'CAS host unchanged')))
    const stale = await realApi('saveDefinition', { blueprintId: 'comfy-edit', definitionJson: JSON.stringify(retainedDraft), expectedRevision: saved.documentRevision })
    ensure(stale.body?.result?.error?.code === 'blueprint/revision-conflict', 'Host CAS failure is not typed')
    // Explicit fixture-only reconciliation: retain local draft via the same
    // existing Host CAS, then use native reload to bind the new revision.
    receipt.phase = 'cas-reconciliation/save'
    value(await realApi('saveDefinition', { blueprintId: 'comfy-edit', definitionJson: JSON.stringify(retainedDraft), expectedRevision: hostNew.documentRevision }), 'fixture CAS reconciliation')
    receipt.phase = 'cas-reconciliation/choose-other'; await choose(page, 'comfy-other')
    receipt.phase = 'cas-reconciliation/choose-edit'; await choose(page, 'comfy-edit')
    for (let pass = 1; pass <= 3; pass++) {
      receipt.phase = `save-load-${pass}/choose`; await choose(page, 'comfy-edit')
      receipt.phase = `save-load-${pass}/select`; await selectNodes(page, ['source'])
      receipt.phase = `save-load-${pass}/color`; await context(page, node(page, 'source').locator('.bp-node-title'), 'color-blue')
      receipt.phase = `save-load-${pass}/save`; await save(page)
      receipt.phase = `save-load-${pass}/read`
      const roundtrip = value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'presentation roundtrip load')
      receipt.phase = `save-load-${pass}/reload`; await page.reload({ waitUntil: 'domcontentloaded' })
      receipt.phase = `save-load-${pass}/reopen`; await reopen(page)
      receipt.phase = `save-load-${pass}/choose`; await choose(page, 'comfy-edit')
      check(`CI-SAVE-LOAD-${pass}`, 'real Host Save/load and native reload retain strict presentation, groups and graph', same(roundtrip, value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'roundtrip after reload')) && same(JSON.parse(roundtrip.definitionJson), await doc()), { pass, documentRevision: roundtrip.documentRevision, semanticRevision: roundtrip.semanticRevision })
    }
    // Empty target is configured from boot with its OWN correct package ID.
    // Populate via real Host, download via UI, then move only this disposable
    // same-ID fixture to backup. Import never changes the downloaded archive ID.
    const fixture = JSON.parse(readFileSync(join(dir, 'comfy-fixtures.json'), 'utf8'))
    assertEmptyImportFixture(fixture)
    const emptyCatalog = value(await realApi('listDefinitions'), 'configured empty import target').definitions.find(d => d.blueprintId === 'comfy-empty')
    ensure(emptyCatalog?.documentRevision === null && fixture.seed.id === 'comfy-empty', 'same-ID empty configured target missing')
    value(await realApi('saveDefinition', { blueprintId: 'comfy-empty', definitionJson: JSON.stringify(fixture.seed), expectedRevision: null }), 'seed same-ID export fixture through Host')
    await preparePublicAction(page, 'refresh-library')
    await action(page, 'refresh-library').click(); await idle(page); await choose(page, 'comfy-empty')
    const archiveBefore = value(await realApi('loadDefinition', { blueprintId: 'comfy-empty' }), 'archive source')
    const downloadEvent = page.waitForEvent('download')
    const exportResponseEvent = page.waitForResponse(response => /\/api\/blueprint\/exportDefinition(?:\?|$)/.test(response.url()) && response.request().method() === 'POST')
    await preparePublicAction(page, 'export-blueprint')
    await action(page, 'export-blueprint').click()
    const [download, exportResponse] = await Promise.all([downloadEvent, exportResponseEvent])
    const archivePath = join(dir, 'downloaded-comfy-empty.zip'); await download.saveAs(archivePath)
    ensure(await download.failure() === null, 'native archive download failed')
    // Export manifest contains exportedAt. Compare the SAME UI request's Host
    // response; a second export legitimately has different archive bytes.
    const exportWire = { status: exportResponse.status(), body: await exportResponse.json() }
    const bytes = readFileSync(archivePath), exported = verifyArchiveDownload(bytes, exportWire, 'comfy-empty')
    receipt.rpc.push({ method: 'exportDefinition', blueprintId: 'comfy-empty', status: exportWire.status, ok: true, code: null, at: new Date().toISOString(), provenance: 'real DSH gateway' })
    check('CI-ARCHIVE-DOWNLOAD', 'actual UI download is byte-identical to real Host archive and retains configured package ID', bytes.length > 0 && sha256(bytes) === exported.archiveSha256 && bytes.equals(Buffer.from(exported.archiveBase64, 'base64')) && requests.some(r => r.method === 'exportDefinition' && r.args.blueprintId === 'comfy-empty'), { archiveSha256: sha256(bytes), blueprintId: 'comfy-empty', filename: download.suggestedFilename() })
    receipt.downloads.push({ kind: 'archive', path: archivePath, sha256: sha256(bytes), blueprintId: 'comfy-empty', provenance: 'actual Playwright download from real Host exportDefinition' })
    await choose(page, 'comfy-files')
    const backup = join(fixture.tempRoot, 'comfy-empty-export-backup')
    ensure(!existsSync(backup), 'fixture export backup already exists')
    renameSync(fixture.empty, backup); mkdirSync(fixture.empty)
    receipt.fixtureRotation = { source: fixture.empty, backup, sameConfiguredId: 'comfy-empty', userData: false, archiveIdRewritten: false }
    await preparePublicAction(page, 'refresh-library')
    await action(page, 'refresh-library').click(); await idle(page)
    const importLockSnapshot = async kind => {
      // Menu availability and the import dialog are mutually exclusive public
      // surfaces. Measure the real entry, then restore the same empty dialog;
      // retain every original lock/visibility/document/Host/history assertion.
      const dialogWasOpen = await page.locator('[data-bp-overlay="import"]').isVisible()
      if (dialogWasOpen && await action(page, 'more-actions').count()) await page.keyboard.press('Escape')
      await preparePublicAction(page, 'import-blueprint')
      const importButtonVisible = await action(page, 'import-blueprint').isVisible(), importDisabled = await action(page, 'import-blueprint').isDisabled()
      const publicEntry = { selector: '[data-bp-action="import-blueprint"]', visible: importButtonVisible, disabled: importDisabled, at: new Date().toISOString() }
      if (dialogWasOpen) {
        if (await action(page, 'more-actions').count()) await action(page, 'import-blueprint').click()
        await page.locator('[data-bp-overlay="import"]').waitFor({ state: 'visible' })
      } else { await closePublicMore(page); await page.locator(SELECTORS.surface).focus() }
      return { kind, definition: await doc('comfy-files'), history: await history(),
        hostDocument: value(await realApi('loadDefinition', { blueprintId: 'comfy-files' }), 'import lock Host invariant'),
        locked: await page.locator(SELECTORS.root).getAttribute('data-bp-canvas-locked') === 'true', importButtonVisible,
        importDisabled, importVisible: await page.locator('[data-bp-overlay="import"]').isVisible(), publicEntry,
        noticeVisible: await page.locator('[data-bp-status="message"]').isVisible(), noticeKey: await page.locator('[data-bp-status="message"]').getAttribute('data-bp-status-key'), noticeText: await page.locator('[data-bp-status="message"]').textContent() }
    }
    await focusCanvas(page)
    const importLockFacts = { before: await importLockSnapshot('before'), stages: [], keys: [] }
    await page.evaluate(() => {
      const events = [], listener = event => { if (['h', 'o', 'v'].includes(event.key.toLowerCase())) events.push({ key: event.key.toLowerCase(), trusted: event.isTrusted,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey, canvasFocused: !!event.target?.closest?.('[data-bp-canvas="surface"]') }) }
      document.addEventListener('keydown', listener, { capture: true, passive: true }); window.__bpComfyImportLock = { events, listener }
    })
    try {
      await page.keyboard.press('h'); await settle(page); importLockFacts.stages.push(await importLockSnapshot('locked'))
      for (const [kind, chord] of [['control-o', 'Control+o'], ['meta-o', 'Meta+o']]) {
        await page.keyboard.press(chord); await settle(page); importLockFacts.stages.push(await importLockSnapshot(kind))
      }
      await page.keyboard.press('v'); await settle(page); importLockFacts.stages.push(await importLockSnapshot('unlocked'))
    } finally {
      importLockFacts.keys = await page.evaluate(() => { const state = window.__bpComfyImportLock; if (!state) return []
        document.removeEventListener('keydown', state.listener, true); delete window.__bpComfyImportLock; return state.events })
    }
    await preparePublicAction(page, 'import-blueprint')
    await action(page, 'import-blueprint').click(); await page.locator('[data-bp-overlay="import"]').waitFor({ state: 'visible' })
    importLockFacts.stages.push(await importLockSnapshot('ordinary-import'))
    check('CI-IMPORT-LOCK', 'trusted H disables Import and refuses Control/Meta O without document/Host/history writes; V restores ordinary import', importLockWitness(importLockFacts), importLockFacts)
    await page.locator('[data-bp-import-target]').selectOption('comfy-empty'); await page.locator(SELECTORS.file).setInputFiles(archivePath)
    await page.locator('[data-bp-import-confirm]').check()
    const importResponseEvent = page.waitForResponse(response => /\/api\/blueprint\/importDefinition(?:\?|$)/.test(response.url()) && response.request().method() === 'POST')
    await action(page, 'import-apply').click(); await idle(page)
    const importResponse = await importResponseEvent
    const importWire = { status: importResponse.status(), body: await importResponse.json() }
    const importResult = value(importWire, 'same real Host UI import response')
    ensure(importResult?.blueprintId === 'comfy-empty', 'UI import response configured identity mismatch')
    receipt.rpc.push({ method: 'importDefinition', blueprintId: importResult.blueprintId, status: importWire.status, ok: true, code: null, at: new Date().toISOString(), provenance: 'real DSH gateway' })
    await page.waitForFunction(() => document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-blueprint') === 'comfy-empty')
    const imported = value(await realApi('loadDefinition', { blueprintId: 'comfy-empty' }), 'actual imported archive')
    check('CI-ARCHIVE-EMPTY', 'downloaded unchanged same-ID archive imports through UI and real Host into configured empty root', same(JSON.parse(imported.definitionJson), JSON.parse(archiveBefore.definitionJson)) && imported.semanticRevision === archiveBefore.semanticRevision && requests.some(r => r.method === 'importDefinition' && r.args.blueprintId === 'comfy-empty'), { blueprintId: 'comfy-empty', archiveSha256: sha256(bytes), documentRevision: imported.documentRevision })
    const nonemptyResponse = await realApi('importDefinition', { blueprintId: 'comfy-empty', archiveBase64: bytes.toString('base64') })
    await preparePublicAction(page, 'import-blueprint')
    await action(page, 'import-blueprint').click(); await page.locator('[data-bp-overlay="import"]').waitFor({ state: 'visible' })
    const disabledNonempty = await page.locator('[data-bp-import-target] option[value="comfy-empty"]').isDisabled()
    await page.keyboard.press('Escape')
    check('CI-ARCHIVE-NONEMPTY', 'UI disables nonempty target and authoritative Host rejects replay with package unchanged', disabledNonempty && nonemptyResponse.body?.result?.error?.code === 'blueprint/import-failed' && same(imported, value(await realApi('loadDefinition', { blueprintId: 'comfy-empty' }), 'nonempty package unchanged')))

    await choose(page, 'comfy-edit')
    await preparePublicAction(page, 'export-blueprint')
    check('CI-CURRENT-EXPORT', 'only the current portable archive export is offered', await action(page, 'export-blueprint').count() === 1 && await action(page, 'export-legacy').count() === 0)
    await page.keyboard.press('Escape')
    const stable = value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'theme canonical baseline')
    for (const locale of ['zh', 'en']) for (const scheme of ['light', 'dark']) {
      await setNativeLocale(page, locale); await setNativeTheme(page, scheme)
      const dimensions = await page.locator(SELECTORS.root).evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, scheme: getComputedStyle(document.documentElement).colorScheme, overflow: document.documentElement.scrollWidth > innerWidth }))
      ensure(dimensions.width >= 800 && dimensions.height >= 500 && !dimensions.overflow && dimensions.scheme === scheme, 'native locale/theme layout contract failed')
      ensure(same(stable, value(await realApi('loadDefinition', { blueprintId: 'comfy-edit' }), 'theme document unchanged')), 'native locale/theme changed canonical document')
      const screenshot = join(dir, `${locale}-${scheme}.png`); await page.screenshot({ path: screenshot, fullPage: false })
      receipt.themes.push({ locale, scheme, screenshot, sha256: sha256(readFileSync(screenshot)), ...dimensions })
    }
    check('CI-THEMES', 'actual native zh/en × light/dark Settings render and retain canonical document', receipt.themes.length === 4)
    check('CI-ZERO-PROVIDER', 'W2 editing/files/CAS use keyless gateway with zero provider commands and no transport fixtures', receipt.providerCalls === 0 && !requests.some(r => ['startRun', 'hostProbe'].includes(r.method)) && !receipt.rpc.some(r => ['startRun', 'hostProbe'].includes(r.method)) && receipt.transportFixtures.length === 0 && receipt.keyRead === false)
    receipt.finishedAt = new Date().toISOString()
    receipt.requests = requests.map(r => ({ method: r.method, blueprintId: r.args?.blueprintId }))
    writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt))
    return { ...base, comfyInteractions: receipt }
  } catch (error) {
    primaryError = error
    receipt.primaryFailure = { at: new Date().toISOString(), message: error.message, stack: error.stack,
      phase: receipt.phase, latestCase: receipt.cases.at(-1)?.id ?? null, url: page.url(), captureErrors: [] }
    const capture = async (step, read) => {
      try { await read() }
      catch (captureError) { receipt.primaryFailure.captureErrors.push({ step, message: captureError.message, stack: captureError.stack }) }
    }
    await capture('persist-original', () => writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt)))
    await capture('native-dom', async () => {
      receipt.primaryFailure.dom = await page.evaluate(() => {
        const root = document.querySelector('[data-bp-canvas="root"]')
        const summary = el => ({ tag: el.tagName, role: el.getAttribute('role'), text: (el.textContent ?? '').slice(0, 1200),
          buttons: Array.from(el.querySelectorAll('button')).slice(0, 30).map(button => ({ text: button.textContent, action: button.getAttribute('data-bp-action'), disabled: button.disabled })) })
        return { title: document.title, readyState: document.readyState, rootPresent: !!root,
          seat: root ? Object.fromEntries(['data-bp-blueprint', 'data-bp-mode', 'data-bp-motion'].map(key => [key, root.getAttribute(key)])) : null,
          dialogs: Array.from(document.querySelectorAll('[role="dialog"],dialog')).slice(0, 8).map(summary),
          sidebar: Array.from(document.querySelectorAll('aside,[role="navigation"],nav')).slice(0, 8).map(summary),
          blueprintButtons: Array.from(document.querySelectorAll('button')).filter(el => /XuanLing|蓝图|Blueprint/.test(el.textContent ?? '')).slice(0, 20).map(summary) }
      })
    })
    await capture('native-screenshot', async () => {
      const screenshot = join(dir, 'failure.png')
      await page.screenshot({ path: screenshot, fullPage: false })
      receipt.primaryFailure.screenshot = { path: screenshot, sha256: sha256(readFileSync(screenshot)), provenance: 'actual Playwright page screenshot at primary failure' }
    })
    await capture('persist-failure', () => writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt)))
    throw error
  } finally {
    try { await cleanupComfyJourney(page, receipt, primaryError) }
    finally {
      page.off('request', observe); page.off('pageerror', onPageError); page.off('console', onConsole)
      // Persistence failure cannot replace an already captured native error.
      try { writeFileSync(join(dir, 'comfy-ui-evidence.json'), stringifyProbeEvidence(receipt)) }
      catch (error) { if (!primaryError) throw error; receipt.primaryFailure.captureErrors.push({ step: 'persist-cleanup', message: error.message, stack: error.stack }) }
    }
  }
}

function validTimestamp(text, lower, upper) {
  const time = Date.parse(text)
  return typeof text === 'string' && Number.isFinite(time) && time >= lower && time <= upper
}
function fingerprintValid(fp) {
  return /^[a-f0-9]{40}$/.test(fp?.revision ?? '') && /^[a-f0-9]{64}$/.test(fp?.source_sha256 ?? '') && /^[a-f0-9]{64}$/.test(fp?.artifact_sha256 ?? '')
}
function pngEvidence(dir, item) {
  ensure(realFile(dir, item.screenshot), 'native screenshot missing or outside fresh report directory')
  const bytes = readFileSync(item.screenshot)
  ensure(bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(16) >= 800 && bytes.readUInt32BE(20) >= 500, 'native screenshot PNG/dimensions invalid')
  ensure(item.sha256 === sha256(bytes), 'native screenshot hash mismatch')
}
export function validateComfyReport(report, context) {
  const { reportDir, invokedAt, finishedAt, planId = PLAN_ID, packageRoot = PLUGIN } = context
  ensure([PLAN_ID, COMPACT_PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(planId) && reportPathAllowed(planId, 'comfy', reportDir), 'fresh W2 plan/report isolation required (physical report isolation checked)')
  ensure(existsSync(reportDir) && reportPathAllowed(planId, 'comfy', reportDir, { physical: true }), 'fresh W2 physical report isolation required')
  ensure(Number.isFinite(invokedAt) && Number.isFinite(finishedAt) && finishedAt >= invokedAt, 'invalid invocation timestamps')
  // Check physical confinement BEFORE the shared validator reads its nested
  // JSON. A symlink must never make us read historical evidence or user data.
  ensure(realFile(reportDir, report?.artifacts?.sidebar_screenshot) && realFile(join(reportDir, 'tools'), report?.artifacts?.host_tools_contract?.reportPath), 'screenshot/nested security file missing or physically outside fresh directory')
  // This shared validator preserves all original Host/browser contracts.
  const original = validateCanvasReport(report, { mode: 'browser', planId, reportDir, packageRoot, invokedAt, finishedAt })
  ensure(report.environment.dsh_version_output === '0.2.1-alpha.1' && /^v\d+\./.test(report.environment.node ?? '') && typeof report.environment.browser_version === 'string' && report.environment.browser_version.length > 0, 'real DSH/browser/runtime provenance missing')
  ensure(isAbsolute(report.environment.temp_root ?? '') && /(?:^|[/\\])xuanling-bp-probe-[^/\\]+$/.test(report.environment.temp_root)
    && report.artifacts.auth_cookie_set === true && report.artifacts.index_has_boot === true && report.artifacts.client_bundle?.status === 200 && report.artifacts.client_bundle.closure === true
    && report.artifacts.boot_entries?.some(entry => entry.id === BLUEPRINT_PACKAGE), 'authenticated isolated DSH boot/closure provenance absent')
  const ids = new Set(report.assertions.map(a => a.id))
  for (const id of REQUIRED_ASSERTIONS) ensure(ids.has(id), `required assertion missing: ${id}`)
  const journey = report.artifacts.canvas_journey, ui = journey.comfyInteractions
  ensure(journey.provenance.startsWith('real DSH boot graph') && journey.binding && ui?.planId === planId && ui.wave === 'W2', 'real DSH mounted Comfy provenance missing')
  ensure(ui.keyRead === false && ui.providerCalls === 0 && ui.providerEvidence === false && ui.nativeClipboardEvidence === false, 'key/provider/native clipboard evidence mislabeled')
  ensure(Array.isArray(ui.transportFixtures) && ui.transportFixtures.length === 0, 'W2 forbids transport fixtures')
  ensure(ui.clipboardSeams?.length === 1 && ui.clipboardSeams[0].scope === 'UI-only' && ui.clipboardSeams[0].osClipboardRead === false && ui.clipboardSeams[0].osClipboardWrite === false, 'clipboard permission seam mislabeled')
  const start = Date.parse(report.started_at), end = Date.parse(report.finished_at)
  ensure(validTimestamp(ui.startedAt, start, end) && validTimestamp(ui.finishedAt, Date.parse(ui.startedAt), end), 'mounted evidence timestamps stale/missing')
  ensure(Array.isArray(ui.cases) && ui.cases.length === UI_ASSERTIONS.length, 'mounted case assertions missing/extra')
  const cases = new Set()
  for (const c of ui.cases) {
    ensure(c?.passed === true && UI_ASSERTIONS.includes(c.id) && !cases.has(c.id) && typeof c.description === 'string' && c.description.length > 0 && validTimestamp(c.at, Date.parse(ui.startedAt), Date.parse(ui.finishedAt)), `failed/duplicate/stale mounted case: ${c?.id}`)
    ensure(report.assertions.some(a => a.id === c.id && a.passed === true && a.description === c.description), `mounted/report assertion mismatch: ${c.id}`)
    if (c.id === 'CI-IMPORT-LOCK') ensure(importLockWitness(c.facts), 'import lock trusted availability/document/Host/history witness missing or failed')
    if (c.id === 'CI-SEARCH-CANCEL') {
      const { baseline, stages, invariants } = c.facts ?? {}, names = ['tab-open', 'tab-cancel', 'doubleclick-open', 'doubleclick-cancel']
      ensure(baseline && Array.isArray(stages) && stages.length === names.length, 'search cancellation full witness missing')
      ensure(typeof baseline.style === 'string' && ['x', 'y', 'zoom'].every(key => Number.isFinite(baseline.viewport?.[key])) && baseline.viewport.zoom > 0
        && typeof baseline.history?.undo === 'boolean' && typeof baseline.history.redo === 'boolean' && ['true', 'false'].includes(baseline.history.dirty)
        && /^[a-f0-9]{64}$/.test(baseline.definitionSha256 ?? '') && /^[a-f0-9]{64}$/.test(baseline.hostDocumentSha256 ?? ''), 'search cancellation baseline invalid')
      for (const [index, name] of names.entries()) {
        const state = stages[index]
        ensure(state?.kind === name && state.style === baseline.style && same(state.viewport, baseline.viewport) && same(state.history, baseline.history)
          && state.definitionSha256 === baseline.definitionSha256 && state.hostDocumentSha256 === baseline.hostDocumentSha256, `search cancellation ${name} changed viewport/document/Host/history`)
      }
      ensure(['viewportUnchanged', 'historyUnchanged', 'definitionUnchanged', 'hostUnchanged'].every(key => invariants?.[key] === true), 'search cancellation invariant failed')
    }
    if (['CI-RESIZE', 'CI-REROUTE-MOVE', 'CI-GROUP-MOVE'].includes(c.id)) {
      const cancellations = c.facts?.cancellations
      ensure(Array.isArray(cancellations) && cancellations.length === 2, `${c.id} cancellation proof missing`)
      for (const [index, kind] of ['escape', 'outside-release'].entries()) {
        const result = cancellations[index]
        ensure(result?.kind === kind && same(result.before, result.after) && /^[a-f0-9]{64}$/.test(result.before?.documentSha256 ?? '')
          && /^[a-f0-9]{64}$/.test(result.before?.hostDocumentSha256 ?? '') && result.before?.history?.undo === false
          && typeof result.before.history.redo === 'boolean' && ['true', 'false'].includes(result.before.history.dirty)
          && /^[a-f0-9]{64}$/.test(result.priorDocumentSha256 ?? '') && result.priorDocumentSha256 !== result.before.documentSha256
          && result.undoDocumentSha256 === result.priorDocumentSha256 && result.redoDocumentSha256 === result.before.documentSha256, `${c.id} ${kind} cancellation changed document/Host/history or lost Undo/Redo witness`)
      }
    }
    if (c.id === 'CI-GROUP-MOVE') {
      const oracle = groupMoveOracle(c.facts)
      ensure(oracle.passed && same(c.facts.oracle, oracle), 'group move exact document/gesture oracle missing or failed')
      ensure(c.facts.cancellations.every(result => result.before.documentSha256 === c.facts.before.documentSha256
        && result.before.hostDocumentSha256 === c.facts.before.hostDocumentSha256 && same(result.before.history, c.facts.before.history)), 'group move cancellation baseline differs from fresh valid-drag baseline')
    }
    if (['CI-VIEWPORT-PREFERENCES', 'CI-VIEWPORT-SWITCH', 'CI-VIEWPORT-RELOAD'].includes(c.id)) {
      const facts = c.facts, expectedPrefs = ui.cases.find(item => item.id === 'CI-VIEWPORT-PREFERENCES')?.facts?.expectedPrefs
      const options = c.id === 'CI-VIEWPORT-PREFERENCES' ? { beforeZoom: facts?.storedZoomBefore, expectedPrefs } : { expectedPrefs }
      const oracle = viewportStateOracle(facts?.css, options)
      ensure(expectedPrefs && same(facts?.expectedPrefs, expectedPrefs) && oracle.passed && same(facts.oracle, oracle), `${c.id} viewport exact CSS/full prefs oracle missing or failed`)
      const trustedWheel = (events, deltaY) => Array.isArray(events) && events.some(event => event.type === 'wheel' && event.trusted === true && event.deltaX === 0 && event.deltaY === deltaY
        && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey)
      if (c.id === 'CI-VIEWPORT-PREFERENCES') {
        ensure(trustedWheel(facts.wheel, -120) && Array.isArray(facts.stages) && facts.stages.some(state => state.kind === 'before-case-assertion')
          && facts.baseline?.document && facts.baseline?.hostDocument && facts.baseline?.history && facts.stages.every(state => same(state.document, facts.baseline.document)
            && same(state.hostDocument, facts.baseline.hostDocument) && same(state.history, facts.baseline.history))
          && ['documentUnchanged', 'hostUnchanged', 'historyUnchanged'].every(name => facts.invariants?.[name] === true), 'viewport preferences missing trusted wheel or full document/Host/history invariants')
      } else {
        ensure(facts.before?.definition && facts.before?.hostDocument && facts.before?.history && same(facts.before.definition, facts.after?.definition)
          && same(facts.before.hostDocument, facts.after?.hostDocument) && same(facts.before.history, facts.after?.history)
          && ['documentUnchanged', 'hostUnchanged', 'historyUnchanged'].every(name => facts.invariants?.[name] === true), `${c.id} viewport switch/reload full invariants missing or failed`)
        if (c.id === 'CI-VIEWPORT-SWITCH') {
          const other = facts.otherWheel, otherOracle = viewportStateOracle(other?.css, { beforeZoom: other?.storedZoomBefore })
          ensure(otherOracle.passed && same(other?.oracle, otherOracle) && trustedWheel(other?.wheel, 120) && other?.before?.definition
            && other.before.hostDocument && other.before.history && same(other.before, other.after), 'viewport other-blueprint wheel/full invariants missing or failed')
        }
      }
    }
    cases.add(c.id)
  }
  for (const id of UI_ASSERTIONS) ensure(cases.has(id), `mounted case missing: ${id}`)
  ensure(ui.trustedEvents?.pointerdown > 0 && ui.trustedEvents?.pointerup > 0 && ui.trustedEvents?.keydown > 0 && ui.trustedEvents?.wheel > 0 && ui.trustedEvents?.compositionstart > 0 && ui.untrustedEvents === 0, 'genuine pointer/keyboard/wheel/IME event provenance absent')
  ensure(Array.isArray(ui.themes) && ui.themes.length === 4, 'four native theme screenshots required')
  const themes = new Set()
  for (const theme of ui.themes) {
    ensure(['zh', 'en'].includes(theme.locale) && ['light', 'dark'].includes(theme.scheme) && theme.width >= 800 && theme.height >= 500 && theme.overflow === false && !themes.has(`${theme.locale}/${theme.scheme}`), 'native theme matrix/provenance invalid')
    themes.add(`${theme.locale}/${theme.scheme}`); pngEvidence(reportDir, theme)
  }
  ensure(Array.isArray(ui.rpc) && ui.rpc.length > 0, 'real Host RPC evidence missing')
  for (const rpc of ui.rpc) ensure(rpc.provenance === 'real DSH gateway' && rpc.status === 200 && typeof rpc.ok === 'boolean' && validTimestamp(rpc.at, Date.parse(ui.startedAt), Date.parse(ui.finishedAt)), 'invalid RPC provenance/timestamp')
  for (const method of ['loadDefinition', 'saveDefinition', 'exportDefinition', 'importDefinition', 'listDefinitions', 'validate']) ensure(ui.rpc.some(r => r.method === method && r.ok === true), `real Host ${method} success missing`)
  for (const [method, code] of [['saveDefinition', 'blueprint/revision-conflict'], ['importDefinition', 'blueprint/import-failed']]) ensure(ui.rpc.some(r => r.method === method && r.ok === false && r.code === code), `typed negative Host ${method} evidence missing`)
  ensure(Array.isArray(ui.requests) && !ui.requests.some(r => ['startRun', 'hostProbe'].includes(r.method)) && !ui.rpc.some(r => ['startRun', 'hostProbe'].includes(r.method)), 'W2 must not dispatch provider-capable commands')
  ensure(ui.downloads?.length === 1 && ui.downloads[0].kind === 'archive', 'current archive download evidence missing')
  for (const d of ui.downloads) ensure(d.kind === 'archive' && realFile(reportDir, d.path) && d.sha256 === sha256(readFileSync(d.path)) && d.provenance?.startsWith('actual Playwright'), 'download hash/provenance/missing file')
  ensure(ui.fixtureRotation?.sameConfiguredId === 'comfy-empty' && ui.fixtureRotation.archiveIdRewritten === false && ui.fixtureRotation.userData === false, 'same-ID empty archive fixture identity missing')
  ensure(ui.fixtureRotation.source === join(report.environment.temp_root, 'blueprints/comfy-empty') && confined(report.environment.temp_root, ui.fixtureRotation.backup), 'archive filesystem rotation escapes disposable probe fixture')
  return { ok: true, original, assertions: report.assertions.length, mountedCases: cases.size }
}

export function validateCollectorGate(report, { processResult, fingerprint, fingerprintAfter, provenance, expectedProvenance, ...context }) {
  ensure(processResult?.status === 0 && !processResult.signal && !processResult.error, 'probe subprocess failed or unavailable')
  ensure(fingerprintValid(fingerprint) && fingerprintValid(fingerprintAfter) && same(fingerprint, fingerprintAfter), 'checkout fingerprint changed/missing')
  ensure(provenance && expectedProvenance && same(provenance, expectedProvenance), 'probe/adapter/collector provenance hash mismatch')
  for (const name of ['probeSha256', 'adapterSha256', 'collectorSha256']) ensure(/^[a-f0-9]{64}$/.test(provenance[name] ?? ''), `provenance ${name} absent`)
  ensure(provenance.planId === (context.planId ?? PLAN_ID) && provenance.keyRead === false && provenance.providerCalls === 0 && same(provenance.performanceBudget, PERFORMANCE_BUDGET), 'provenance plan/isolation/original budgets invalid')
  if ([COMPACT_PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(context.planId)) for (const key of ['entrySha256', 'canvasJourneySha256']) ensure(/^[a-f0-9]{64}$/.test(provenance[key] ?? ''), `compact provenance ${key} missing`)
  return validateComfyReport(report, context)
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    console.log(`node --experimental-transform-types capabilities/comfy-interactions-ui.mjs --plan-id ${PLAN_ID} --report-dir <absolute-NEW-directory-under-docs/validation/blueprint/current/comfy-interactions/w2>\nCompact mode: --plan-id ${COMPACT_PLAN_ID} --report-dir <absolute-NEW-directory-under-docs/validation/blueprint/current/compact-ux/w2>\nHost controls mode: --plan-id ${HOST_CONTROLS_PLAN_ID} --report-dir <absolute-NEW-directory-under-docs/validation/blueprint/current/host-controls/w2>\nMain review/freeze/official build required before launch. Real isolated DSH boot/gateway and original Host/browser assertions; no React preview, no provider/key access. 63 Comfy cases / 122 required assertions; run the separate motion collector for its 19 cases / 78 assertions. Clipboard permission/late-result seam is disposable UI-only; OS clipboard is never read or written. Missing dependency/browser/assertion/file, subprocess failure, stale timestamps or changed fingerprint fails nonzero. No old report fallback. Original 200/300/20 and 2000ms/100ms budgets remain unchanged in the reused performance export.`)
    return
  }
  ensure(!existsSync(options.reportDir), '--report-dir already exists; use an explicit fresh directory')
  mkdirSync(dirname(options.reportDir), { recursive: true })
  ensure(reportPathAllowed(options.planId, 'comfy', options.reportDir, { physical: true }), 'report parent escapes W2 through symlink')
  mkdirSync(options.reportDir)
  const probePath = join(HERE, 'probe.mjs'), original = readFileSync(probePath, 'utf8'), adapted = adaptProbe(original)
  const driver = join(options.reportDir, 'isolated-comfy-probe.mjs'); writeFileSync(driver, adapted)
  const provenanceNow = () => ({ planId: options.planId, originalProbe: probePath, probeSha256: sha256(readFileSync(probePath)),
    adapterSha256: sha256(readFileSync(driver)), collectorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    entrySha256: sha256(readFileSync(join(HERE, 'compact-ui-entry.mjs'))), canvasJourneySha256: sha256(readFileSync(join(HERE, 'canvas-journey.mjs'))),
    keyRead: false, providerCalls: 0, performanceBudget: PERFORMANCE_BUDGET })
  const provenance = provenanceNow(); writeFileSync(join(options.reportDir, 'driver-provenance.json'), stringifyProbeEvidence(provenance))
  const fingerprint = captureEvidenceFingerprint(), invokedAt = Date.now(), env = { BP_COMFY_ARTIFACT_DIR: options.reportDir, BP_COLLECTOR_PLAN_ID: options.planId }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key]
  const command = [driver, `--plugin-dir=${PLUGIN}`, '--expect=blueprint', '--canvas-test=browser', `--report-dir=${options.reportDir}`, `--plan-id=${options.planId}`]
  const run = spawnSync(process.execPath, command, { cwd: join(ROOT, 'test/blueprint'), env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 30 * 1024 * 1024 })
  writeFileSync(join(options.reportDir, 'driver.stdout.log'), redactProbeEvidenceText(run.stdout ?? ''))
  writeFileSync(join(options.reportDir, 'driver.stderr.log'), redactProbeEvidenceText(run.stderr ?? ''))
  const fingerprintAfter = captureEvidenceFingerprint(), finishedAt = Date.now()
  let gate, report
  try {
    report = JSON.parse(readFileSync(join(options.reportDir, 'w0.2-probe-report.json'), 'utf8'))
    const persistedProvenance = JSON.parse(readFileSync(join(options.reportDir, 'driver-provenance.json'), 'utf8'))
    ensure(same(persistedProvenance, provenance), 'persisted provenance was replaced')
    gate = validateCollectorGate(report, { processResult: run, fingerprint, fingerprintAfter, provenance, expectedProvenance: provenanceNow(),
      reportDir: options.reportDir, invokedAt, finishedAt, planId: options.planId, packageRoot: PLUGIN })
  } catch (error) { gate = { ok: false, error: redactProbeEvidenceText(error.message) } }
  const passed = gate.ok === true
  writeFileSync(join(options.reportDir, 'comfy-ui-gate.json'), stringifyProbeEvidence({ planId: options.planId, wave: 'W2', passed, gate,
    command: [process.execPath, ...command], startedAt: new Date(invokedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(),
    exitCode: run.status, signal: run.signal, processError: run.error?.code ?? null, fingerprint, fingerprintAfter, provenance,
    keyRead: false, providerCalls: 0, nativeClipboardEvidence: false, reportDir: options.reportDir }))
  console.log(stringifyProbeEvidence({ passed, gate, exitCode: run.status, browserError: report?.artifacts?.browser_error ?? null, reportDir: options.reportDir }))
  process.exitCode = passed ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { console.error(redactProbeEvidenceText(error.message)); process.exitCode = 1 }
}
