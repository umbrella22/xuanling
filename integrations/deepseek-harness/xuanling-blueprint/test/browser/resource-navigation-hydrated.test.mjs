// Actual browser + React DOM client + production controls/Panel; synthetic data, no Host/provider calls.
import assert from 'node:assert/strict'
import { before, after, beforeEach, test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
const requireHarness = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = requireHarness('playwright')
let server, browser, page, home, url
before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../..', import.meta.url)),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        'react',
        'react-dom/client',
        '@xyflow/react',
        'zod',
        '@codemirror/view',
        '@codemirror/state',
        '@codemirror/commands',
        '@codemirror/lang-json',
        '@codemirror/language'
      ]
    },
    plugins: [
      {
        name: 'resource-navigation-fixture',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== '/') return next()
            res.setHeader('Content-Type', 'text/html')
            res.end('<!doctype html><div id="root"></div><script type="module" src="/test/browser/resource-navigation.fixture.ts"></script>')
          })
        }
      }
    ]
  })
  await server.listen()
  url = `http://127.0.0.1:${server.httpServer.address().port}`
  home = mkdtempSync(join(tmpdir(), 'bp-controls-hydrated-'))
  browser = await chromium.launch({ channel: 'msedge', headless: true, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home } })
  page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
  page.on('pageerror', error => console.error(error.message))
})
beforeEach(async () => {
  await page.goto(url)
  await page.locator('[data-bp-select="blueprint"]').waitFor()
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await choose('alpha')
})
after(async () => {
  await browser?.close()
  await server?.close()
  if (home) rmSync(home, { recursive: true, force: true })
})

const select = () => page.locator('[data-bp-select="blueprint"]')
// Deliberately never auto-confirm navigation; every test observes the production dialog.
async function choose(value) {
  await select().click()
  await page.locator(`[role="option"][data-bp-option-value="${value}"]`).click()
}
const dialog = () => page.locator('[data-bp-resource-dialog]')
const toggle = kind => page.locator(`[data-bp-resource-toggle="${kind}"]`)
const dirty = () => page.locator('[data-bp-dirty]').getAttribute('data-bp-dirty')
const snapshotStorage = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort()))

test('C-03 production resource fields pair at 720px and stack in narrow viewport and narrow parent; editors/actions remain bounded', async t => {
  await page.setViewportSize({ width: 2239, height: 1514 })
  await page.locator('[data-bp-action="add-resource"]').click()
  const fields = () => dialog().locator('.bp-resource-fields>label.bp-field')
  const geometry = async () => ({
    dialog: await dialog().boundingBox(),
    fields: await fields().evaluateAll(els =>
      els.map(el => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, bottom: r.bottom }
      })
    ),
    overflow: await dialog().evaluate(el => el.scrollWidth > el.clientWidth)
  })
  const wide = await geometry()
  t.diagnostic(JSON.stringify({ wide }))
  assert.ok(wide.dialog.width >= 710 && wide.dialog.width <= 730, `dialog width ${wide.dialog.width}`)
  assert.equal(wide.fields.length, 4)
  assert.ok(Math.abs(wide.fields[0].y - wide.fields[1].y) < 1)
  assert.ok(Math.abs(wide.fields[2].y - wide.fields[3].y) < 1)
  assert.ok(wide.fields[1].x > wide.fields[0].x && wide.fields[3].x > wide.fields[2].x)
  assert.equal(wide.overflow, false)
  const evidence = process.env.BP_RESOURCE_EVIDENCE
  for (const theme of ['light', 'dark']) {
    await page.locator('.bp-workspace').evaluate((el, theme) => {
      const tokens =
        theme === 'dark'
          ? { bg: '#151619', raised: '#23252a', text: '#eceef2', muted: '#9ca1ad', accent: '#7c9bff' }
          : { bg: '#fafafa', raised: '#ffffff', text: '#202127', muted: '#737782', accent: '#4065d5' }
      for (const [key, value] of Object.entries(tokens)) el.style.setProperty(`--bp-${key}`, value)
    }, theme)
    if (evidence) await page.screenshot({ path: `${evidence}/resource-dialog-2239-${theme}.png` })
  }
  for (const parentOnly of [false, true]) {
    await page.setViewportSize({ width: parentOnly ? 1100 : 390, height: 900 })
    if (parentOnly)
      await page.locator('#root>div').evaluate(el => {
        el.style.width = '390px'
      })
    const narrow = await geometry()
    t.diagnostic(JSON.stringify({ parentOnly, narrow }))
    assert.ok(narrow.dialog.width <= 358)
    assert.equal(narrow.overflow, false)
    for (let i = 1; i < 4; i++) assert.ok(narrow.fields[i].y >= narrow.fields[i - 1].bottom, 'narrow fields stack')
    assert.equal(
      await dialog()
        .locator('.bp-resource-configuration')
        .evaluate(el => {
          const term = el.querySelector('dt').getBoundingClientRect(),
            value = el.querySelector('dd').getBoundingClientRect()
          return value.y >= term.bottom && value.width > 280
        }),
      true,
      'narrow configuration descriptions and paths use full width below their labels'
    )
    const cm = dialog().locator('.cm-editor')
    assert.equal(await cm.count(), 1, 'production CodeMirror retained')
    if (evidence) await page.screenshot({ path: `${evidence}/resource-dialog-narrow-${parentOnly ? 'parent' : 'viewport'}-top.png` })
    await page.locator('[data-bp-action="resource-cancel"]').scrollIntoViewIfNeeded()
    assert.equal(await page.locator('[data-bp-action="resource-cancel"]').isVisible(), true)
    if (evidence) await page.screenshot({ path: `${evidence}/resource-dialog-narrow-${parentOnly ? 'parent' : 'viewport'}.png` })
  }
})

test('C-04 four production category buttons independently collapse by pointer/keyboard without draft/history changes; counts and tooltips survive', async () => {
  await page.setViewportSize({ width: 2239, height: 1514 })
  const before = { dirty: await dirty(), storage: await snapshotStorage(), undo: await page.locator('[data-bp-action="undo"]').isDisabled() }
  for (const kind of ['agent', 'skill', 'mcp', 'other']) {
    assert.equal(await toggle(kind).count(), 1, `${kind} accessible category button exists`)
    assert.equal(await toggle(kind).getAttribute('aria-expanded'), 'true')
    assert.match(await toggle(kind).textContent(), /\(1\)/)
    const target = await toggle(kind).getAttribute('aria-controls')
    assert.equal(await page.locator(`[id="${target}"]`).isVisible(), true)
    const rects = await toggle(kind).evaluate(el => {
      const label = el.querySelector('span'),
        arrow = el.querySelector('svg')
      return { label: label.getBoundingClientRect().x, arrow: arrow.getBoundingClientRect().x, expanded: arrow.dataset.bpExpanded }
    })
    assert.ok(rects.arrow > rects.label)
    assert.equal(rects.expanded, 'true')
    const arrowDirection = expanded =>
      page.waitForFunction(
        ({ kind, expanded }) => {
          const arrow = document.querySelector(`[data-bp-resource-toggle="${kind}"] svg`)
          const matrix = new DOMMatrix(getComputedStyle(arrow).transform)
          return expanded ? Math.abs(matrix.a) < 0.001 && Math.abs(matrix.b - 1) < 0.001 : Math.abs(matrix.a - 1) < 0.001 && Math.abs(matrix.b) < 0.001
        },
        { kind, expanded }
      )
    await arrowDirection(true)
    await toggle(kind).click()
    assert.equal(await toggle(kind).getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator(`[id="${target}"]`).isVisible(), false)
    assert.equal(await toggle(kind).locator('svg').getAttribute('data-bp-expanded'), 'false')
    await arrowDirection(false)
    if (kind === 'agent' && process.env.BP_RESOURCE_EVIDENCE)
      await page.screenshot({ path: `${process.env.BP_RESOURCE_EVIDENCE}/resource-category-collapsed-2239.png` })
    for (const other of ['agent', 'skill', 'mcp', 'other'].filter(k => k !== kind)) assert.equal(await toggle(other).getAttribute('aria-expanded'), 'true')
    await toggle(kind).press('Enter')
    assert.equal(await toggle(kind).getAttribute('aria-expanded'), 'true')
    await toggle(kind).press('Space')
    assert.equal(await toggle(kind).getAttribute('aria-expanded'), 'false')
    // Changing panel query is an ordinary rerender, not a definition edit.
    await page.getByRole('textbox', { name: 'Search nodes' }).fill('input')
    assert.equal(await toggle(kind).getAttribute('aria-expanded'), 'false')
    await toggle(kind).press('Enter')
  }
  assert.deepEqual({ dirty: await dirty(), storage: await snapshotStorage(), undo: await page.locator('[data-bp-action="undo"]').isDisabled() }, before)
  assert.equal(await page.locator('[data-bp-resource-row]').count(), 4)
  await page.locator('[data-bp-resource-row="blueprint:tools"]').hover()
  assert.equal(await page.locator('[data-bp-tooltip="resource-blueprint:tools"]').innerText(), 'Full synthetic description for retained resource tooltip.')
  if (process.env.BP_RESOURCE_EVIDENCE) await page.screenshot({ path: `${process.env.BP_RESOURCE_EVIDENCE}/resource-categories-2239.png` })
})

test('C-05 mounted production navigation requires semantic edits, supports undo/redo/cancel and restores nonempty draft across reload', async () => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  const name = () => page.getByRole('textbox', { name: 'Blueprint name', exact: true })
  await name().fill('Meaningful unsaved edit')
  await choose('beta')
  assert.equal(await page.locator('[data-bp-confirm-dialog]').count(), 1)
  await page.locator('[data-bp-confirm-cancel]').click()
  assert.equal(await select().getAttribute('data-bp-value'), 'alpha')
  await page.locator('[data-bp-action="undo"]').click()
  await choose('beta')
  assert.equal(await page.locator('[data-bp-confirm-dialog]').count(), 0)
  await page.waitForFunction(() => document.querySelector('[data-bp-select="blueprint"]')?.getAttribute('data-bp-value') === 'beta')
  await name().fill('Restored semantic edit')
  await page.reload()
  await select().waitFor()
  await choose('beta')
  await name().waitFor()
  assert.equal(await name().inputValue(), 'Restored semantic edit')
  await page.locator('[data-bp-action="new-blueprint"]').click()
  assert.equal(await page.locator('[data-bp-confirm-dialog]').count(), 1)
  await page.keyboard.press('Escape')
  assert.equal(await name().inputValue(), 'Restored semantic edit')
})

test('C-05 mounted empty draft, renamed/resources empty draft and restored empty draft leave without a dialog and keep draft bytes', async () => {
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.locator('[data-bp-action="new-blueprint"]').click()
  assert.equal(await page.locator('[data-bp-confirm-dialog]').count(), 0, 'saved unchanged leaves directly')
  await page.getByRole('textbox', { name: 'Blueprint name', exact: true }).fill('Empty renamed draft')
  await page.locator('[data-bp-action="add-resource"]').click()
  await dialog().getByRole('textbox', { name: 'New resource ID', exact: true }).fill('unsaved-agent')
  await page.locator('[data-bp-action="resource-apply"]').click()
  assert.equal(await page.locator('.react-flow__node-blueprint').count(), 0)
  assert.equal(await dirty(), 'true')
  const draft = await page.evaluate(() => localStorage.getItem('xuanling-blueprint:new-draft'))
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[data-bp-select="blueprint"]')?.getAttribute('data-bp-value')?.startsWith('draft-'))
  assert.equal(await dirty(), 'true', 'restored empty draft remains save-dirty')
  await choose('beta')
  assert.equal(await page.locator('[data-bp-confirm-dialog]').count(), 0, 'restored empty graph leaves directly')
  await page.waitForFunction(() => document.querySelector('[data-bp-select="blueprint"]')?.getAttribute('data-bp-value') === 'beta')
  assert.equal(await page.evaluate(() => localStorage.getItem('xuanling-blueprint:new-draft')), draft)
})

test('C-05 narrow resource cancel restores focus to current add trigger after responsive sidebar collapse', async () => {
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.locator('[data-bp-action="add-resource"]').click()
  const resource = dialog()
  await resource.getByRole('textbox', { name: /^(New resource ID|新资源 ID)$/, exact: true }).fill('cancelled-responsive-resource')
  const original = page.locator('[data-bp-action="add-resource"]')
  await page.setViewportSize({ width: 390, height: 900 })
  await resource.locator('[data-bp-action="resource-cancel"]').scrollIntoViewIfNeeded()
  await resource.locator('[data-bp-action="resource-cancel"]').click()
  assert.equal(await dialog().count(), 0)
  assert.equal(await page.locator('[data-bp-resource-row="blueprint:cancelled-responsive-resource"]').count(), 0)
  assert.equal(await page.locator('[data-bp-action="add-resource"]').evaluate(element => element === document.activeElement), true)
  assert.equal(await original.count(), 1)
  assert.equal(await page.locator('.bp-library').isVisible(), true, 'responsive sidebar is revealed before focus restoration')
  assert.equal(await page.locator('[data-bp-action="toggle-inspector"]').getAttribute('aria-expanded'), 'false')
})

test('C-05 narrow resource detail Close returns focus to its original card after responsive sidebar collapse', async () => {
  await page.setViewportSize({ width: 1100, height: 900 })
  if ((await page.locator('[data-bp-action="toggle-library"]').getAttribute('aria-expanded')) === 'false')
    await page.locator('[data-bp-action="toggle-library"]').click()
  const row = page.locator('[data-bp-resource-row="blueprint:tools"]')
  await row.click()
  await page.setViewportSize({ width: 390, height: 900 })
  await dialog().locator('[data-bp-action="resource-cancel"]').scrollIntoViewIfNeeded()
  await dialog().locator('[data-bp-action="resource-cancel"]').click()
  assert.equal(await dialog().count(), 0)
  assert.equal(await row.evaluate(element => element === document.activeElement), true)
  assert.equal(await page.locator('.bp-library').isVisible(), true)
  assert.equal(await page.locator('[data-bp-action="toggle-inspector"]').getAttribute('aria-expanded'), 'false')
})
