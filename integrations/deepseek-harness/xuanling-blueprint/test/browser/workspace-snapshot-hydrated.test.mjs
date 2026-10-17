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

test('hydrated useSyncExternalStore observes production Workspace transitions, stable reads, instance isolation and unsubscribe', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bp-workspace-snapshot-'))
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
          name: 'workspace-snapshot-fixture',
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/') return next()
              res.setHeader('Content-Type', 'text/html')
              res.end(
                '<!doctype html><div id="first"></div><div id="second"></div><script type="module" src="/test/browser/workspace-snapshot-hydrated.fixture.ts"></script>'
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
    await page.evaluate(() => window.workspaceSnapshotFixture.input(0, '{"synthetic":1}'))
    await wait({ input: '{"synthetic":1}' })
    await page.evaluate(() => window.workspaceSnapshotFixture.selection(0, ['synthetic-node']))
    await wait({ selection: ['synthetic-node'] })
    await page.evaluate(() => window.workspaceSnapshotFixture.disconnected(0))
    await wait({ connection: 'stale' })
    await page.evaluate(() => window.workspaceSnapshotFixture.beginBusy(0))
    await wait({ busy: true })
    await page.evaluate(() => window.workspaceSnapshotFixture.finishBusy())
    await wait({ busy: false })
    await page.evaluate(() => window.workspaceSnapshotFixture.newDraft(0))
    await wait({ notice: 'status.newDraft', input: '{}', selection: [] })
    assert.deepEqual(await state(1), second, 'second Workspace UI never borrows first-instance state')
    const before = await state(0)
    assert.equal(await page.evaluate(() => window.workspaceSnapshotFixture.stable(0)), true)
    const rendersBefore = (await page.evaluate(() => window.workspaceSnapshotFixture.stats())).renders[0]
    await page.evaluate(() => window.workspaceSnapshotFixture.render(0))
    await page.waitForFunction(before => window.workspaceSnapshotFixture.stats().renders[0] > before, rendersBefore)
    assert.deepEqual(await state(0), before, 'parent rerender reads the same authoritative snapshot')
    assert.deepEqual((await page.evaluate(() => window.workspaceSnapshotFixture.stats())).subscriptions, [1, 1])
    await page.evaluate(() => window.workspaceSnapshotFixture.unmount(0))
    const stats = await page.evaluate(() => window.workspaceSnapshotFixture.stats())
    assert.deepEqual(stats.subscriptions, [0, 1])
    await page.evaluate(() => {
      window.workspaceSnapshotFixture.input(0, 'after-unmount')
      window.workspaceSnapshotFixture.selection(0, ['later'])
      window.workspaceSnapshotFixture.disconnected(0)
    })
    assert.deepEqual(await page.evaluate(() => window.workspaceSnapshotFixture.stats()), stats, 'unmounted React consumer receives no callback or render')
    assert.deepEqual(await state(1), second)
    await page.evaluate(() => window.workspaceSnapshotFixture.unmount(1))
    assert.deepEqual((await page.evaluate(() => window.workspaceSnapshotFixture.stats())).subscriptions, [0, 0])
    assert.deepEqual(errors, [], 'no cached-snapshot loop, cross-seat hooks error or browser exception')
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(home, { recursive: true, force: true })
  }
})
