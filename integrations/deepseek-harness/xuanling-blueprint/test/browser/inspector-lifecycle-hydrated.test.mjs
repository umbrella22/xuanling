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

test('mounted Inspector preserves drafts and concurrent edits while releasing session subscriptions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'bp-inspector-lifecycle-'))
  let server, browser
  try {
    server = await createServer({
      configFile: false,
      cacheDir: join(directory, 'vite-cache'),
      root: fileURLToPath(new URL('../../', import.meta.url)),
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client', 'zod'] },
      plugins: [
        {
          name: 'inspector-lifecycle',
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (request.url !== '/') return next()
              response.setHeader('Content-Type', 'text/html')
              response.end(
                '<!doctype html><button id="outside">Outside</button><div id="mount"></div><script type="module" src="/test/browser/inspector-lifecycle-hydrated.fixture.ts"></script>'
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
    await page.waitForFunction(() => !!window.inspectorLifecycle)
    const stats = () => page.evaluate(() => window.inspectorLifecycle.stats())
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => window.inspectorLifecycle.mount())
      await page.locator('[data-bp-node-inspector="task"]').waitFor()
      assert.equal((await stats()).subscriptions, 1)
      await page.locator('[data-bp-inspector-advanced]').click()
      await page.locator('[data-bp-json-editor]').last().scrollIntoViewIfNeeded()
      const json = page.locator('.cm-content[data-bp-json="options"]')
      await json.waitFor()
      await json.fill('{invalid')
      await page.locator('#outside').click()
      await page.locator('[data-bp-inspector-notice="inspector.invalidJsonRetained"]').waitFor()
      assert.equal((await stats()).canUndo, false, 'invalid draft cannot create a graph transaction')
      await page.evaluate(() => window.inspectorLifecycle.locale('zh'))
      assert.equal(await json.innerText(), '{invalid', 'locale preserves the unfinished buffer')
      const options = {
        id: 'task',
        kind: 'agentTask',
        agentRef: 'local',
        inputs: {},
        outputs: { authored: 'number' },
        modelSelection: { provider: 'fixture-provider', model: 'initial-model' }
      }
      await json.fill(JSON.stringify(options))
      await page.evaluate(() => window.inspectorLifecycle.concurrent())
      assert.equal((await stats()).definition.graph.nodes[0].modelSelection.model, 'concurrent-model')
      assert.equal(await json.innerText(), JSON.stringify(options), 'uncommitted JSON is not overwritten by graph notification')
      await page.locator('[data-bp-action="apply-node-options"]').click()
      const applied = (await stats()).definition.graph.nodes[0]
      assert.deepEqual(applied.outputs, { authored: 'number' })
      assert.deepEqual(applied.modelSelection, { provider: 'fixture-provider', model: 'concurrent-model' }, 'JSON delta preserves concurrent unedited fields')
      await page.evaluate(() => window.inspectorLifecycle.undo())
      const undone = (await stats()).definition.graph.nodes[0]
      assert.deepEqual(undone.outputs, { original: 'string' }, 'blur and Apply must create one graph edit')
      assert.deepEqual(undone.modelSelection, { provider: 'fixture-provider', model: 'concurrent-model' })
      assert.equal(await page.evaluate(() => window.inspectorLifecycle.capture('resource')), true)
      await page.evaluate(() => window.inspectorLifecycle.catalog(false))
      const beforeResource = (await stats()).definition
      await page.evaluate(() => window.inspectorLifecycle.replay(true))
      assert.deepEqual((await stats()).definition, beforeResource, 'OLD_INSPECTOR_CATALOG_CALLBACK_BOUND_UNAVAILABLE_RESOURCE')
      await page.evaluate(() => window.inspectorLifecycle.catalog(true))
      await page.evaluate(() => window.inspectorLifecycle.replay(true))
      assert.equal((await stats()).definition.graph.nodes[0].skillRefs.length, 1, 'current available choice still dispatches')
      await page.evaluate(() => window.inspectorLifecycle.undo())
      assert.deepEqual((await stats()).definition, beforeResource, 'resource declaration and binding share one Undo transaction')
      assert.equal(await page.evaluate(() => window.inspectorLifecycle.capture()), true)
      await page.evaluate(() => window.inspectorLifecycle.node('other'))
      await page.locator('[data-bp-node-inspector="other"]').waitFor()
      assert.equal((await stats()).subscriptions, 1, 'replacing the node releases the old session')
      assert.equal((await stats()).definition.graph.nodes[1].outputs.authored, undefined)
      const afterSwitch = (await stats()).definition
      await page.evaluate(() => window.inspectorLifecycle.replay())
      assert.deepEqual((await stats()).definition, afterSwitch, 'OLD_INSPECTOR_NODE_CALLBACK_MUTATED_GRAPH')
      assert.equal(await page.evaluate(() => window.inspectorLifecycle.capture()), true)
      await page.evaluate(() => window.inspectorLifecycle.unmount())
      assert.equal((await stats()).subscriptions, 0)
      assert.equal(await page.locator('.cm-editor').count(), 0)
      const afterUnmount = (await stats()).definition
      await page.evaluate(() => window.inspectorLifecycle.replay())
      assert.deepEqual((await stats()).definition, afterUnmount, 'UNMOUNTED_INSPECTOR_CALLBACK_MUTATED_GRAPH')
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
