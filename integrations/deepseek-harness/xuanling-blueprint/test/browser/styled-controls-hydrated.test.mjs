import { selectStyledOption } from '../../../../../test/blueprint/capabilities/styled-control-entry.mjs'
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
        name: 'controls-fixture',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url?.split('?')[0] !== '/') return next()
            res.setHeader('Content-Type', 'text/html')
            res.end('<!doctype html><div id="root"></div><script type="module" src="/test/browser/styled-controls.fixture.ts"></script>')
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
  await page.getByRole('combobox', { name: 'Example' }).waitFor()
})
after(async () => {
  await browser?.close()
  await server?.close()
  if (home) rmSync(home, { recursive: true, force: true })
})
const combo = () => page.getByRole('combobox', { name: 'Example' })
const value = () => page.locator('#value').textContent()

test('hydrated combobox preserves raw values, disabled options, keyboard walk/typeahead and no canvas key leakage', async () => {
  await combo().focus()
  await combo().press('ArrowDown')
  assert.equal(await combo().getAttribute('aria-expanded'), 'true')
  await combo().press('b')
  assert.equal(await value(), 'alpha raw / value', 'walking never changes the selected value')
  await combo().press('Enter')
  assert.equal(await value(), 'beta')
  await combo().press('Home')
  const active = await combo().getAttribute('aria-activedescendant')
  assert.equal(await page.locator(`[id="${active}"]`).textContent(), 'Alpha')
  await combo().press('Enter')
  assert.equal(await value(), 'alpha raw / value')
  await combo().press('Space')
  await combo().press('End')
  await combo().press('Escape')
  assert.equal(await value(), 'alpha raw / value')
  await combo().press('a')
  await combo().press('l')
  const typed = await combo().getAttribute('aria-activedescendant')
  assert.match(await page.locator(`[id="${typed}"]`).textContent(), /^Alpine/)
  await combo().press('Tab')
  assert.equal(await combo().getAttribute('aria-expanded'), 'false')
  assert.equal(await value(), 'alpha raw / value')
  assert.equal(await page.locator('#keys').textContent(), '1', 'only Tab continues to surrounding focus trap; editing keys stay local')
})

test('list top layer escapes clipping, stays bounded, scrolls long lists, and closes outside/disabled including nested fieldsets', async () => {
  await combo().click()
  const list = page.getByRole('listbox', { name: 'Example' })
  assert.equal(await list.evaluate(el => el.matches(':popover-open')), true)
  const bounds = await list.boundingBox()
  assert.ok(bounds.height <= 320 && bounds.y + bounds.height <= 900 && bounds.x >= 0)
  await combo().press('End')
  assert.equal(await list.getByRole('option').last().isVisible(), true)
  assert.ok(await list.evaluate(el => el.scrollTop > 0))
  await page.mouse.click(1000, 20)
  assert.equal(await list.count(), 0)
  await page.locator('#toggle-disabled').click()
  assert.equal(await combo().isDisabled(), true)
  await page.locator('#toggle-disabled').click()
  await combo().click()
  // Disable the outer fieldset without moving focus or sending an outside click.
  await combo().evaluate(el => {
    el.closest('fieldset').parentElement.disabled = true
  })
  await list.waitFor({ state: 'detached' })
  assert.equal(await combo().isDisabled(), true)
})

test('confirmation defaults to Cancel, traps focus, cancels on Escape/backdrop and returns focus; confirm calls once', async () => {
  const open = page.locator('#open-confirm')
  await open.click()
  const dialog = page.getByRole('dialog', { name: 'Confirm action' })
  assert.equal(await dialog.getByRole('button', { name: 'Cancel' }).evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.getByRole('button', { name: 'Confirm', exact: true }).evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Tab')
  await page.keyboard.press('Escape')
  assert.equal(await dialog.count(), 0)
  assert.equal(await open.evaluate(el => el === document.activeElement), true)
  assert.equal(await page.locator('#accepted').textContent(), '0')
  await open.click()
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
  assert.equal(await page.locator('#accepted').textContent(), '1')
})

test('actual production resource dialog: select Escape closes only nested list, second Escape cancels dialog', async () => {
  await page.locator('[data-bp-action="new-blueprint"]').click()
  await page.locator('[data-bp-action="add-resource"]').click()
  const dialog = page.locator('[data-bp-resource-dialog]')
  const kind = dialog.getByRole('combobox', { name: 'Resource type' })
  for (const control of [page.locator('[data-bp-select="blueprint"]'), kind]) {
    assert.deepEqual(
      await control.evaluate(el => {
        const style = getComputedStyle(el)
        return { justify: style.justifyContent, align: style.textAlign }
      }),
      { justify: 'space-between', align: 'left' },
      'actual toolbar/resource trigger overrides host generic button centering'
    )
  }
  await kind.click()
  await page.getByRole('option', { name: 'MCP', exact: true }).click()
  assert.equal(await kind.getAttribute('data-bp-value'), 'mcp')
  assert.equal(await kind.getAttribute('aria-expanded'), 'false')
  await kind.click()
  await kind.press('End')
  await kind.press('Escape')
  assert.equal(await kind.getAttribute('aria-expanded'), 'false')
  assert.equal(await dialog.count(), 1)
  await kind.press('Escape')
  assert.equal(await dialog.count(), 0)
})

test('theme screenshots show production dropdown and confirmation in light/dark palettes', async () => {
  const evidence = process.env.BP_CONTROLS_EVIDENCE
  for (const theme of ['light', 'dark']) {
    await page
      .locator('.bp-workspace')
      .first()
      .evaluate((el, theme) => {
        const tokens =
          theme === 'dark'
            ? { bg: '#151619', raised: '#23252a', text: '#eceef2', muted: '#9ca1ad', accent: '#7c9bff' }
            : { bg: '#fafafa', raised: '#ffffff', text: '#202127', muted: '#737782', accent: '#4065d5' }
        for (const [key, value] of Object.entries(tokens)) el.style.setProperty(`--bp-${key}`, value)
      }, theme)
    await combo().click()
    const list = page.getByRole('listbox', { name: 'Example' })
    assert.equal(await list.evaluate(el => getComputedStyle(el).backgroundColor), theme === 'dark' ? 'rgb(35, 37, 42)' : 'rgb(255, 255, 255)')
    if (evidence) await page.screenshot({ path: `${evidence}/select-${theme}.png` })
    await combo().press('Escape')
    await page.locator('#open-confirm').click()
    if (evidence) await page.screenshot({ path: `${evidence}/confirmation-${theme}.png` })
    await page.keyboard.press('Escape')
  }
})

test('narrow viewport places a bottom-edge long list above the trigger without horizontal overflow', async () => {
  await page.setViewportSize({ width: 360, height: 520 })
  try {
    await page
      .locator('.bp-workspace')
      .first()
      .evaluate(el => Object.assign(el.style, { position: 'fixed', bottom: '0', left: '0', width: '360px', height: '120px', zIndex: '100' }))
    await combo().click()
    const bounds = await page.getByRole('listbox', { name: 'Example' }).boundingBox()
    const anchor = await combo().boundingBox()
    assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= 352)
    assert.ok(bounds.y >= 8 && bounds.y + bounds.height <= anchor.y, 'limited space below chooses upward placement')
    await combo().press('End')
    await combo().press('Enter')
    assert.equal(await value(), 'long-69')
  } finally {
    await page.setViewportSize({ width: 1100, height: 900 })
  }
})

test('delayed production library exposes unavailability until catalog arrives, then collector selection waits for one actionable click', async () => {
  await page.goto(`${url}/?delayed-catalog`)
  const picker = page.locator('[data-bp-select="blueprint"]')
  await picker.waitFor()
  await page.waitForFunction(() => window.delayedCalls.includes('catalog:waiting'))
  assert.equal(await picker.isDisabled(), true, 'empty library cannot open a list and must be observably unavailable before catalog readiness')
  const selecting = selectStyledOption(page, picker, 'delayed-blueprint')
  await page.locator('#release-catalog').click()
  await selecting
  assert.equal(await picker.getAttribute('data-bp-value'), 'delayed-blueprint')
  assert.deepEqual(await page.evaluate(() => window.delayedCalls), ['catalog:waiting', 'catalog:ready', 'load:delayed-blueprint'])
})
