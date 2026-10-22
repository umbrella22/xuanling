import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { probeBrowserEnv } from '../../../../../test/blueprint/capabilities/probe.mjs'
const harness = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = harness('playwright')

export async function managedBrowser(t, fixture, service, initial = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bp-managed-ui-'))
  let server, browser, page
  const calls = [],
    errors = []
  t.after(async () => {
    if (page) {
      await page.screenshot({ path: `/tmp/dsh-blueprint-managed-composition-v1-evidence/${fixture}.png` }).catch(() => {})
      const view = await page.evaluate(() => ({ text: document.body.innerText, state: window.composition?.state() })).catch(() => null)
      writeFileSync(`/tmp/dsh-blueprint-managed-composition-v1-evidence/${fixture}.diagnostic.json`, JSON.stringify({ errors, view }, null, 2))
    }
    await browser?.close()
    await server?.close()
    rmSync(directory, { recursive: true, force: true })
  })
  server = await createServer({
    configFile: false,
    cacheDir: join(directory, 'cache'),
    root: fileURLToPath(new URL('../..', import.meta.url)),
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: {
      noDiscovery: true,
      include: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-dom',
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
        name: 'managed-ui-fixture',
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (req.url === '/') {
              res.setHeader('Content-Type', 'text/html')
              res.end(`<!doctype html><div id="root" style="height:100vh"></div><script type="module" src="/test/managed-workflows/${fixture}"></script>`)
            } else if (req.url?.startsWith('/rpc/') && req.method === 'POST') {
              const method = req.url.slice(5)
              const chunks = []
              for await (const chunk of req) chunks.push(chunk)
              const args = JSON.parse(Buffer.concat(chunks).toString())
              calls.push({ method, args })
              res.setHeader('Content-Type', 'application/json')
              try {
                res.end(JSON.stringify({ ok: true, value: await service[method](args) }))
              } catch (error) {
                res.end(JSON.stringify({ ok: false, error: { code: error.code ?? 'fixture/rpc-failed' } }))
              }
            } else next()
          })
        }
      }
    ]
  })
  await server.listen()
  browser = await chromium.launch({ channel: 'msedge', headless: true, env: probeBrowserEnv(directory) })
  page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
  page.setDefaultTimeout(10000)
  page.setDefaultNavigationTimeout(15000)
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(value => {
    window.fixtureInitial = value
  }, initial)
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`)
  return { page, calls, errors, directory }
}
