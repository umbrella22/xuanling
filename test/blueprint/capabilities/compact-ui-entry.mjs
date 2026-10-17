import { openNativeSettings } from './native-settings-journey.mjs'
/** Public input preparation only. Every activation uses Playwright's trusted
 * locator/keyboard path. evaluate is reserved for passive public observations. */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
export const HOST_CONTROLS_PLAN_ID = 'dsh-blueprint-host-controls-v1'
export const COMPACT_PLAN_ID = 'dsh-blueprint-compact-ux-v1'
export const COMFY_PLAN_ID = 'dsh-blueprint-comfy-interactions-v1'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const REPORTS = join(ROOT, 'docs/validation/blueprint/current')
export const MORE_ACTION_GROUPS = Object.freeze({ 'export-blueprint': 'files', 'import-blueprint': 'files',
  'motion-toggle': 'view', 'toggle-minimap': 'view', 'check-run': 'tools', 'refresh-library': 'tools', shortcuts: 'tools' })
export const OBJECT_COMMAND_GROUPS = Object.freeze({ 'color-default': 'appearance', 'color-blue': 'appearance', 'color-green': 'appearance',
  'color-amber': 'appearance', 'color-red': 'appearance', 'color-purple': 'appearance', 'align-left': 'layout', 'align-right': 'layout',
  'align-top': 'layout', 'align-bottom': 'layout', 'align-center-x': 'layout', 'align-center-y': 'layout', 'distribute-x': 'layout', 'distribute-y': 'layout' })
const requireFact = (ok, why) => { if (!ok) throw new Error(why) }
export function reportRoots(planId, mode) {
  if (planId === HOST_CONTROLS_PLAN_ID) {
    requireFact(['compact', 'comfy', 'motion'].includes(mode), 'explicit host-control collector mode required')
    return [join(REPORTS, 'host-controls/w2')]
  }
  if (planId === COMPACT_PLAN_ID) return [join(REPORTS, 'compact-ux/w2')]
  requireFact(planId === COMFY_PLAN_ID && ['comfy', 'motion'].includes(mode), 'explicit frozen plan ID required')
  return (mode === 'motion' ? ['w3', 'w4'] : ['w2']).map(wave => join(REPORTS, 'comfy-interactions', wave))
}
export function reportPathAllowed(planId, mode, path, { physical = false } = {}) {
  if (!isAbsolute(path ?? '') || ([COMPACT_PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(planId) && path !== resolve(path))) return false
  if (planId === HOST_CONTROLS_PLAN_ID && (path.trim() !== path || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) return false
  const inside = (root, target) => { const rel = relative(root, target); return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel) }
  const root = reportRoots(planId, mode).find(root => inside(root, resolve(path)))
  if (!root) return false
  // Existing ancestors are checked BEFORE callers create directories or read
  // reports. Compact mode never accepts a link in its owned report tree.
  if (physical || [COMPACT_PLAN_ID, HOST_CONTROLS_PLAN_ID].includes(planId)) {
    let ancestor = resolve(path)
    for (;;) {
      try { if (lstatSync(ancestor).isSymbolicLink()) return false; break }
      catch (error) { if (error.code !== 'ENOENT') return false; const parent = dirname(ancestor); if (parent === ancestor) return false; ancestor = parent }
    }
    let cursor = ancestor
    while (cursor !== REPORTS && inside(REPORTS, cursor)) {
      if (lstatSync(cursor).isSymbolicLink() || !lstatSync(cursor).isDirectory()) return false
      cursor = dirname(cursor)
    }
    if (cursor !== REPORTS || lstatSync(REPORTS).isSymbolicLink()) return false
    const canonicalReports = realpathSync(REPORTS), canonicalAncestor = realpathSync(ancestor)
    if (ancestor !== REPORTS && !inside(canonicalReports, canonicalAncestor)) return false
    if (existsSync(root) && existsSync(path) && !inside(realpathSync(root), realpathSync(path))) return false
  }
  return true
}
const action = (page, id) => page.locator(`[data-bp-action="${id}"]`)
export async function openPublicSubmenu(page, menu, group, { keyboard = false } = {}) {
  const trigger = menu.locator(`[data-bp-menu-group="${group}"]`)
  await trigger.waitFor({ state: 'visible' })
  requireFact(await trigger.getAttribute('aria-haspopup') === 'menu', `public ${group} trigger lacks menu ARIA`)
  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    if (keyboard) { await trigger.focus(); await page.keyboard.press('ArrowRight') }
    else await trigger.click()
  }
  const submenu = page.locator(`[data-bp-submenu="${group}"]`)
  await submenu.waitFor({ state: 'visible' })
  requireFact(await submenu.getAttribute('role') === 'menu', `public ${group} submenu lacks menu role`)
  return submenu
}
export async function preparePublicAction(page, id) {
  const target = action(page, id)
  if (await target.isVisible()) return target
  const group = MORE_ACTION_GROUPS[id]
  if (group && await action(page, 'more-actions').count()) {
    const menu = page.locator('[data-bp-overlay="more-menu"]')
    if (!await menu.isVisible()) await action(page, 'more-actions').click()
    await menu.waitFor({ state: 'visible' })
    await openPublicSubmenu(page, menu, group)
  } else if (['inspect-run', 'retry-inspect', 'cancel-run', 'approve', 'reject'].includes(id)) {
    await preparePublicDisclosure(page, 'run')
  }
  await target.waitFor({ state: 'visible' })
  return target
}
export async function clickPublicAction(page, id, options) {
  const target = await preparePublicAction(page, id)
  await target.click(options)
}
export async function preparePublicCommand(page, command) {
  const target = page.locator(`[data-bp-menu-command="${command}"]`)
  if (!await target.isVisible() && OBJECT_COMMAND_GROUPS[command]) {
    await openPublicSubmenu(page, page.locator('[data-bp-overlay="context-menu"]'), OBJECT_COMMAND_GROUPS[command])
  }
  await target.waitFor({ state: 'visible' })
  return target
}
export async function clickPublicCommand(page, command) { await (await preparePublicCommand(page, command)).click() }
export async function setPublicDisclosure(page, id, open) {
  const details = page.locator(`details[data-bp-disclosure="${id}"]`)
  if (!await details.count()) return false // Old, fully expanded layout.
  if ((await details.getAttribute('open') !== null) !== open) {
    await details.locator(`summary[data-bp-disclosure-toggle="${id}"]`).click()
  }
  requireFact((await details.getAttribute('open') !== null) === open, `public ${id} summary did not change disclosure`)
  return true
}
export async function preparePublicDisclosure(page, id) { return setPublicDisclosure(page, id, true) }
export async function closePublicMore(page) {
  const menu = page.locator('[data-bp-overlay="more-menu"]')
  if (!await menu.isVisible()) return
  // Escape returns from one submenu level, then restores the More initiator.
  await page.keyboard.press('Escape')
  if (await menu.isVisible()) await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden' })
}
export async function prepareRunInput(page) {
  await preparePublicDisclosure(page, 'run')
  await page.locator('[data-bp-run-input]').waitFor({ state: 'visible' })
}
/** Same native Settings menu, with public ARIA observation for icon chrome.
 * Original layout still uses the original text-labelled entry. */
export async function setPublicNativeLocale(page, id) {
  requireFact(['zh', 'en'].includes(id), 'unsupported acceptance locale')
  const modal = await openNativeSettings(page)
  const selected = modal.getByRole('button', { name: /^(中文|English)$/ }), label = id === 'zh' ? '中文' : 'English'
  if ((await selected.textContent()).trim() !== label) { await selected.click(); await page.getByRole('menuitem', { name: label, exact: true }).click() }
  await modal.getByText(id === 'zh' ? '语言' : 'Language', { exact: true }).waitFor({ state: 'visible' })
  await modal.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await modal.waitFor({ state: 'hidden' })
  const run = action(page, 'start-run')
  await run.waitFor({ state: 'visible' })
  requireFact(await run.getAttribute('aria-label') === (id === 'zh' ? '运行' : 'Run') || (await run.textContent()).trim() === (id === 'zh' ? '运行' : 'Run'), 'native locale did not reach public run entry')
}
