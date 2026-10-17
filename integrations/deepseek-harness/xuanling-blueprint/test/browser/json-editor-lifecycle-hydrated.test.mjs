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

test('JSON editor preserves lazy activation, raw drafts, controlled updates and disposal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bp-json-lifecycle-'))
  let server, browser
  try {
    server = await createServer({
      configFile: false,
      cacheDir: join(directory, 'vite-cache'),
      root: fileURLToPath(new URL('../../', import.meta.url)),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'] },
      plugins: [
        {
          name: 'json-editor-lifecycle',
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (request.url !== '/') return next()
              response.setHeader('Content-Type', 'text/html')
              response.end(
                '<!doctype html><button id="outside">Outside</button><details id="section" class="bp-workspace"><summary>Editor</summary><div id="mount"></div></details><script type="module" src="/test/browser/json-editor-lifecycle-hydrated.fixture.ts"></script>'
              )
            })
          }
        }
      ]
    })
    await server.listen()
    browser = await chromium.launch({ channel: 'msedge', headless: true, env: probeBrowserEnv(directory) })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    await page.waitForFunction(() => !!window.jsonLifecycle)
    const stats = () => page.evaluate(() => window.jsonLifecycle.stats())
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.locator('#section').evaluate(element => {
        element.open = false
      })
      await page.evaluate(() => window.jsonLifecycle.mount())
      assert.equal(await page.locator('.cm-editor').count(), 0, 'closed details must not allocate CodeMirror')
      assert.equal((await stats()).observers, 1)
      await page.locator('summary').click()
      const editor = page.getByRole('textbox', { name: 'JSON buffer', exact: true })
      await editor.waitFor()
      assert.equal(await page.evaluate(() => window.jsonLifecycle.capture()), true)
      assert.equal((await stats()).observers, 0)
      assert.equal(await editor.innerText(), '{"initial":1}')
      await editor.fill('{invalid')
      await page.locator('[data-bp-json-valid="false"]').waitFor()
      await page.locator('[data-bp-action="format-json"]').click()
      assert.equal(await editor.innerText(), '{invalid', 'format must retain malformed buffer')
      assert.equal((await stats()).changes.at(-1).text, '{invalid')
      await page.evaluate(() => window.jsonLifecycle.update({ value: '{"external":2}', label: 'Current JSON' }, 'current'))
      const current = page.getByRole('textbox', { name: 'Current JSON', exact: true })
      await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent === '{"external":2}')
      assert.equal((await stats()).changes.at(-1).text, '{invalid', 'controlled update must not echo onChange')
      await page.locator('[data-bp-json-valid="true"]').waitFor()
      await current.fill('  {"原样":3}  ')
      assert.deepEqual((await stats()).changes.at(-1), { owner: 'current', text: '  {"原样":3}  ' })
      assert.equal(await page.locator('input[name="payload"]').inputValue(), '  {"原样":3}  ')
      await page.locator('#outside').click()
      assert.deepEqual((await stats()).blurs.at(-1), { owner: 'current', text: '  {"原样":3}  ' })
      await page.evaluate(() => window.jsonLifecycle.update({ disabled: true }))
      assert.equal(await page.locator('.cm-content').getAttribute('contenteditable'), 'false')
      assert.equal(await page.locator('[data-bp-action="format-json"]').isDisabled(), true)
      await page.evaluate(() => window.jsonLifecycle.unmount())
      assert.equal((await stats()).destroyed, true)
      assert.equal((await stats()).observers, 0)
      assert.equal(await page.locator('.cm-editor').count(), 0)
    }
    await page.locator('#section').evaluate(element => {
      element.open = false
    })
    await page.evaluate(() => window.jsonLifecycle.mount())
    assert.equal((await stats()).observers, 1)
    await page.evaluate(() => window.jsonLifecycle.unmount())
    assert.equal((await stats()).observers, 0, 'unmount before visibility releases pending observer')
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
