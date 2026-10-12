// Accessible-name oracle only: render unmodified installed Controls, then ask
// real Playwright getByRole about that HTML. No label mock, DSH/profile boot,
// React hydration or click; actual mounted Fit View behavior remains Main's gate.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Controls, ReactFlowProvider } from '@xyflow/react'

const harnessRequire = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = harnessRequire('playwright')
const journey = new URL('../../../../../test/blueprint/capabilities/canvas-journey.mjs', import.meta.url)
let browser, page, home

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'bp-installed-fit-control-'))
  browser = await chromium.launch({ channel: 'msedge', headless: true,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: home } })
  const context = await browser.newContext()
  await context.route('**/*', route => route.abort())
  page = await context.newPage()
  // No ariaLabelConfig/aria-label prop override: labels come from the actual
  // installed Controls/default store, rendered by actual React DOM Server.
  const html = renderToStaticMarkup(React.createElement(ReactFlowProvider, null, React.createElement(Controls)))
  await page.setContent(html)
})
after(async () => {
  try { await browser?.close() } finally { if (home) rmSync(home, { recursive: true, force: true }) }
})

function journeyFitOracle() {
  const lines = readFileSync(journey, 'utf8').split('\n')
  const index = lines.findIndex(line => line.startsWith("  assert('B-VIEWPORT',"))
  assert.ok(index > 0, 'fixture must read the existing B-VIEWPORT assertion')
  const match = /^  await page\.getByRole\('button', \{ name: '([^']+)', exact: true \}\)\.click\(\)$/.exec(lines[index - 1])
  assert.ok(match, 'Fit View journey retains its exact role locator and ordinary .click()')
  return { name: match[1], exact: true }
}

test('C-09 actual installed Controls renders Fit View; old lowercase exact name misses, official exact name identifies the same visible control', async t => {
  const control = page.locator('button.react-flow__controls-fitview')
  assert.equal(await control.count(), 1, 'actual installed Controls must render one Fit View button')
  assert.equal(await control.getAttribute('aria-label'), 'Fit View')
  assert.equal(await control.getAttribute('title'), 'Fit View')
  assert.equal(await control.isVisible(), true)
  const rect = await control.boundingBox()
  assert.ok(rect?.width > 0 && rect.height > 0, 'installed rendered control is measurable')
  const oldCount = await page.getByRole('button', { name: 'fit view', exact: true }).count()
  const installed = page.getByRole('button', { name: 'Fit View', exact: true })
  assert.equal(oldCount, 0, 'old lowercase exact selector cannot match the installed accessible name')
  assert.equal(await installed.count(), 1)
  assert.equal(await installed.evaluate(element => element === document.querySelector('button.react-flow__controls-fitview')), true,
    'not just any button: official name resolves the actual Fit View control')
  t.diagnostic(JSON.stringify({ browser: browser.version(), labels: await page.getByRole('button').evaluateAll(elements => elements.map(el => el.getAttribute('aria-label'))), oldExactMatches: oldCount, officialExactMatches: await installed.count() }))
})

test('C-09 current journey exact Fit View oracle resolves the installed rendered control without changing ordinary click semantics', async t => {
  const oracle = journeyFitOracle()
  const locator = page.getByRole('button', oracle)
  assert.equal(await locator.count(), 1,
    `JOURNEY_FIT_VIEW_EXACT_LABEL_MISMATCH: journey name ${JSON.stringify(oracle.name)} must locate installed Controls Fit View`)
  assert.equal(await locator.evaluate(element => element === document.querySelector('button.react-flow__controls-fitview')), true,
    'journey oracle must resolve that precise installed control, not any successful match')
  assert.equal(await locator.getAttribute('aria-label'), 'Fit View')
  t.diagnostic(JSON.stringify({ journeyOracle: oracle, matches: await locator.count(), nativeClickSourcePreserved: true, performedClick: false }))
})
