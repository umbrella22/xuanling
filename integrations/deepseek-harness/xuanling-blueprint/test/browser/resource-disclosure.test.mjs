// Resource entrypoint regression: the library owns one visible + button and
// delegates creation to the existing resource dialog. The old native details
// form must not return as a second creation path.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createBlueprintPanel } from '../../src/client/panel.ts'
import { en } from '../../src/client/locales.ts'

const fixtureT = (key, params = {}) => {
  assert.ok(Object.hasOwn(en, key), `existing English dictionary key: ${key}`)
  return en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

const harnessRequire = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = harnessRequire('playwright')
let browser, page, home, html

before(async () => {
  const Panel = createBlueprintPanel({ hostLink: undefined, storage: undefined })
  html = renderToStaticMarkup(React.createElement(Panel, { t: fixtureT }))
  home = mkdtempSync(join(tmpdir(), 'bp-production-resource-entrypoint-'))
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

const resources = () => page.locator('[data-bp-section="resources"]')
const addButton = () => resources().locator('[data-bp-action="add-resource"]')

async function assertSinglePlusEntrypoint() {
  assert.equal(await page.locator('.react-flow').count(), 1, 'actual production panel includes installed React Flow')
  assert.equal(await resources().count(), 1)
  assert.equal(await addButton().count(), 1, 'resource creation has one visible entrypoint')
  assert.deepEqual(
    await addButton().evaluate(element => ({
      tag: element.tagName,
      text: element.textContent,
      type: element.type,
      className: element.className,
      disabled: element.disabled,
      title: element.getAttribute('title')
    })),
    {
      tag: 'BUTTON',
      text: '+',
      type: 'button',
      className: 'bp-resource-add',
      disabled: true,
      title: 'Open resource editor'
    }
  )
  assert.equal(await resources().locator('details').count(), 0, 'old Add resource disclosure is removed')
  assert.equal(await resources().getByText('Add resource', { exact: true }).count(), 0, 'old summary and submit labels are absent')
  for (const name of ['New resource ID', 'New resource JSON']) {
    assert.equal(await page.getByRole(name === 'New resource JSON' ? 'group' : 'textbox', { name, exact: true, includeHidden: true }).count(), 0)
  }
}

test('C-09 actual production panel exposes one accessible + resource entrypoint and removes the duplicate details form', async t => {
  await assertSinglePlusEntrypoint()
  t.diagnostic(
    JSON.stringify({
      browser: browser.version(),
      resourceEntryPoint: 'button[data-bp-action="add-resource"]',
      text: '+',
      oldDetails: false,
      hydrated: false,
      hostMutation: false
    })
  )
})

test('C-09 resource entrypoint keeps the title row contract and remains disabled without an editable blueprint', async t => {
  await assertSinglePlusEntrypoint()
  const heading = resources().locator('.bp-resource-heading')
  assert.equal(await heading.locator('h2').innerText(), en['resource.title'])
  assert.equal(await heading.locator('button').count(), 1)
  assert.equal(
    await heading.locator('button').evaluate(element => element.parentElement === document.querySelector('[data-bp-section="resources"] .bp-resource-heading')),
    true
  )
  t.diagnostic(JSON.stringify({ title: en['resource.title'], plusOnly: true, editableBlueprint: false }))
})
