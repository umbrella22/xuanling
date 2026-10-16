import { selectStyledOption } from './styled-control-entry.mjs'
// Actual CLI-installed DSH/native Edge collector. No route interception or fake graph.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, lstatSync } from 'node:fs'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
const HERE = dirname(fileURLToPath(import.meta.url)),
  ROOT = resolve(HERE, '../../..'),
  BP = join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const requireTrue = (ok, code) => {
  if (!ok) throw Object.assign(new Error(code), { code })
}
export function parseCli(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const values = {}
  for (let i = 0; i < args.length; i++) {
    const [flag, ...tail] = args[i].split('=')
    const v = tail.length ? tail.join('=') : args[++i]
    requireTrue(
      ['--report-dir', '--phase', '--pnpm-executable'].includes(flag) &&
        !Object.hasOwn(values, flag) &&
        typeof v === 'string' &&
        v.length > 0 &&
        !v.startsWith('--'),
      'CLI_INVALID_ARGUMENT'
    )
    values[flag] = v
  }
  const reportDir = values['--report-dir']
  requireTrue(typeof reportDir === 'string' && isAbsolute(reportDir) && resolve(reportDir) === reportDir, 'CLI_REPORT_ABSOLUTE_REQUIRED')
  for (let p = reportDir; ; p = dirname(p)) {
    try {
      requireTrue(!lstatSync(p).isSymbolicLink(), 'CLI_REPORT_SYMLINK')
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
    if (dirname(p) === p) break
  }
  requireTrue(!existsSync(reportDir), 'CLI_REPORT_ALREADY_EXISTS')
  const phase = values['--phase'] ?? 'green'
  requireTrue(['red', 'green'].includes(phase), 'CLI_PHASE_INVALID')
  return { reportDir, phase, pnpmExecutable: values['--pnpm-executable'] }
}
// Browser-only read probe. Outer shell, content overflow and viewport clipping are separate facts.
export function geometryProbe(scopeSelector) {
  const scope = document.querySelector(scopeSelector)
  if (!scope) return null
  const rect = el => {
    const r = el.getBoundingClientRect()
    return {
      x: r.x,
      y: r.y,
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height
    }
  }
  const measure = el => ({
    rect: rect(el),
    clientWidth: el.clientWidth,
    clientHeight: el.clientHeight,
    scrollWidth: el.scrollWidth,
    scrollHeight: el.scrollHeight,
    overflowX: getComputedStyle(el).overflowX,
    overflowY: getComputedStyle(el).overflowY
  })
  const canvas = scope.querySelector('.bp-conversation-canvas') ?? scope.querySelector('[data-bp-canvas="surface"]')
  const contained = (a, b) => a.left >= b.left - 1 && a.top >= b.top - 1 && a.right <= b.right + 1 && a.bottom <= b.bottom + 1
  const nodes = [...scope.querySelectorAll('[data-bp-node]')].map(el => {
    const shell = el.closest('.react-flow__node')
    const body = rect(el),
      outer = rect(shell ?? el)
    const children = [...el.querySelectorAll('.bp-node-title,.bp-node-state,.bp-port-row,.react-flow__handle,.bp-member-activity')].map(child => {
      const r = rect(child)
      const handle = child.classList.contains('react-flow__handle')
      const bounds = handle
        ? {
            left: (r.left + r.right) / 2,
            right: (r.left + r.right) / 2,
            top: (r.top + r.bottom) / 2,
            bottom: (r.top + r.bottom) / 2
          }
        : r
      const clipping = []
      for (let p = child.parentElement; p && scope.contains(p); p = p.parentElement) {
        const s = getComputedStyle(p)
        if (/hidden|clip|auto|scroll/.test(`${s.overflowX} ${s.overflowY}`) && !contained(r, rect(p)))
          clipping.push({ tag: p.tagName, className: p.className, rect: rect(p) })
      }
      return {
        text: child.textContent,
        rect: r,
        insideBody: contained(bounds, body),
        insideShell: contained(bounds, outer),
        clipping
      }
    })
    return {
      id: el.getAttribute('data-bp-node'),
      body: measure(el),
      shell: measure(shell ?? el),
      children,
      viewportContained: canvas ? contained(outer, rect(canvas)) : false
    }
  })
  return {
    scope: measure(scope),
    canvas: canvas ? measure(canvas) : null,
    body: scope.querySelector('.bp-conversation-body') ? measure(scope.querySelector('.bp-conversation-body')) : null,
    attempts: scope.querySelector('.bp-conversation-attempts') ? measure(scope.querySelector('.bp-conversation-attempts')) : null,
    toolbar: scope.querySelector('.bp-toolbar') ? measure(scope.querySelector('.bp-toolbar')) : null,
    status: scope.querySelector('.bp-conversation-status') ? measure(scope.querySelector('.bp-conversation-status')) : null,
    composer: [...document.querySelectorAll('[data-composer-input][role="textbox"]')].map(measure),
    viewport: { width: innerWidth, height: innerHeight },
    css: {
      available: getComputedStyle(scope).getPropertyValue('--dsh-conversation-viewport-height'),
      composer: getComputedStyle(scope).getPropertyValue('--dsh-composer-height')
    },
    layoutReady: scope.getAttribute('data-bp-layout-ready'),
    fitReady: scope.getAttribute('data-bp-fit-ready'),
    transform: scope.querySelector('.react-flow__viewport')?.getAttribute('style'),
    nodes,
    headers: [...scope.querySelectorAll('[data-bp-group] .bp-group-header')].map(el => ({
      text: el.textContent,
      rect: rect(el)
    }))
  }
}
const safeMessage = error =>
  String(error?.message ?? 'Operation failed')
    .replace(/https?:\/\/[^\s)]+/g, '<url>')
    .replace(/(?:cookie|authorization|api[_-]?key|password)\s*[:=][^\n]+/gi, '<credential redacted>')
    .slice(0, 1500)
const fits = g =>
  g.nodes.every(n => n.viewportContained) &&
  g.headers.every(
    h =>
      h.rect.left >= g.canvas.rect.left - 1 &&
      h.rect.top >= g.canvas.rect.top - 1 &&
      h.rect.right <= g.canvas.rect.right + 1 &&
      h.rect.bottom <= g.canvas.rect.bottom + 1
  )
const overlaps = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
const headerBodyCollisions = g => g.headers.flatMap(h => g.nodes.filter(n => overlaps(h.rect, n.shell.rect)).map(n => ({ header: h.text, node: n.id })))
const collisions = items =>
  items.flatMap((a, i) =>
    items
      .slice(i + 1)
      .filter(b => overlaps(a.rect, b.rect))
      .map(b => [a.id ?? a.text, b.id ?? b.text])
  )
export async function runCollector(options) {
  mkdirSync(dirname(options.reportDir), { recursive: true })
  mkdirSync(options.reportDir, { mode: 0o700 })
  const receipt = {
    schemaVersion: 1,
    planId: 'dsh-blueprint-node-ux-v1',
    phase: options.phase,
    startedAt: new Date().toISOString(),
    cases: [],
    steps: [],
    rpc: [],
    notRun: [],
    cleanup: {},
    providerEvidence: false
  }
  let root, profile, host, edge, page, native
  const check = (id, name, ok, facts) => {
    receipt.cases.push({
      id,
      name,
      passed: !!ok,
      category: ok ? 'pass' : 'product-assertion',
      facts
    })
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}`)
  }
  const scene = async (id, fn) => {
    try {
      await fn()
    } catch (e) {
      receipt.cases.push({
        id,
        passed: false,
        category: 'scene-operation-failure',
        code: e.code ?? 'BROWSER_OPERATION_FAILED',
        message: safeMessage(e)
      })
      console.error(`${id}: ${e.code ?? 'BROWSER_OPERATION_FAILED'}`)
    }
  }
  const snap = async name => {
    const path = join(options.reportDir, `${name}.png`)
    await page.screenshot({ path, fullPage: true })
    return { file: `${name}.png`, sha256: hash(readFileSync(path)) }
  }
  try {
    const runtime = await import('./conversation-runtime.mjs'),
      fixture = await import('./node-ux-fixtures.mjs')
    const browser = await import('./conversation-browser.mjs')
    const { captureEvidenceFingerprint } = await import(join(BP, 'scripts/verify.mjs'))
    receipt.fingerprintBefore = captureEvidenceFingerprint()
    receipt.helpers = [
      'node-ux-ui.mjs',
      'node-ux-fixtures.mjs',
      'conversation-runtime.mjs',
      'conversation-fixture.mjs',
      'conversation-browser.mjs',
      'canvas-fixtures.mjs',
      'canvas-journey.mjs',
      'comfy-motion-ui.mjs'
    ].map(p => ({ path: p, sha256: hash(readFileSync(join(HERE, p))) }))
    root = mkdtempSync(join(realpathSync(tmpdir()), 'bp-node-ux-'))
    profile = await runtime.prepareProfile({ mode: 'keyless', installMode: 'cli', pnpmExecutable: options.pnpmExecutable }, fixture, root, receipt.steps)
    // Public Host catalog fixture only. No inherited user Skill roots/connection secrets.
    const skillDir = join(root, 'host-skills'),
      skill = join(skillDir, 'node-ux-skill')
    mkdirSync(skill, { recursive: true })
    writeFileSync(join(skill, 'SKILL.md'), '---\nname: node-ux-skill\ndescription: Anonymous fixture skill.\n---\nAnonymous fixture skill.\n')
    const effects = join(root, 'mcp-effects.txt'),
      patch = join(profile.profileDir, 'cordis.patch.yml')
    writeFileSync(
      patch,
      runtime.collectorOverlaySource(
        readFileSync(patch, 'utf8'),
        `- id: skill-filesystem\n  disabled: false\n  config: ${JSON.stringify({ includeDefaultRoots: false, customSkillDirs: [skillDir], watch: false })}\n- insert:\n    - id: node-ux-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config: ${JSON.stringify({ transport: 'stdio', serverName: 'bp_host', command: process.execPath, args: [join(HERE, 'mcp-server.mjs')], env: { BP_MCP_SIDE_EFFECT_FILE: effects }, failOnStartupError: true })}`
      )
    )
    receipt.installed = {
      mode: 'cli',
      inventory: profile.installedInventory,
      packageManager: profile.packageManager?.executable
    }
    host = runtime.bootHost(profile, receipt.steps)
    const authUrl = await host.ready
    const gateway = runtime.makeGateway(authUrl, receipt.rpc, 'keyless')
    await gateway.authenticate()
    requireTrue((await gateway.call('blueprint/ping', {})).status === 'ok', 'HOST_PLUGIN_NOT_MOUNTED')
    // Separate minimal authenticated RPC; never extends the old conversation gateway.
    const auth = await fetch(authUrl, { redirect: 'manual' }),
      cookie = auth.headers
        .getSetCookie()
        .map(c => c.split(';')[0])
        .join('; ')
    const api = async (method, args) => {
      requireTrue(['listResources', 'loadDefinition', 'saveDefinition'].includes(method), 'HOST_METHOD_FORBIDDEN')
      const rpcId = randomUUID()
      const r = await fetch(`${gateway.origin}/api/blueprint/${method}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method: `blueprint/${method}`,
          payload: { args: args === undefined ? {} : { args } }
        }),
        signal: AbortSignal.timeout(15000)
      })
      const b = await r.json()
      requireTrue(
        r.status === 200 && b.rpcId === rpcId && b.result?.ok,
        `HOST_RPC_FAILED_${method}_${r.status}_${String(b.result?.error?.code ?? 'invalid-envelope').replace(/[^A-Za-z0-9_-]/g, '_')}`
      )
      return b.result.value
    }
    const catalog = (await api('listResources')).resources
    const allowed = ['id', 'kind', 'displayName', 'description', 'source', 'availability', 'provenance', 'bindingId']
    check(
      'U14',
      'catalog exposes safe public DTO only',
      catalog.every(r => Object.keys(r).every(k => allowed.includes(k))),
      catalog
    )
    check(
      'U14',
      'real Host catalog fixture identities available',
      ['node-ux-agent', 'node-ux-skill', 'mcp__bp_host__record_side_effect'].every(id => catalog.some(r => r.id === id && r.availability === 'available')),
      catalog.map(r => ({ id: r.id, kind: r.kind, availability: r.availability }))
    )
    const catalogKinds = new Set(catalog.map(r => r.kind))
    const hostKinds = ['agent', 'skill', 'mcp']
    check(
      'U14',
      'public catalog covers Agent Skills and MCP host kinds',
      hostKinds.every(kind => catalogKinds.has(kind)) && catalogKinds.size === hostKinds.length && [...catalogKinds].every(kind => hostKinds.includes(kind)),
      [...catalogKinds]
    )
    check(
      'U14',
      'catalog has no empty typed rows and preserves same-name cross-type identities',
      catalog.every(r => r.displayName && r.kind && r.id) && new Set(catalog.filter(r => r.displayName === 'node-ux-skill').map(r => r.kind)).size >= 2,
      catalog.map(r => ({ id: r.id, kind: r.kind, displayName: r.displayName }))
    )
    check(
      'U14',
      'unavailable Host entries retain original reference when present',
      catalog.filter(r => r.availability !== 'available').every(r => typeof r.id === 'string' && r.id.length > 0 && typeof r.displayName === 'string'),
      catalog.filter(r => r.availability !== 'available')
    )
    const { launchOwnedEdge } = await import('./comfy-motion-ui.mjs'),
      pw = createRequire(join(ROOT, 'test/blueprint/package.json'))('playwright')
    edge = await launchOwnedEdge(pw, runtime.isolatedEnvironment(profile.home), root)
    receipt.browser = edge.evidence
    page = await edge.context.newPage()
    page.setDefaultTimeout(15000)
    native = browser.observeNativeRequests(page)
    receipt.pageErrors = []
    page.on('pageerror', () => receipt.pageErrors.push('BROWSER_PAGE_ERROR'))
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForFunction(() => window.__DSH_BOOT__?.entries?.some(e => (e.id ?? e.package) === '@xuanling-rs/xuanling-dsh-blueprint'))
    const bound = await fixture.arrange({ page, gateway, root })
    receipt.bound = bound
    const tab = page.locator('[data-conversation-tabs]').getByRole('tab', { name: /^(Blueprint|XuanLing Blueprint|蓝图|玄灵蓝图)$/i })
    await tab.click()
    await page.locator('[data-bp-conversation="root"]').waitFor({ state: 'visible' })
    const before = await gateway.call('blueprint/inspectSession', {
      args: { sessionId: bound.sessionId }
    })
    await page.waitForFunction(
      ({ sessionId, runId, revision }) => {
        const el = document.querySelector('[data-bp-conversation="root"]')
        return (
          el?.getAttribute('data-bp-session') === sessionId &&
          el.getAttribute('data-bp-run-id') === runId &&
          el.getAttribute('data-bp-frozen-revision') === revision
        )
      },
      {
        sessionId: bound.sessionId,
        runId: before.selected.run.runId,
        revision: before.selected.run.definitionRevision
      }
    )
    receipt.projection = browser.projectInspection(before, await page.evaluate(browser.conversationDomProbe))
    await page.waitForFunction(() => document.querySelector('[data-bp-conversation="root"]')?.getAttribute('data-bp-layout-ready') === 'true', {
      timeout: 15000
    })
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    const initial = await page.evaluate(geometryProbe, '[data-bp-conversation="root"]')
    writeFileSync(join(options.reportDir, 'initial-fit.json'), JSON.stringify(initial, null, 2))
    await snap('initial-fit')
    check('U07', 'first mounted Fit includes complete graph', fits(initial), initial)
    const mutations = native.mutations()
    const viewports =
      options.phase === 'red'
        ? [{ width: 1920, height: 1080 }]
        : [
            { width: 1440, height: 900 },
            { width: 1920, height: 1080 },
            { width: 2560, height: 1440 },
            { width: 900, height: 700 }
          ]
    for (const vp of viewports)
      for (const composerMode of ['short', 'expanded'])
        await scene(`runtime-${vp.width}-${composerMode}`, async () => {
          await page.setViewportSize(vp)
          const composer = page.locator(browser.COMPOSER)
          requireTrue((await composer.count()) === 1, 'BROWSER_COMPOSER_MISSING')
          await composer.fill(composerMode === 'short' ? 'Anonymous draft' : Array.from({ length: 12 }, (_, i) => `Anonymous draft line ${i}`).join('\n'))
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
          await page
            .locator('[data-bp-conversation="root"]')
            .getByRole('button', { name: /^(Fit frozen graph|显示整个冻结图)$/ })
            .click()
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
          const g = await page.evaluate(geometryProbe, '[data-bp-conversation="root"]')
          requireTrue(g?.nodes.length === before.selected.graph.nodes.length, 'BROWSER_GRAPH_NOT_READY')
          const tag = `runtime-${vp.width}x${vp.height}-${composerMode}`
          writeFileSync(join(options.reportDir, `${tag}.json`), JSON.stringify(g, null, 2))
          await snap(tag)
          check('U01', 'frozen headers avoid all node bodies', headerBodyCollisions(g).length === 0, { tag, collisions: headerBodyCollisions(g) })
          check('U01', 'frozen group headers do not overlap', collisions(g.headers).length === 0, {
            tag,
            collisions: collisions(g.headers)
          })
          check(
            'U07',
            'node content fits actual body and shell',
            g.nodes.every(n => n.children.every(c => c.insideBody && c.insideShell)),
            {
              tag,
              overflow: g.nodes.flatMap(n => n.children.filter(c => !c.insideBody || !c.insideShell).map(c => ({ id: n.id, ...c })))
            }
          )
          check('U07', 'explicit Fit includes nodes and group headers', fits(g), { tag })
          const available = /^\s*[0-9.]+px\s*$/.test(g.css.available) ? Number.parseFloat(g.css.available) : NaN,
            composerHeight = /^\s*[0-9.]+px\s*$/.test(g.css.composer) ? Number.parseFloat(g.css.composer) : NaN,
            chromeAbove = g.canvas.rect.top - g.scope.rect.top,
            chromeBelow = g.scope.rect.bottom - g.canvas.rect.bottom
          // Compare observed public size budget; no guessed fixed height subtraction.
          check(
            'U06',
            'canvas fills available Host height',
            Number.isFinite(available) && Number.isFinite(composerHeight) && g.canvas.rect.height >= available - composerHeight - chromeAbove - chromeBelow - 1,
            {
              tag,
              available,
              composerHeight,
              chromeAbove,
              chromeBelow,
              actual: g.canvas.rect.height,
              composer: g.composer,
              css: g.css
            }
          )
          check(
            'U13',
            'root does not overlap native composer',
            g.composer.every(c => g.scope.rect.bottom <= c.rect.top + 1 || g.scope.rect.top >= c.rect.bottom - 1),
            { tag }
          )
        })
    await scene('read-only-pan-refresh', async () => {
      const canvas = page.locator('.bp-conversation-canvas'),
        b = await canvas.boundingBox()
      requireTrue(b, 'BROWSER_CANVAS_MISSING')
      const viewport = page.locator('[data-bp-conversation="root"] .react-flow__viewport')
      const old = await viewport.getAttribute('style')
      await page.mouse.move(b.x + b.width - 70, b.y + b.height - 60)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width - 105, b.y + b.height - 85, { steps: 4 })
      await page.mouse.up()
      await page.waitForFunction(
        previous => document.querySelector('[data-bp-conversation="root"] .react-flow__viewport')?.getAttribute('style') !== previous,
        old
      )
      const panned = await viewport.getAttribute('style')
      const requestsBefore = native.requests.length
      await page
        .locator('[data-bp-conversation="root"]')
        .getByRole('button', { name: /^(Refresh run facts|刷新运行事实)$/ })
        .click()
      await gateway.call('blueprint/inspectSession', { args: { sessionId: bound.sessionId } })
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      requireTrue(
        native.requests.slice(requestsBefore).some(r => r.method === 'blueprint/inspectSession'),
        'BROWSER_REFRESH_REQUEST_MISSING'
      )
      check('U13', 'read-only refresh preserves user pan', (await viewport.getAttribute('style')) === panned, {
        old,
        panned,
        after: await viewport.getAttribute('style')
      })
    })
    const after = await gateway.call('blueprint/inspectSession', {
      args: { sessionId: bound.sessionId }
    })
    check('U13', 'observation keeps frozen Run and introduces zero mutations', isDeepStrictEqual(before, after) && native.mutations() === mutations, {
      mutationsBefore: mutations,
      mutationsAfter: native.mutations()
    })
    await scene('authoring', async () => {
      await page.getByRole('button', { name: /XuanLing Blueprint|玄灵蓝图/ }).click()
      const select = page.locator('[data-bp-select="blueprint"]')
      await select.waitFor()
      await selectStyledOption(page, select, fixture.AUTHOR_ID)
      const canonicalBeforeProjection = await api('loadDefinition', {
        blueprintId: fixture.AUTHOR_ID
      })
      await page.waitForFunction(id => document.querySelector('[data-bp-blueprint]')?.getAttribute('data-bp-blueprint') === id, fixture.AUTHOR_ID)
      await page.locator('[data-bp-node="input"]').waitFor()
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      await page.locator('[data-bp-canvas="root"] .react-flow__controls-fitview').click()
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      const g = await page.evaluate(geometryProbe, '[data-bp-canvas="root"]')
      writeFileSync(join(options.reportDir, 'authoring-geometry.json'), JSON.stringify(g, null, 2))
      await snap('authoring')
      check('U01', 'authoring headers avoid all node bodies', g && headerBodyCollisions(g).length === 0, g ? headerBodyCollisions(g) : null)
      check('U01', 'authoring group headers do not overlap', g && collisions(g.headers).length === 0, g?.headers)
      check(
        'U02',
        'authoring node shells do not overlap',
        g && collisions(g.nodes.map(n => ({ id: n.id, rect: n.shell.rect }))).length === 0,
        g?.nodes.map(n => ({ id: n.id, rect: n.shell.rect }))
      )
      const canonicalAfterProjection = await api('loadDefinition', {
        blueprintId: fixture.AUTHOR_ID
      })
      check('U13', 'authoring projection observation keeps exact canonical document', isDeepStrictEqual(canonicalBeforeProjection, canonicalAfterProjection), {
        beforeSha256: hash(canonicalBeforeProjection.definitionJson),
        afterSha256: hash(canonicalAfterProjection.definitionJson)
      })
      await page
        .locator('.react-flow__node-blueprint')
        .filter({ has: page.locator('[data-bp-node="input"]') })
        .click()
      const inspector = page.locator('.bp-node-inspector')
      await inspector.waitFor({ state: 'visible' })
      await page.waitForFunction(
        () =>
          document.querySelector('.bp-inspector .bp-node-id')?.textContent?.trim() === 'input' &&
          document.querySelector('.bp-node-inspector')?.getAttribute('data-bp-node-inspector') === 'input'
      )
      const bindingFields = {}
      for (const field of ['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef', 'model-mode'])
        bindingFields[field] = await inspector.locator(`[data-bp-field="${field}"]:visible`).count()
      check(
        'U03',
        'ready structural Inspector hides executable binding and model fields',
        Object.values(bindingFields).every(count => count === 0),
        { selectedNode: 'input', bindingFields }
      )
      check('U08', 'resource library provides Agent Skills MCP and other categories', (await page.locator('[data-bp-resource-category]').count()) >= 4)
      const add = page.locator('[data-bp-action="add-resource"]')
      check('U09', 'resource add opens explicit dialog', (await add.count()) === 1)
      if ((await add.count()) === 1) {
        await add.click()
        check(
          'U09',
          'resource dialog has explicit Apply and Cancel',
          (await page.locator('[data-bp-resource-dialog]').count()) === 1 &&
            (await page.locator('[data-bp-action="resource-apply"]').count()) === 1 &&
            (await page.locator('[data-bp-action="resource-cancel"]').count()) === 1
        )
        await page.keyboard.press('Escape')
        const closedDialog = page.locator('[data-bp-resource-dialog]')
        await closedDialog.waitFor({ state: 'detached' }).catch(async () => {
          await closedDialog.waitFor({ state: 'hidden' })
        })
      }
      if ((await add.count()) === 1) {
        await add.click()
        const dialog = page.locator('[data-bp-resource-dialog]')
        const fields = {
          kind: await dialog.locator('select[aria-label]').count(),
          logicalId: await dialog.locator('input[aria-label]').count(),
          title: await dialog.locator('[data-bp-resource-field="title"]').count(),
          description: await dialog.locator('[data-bp-resource-field="description"]').count(),
          configuration: await dialog.locator('[data-bp-resource-detail="configuration"]').count(),
          advanced: await dialog.locator('[data-bp-resource-advanced] [data-bp-json-editor]').count()
        }
        check(
          'U09',
          'resource dialog exposes kind name config and description fields',
          (await dialog.count()) === 1 &&
            fields.kind === 1 &&
            fields.logicalId >= 1 &&
            fields.title === 1 &&
            fields.description === 1 &&
            fields.advanced === 1 &&
            (fields.configuration === 1 || (await dialog.locator('[data-bp-resource-detail="identity"]').count()) === 1),
          { fields, text: await dialog.textContent() }
        )
        check(
          'U09',
          'resource dialog keyboard focus stays inside and Escape closes without dispatch',
          await dialog
            .locator('[data-bp-resource-field="description"]')
            .focus()
            .then(() => page.keyboard.press('Escape'))
            .then(async () => (await page.locator('[data-bp-resource-dialog]').count()) === 0),
          {}
        )
      }
      const rows = page.locator('[data-bp-resource-row]')
      check(
        'U09',
        'resource rows expose 40px pointer targets and visible identity fields',
        (await rows.count()) > 0 &&
          (await rows.evaluateAll(es =>
            es.every(e => {
              const r = e.getBoundingClientRect()
              return r.width >= 40 && r.height >= 40 && !!e.textContent?.trim()
            })
          )),
        { rows: await rows.count() }
      )
      if (await rows.count()) {
        const effectsBefore = native.requests.length
        await rows.first().click()
        const dialog = page.locator('[data-bp-resource-dialog]')
        const detail = {
          identity: await dialog.locator('[data-bp-resource-detail="identity"]').count(),
          configuration: await dialog.locator('[data-bp-resource-detail="configuration"]').count(),
          advanced: await dialog.locator('[data-bp-resource-advanced]').count(),
          fields: await dialog.locator('[data-bp-resource-field],select,input,textarea').count()
        }
        check(
          'U09',
          'resource detail reveals type name config and description without navigation',
          (await dialog.count()) === 1 && detail.identity === 1 && detail.configuration === 1 && detail.advanced === 1 && detail.fields >= 3,
          { detail, text: await dialog.textContent() }
        )
        check('U14', 'opening resource details reads no URL/header/env and no MCP effect', native.requests.length === effectsBefore && !existsSync(effects), {
          requestsBefore: effectsBefore,
          requestsAfter: native.requests.length,
          effects: existsSync(effects)
        })
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' }).catch(async () => {
          await dialog.waitFor({ state: 'hidden' })
        })
      }
      const inputCard = page.locator('.react-flow__node-blueprint').filter({ has: page.locator('[data-bp-node="input"]') })
      await inputCard.click()
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      await page.locator('.bp-node-inspector').waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.querySelector('.bp-node-inspector')?.getAttribute('data-bp-node-inspector') === 'input')
      const portToggles = page.locator('[data-bp-port-toggle]')
      check('U05/U10', 'real Inspector exposes port toggles for connected and unconnected ports', (await portToggles.count()) === 3, {
        count: await portToggles.count()
      })
      if ((await portToggles.count()) !== 3)
        receipt.notRun.push('U05/U10: real Inspector did not expose exactly control/input/output port toggles; connected/unused toggle evidence blocked')
      if ((await portToggles.count()) === 3) {
        const portBaseline = await api('loadDefinition', { blueprintId: fixture.AUTHOR_ID }),
          portBaselineJson = portBaseline.definitionJson
        const historyState = async () => ({
          dirty: await page.locator('[data-bp-dirty]').getAttribute('data-bp-dirty'),
          undoDisabled: await page.locator('[data-bp-action="undo"]').isDisabled(),
          redoDisabled: await page.locator('[data-bp-action="redo"]').isDisabled()
        })
        const portHistoryBefore = await historyState()
        const clickToggle = async side =>
          page.evaluate(side => {
            const element = document.querySelector(`[data-bp-port-toggle="${side}"]`)
            if (!(element instanceof HTMLInputElement)) throw new Error(`PORT_TOGGLE_MISSING_${side}`)
            element.click()
          }, side)
        const waitToggle = async (side, checked) => {
          await page.waitForFunction(({ side, checked }) => document.querySelector(`[data-bp-port-toggle="${side}"]`)?.checked === checked, { side, checked })
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
        }
        const selectInspector = async (nodeId, side) => {
          const inspectorSelector = `.bp-node-inspector[data-bp-node-inspector="${nodeId}"]`
          const toggleSelector = `[data-bp-port-toggle="${side}"]`
          // Alpha.3 may place the state row above the title in the hit-test
          // stack even while the title is visible. Use the mounted card's
          // public pointer path, which is the same path used for the initial
          // selection above, instead of targeting the overlapped child.
          const selectedNode = page.locator(`.react-flow__node[data-id="${nodeId}"]`)
          await selectedNode.waitFor({ state: 'visible' })
          const selected = page.locator(`.react-flow__node[data-id="${nodeId}"] .bp-node.bp-node-selected`)
          if ((await selected.count()) === 0 || (await page.locator(inspectorSelector).count()) === 0 || (await page.locator(toggleSelector).count()) === 0)
            await selectedNode.click({ force: true })
          try {
            await page.waitForFunction(
              ({ inspectorSelector, toggleSelector }) =>
                Boolean(document.querySelector(inspectorSelector)?.isConnected && document.querySelector(toggleSelector)?.isConnected),
              { inspectorSelector, toggleSelector }
            )
          } catch (error) {
            const state = await page.evaluate(
              ({ nodeId, inspectorSelector, toggleSelector }) => ({
                selected: !!document.querySelector(`.react-flow__node[data-id="${nodeId}"] .bp-node.bp-node-selected`),
                inspector: !!document.querySelector(inspectorSelector),
                toggle: !!document.querySelector(toggleSelector),
                node: !!document.querySelector(`.react-flow__node[data-id="${nodeId}"]`),
                body: document.querySelector('[data-bp-canvas="root"]')?.textContent?.slice(0, 240)
              }),
              { nodeId, inspectorSelector, toggleSelector }
            )
            throw Object.assign(new Error(`NODE_INSPECTOR_NOT_READY_${nodeId}_${side}_${JSON.stringify(state)}`), {
              code: error?.code ?? 'BROWSER_OPERATION_FAILED'
            })
          }
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
        }
        const selectInputInspector = side => selectInspector('input', side)
        const selectDecisionInspector = side => selectInspector('decision', side)
        const hostStillBaseline = async () => {
          const current = await api('loadDefinition', { blueprintId: fixture.AUTHOR_ID })
          return (
            current.definitionJson === portBaselineJson &&
            current.documentRevision === portBaseline.documentRevision &&
            current.semanticRevision === portBaseline.semanticRevision
          )
        }
        for (const side of ['control', 'outputs']) {
          const toggle = page.locator(`[data-bp-port-toggle="${side}"]`)
          const checkedBefore = await toggle.isChecked()
          await clickToggle(side)
          await page.waitForFunction(
            side =>
              document.querySelector(`[data-bp-port-toggle="${side}"]`)?.checked === true &&
              document.querySelector('[data-bp-inspector-notice="connection.portVisibilityConnected"]') !== null,
            side
          )
          const stateAfter = await historyState(),
            afterReject = await api('loadDefinition', { blueprintId: fixture.AUTHOR_ID })
          check(
            'U05/U10',
            `connected ${side} close is atomically rejected`,
            checkedBefore &&
              (await toggle.isChecked()) &&
              stateAfter.dirty === portHistoryBefore.dirty &&
              stateAfter.undoDisabled === portHistoryBefore.undoDisabled &&
              stateAfter.redoDisabled === portHistoryBefore.redoDisabled &&
              afterReject.definitionJson === portBaselineJson &&
              afterReject.documentRevision === portBaseline.documentRevision &&
              afterReject.semanticRevision === portBaseline.semanticRevision,
            {
              side,
              checkedBefore,
              checkedAfter: await toggle.isChecked(),
              notice: await page.locator('[data-bp-inspector-notice]').getAttribute('data-bp-inspector-notice'),
              stateBefore: portHistoryBefore,
              stateAfter,
              hostUnchanged: await hostStillBaseline()
            }
          )
        }
        const edgeCountBeforeDisconnect = await page.locator('[data-bp-edge]').count()
        await inputCard.click({ button: 'right' })
        const nodeMenu = page.locator('[data-bp-overlay="context-menu"]')
        await nodeMenu.waitFor({ state: 'visible' })
        const disconnect = nodeMenu.locator('[data-bp-menu-command="disconnect"]')
        check('U05/U10', 'node context menu exposes disconnect for the selected input', (await disconnect.count()) === 1 && !(await disconnect.isDisabled()), {
          edgeCountBeforeDisconnect
        })
        await disconnect.click()
        await nodeMenu.waitFor({ state: 'detached' }).catch(async () => {
          await nodeMenu.waitFor({ state: 'hidden' })
        })
        await page.waitForFunction(before => document.querySelectorAll('[data-bp-edge]').length < before, edgeCountBeforeDisconnect)
        await selectInputInspector('outputs')
        await selectDecisionInspector('control')
        const decisionNode = page.locator('.react-flow__node[data-id="decision"]')
        const edgeCountBeforeDecisionDisconnect = await page.locator('[data-bp-edge]').count()
        await decisionNode.click({ button: 'right', force: true })
        const decisionMenu = page.locator('[data-bp-overlay="context-menu"]')
        await decisionMenu.waitFor({ state: 'visible' })
        const decisionDisconnect = decisionMenu.locator('[data-bp-menu-command="disconnect"]')
        requireTrue((await decisionDisconnect.count()) === 1 && !(await decisionDisconnect.isDisabled()), 'DECISION_DISCONNECT_UNAVAILABLE')
        await decisionDisconnect.click()
        await decisionMenu.waitFor({ state: 'detached' }).catch(async () => {
          await decisionMenu.waitFor({ state: 'hidden' })
        })
        await page.waitForFunction(before => document.querySelectorAll('[data-bp-edge]').length < before, edgeCountBeforeDecisionDisconnect)
        for (const side of ['control', 'inputs']) {
          await selectDecisionInspector(side)
          const toggle = page.locator(`[data-bp-port-toggle="${side}"]`)
          const checkedBefore = await toggle.isChecked()
          if (checkedBefore) await clickToggle(side)
          await waitToggle(side, false)
          const handles =
            side === 'control'
              ? await page.locator('[data-bp-node="decision"] [data-bp-port^="decision:control:"]').count()
              : await page.locator('[data-bp-node="decision"] [data-bp-port^="decision:data:"]').count()
          check('U05/U10', `disconnected ${side} can be hidden without changing the Host document`, !(await toggle.isChecked()) && handles === 0, {
            node: 'decision',
            side,
            checkedBefore,
            checked: await toggle.isChecked(),
            handles,
            edgeCountBeforeDecisionDisconnect,
            hostUnchanged: await hostStillBaseline()
          })
        }
        await selectInputInspector('outputs')
        const inputOutputs = page.locator('[data-bp-port-toggle="outputs"]')
        if (!(await inputOutputs.isChecked())) {
          await clickToggle('outputs')
          await waitToggle('outputs', true)
        }
        await selectDecisionInspector('inputs')
        const hiddenTargetHandles = await page.locator('[data-bp-node="decision"] [data-bp-port^="decision:data:"]').count()
        const sourceHandle = page.locator('[data-bp-port-out="input:data:a"]')
        const sourceBox = await sourceHandle.boundingBox(),
          targetBox = await decisionNode.boundingBox()
        const edgesBeforeHiddenConnect = await page.locator('[data-bp-edge]').count()
        if (sourceBox && targetBox) {
          await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
          await page.mouse.down()
          await page.mouse.move(targetBox.x + 3, targetBox.y + targetBox.height / 2, { steps: 8 })
          await page.mouse.up()
          await page.waitForTimeout(150)
        }
        const searchOverlay = page.locator('[data-bp-overlay="node-search"]')
        if (await searchOverlay.count()) await page.keyboard.press('Escape')
        const edgesAfterHiddenConnect = await page.locator('[data-bp-edge]').count()
        check(
          'U05/U10',
          'hidden target rejects a real pointer connection without partial graph mutation',
          sourceBox && targetBox && hiddenTargetHandles === 0 && edgesAfterHiddenConnect === edgesBeforeHiddenConnect,
          {
            sourceBox,
            targetBox,
            hiddenTargetHandles,
            edgesBeforeHiddenConnect,
            edgesAfterHiddenConnect,
            status: await page.locator('[data-bp-status]').getAttribute('data-bp-status-key')
          }
        )
        // Port checks intentionally use an isolated local draft. Remove it before
        // the following drag/resource journey so that the later Save receipt starts
        // from the same Host definition and a clean history stack.
        await page.evaluate(() => localStorage.removeItem('xuanling-blueprint:draft:node-ux-author'))
        await page.reload({ waitUntil: 'networkidle' })
        await page.waitForFunction(() => Boolean(window.__DSH_BOOT__?.entries?.some(e => (e.id ?? e.package) === '@xuanling-rs/xuanling-dsh-blueprint')), {
          timeout: 60000
        })
        const onboarding = await import('./onboarding-journey.mjs')
        const visibleOnboarding = page.locator('[role="dialog"]:visible')
        if ((await visibleOnboarding.count()) > 0) await onboarding.dismissOnboardingDialogs(page)
        const reloadedPanel = page.locator('[data-bp-canvas="root"]')
        if ((await reloadedPanel.count()) === 0 || !(await reloadedPanel.isVisible().catch(() => false))) {
          const sidebar = page.getByRole('button', { name: /XuanLing Blueprint|玄灵蓝图/ })
          await sidebar.waitFor({ state: 'visible' })
          await sidebar.click()
        }
        await reloadedPanel.waitFor({ state: 'visible' })
        const reloadedSelect = page.locator('[data-bp-select="blueprint"]')
        await reloadedSelect.waitFor({ state: 'visible' })
        await selectStyledOption(page, reloadedSelect, fixture.AUTHOR_ID)
        await page.waitForFunction(id => document.querySelector('[data-bp-blueprint]')?.getAttribute('data-bp-blueprint') === id, fixture.AUTHOR_ID)
        await page.locator('.react-flow__node[data-id="input"]').waitFor()
        await page.waitForFunction(() => document.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty') === 'false')
      }
      const saveAction = page.locator('[data-bp-action="save-layout"]')
      const undoAction = page.locator('[data-bp-action="undo"]')
      const redoAction = page.locator('[data-bp-action="redo"]')
      const authorNode = page.locator('.react-flow__node[data-id="input"]')
      const authorTitle = authorNode.locator('.bp-node-title')
      await authorTitle.scrollIntoViewIfNeeded()
      const beforeHost = await api('loadDefinition', { blueprintId: fixture.AUTHOR_ID })
      const beforeDocument = JSON.parse(beforeHost.definitionJson)
      const beforeStyle = await authorNode.getAttribute('style')
      const dragBox = await authorTitle.boundingBox()
      requireTrue(
        (await saveAction.count()) === 1 &&
          (await undoAction.count()) === 1 &&
          (await redoAction.count()) === 1 &&
          dragBox &&
          dragBox.width > 0 &&
          dragBox.height > 0,
        'AUTHORING_HISTORY_CONTROLS_MISSING'
      )
      await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + dragBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(dragBox.x + dragBox.width / 2 + 37, dragBox.y + dragBox.height / 2 + 21, { steps: 6 })
      await page.mouse.up()
      await page.waitForFunction(() => document.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty') === 'true')
      const afterDragStyle = await authorNode.getAttribute('style')
      const undoEnabled = !(await undoAction.isDisabled())
      await undoAction.click()
      await page.waitForFunction(
        () =>
          document.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty') === 'false' && !document.querySelector('[data-bp-action="redo"]')?.disabled
      )
      const afterUndoStyle = await authorNode.getAttribute('style')
      const redoEnabled = !(await redoAction.isDisabled())
      await redoAction.click()
      await page.waitForFunction(() => document.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty') === 'true')
      const afterRedoStyle = await authorNode.getAttribute('style')
      const transformOf = style => style?.match(/transform:\s*([^;]+)/)?.[1] ?? null
      const beforeTransform = transformOf(beforeStyle),
        afterDragTransform = transformOf(afterDragStyle),
        afterUndoTransform = transformOf(afterUndoStyle),
        afterRedoTransform = transformOf(afterRedoStyle)
      if (options.phase === 'green') {
        {
          const resourceBaseline = await api('loadDefinition', { blueprintId: fixture.AUTHOR_ID }),
            resourceBaselineDefinition = JSON.parse(resourceBaseline.definitionJson),
            resourceRow = page.locator('[data-bp-resource-row="blueprint:agent"]')
          if ((await resourceRow.count()) !== 1) {
            check('U09', 'resource Apply target row is present', false, {
              count: await resourceRow.count()
            })
            receipt.notRun.push('U11/U12: resource Apply target row unavailable')
          } else {
            await resourceRow.click()
            const resourceDialog = page.locator('[data-bp-resource-dialog]')
            await resourceDialog.waitFor({ state: 'visible' })
            const expectedResourceTitle = `Collector-visible agent - ${await resourceDialog.locator('[data-bp-resource-source]').innerText()}`
            await resourceDialog.locator('[data-bp-resource-field="title"]').fill('Collector-visible agent')
            await resourceDialog.locator('[data-bp-resource-field="description"]').fill('Collector safe description')
            await resourceDialog.locator('[data-bp-action="resource-apply"]').click()
            await resourceDialog.waitFor({ state: 'detached' }).catch(async () => {
              await resourceDialog.waitFor({ state: 'hidden' })
            })
            const localResource = JSON.parse((await api('loadDefinition', { blueprintId: fixture.AUTHOR_ID })).definitionJson),
              resourceDirty = (await page.locator('[data-bp-dirty="true"]').count()) === 1
            check('U09', 'resource Apply keeps Host unchanged until Save', resourceDirty && isDeepStrictEqual(localResource, resourceBaselineDefinition), {
              resourceDirty,
              hostUnchanged: isDeepStrictEqual(localResource, resourceBaselineDefinition)
            })
            const resourceUndo = page.locator('[data-bp-action="undo"]'),
              resourceRedo = page.locator('[data-bp-action="redo"]'),
              resourceUndoEnabled = !(await resourceUndo.isDisabled())
            await resourceUndo.click()
            await resourceRedo.click()
            await page.waitForFunction(
              title => document.querySelector('[data-bp-resource-row="blueprint:agent"] strong')?.textContent === title,
              expectedResourceTitle
            )
            check(
              'U12',
              'resource Apply roundtrips as one Undo/Redo transaction',
              resourceUndoEnabled && (await page.locator('[data-bp-resource-row="blueprint:agent"] strong').textContent()) === expectedResourceTitle,
              { resourceUndoEnabled }
            )
          }
        }
        await saveAction.click()
        await page.waitForFunction(() => document.querySelector('[data-bp-status="message"]')?.getAttribute('data-bp-status-key') === 'status.saved')
        const afterSave = await api('loadDefinition', { blueprintId: fixture.AUTHOR_ID })
        const afterDocument = JSON.parse(afterSave.definitionJson)
        const positionChanged =
          afterDocument.presentation?.nodes?.input?.x !== beforeDocument.presentation?.nodes?.input?.x ||
          afterDocument.presentation?.nodes?.input?.y !== beforeDocument.presentation?.nodes?.input?.y
        const resourceMetadata = afterDocument.presentation?.resources?.agent
        const resourceSaved =
          afterDocument.resources?.agent?.path === 'lib/agents/review.md' &&
          resourceMetadata?.title === 'Collector-visible agent' &&
          resourceMetadata?.description === 'Collector safe description'
        const savedDirty = await page.locator('[data-bp-dirty]').getAttribute('data-bp-dirty')
        check(
          'U11',
          'real drag/resource Undo/Redo and Host Save roundtrip preserve the edited presentation',
          undoEnabled &&
            redoEnabled &&
            beforeTransform !== afterDragTransform &&
            afterUndoTransform === beforeTransform &&
            afterRedoTransform === afterDragTransform &&
            positionChanged &&
            resourceSaved &&
            afterSave.documentRevision !== beforeHost.documentRevision &&
            savedDirty === 'false',
          {
            beforeStyle,
            afterDragStyle,
            afterUndoStyle,
            afterRedoStyle,
            beforeTransform,
            afterDragTransform,
            afterUndoTransform,
            afterRedoTransform,
            undoEnabled,
            redoEnabled,
            beforeRevision: beforeHost.documentRevision,
            afterRevision: afterSave.documentRevision,
            positionChanged,
            resourceSaved,
            resourceMetadata,
            savedDirty
          }
        )
        const { dismissOnboardingDialogs } = await import('./onboarding-journey.mjs')
        await page.reload({ waitUntil: 'networkidle' })
        await page.waitForFunction(() => Boolean(window.__DSH_BOOT__?.entries?.some(e => (e.id ?? e.package) === '@xuanling-rs/xuanling-dsh-blueprint')), {
          timeout: 60000
        })
        const visibleDialog = page.locator('[role="dialog"]:visible')
        if ((await visibleDialog.count()) > 0) await dismissOnboardingDialogs(page)
        const panel = page.locator('[data-bp-canvas="root"]')
        if ((await panel.count()) === 0 || !(await panel.isVisible().catch(() => false))) {
          const sidebar = page.getByRole('button', { name: /XuanLing Blueprint|玄灵蓝图/ })
          await sidebar.waitFor({ state: 'visible' })
          await sidebar.click()
        }
        await panel.waitFor({ state: 'visible' })
        await page.locator('[data-bp-select="blueprint"]').waitFor({ state: 'visible' })
        await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), fixture.AUTHOR_ID)
        await page.waitForFunction(id => document.querySelector('[data-bp-blueprint]')?.getAttribute('data-bp-blueprint') === id, fixture.AUTHOR_ID)
        await page.locator('.react-flow__node[data-id="input"]').waitFor()
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
        const reopenedNode = page.locator('.react-flow__node[data-id="input"]')
        const reopenedStyle = await reopenedNode.getAttribute('style')
        const reopenedTransform = transformOf(reopenedStyle)
        const reopenedHost = await api('loadDefinition', { blueprintId: fixture.AUTHOR_ID })
        const reopenedDefinition = JSON.parse(reopenedHost.definitionJson)
        const reopenedDirty = await page.locator('[data-bp-dirty]').getAttribute('data-bp-dirty')
        const reopenedUndoDisabled = await page.locator('[data-bp-action="undo"]').isDisabled()
        check(
          'U12',
          'browser reload reopens the saved Host document with resource metadata and no stale local history',
          reopenedTransform === afterRedoTransform &&
            isDeepStrictEqual(reopenedDefinition, afterDocument) &&
            reopenedDefinition.presentation?.resources?.agent?.title === 'Collector-visible agent' &&
            reopenedDefinition.presentation?.resources?.agent?.description === 'Collector safe description' &&
            reopenedDirty === 'false' &&
            reopenedUndoDisabled,
          {
            reopenedStyle,
            afterRedoStyle,
            reopenedTransform,
            afterRedoTransform,
            dirty: reopenedDirty,
            undoDisabled: reopenedUndoDisabled,
            resourceMetadata: reopenedDefinition.presentation?.resources?.agent,
            revision: reopenedHost.documentRevision
          }
        )
        check('U09', 'resource Apply/Cancel and keyboard evidence completed above', (await page.locator('[data-bp-resource-dialog]').count()) === 0, {
          dialogCount: await page.locator('[data-bp-resource-dialog]').count()
        })
        const { measureCanvasPerformance } = await import('./canvas-journey.mjs'),
          { performanceDefinition, fixtureEvidence } = await import('./canvas-fixtures.mjs')
        const blueprintSelect = page.locator('[data-bp-select="blueprint"]')
        await blueprintSelect.waitFor({ state: 'attached' })
        await blueprintSelect.waitFor({ state: 'visible' })
        receipt.performance = await measureCanvasPerformance(
          page,
          (id, name, ok, facts) => check(id, name, ok, facts),
          fixtureEvidence(performanceDefinition()),
          async (method, args) => ({
            status: 200,
            body: { result: { ok: true, value: await api(method, args) } }
          })
        )
        await snap('performance')
      }
    })
    check('U14', 'opening catalog/details never dispatches MCP', !existsSync(effects))
    const observer = browser.publicObserverSnapshot(profile.observerFile)
    receipt.observer = observer
    check(
      'U15',
      'no model requests',
      observer.sessions.every(s => s.requests.length === 0)
    )
    check('U15', 'no browser errors', receipt.pageErrors.length === 0)
    receipt.fingerprintAfter = captureEvidenceFingerprint()
    check('U15', 'source and built artifact unchanged during collector', isDeepStrictEqual(receipt.fingerprintBefore, receipt.fingerprintAfter))
    receipt.installedAfter = runtime.artifactInventory(join(profile.installedPackage, 'lib'))
    check('U15', 'installed artifact unchanged', isDeepStrictEqual(receipt.installed.inventory, receipt.installedAfter))
  } catch (e) {
    receipt.readinessFailure = {
      code: e.code ?? 'HOST_OR_BROWSER_OPERATION_FAILED',
      message: safeMessage(e)
    }
    console.error(receipt.readinessFailure.code)
  } finally {
    native?.stop()
    try {
      await edge?.close()
      receipt.cleanup.browserClosed = true
    } catch {
      receipt.cleanup.browserClosed = false
    }
    try {
      const { stopHost } = await import('./conversation-runtime.mjs')
      await stopHost(host?.child)
      receipt.cleanup.hostStopped = true
    } catch {
      receipt.cleanup.hostStopped = false
    }
    if (root) {
      rmSync(root, { recursive: true, force: true })
      receipt.cleanup.isolationRemoved = !existsSync(root)
    }
    receipt.finishedAt = new Date().toISOString()
    receipt.status =
      receipt.cleanup.browserClosed === false || receipt.cleanup.hostStopped === false || receipt.cleanup.isolationRemoved === false
        ? 'cleanup-failed'
        : receipt.readinessFailure
          ? 'readiness-failed'
          : receipt.cases.some(c => !c.passed)
            ? 'product-assertions-failed'
            : receipt.notRun.length
              ? 'incomplete'
              : 'passed'
    writeFileSync(join(options.reportDir, 'receipt.json'), JSON.stringify(receipt, null, 2))
  }
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCli(process.argv.slice(2))
    if (options.help)
      console.log(
        'Usage: node --experimental-transform-types test/blueprint/capabilities/node-ux-ui.mjs --report-dir <fresh absolute directory> [--phase red|green] [--pnpm-executable <physical absolute real pnpm CLI>]\nNo build. Always real CLI installation/keyless structural bound Run/native Edge. Both phases assert the target behavior; product red exits 1, invalid CLI exits 2. Green remains incomplete while any required journey is not-run.'
      )
    else {
      const r = await runCollector(options)
      process.exitCode = r.status === 'passed' ? 0 : 1
    }
  } catch (e) {
    console.error(e.code ?? 'CLI_INVALID')
    process.exitCode = 2
  }
}
