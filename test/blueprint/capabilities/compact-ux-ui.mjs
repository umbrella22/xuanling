#!/usr/bin/env node
import { supportsDshVersion } from './dsh-version.mjs'
/** Independent mounted compact UX collector. Only main launches after build,
 * review and freeze. Synthetic validator inputs never prove native behavior. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual as same } from 'node:util'
import { runCanvasJourney as originalJourney, measureCanvasPerformance, PERFORMANCE_BUDGET } from './canvas-journey.mjs'
import { requiredCanvasAssertions, validateCanvasReport } from './canvas-suite.mjs'
import { prepareCanvasFixtures, viewportCssProbe, viewportStateOracle } from './comfy-interactions-ui.mjs'
import { adaptProbe as motionAdapter, launchOwnedEdge, observeNavigation } from './comfy-motion-ui.mjs'
import { setNativeTheme } from './i18n-workspace-journey.mjs'
import { HOST_CONTROLS_PLAN_ID, COMPACT_PLAN_ID, reportPathAllowed, preparePublicAction, openPublicSubmenu, preparePublicDisclosure,
  setPublicDisclosure, closePublicMore, prepareRunInput, setPublicNativeLocale, MORE_ACTION_GROUPS, OBJECT_COMMAND_GROUPS } from './compact-ui-entry.mjs'
import { stringifyProbeEvidence, redactProbeEvidenceText } from './probe-evidence.mjs'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
import { BLUEPRINT_PACKAGE, BLUEPRINT_INVOCATIONS } from '../../../integrations/deepseek-harness/xuanling-blueprint/src/typert-descriptors.ts'
import { BUILTIN_NODE_CATALOG } from '../../../integrations/deepseek-harness/xuanling-blueprint/src/client/features/authoring/logic/graph/node-catalog.ts'
export { prepareCanvasFixtures, measureCanvasPerformance, launchOwnedEdge, observeNavigation, PERFORMANCE_BUDGET }
export const PLAN_ID = COMPACT_PLAN_ID
export { HOST_CONTROLS_PLAN_ID }
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../../..')
const PLUGIN = join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint')
const ensure = (ok, why) => { if (!ok) throw new Error(why) }
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const UX_CASES = Object.freeze([
  ['UX-ICONS', 'Public high frequency buttons have local SVG, accessible names and 40px targets'],
  ['UX-TOOLTIP', 'Trusted hover and focus expose readable tooltip name and shortcut'],
  ['UX-DISABLED', 'Disabled public actions retain ARIA and a readable reason without execution'],
  ['UX-BLUEPRINT', 'Exactly one visible configured blueprint selector remains in the top toolbar; side handles are available and library/inspector remain mounted'],
  ['UX-MORE', 'Files view and tools public submenus expose every original low frequency action'],
  ['UX-MENU', 'Node appearance and multi-selection layout submenus open through public pointer inputs'],
  ['UX-FOCUS', 'Public menu Right Left Escape and bounded navigation restore actual initiator focus'],
  ['UX-BOUNDARY', 'Open object menu and submenu stay inside actual workspace bounds'],
  ['UX-PALETTE', 'Supported palette entries retain visible names and readable hover or focus descriptions'],
  ['UX-DISCLOSURE', 'Native summaries fold and reveal retained preflight and run children'],
  ['UX-RETENTION', 'Folding preserves full definition Host input selection Run history dirty draft and exact public viewport'],
  ['UX-RETENTION-WAITING', 'Waiting Run binding and complete durable snapshot survive folding'],
  ['UX-TOP-ROW', 'At 1700px every top control is on one row with 40px targets and no clipping'],
  ['UX-THEMES', 'Four actual native locale and theme screenshots retain complete state'],
  ['UX-NARROW', 'At 1100px actual chrome and open menus fit without page overflow'],
  ['UX-ZERO-PROVIDER', 'Isolated collector never reads keys or dispatches provider requests'],
].map(([id, description]) => Object.freeze({ id, description })))
export const HOST_CONTROL_CASES = Object.freeze([
  { id: 'HC-STYLE', description: 'Four native themes compare actual form/select/button/icon style and host sidebar layout to host tokens with complete retention' },
  { id: 'HC-FOCUS', description: 'Four native themes retain keyboard focus, neutral/primary feedback and disabled nonactivation with trusted input and complete state' },
].map(Object.freeze))
export const casesForPlan = planId => {
  ensure([PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(planId), 'explicit compact/host-controls plan required')
  return planId === HOST_CONTROLS_PLAN_ID ? [...UX_CASES, ...HOST_CONTROL_CASES] : UX_CASES
}
export const UX_ASSERTIONS = Object.freeze(UX_CASES.map(c => c.id))
export const PALETTE_KINDS = Object.freeze(BUILTIN_NODE_CATALOG.map(node => node.kind))
export const REQUIRED_ASSERTIONS = Object.freeze([...requiredCanvasAssertions('browser'), ...UX_ASSERTIONS])
const topActions = Object.freeze(['undo', 'redo', 'save-layout', 'mode-pan', 'mode-select', 'start-run', 'more-actions'])
const action = (page, id) => page.locator(`[data-bp-action="${id}"]`)
const root = page => page.locator('[data-bp-canvas="root"]')
const fresh = (at, start, end) => typeof at === 'string' && Number.isFinite(Date.parse(at)) && Date.parse(at) >= start && Date.parse(at) <= end
const inside = (dir, path) => { if (!isAbsolute(path ?? '')) return false; const rel = relative(dir, resolve(path)); return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) }
const fileInside = (dir, path) => inside(dir, path) && existsSync(path) && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && inside(realpathSync(dir), realpathSync(path))
const rectValid = r => r && ['left', 'right', 'top', 'bottom', 'width', 'height'].every(key => Number.isFinite(r[key])) && r.width > 0 && r.height > 0
const within = (r, bounds) => rectValid(r) && rectValid(bounds) && r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom
const text = value => typeof value === 'string' && value.trim().length > 0
export function validateRetentionState(state) {
  ensure(state?.definition?.graph && state.host?.blueprintId === state.definition.id && typeof state.host.definitionJson === 'string'
    && text(state.host.semanticRevision) && text(state.host.documentRevision), 'full definition/Host facts missing')
  ensure(typeof state.inputJson === 'string' && Array.isArray(state.selection) && state.selection.every(text)
    && new Set(state.selection).size === state.selection.length && state.selection.every(id => state.definition.graph.nodes.some(n => n.id === id)), 'input/selection facts missing or invalid')
  ensure(typeof state.history?.undo === 'boolean' && typeof state.history.redo === 'boolean' && ['true', 'false'].includes(state.history.dirty)
    && (state.draft === null || typeof state.draft === 'string'), 'history/dirty/draft facts missing')
  if (state.draft === null) ensure(same(state.definition, JSON.parse(state.host.definitionJson)), 'definition differs from unchanged Host without a draft')
  else ensure(same(state.definition, JSON.parse(JSON.parse(state.draft).definitionJson)), 'definition/draft mismatch')
  const view = state.viewport
  ensure(view?.blueprintId === state.definition.id && view.key === `xuanling-blueprint:viewport:${encodeURIComponent(state.definition.id)}`
    && view.status === 'present' && typeof view.raw === 'string' && same(JSON.parse(view.raw), view.state)
    && view.state?.version === 1 && ['x', 'y', 'zoom'].every(key => Number.isFinite(view.state.viewport?.[key])) && view.state.viewport.zoom > 0
    && text(view.inlineTransform) && text(view.computedTransform) && ['m11', 'm12', 'm21', 'm22', 'm41', 'm42'].every(key => Number.isFinite(view.matrix?.[key])), 'exact public viewport facts missing or invalid')
  ensure(viewportStateOracle(view.css, { expectedPrefs: view.state }).passed && view.css.publicPrefs.raw === view.raw
    && same(view.css.actual.matrix, view.matrix) && view.css.actual.computedTransform === view.computedTransform, 'exact public viewport does not match actual browser CSS encoding')
  ensure(state.run && (state.run.snapshot === null || BLUEPRINT_INVOCATIONS.find(i => i.method === 'inspectRun').result.create().safeParse(state.run.snapshot).success)
    && typeof state.run.inspectInput === 'string' && text(state.run.state) && ['connected', 'stale', 'reconnecting'].includes(state.run.connection)
    && Array.isArray(state.run.nodeStates) && Array.isArray(state.run.attempts) && Array.isArray(state.run.logTail), 'complete Run binding/snapshot facts missing')
  if (state.run.snapshot) ensure(state.run.id === state.run.snapshot.runId && state.run.state === state.run.snapshot.state
    && state.run.revision === state.run.snapshot.definitionRevision, 'Run binding differs from complete snapshot')
  else ensure(state.run.id === null && state.run.state === 'none' && state.run.revision === null, 'unbound Run facts invalid')
  return true
}
export function validateRetentionFacts(facts) {
  validateRetentionState(facts?.before); validateRetentionState(facts?.after)
  ensure(same(facts.before, facts.after), 'fold/theme changed definition/Host/input/selection/Run/history/dirty/draft/exact viewport')
  return true
}
// These names and sizes come from DSH ui-primitives/{Input,Button}.module.css
// and ui-theme/styles/{base,focus}.css, rather than the plugin's CSS source.
export const HOST_CONTROL_SELECTORS = Object.freeze({
  picker: '[data-bp-select="blueprint"]', search: '[data-bp-palette-search]',
  inspectorSelect: '.bp-node-inspector select[data-bp-field="agentRef"]',
  runInput: '[data-bp-run-input]', formInput: 'input[name="runId"]',
  textButton: '[data-bp-action="inspect-run"]', portButton: '[data-bp-action="add-input-port"]',
  neutral: '[data-bp-action="more-actions"]', primary: '[data-bp-action="start-run"]',
})
export const HOST_STYLE_TOKENS = Object.freeze({
  radiusMd: '--dsw-radius-md', radiusSm: '--dsw-radius-sm', label: '--dsw-alias-label-primary',
  placeholder: '--dsw-alias-label-dimmed', background: '--dsw-alias-bg-layer-1',
  inputBorder: '--dsw-alias-border-l4', buttonBorder: '--dsw-alias-border-l3',
  focus: '--dsw-alias-state-business-primary', hover: '--dsw-alias-interactive-bg-hover',
  active: '--dsw-alias-interactive-bg-active', primary: '--dsw-alias-button-primary-fill',
  primaryHover: '--dsw-alias-button-primary-hover', foreground: '--dsw-alias-label-primary-foreground',
})
export function validateMountedControlPanes(f) {
  ensure(f?.picker?.count === 1 && f.picker.visible === true && f.picker.inToolbar === true
    && text(f.picker.name) && same(f.toggles, ['toggle-library', 'toggle-inspector'])
    && ['library', 'inspector'].every(id => f[id]?.count === 1 && f[id].mounted === true && f[id].visible === true && rectValid(f[id].rect))
    && rectValid(f.bounds), 'host layout picker/side handles/always-mounted pane geometry missing')
  return true
}
export function validateHostControlFacts(c) {
  ensure(HOST_CONTROL_CASES.some(spec => spec.id === c?.id), 'unknown host-control case')
  const f = c.facts
  const trusted = events => Array.isArray(events) && events.length > 0 && events.every(e => e.trusted === true)
  ensure(trusted(f?.events), 'host-control trusted input facts missing')
  ensure(f.themes?.length === 4 && new Set(f.themes.map(t => `${t.locale}/${t.scheme}`)).size === 4, 'host-control four theme facts missing')
  for (const theme of f.themes) {
    ensure(['zh', 'en'].includes(theme.locale) && ['light', 'dark'].includes(theme.scheme)
      && theme.width === 1700 && theme.height === 1100 && theme.overflow === false
      && trusted(theme.events), 'host-control native theme/input/geometry facts missing')
    validateRetentionFacts(theme)
    ensure(theme.style?.selectedNode === 'gate' && theme.before.selection.length === 1 && theme.before.selection[0] === 'gate'
      && theme.after.selection.length === 1 && theme.after.selection[0] === 'gate', 'host-control actual gate Inspector/selection missing')
    const { tokens, controls } = theme.style ?? {}
    ensure(theme.style?.provenance === 'actual getComputedStyle controls / themed document.body tokens / owned CSS reference in body', 'host-control computed-style provenance missing')
    for (const [name, token] of Object.entries(HOST_STYLE_TOKENS))
      ensure(tokens?.[name]?.name === token && text(tokens[name].raw) && text(tokens[name].resolved), `host token missing: ${name}`)
    ensure(tokens.radiusMd.resolved === '12px' && tokens.radiusSm.resolved === '8px', 'host radius tokens differ from DSH 12px/8px contract')
    for (const [role, selector] of Object.entries(HOST_CONTROL_SELECTORS)) {
      const control = controls?.[role]
      ensure(control?.selector === selector && control.count === 1 && control.visible === true && rectValid(control.rect)
        && text(control.name) && control.height >= 40 && typeof control.disabled === 'boolean', `host-control visible semantic control facts missing: ${role}`)
      const icon = ['neutral', 'primary'].includes(role)
      ensure(control.radius === tokens[['portButton', 'neutral', 'primary'].includes(role) ? 'radiusSm' : 'radiusMd'].resolved, `host-control wrong radius: ${role}`)
      if (icon) ensure(control.width >= 40 && control.tag === 'BUTTON' && control.svgHidden === true, `host-control icon/40px facts missing: ${role}`)
      else if (['picker', 'inspectorSelect', 'search', 'formInput', 'runInput'].includes(role)) {
        ensure(control.tag === (['picker', 'inspectorSelect'].includes(role) ? 'SELECT' : role === 'runInput' ? 'TEXTAREA' : 'INPUT')
          && typeof control.value === 'string' && Array.isArray(control.options)
          && control.background === tokens.background.resolved && control.color === tokens.label.resolved
          && control.border === tokens.inputBorder.resolved, `host-control native form/token facts wrong: ${role}`)
        if (control.tag === 'SELECT') ensure(control.appearance === 'none' && control.options.length > 0, 'native select appearance/options missing')
        if (['search', 'formInput'].includes(role)) ensure(control.placeholderColor === tokens.placeholder.resolved, 'native input placeholder token mismatch')
      } else ensure(control.tag === 'BUTTON' && control.color === tokens.label.resolved && control.border === tokens.buttonBorder.resolved, 'native text/port button tokens wrong')
    }
    ensure(controls.primary.background === tokens.primary.resolved && controls.primary.color === tokens.foreground.resolved, 'primary fill/foreground token mismatch')
    if (c.id === 'HC-STYLE') {
      const sidebar = theme.sidebar
      ensure(sidebar?.collapseBefore === true && sidebar.openCollapsed === true && sidebar.collapseAfter === true
        && trusted(sidebar.events) && sidebar.events.filter(e => e.type === 'pointerdown').length >= 2, 'actual host sidebar collapse/open inputs missing')
      for (const phase of ['before', 'collapsed', 'after']) validateMountedControlPanes(sidebar[phase])
      validateRetentionFacts({ before: sidebar.stateBefore, after: sidebar.stateCollapsed })
      validateRetentionFacts({ before: sidebar.stateBefore, after: sidebar.stateAfter })
    } else {
      ensure(theme.focus?.length === 5 && ['picker', 'search', 'formInput', 'runInput', 'neutral'].every(role => theme.focus.some(item =>
        item.role === role && item.selector === HOST_CONTROL_SELECTORS[role] && item.active === true && item.focusVisible === true
        && item.outlineStyle !== 'none' && parseFloat(item.outlineWidth) > 0 && item.outlineColor === tokens.focus.resolved
        && (role === 'neutral' || item.border === tokens.focus.resolved))), 'keyboard focus/host ring or input border facts wrong')
      ensure(theme.feedback?.neutralHover === tokens.hover.resolved && theme.feedback.neutralActive === tokens.active.resolved
        && theme.feedback.primaryHover === tokens.primaryHover.resolved, 'neutral/primary hover/active token mismatch')
      const disabled = theme.disabled
      ensure(disabled?.disabled === true && disabled.ariaDisabled === 'true' && text(disabled.name) && text(disabled.reason)
        && disabled.tooltipVisible === true && disabled.executionRequests === 0 && disabled.activationEvents === 0
        && trusted(disabled.events) && disabled.events.some(e => e.type === 'keydown' && e.key === 'Enter'), 'disabled wrong activation/ARIA/reason/input facts')
      validateRetentionFacts(disabled)
    }
  }
  return true
}
/** Browser color resolution uses only a short-lived owned reference, just as
 * the existing viewport CSS oracle does. It never writes a product control. */
export function hostControlStyleProbe({ selectors, tokenNames }) {
  const host = document.body, workspace = document.querySelector('[data-bp-canvas="root"]')
  const hostStyle = getComputedStyle(host), reference = document.createElement('span')
  reference.setAttribute('data-bp-collector-css-reference', 'host-controls')
  reference.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:0;height:0;overflow:hidden'
  host.appendChild(reference)
  const tokens = {}
  try {
    for (const [name, token] of Object.entries(tokenNames)) {
      const radius = name.startsWith('radius'), property = radius ? 'borderRadius' : 'color'
      reference.style[property] = `var(${token})`
      tokens[name] = { name: token, raw: hostStyle.getPropertyValue(token).trim(), resolved: getComputedStyle(reference)[property] }
    }
  } finally { reference.remove() }
  const rect = el => { const r = el?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null }
  const controls = Object.fromEntries(Object.entries(selectors).map(([role, selector]) => {
    const nodes = workspace.querySelectorAll(selector), el = nodes[0], css = el && getComputedStyle(el), box = rect(el)
    return [role, { selector, count: nodes.length, tag: el?.tagName, value: 'value' in (el ?? {}) ? el.value : null,
      options: el?.tagName === 'SELECT' ? [...el.options].map(o => ({ value: o.value, label: o.label, disabled: o.disabled })) : [],
      name: el?.getAttribute('aria-label') || el?.textContent || el?.closest('label')?.textContent || el?.getAttribute('name'),
      visible: !!box && box.width > 0 && box.height > 0 && css.display !== 'none' && !['hidden', 'collapse'].includes(css.visibility)
        && el.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }),
      rect: box, width: box?.width, height: box?.height, disabled: el?.matches(':disabled'),
      svgHidden: el?.querySelector('svg[data-bp-icon]')?.getAttribute('aria-hidden') === 'true',
      radius: css?.borderRadius, appearance: css?.appearance, color: css?.color, background: css?.backgroundColor,
      focused: document.activeElement === el, focusVisible: el?.matches(':focus-visible'), hovered: el?.matches(':hover'), active: el?.matches(':active'),
      outlineColor: css?.outlineColor, outlineStyle: css?.outlineStyle, outlineWidth: css?.outlineWidth,
      border: css?.borderTopColor, placeholderColor: el && getComputedStyle(el, '::placeholder').color }]
  }))
  return { provenance: 'actual getComputedStyle controls / themed document.body tokens / owned CSS reference in body', tokens, controls, hostScope: { tag: host.tagName, darkTheme: host.hasAttribute?.('data-ds-dark-theme') ?? false },
    selectedNode: workspace.querySelector('[data-bp-node-inspector]')?.getAttribute('data-bp-node-inspector') }
}
export function mountedControlPanesProbe() {
  const root = document.querySelector('[data-bp-canvas="root"]')
  const rect = el => { const r = el?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null }
  const pane = selector => { const nodes = root.querySelectorAll(selector), el = nodes[0], box = rect(el); return {
    count: nodes.length, mounted: el?.isConnected === true, visible: !!box && box.width > 0 && box.height > 0 && el.checkVisibility(), rect: box } }
  const items = root.querySelectorAll('[data-bp-select="blueprint"]'), item = items[0]
  return { bounds: rect(root), library: pane('.bp-library'), inspector: pane('.bp-inspector'),
    picker: { count: items.length, visible: !!item && item.checkVisibility() && item.getBoundingClientRect().width > 0,
      inToolbar: !!item?.closest('.bp-toolbar'), name: item?.getAttribute('aria-label') },
    toggles: [...root.querySelectorAll('[data-bp-action="toggle-library"], [data-bp-action="toggle-inspector"]')].map(el => el.getAttribute('data-bp-action')) }
}
export async function prepareHostControlView(page) {
  await closePublicMore(page)
  await page.locator('[data-bp-canvas="surface"]').focus()
  await page.keyboard.press('Escape')
  await page.locator('.react-flow__node[data-id="gate"] .bp-node-title').click()
  await page.waitForFunction(() => {
    const root = document.querySelector('[data-bp-canvas="root"]')
    const selected = root?.querySelectorAll('.react-flow__node.selected[data-id]')
    const inspector = root?.querySelector('[data-bp-node-inspector="gate"]'), rect = inspector?.getBoundingClientRect()
    return selected?.length === 1 && selected[0].getAttribute('data-id') === 'gate'
      && !!inspector && inspector.checkVisibility() && rect.width > 0 && rect.height > 0
  })
  await page.locator('[data-bp-node-inspector="gate"]').waitFor({ state: 'visible' })
  await setPublicDisclosure(page, 'preflight', false)
  await prepareRunInput(page)
  // The actual scroll containers reveal the real fields; no hidden fill or
  // details.open mutation. Keep the palette search at the top for visual QA.
  await page.locator('[data-bp-palette-search]').scrollIntoViewIfNeeded()
  await page.locator(HOST_CONTROL_SELECTORS.inspectorSelect).scrollIntoViewIfNeeded()
}
/** Stage receipts survive an early wait rejection. Samples are passive reads,
 * not native acceptance; the original operation/error remains authoritative. */
export async function observeHostControlStage(page, { ui, dir, stage, locale = null, scheme = null }, operation) {
  ensure(reportPathAllowed(ui.planId, 'compact', dir, { physical: true }), 'host-control diagnostics require confined current report directory')
  ui.hostControlStages ??= []
  const receipt = { phase: ui.phase, stage, locale, scheme, startedAt: new Date().toISOString(), status: 'pending',
    before: null, after: null, failure: null, diagnosticErrors: [] }
  const index = ui.hostControlStages.length + 1
  const receiptPath = join(dir, `host-control-stage-${index}.json`)
  ui.hostControlStages.push(receipt)
  const persist = () => {
    writeFileSync(receiptPath, stringifyProbeEvidence(receipt))
    writeFileSync(join(dir, 'compact-ux-evidence.json'), stringifyProbeEvidence(ui))
  }
  const sample = async () => {
    try { return { at: new Date().toISOString(), style: await page.evaluate(hostControlStyleProbe, { selectors: HOST_CONTROL_SELECTORS, tokenNames: HOST_STYLE_TOKENS }) } }
    catch (error) { receipt.diagnosticErrors.push({ kind: 'sample', name: error.name, message: redactProbeEvidenceText(error.message) }); return null }
  }
  receipt.before = await sample(); persist()
  try {
    const result = await operation()
    receipt.after = await sample(); receipt.finishedAt = new Date().toISOString(); receipt.status = 'complete'; persist()
    return result
  } catch (error) {
    receipt.status = 'failed'; receipt.finishedAt = new Date().toISOString()
    receipt.failure = { name: error.name, message: redactProbeEvidenceText(error.message), at: receipt.finishedAt }
    receipt.after = await sample(); persist()
    const path = join(dir, `host-control-stage-${index}-failure.png`)
    try {
      await page.screenshot({ path, fullPage: true })
      receipt.screenshot = { path, sha256: sha256(readFileSync(path)), provenance: 'actual Playwright screenshot at failed HC stage' }
    } catch (diagnosticError) {
      receipt.diagnosticErrors.push({ kind: 'screenshot', name: diagnosticError.name, message: redactProbeEvidenceText(diagnosticError.message) })
    }
    persist(); throw error
  }
}
export async function collectHostControlFacts(page, { id, state, ui, events, dir }) {
  const observe = (stage, operation, locale, scheme) => observeHostControlStage(page, { ui, dir, stage, locale, scheme }, operation)
  await observe('prepare-view', () => prepareHostControlView(page))
  const themes = []
  const sampleStyle = () => page.evaluate(hostControlStyleProbe, { selectors: HOST_CONTROL_SELECTORS, tokenNames: HOST_STYLE_TOKENS })
  const sampleFocus = (role) => page.locator(HOST_CONTROL_SELECTORS[role]).evaluate(el => {
    const css = getComputedStyle(el)
    return { active: document.activeElement === el, focusVisible: el.matches(':focus-visible'), border: css.borderTopColor,
      outlineColor: css.outlineColor, outlineStyle: css.outlineStyle, outlineWidth: css.outlineWidth }
  })
  for (const locale of ['zh', 'en']) for (const scheme of ['light', 'dark']) {
    const eventStart = events.length
    const stage = (name, operation) => observe(name, operation, locale, scheme)
    await stage('native-locale', () => setPublicNativeLocale(page, locale))
    await stage('native-theme', () => setNativeTheme(page, scheme))
    await stage('theme-prepare-view', () => prepareHostControlView(page))
    const before = await state(), extra = {}
    if (id === 'HC-STYLE') {
      const collapse = page.getByRole('button', { name: locale === 'zh' ? '收起侧边栏' : 'Collapse sidebar', exact: true })
      const open = page.getByRole('button', { name: locale === 'zh' ? '打开侧边栏' : 'Open sidebar', exact: true })
      const start = events.length, sidebar = { collapseBefore: await collapse.isVisible(), stateBefore: await state(), before: await page.evaluate(mountedControlPanesProbe) }
      await stage('host-collapse', async () => { await collapse.click(); await open.waitFor({ state: 'visible' }) })
      sidebar.openCollapsed = await open.isVisible(); sidebar.collapsed = await page.evaluate(mountedControlPanesProbe); sidebar.stateCollapsed = await state()
      await stage('host-open', async () => { await open.click(); await collapse.waitFor({ state: 'visible' }) })
      sidebar.collapseAfter = await collapse.isVisible(); sidebar.after = await page.evaluate(mountedControlPanesProbe); sidebar.stateAfter = await state()
      await page.evaluate(() => Promise.resolve()); sidebar.events = events.slice(start); extra.sidebar = sidebar
    } else {
      const focus = []
      for (const role of ['picker', 'search', 'formInput', 'runInput', 'neutral']) {
        const target = page.locator(HOST_CONTROL_SELECTORS[role])
        await target.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab')
        await stage(`focus-${role}`, () => page.waitForFunction(({ selector, input }) => {
          const el = document.querySelector(selector), reference = document.createElement('span')
          reference.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'; reference.style.color = 'var(--dsw-alias-state-business-primary)'
          document.body.appendChild(reference)
          try {
            const css = getComputedStyle(el), color = getComputedStyle(reference).color
            return document.activeElement === el && el.matches(':focus-visible') && css.outlineStyle !== 'none'
              && parseFloat(css.outlineWidth) > 0 && css.outlineColor === color && (!input || css.borderTopColor === color)
          } finally { reference.remove() }
        }, { selector: HOST_CONTROL_SELECTORS[role], input: role !== 'neutral' }))
        focus.push({ role, selector: HOST_CONTROL_SELECTORS[role], ...await sampleFocus(role) })
      }
      extra.focus = focus
      const feedback = {}, neutral = page.locator(HOST_CONTROL_SELECTORS.neutral), primary = page.locator(HOST_CONTROL_SELECTORS.primary)
      const background = el => getComputedStyle(el).backgroundColor
      // Observe the actual settled hover color at the caller's original bound.
      const hover = async (target, token) => {
        await target.hover()
        const actionId = await target.getAttribute('data-bp-action')
        await stage(`hover-${actionId}`, () => page.waitForFunction(({ selector, token }) => {
          const el = document.querySelector(selector), reference = document.createElement('span')
          reference.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'; reference.style.color = `var(${token})`
          document.body.appendChild(reference)
          try { return getComputedStyle(el).backgroundColor === getComputedStyle(reference).color } finally { reference.remove() }
        }, { selector: `[data-bp-action="${actionId}"]`, token }))
        return target.evaluate(background)
      }
      feedback.neutralHover = await hover(neutral, HOST_STYLE_TOKENS.hover)
      const box = await neutral.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
      try {
        await stage('neutral-active', () => page.waitForFunction(() => {
          const el = document.querySelector('[data-bp-action="more-actions"]'), reference = document.createElement('span')
          reference.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'; reference.style.color = 'var(--dsw-alias-interactive-bg-active)'
          document.body.appendChild(reference)
          try { return el?.matches(':active') && getComputedStyle(el).backgroundColor === getComputedStyle(reference).color } finally { reference.remove() }
        }))
        feedback.neutralActive = await neutral.evaluate(background)
      } finally {
        // Release outside the button so this feedback sample cannot activate it.
        await page.mouse.move(0, 0); await page.mouse.up()
      }
      feedback.primaryHover = await hover(primary, HOST_STYLE_TOKENS.primaryHover)
      extra.feedback = feedback
      const start = events.length, requestStart = ui.requests.length, disabledBefore = await state()
      const disabledId = await action(page, 'undo').isDisabled() ? 'undo' : 'redo', disabled = action(page, disabledId)
      const anchor = disabled.locator('..'); await anchor.focus(); await page.keyboard.press('Enter')
      const tooltip = page.locator(`[data-bp-tooltip="${disabledId}"]`); await stage('disabled-tooltip', () => tooltip.waitFor({ state: 'visible' }))
      await page.evaluate(() => Promise.resolve())
      extra.disabled = { before: disabledBefore, after: await state(), disabled: await disabled.isDisabled(), ariaDisabled: await disabled.getAttribute('aria-disabled'),
        name: await disabled.getAttribute('aria-label'), reason: await tooltip.locator('small').textContent(), tooltipVisible: await tooltip.isVisible(),
        executionRequests: ui.requests.slice(requestStart).filter(r => ['startRun', 'cancelRun', 'decide', 'saveDefinition'].includes(r.method)).length,
        activationEvents: events.slice(start).filter(e => e.type === 'click' && e.action === disabledId).length, events: events.slice(start) }
    }
    // Blur before baseline styles, then reveal both Inspector controls and Run.
    await page.mouse.move(0, 0)
    // Leave focus on a native summary, so form baselines are neither focused nor hovered.
    await page.locator('summary[data-bp-disclosure-toggle="run"]').focus()
    await stage('baseline-primary-fill', () => page.waitForFunction(() => {
      const el = document.querySelector('[data-bp-action="start-run"]'), reference = document.createElement('span')
      reference.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none'; reference.style.color = 'var(--dsw-alias-button-primary-fill)'
      document.body.appendChild(reference)
      try { return getComputedStyle(el).backgroundColor === getComputedStyle(reference).color } finally { reference.remove() }
    }))
    await page.locator(HOST_CONTROL_SELECTORS.inspectorSelect).scrollIntoViewIfNeeded()
    const layout = await page.evaluate(layoutDomProbe), style = await sampleStyle(), screenshot = join(dir, `host-controls-${id}-${locale}-${scheme}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await page.evaluate(() => Promise.resolve())
    themes.push({ locale, scheme, width: layout.width, height: layout.height, overflow: layout.pageOverflow, before, after: await state(),
      style, ...extra, events: events.slice(eventStart), screenshot, sha256: sha256(readFileSync(screenshot)) })
  }
  return { themes }
}
export function validateCompactCase(c) {
  const spec = UX_CASES.find(item => item.id === c?.id)
  ensure(spec && c.description === spec.description, 'unknown compact UX case or wrong description')
  const f = c.facts
  ensure(f && Array.isArray(f.events) && f.events.length > 0 && f.events.every(e => e.trusted === true), `${c.id}: trusted public input facts missing`)
  if (c.id === 'UX-ICONS') {
    ensure(f.buttons?.length === topActions.length && topActions.every(id => f.buttons.some(b => b.id === id && text(b.name) && b.svgHidden === true
      && b.visible === true && b.width >= 40 && b.height >= 40)), 'icon ARIA/SVG/40px targets missing')
  } else if (c.id === 'UX-TOOLTIP') {
    ensure(['hover', 'focus'].every(kind => f.tooltips?.some(t => t.kind === kind && t.role === 'tooltip' && t.visible && text(t.text)
      && t.text.includes(t.name) && text(t.shortcut))), 'hover/focus tooltip name or shortcut missing')
  } else if (c.id === 'UX-DISABLED') {
    ensure(f.actions?.length > 0 && f.actions.every(a => a.disabled && a.ariaDisabled === 'true' && text(a.name) && text(a.reason)
      && a.tooltipVisible && a.tooltip.includes(a.reason)) && f.executionRequests === 0, 'disabled ARIA/reason or no-execution witness missing')
    validateRetentionFacts(f)
  } else if (c.id === 'UX-BLUEPRINT') {
    ensure(f.count === 1 && f.inToolbar === true && f.visible === true && same(f.toggles, ['toggle-library', 'toggle-inspector'])
      && ['library', 'inspector'].every(id => f[id]?.count === 1 && f[id].mounted === true && f[id].visible === true)
      && !Object.hasOwn(f, 'libraryHidden') && !Object.hasOwn(f, 'visibleWithLibraryHidden') && text(f.name), 'unique top blueprint selector/side handles/always-mounted facts missing')
  } else if (c.id === 'UX-MORE') {
    ensure(f.actions?.length === Object.keys(MORE_ACTION_GROUPS).length && Object.entries(MORE_ACTION_GROUPS).every(([id, group]) =>
      f.actions.some(a => a.id === id && a.group === group && a.visible && text(a.name) && typeof a.disabled === 'boolean'
        && a.ariaDisabled === String(a.disabled) && (!a.disabled || (text(a.reason) && a.reasonVisible)))) && ['files', 'view', 'tools'].every(group =>
      f.groups?.some(g => g.id === group && g.haspopup === 'menu' && g.expanded === 'true' && g.role === 'menu')), 'public More group/action registry missing')
  } else if (c.id === 'UX-MENU') {
    ensure(['appearance', 'layout'].every(group => f.groups?.some(g => g.id === group && g.haspopup === 'menu' && g.expanded === 'true' && g.role === 'menu' && g.visible)), 'object appearance/layout submenu missing')
    ensure(f.commands?.length === Object.keys(OBJECT_COMMAND_GROUPS).length && Object.entries(OBJECT_COMMAND_GROUPS).every(([command, group]) =>
      f.commands.some(a => a.command === command && a.group === group && a.visible && text(a.name) && typeof a.disabled === 'boolean'
        && a.ariaDisabled === String(a.disabled) && (!a.disabled || (text(a.reason) && a.reasonVisible)))), 'object command registry/disabled ARIA/reasons missing')
  } else if (c.id === 'UX-FOCUS') {
    ensure(f.rightOpened && f.leftRestoredParent && f.escapeRestoredParent && f.secondEscapeRestoredInitiator
      && f.navigation?.length === 4 && ['ArrowDown', 'ArrowUp', 'Home', 'End'].every(key => f.navigation.some(n => n.key === key && n.inCurrentLevel)), 'menu keyboard levels/focus restoration missing')
    validateRetentionFacts(f)
  } else if (c.id === 'UX-BOUNDARY' || c.id === 'UX-NARROW') {
    ensure(f.menus?.length >= 2 && f.menus.every(m => within(m.rect, f.bounds)) && f.pageOverflow === false, 'menu clamped bounds or page overflow failed')
    if (c.id === 'UX-NARROW') ensure(f.width === 1100 && f.buttons?.length >= topActions.length && f.buttons.every(b => b.visible && b.width >= 40 && b.height >= 40), '1100px narrow targets missing')
  } else if (c.id === 'UX-PALETTE') {
    ensure(f.entries?.length === PALETTE_KINDS.length && PALETTE_KINDS.every(kind =>
      f.entries.some(e => e.kind === kind && e.visible && text(e.name) && e.icon && text(e.description) && e.descriptionVisible)), 'supported palette names/descriptions missing')
  } else if (c.id === 'UX-DISCLOSURE') {
    ensure(f.disclosures?.length === 2 && ['preflight', 'run'].every(id => f.disclosures.some(d => d.id === id && d.tag === 'DETAILS'
      && d.summaryTag === 'SUMMARY' && d.folded && d.expanded && d.childrenRetained && text(d.summary))), 'native details/summary/child identity missing')
    validateRetentionFacts(f)
  } else if (['UX-RETENTION', 'UX-RETENTION-WAITING'].includes(c.id)) {
    validateRetentionFacts(f)
    if (c.id === 'UX-RETENTION-WAITING') ensure(f.before.run.state === 'waiting_input' && f.before.run.snapshot?.attempts.some(a => a.state === 'waiting_input'), 'complete durable waiting Run witness missing')
  } else if (c.id === 'UX-TOP-ROW') {
    ensure(f.width === 1700 && f.pageOverflow === false && f.controls?.length >= topActions.length + 1
      && f.controls.every(b => within(b.rect, f.toolbar) && b.rect.width >= 40 && b.rect.height >= 40)
      && Math.max(...f.controls.map(b => b.rect.top)) < Math.min(...f.controls.map(b => b.rect.bottom)), '1700px fixed top one-row/clipping/40px gate failed')
  } else if (c.id === 'UX-THEMES') {
    ensure(f.themes?.length === 4 && new Set(f.themes.map(t => `${t.locale}/${t.scheme}`)).size === 4
      && f.themes.every(t => ['zh', 'en'].includes(t.locale) && ['light', 'dark'].includes(t.scheme) && t.width === 1700 && t.height === 1100 && !t.overflow), 'four native theme matrix missing')
    for (const theme of f.themes) validateRetentionFacts(theme)
  } else if (c.id === 'UX-ZERO-PROVIDER') ensure(f.keyRead === false && f.providerCalls === 0 && f.defaultProfilesRead === false, 'key/provider/default profile isolation failed')
  return true
}
export function validateCompactReceipt(ui, { startedAt, finishedAt, assertions, planId = PLAN_ID } = {}) {
  ensure([PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(planId) && ui?.planId === planId && ui.wave === 'W2' && ui.keyRead === false && ui.providerCalls === 0 && ui.nativeClipboardEvidence === false, 'compact receipt plan/isolation mislabeled')
  const start = Date.parse(ui.startedAt), end = Date.parse(ui.finishedAt)
  ensure(fresh(ui.startedAt, startedAt, finishedAt) && fresh(ui.finishedAt, start, finishedAt), 'compact receipt timestamps stale/missing')
  const registry = casesForPlan(planId)
  ensure(ui.cases?.length === registry.length && new Set(ui.cases.map(c => c.id)).size === registry.length, 'compact UX cases missing/duplicate/extra')
  for (const c of ui.cases) {
    ensure(c.passed === true && fresh(c.at, start, end) && assertions?.some(a => a.id === c.id && a.description === c.description && a.passed === true), 'compact assertion/time/pass mismatch')
    const spec = registry.find(spec => spec.id === c.id)
    ensure(spec && c.description === spec.description, 'compact case registry description mismatch')
    if (HOST_CONTROL_CASES.some(spec => spec.id === c.id)) validateHostControlFacts(c)
    else validateCompactCase(c)
  }
  for (const { id } of registry) ensure(ui.cases.some(c => c.id === id), `compact UX required case missing: ${id}`)
  ensure(ui.trustedEvents?.pointerdown > 0 && ui.trustedEvents.keydown > 0 && ui.untrustedEvents === 0 && ui.requests?.every(r =>
    !['hostProbe', 'toolProbe', 'mcpProbe'].includes(r.method)), 'compact trusted input or forbidden request evidence missing')
  return { ok: true, mountedCases: ui.cases.length }
}
export function parseCli(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const at = args[i].indexOf('='), flag = at < 0 ? args[i] : args[i].slice(0, at), value = at < 0 ? args[++i] : args[i].slice(at + 1)
    ensure(['--plan-id', '--report-dir'].includes(flag) && !Object.hasOwn(options, flag) && text(value) && value.trim() === value
      && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !value.startsWith('--'), 'invalid/duplicate compact CLI option')
    options[flag] = value
  }
  const planId = options['--plan-id']
  ensure([PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(planId) && reportPathAllowed(planId, 'compact', options['--report-dir']), 'explicit compact/host-controls plan and new physical W2 directory required')
  return { planId, reportDir: options['--report-dir'] }
}
export function adaptProbe(original) {
  const motion = pathToFileURL(join(HERE, 'comfy-motion-ui.mjs')).href, self = pathToFileURL(fileURLToPath(import.meta.url)).href
  const source = motionAdapter(original)
  ensure(source.includes(motion), 'actual native adapter collector anchor missing')
  return source.split(motion).join(self)
}

/** Passive read of documented DOM/storage surfaces. Does not touch Flow stores. */
export function retentionDomProbe() {
  const root = document.querySelector('[data-bp-canvas="root"]')
  if (!root) throw new Error('actual mounted root absent')
  const id = root.getAttribute('data-bp-blueprint'), key = `xuanling-blueprint:viewport:${encodeURIComponent(id)}`
  const raw = localStorage.getItem(key), viewport = root.querySelector('.react-flow__viewport'), matrix = new DOMMatrix(getComputedStyle(viewport).transform)
  const run = root.querySelector('[data-bp-run]'), state = run?.getAttribute('data-bp-run')
  return { id, draft: localStorage.getItem(`xuanling-blueprint:draft:${encodeURIComponent(id)}`), inputJson: root.querySelector('[data-bp-run-input]')?.value,
    selection: [...root.querySelectorAll('.react-flow__node.selected[data-id]')].map(el => el.getAttribute('data-id')).sort(),
    history: { undo: !root.querySelector('[data-bp-action="undo"]')?.disabled, redo: !root.querySelector('[data-bp-action="redo"]')?.disabled,
      dirty: root.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty') },
    viewport: { blueprintId: id, key, raw, state: raw === null ? null : JSON.parse(raw), status: raw === null ? 'missing' : 'present',
      inlineTransform: viewport.getAttribute('style'), computedTransform: getComputedStyle(viewport).transform,
      matrix: Object.fromEntries(['m11', 'm12', 'm21', 'm22', 'm41', 'm42'].map(key => [key, matrix[key]])) },
    run: { id: state === 'none' ? null : run?.textContent.split(' · ')[0].trim(), state, inspectInput: root.querySelector('input[name="runId"]')?.value,
      revision: root.querySelector('[data-bp-run-revision]')?.getAttribute('data-bp-run-revision') ?? null,
      connection: root.querySelector('[data-bp-connection]')?.getAttribute('data-bp-connection'),
      nodeStates: [...root.querySelectorAll('[data-bp-node]')].map(el => ({ id: el.getAttribute('data-bp-node'), state: el.getAttribute('data-bp-raw-state') })),
      attempts: [...root.querySelectorAll('[data-bp-attempt]')].map(el => ({ id: el.getAttribute('data-bp-attempt'), output: el.querySelector('[data-bp-output]')?.textContent ?? null,
        error: el.querySelector('p')?.textContent ?? null })),
      logTail: [...root.querySelectorAll('.bp-log li')].map(el => el.textContent) } }
}
export async function readRetentionState(page, api) {
  const dom = await page.evaluate(retentionDomProbe)
  dom.viewport.css = await page.evaluate(viewportCssProbe, { action: 'read', blueprintId: dom.id })
  const hostWire = await api('loadDefinition', { blueprintId: dom.id })
  ensure(hostWire?.status === 200 && hostWire.body?.result?.ok === true, 'retention real Host load failed')
  const host = hostWire.body.result.value, definition = JSON.parse(dom.draft === null ? host.definitionJson : JSON.parse(dom.draft).definitionJson)
  let snapshot = null
  if (dom.run.id) {
    const wire = await api('inspectRun', { runId: dom.run.id })
    ensure(wire?.status === 200 && wire.body?.result?.ok === true, 'retention real durable Run inspect failed')
    snapshot = wire.body.result.value
  }
  const state = { definition, host, inputJson: dom.inputJson, selection: dom.selection, history: dom.history, draft: dom.draft, viewport: dom.viewport, run: { ...dom.run, snapshot } }
  validateRetentionState(state)
  return state
}
function layoutDomProbe() {
  const root = document.querySelector('[data-bp-canvas="root"]'), toolbar = root?.querySelector('.bp-toolbar')
  const rect = el => { const r = el?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null }
  const visible = el => { const r = rect(el); return !!r && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
  return { width: innerWidth, height: innerHeight, bounds: rect(root), toolbar: rect(toolbar), pageOverflow: document.documentElement.scrollWidth > innerWidth,
    controls: [...(toolbar?.querySelectorAll('button[data-bp-action], select[data-bp-select]') ?? [])].map(el => ({ id: el.getAttribute('data-bp-action') ?? 'blueprint', rect: rect(el) })),
    buttons: [...(toolbar?.querySelectorAll('button[data-bp-action]') ?? [])].map(el => ({ id: el.getAttribute('data-bp-action'), visible: visible(el), name: el.getAttribute('aria-label'),
      svgHidden: el.querySelector('svg[data-bp-icon]')?.getAttribute('aria-hidden') === 'true', width: rect(el)?.width, height: rect(el)?.height })),
    menus: [...root.querySelectorAll('[role="menu"]')].filter(visible).map(el => ({ rect: rect(el), name: el.getAttribute('aria-label') })) }
}
/** Self-contained public DOM observation for only the two compact bounds cases.
 * A visible submenu can precede the ResizeObserver/React position commit. */
export function compactMenuBoundsProbe({ overlay, group, waitForBounds = false }) {
  const at = new Date().toISOString(), root = document.querySelector('[data-bp-canvas="root"]'), toolbar = root?.querySelector('.bp-toolbar')
  const rect = el => { const r = el?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null }
  const visible = el => { const r = rect(el), style = el && getComputedStyle(el); return !!r && r.width > 0 && r.height > 0
    && style.display !== 'none' && !['hidden', 'collapse'].includes(style.visibility) }
  const valid = r => r && ['left', 'right', 'top', 'bottom', 'width', 'height'].every(key => Number.isFinite(r[key])) && r.width > 0 && r.height > 0
  const within = (r, bounds) => valid(r) && valid(bounds) && r.left >= bounds.left && r.right <= bounds.right && r.top >= bounds.top && r.bottom <= bounds.bottom
  const parents = [...(root?.querySelectorAll(`[data-bp-overlay="${overlay}"]`) ?? [])], parent = parents.length === 1 ? parents[0] : null
  const submenus = [...(root?.querySelectorAll(`[data-bp-submenu="${group}"]`) ?? [])], submenu = submenus.length === 1 ? submenus[0] : null
  const target = { overlay, group, parentCount: parents.length, submenuCount: submenus.length, parentVisible: visible(parent), submenuVisible: visible(submenu),
    parentRole: parent?.getAttribute('role') ?? null, submenuRole: submenu?.getAttribute('role') ?? null,
    submenuInParent: !!parent && !!submenu && parent.contains(submenu),
    expanded: parent?.querySelector(`[data-bp-menu-group="${group}"]`)?.getAttribute('aria-expanded') ?? null }
  const facts = { width: innerWidth, height: innerHeight, bounds: rect(root), toolbar: rect(toolbar), pageOverflow: document.documentElement.scrollWidth > innerWidth,
    controls: [...(toolbar?.querySelectorAll('button[data-bp-action], select[data-bp-select]') ?? [])].map(el => ({ id: el.getAttribute('data-bp-action') ?? 'blueprint', rect: rect(el) })),
    buttons: [...(toolbar?.querySelectorAll('button[data-bp-action]') ?? [])].map(el => ({ id: el.getAttribute('data-bp-action'), visible: visible(el), name: el.getAttribute('aria-label'),
      svgHidden: el.querySelector('svg[data-bp-icon]')?.getAttribute('aria-hidden') === 'true', width: rect(el)?.width, height: rect(el)?.height })),
    menus: [...(root?.querySelectorAll('[role="menu"]') ?? [])].filter(visible).map(el => ({ rect: rect(el), name: el.getAttribute('aria-label') })) }
  const ready = target.parentVisible && target.submenuVisible && target.parentRole === 'menu' && target.submenuRole === 'menu'
    && target.submenuInParent && target.expanded === 'true' && within(rect(parent), facts.bounds) && within(rect(submenu), facts.bounds)
    && facts.menus.length >= 2 && facts.menus.every(menu => within(menu.rect, facts.bounds)) && facts.pageOverflow === false
  return waitForBounds && !ready ? false : { at, target, ready, facts }
}
export async function waitForCompactMenuBounds(page, target, recordReadiness) {
  const first = await page.evaluate(compactMenuBoundsProbe, target)
  const evidence = { target, status: 'pending', first, reached: null, failure: null }
  recordReadiness(evidence) // Persist the original sample before polling/closing.
  try {
    let reached = first
    if (!first.ready) {
      // No timeout override: retain the caller's existing Playwright bound.
      const observed = await page.waitForFunction(compactMenuBoundsProbe, { ...target, waitForBounds: true })
      try { reached = await observed.jsonValue() }
      finally { await observed.dispose() }
    }
    ensure(reached.ready === true, 'compact menu bounds readiness returned an invalid sample')
    evidence.status = 'ready'; evidence.reached = reached; recordReadiness(evidence)
    return reached.facts // Validate this same sample; do not re-read settled DOM.
  } catch (error) {
    const at = new Date().toISOString()
    let sample = null, sampleError = null
    try { sample = await page.evaluate(compactMenuBoundsProbe, target) }
    catch (readError) { sampleError = redactProbeEvidenceText(readError.message) }
    evidence.status = 'failed'; evidence.failure = { at, name: error.name, message: redactProbeEvidenceText(error.message), sample, sampleError }
    recordReadiness(evidence); throw error
  }
}
export async function runCompactJourney(page, record, api) {
  const dir = process.env.BP_COMFY_ARTIFACT_DIR
  const planId = process.env.BP_COLLECTOR_PLAN_ID ?? PLAN_ID
  ensure(reportPathAllowed(planId, 'compact', dir, { physical: true }), 'fresh compact native report directory required')
  const ui = { planId, wave: 'W2', startedAt: new Date().toISOString(), keyRead: false, providerCalls: 0, nativeClipboardEvidence: false,
    cases: [], requests: [], trustedEvents: { pointerdown: 0, keydown: 0 }, untrustedEvents: 0 }
  const events = [], observeRequest = request => {
    if (/\/api\/llm\/(?:stream|request)/.test(request.url())) ui.providerCalls++
    if (/\/api\/blueprint\//.test(request.url()) && request.method() === 'POST') {
      const body = request.postDataJSON(); ui.requests.push({ method: body?.method?.replace(/^blueprint\//, ''), rpcId: body?.rpcId, at: new Date().toISOString() })
    }
  }
  await page.exposeFunction('__bpCompactObserve', event => {
    events.push(event)
    if (!event.trusted) ui.untrustedEvents++
    if (event.trusted && Object.hasOwn(ui.trustedEvents, event.type)) ui.trustedEvents[event.type]++
  })
  const install = () => {
    const observer = event => void window.__bpCompactObserve({ type: event.type, trusted: event.isTrusted, key: event.key ?? null,
      action: event.target?.closest?.('[data-bp-action]')?.getAttribute('data-bp-action') ?? null,
      group: event.target?.closest?.('[data-bp-menu-group]')?.getAttribute('data-bp-menu-group') ?? null, at: new Date().toISOString() })
    for (const type of ['pointerdown', 'pointerover', 'focusin', 'keydown', 'change', 'click']) document.addEventListener(type, observer, { capture: true, passive: true })
    window.__bpCompactStop = () => { for (const type of ['pointerdown', 'pointerover', 'focusin', 'keydown', 'change', 'click']) document.removeEventListener(type, observer, true); delete window.__bpCompactStop }
  }
  await page.evaluate(install); page.on('request', observeRequest)
  const state = () => readRetentionState(page, api)
  const save = () => writeFileSync(join(dir, 'compact-ux-evidence.json'), stringifyProbeEvidence(ui))
  const caseRun = async (id, run) => {
    const spec = casesForPlan(planId).find(c => c.id === id), start = events.length
    ui.phase = id; save()
    const facts = await run()
    // Flush passive observer promises without changing product input/state.
    await page.evaluate(() => Promise.resolve())
    facts.events = events.slice(start)
    const c = { ...spec, at: new Date().toISOString(), facts }
    ui.pendingCase = c; save()
    c.passed = HOST_CONTROL_CASES.some(spec => spec.id === id) ? validateHostControlFacts(c) : validateCompactCase(c); ui.cases.push(c); record(c.id, c.description, c.passed, 'actual native public input and complete independent facts')
    delete ui.pendingCase; save()
    return c
  }
  const boundsFacts = target => waitForCompactMenuBounds(page, target, evidence => {
    ui.boundsReadiness ??= {}; ui.boundsReadiness[ui.phase] = evidence; save()
  })
  const tooltip = async (id, kind) => {
    const target = action(page, id), anchor = target.locator('..')
    if (kind === 'hover') await anchor.hover(); else await (await target.isDisabled() ? anchor : target).focus()
    const tip = page.locator(`[data-bp-tooltip="${id}"]`)
    await tip.waitFor({ state: 'visible' })
    return { kind, role: await tip.getAttribute('role'), visible: await tip.isVisible(), name: await target.getAttribute('aria-label'), text: await tip.textContent(), shortcut: await tip.locator('kbd').textContent().catch(() => '') }
  }
  const foldFacts = async () => {
    const before = await state()
    for (const id of ['preflight', 'run']) await setPublicDisclosure(page, id, false)
    const folded = await state()
    for (const id of ['preflight', 'run']) await setPublicDisclosure(page, id, true)
    const after = await state()
    ensure(same(before, folded), 'folded state differs from full public baseline')
    return { before, after, folded }
  }
  const menu = () => page.locator('[data-bp-overlay="context-menu"]')
  const closeContext = async () => { await page.keyboard.press('Escape'); if (await menu().isVisible()) await page.keyboard.press('Escape') }
  const nodeTitle = () => page.locator('.react-flow__node[data-id="gate"] .bp-node-title')
  try {
    await page.setViewportSize({ width: 1700, height: 1100 }); await setPublicNativeLocale(page, 'en'); await setNativeTheme(page, 'dark')
    await prepareRunInput(page); await preparePublicDisclosure(page, 'preflight')
    await caseRun('UX-ICONS', async () => { await action(page, 'more-actions').focus(); const layout = await page.evaluate(layoutDomProbe); return { buttons: layout.buttons.filter(b => topActions.includes(b.id)) } })
    await caseRun('UX-TOOLTIP', async () => ({ tooltips: [await tooltip('save-layout', 'hover'), await tooltip('save-layout', 'focus')] }))
    await caseRun('UX-DISABLED', async () => {
      const before = await state(), initialRequests = ui.requests.length
      const candidate = await action(page, 'undo').isDisabled() ? 'undo' : 'redo', target = action(page, candidate), tip = await tooltip(candidate, 'focus')
      ensure(await target.isDisabled(), 'disabled history action not available in original terminal fixture')
      await page.keyboard.press('Enter')
      const bubble = page.locator(`[data-bp-tooltip="${candidate}"]`), reason = await bubble.locator('small').textContent()
      return { before, after: await state(), executionRequests: ui.requests.slice(initialRequests).filter(r => ['startRun', 'cancelRun', 'decide', 'saveDefinition'].includes(r.method)).length,
        actions: [{ disabled: await target.isDisabled(), ariaDisabled: await target.getAttribute('aria-disabled'), name: await target.getAttribute('aria-label'), reason, tooltip: tip.text, tooltipVisible: await bubble.isVisible() }] }
    })
    await caseRun('UX-BLUEPRINT', async () => {
      await page.locator('[data-bp-select="blueprint"]').focus()
      return root(page).evaluate(el => {
        const items = el.querySelectorAll('[data-bp-select="blueprint"]'), item = items[0]
        const visible = node => !!node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0
          && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden'
        const pane = selector => { const nodes = el.querySelectorAll(selector); return { count: nodes.length, mounted: nodes[0]?.isConnected === true, visible: visible(nodes[0]) } }
        return { count: items.length, inToolbar: !!item?.closest('.bp-toolbar'), visible: visible(item),
          toggles: [...el.querySelectorAll('[data-bp-action="toggle-library"], [data-bp-action="toggle-inspector"]')].map(node => node.getAttribute('data-bp-action')),
          library: pane('.bp-library'), inspector: pane('.bp-inspector'), name: item?.getAttribute('aria-label') }
      })
    })
    await caseRun('UX-MORE', async () => {
      const actions = [], groups = []
      for (const group of ['files', 'view', 'tools']) {
        await preparePublicAction(page, Object.keys(MORE_ACTION_GROUPS).find(id => MORE_ACTION_GROUPS[id] === group))
        const trigger = page.locator(`[data-bp-menu-group="${group}"]`), submenu = page.locator(`[data-bp-submenu="${group}"]`)
        groups.push({ id: group, haspopup: await trigger.getAttribute('aria-haspopup'), expanded: await trigger.getAttribute('aria-expanded'), role: await submenu.getAttribute('role') })
        for (const [id, expected] of Object.entries(MORE_ACTION_GROUPS)) if (expected === group) {
          const entry = action(page, id), reason = entry.locator(`[data-bp-disabled-reason="${id}"]`)
          actions.push({ id, group, visible: await entry.isVisible(), name: await entry.getAttribute('aria-label'), disabled: await entry.isDisabled(),
            ariaDisabled: await entry.getAttribute('aria-disabled'), reason: await reason.count() ? await reason.textContent() : '', reasonVisible: await reason.isVisible() })
        }
        await closePublicMore(page)
      }
      return { actions, groups }
    })
    await caseRun('UX-MENU', async () => {
      const groups = [], commands = []
      await nodeTitle().click(); await nodeTitle().click({ button: 'right' })
      for (const group of ['appearance', 'layout']) {
        if (group === 'layout') {
          await closeContext(); await page.locator('.react-flow__node[data-id="out"] .bp-node-title').click({ modifiers: ['ControlOrMeta'] }); await nodeTitle().click({ button: 'right' })
        }
        const submenu = await openPublicSubmenu(page, menu(), group), trigger = menu().locator(`[data-bp-menu-group="${group}"]`)
        groups.push({ id: group, haspopup: await trigger.getAttribute('aria-haspopup'), expanded: await trigger.getAttribute('aria-expanded'), role: await submenu.getAttribute('role'), visible: await submenu.isVisible() })
        for (const [command, expected] of Object.entries(OBJECT_COMMAND_GROUPS)) if (expected === group) {
          const entry = submenu.locator(`[data-bp-menu-command="${command}"]`), reason = entry.locator(`[data-bp-disabled-reason="${command}"]`)
          commands.push({ command, group, visible: await entry.isVisible(), name: await entry.getAttribute('aria-label'), disabled: await entry.isDisabled(),
            ariaDisabled: await entry.getAttribute('aria-disabled'), reason: await reason.count() ? await reason.textContent() : '', reasonVisible: await reason.isVisible() })
        }
      }
      await closeContext(); return { groups, commands }
    })
    await caseRun('UX-FOCUS', async () => {
      const before = await state()
      await action(page, 'more-actions').click()
      const parent = page.locator('[data-bp-menu-group="files"]')
      await openPublicSubmenu(page, page.locator('[data-bp-overlay="more-menu"]'), 'files', { keyboard: true })
      const inLevel = () => page.evaluate(() => document.activeElement?.getAttribute('data-bp-menu-level') === 'files')
      const rightOpened = await inLevel(), navigation = []
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) { await page.keyboard.press(key); navigation.push({ key, inCurrentLevel: await inLevel() }) }
      await page.keyboard.press('ArrowLeft')
      const parentFocused = () => parent.evaluate(el => document.activeElement === el)
      const leftRestoredParent = await parentFocused()
      await page.keyboard.press('ArrowRight'); await page.keyboard.press('Escape'); const escapeRestoredParent = await parentFocused()
      await page.keyboard.press('Escape'); const secondEscapeRestoredInitiator = await action(page, 'more-actions').evaluate(el => document.activeElement === el)
      return { before, after: await state(), rightOpened, navigation, leftRestoredParent, escapeRestoredParent, secondEscapeRestoredInitiator }
    })
    await caseRun('UX-BOUNDARY', async () => { await nodeTitle().click({ button: 'right' }); await openPublicSubmenu(page, menu(), 'appearance'); const f = await boundsFacts({ overlay: 'context-menu', group: 'appearance' }); await closeContext(); return f })
    await caseRun('UX-PALETTE', async () => {
      const entries = []
      await page.locator('[data-bp-palette-search]').fill('')
      for (const kind of PALETTE_KINDS) {
        const entry = action(page, `add-${kind}`)
        await entry.hover(); const description = page.locator(`[data-bp-tooltip="add-${kind}"]`); await description.waitFor({ state: 'visible' })
        entries.push({ kind, visible: await entry.isVisible(), name: await entry.locator('strong').textContent(), icon: await entry.locator('svg[data-bp-icon]').count() === 1,
          description: await description.textContent(), descriptionVisible: await description.isVisible() })
      }
      return { entries }
    })
    await caseRun('UX-DISCLOSURE', async () => {
      const before = await state(), disclosures = []
      // Weak references observe existing children; they neither mount nor mutate them.
      await root(page).evaluate(el => { window.__bpCompactChildren = Object.fromEntries(['preflight', 'run'].map(id => [id, [...el.querySelector(`[data-bp-disclosure="${id}"]`).children]])) })
      for (const id of ['preflight', 'run']) {
        await setPublicDisclosure(page, id, false)
        const details = page.locator(`[data-bp-disclosure="${id}"]`), folded = await details.getAttribute('open') === null
        await setPublicDisclosure(page, id, true)
        disclosures.push(await details.evaluate((el, { id, folded }) => ({ id, folded, expanded: el.open, tag: el.tagName, summaryTag: el.querySelector('summary')?.tagName,
          summary: el.querySelector('summary')?.textContent, childrenRetained: window.__bpCompactChildren[id].every(child => child.isConnected && child.parentElement === el) }), { id, folded }))
      }
      await page.evaluate(() => { delete window.__bpCompactChildren }); return { before, after: await state(), disclosures }
    })
    await caseRun('UX-RETENTION', foldFacts)
    if (planId === HOST_CONTROLS_PLAN_ID) {
      for (const spec of HOST_CONTROL_CASES) await caseRun(spec.id, () => collectHostControlFacts(page, { id: spec.id, state, ui, events, dir }))
    }
    await caseRun('UX-RETENTION-WAITING', async () => {
      await prepareRunInput(page); await page.locator('[data-bp-run-input]').fill('{"compactRetention":true}')
      await action(page, 'start-run').click(); await page.locator('[data-bp-run="waiting_input"]').waitFor({ state: 'visible' })
      return foldFacts()
    })
    await caseRun('UX-TOP-ROW', async () => { await action(page, 'more-actions').focus(); return page.evaluate(layoutDomProbe) })
    await caseRun('UX-THEMES', async () => {
      await prepareHostControlView(page)
      const themes = [], before = await state()
      for (const locale of ['zh', 'en']) for (const scheme of ['light', 'dark']) {
        await setPublicNativeLocale(page, locale); await setNativeTheme(page, scheme)
        const layout = await page.evaluate(layoutDomProbe), screenshot = join(dir, `compact-${locale}-${scheme}.png`)
        await page.screenshot({ path: screenshot, fullPage: true })
        themes.push({ locale, scheme, width: layout.width, height: layout.height, overflow: layout.pageOverflow, before, after: await state(), screenshot, sha256: sha256(readFileSync(screenshot)) })
      }
      return { themes }
    })
    await caseRun('UX-NARROW', async () => {
      await page.setViewportSize({ width: 1100, height: 1100 }); await action(page, 'more-actions').click(); await openPublicSubmenu(page, page.locator('[data-bp-overlay="more-menu"]'), 'files')
      const f = await boundsFacts({ overlay: 'more-menu', group: 'files' }), screenshot = join(dir, 'compact-narrow-1100.png')
      await page.screenshot({ path: screenshot, fullPage: true }); await closePublicMore(page)
      return { ...f, screenshot, sha256: sha256(readFileSync(screenshot)) }
    })
    await caseRun('UX-ZERO-PROVIDER', async () => { await action(page, 'more-actions').click(); await closePublicMore(page); return { keyRead: false, providerCalls: ui.providerCalls, defaultProfilesRead: false } })
    ui.finishedAt = new Date().toISOString(); save(); return ui
  } catch (error) {
    ui.failure = { phase: ui.phase, message: redactProbeEvidenceText(error.message), at: new Date().toISOString() }
    ui.finishedAt = new Date().toISOString(); save(); throw error
  } finally {
    page.off('request', observeRequest); await page.evaluate(() => window.__bpCompactStop?.()).catch(() => {})
  }
}
export async function runCanvasJourney(page, record, api) {
  await setPublicNativeLocale(page, 'en')
  const base = await originalJourney(page, record, api)
  return { ...base, compactUX: await runCompactJourney(page, record, api) }
}
function screenshotEvidence(dir, item, expectedWidth) {
  ensure(fileInside(dir, item?.screenshot), 'compact screenshot missing/physically outside report')
  const bytes = readFileSync(item.screenshot)
  ensure(bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && bytes.readUInt32BE(16) === expectedWidth && bytes.readUInt32BE(20) >= 1100 && sha256(bytes) === item.sha256, 'compact screenshot hash/PNG/native dimensions mismatch')
}
export function validateCompactReport(report, context) {
  const { reportDir, invokedAt, finishedAt, packageRoot = PLUGIN, planId = PLAN_ID } = context
  ensure(Number.isFinite(invokedAt) && Number.isFinite(finishedAt) && finishedAt >= invokedAt, 'compact invocation timestamps missing/invalid')
  ensure(reportPathAllowed(planId, 'compact', reportDir, { physical: true }) && existsSync(reportDir), 'compact W2 physical report isolation required')
  ensure(fileInside(reportDir, report?.artifacts?.sidebar_screenshot) && fileInside(join(reportDir, 'tools'), report?.artifacts?.host_tools_contract?.reportPath), 'compact original screenshot/tools physical isolation missing')
  const original = validateCanvasReport(report, { mode: 'browser', planId, reportDir, packageRoot, invokedAt, finishedAt })
  const { environment: env, artifacts } = report, ui = artifacts.canvas_journey?.compactUX, native = artifacts.motion_browser
  ensure(supportsDshVersion(env.dsh_version_output) && env.platform === 'darwin/arm64' && /^v\d+\./.test(env.node ?? '') && text(env.browser_version)
    && isAbsolute(env.temp_root ?? '') && /(?:^|\/)xuanling-bp-probe-[^/]+$/.test(env.temp_root), 'compact real isolated native environment missing')
  ensure(artifacts.auth_cookie_set === true && artifacts.index_has_boot === true && artifacts.client_bundle?.status === 200 && artifacts.client_bundle.closure === true
    && artifacts.boot_entries?.some(e => e.id === BLUEPRINT_PACKAGE) && !artifacts.browser_error, 'compact authenticated actual DSH boot/closure missing')
  ensure(native?.kind === 'owned native Edge CDP' && native.noDefaults === true && native.defaultContext === true && native.closed === true && native.profileRemoved === true
    && Number.isSafeInteger(native.pid) && native.pid > 0 && inside(env.temp_root, native.profile) && native.args?.includes(`--user-data-dir=${native.profile}`)
    && native.args.includes('--headless=new') && native.args.includes('--remote-debugging-port=0'), 'compact owned native browser/cleanup provenance missing')
  ensure(!ui?.failure, 'compact mounted journey failed')
  const mounted = validateCompactReceipt(ui, { startedAt: Date.parse(report.started_at), finishedAt: Date.parse(report.finished_at), assertions: report.assertions, planId })
  for (const theme of ui.cases.find(c => c.id === 'UX-THEMES').facts.themes) screenshotEvidence(reportDir, theme, 1700)
  screenshotEvidence(reportDir, ui.cases.find(c => c.id === 'UX-NARROW').facts, 1100)
  if (planId === HOST_CONTROLS_PLAN_ID) for (const spec of HOST_CONTROL_CASES)
    for (const theme of ui.cases.find(c => c.id === spec.id).facts.themes) screenshotEvidence(reportDir, theme, 1700)
  return { ok: true, original, ...mounted, assertions: report.assertions.length, providerEvidence: false, nativeClipboardEvidence: false }
}
export function validateCollectorGate(report, context) {
  const { processResult, fingerprint, fingerprintAfter, provenance, expectedProvenance } = context
  const fpValid = f => /^[a-f0-9]{40}$/.test(f?.revision ?? '') && /^[a-f0-9]{64}$/.test(f?.source_sha256 ?? '') && /^[a-f0-9]{64}$/.test(f?.artifact_sha256 ?? '')
  ensure(processResult?.status === 0 && !processResult.error && !processResult.signal, 'compact native probe subprocess failed/unavailable')
  ensure(fpValid(fingerprint) && fpValid(fingerprintAfter) && same(fingerprint, fingerprintAfter), 'compact source/artifact fingerprint changed/missing')
  ensure(provenance && expectedProvenance && same(provenance, expectedProvenance) && provenance.planId === (context.planId ?? PLAN_ID) && provenance.keyRead === false && provenance.providerCalls === 0
    && same(provenance.performanceBudget, PERFORMANCE_BUDGET), 'compact probe/adapter/dependency provenance or original budgets changed')
  for (const key of ['probeSha256', 'adapterSha256', 'collectorSha256', 'entrySha256', 'canvasJourneySha256', 'motionCollectorSha256', 'comfyCollectorSha256'])
    ensure(/^[a-f0-9]{64}$/.test(provenance[key] ?? ''), `compact provenance ${key} missing`)
  return validateCompactReport(report, context)
}
async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    console.log(`node --experimental-transform-types ${join(HERE, 'compact-ux-ui.mjs')} --plan-id ${PLAN_ID} --report-dir <absolute-NEW-directory-under-docs/validation/blueprint/current/compact-ux/w2>\nHost controls mode: --plan-id ${HOST_CONTROLS_PLAN_ID} --report-dir <absolute-NEW-directory-under-docs/validation/blueprint/current/host-controls/w2>\nMain review, official build and owned freeze required before native launch. Isolated actual DSH 0.2.1-rc.2 and installed Microsoft Edge, Playwright, darwin/arm64, owned CDP noDefaults/default context. Original Host/browser assertions and 200/300/20, 2000ms/100ms performance export preserved. Fixed ${UX_CASES.length} compact cases plus ${HOST_CONTROL_CASES.length} required host-control cases in host mode, 1700px one row, four native themes and 1100px screenshot, complete durable Run/Host/draft/exact viewport facts. No keys/default profiles/provider or OS clipboard access. Missing case, stale provenance, process failure or escaping path fails nonzero. Run original Comfy and motion CLIs separately with this same explicit plan in fresh W2 directories.`)
    return
  }
  ensure(!existsSync(options.reportDir), 'compact report directory already exists; fresh output required')
  ensure(reportPathAllowed(options.planId, 'compact', options.reportDir, { physical: true }), 'compact report parent escapes physically')
  mkdirSync(options.reportDir, { recursive: true })
  const probe = join(HERE, 'probe.mjs'), driver = join(options.reportDir, 'isolated-compact-probe.mjs')
  writeFileSync(driver, adaptProbe(readFileSync(probe, 'utf8')))
  const current = () => ({ planId: options.planId, keyRead: false, providerCalls: 0, performanceBudget: PERFORMANCE_BUDGET,
    probeSha256: sha256(readFileSync(probe)), adapterSha256: sha256(readFileSync(driver)), collectorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    entrySha256: sha256(readFileSync(join(HERE, 'compact-ui-entry.mjs'))), canvasJourneySha256: sha256(readFileSync(join(HERE, 'canvas-journey.mjs'))),
    motionCollectorSha256: sha256(readFileSync(join(HERE, 'comfy-motion-ui.mjs'))), comfyCollectorSha256: sha256(readFileSync(join(HERE, 'comfy-interactions-ui.mjs'))) })
  const provenance = current(), fingerprint = captureEvidenceFingerprint(), invokedAt = Date.now()
  writeFileSync(join(options.reportDir, 'driver-provenance.json'), stringifyProbeEvidence(provenance))
  const env = { BP_COMFY_ARTIFACT_DIR: options.reportDir, BP_MOTION_ARTIFACT_DIR: options.reportDir, BP_COLLECTOR_PLAN_ID: options.planId }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']) if (process.env[key] !== undefined) env[key] = process.env[key]
  const argv = [process.execPath, driver, `--plugin-dir=${PLUGIN}`, '--expect=blueprint', '--canvas-test=browser', `--report-dir=${options.reportDir}`, `--plan-id=${options.planId}`]
  const cwd = join(ROOT, 'test/blueprint'), run = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 20 * 60_000, maxBuffer: 30 * 1024 * 1024 })
  writeFileSync(join(options.reportDir, 'driver.stdout.log'), redactProbeEvidenceText(run.stdout ?? '')); writeFileSync(join(options.reportDir, 'driver.stderr.log'), redactProbeEvidenceText(run.stderr ?? ''))
  const finishedAt = Date.now(), fingerprintAfter = captureEvidenceFingerprint()
  let gate
  try {
    ensure(same(provenance, JSON.parse(readFileSync(join(options.reportDir, 'driver-provenance.json'), 'utf8'))), 'persisted compact provenance replaced')
    gate = validateCollectorGate(JSON.parse(readFileSync(join(options.reportDir, 'w0.2-probe-report.json'), 'utf8')), { processResult: run, fingerprint, fingerprintAfter, provenance,
      expectedProvenance: current(), planId: options.planId, reportDir: options.reportDir, invokedAt, finishedAt })
  } catch (error) { gate = { ok: false, error: redactProbeEvidenceText(error.message) } }
  writeFileSync(join(options.reportDir, 'compact-ux-gate.json'), stringifyProbeEvidence({ planId: options.planId, passed: gate.ok === true, gate, argv, cwd,
    startedAt: new Date(invokedAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(), exitCode: run.status, signal: run.signal, processError: run.error?.code ?? null,
    provenance, fingerprint, fingerprintAfter, keyRead: false, providerCalls: 0, nativeClipboardEvidence: false, reportDir: options.reportDir }))
  console.log(stringifyProbeEvidence({ passed: gate.ok === true, gate, reportDir: options.reportDir })); process.exitCode = gate.ok === true ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { console.error(redactProbeEvidenceText(error.message)); process.exitCode = 1 }
}
