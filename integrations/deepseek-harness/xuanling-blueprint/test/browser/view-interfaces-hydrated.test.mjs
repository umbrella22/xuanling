// Real ReactDOM consumer of production Workspace, synthetic browser only.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { probeBrowserEnv } from '../../../../../test/blueprint/capabilities/probe.mjs'
const harness = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = harness('playwright')

test('hydrated view intents preserve valid controls and fence callbacks from replaced editors', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bp-view-interfaces-'))
  let server, browser
  try {
    server = await createServer({
      configFile: false,
      root: fileURLToPath(new URL('../../', import.meta.url)),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react-dom/client', 'zod'] },
      plugins: [
        {
          name: 'view-interfaces-fixture',
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/') return next()
              res.setHeader('Content-Type', 'text/html')
              res.end('<!doctype html><div id="root"></div><script type="module" src="/test/browser/view-interfaces-hydrated.fixture.ts"></script>')
            })
          }
        }
      ]
    })
    await server.listen()
    browser = await chromium.launch({ channel: 'msedge', headless: true, env: probeBrowserEnv(home) })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    await page.locator('#state').waitFor()
    const state = async () => JSON.parse(await page.locator('#state').innerText())
    await page.locator('#confirm-open').click()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.deepEqual((await state()).calls, ['load:a'])
    await page.locator('#confirm-open').click()
    await page.getByRole('button', { name: 'Confirm', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.querySelector('#state').textContent).id === 'b')
    await page.getByRole('combobox', { name: 'Blueprint' }).click()
    await page.getByRole('option', { name: 'a', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.querySelector('#state').textContent).id === 'a')
    await page.locator('#rename-open').click()
    await page.locator('[data-bp-rename-field]').fill('Renamed')
    await page.locator('[data-bp-action="rename-apply"]').click()
    assert.equal((await state()).name, 'Renamed')
    const editor = page.getByRole('textbox', { name: 'Outputs JSON', exact: true })
    await editor.fill('{invalid')
    await page.locator('#json-apply').click()
    assert.deepEqual((await state()).outputs, {})
    assert.ok((await state()).notice)
    await editor.fill('{"result":"string"}')
    await page.locator('#json-apply').click()
    assert.deepEqual((await state()).outputs, { result: 'string' })
    await editor.fill('{"cancelled":"number"}')
    await page.locator('#json-cancel').click()
    assert.deepEqual((await state()).outputs, { result: 'string' })
    await page.locator('#capture').click()
    await page.evaluate(() => window.viewInterfacesFixture.switchEditor())
    await page.waitForFunction(() => JSON.parse(document.querySelector('#state').textContent).name === 'Replacement')
    const before = await page.evaluate(() => window.viewInterfacesFixture.stats())
    await page.evaluate(() => window.viewInterfacesFixture.replay())
    assert.deepEqual(await page.evaluate(() => window.viewInterfacesFixture.stats()), before, 'old bindings cannot mutate replacement graph or invoke Host')
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(home, { recursive: true, force: true })
  }
})
