import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { probeBrowserEnv } from '../../../../../test/blueprint/capabilities/probe.mjs'
import { selectStyledOption } from '../../../../../test/blueprint/capabilities/styled-control-entry.mjs'
const harness = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = harness('playwright')
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
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom/client',
        'react-dom',
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
        name: 'panel-snapshot-fixture',
        configureServer(vite) {
          vite.middlewares.use((req, res, next) => {
            if (req.url !== '/') return next()
            res.setHeader('Content-Type', 'text/html')
            res.end(
              '<!doctype html><div id="root-0" style="height:650px"></div><div id="root-1" style="height:650px"></div><script type="module" src="/test/browser/panel-snapshot-hydrated.fixture.ts"></script>'
            )
          })
        }
      }
    ]
  })
  await server.listen()
  url = `http://127.0.0.1:${server.httpServer.address().port}`
  home = mkdtempSync(join(tmpdir(), 'bp-panel-snapshot-'))
  browser = await chromium.launch({ channel: 'msedge', headless: true, env: probeBrowserEnv(home) })
  page = await browser.newPage({ viewport: { width: 1250, height: 1000 } })
  page.on('pageerror', error => console.error('PAGEERROR', error.message))
})
after(async () => {
  await browser?.close()
  await server?.close()
  if (home) rmSync(home, { recursive: true, force: true })
})
const mount = async () => {
  await page.goto(url)
  await page.waitForFunction(() => window.panelSnapshot?.state(0) && window.panelSnapshot?.state(1))
  await page.evaluate(async () => {
    await window.panelSnapshot.load(0, 'one')
    await window.panelSnapshot.load(1, 'one')
  })
  await page.locator('#root-0 [data-bp-action="save-layout"]').waitFor()
}
test('actual Panel retained save callback cannot save a later document', async () => {
  await mount()
  await page.evaluate(() => window.panelSnapshot.capture(0, 'save-layout'))
  await page.evaluate(() => window.panelSnapshot.load(0, 'two'))
  await page.evaluate(async () => {
    window.panelSnapshot.clear()
    window.panelSnapshot.invoke(0, 'save-layout')
    await window.panelSnapshot.settle()
  })
  assert.equal(
    (await page.evaluate(() => window.panelSnapshot.calls())).some(call => call[1] === 'save'),
    false,
    'OLD_PANEL_SAVE_CALLBACK_SAVED_NEW_DOCUMENT'
  )
})
test('actual Panel retained new callback cannot replace a later document', async () => {
  await mount()
  await page.evaluate(() => window.panelSnapshot.capture(0, 'new-blueprint'))
  await page.evaluate(() => window.panelSnapshot.load(0, 'two'))
  const before = await page.evaluate(() => window.panelSnapshot.state(0))
  await page.evaluate(() => {
    window.panelSnapshot.clear()
    window.panelSnapshot.invoke(0, 'new-blueprint')
  })
  assert.deepEqual(await page.evaluate(() => window.panelSnapshot.state(0)), before, 'OLD_PANEL_NEW_CALLBACK_REPLACED_NEW_DOCUMENT')
  assert.deepEqual(await page.evaluate(() => window.panelSnapshot.calls()), [])
})
test('actual Panel unmount immediately invalidates retained new and input callbacks', async () => {
  await mount()
  await page.evaluate(() => {
    window.panelSnapshot.capture(0, 'new-blueprint')
    window.panelSnapshot.capture(0, 'input')
  })
  const immediate = await page.evaluate(() => {
    window.panelSnapshot.clear()
    const before = window.panelSnapshot.state(0)
    window.panelSnapshot.unmount(0)
    window.panelSnapshot.invoke(0, 'input', '{"detached":true}')
    window.panelSnapshot.invoke(0, 'new-blueprint')
    return { before, after: window.panelSnapshot.state(0) }
  })
  assert.deepEqual(immediate.after, immediate.before, 'UNMOUNTED_PANEL_CALLBACK_MUTATED_WORKSPACE')
  assert.deepEqual(await page.evaluate(() => window.panelSnapshot.calls()), [])
})
test('actual disposed Panel rejects retained new and input callbacks without throwing', async () => {
  await mount()
  await page.evaluate(() => {
    window.panelSnapshot.capture(0, 'new-blueprint')
    window.panelSnapshot.capture(0, 'input')
    window.panelSnapshot.clear()
    window.panelSnapshot.unmount(0)
  })
  const late = await page.evaluate(() => {
    const before = window.panelSnapshot.state(0)
    window.panelSnapshot.invoke(0, 'input', '{"late":true}')
    window.panelSnapshot.invoke(0, 'new-blueprint')
    return { before, after: window.panelSnapshot.state(0) }
  })
  assert.deepEqual(late.after, late.before, 'DISPOSED_PANEL_CALLBACK_MUTATED_WORKSPACE')
  assert.deepEqual(await page.evaluate(() => window.panelSnapshot.calls()), [])
})
test('actual Panel preserves first-visit viewport through a successful canonical save', async () => {
  await mount()
  const root = page.locator('#root-0')
  await root.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#root-0 .react-flow__viewport')?.style.transform.includes('scale(1.2)'))
  const before = await root.locator('.react-flow__viewport').getAttribute('style')
  await root.locator('[data-bp-action="save-layout"]').click()
  await page.waitForFunction(() => document.querySelector('#root-0 [data-bp-status-key]')?.getAttribute('data-bp-status-key') === 'status.saved')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await root.locator('.react-flow__viewport').getAttribute('style'), before, 'CANONICAL_SAVE_RESET_FIRST_VISIT_VIEWPORT')
})
test('actual Panel picker fits a first-visit document in its new canvas instance', async () => {
  await mount()
  await selectStyledOption(page, page.locator('#root-0 [data-bp-select="blueprint"]'), 'distant')
  await page.waitForFunction(() => window.panelSnapshot.state(0).id === 'distant' && !window.panelSnapshot.state(0).busy)
  await page.locator('#root-0 .react-flow__node[data-id="far-input"]').waitFor({ state: 'attached' })
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector('#root-0 [data-bp-canvas="surface"]').getBoundingClientRect()
    const node = document.querySelector('#root-0 .react-flow__node[data-id="far-input"]').getBoundingClientRect()
    return {
      transform: document.querySelector('#root-0 .react-flow__viewport').style.transform,
      contained:
        node.width > 0 && node.height > 0 && node.left >= canvas.left && node.right <= canvas.right && node.top >= canvas.top && node.bottom <= canvas.bottom
    }
  })
  assert.equal(geometry.contained, true, `PICKER_FIT_TARGETED_OLD_CANVAS: ${JSON.stringify(geometry)}`)
})
test('actual StrictMode Panel keeps model-only subscription, locale, input while busy and instance isolation', async () => {
  await mount()
  const second = await page.evaluate(() => window.panelSnapshot.state(1))
  await page.evaluate(() => {
    window.panelSnapshot.capture(0, 'input')
    window.panelSnapshot.busy(0)
    window.panelSnapshot.invoke(0, 'input', ' {"busy":true} ')
  })
  assert.equal((await page.evaluate(() => window.panelSnapshot.state(0))).input, ' {"busy":true} ')
  await page.evaluate(() => window.panelSnapshot.finish(0))
  await page.evaluate(() => window.panelSnapshot.model(0))
  await page.waitForFunction(() => document.querySelector('#root-0').textContent.includes('Succeeded'))
  await page.evaluate(() => window.panelSnapshot.locale(0))
  await page.waitForFunction(() => document.querySelector('#root-0').textContent.includes('成功'))
  assert.deepEqual(await page.evaluate(() => window.panelSnapshot.state(1)), second)
})
test('actual Panel unmount immediately invalidates retained commands', async () => {
  await mount()
  await page.evaluate(() => window.panelSnapshot.capture(0, 'save-layout'))
  await page.evaluate(() => {
    window.panelSnapshot.clear()
    window.panelSnapshot.unmount(0)
    window.panelSnapshot.invoke(0, 'save-layout')
  })
  assert.deepEqual(await page.evaluate(() => window.panelSnapshot.calls()), [], 'UNMOUNTED_PANEL_CALLBACK_REACHED_HOST')
})
