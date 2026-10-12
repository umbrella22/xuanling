#!/usr/bin/env node
/** Independent W3 collector. Main alone launches after source freeze/build.
 * Motion transport fixtures prove rendering only, never provider/effects.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, isAbsolute, relative, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual as same } from 'node:util'
import { prepareCanvasFixtures as baseFixtures, fixtureEvidence } from './canvas-fixtures.mjs'
import { runCanvasJourney as baseJourney, measureCanvasPerformance, BROWSER_ASSERTIONS, PERFORMANCE_BUDGET } from './canvas-journey.mjs'
import { HOST_ASSERTIONS, validateCanvasReport } from './canvas-suite.mjs'
import { setNativeTheme } from './i18n-workspace-journey.mjs'
import { redactProbeEvidenceText, stringifyProbeEvidence } from './probe-evidence.mjs'
import { BLUEPRINT_PACKAGE, BLUEPRINT_INVOCATIONS } from '../../../integrations/deepseek-harness/xuanling-blueprint/src/typert-descriptors.ts'
import { projectRuntimeMotion } from '../../../integrations/deepseek-harness/xuanling-blueprint/src/client/runtime-motion.ts'
import { en, zh } from '../../../integrations/deepseek-harness/xuanling-blueprint/src/client/locales.ts'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
import { HOST_CONTROLS_PLAN_ID, COMPACT_PLAN_ID, reportPathAllowed, preparePublicAction, prepareRunInput, closePublicMore, setPublicNativeLocale as setNativeLocale } from './compact-ui-entry.mjs'
export { measureCanvasPerformance, PERFORMANCE_BUDGET, HOST_CONTROLS_PLAN_ID }
export const PLAN_ID = 'dsh-blueprint-comfy-interactions-v1'
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const PLUGIN = join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint')
const ensure = (ok, message) => { if (!ok) throw new Error(message) }
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const MOTION_ASSERTIONS = Object.freeze(['CM-LATEST-ORDINAL', 'CM-LATEST-TIE', 'CM-DIRECTED', 'CM-REROUTED', 'CM-ACTIVE-NODE',
  'CM-HOVER', 'CM-FOCUS', 'CM-OFF', 'CM-REDUCED', 'CM-STALE', 'CM-DISCONNECTED', 'CM-UNKNOWN', 'CM-UNKNOWN-PATH', 'CM-WAITING',
  'CM-TERMINAL', 'CM-HIDDEN', 'CM-VISIBLE', 'CM-THEMES', 'CM-ZERO'])
export const REQUIRED_ASSERTIONS = Object.freeze([...new Set([...HOST_ASSERTIONS, ...BROWSER_ASSERTIONS, ...MOTION_ASSERTIONS])])
const rootSelector = '[data-bp-canvas="root"]'
const action = (page, id) => page.locator(`[data-bp-action="${id}"]`)
const rpcPattern = method => new RegExp(`/api/blueprint/${method}(?:\\?|$)`)
const requestArgs = request => { const body = request.postDataJSON(); return body?.payload?.args?.args ?? body?.payload?.args }
function rpcValue(response) {
  ensure(response?.status === 200 && response?.body?.result?.ok === true, 'real Host RPC failed')
  return response.body.result.value
}
function confined(root, path) {
  if (!isAbsolute(path ?? '')) return false
  const rel = relative(resolve(root), resolve(path))
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../')
}
function realFile(root, path) {
  return confined(root, path) && existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && confined(realpathSync(root), realpathSync(path))
}
function freshTime(at, start, end) { const t = Date.parse(at); return typeof at === 'string' && Number.isFinite(t) && t >= start && t <= end }

export function motionDefinition(id = 'motion-ui', routed = false) {
  return { schemaVersion: 1, id, name: `Motion UI-only · ${id}`, resources: {}, graph: {
    nodes: [{ id: 'source', kind: 'input', outputs: { 'part.中文': 'string' } }, { id: 'target', kind: 'output', inputs: { value: 'string' } },
      { id: 'gate', kind: 'condition', inputs: { predicate: 'boolean' }, branches: ['yes', 'no'], condition: { inputPort: 'predicate', trueBranch: 'yes', falseBranch: 'no' } },
      { id: 'yes', kind: 'output' }, { id: 'no', kind: 'output' }],
    edges: [{ kind: 'data', from: 'source.part.中文', to: 'target.value' }, { kind: 'control', from: 'gate@yes', to: 'yes' }, { kind: 'control', from: 'gate@no', to: 'no' }],
  }, presentation: { nodes: { source: { x: 50, y: 40 }, target: { x: 440, y: 40 }, gate: { x: 50, y: 300 }, yes: { x: 440, y: 290 }, no: { x: 440, y: 550 } }, groups: [],
    ...(routed ? { edges: [{ kind: 'data', from: 'source.part.中文', to: 'target.value', points: [{ x: 330, y: 180 }, { x: 380, y: 180 }] }] } : {}) },
    metadata: { fixture: 'motion-rendering-only', providerEvidence: false } }
}
export function prepareCanvasFixtures(tempRoot, decode, validate) {
  const fixtures = baseFixtures(tempRoot, decode, validate)
  for (const definition of [motionDefinition(), motionDefinition('motion-routed', true)]) {
    validate(decode(JSON.stringify(definition)))
    const dir = join(tempRoot, 'blueprints', definition.id); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'blueprint.json'), JSON.stringify(definition)); fixtures.config.blueprints[definition.id] = dir
    fixtures.evidence.push({ ...fixtureEvidence(definition), generator: 'comfy-motion-ui.mjs:motionDefinition', providerEvidence: false })
  }
  return fixtures
}
export function motionSnapshot(host, mode = 'active', seq = 1) {
  const attempt = (nodeId, state, ordinal = 1, extra = {}) => ({ nodeId, state, attempt: ordinal, attemptId: `ui-only-${nodeId}-${ordinal}-${state}`, ...extra })
  const raw = { runId: `ui-only-${host.blueprintId}`, definitionRevision: host.semanticRevision, seq, state: 'running', logTail: [],
    attempts: [attempt('source', 'succeeded'), attempt('target', 'running'), attempt('gate', 'succeeded', 1, { outputJson: '{"value":true}' }), attempt('yes', 'preparing'), attempt('no', 'ready')] }
  if (mode === 'ordinal') raw.attempts.splice(1, 1, attempt('target', 'waiting_input', 2), attempt('target', 'running', 1))
  if (mode === 'tie') raw.attempts.splice(1, 1, attempt('target', 'running', 2), attempt('target', 'failed', 2))
  if (mode === 'stale') raw.definitionRevision = 'ui-only-unmatched-semantic-revision'
  if (mode === 'unknown') { raw.state = 'ui-only-future-run'; raw.attempts[1].state = 'ui-only-future-attempt' }
  if (mode === 'unknown-path') delete raw.attempts.find(item => item.nodeId === 'gate').outputJson
  if (mode === 'waiting') { raw.state = 'waiting_input'; raw.attempts[1].state = 'waiting_input' }
  if (mode === 'terminal') { raw.state = 'succeeded'; for (const a of raw.attempts) a.state = 'succeeded' }
  return BLUEPRINT_INVOCATIONS.find(item => item.method === 'inspectRun').result.create().parse(raw)
}

/** Own a raw browser process/profile; never use a user's browser or context. */
export async function launchOwnedEdge(pw, env, tempRoot) {
  const executable = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ensure(process.platform === 'darwin' && existsSync(executable), 'required native Edge executable unavailable')
  const profile = mkdtempSync(join(tempRoot, 'motion-edge-'))
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--password-store=basic', '--use-mock-keychain', 'about:blank']
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.resume()
  const evidence = { kind: 'owned native Edge CDP', executable, args, profile, pid: child.pid, noDefaults: true, defaultContext: true, closed: false, profileRemoved: false }
  let browser, closed = false
  const onExit = () => { if (!closed && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  const onSignal = () => { void close().catch(error => console.error(error.message)).finally(() => process.exit(143)) }
  process.once('exit', onExit)
  const close = async () => {
    if (closed) return
    try { await browser?.close() }
    finally {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await new Promise((done, reject) => {
          const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned Edge did not close within original 15s budget')) }, 15000)
          child.once('exit', () => { clearTimeout(timer); done() })
        })
      }
      closed = true; process.removeListener('exit', onExit)
      process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal)
      evidence.closed = true; rmSync(profile, { recursive: true, force: true }); evidence.profileRemoved = !existsSync(profile)
    }
  }
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal)
  try {
    const endpoint = await new Promise((done, reject) => {
      let stderr = ''
      const timer = setTimeout(() => reject(new Error('native Edge CDP endpoint unavailable within original 15s budget')), 15000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`native Edge exited before attach: ${code}`)) })
      child.stderr.on('data', chunk => { stderr += chunk; const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); done(match[1]) } })
    })
    browser = await pw.chromium.connectOverCDP(endpoint, { noDefaults: true })
    const contexts = browser.contexts(); ensure(contexts.length === 1, 'owned native default context missing/ambiguous')
    return { browser, context: contexts[0], evidence, close }
  } catch (error) { try { await close() } catch (cleanupError) { error.cleanupError = cleanupError.message }; throw error }
}
function replaceOnce(source, before, after) { ensure(source.split(before).length === 2, `probe adapter anchor absent/ambiguous: ${before}`); return source.replace(before, after) }
/** Passive initial-navigation evidence; URL queries/credentials never enter receipts. */
export function observeNavigation(page, artifactDir) {
  const locator = value => { try { const u = new URL(value); return u.origin === 'null' ? u.pathname : u.origin + u.pathname } catch { return '<invalid-url>' } }
  const text = value => redactProbeEvidenceText(String(value)).replace(/(?:https?|wss?):\/\/[^\s"'<>`]+/gi, locator)
    .split('\n').map(line => /authorization|headers?\s*[:=]|(?:token|authToken|api[_-]?key|password)\s*[:=]/i.test(line) ? '<credential/header diagnostic omitted>' : line).join('\n')
  const startedAt = Date.now(), timeline = [], active = new Map(), pageErrors = [], consoleErrors = [], handlers = []
  const at = () => Date.now() - startedAt
  const on = (event, fn) => { page.on(event, fn); handlers.push([event, fn]) }
  on('request', request => { const entry = { phase: 'request', atMs: at(), url: locator(request.url()), resourceType: request.resourceType() }; active.set(request, entry); timeline.push(entry) })
  for (const [event, phase] of [['requestfinished', 'finished'], ['requestfailed', 'failed']]) on(event, request => {
    timeline.push({ phase, atMs: at(), url: locator(request.url()), resourceType: request.resourceType(),
      ...(phase === 'failed' ? { error: text(request.failure()?.errorText ?? '') } : {}) }); active.delete(request)
  })
  on('pageerror', error => pageErrors.push({ atMs: at(), error: text(error.message) }))
  on('console', msg => { if (msg.type() === 'error') consoleErrors.push({ atMs: at(), error: text(msg.text()) }) })
  return {
    stop: () => { for (const [event, fn] of handlers) page.off(event, fn) },
    failed: async error => {
      const now = at(), facts = { phase: 'initial-goto-networkidle', at: new Date().toISOString(), error: text(error.message), stack: text(error.stack),
        url: locator(page.url()), timeline: [...timeline], activeRequests: [...active.values()].map(entry => ({ ...entry, ageMs: now - entry.atMs })),
        pageErrors: [...pageErrors], consoleErrors: [...consoleErrors], diagnosticErrors: [] }
      const persist = () => writeFileSync(join(artifactDir, 'initial-navigation-diagnostic.json'), stringifyProbeEvidence(facts))
      persist()
      let domTimer
      try { facts.dom = await Promise.race([
        page.evaluate(() => ({ readyState: document.readyState, title: document.title, visibility: document.visibilityState,
          hidden: document.hidden, body: document.body?.innerText?.slice(0, 1200) ?? '' })),
        new Promise((_, reject) => { domTimer = setTimeout(() => reject(Object.assign(new Error('diagnostic DOM read exceeded 15000ms'), { code: 'NAVIGATION_DOM_TIMEOUT' })), 15000) })
      ]); facts.dom.title = text(facts.dom.title ?? ''); facts.dom.body = text(facts.dom.body ?? '') }
      catch (diagnosticError) { facts.diagnosticErrors.push({ phase: 'dom', error: text(diagnosticError.message),
        ...(diagnosticError.code === 'NAVIGATION_DOM_TIMEOUT' ? { timedOut: true, timeoutMs: 15000 } : {}) }) }
      finally { clearTimeout(domTimer) }
      persist()
      const screenshot = join(artifactDir, 'initial-navigation-failure.png')
      try { await page.screenshot({ path: screenshot, fullPage: false, timeout: 15000 }); facts.screenshot = screenshot; facts.screenshotSha256 = sha256(readFileSync(screenshot)) }
      catch (diagnosticError) { facts.diagnosticErrors.push({ phase: 'screenshot', error: text(diagnosticError.message) }) }
      persist()
      return facts
    }
  }
}
export function adaptProbe(original) {
  const self = pathToFileURL(fileURLToPath(import.meta.url)).href
  let source = original.replace(/from '\.\/([^']+\.mjs)'/g, (_, name) => `from '${pathToFileURL(join(HERE, name)).href}'`)
    .replace(/import\('\.\/([^']+\.mjs)'\)/g, (_, name) => `import('${pathToFileURL(join(HERE, name)).href}')`)
  source = replaceOnce(source, 'const HERE = dirname(fileURLToPath(import.meta.url))', `const HERE = ${JSON.stringify(HERE)}`)
  source = replaceOnce(source, pathToFileURL(join(HERE, 'canvas-fixtures.mjs')).href, self)
  source = replaceOnce(source, pathToFileURL(join(HERE, 'canvas-journey.mjs')).href, self)
  source = replaceOnce(source, "const pw = await import('playwright')", `const pw = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'test/blueprint/node_modules/playwright/index.mjs')).href)})`)
  source = replaceOnce(source, 'let browserTried = false', `let browserTried = false\n  let ownedEdge`)
  source = replaceOnce(source, "const browser = await pw.chromium.launch({ channel: 'msedge', headless: true, env: ISOLATED_ENV(home) })", `const { launchOwnedEdge, observeNavigation } = await import(${JSON.stringify(self)})\n    ownedEdge = await launchOwnedEdge(pw, ISOLATED_ENV(home), tempRoot)\n    const browser = ownedEdge.browser`)
  source = replaceOnce(source, "const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })", `const page = await ownedEdge.context.newPage()\n    await page.setViewportSize({ width: 1600, height: 1000 })\n    await page.emulateMedia({ reducedMotion: 'reduce' })`)
  source = replaceOnce(source, "await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60_000 })", `const navigation = observeNavigation(page, process.env.BP_MOTION_ARTIFACT_DIR)\n    try { await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 60_000 }) }\n    catch (error) {\n      try { report.artifacts.motion_navigation = await navigation.failed(error) }\n      catch { report.artifacts.motion_navigation = { diagnosticWriteFailed: true } }\n      throw error\n    } finally { navigation.stop() }`)
  source = replaceOnce(source, 'await browser.close()', 'await ownedEdge.close()')
  source = replaceOnce(source, "\n  boot.kill('SIGTERM')", `\n  try { await ownedEdge?.close() } catch (error) { assert('CM-CLEANUP', 'owned native browser cleanup completes', false, String(error)) }\n  report.artifacts.motion_browser = ownedEdge?.evidence ?? null\n  boot.kill('SIGTERM')`)
  return source
}

/** Passive public DOM reader. No Flow store, geometry writes or synthetic events. */
export function motionDomProbe() {
  const root = document.querySelector('[data-bp-canvas="root"]')
  if (!root) throw new Error('mounted motion root absent')
  const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
  const nodes = Array.from(root.querySelectorAll('[data-bp-node]')).map(el => ({ id: el.getAttribute('data-bp-node'), state: el.getAttribute('data-bp-raw-state'),
    motion: el.getAttribute('data-bp-motion'), relation: el.getAttribute('data-bp-relation'), caption: el.querySelector('[data-bp-node-state]')?.textContent,
    opacity: el.querySelector('.bp-node-emphasis') ? Number(getComputedStyle(el.querySelector('.bp-node-emphasis')).opacity) : null }))
  const edges = Array.from(root.querySelectorAll('.react-flow__edge')).map(group => {
    const marked = group.querySelector('g[data-bp-edge]')
    const path = group.querySelector('.react-flow__edge-path')
    if (!path || !marked) throw new Error('public edge motion/path identity absent')
    const length = path.getTotalLength(), matrix = path.getScreenCTM()
    if (!matrix || length <= 0) throw new Error('rendered edge path not measurable')
    const map = point => { const p = new DOMPoint(point.x, point.y).matrixTransform(matrix); return { x: p.x, y: p.y } }
    const light = group.querySelector('path.bp-directed-light'), dashOffset = light ? Number.parseFloat(getComputedStyle(light).strokeDashoffset) : null
    return { id: marked.getAttribute('data-bp-edge'), motion: marked.getAttribute('data-bp-motion'), related: marked.getAttribute('data-bp-related'),
      d: path.getAttribute('d'), lightD: light?.getAttribute('d') ?? null, dashOffset: light ? Number.parseFloat(getComputedStyle(light).strokeDashoffset) : null,
      pathLength: light ? Number(light.getAttribute('pathLength')) : null, dashArray: light?.getAttribute('stroke-dasharray') ?? null,
      phase: light ? -(dashOffset % 1) : null,
      length, start: map(path.getPointAtLength(0)), end: map(path.getPointAtLength(length)) }
  })
  const handles = Array.from(root.querySelectorAll('[data-bp-port]')).map(el => ({ id: el.getAttribute('data-bp-port'), direction: el.classList.contains('source') ? 'out' : 'in', position: el.getAttribute('data-handlepos'), rect: rect(el) }))
  const geometry = { nodes: Array.from(root.querySelectorAll('.react-flow__node')).map(el => ({ id: el.getAttribute('data-id'), rect: rect(el) })), handles,
    viewport: root.querySelector('.react-flow__viewport')?.getAttribute('style') }
  const animations = document.getAnimations().filter(a => a.effect?.target?.closest?.('[data-bp-node],.react-flow__edge') && a.effect.getComputedTiming().iterations === Infinity).map(a => {
    const target = a.effect.target, timing = a.effect.getComputedTiming()
    return { nodeId: target.closest('[data-bp-node]')?.getAttribute('data-bp-node') ?? null,
      edgeId: target.closest('g[data-bp-edge]')?.getAttribute('data-bp-edge') ?? null,
      name: a.animationName ?? a.id, currentTime: a.currentTime, playState: a.playState, duration: timing.duration, iterations: 'Infinity', direction: a.effect.getTiming().direction,
      progress: timing.progress, keyframes: a.effect.getKeyframes().map(frame => ({ offset: frame.computedOffset, opacity: frame.opacity ?? null, strokeDashoffset: frame.strokeDashoffset ?? null })) }
  })
  return { id: root.getAttribute('data-bp-blueprint'), visible: root.getAttribute('data-bp-motion-visible'), reduced: root.getAttribute('data-bp-motion-reduced'), loops: root.getAttribute('data-bp-motion-loops'),
    runId: root.querySelector('[data-bp-run]')?.textContent?.split(' · ')[0].trim(),
    hoveredNodeId: root.querySelector('[data-bp-node]:hover')?.getAttribute('data-bp-node') ?? null,
    focusedNodeId: document.activeElement?.closest('.react-flow__node')?.querySelector('[data-bp-node]')?.getAttribute('data-bp-node') ?? null,
    userMotion: root.getAttribute('data-bp-motion'), overlayEligible: root.querySelector('[data-bp-canvas="surface"]')?.getAttribute('data-bp-overlay') === 'eligible',
    connection: root.querySelector('[data-bp-connection]')?.getAttribute('data-bp-connection'), actualHidden: document.hidden, visibilityState: document.visibilityState,
    actualReduced: matchMedia('(prefers-reduced-motion: reduce)').matches, timeline: document.timeline.currentTime,
    history: { undo: !root.querySelector('[data-bp-action="undo"]')?.disabled, redo: !root.querySelector('[data-bp-action="redo"]')?.disabled, dirty: root.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty') },
    nodes, edges, geometry, animations, runningLoops: animations.filter(a => a.playState === 'running').length,
    events: structuredClone(window.__bpMotionEvents ?? []) }
}
function projection(facts, dom) {
  const definition = facts.before.definition
  return projectRuntimeMotion({ nodes: definition.graph.nodes, edges: definition.graph.edges, snapshot: facts.raw,
    overlayEligible: dom.overlayEligible, connectionState: dom.connection, visible: !dom.actualHidden, reducedMotion: dom.actualReduced, userMotion: dom.userMotion,
    hoveredNodeId: dom.hoveredNodeId, focusedNodeId: dom.focusedNodeId })
}
function renderedProjection(facts, dom) {
  const expected = projection(facts, dom), dictionary = facts.locale === 'zh' ? zh : en
  ensure(dom.id === facts.before.host.blueprintId && dom.visible === String(!dom.actualHidden) && dom.reduced === String(dom.actualReduced)
    && dom.loops === String(expected.loopsAllowed) && dom.runId === facts.raw.runId && ['on', 'off'].includes(dom.userMotion)
    && ['connected', 'stale', 'reconnecting'].includes(dom.connection) && dom.overlayEligible === (facts.raw.definitionRevision === facts.before.host.semanticRevision), 'motion environment/projection mismatch')
  ensure(Array.isArray(dom.animations) && dom.runningLoops === dom.animations.filter(a => a.playState === 'running').length, 'actual running animation count mismatch')
  ensure(dom.nodes.length === expected.nodes.length && dom.edges.length === expected.edges.length, 'motion node/edge count mismatch')
  for (const node of expected.nodes) {
    const actual = dom.nodes.find(n => n.id === node.nodeId)
    const caption = node.state === 'idle' ? dictionary['node.notRunning'] : node.state === 'unknown' ? dictionary['node.unknownState'] : dictionary[`state.${node.state}`]
    ensure(caption && actual?.state === node.state && actual.motion === node.motion && actual.relation === node.relation && actual.caption === caption
      && (node.motion === 'pulse' ? Number.isFinite(actual.opacity) : actual.opacity === null), `raw latest caption/motion/relation mismatch: ${node.nodeId}`)
  }
  for (const edge of expected.edges) ensure(dom.edges[edge.edgeIndex].motion === edge.motion
    && dom.edges[edge.edgeIndex].related === String(edge.related) && (edge.motion === 'pulse' ? dom.edges[edge.edgeIndex].lightD === dom.edges[edge.edgeIndex].d : dom.edges[edge.edgeIndex].lightD === null), 'logical edge motion/relation mismatch')
  if (!expected.loopsAllowed) ensure(dom.runningLoops === 0 && dom.animations.every(a => a.playState !== 'running'), 'static environment retains running animation')
  return expected
}
export function validateMotionCase(c) {
  ensure(MOTION_ASSERTIONS.includes(c?.id), 'unknown motion case')
  const f = c.facts
  ensure(f?.raw && BLUEPRINT_INVOCATIONS.find(item => item.method === 'inspectRun').result.create().safeParse(f.raw).success, 'motion raw fixture differs from actual inspectRun DTO')
  ensure(f?.before?.definition && f.before.host && f.after?.host && same(f.before.definition, f.after.definition) && same(f.before.host, f.after.host)
    && same(f.before.dom.history, f.after.dom.history) && same(f.before.dom.geometry, f.after.dom.geometry), 'motion changed whole definition/Host/history/node or handle geometry')
  ensure(f.before.host.definitionJson && same(f.before.definition, JSON.parse(f.before.host.definitionJson)), 'motion baseline differs from real saved Host definition')
  const expected = renderedProjection(f, f.after.dom)
  if (f.frames) {
    ensure(f.frames.length === 2 && f.frames[1].timeline > f.frames[0].timeline && same(f.frames[0].geometry, f.frames[1].geometry)
      && same(f.frames[0].geometry, f.after.dom.geometry), 'two actual animation frames/timeline/stable geometry required')
    for (const frame of f.frames) renderedProjection(f, frame)
    for (const edge of expected.edges.filter(e => e.motion === 'pulse')) {
      const a = f.frames[0].edges[edge.edgeIndex], b = f.frames[1].edges[edge.edgeIndex]
      const first = f.frames[0].animations.find(item => item.edgeId === a.id), last = f.frames[1].animations.find(item => item.edgeId === a.id && item.name === first?.name)
      ensure(a.id && a.id === b.id && a.d === b.d && a.lightD === a.d && b.lightD === b.d && Number.isFinite(a.dashOffset) && Number.isFinite(b.dashOffset)
        && a.dashOffset !== b.dashOffset && first?.playState === 'running' && last?.currentTime > first.currentTime && first.direction === 'normal', 'directed same-path actual dash/currentTime proof absent')
      ensure(a.pathLength === 1 && b.pathLength === 1 && a.dashArray === '0 2' && b.dashArray === '0 2' && a.phase >= 0 && a.phase < 1 && b.phase >= 0 && b.phase < 1
        && first.duration > 0 && last.duration === first.duration && first.progress >= 0 && first.progress < 1 && last.progress >= 0 && last.progress < 1, 'normalized directed light phase/timing proof absent')
      const offsets = first.keyframes.filter(frame => frame.strokeDashoffset !== null).map(frame => Number.parseFloat(frame.strokeDashoffset))
      ensure(offsets.length >= 2 && offsets.every(Number.isFinite) && offsets[0] > offsets.at(-1), 'edge light direction is not from source to target')
      const logical = f.before.definition.graph.edges[edge.edgeIndex], delim = logical.kind === 'data' ? '.' : '@'
      const from = logical.from.split(delim)[0], to = logical.to.split('.')[0]
      const fromPort = logical.kind === 'data' ? logical.from.slice(logical.from.indexOf('.') + 1) : logical.from.includes('@') ? logical.from.split('@')[1] : 'control'
      const toPort = logical.kind === 'data' ? logical.to.slice(logical.to.indexOf('.') + 1) : 'control'
      const handle = (id, direction) => f.after.dom.geometry.handles.find(h => h.id === id && h.direction === direction)
      const source = handle(`${from}:${logical.kind}:${fromPort}`, 'out'), target = handle(`${to}:${logical.kind}:${toPort}`, 'in')
      const atHandle = (point, h) => {
        if (!h?.rect) return false
        const { x, y, width, height } = h.rect
        const midpoint = ({ right: { x: x + width, y: y + height / 2 }, left: { x, y: y + height / 2 },
          top: { x: x + width / 2, y }, bottom: { x: x + width / 2, y: y + height } })[h.position]
        return midpoint && Math.hypot(point.x - midpoint.x, point.y - midpoint.y) <= 1
      }
      ensure(atHandle(a.start, source) && atHandle(a.end, target), 'edge path source/target differs from actual named handle side midpoint')
    }
    const active = expected.nodes.filter(n => n.motion === 'pulse')
    for (const node of active) {
      const first = f.frames[0].animations.find(a => a.nodeId === node.nodeId), last = f.frames[1].animations.find(a => a.nodeId === node.nodeId && a.name === first?.name)
      ensure(first?.playState === 'running' && first.duration > 0 && Number.isFinite(first.currentTime) && last?.currentTime > first.currentTime, 'active node emphasis timeline did not advance')
    }
    ensure(active.length > 0 && active.some(n => f.frames[0].nodes.find(v => v.id === n.nodeId)?.opacity !== f.frames[1].nodes.find(v => v.id === n.nodeId)?.opacity), 'active node opacity did not advance')
    if (c.id === 'CM-REROUTED') {
      const route = f.before.definition.presentation.edges?.[0], path = f.frames[0].edges[0].d
      ensure(route?.points?.length === 2 && route.from === 'source.part.中文' && route.to === 'target.value'
        && route.points.every((p, i) => path.includes(`L ${p.x} ${p.y}`) && (i === 0 || path.indexOf(`L ${route.points[i - 1].x} ${route.points[i - 1].y}`) < path.indexOf(`L ${p.x} ${p.y}`))), 'same logical edge reroute points absent/out of order')
    }
  }
  if (['CM-DIRECTED', 'CM-REROUTED', 'CM-ACTIVE-NODE', 'CM-VISIBLE'].includes(c.id)) ensure(f.frames?.length === 2 && f.screenshots?.length === 2 && f.screenshots[0].sha256 !== f.screenshots[1].sha256, 'two distinct mounted frames/screenshots missing')
  if (['CM-HOVER', 'CM-FOCUS'].includes(c.id)) {
    const type = c.id === 'CM-HOVER' ? 'pointerover' : 'focusin', anchor = c.id === 'CM-HOVER' ? f.hoveredNodeId : f.focusedNodeId
    ensure(anchor === 'source' && f.after.dom.events.some(event => event.type === type && event.nodeId === anchor && event.trusted === true), 'genuine hover/focus event absent')
    ensure(f.after.dom.nodes.find(n => n.id === anchor)?.relation === 'anchor' && f.after.dom.nodes.find(n => n.id === 'target')?.relation === 'neighbor', 'static association absent')
    ensure(f.offDom?.userMotion === 'off' && f.offDom.runningLoops === 0 && f.offDom.nodes.find(n => n.id === anchor)?.relation === 'anchor'
      && same(f.offDom.geometry, f.after.dom.geometry) && same(f.offDom.history, f.after.dom.history), 'hover/focus association depends on motion preference or changes geometry/history')
    renderedProjection(f, f.offDom)
  }
  if (['CM-HIDDEN', 'CM-VISIBLE'].includes(c.id)) {
    const hidden = c.id === 'CM-HIDDEN'
    const visibility = f.after.dom.events.filter(event => event.type === 'visibilitychange'), last = visibility.at(-1)
    ensure(f.after.dom.actualHidden === hidden && last?.state === (hidden ? 'hidden' : 'visible') && last.trusted === true
      && (hidden || visibility.slice(0, -1).some(event => event.state === 'hidden' && event.trusted)), 'real trusted hidden/visible event missing')
  }
  const dom = f.after.dom
  if (c.id === 'CM-OFF') ensure(dom.userMotion === 'off' && dom.runningLoops === 0, 'off witness absent')
  if (c.id === 'CM-REDUCED') ensure(dom.actualReduced && dom.runningLoops === 0, 'native reduced-motion witness absent')
  if (c.id === 'CM-STALE') ensure(f.raw.definitionRevision !== f.before.host.semanticRevision && !dom.overlayEligible && dom.runningLoops === 0, 'stale semantic binding witness absent')
  if (c.id === 'CM-DISCONNECTED') ensure(dom.connection === 'stale' && dom.runningLoops === 0 && dom.events.some(e => e.type === 'offline' && e.trusted), 'actual disconnect witness absent')
  if (c.id === 'CM-UNKNOWN') ensure(expected.runState === 'unknown' && dom.nodes.find(n => n.id === 'target')?.state === 'unknown' && dom.runningLoops === 0, 'unknown state fallback absent')
  if (c.id === 'CM-UNKNOWN-PATH') ensure(!Object.hasOwn(f.raw.attempts.find(a => a.nodeId === 'gate'), 'outputJson') && dom.edges[1].motion === 'static' && dom.edges[2].motion === 'static', 'unproven control branch pulses')
  if (c.id === 'CM-WAITING') ensure(f.raw.state === 'waiting_input' && dom.runningLoops === 0, 'waiting loop remains')
  if (c.id === 'CM-TERMINAL') ensure(f.raw.state === 'succeeded' && dom.runningLoops === 0, 'terminal loop remains')
  if (c.id === 'CM-LATEST-ORDINAL') ensure(f.raw.attempts.filter(a => a.nodeId === 'target').map(a => a.attempt).join(',') === '2,1' && dom.nodes.find(n => n.id === 'target')?.state === 'waiting_input', 'ordinal/latest witness absent')
  if (c.id === 'CM-LATEST-TIE') ensure(f.raw.attempts.filter(a => a.nodeId === 'target').map(a => a.attempt).join(',') === '2,2' && dom.nodes.find(n => n.id === 'target')?.state === 'failed', 'tie/latest witness absent')
  return true
}

async function idle(page) {
  if (await page.locator('[data-bp-action="more-actions"]').count()) {
    await page.waitForFunction(() => { const selector = document.querySelector('[data-bp-select="blueprint"]'); return selector && !selector.disabled })
    await closePublicMore(page)
    return
  }
  await preparePublicAction(page, 'refresh-library'); await page.waitForFunction(() => !document.querySelector('[data-bp-action="refresh-library"]')?.disabled); await closePublicMore(page)
}
async function choose(page, id) {
  await idle(page); await page.locator('[data-bp-select="blueprint"]').selectOption(id)
  await page.waitForFunction(id => document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-blueprint') === id && document.querySelectorAll('[data-bp-node]').length === 5, id)
  await idle(page)
}
export async function runCanvasJourney(page, record, api) {
  // Preserve every actual original Host/browser assertion before any UI fixture.
  const base = await baseJourney(page, record, api)
  const dir = process.env.BP_MOTION_ARTIFACT_DIR
  ensure(isAbsolute(dir ?? ''), 'fresh motion artifact directory required')
  await page.setViewportSize({ width: 1700, height: 1100 }); await setNativeLocale(page, 'en'); await page.emulateMedia({ reducedMotion: 'no-preference' })
  const receipt = { planId: process.env.BP_COLLECTOR_PLAN_ID ?? PLAN_ID, wave: 'W3', startedAt: new Date().toISOString(), keyRead: false, providerCalls: 0, providerEvidence: false, effectEvidence: false,
    fixtureScope: 'UI-only motion rendering', transport: [], rpc: [], cases: [], themes: [], requests: [] }
  let host, raw, disconnected = false, sequence = 0, primaryError
  const methodOf = request => new URL(request.url()).pathname.split('/').at(-1)
  const observe = request => { if (request.method() === 'POST' && /\/api\/blueprint\//.test(request.url())) receipt.requests.push({ method: methodOf(request), rpcId: request.postDataJSON()?.rpcId }) }
  page.on('request', observe)
  await page.evaluate(() => {
    window.__bpMotionEvents = []
    const listener = event => window.__bpMotionEvents.push({ type: event.type, trusted: event.isTrusted, state: document.visibilityState,
      nodeId: event.target?.closest?.('[data-bp-node]')?.getAttribute('data-bp-node') ?? event.target?.closest?.('.react-flow__node')?.querySelector('[data-bp-node]')?.getAttribute('data-bp-node') ?? null,
      key: event.key ?? null })
    window.__bpMotionListener = listener
    for (const type of ['visibilitychange', 'pointerover', 'focusin', 'keydown', 'pointerdown']) document.addEventListener(type, listener, { capture: true, passive: true })
    for (const type of ['offline', 'online']) window.addEventListener(type, listener, { passive: true })
  })
  const transport = async route => {
    const request = route.request(), method = methodOf(request), args = requestArgs(request), requestEnvelope = request.postDataJSON(), rpcId = requestEnvelope?.rpcId
    if (method === 'inspectRun' && !args?.runId?.startsWith('ui-only-motion-')) return route.continue()
    ensure(request.method() === 'POST' && host && raw && (method === 'startRun' ? args?.blueprintId === host.blueprintId && args.expectedRevision === host.documentRevision : args?.runId === raw.runId), 'UI-only transport fixture request/binding mismatch')
    ensure(requestEnvelope.type === 'client-request' && typeof rpcId === 'string' && rpcId.length > 0, 'UI-only transport request correlation missing')
    if (disconnected) { await route.abort('internetdisconnected'); return }
    const result = method === 'startRun' ? { runId: raw.runId, semanticRevision: host.semanticRevision, state: raw.state, replayed: false } : structuredClone(raw)
    BLUEPRINT_INVOCATIONS.find(item => item.method === method).result.create().parse(result)
    const response = { status: 200, body: { type: 'server-response', rpcId, result: { ok: true, value: result } } }
    await route.fulfill({ status: response.status, contentType: 'application/json', json: response.body })
    receipt.transport.push({ method, rpcId, args, result, response, at: new Date().toISOString(), scope: 'UI-only', providerEvidence: false, effectEvidence: false })
  }
  await page.route(rpcPattern('startRun'), transport); await page.route(rpcPattern('inspectRun'), transport)
  const read = async () => {
    const response = await api('loadDefinition', { blueprintId: host.blueprintId }), saved = rpcValue(response)
    receipt.rpc.push({ method: 'loadDefinition', blueprintId: host.blueprintId, status: response.status, ok: true, at: new Date().toISOString(), provenance: 'real DSH gateway' })
    const draft = await page.evaluate(id => localStorage.getItem(`xuanling-blueprint:draft:${encodeURIComponent(id)}`), host.blueprintId)
    return { host: saved, definition: JSON.parse(draft ? JSON.parse(draft).definitionJson : saved.definitionJson), dom: await page.evaluate(motionDomProbe) }
  }
  const screenshot = async name => { const path = join(dir, `${name}.png`); await page.screenshot({ path, fullPage: false }); return { screenshot: path, sha256: sha256(readFileSync(path)), provenance: 'actual Playwright native Edge screenshot' } }
  const frames = async id => {
    const a = await page.evaluate(motionDomProbe), first = await screenshot(`${id}-frame-1`)
    await page.waitForFunction(before => document.getAnimations().some(animation => animation.effect?.target?.closest?.('.react-flow__edge')
      && animation.effect.getComputedTiming().iterations === Infinity && animation.playState === 'running' && animation.currentTime > before + 120),
    Math.max(...a.animations.filter(animation => animation.edgeId).map(animation => animation.currentTime)))
    const b = await page.evaluate(motionDomProbe), second = await screenshot(`${id}-frame-2`)
    return { frames: [a, b], screenshots: [first, second] }
  }
  const exercise = async (id, change, extra = {}) => {
    receipt.phase = id
    const before = await read(); await change()
    const after = await read(), facts = { before, after, raw: structuredClone(raw), locale: 'en', ...extra }
    if (['CM-DIRECTED', 'CM-REROUTED', 'CM-ACTIVE-NODE', 'CM-VISIBLE'].includes(id)) Object.assign(facts, await frames(id))
    const c = { id, description: `${id}: actual mounted motion rendering, trusted environment and complete real Host/editor invariants`, at: new Date().toISOString(), facts }
    receipt.cases.push(c)
    c.passed = validateMotionCase(c)
    record(id, c.description, c.passed, 'UI-only transport; no provider/effect proof')
    writeFileSync(join(dir, 'comfy-motion-evidence.json'), stringifyProbeEvidence(receipt))
    return c
  }
  const refresh = async mode => { raw = motionSnapshot(host, mode, ++sequence); await action(page, 'retry-inspect').click(); await idle(page)
    await page.waitForFunction(state => document.querySelector('[data-bp-run]')?.getAttribute('data-bp-run') === state, raw.state) }
  const bind = async id => {
    await choose(page, id); host = rpcValue(await api('loadDefinition', { blueprintId: id })); raw = motionSnapshot(host, 'active', ++sequence)
    await prepareRunInput(page)
    await page.locator('[data-bp-run-input]').fill('{"predicate":true,"part.中文":"UI-only"}')
    await action(page, 'start-run').click(); await idle(page)
    await page.locator('[data-bp-run="running"]').waitFor({ state: 'visible' })
    ensure(same(host, (await read()).host), 'UI-only binding changed entire saved Host document')
  }
  const setMotion = async mode => { await preparePublicAction(page, 'motion-toggle'); if (await page.locator(rootSelector).getAttribute('data-bp-motion') !== mode) await action(page, 'motion-toggle').click()
    await page.waitForFunction(mode => document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-motion') === mode, mode); await closePublicMore(page) }
  const hoverSource = async () => { const b = await page.locator('[data-bp-node="source"] .bp-node-title').boundingBox(); ensure(b?.width > 0, 'source title not hit-testable'); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2) }
  const focusSource = async () => {
    await closePublicMore(page); await prepareRunInput(page)
    // Genuine unbound Shift+Tab traversal; forward Tab opens the accepted canvas search.
    if (await page.evaluate(() => document.activeElement?.closest('.react-flow__node')?.getAttribute('data-id') === 'source')) return
    for (let i = 0; i < 150; i++) { await page.keyboard.press('Shift+Tab'); if (await page.evaluate(() => document.activeElement?.closest('.react-flow__node')?.getAttribute('data-id') === 'source')) return }
    throw new Error('native Shift+Tab traversal did not focus source node')
  }
  try {
    await bind('motion-ui')
    await exercise('CM-LATEST-ORDINAL', () => refresh('ordinal')); await exercise('CM-LATEST-TIE', () => refresh('tie'))
    await exercise('CM-DIRECTED', () => refresh('active')); await exercise('CM-ACTIVE-NODE', async () => {})
    for (const [id, gesture, field] of [['CM-HOVER', hoverSource, 'hoveredNodeId'], ['CM-FOCUS', focusSource, 'focusedNodeId']]) {
      const extra = { [field]: 'source' }
      await exercise(id, async () => { await gesture(); await setMotion('off'); await gesture(); extra.offDom = await page.evaluate(motionDomProbe)
        await setMotion('on'); await gesture() }, extra)
    }
    await exercise('CM-OFF', () => setMotion('off')); await setMotion('on')
    await exercise('CM-REDUCED', async () => { await page.emulateMedia({ reducedMotion: 'reduce' }); await page.waitForFunction(() => document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-motion-reduced') === 'true') })
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await exercise('CM-STALE', () => refresh('stale')); await refresh('active')
    await exercise('CM-DISCONNECTED', async () => { disconnected = true; await page.context().setOffline(true)
      await page.locator('[data-bp-connection="stale"]').waitFor({ state: 'visible' }) })
    disconnected = false; await page.context().setOffline(false); await refresh('active')
    await exercise('CM-UNKNOWN', () => refresh('unknown')); await exercise('CM-UNKNOWN-PATH', () => refresh('unknown-path'))
    await exercise('CM-WAITING', () => refresh('waiting')); await exercise('CM-TERMINAL', () => refresh('terminal')); await refresh('active')
    const other = await page.context().newPage()
    other.setDefaultTimeout(15000)
    try {
      await other.goto(page.url(), { waitUntil: 'domcontentloaded' }); await page.bringToFront()
      await page.waitForFunction(() => !document.hidden && document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-motion-visible') === 'true')
      await exercise('CM-HIDDEN', async () => { await other.bringToFront()
        await page.waitForFunction(() => document.hidden && document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-motion-loops') === 'false', null, { polling: 100 }) })
      await exercise('CM-VISIBLE', async () => { await page.bringToFront()
        await page.waitForFunction(() => !document.hidden && document.querySelector('[data-bp-canvas="root"]')?.getAttribute('data-bp-motion-loops') === 'true') })
    } finally { await other.close(); await page.bringToFront() }
    await bind('motion-routed'); await exercise('CM-REROUTED', async () => {})
    await exercise('CM-THEMES', async () => {
      for (const locale of ['zh', 'en']) for (const scheme of ['light', 'dark']) {
        await setNativeLocale(page, locale); await setNativeTheme(page, scheme)
        const current = await read(), facts = { before: current, raw, locale }, dom = current.dom
        renderedProjection(facts, dom)
        const dimensions = await page.locator(rootSelector).evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, scheme: getComputedStyle(document.documentElement).colorScheme, overflow: document.documentElement.scrollWidth > innerWidth }))
        ensure(dimensions.scheme === scheme && dimensions.width >= 800 && dimensions.height >= 500 && !dimensions.overflow, 'native theme/layout mismatch')
        receipt.themes.push({ locale, scheme, state: current, ...dimensions, ...await screenshot(`${locale}-${scheme}`) })
      }
      await setNativeLocale(page, 'en')
    })
    await exercise('CM-ZERO', async () => { ensure(receipt.requests.filter(r => r.method === 'startRun').every(r => receipt.transport.some(t => t.method === 'startRun' && t.rpcId === r.rpcId))
      && !receipt.requests.some(r => ['hostProbe', 'toolProbe', 'mcpProbe', 'cancelRun', 'decide'].includes(r.method)), 'provider/effect capable request escaped UI-only fixture') })
    receipt.finishedAt = new Date().toISOString(); return { ...base, comfyMotion: receipt }
  } catch (error) {
    primaryError = error; receipt.failure = { phase: receipt.phase, message: error.message, stack: error.stack, url: page.url() }
    try { receipt.failure.dom = await page.evaluate(motionDomProbe); receipt.failure.screenshot = await screenshot('failure') } catch (captureError) { receipt.failure.captureError = captureError.message }
    throw error
  } finally {
    try {
      disconnected = false; await page.context().setOffline(false)
      await page.unroute(rpcPattern('startRun'), transport); await page.unroute(rpcPattern('inspectRun'), transport)
      await page.evaluate(() => { for (const type of ['visibilitychange', 'pointerover', 'focusin', 'keydown', 'pointerdown']) document.removeEventListener(type, window.__bpMotionListener, true)
        for (const type of ['offline', 'online']) window.removeEventListener(type, window.__bpMotionListener); delete window.__bpMotionListener })
    } catch (error) { receipt.cleanupError = error.message; if (!primaryError) throw error }
    finally { page.off('request', observe); writeFileSync(join(dir, 'comfy-motion-evidence.json'), stringifyProbeEvidence(receipt)) }
  }
}

function screenshotEvidence(dir, item) {
  ensure(item && realFile(dir, item.screenshot), 'motion screenshot missing/outside fresh physical report')
  const bytes = readFileSync(item.screenshot)
  ensure(bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.readUInt32BE(16) >= 800 && bytes.readUInt32BE(20) >= 500
    && item.sha256 === sha256(bytes) && item.provenance === 'actual Playwright native Edge screenshot', 'motion screenshot hash/PNG/provenance invalid')
}
export function validateMotionReport(report, context) {
  const { reportDir, invokedAt, finishedAt, packageRoot = PLUGIN, planId = PLAN_ID } = context
  ensure(Number.isFinite(invokedAt) && Number.isFinite(finishedAt) && finishedAt >= invokedAt, 'motion invocation timestamps missing/invalid')
  ensure(reportPathAllowed(planId, 'motion', reportDir, { physical: true }) && existsSync(reportDir), 'fresh W3/W4 physical report confinement required')
  ensure(realFile(reportDir, report?.artifacts?.sidebar_screenshot) && realFile(reportDir, report?.artifacts?.host_tools_contract?.reportPath)
    && realFile(join(reportDir, 'tools'), report?.artifacts?.host_tools_contract?.reportPath), 'original screenshot/nested tools physical confinement missing')
  const original = validateCanvasReport(report, { mode: 'browser', planId, reportDir, packageRoot, invokedAt, finishedAt })
  const { environment: env, artifacts: artifacts } = report, receipt = artifacts.canvas_journey.comfyMotion
  ensure(env.dsh_version_output === '0.2.1-alpha.1' && /^v\d+\./.test(env.node ?? '') && env.browser_version && env.platform === 'darwin/arm64'
    && isAbsolute(env.temp_root ?? '') && /(?:^|\/)xuanling-bp-probe-[^/]+$/.test(env.temp_root), 'real isolated DSH/browser environment provenance absent')
  ensure(artifacts.auth_cookie_set === true && artifacts.index_has_boot === true && artifacts.client_bundle?.status === 200 && artifacts.client_bundle.closure === true
    && artifacts.boot_entries?.some(entry => entry.id === BLUEPRINT_PACKAGE) && !artifacts.browser_error, 'actual authenticated boot identity/closure missing or browser failed')
  const native = artifacts.motion_browser
  ensure(native?.kind === 'owned native Edge CDP' && native.noDefaults === true && native.defaultContext === true && native.closed === true && native.profileRemoved === true
    && Number.isSafeInteger(native.pid) && native.pid > 0 && confined(env.temp_root, native.profile) && native.args?.includes(`--user-data-dir=${native.profile}`)
    && native.args.includes('--headless=new') && native.args.includes('--remote-debugging-port=0'), 'owned native default-context browser/cleanup provenance missing')
  ensure(receipt?.planId === planId && receipt.wave === 'W3' && receipt.keyRead === false && receipt.providerCalls === 0 && receipt.providerEvidence === false
    && receipt.effectEvidence === false && receipt.fixtureScope === 'UI-only motion rendering' && !receipt.failure && !receipt.cleanupError, 'motion fixture isolation/effect labels invalid or journey failed')
  const start = Date.parse(receipt.startedAt), end = Date.parse(receipt.finishedAt)
  ensure(freshTime(receipt.startedAt, Date.parse(report.started_at), Date.parse(report.finished_at)) && freshTime(receipt.finishedAt, start, Date.parse(report.finished_at)), 'motion timestamps missing/stale')
  ensure(receipt.cases?.length === MOTION_ASSERTIONS.length && new Set(receipt.cases.map(c => c.id)).size === MOTION_ASSERTIONS.length, 'motion cases missing/duplicate')
  for (const c of receipt.cases) {
    ensure(c.passed === true && freshTime(c.at, start, end) && typeof c.description === 'string' && c.description.length > 0
      && report.assertions.some(a => a.id === c.id && a.passed && a.description === c.description), 'motion case failure/timestamp/assertion mismatch')
    validateMotionCase(c)
    for (const image of c.facts.screenshots ?? []) screenshotEvidence(reportDir, image)
  }
  for (const id of REQUIRED_ASSERTIONS) ensure(report.assertions.some(a => a.id === id && a.passed), `required assertion missing: ${id}`)
  ensure(receipt.transport?.length > 0 && receipt.transport.every(t => ['startRun', 'inspectRun'].includes(t.method) && t.scope === 'UI-only' && t.providerEvidence === false && t.effectEvidence === false
    && freshTime(t.at, start, end) && typeof t.rpcId === 'string' && t.rpcId.length > 0 && BLUEPRINT_INVOCATIONS.find(item => item.method === t.method).result.create().safeParse(t.result).success
    && t.response?.status === 200 && t.response.body?.type === 'server-response' && t.response.body.rpcId === t.rpcId
    && t.response.body.result?.ok === true && same(t.response.body.result.value, t.result)
    && receipt.requests?.some(r => r.method === t.method && r.rpcId === t.rpcId)), 'UI-only start/inspect transport evidence/envelope/correlation missing/mislabeled')
  ensure(receipt.transport.some(t => t.method === 'startRun') && receipt.transport.some(t => t.method === 'inspectRun') && receipt.requests?.filter(r => r.method === 'startRun').every(r => receipt.transport.some(t => t.method === 'startRun' && t.rpcId === r.rpcId))
    && !receipt.requests.some(r => ['hostProbe', 'toolProbe', 'mcpProbe', 'cancelRun', 'decide'].includes(r.method)), 'provider/effect request bypassed motion fixture')
  ensure(receipt.rpc?.length > 0 && receipt.rpc.every(r => r.method === 'loadDefinition' && r.provenance === 'real DSH gateway' && r.status === 200 && r.ok === true && freshTime(r.at, start, end)), 'real Host invariant reads missing/mislabeled')
  ensure(receipt.themes?.length === 4 && new Set(receipt.themes.map(t => `${t.locale}/${t.scheme}`)).size === 4, 'four native motion themes missing/duplicate')
  for (const theme of receipt.themes) {
    ensure(['zh', 'en'].includes(theme.locale) && ['light', 'dark'].includes(theme.scheme) && theme.width >= 800 && theme.height >= 500 && theme.overflow === false, 'native motion theme/layout invalid')
    const baseline = receipt.cases.find(c => c.id === 'CM-THEMES').facts
    ensure(same(theme.state?.definition, baseline.before.definition) && same(theme.state?.host, baseline.before.host) && same(theme.state?.dom?.history, baseline.before.dom.history), 'native theme changed full definition/Host/history')
    renderedProjection({ before: theme.state, raw: baseline.raw, locale: theme.locale }, theme.state.dom)
    screenshotEvidence(reportDir, theme)
  }
  return { ok: true, original, mountedCases: receipt.cases.length, assertions: report.assertions.length, providerEvidence: false, effectEvidence: false }
}
export function validateCollectorGate(report, context) {
  const { processResult, fingerprint, fingerprintAfter, provenance, expectedProvenance } = context
  ensure(processResult?.status === 0 && !processResult.error && !processResult.signal, 'motion probe subprocess failed/unavailable')
  const validFingerprint = f => /^[a-f0-9]{40}$/.test(f?.revision ?? '') && /^[a-f0-9]{64}$/.test(f?.source_sha256 ?? '') && /^[a-f0-9]{64}$/.test(f?.artifact_sha256 ?? '')
  ensure(validFingerprint(fingerprint) && validFingerprint(fingerprintAfter) && same(fingerprint, fingerprintAfter), 'motion source/artifact fingerprint changed/missing')
  ensure(provenance && expectedProvenance && same(provenance, expectedProvenance) && ['probeSha256', 'adapterSha256', 'collectorSha256'].every(key => /^[a-f0-9]{64}$/.test(provenance[key] ?? ''))
    && provenance.planId === (context.planId ?? PLAN_ID) && provenance.keyRead === false && provenance.providerCalls === 0 && same(provenance.performanceBudget, PERFORMANCE_BUDGET), 'motion adapter/probe/collector provenance or original budgets changed/missing')
  if ([COMPACT_PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(context.planId)) for (const key of ['entrySha256', 'canvasJourneySha256']) ensure(/^[a-f0-9]{64}$/.test(provenance[key] ?? ''), `compact provenance ${key} missing`)
  return validateMotionReport(report, context)
}
export function parseCli(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const [flag, ...tail] = args[i].split('='), val = tail.length ? tail.join('=') : args[++i]
    ensure(['--plan-id', '--report-dir'].includes(flag) && options[flag] === undefined, 'unknown/duplicate CLI option')
    ensure(typeof val === 'string' && val.trim() === val && val.length > 0 && !/[\x00-\x1f\x7f]/.test(val) && !val.startsWith('--'), 'CLI value required')
    options[flag] = val
  }
  const reportDir = options['--report-dir']
  const planId = options['--plan-id']
  ensure([PLAN_ID, COMPACT_PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(planId), 'explicit frozen plan ID required')
  ensure(reportDir === resolve(reportDir ?? '.') && reportPathAllowed(planId, 'motion', reportDir), 'explicit new absolute W3/W4 or compact W2 report directory required')
  return { planId, reportDir }
}
async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    console.log(`node --experimental-transform-types ${join(HERE, 'comfy-motion-ui.mjs')} --plan-id ${PLAN_ID} --report-dir <absolute-NEW-directory-under-docs/validation/blueprint/current/comfy-interactions/w3-or-w4>\nCompact mode: --plan-id ${COMPACT_PLAN_ID} --report-dir <absolute-NEW-directory-under-docs/validation/blueprint/current/compact-ux/w2>\nHost controls mode: --plan-id ${HOST_CONTROLS_PLAN_ID} --report-dir <absolute-NEW-directory-under-docs/validation/blueprint/current/host-controls/w2>\nMain review/freeze/build required. Actual isolated DSH probe/Host/browser; native owned Edge CDP public noDefaults/default context. Motion start/inspect transport fixtures are UI-only, never provider/effect proof. No keys/default profiles. Original 200/300/20 performance export and budgets preserved.`)
    return
  }
  ensure(!existsSync(options.reportDir), 'report directory exists; explicit fresh directory required')
  mkdirSync(dirname(options.reportDir), { recursive: true })
  ensure(reportPathAllowed(options.planId, 'motion', options.reportDir, { physical: true }), 'report parent escapes W3/W4 physically')
  mkdirSync(options.reportDir)
  const probe = join(HERE, 'probe.mjs'), driver = join(options.reportDir, 'isolated-motion-probe.mjs')
  writeFileSync(driver, adaptProbe(readFileSync(probe, 'utf8')))
  const currentProvenance = () => ({ planId: options.planId, probeSha256: sha256(readFileSync(probe)), adapterSha256: sha256(readFileSync(driver)), collectorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    entrySha256: sha256(readFileSync(join(HERE, 'compact-ui-entry.mjs'))), canvasJourneySha256: sha256(readFileSync(join(HERE, 'canvas-journey.mjs'))),
    keyRead: false, providerCalls: 0, performanceBudget: PERFORMANCE_BUDGET })
  const provenance = currentProvenance(), fingerprint = captureEvidenceFingerprint(), invokedAt = Date.now()
  writeFileSync(join(options.reportDir, 'driver-provenance.json'), stringifyProbeEvidence(provenance))
  const env = { BP_MOTION_ARTIFACT_DIR: options.reportDir, BP_COLLECTOR_PLAN_ID: options.planId }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key]
  const command = [driver, `--plugin-dir=${PLUGIN}`, '--expect=blueprint', '--canvas-test=browser', `--report-dir=${options.reportDir}`, `--plan-id=${options.planId}`]
  const run = spawnSync(process.execPath, command, { cwd: join(ROOT, 'test/blueprint'), env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 30 * 1024 * 1024 })
  writeFileSync(join(options.reportDir, 'driver.stdout.log'), redactProbeEvidenceText(run.stdout ?? '')); writeFileSync(join(options.reportDir, 'driver.stderr.log'), redactProbeEvidenceText(run.stderr ?? ''))
  const fingerprintAfter = captureEvidenceFingerprint(), finishedAt = Date.now()
  let gate
  try {
    ensure(same(JSON.parse(readFileSync(join(options.reportDir, 'driver-provenance.json'), 'utf8')), provenance), 'persisted motion provenance changed')
    const report = JSON.parse(readFileSync(join(options.reportDir, 'w0.2-probe-report.json'), 'utf8'))
    gate = validateCollectorGate(report, { processResult: run, fingerprint, fingerprintAfter, provenance, expectedProvenance: currentProvenance(), planId: options.planId, reportDir: options.reportDir, invokedAt, finishedAt })
  } catch (error) { gate = { ok: false, error: redactProbeEvidenceText(error.message) } }
  writeFileSync(join(options.reportDir, 'comfy-motion-gate.json'), stringifyProbeEvidence({ planId: options.planId, passed: gate.ok === true, gate,
    command: [process.execPath, ...command], startedAt: new Date(invokedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(), exitCode: run.status, signal: run.signal, processError: run.error?.code ?? null,
    fingerprint, fingerprintAfter, provenance, keyRead: false, providerCalls: 0, providerEvidence: false, effectEvidence: false, reportDir: options.reportDir }))
  console.log(stringifyProbeEvidence({ passed: gate.ok === true, gate, reportDir: options.reportDir })); process.exitCode = gate.ok === true ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
