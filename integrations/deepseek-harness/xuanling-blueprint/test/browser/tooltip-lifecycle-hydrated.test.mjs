// Real hydrated React lifecycle oracle. Synthetic fixture only; no DSH/provider.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { probeBrowserEnv } from '../../../../../test/blueprint/capabilities/probe.mjs'
const requireHarness = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = requireHarness('playwright')
const packageRoot = fileURLToPath(new URL('../../', import.meta.url))

async function lifecycle(mutation) {
  let server, browser
  const home = mkdtempSync(join(tmpdir(), 'bp-tooltip-browser-'))
  const original = readFileSync(new URL('../../src/client/adapters/browser/tooltip-browser-effects.ts', import.meta.url), 'utf8')
  const mutated = original
    .replace('observer.disconnect()', 'void observer')
    .replace("document.removeEventListener('keydown', dismiss)", 'void dismiss')
    .replace("document.removeEventListener('pointerdown', onClose, true)", 'void onClose')
    .replace("window.removeEventListener('resize', place)", 'void place')
  assert.notEqual(mutated, original, 'cleanup mutation must match actual production source')
  try {
    server = await createServer({
      configFile: false,
      root: packageRoot,
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client'] },
      plugins: [
        {
          name: 'tooltip-lifecycle-fixture',
          resolveId(id) {
            if (id === '__tooltip_under_test__') return `${packageRoot}/src/client/shared/controls/tooltips.ts?lifecycle=${mutation}`
          },
          transform(source, id) {
            if (mutation && id.endsWith('/tooltip-browser-effects.ts'))
              return source
                .replace('observer.disconnect()', 'void observer')
                .replace("document.removeEventListener('keydown', dismiss)", 'void dismiss')
                .replace("document.removeEventListener('pointerdown', onClose, true)", 'void onClose')
                .replace("window.removeEventListener('resize', place)", 'void place')
          },
          configureServer(vite) {
            vite.middlewares.use((req, res, next) => {
              if (req.url !== '/') return next()
              res.setHeader('Content-Type', 'text/html')
              res.end(
                '<!doctype html><div id="workspace" style="width:600px;height:400px"><button id="anchor">Anchor</button><div id="root"></div></div><script type="module" src="/test/browser/tooltip-lifecycle.fixture.ts"></script>'
              )
            })
          }
        }
      ]
    })
    await server.listen()
    browser = await chromium.launch({ channel: 'msedge', headless: true, env: probeBrowserEnv(home) })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
    await page.waitForFunction(() => !!window.tooltipFixture)
    const baseline = await page.evaluate(() => window.tooltipFixture.snapshot())
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let render = 0; render < 2; render++) {
        const epoch = await page.evaluate(() => window.tooltipFixture.render())
        await page.locator(`[data-bp-tooltip="synthetic-${epoch}"]`).waitFor()
        await page.waitForFunction(() => window.tooltipFixture.snapshot().observed >= 2)
        const mounted = await page.evaluate(() => window.tooltipFixture.snapshot())
        assert.deepEqual(
          mounted.listeners,
          ['document:keydown:false:1', 'document:pointerdown:true:1', 'window:resize:false:1'],
          'one exact callback/capture registration per live effect'
        )
        assert.equal(mounted.observed, 2, 'rerender releases prior observer targets')
        const before = mounted.closes
        await page.keyboard.press('Escape')
        assert.equal((await page.evaluate(() => window.tooltipFixture.snapshot())).closes, before + 1, 'exactly one live callback responds')
      }
      await page.evaluate(() => window.tooltipFixture.hide())
      await page.getByRole('tooltip').waitFor({ state: 'hidden' })
      await page.waitForFunction(() => window.tooltipFixture.snapshot().observed === 0)
      const hidden = await page.evaluate(() => window.tooltipFixture.snapshot())
      assert.deepEqual(hidden.listeners, baseline.listeners, 'listener identity and capture return to baseline')
      assert.equal(hidden.observed, baseline.observed, 'all observed elements released')
      await page.keyboard.press('Escape')
      await page.mouse.click(700, 500)
      assert.equal((await page.evaluate(() => window.tooltipFixture.snapshot())).closes, hidden.closes, 'unmounted callbacks cannot fire')
    }
    await page.evaluate(() => window.tooltipFixture.dispose())
  } finally {
    await browser?.close()
    await server?.close()
    rmSync(home, { recursive: true, force: true })
  }
}

test('hydrated tooltip preserves callback identity/capture and observer cleanup across three component remount/rerender cycles', async () => {
  await lifecycle(false)
})
test('cleanup deletion mutation fails the same hydrated production oracle for listener/observer leakage', async () => {
  await assert.rejects(lifecycle(true), error => {
    assert.match(error.message, /one exact callback\/capture registration|rerender releases prior observer/)
    console.log(`Expected cleanup mutation red: ${error.message.split('\n')[0]}`)
    return true
  })
})
