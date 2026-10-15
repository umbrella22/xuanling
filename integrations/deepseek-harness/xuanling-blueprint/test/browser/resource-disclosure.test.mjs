// Locator/native disclosure regression only: actual production panel SSR through
// installed React/React Flow, then ordinary Edge pointer on its actual <details>.
// No panel/label/markup mock, hydration, host mutation or DSH admission claim.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createBlueprintPanel } from '../../src/client/panel.ts'
import { en } from '../../src/client/locales.ts'

// Explicit injected-locale fixture seat, not native DSH locale acceptance.
const fixtureT = (key, params = {}) => {
  assert.ok(Object.hasOwn(en, key), `existing English dictionary key: ${key}`)
  return en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

const harnessRequire = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = harnessRequire('playwright')
const journey = new URL('../../../../../test/blueprint/capabilities/canvas-journey.mjs', import.meta.url)
const oldCommand = "  await page.getByText('Add resource', { exact: true }).click()"
const scopedCommand = '  await page.locator(\'[data-bp-section="resources"] summary\').filter({ hasText: /^Add resource$/ }).click()'
const submitCommand = "  await page.getByRole('button', { name: 'Add resource', exact: true }).click()"
let browser, page, home, html

before(async () => {
  // This is a legal initial production workspace, not a fake loaded definition.
  // Native disclosure markup exists before choosing a configured blueprint.
  const Panel = createBlueprintPanel({ hostLink: undefined, storage: undefined })
  html = renderToStaticMarkup(React.createElement(Panel, { t: fixtureT }))
  home = mkdtempSync(join(tmpdir(), 'bp-production-resource-disclosure-'))
  browser = await chromium.launch({ channel: 'msedge', headless: true, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home } })
  const context = await browser.newContext()
  await context.route('**/*', route => route.abort())
  page = await context.newPage()
})
beforeEach(async () => {
  await page.setContent(html)
})
after(async () => {
  try {
    await browser?.close()
  } finally {
    if (home) rmSync(home, { recursive: true, force: true })
  }
})

const resourceSummary = () => page.locator('[data-bp-section="resources"] summary').filter({ hasText: /^Add resource$/ })
// SSR proves disclosure and the deferred editor mount; W6 hydrates and edits JSON.
const resourceInput = name => page.getByRole(name === 'New resource JSON' ? 'group' : 'textbox', { name, exact: true, includeHidden: true })

function locatorFromCommand(command) {
  // Execute only a whitelisted, trusted repository locator expression. Reading
  // the canonical command prevents a parallel hand-written oracle hiding drift.
  assert.ok([oldCommand, scopedCommand, submitCommand].includes(command), 'canonical locator must retain its bounded exact shape and ordinary .click()')
  const expression = command.trim().slice('await '.length, -'.click()'.length)
  return new Function('page', `return ${expression}`)(page)
}
function journeyResourceOracle() {
  const source = readFileSync(journey, 'utf8')
  const idMatch =
    /await\s+page\s*\.\s*getByRole\(\s*'textbox'\s*,\s*\{\s*name:\s*'New resource ID'\s*,\s*exact:\s*true\s*\}\s*\)\s*\.\s*fill\(\s*'tools'\s*\)/.exec(source)
  assert.ok(idMatch, 'read the unique canonical resource ID input command')
  const beforeId = source.slice(0, idMatch.index)
  const oldMatch = /await\s+page\s*\.\s*getByText\(\s*'Add resource'\s*,\s*\{\s*exact:\s*true\s*\}\s*\)\s*\.\s*click\(\s*\)/.exec(beforeId)
  const scopedMatch =
    /await\s+page\s*\.\s*locator\(\s*'\[data-bp-section="resources"\] summary'\s*\)\s*\.\s*filter\(\s*\{\s*hasText:\s*\/\^Add resource\$\/\s*\}\s*\)\s*\.\s*click\(\s*\)/.exec(
      beforeId
    )
  const disclosureMatches = [oldMatch, scopedMatch].filter(Boolean)
  assert.equal(disclosureMatches.length, 1, 'first canonical disclosure must retain exact matching and ordinary .click()')
  const disclosure = oldMatch ? oldCommand : scopedCommand
  const afterId = source.slice(idMatch.index + idMatch[0].length)
  const jsonMatch =
    /await\s+page\s*\.\s*getByRole\(\s*'textbox'\s*,\s*\{\s*name:\s*'New resource JSON'\s*,\s*exact:\s*true\s*\}\s*\)\s*\.\s*fill\(\s*'\{"kind":"mcp","bindingId":"bp_probe"\}'\s*\)/.exec(
      afterId
    )
  assert.ok(jsonMatch, 'canonical JSON input follows the resource ID')
  const submitMatch = /await\s+page\s*\.\s*getByRole\(\s*'button'\s*,\s*\{\s*name:\s*'Add resource'\s*,\s*exact:\s*true\s*\}\s*\)\s*\.\s*click\(\s*\)/.exec(
    afterId.slice(jsonMatch.index + jsonMatch[0].length)
  )
  assert.ok(submitMatch, 'later real form submit command stays unchanged')
  return { disclosure, submit: submitCommand }
}

async function assertCollapsedProductionMarkup() {
  assert.equal(await page.locator('.react-flow').count(), 1, 'actual production panel includes installed React Flow')
  assert.equal(await page.locator('[data-bp-section="resources"]').count(), 1)
  const generic = page.getByText('Add resource', { exact: true })
  assert.equal(await generic.count(), 2, 'old generic exact text matches actual summary and actual submit button')
  assert.deepEqual(await generic.evaluateAll(elements => elements.map(element => element.tagName).sort()), ['BUTTON', 'SUMMARY'])
  const summary = resourceSummary()
  assert.equal(await summary.count(), 1, 'scoped exact summary is unique, without first/nth disambiguation')
  assert.equal(await summary.isVisible(), true)
  assert.deepEqual(
    await summary.evaluate(element => ({
      tag: element.tagName,
      parent: element.parentElement.tagName,
      open: element.parentElement.open,
      section: element.closest('[data-bp-section]').dataset.bpSection
    })),
    { tag: 'SUMMARY', parent: 'DETAILS', open: false, section: 'resources' }
  )
  for (const name of ['New resource ID', 'New resource JSON']) {
    const input = resourceInput(name)
    assert.equal(await input.count(), 1, `${name} exists in actual production markup before disclosure`)
    assert.equal(await input.isVisible(), false, `${name} is hidden by the collapsed native details`)
  }
  return summary
}
async function clickAndObserveDisclosure(locator, submit) {
  // Observation only: record trusted native pointer/click events on the existing
  // summary. No DOM mutation, preventDefault, dispatchEvent or visibility mask.
  await resourceSummary().evaluate(element => {
    window.__bpResourceDisclosureEvents = []
    for (const type of ['pointerdown', 'click'])
      element.addEventListener(
        type,
        event => {
          window.__bpResourceDisclosureEvents.push({ type: event.type, trusted: event.isTrusted })
        },
        { once: true }
      )
  })
  await locator.click()
  assert.equal(await resourceSummary().evaluate(element => element.parentElement.open), true, 'ordinary native pointer opens the actual production details')
  assert.deepEqual(await page.evaluate(() => window.__bpResourceDisclosureEvents), [
    { type: 'pointerdown', trusted: true },
    { type: 'click', trusted: true }
  ])
  for (const name of ['New resource ID', 'New resource JSON']) {
    assert.equal(await resourceInput(name).count(), 1)
    assert.equal(await resourceInput(name).isVisible(), true, `${name} becomes visible after native disclosure`)
  }
  const button = locatorFromCommand(submit)
  assert.equal(await button.count(), 1, 'later unchanged exact submit locator identifies one actual button')
  assert.equal(await button.isVisible(), true)
  assert.deepEqual(
    await button.evaluate(element => ({
      tag: element.tagName,
      type: element.type,
      sameForm: element.form === document.querySelector('[data-bp-section="resources"] input[name="id"]').form,
      sameDetails: element.closest('details') === document.querySelector('[data-bp-section="resources"] input[name="id"]').closest('details')
    })),
    { tag: 'BUTTON', type: 'submit', sameForm: true, sameDetails: true }
  )
}

test('C-09 actual production panel duplicate text has a unique resource summary; native disclosure exposes the real ID/JSON inputs and submit button', async t => {
  const summary = await assertCollapsedProductionMarkup()
  await clickAndObserveDisclosure(summary, submitCommand)
  t.diagnostic(
    JSON.stringify({
      browser: browser.version(),
      oldExactMatches: 2,
      scopedExactMatches: 1,
      nativeDetailsOpened: true,
      trustedPointer: true,
      productionMarkup: true,
      hydrated: false,
      hostMutation: false
    })
  )
})

test('C-09 canonical first resource disclosure resolves the actual production summary and opens it without changing later submit semantics', async t => {
  await assertCollapsedProductionMarkup()
  const oracle = journeyResourceOracle()
  const locator = locatorFromCommand(oracle.disclosure)
  assert.equal(
    await locator.count(),
    1,
    'JOURNEY_RESOURCE_DISCLOSURE_AMBIGUOUS: canonical first disclosure must uniquely identify the actual resources summary, not summary plus submit'
  )
  assert.equal(
    await locator.evaluate(element => element === document.querySelector('[data-bp-section="resources"] summary')),
    true,
    'canonical first locator identifies the actual disclosure summary, not merely any single match'
  )
  await clickAndObserveDisclosure(locator, oracle.submit)
  t.diagnostic(
    JSON.stringify({
      canonicalDisclosure: oracle.disclosure.trim(),
      canonicalSubmit: oracle.submit.trim(),
      nativeDetailsOpened: true,
      nativeClickSourcePreserved: true,
      fullDshWorkflow: false
    })
  )
})
