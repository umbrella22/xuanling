import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { probeBrowserEnv } from '../../../../../test/blueprint/capabilities/probe.mjs'
const requireHarness = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = requireHarness('playwright')

test('controls and overlays preserve focus, confirmation and effect cleanup across mounts', async () => {
  const browserDirectory = mkdtempSync(join(tmpdir(), 'bp-control-lifecycle-'))
  let server, browser
  try {
    server = await createServer({
      configFile: false,
      cacheDir: join(browserDirectory, 'vite-cache'),
      root: fileURLToPath(new URL('../../', import.meta.url)),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'zod'] },
      plugins: [
        {
          name: 'control-lifecycle',
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (request.url !== '/') return next()
              response.setHeader('Content-Type', 'text/html')
              response.end(
                '<!doctype html><button id="outside">Outside</button><div id="mount"></div><script type="module" src="/test/browser/control-lifecycle-hydrated.fixture.ts"></script>'
              )
            })
          }
        }
      ]
    })
    await server.listen()
    browser = await chromium.launch({ channel: 'msedge', headless: true, env: probeBrowserEnv(browserDirectory) })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    await page.waitForFunction(() => !!window.controlLifecycle)
    const resources = () => page.evaluate(() => window.controlLifecycle.resources())
    const empty = await resources()
    assert.deepEqual(empty, { listeners: [], resize: 0, mutation: 0 })
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => window.controlLifecycle.mount())
      await page.getByRole('combobox', { name: 'Lifecycle select' }).click()
      await page.getByRole('listbox').waitFor()
      const opened = await resources()
      assert.equal(opened.resize, 1)
      assert.equal(opened.mutation, 1)
      assert.ok(opened.listeners.includes('pointerdown') && opened.listeners.includes('resize'))
      await page.evaluate(() => {
        const trigger = document.querySelector('[role="combobox"]')
        trigger.closest('fieldset').disabled = true
        // Deliver the click before MutationObserver's microtask can close the
        // menu: selection must check the current native disabled state.
        document.querySelector('[data-bp-option-value="b"]').click()
      })
      assert.equal((await page.evaluate(() => window.controlLifecycle.actions())).changes, 0, 'disabled fieldset cannot commit a pending option click')
      await page.getByRole('listbox').waitFor({ state: 'detached' })
      await page.getByRole('combobox').evaluate(element => {
        element.closest('fieldset').disabled = false
      })
      await page.getByRole('combobox').click()
      await page.getByRole('listbox').waitFor()
      await page.evaluate(() => window.controlLifecycle.unmount())
      assert.deepEqual(await resources(), empty, 'unmount must release each browser effect')
      assert.equal(await page.getByRole('listbox').count(), 0)
      await page.locator('#outside').click()
      await page.evaluate(() => {
        window.dispatchEvent(new Event('resize'))
        window.dispatchEvent(new Event('scroll'))
      })
      assert.deepEqual(await page.evaluate(() => window.controlLifecycle.actions()), { accepted: 0, cancelled: cycle, changes: 0 })
      await page.evaluate(() => window.controlLifecycle.mount())
      await page.locator('#open-confirmation').click()
      await page.getByRole('dialog').waitFor()
      await page.locator('.bp-confirm-backdrop').click({ position: { x: 2, y: 2 } })
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await page.locator('#open-confirmation').evaluate(el => el === document.activeElement), true)
      assert.deepEqual(await page.evaluate(() => window.controlLifecycle.actions()), { accepted: 0, cancelled: cycle + 1, changes: 0 })
      await page.evaluate(() => window.controlLifecycle.unmount())
      assert.deepEqual(await resources(), empty)
    }
    await page.evaluate(() => window.controlLifecycle.mount('context-menu'))
    const appearance = page.locator('[data-bp-menu-group="appearance"]')
    await appearance.focus()
    await appearance.press('ArrowRight')
    const blue = page.locator('[data-bp-menu-command="color-blue"]')
    assert.equal(await blue.evaluate(element => element === document.activeElement), true)
    await blue.press('Escape')
    assert.equal(await appearance.evaluate(element => element === document.activeElement), true)
    assert.equal(await page.locator('[data-bp-submenu]').count(), 0)
    await appearance.press('Escape')
    assert.equal(await page.locator('[data-bp-overlay]').count(), 0)
    await page.evaluate(() => window.controlLifecycle.unmount())
    assert.deepEqual(await resources(), empty)

    await page.evaluate(() => window.controlLifecycle.mount('more-menu'))
    await page.locator('[data-bp-menu-group="files"]').click()
    await page.locator('[data-bp-action="fixture-copy"]').click()
    assert.deepEqual((await page.evaluate(() => window.controlLifecycle.overlayActions())).commands, ['more-copy'])
    await page.evaluate(() => window.controlLifecycle.unmount())
    assert.deepEqual(await resources(), empty)

    await page.evaluate(() => window.controlLifecycle.mount('node-search'))
    const search = page.locator('[data-bp-search-input]')
    await search.fill('output')
    await search.press('Enter')
    assert.deepEqual((await page.evaluate(() => window.controlLifecycle.overlayActions())).added, ['output'])
    await search.press('Escape')
    assert.equal(await page.locator('[data-bp-overlay]').count(), 0, 'search Escape closes even with a nonempty query')
    await page.evaluate(() => window.controlLifecycle.unmount())
    assert.deepEqual(await resources(), empty)

    await page.evaluate(() => window.controlLifecycle.mount('rename'))
    await page.locator('[data-bp-rename-field]').fill('  原样 title  ')
    await page.locator('[data-bp-action="rename-apply"]').click()
    assert.deepEqual((await page.evaluate(() => window.controlLifecycle.overlayActions())).names, ['  原样 title  '])
    await page.evaluate(() => window.controlLifecycle.unmount())
    assert.deepEqual(await resources(), empty)

    await page.evaluate(() => window.controlLifecycle.mount('import'))
    const file = page.locator('[data-bp-import-file]'),
      confirm = page.locator('[data-bp-import-confirm]'),
      apply = page.locator('[data-bp-action="import-apply"]')
    await file.setInputFiles({ name: 'first.zip', mimeType: 'application/zip', buffer: Buffer.from([0, 255, 128]) })
    assert.equal(await apply.isDisabled(), true)
    await confirm.check()
    assert.equal(await apply.isDisabled(), false)
    await file.setInputFiles({ name: 'second.zip', mimeType: 'application/zip', buffer: Buffer.from([255, 0]) })
    assert.equal(await confirm.isChecked(), false, 'changing the file invalidates confirmation')
    assert.equal(await apply.isDisabled(), true)
    assert.deepEqual((await page.evaluate(() => window.controlLifecycle.overlayActions())).imports, [])
    await confirm.check()
    await apply.click()
    assert.deepEqual((await page.evaluate(() => window.controlLifecycle.overlayActions())).imports, ['empty:second.zip'])
    await page.getByRole('combobox').click()
    assert.equal(await page.getByRole('option').filter({ hasText: 'Used' }).getAttribute('aria-disabled'), 'true')
    await page.evaluate(() => window.controlLifecycle.unmount())
    assert.deepEqual(await resources(), empty)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(browserDirectory, { recursive: true, force: true })
  }
})
