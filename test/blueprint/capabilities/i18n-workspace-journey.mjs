#!/usr/bin/env node
import { selectStyledOption } from './styled-control-entry.mjs'
/** Native installed-DSH acceptance; Settings owns language and theme preferences.
 * No copied locale runtime, fake t, DOM clicks, user profiles or credential access.
 * The ordinary host/canvas journey remains required; this adds locale contracts.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { runCanvasJourney as runBaseJourney, measureCanvasPerformance, BROWSER_ASSERTIONS } from './canvas-journey.mjs'
import { HOST_ASSERTIONS, validateCanvasReport } from './canvas-suite.mjs'
import { captureEvidenceFingerprint } from '../../../integrations/deepseek-harness/xuanling-blueprint/scripts/verify.mjs'
import { dismissOnboardingDialogs } from './onboarding-journey.mjs'

export { measureCanvasPerformance }
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../../..')
const PLUGIN = join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint')
const PLAN_ID = 'dsh-blueprint-i18n-workspace-v1'
const I18N_ASSERTIONS = [
  'I18N-NATIVE',
  'I18N-SEARCH',
  'I18N-CAPABILITY',
  'I18N-GROUPS',
  'I18N-UNGROUP',
  'I18N-GROUP-RELOAD',
  'I18N-INSPECTOR',
  'I18N-STRUCTURED',
  'I18N-OVERLAY',
  'I18N-THEME',
  ...[1, 2, 3].map(n => `I18N-PRESERVE-${n}`)
]
const PALETTE_LABELS = {
  en: ['+ Input', '+ Agent task', '+ Approval', '+ Condition', '+ Join (all)', '+ Output'],
  zh: ['+ 输入', '+ 智能体任务', '+ 人工决策', '+ 条件', '+ 汇合（全部）', '+ 输出']
}
const action = (page, id) => page.locator(`[data-bp-action="${id}"]`)
const root = page => page.locator('[data-bp-canvas="root"]')
const node = (page, id) => page.locator(`.react-flow__node[data-id="${id}"]`)
const sha256 = data => createHash('sha256').update(data).digest('hex')
function value(response, label) {
  if (response?.status !== 200 || response?.body?.result?.ok !== true)
    throw new Error(`${label}: real RPC failed (${response?.body?.result?.error?.code ?? response?.status})`)
  return response.body.result.value
}
async function settings(page, allowShortcutFallback = false) {
  if (!allowShortcutFallback) await page.getByRole('button', { name: /^(设置|Settings)$/ }).click()
  else {
    const trigger = page.getByRole('button', { name: /^(设置|Settings)$/ })
    if ((await trigger.count()) && (await trigger.isVisible().catch(() => false))) await trigger.click()
    else await page.keyboard.press('Meta+Alt+,')
  }
  const modal = page.locator('[data-shortcut-modal="settings"]')
  await modal.waitFor({ state: 'visible' })
  return modal
}
async function closeSettings(modal) {
  await modal.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await modal.waitFor({ state: 'hidden' })
}
export async function setNativeLocale(page, id) {
  if (!['zh', 'en'].includes(id)) throw new Error('unsupported acceptance locale')
  const modal = await settings(page)
  const selected = modal.getByRole('button', { name: /^(中文|English)$/ })
  const label = id === 'zh' ? '中文' : 'English'
  if ((await selected.textContent()).trim() !== label) {
    await selected.click()
    await page.getByRole('menuitem', { name: label, exact: true }).click()
  }
  await modal.getByText(id === 'zh' ? '语言' : 'Language', { exact: true }).waitFor({ state: 'visible' })
  await closeSettings(modal)
  // Observe the plugin's translated action, not merely the host language row.
  await action(page, 'start-run')
    .filter({ hasText: id === 'zh' ? /^运行$/ : /^Run$/ })
    .waitFor({ state: 'visible' })
}
export async function setNativeTheme(page, scheme, allowShortcutFallback = false) {
  const modal = await settings(page, allowShortcutFallback)
  const button = modal.getByRole('button', {
    name: scheme === 'dark' ? /^(深色|Dark)$/ : /^(浅色|Light)$/
  })
  // Appearance publishes optimistically; only a changed selection writes Host settings.
  const accepted =
    (await button.getAttribute('aria-pressed')) === 'true'
      ? null
      : page.waitForResponse(response => {
          const request = response.request()
          if (new URL(request.url()).pathname !== '/api/settings/mutate' || request.method() !== 'POST') return false
          let body
          try {
            body = request.postDataJSON()
          } catch {
            return false
          }
          const args = body?.payload?.args
          const op = args?.ops?.[0]
          return (
            body?.method === 'settings/mutate' &&
            args?.ns === 'ui-theme' &&
            Array.isArray(args.ops) &&
            args.ops.length === 1 &&
            op?.op === 'set' &&
            Array.isArray(op.path) &&
            op.path.length === 1 &&
            op.path[0] === 'preference' &&
            op.value === scheme
          )
        })
  // Attach both promises so native click failures also retain the response wait's rejection handler.
  const [response] = await Promise.all([accepted, button.click()])
  if (response) {
    const body = await response.json()
    const view = body?.result?.value
    if (response.status() !== 200 || body?.result?.ok !== true || view?.ns !== 'ui-theme' || view?.value?.preference !== scheme)
      throw new Error(`native ${scheme} theme mutation was not accepted`)
  }
  await page.waitForFunction(
    scheme => getComputedStyle(document.documentElement).colorScheme === scheme && document.body.hasAttribute('data-ds-dark-theme') === (scheme === 'dark'),
    scheme
  )
  await closeSettings(modal)
}
function observeRequests(page) {
  const requests = []
  const listener = request => {
    if (!request.url().includes('/api/blueprint/') || request.method() !== 'POST') return
    const body = request.postDataJSON()
    const args = body?.payload?.args?.args ?? body?.payload?.args
    requests.push({
      method: body?.method,
      runId: args?.runId ?? null,
      blueprintId: args?.blueprintId ?? null
    })
  }
  page.on('request', listener)
  return { requests, stop: () => page.off('request', listener) }
}
async function currentRun(page, api) {
  const text = await page.locator('[data-bp-run]').textContent()
  const runId = text.split(' · ')[0].trim()
  return value(await api('inspectRun', { runId }), 'inspect current fixture run')
}
async function snapshot(page, api, blueprintId) {
  const ui = await root(page).evaluate(el => ({
    blueprintId: el.getAttribute('data-bp-blueprint'),
    dirty: el.querySelector('[data-bp-dirty]')?.getAttribute('data-bp-dirty'),
    selection: Array.from(el.querySelectorAll('.react-flow__node.selected'), n => n.getAttribute('data-id')).sort(),
    viewport: el.querySelector('.react-flow__viewport')?.getAttribute('style'),
    undoDisabled: el.querySelector('[data-bp-action="undo"]')?.disabled,
    redoDisabled: el.querySelector('[data-bp-action="redo"]')?.disabled,
    draft: localStorage.getItem(`xuanling-blueprint:draft:${encodeURIComponent(el.getAttribute('data-bp-blueprint'))}`),
    values: Array.from(el.querySelectorAll('input,textarea,select'), (input, index) => ({
      index,
      hook: input.getAttribute('data-bp-field') ?? input.getAttribute('data-bp-json'),
      value: input.value,
      checked: input.type === 'checkbox' ? input.checked : null
    })),
    runId: el.querySelector('[data-bp-run]')?.textContent?.split(' · ')[0].trim()
  }))
  return {
    ui,
    document: value(await api('loadDefinition', { blueprintId }), 'snapshot fixture definition'),
    run: await currentRun(page, api)
  }
}
async function reopen(page) {
  await dismissOnboardingDialogs(page)
  if (!(await root(page).isVisible())) await page.getByRole('button', { name: /^(XuanLing Blueprint|XuanLing 蓝图|玄灵蓝图)$/ }).click()
  await root(page).waitFor({ state: 'visible' })
}
async function save(page) {
  await action(page, 'save-layout').click()
  await page.waitForFunction(() => document.querySelector('[data-bp-status-key]')?.getAttribute('data-bp-status-key') === 'status.saved')
}
async function dragNode(page, id, dx, dy) {
  const title = node(page, id).locator('.bp-node-title')
  await title.scrollIntoViewIfNeeded()
  const box = await title.boundingBox()
  if (!box || box.width <= 0 || box.height <= 0) throw new Error('node title is not hit-testable')
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 6 })
  await page.mouse.up()
}
async function groupsJourney(page, assert, api) {
  const before = value(await api('loadDefinition', { blueprintId: 'canvas-approval' }), 'before grouping')
  await node(page, 'gate').locator('.bp-node-title').click()
  await node(page, 'out')
    .locator('.bp-node-title')
    .click({ modifiers: ['ControlOrMeta'] })
  await page.waitForFunction(() => document.querySelectorAll('.react-flow__node.selected').length === 2)
  await action(page, 'group-selection').click()
  await page.locator('[data-bp-group]').waitFor({ state: 'visible' })
  const id = await page.locator('[data-bp-group]').getAttribute('data-bp-group')
  await action(page, 'undo').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-bp-group]').length === 0)
  await action(page, 'redo').click()
  await page.locator(`[data-bp-group="${id}"]`).waitFor({ state: 'visible' })
  const executableIds = await page.locator('[data-bp-node]').evaluateAll(items => items.map(el => el.getAttribute('data-bp-node')).sort())
  await action(page, `ungroup-${id}`).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-bp-group]').length === 0)
  const afterUngroup = await page.locator('[data-bp-node]').evaluateAll(items => items.map(el => el.getAttribute('data-bp-node')).sort())
  await action(page, 'undo').click()
  await page.locator(`[data-bp-group="${id}"]`).waitFor({ state: 'visible' })
  assert(
    'I18N-UNGROUP',
    'real ungroup and Undo retain executable nodes and restore the presentation frame',
    isDeepStrictEqual(executableIds, afterUngroup),
    JSON.stringify({ groupId: id, executableIds, afterUngroup })
  )
  await save(page)
  const after = value(await api('loadDefinition', { blueprintId: 'canvas-approval' }), 'after grouping')
  const a = JSON.parse(before.definitionJson),
    b = JSON.parse(after.definitionJson)
  assert(
    'I18N-GROUPS',
    'real multi-select grouping, undo/redo and Save affect presentation only',
    isDeepStrictEqual(a.graph, b.graph) &&
      after.semanticRevision === before.semanticRevision &&
      b.presentation.groups.length === 1 &&
      isDeepStrictEqual([...b.presentation.groups[0].nodeIds].sort(), ['gate', 'out']),
    JSON.stringify({
      groupId: id,
      semanticUnchanged: after.semanticRevision === before.semanticRevision
    })
  )
  const reads = observeRequests(page)
  try {
    await page.reload({ waitUntil: 'networkidle' })
    await reopen(page)
    await selectStyledOption(page, page.locator('[data-bp-select="blueprint"]'), 'canvas-approval')
    await page.locator(`[data-bp-group="${id}"]`).waitFor({ state: 'visible' })
    await page.locator('[data-bp-run="cancelled"]').waitFor({ state: 'visible' })
    const reloaded = value(await api('loadDefinition', { blueprintId: 'canvas-approval' }), 'reloaded grouped fixture')
    assert(
      'I18N-GROUP-RELOAD',
      'real reload restores presentation groups and inspects its bound cancelled run without command replay',
      isDeepStrictEqual(reloaded, after) &&
        !reads.requests.some(r => /\/(?:startRun|cancelRun|decide)$/.test(r.method)) &&
        reads.requests.some(r => r.method === 'blueprint/inspectRun'),
      JSON.stringify({ groupId: id, requests: reads.requests })
    )
  } finally {
    reads.stop()
  }
  return { groupId: id, before, after }
}

export async function runCanvasJourney(page, assert, api) {
  await setNativeLocale(page, 'en')
  const base = await runBaseJourney(page, assert, api)
  const grouping = await groupsJourney(page, assert, api)
  const search = page.locator('[data-bp-palette-search]')
  const searches = []
  for (const [query, kind] of [
    ['输入', 'input'],
    ['agent', 'agentTask'],
    ['审批', 'humanDecision'],
    ['output', 'output'],
    ['条件', 'condition'],
    ['join', 'join']
  ]) {
    await search.fill(query)
    const ids = await page.locator('[data-bp-action^="add-"]').evaluateAll(items => items.map(el => el.getAttribute('data-bp-action')))
    searches.push({ query, ids })
    if (!ids.includes(`add-${kind}`)) throw new Error(`catalogue search did not find ${kind}`)
  }
  await search.fill('')
  assert('I18N-SEARCH', 'native palette finds six supported kinds using Chinese, English and kind terms', searches.length === 6, JSON.stringify(searches))
  const palette = await page.locator('[data-bp-action^="add-"]').evaluateAll(items => items.map(el => el.getAttribute('data-bp-action')).sort())
  assert(
    'I18N-CAPABILITY',
    'palette does not advertise TeamStage/subflow or other unsupported execution kinds',
    isDeepStrictEqual(palette, ['add-agentTask', 'add-condition', 'add-humanDecision', 'add-input', 'add-join', 'add-output']),
    JSON.stringify(palette)
  )
  // Trusted layout drags leave a genuine unsaved draft and both Undo/Redo
  // available; malformed textarea content alone is not an editor mutation.
  await dragNode(page, 'out', 24, 18)
  await dragNode(page, 'out', -12, 15)
  await action(page, 'undo').click()
  await node(page, 'out').locator('.bp-node-title').click()
  // All fixture data are operator-generated, never taken from user profiles.
  const advanced = page.locator('[data-bp-json="options"]')
  if (!(await advanced.isVisible())) await page.locator('[data-bp-inspector-advanced]').click()
  await advanced.fill('{"unfinished":')
  await page.locator('[data-bp-run-input]').fill('{"工作语言":"zh prompt stays unchanged"}')
  await page.locator('[name="runId"]').fill('unsubmitted-run-id')
  const panelIdentity = await root(page).elementHandle()
  const stable = await snapshot(page, api, 'canvas-approval')
  if (
    stable.ui.dirty !== 'true' ||
    !stable.ui.draft ||
    stable.ui.undoDisabled ||
    stable.ui.redoDisabled ||
    !isDeepStrictEqual(stable.ui.selection, ['out']) ||
    !stable.ui.values.some(input => input.hook === 'options' && input.value === '{"unfinished":')
  ) {
    throw new Error('locale preservation preconditions require a real dirty draft, selection, undo/redo and unfinished JSON')
  }
  const preservation = []
  const requests = observeRequests(page)
  try {
    for (let pass = 1; pass <= 3; pass++) {
      for (const locale of ['zh', 'en']) {
        await setNativeLocale(page, locale)
        const labels = await page.locator('[data-bp-action^="add-"] strong').allTextContents()
        if (!isDeepStrictEqual(labels, PALETTE_LABELS[locale])) throw new Error(`native ${locale} palette exact labels differ`)
        const observed = await snapshot(page, api, 'canvas-approval')
        const sameElement = await panelIdentity.evaluate(el => el === document.querySelector('[data-bp-canvas="root"]'))
        preservation.push({
          pass,
          locale,
          sameElement,
          unchanged: isDeepStrictEqual(stable, observed)
        })
        if (!sameElement || !isDeepStrictEqual(stable, observed)) throw new Error(`locale ${locale} changed editor/input/history/Run state (pass ${pass})`)
      }
      assert(
        `I18N-PRESERVE-${pass}`,
        'native zh/en roundtrip preserves selection, viewport, undo/redo, dirty draft, unfinished JSON, run input/ID and canonical definition/run',
        true,
        JSON.stringify(preservation.filter(r => r.pass === pass))
      )
    }
    assert(
      'I18N-NATIVE',
      'native Settings translates plugin controls without replaying blueprint commands',
      !requests.requests.some(r => /\/(?:startRun|saveDefinition|cancelRun|decide)$/.test(r.method)),
      JSON.stringify({ requests: requests.requests, transitions: preservation.length })
    )
  } finally {
    requests.stop()
  }
  // Exercise the actual mounted structured port handlers, not just SSR props.
  await action(page, 'add-output-port').click()
  await page.locator('[data-bp-field="outputs.name"]').last().fill('structured.part [中文]')
  await page.locator('[data-bp-field="outputs.type"]').last().fill('string')
  await action(page, 'apply-output-ports').click()
  const structured = await page.evaluate(() =>
    JSON.parse(JSON.parse(localStorage.getItem('xuanling-blueprint:draft:canvas-approval')).definitionJson).graph.nodes.find(n => n.id === 'out')
  )
  await action(page, 'undo').click()
  await page.locator('[data-bp-overlay="eligible"]').waitFor({ state: 'visible' })
  const restoredGraph = await page.evaluate(() => JSON.parse(JSON.parse(localStorage.getItem('xuanling-blueprint:draft:canvas-approval')).definitionJson).graph)
  assert(
    'I18N-STRUCTURED',
    'real structured output-port form preserves its exact key/type and Undo restores the full executable graph',
    structured.outputs['structured.part [中文]'] === 'string' && isDeepStrictEqual(restoredGraph, JSON.parse(grouping.after.definitionJson).graph),
    JSON.stringify({
      outputs: structured.outputs,
      undoRestored: isDeepStrictEqual(restoredGraph, JSON.parse(grouping.after.definitionJson).graph)
    })
  )
  await node(page, 'out').locator('.bp-node-title').click()
  await page.locator('[data-bp-node-inspector="out"]').waitFor({ state: 'visible' })
  if (!(await advanced.isVisible())) await page.locator('[data-bp-inspector-advanced]').click()
  // Continue advanced Inspector/overlay/theme evidence in this same native page.
  const options = JSON.parse(grouping.after.definitionJson).graph.nodes.find(n => n.id === 'out')
  await advanced.fill(JSON.stringify({ ...options, outputs: { 'awkward.port [中文]': 'string' } }))
  await action(page, 'apply-node-options').click()
  await page.locator('[data-bp-overlay="suppressed"]').waitFor({ state: 'visible' })
  assert(
    'I18N-INSPECTOR',
    'advanced JSON applies only edited fixture fields; awkward valid output keys are preserved in the draft',
    (await page.evaluate(
      () =>
        JSON.parse(JSON.parse(localStorage.getItem('xuanling-blueprint:draft:canvas-approval')).definitionJson).graph.nodes.find(n => n.id === 'out').outputs[
          'awkward.port [中文]'
        ]
    )) === 'string',
    'stable port identity; host validates on explicit Save'
  )
  const suppressed = await page.locator('[data-bp-node-state]').allTextContents()
  assert(
    'I18N-OVERLAY',
    'semantic edit suppresses old node Attempt projection but retains authoritative Run details and definitionRevision',
    suppressed.every(text => text === 'Not running') &&
      (await page.locator('[data-bp-run="cancelled"]').isVisible()) &&
      !!(await page.locator('[data-bp-run-revision]').textContent()),
    JSON.stringify({
      suppressed,
      runId: stable.run.runId,
      revision: stable.run.definitionRevision
    })
  )
  await action(page, 'undo').click()
  await page.locator('[data-bp-overlay="eligible"]').waitFor({ state: 'visible' })
  const dir = process.env.BP_I18N_ARTIFACT_DIR
  if (!dir) throw new Error('fresh routed native artifact directory is required')
  const themes = []
  const style = await page.locator('#xuanling-blueprint-canvas-css').elementHandle()
  const css = await style.textContent()
  for (const locale of ['en', 'zh'])
    for (const scheme of ['dark', 'light']) {
      await setNativeLocale(page, locale)
      await setNativeTheme(page, scheme)
      const evidence = await root(page).evaluate(el => ({
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
        rootBackground: getComputedStyle(el).backgroundColor,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        rootText: getComputedStyle(el).color,
        bodyText: getComputedStyle(document.body).color,
        scheme: getComputedStyle(document.documentElement).colorScheme,
        overflow: document.documentElement.scrollWidth > window.innerWidth
      }))
      const unchangedStyle =
        (await style.evaluate(el => el === document.getElementById('xuanling-blueprint-canvas-css'))) && (await style.textContent()) === css
      if (
        evidence.width < 800 ||
        evidence.height < 500 ||
        evidence.overflow ||
        evidence.scheme !== scheme ||
        evidence.rootBackground !== evidence.bodyBackground ||
        evidence.rootText !== evidence.bodyText ||
        !unchangedStyle
      )
        throw new Error(`native ${locale}/${scheme} layout/theme contract failed`)
      await page.screenshot({ path: join(dir, `${locale}-${scheme}.png`), fullPage: false })
      themes.push({ locale, scheme, unchangedStyle, ...evidence })
    }
  assert(
    'I18N-THEME',
    'native zh/en × dark/light renders without document overflow; DSH theme aliases update without reinstalling canvas CSS',
    themes.length === 4,
    JSON.stringify(themes)
  )
  writeFileSync(join(dir, 'i18n-evidence.json'), JSON.stringify({ planId: PLAN_ID, keyRead: false, preservation, searches, grouping, themes }, null, 2))
  return { ...base, i18n: { preservation, searches, themes, keyRead: false } }
}

async function main() {
  const args = process.argv.slice(2)
  const index = args.indexOf('--report-dir')
  const reports = resolve(index >= 0 ? args[index + 1] : join(ROOT, 'docs/validation/blueprint/current/i18n-workspace/ui'))
  mkdirSync(reports, { recursive: true })
  const output = mkdtempSync(join(reports, 'native-i18n-'))
  const probePath = join(HERE, 'probe.mjs')
  const original = readFileSync(probePath, 'utf8')
  let adapted = original
    .replace(/from '\.\/([^']+\.mjs)'/g, (_, name) => `from '${pathToFileURL(join(HERE, name)).href}'`)
    .replace(/import\('\.\/([^']+\.mjs)'\)/g, (_, name) => `import('${pathToFileURL(join(HERE, name)).href}')`)
    .replace(/const HERE = dirname\(fileURLToPath\(import.meta.url\)\)/, `const HERE = ${JSON.stringify(HERE)}`)
    .replace(pathToFileURL(join(HERE, 'canvas-journey.mjs')).href, pathToFileURL(fileURLToPath(import.meta.url)).href)
    .replace(
      "const pw = await import('playwright')",
      `const pw = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'test/blueprint/node_modules/playwright/index.mjs')).href)})`
    )
  if (adapted === original || !adapted.includes(pathToFileURL(fileURLToPath(import.meta.url)).href))
    throw new Error('probe adapter did not preserve/route native journey')
  const adaptedPath = join(output, 'native-probe.mjs')
  writeFileSync(adaptedPath, adapted)
  writeFileSync(
    join(output, 'driver-provenance.json'),
    JSON.stringify(
      {
        planId: PLAN_ID,
        originalProbe: 'test/blueprint/capabilities/probe.mjs',
        originalProbeSha256: sha256(original),
        adapterSha256: sha256(adapted),
        driverSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
        keyRead: false
      },
      null,
      2
    )
  )
  const fingerprint = captureEvidenceFingerprint()
  const invokedAt = Date.now()
  const env = { BP_I18N_ARTIFACT_DIR: output }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT'])
    if (process.env[key] !== undefined) env[key] = process.env[key]
  const run = spawnSync(
    process.execPath,
    [adaptedPath, `--plugin-dir=${PLUGIN}`, '--expect=blueprint', '--canvas-test=browser', `--report-dir=${output}`, `--plan-id=${PLAN_ID}`],
    { cwd: join(ROOT, 'test/blueprint'), env, encoding: 'utf8', maxBuffer: 30 * 1024 * 1024 }
  )
  writeFileSync(join(output, 'driver.stdout.log'), run.stdout ?? '')
  writeFileSync(join(output, 'driver.stderr.log'), run.stderr ?? '')
  const report = JSON.parse(readFileSync(join(output, 'w0.2-probe-report.json'), 'utf8'))
  const required = [...new Set([...HOST_ASSERTIONS, ...BROWSER_ASSERTIONS, ...I18N_ASSERTIONS])]
  const missing = required.filter(id => !report.assertions?.some(a => a.id === id && a.passed))
  let nativeGate
  try {
    nativeGate = validateCanvasReport(report, {
      mode: 'browser',
      planId: PLAN_ID,
      reportDir: output,
      packageRoot: PLUGIN,
      invokedAt,
      finishedAt: Date.now()
    })
  } catch (error) {
    nativeGate = { ok: false, error: error.message }
  }
  const fingerprintAfter = captureEvidenceFingerprint()
  const passed =
    run.status === 0 && report.passed === true && missing.length === 0 && nativeGate.ok === true && isDeepStrictEqual(fingerprint, fingerprintAfter)
  writeFileSync(
    join(output, 'i18n-gate.json'),
    JSON.stringify(
      {
        planId: PLAN_ID,
        passed,
        exitCode: run.status,
        required,
        missing,
        nativeGate,
        fingerprint,
        fingerprintAfter,
        reportDir: output,
        keyRead: false
      },
      null,
      2
    )
  )
  console.log(
    JSON.stringify(
      {
        passed,
        exitCode: run.status,
        missing,
        nativeGate,
        browserError: report.artifacts?.browser_error ?? null,
        reportDir: output
      },
      null,
      2
    )
  )
  process.exitCode = passed ? 0 : 1
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
