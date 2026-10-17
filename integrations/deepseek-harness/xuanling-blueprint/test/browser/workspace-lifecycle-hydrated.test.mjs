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

test('hydrated component remounts settle pending actions without old callbacks; owner dispose fences old sources and preserves second instance', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bp-workspace-lifecycle-'))
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
          name: 'workspace-lifecycle-fixture',
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/') return next()
              res.setHeader('Content-Type', 'text/html')
              res.end(
                '<!doctype html><div id="first"></div><div id="second"></div><script type="module" src="/test/browser/workspace-lifecycle-hydrated.fixture.ts"></script>'
              )
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
    await page.locator('[data-consumer="1"]').waitFor()
    const state = async index => JSON.parse(await page.locator(`[data-consumer="${index}"]`).innerText())
    const wait = async expected =>
      page.waitForFunction(expected => {
        const output = document.querySelector('[data-consumer="0"]')
        if (!output) return false
        const value = JSON.parse(output.textContent)
        return Object.entries(expected).every(([key, item]) => JSON.stringify(value[key]) === JSON.stringify(item))
      }, expected)
    const second = await state(1)
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => window.workspaceLifecycleFixture.beginBusy(0))
      await wait({ busy: true })
      await page.evaluate(() => window.workspaceLifecycleFixture.hide(0))
      await page.locator('[data-consumer="0"]').waitFor({ state: 'hidden' })
      await page.waitForFunction(() => window.workspaceLifecycleFixture.stats().subscriptions[0] === 0)
      const hidden = await page.evaluate(() => window.workspaceLifecycleFixture.stats())
      await page.evaluate(() => window.workspaceLifecycleFixture.finishBusy(0))
      assert.deepEqual(await page.evaluate(() => window.workspaceLifecycleFixture.stats()), hidden, 'settlement cannot call the unsubscribed React consumer')
      await page.evaluate(() => window.workspaceLifecycleFixture.render(0))
      await wait({ busy: false })
      assert.deepEqual((await page.evaluate(() => window.workspaceLifecycleFixture.stats())).subscriptions, [1, 1])
      assert.deepEqual(await state(1), second)
    }
    await page.evaluate(() => window.workspaceLifecycleFixture.beginBusy(0))
    await wait({ busy: true })
    await page.evaluate(() => window.workspaceLifecycleFixture.dispose(0))
    const disposed = await page.evaluate(() => window.workspaceLifecycleFixture.stats())
    await page.evaluate(() => {
      window.workspaceLifecycleFixture.oldSources(0)
      window.workspaceLifecycleFixture.dispose(0)
    })
    await page.evaluate(() => window.workspaceLifecycleFixture.finishBusy(0))
    assert.equal(
      await page.evaluate(() => window.workspaceLifecycleFixture.disposedStable(0)),
      true,
      'disposed owner retains the last published snapshot identity'
    )
    assert.deepEqual(
      await page.evaluate(() => window.workspaceLifecycleFixture.stats()),
      disposed,
      'old editor/model/pending work cannot publish after owner disposal'
    )
    await page.evaluate(() => window.workspaceLifecycleFixture.input(1, '{"second":"alive"}'))
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-consumer="1"]').textContent).input === '{"second":"alive"}')
    assert.equal((await state(1)).input, '{"second":"alive"}')
    assert.equal((await page.evaluate(() => window.workspaceLifecycleFixture.stats())).notifications[0], disposed.notifications[0])
    await page.evaluate(() => {
      window.workspaceLifecycleFixture.unmount(0)
      window.workspaceLifecycleFixture.unmount(1)
    })
    assert.deepEqual((await page.evaluate(() => window.workspaceLifecycleFixture.stats())).subscriptions, [0, 0])
    assert.deepEqual(errors, [], 'no cached-snapshot loop, cross-seat hooks error or browser exception')
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(home, { recursive: true, force: true })
  }
})
