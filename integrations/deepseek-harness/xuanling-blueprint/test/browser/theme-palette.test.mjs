// Source/browser CSS integration only, not native DSH acceptance. The existing
// harness Playwright/system Edge executes the actual unmodified production
// installer and stylesheet. Markup is an isolated CSS-consumer fixture; host
// aliases are explicit inputs, never mocked computed styles or DSH internals.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'

const harnessRequire = createRequire(new URL('../../../../../test/blueprint/package.json', import.meta.url))
const { chromium } = harnessRequire('playwright')
const source = readFileSync(new URL('../../src/client/shared/styles/styles.ts', import.meta.url), 'utf8')
const sourceSha256 = createHash('sha256').update(source).digest('hex')
const browserModule = stripTypeScriptTypes(source, { mode: 'transform' })
const browserFragments = Object.fromEntries(
  ['base', 'canvas', 'panel', 'composition'].map(name => {
    const fragment = readFileSync(new URL(`../../src/client/shared/styles/${name}.ts`, import.meta.url), 'utf8')
    return [name, stripTypeScriptTypes(fragment, { mode: 'transform' })]
  })
)
const styleId = 'xuanling-blueprint-canvas-css'
const aliases = {
  base: '--dsw-alias-bg-base',
  raised: '--dsw-alias-bg-layer-1',
  text: '--dsw-alias-label-primary',
  muted: '--dsw-alias-label-secondary',
  accent: '--dsw-alias-brand-primary'
}
const palettes = {
  light: { base: 'rgb(250, 251, 252)', raised: 'rgb(242, 244, 247)', text: 'rgb(25, 28, 34)', muted: 'rgb(91, 102, 116)', accent: 'rgb(49, 105, 201)' },
  dark: { base: 'rgb(18, 22, 28)', raised: 'rgb(30, 37, 46)', text: 'rgb(228, 236, 245)', muted: 'rgb(152, 167, 184)', accent: 'rgb(135, 174, 231)' },
  custom: { base: 'rgb(226, 248, 237)', raised: 'rgb(205, 238, 218)', text: 'rgb(30, 57, 43)', muted: 'rgb(66, 110, 85)', accent: 'rgb(179, 62, 132)' },
  fallback: { base: 'rgb(24, 27, 32)', raised: 'rgb(34, 38, 44)', text: 'rgb(222, 223, 225)', muted: 'rgb(147, 154, 164)', accent: 'rgb(103, 154, 188)' }
}
// These existing consumer classes exercise backgrounds, text, native controls,
// React Flow handles and SVG edges. No fixture CSS sets their tested properties.
const markup = `<!doctype html><html><head></head><body>
  <main class="bp-workspace" style="width:800px;height:600px">
    <header class="bp-toolbar"><strong>Blueprint CSS fixture</strong><span class="bp-revision">Revision</span></header>
    <section class="bp-body"><div class="bp-canvas">
      <article class="bp-node"><div class="bp-node-title">Node</div><p class="bp-help">Hint</p>
        <button class="react-flow__controls-button" type="button">Control</button>
        <div class="react-flow__handle"></div>
      </article>
      <svg width="240" height="80"><path class="react-flow__edge-path" d="M0 10 L200 10"></path>
        <g class="bp-edge-control"><path class="react-flow__edge-path" d="M0 40 L200 40"></path></g>
      </svg>
    </div></section>
  </main>
</body></html>`
let browser, home

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'bp-theme-css-edge-'))
  browser = await chromium.launch({ channel: 'msedge', headless: true, env: { PATH: process.env.PATH, HOME: home, TMPDIR: home } })
})
after(async () => {
  try {
    await browser?.close()
  } finally {
    if (home) rmSync(home, { recursive: true, force: true })
  }
})

async function setHostPalette(page, palette, scheme) {
  await page.evaluate(
    ({ palette, aliases, scheme }) => {
      const root = document.documentElement
      root.style.colorScheme = scheme
      for (const [role, alias] of Object.entries(aliases)) {
        if (palette) root.style.setProperty(alias, palette[role])
        else root.style.removeProperty(alias)
      }
    },
    { palette, aliases, scheme }
  )
}

async function observe(page) {
  // Production native controls transition background-color. Observe their
  // actual animation completion, not a just-injected stylesheet's UA-color
  // transition frame. No sleep, transition override or timeout extension.
  await page.evaluate(async () => {
    getComputedStyle(document.querySelector('.react-flow__controls-button')).getPropertyValue('background-color')
    await Promise.all(document.getAnimations().map(animation => animation.finished))
  })
  return page.evaluate(
    ({ aliases, styleId }) => {
      const css = selector => getComputedStyle(document.querySelector(selector))
      const rect = selector => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect()
        return { x, y, width, height }
      }
      const style = document.getElementById(styleId)
      return {
        host: Object.fromEntries(
          Object.entries(aliases).map(([role, alias]) => [role, getComputedStyle(document.documentElement).getPropertyValue(alias).trim()])
        ),
        scheme: getComputedStyle(document.documentElement).colorScheme,
        palette: {
          base: css('.bp-workspace').backgroundColor,
          raised: css('.bp-node').backgroundColor,
          text: css('.bp-workspace').color,
          muted: css('.bp-revision').color,
          accent: css('.react-flow__handle').backgroundColor
        },
        consumers: {
          canvas: css('.bp-canvas').backgroundColor,
          nodeText: css('.bp-node').color,
          buttonRaised: css('.react-flow__controls-button').backgroundColor,
          buttonText: css('.react-flow__controls-button').color,
          help: css('.bp-help').color,
          handleBorder: css('.react-flow__handle').borderTopColor,
          edge: css('svg > .react-flow__edge-path').stroke,
          controlEdge: css('.bp-edge-control .react-flow__edge-path').stroke
        },
        geometry: Object.fromEntries(
          ['.bp-workspace', '.bp-canvas', '.bp-node', '.react-flow__controls-button', '.react-flow__handle'].map(selector => [selector, rect(selector)])
        ),
        stylesheetCount: document.querySelectorAll(`#${styleId}`).length,
        ruleCount: style.sheet.cssRules.length,
        stylesheetText: style.textContent,
        sameStylesheet: style === globalThis.__bpCssFixture.style,
        installCalls: globalThis.__bpCssFixture.installCalls
      }
    },
    { aliases, styleId }
  )
}

async function withFixture(palette, scheme, callback) {
  const context = await browser.newContext()
  const networkRequests = []
  await context.route('**/*', route => {
    networkRequests.push(route.request().url())
    return route.abort()
  })
  try {
    const page = await context.newPage()
    await page.setContent(markup)
    await setHostPalette(page, palette, scheme)
    // Execute the production TS module with only types erased. In particular,
    // installer/CSS bytes are neither extracted, replaced nor reimplemented.
    await page.evaluate(
      async ({ source, fragments, styleId }) => {
        const fragmentUrls = Object.fromEntries(
          Object.entries(fragments).map(([name, text]) => [name, URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))])
        )
        const rewritten = Object.entries(fragmentUrls).reduce((text, [name, url]) => text.replace(`from './${name}.ts'`, `from ${JSON.stringify(url)}`), source)
        const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/javascript' }))
        try {
          const module = await import(url)
          module.installCanvasStyles()
          globalThis.__bpCssFixture = { module, style: document.getElementById(styleId), installCalls: 1 }
        } finally {
          URL.revokeObjectURL(url)
          for (const fragmentUrl of Object.values(fragmentUrls)) URL.revokeObjectURL(fragmentUrl)
        }
      },
      { source: browserModule, fragments: browserFragments, styleId }
    )
    const initial = await observe(page)
    assert.equal(initial.stylesheetCount, 1, 'production installer appends its actual stylesheet once')
    assert.ok(initial.ruleCount > 0, 'actual installed CSS must parse in Edge before palette assertions')
    assert.equal(initial.sameStylesheet, true)
    assert.ok(initial.geometry['.bp-node'].width > 0, 'CSS consumer fixture must be rendered, not absent DOM')
    assert.deepEqual(
      initial.host,
      palette ?? { base: '', raised: '', text: '', muted: '', accent: '' },
      'official host token fixture is present before the product oracle'
    )
    assert.equal(initial.scheme, scheme)
    await callback(page, initial)
    assert.deepEqual(networkRequests, [], 'isolated CSS integration makes no network requests')
  } finally {
    await context.close()
  }
}

function assertPalette(observed, expected, label) {
  assert.deepEqual(observed.palette, expected, `THEME_PALETTE_COMPUTED_MISMATCH (${label}): production CSS must follow official host aliases`)
  assert.deepEqual(
    observed.consumers,
    {
      canvas: expected.base,
      nodeText: expected.text,
      buttonRaised: expected.raised,
      buttonText: expected.text,
      help: expected.muted,
      handleBorder: expected.raised,
      edge: expected.accent,
      controlEdge: expected.muted
    },
    `real CSS consumers inherit the ${label} host palette`
  )
}

function diagnose(t, label, observed) {
  t.diagnostic(
    JSON.stringify({
      provenance: 'source/browser CSS integration; not native DSH',
      browser: browser.version(),
      sourceSha256,
      label,
      scheme: observed.scheme,
      host: observed.host,
      computed: observed.palette,
      consumers: observed.consumers,
      stylesheetCount: observed.stylesheetCount,
      ruleCount: observed.ruleCount,
      installCalls: observed.installCalls,
      sameStylesheet: observed.sameStylesheet
    })
  )
}

test('C-09 production styles installer is a no-op without a DOM', () => {
  assert.equal(typeof document, 'undefined', 'no-DOM control must genuinely lack a document')
  assert.equal(installCanvasStyles(), undefined)
  assert.equal(installCanvasStyles(), undefined)
  assert.equal(typeof document, 'undefined', 'installer must not create a DOM/global document')
})

test('C-09 actual Edge stylesheet installer is idempotent and preserves the original style element/rules', async t => {
  await withFixture(undefined, 'light', async (page, initial) => {
    await page.evaluate(() => {
      globalThis.__bpCssFixture.module.installCanvasStyles()
      globalThis.__bpCssFixture.module.installCanvasStyles()
      globalThis.__bpCssFixture.installCalls += 2
    })
    const current = await observe(page)
    assert.equal(current.stylesheetCount, 1)
    assert.equal(current.sameStylesheet, true, 'idempotency preserves element identity, not just count')
    assert.equal(current.stylesheetText, initial.stylesheetText)
    assert.equal(current.ruleCount, initial.ruleCount)
    assert.equal(current.installCalls, 3)
    assert.deepEqual(current.geometry, initial.geometry)
    diagnose(t, 'idempotent', current)
  })
})

for (const scheme of ['light', 'dark']) {
  test(`C-09 actual Edge production CSS computes all five official ${scheme} host palette roles`, async t => {
    await withFixture(palettes[scheme], scheme, async (_page, observed) => {
      diagnose(t, scheme, observed)
      assertPalette(observed, palettes[scheme], scheme)
    })
  })
}

test('C-09 live light/dark/custom host token updates change computed CSS without reinstall or geometry mutation', async t => {
  await withFixture(palettes.light, 'light', async (page, initial) => {
    // Update tokens before the first product assertion so the unchanged-source
    // red directly proves the dynamic/custom mismatch, not fixture startup.
    for (const [label, scheme] of [
      ['dark', 'dark'],
      ['custom', 'light']
    ]) {
      await setHostPalette(page, palettes[label], scheme)
      const observed = await observe(page)
      assert.deepEqual(observed.host, palettes[label])
      assert.equal(observed.scheme, scheme)
      assert.equal(observed.installCalls, 1, 'host token changes must not reinstall production styles')
      assert.equal(observed.sameStylesheet, true)
      assert.equal(observed.stylesheetCount, 1)
      assert.equal(observed.stylesheetText, initial.stylesheetText)
      assert.equal(observed.ruleCount, initial.ruleCount)
      assert.deepEqual(observed.geometry, initial.geometry, 'theme updates must not alter canvas/control geometry')
      diagnose(t, label, observed)
      assertPalette(observed, palettes[label], `updated ${label}`)
    }
    assertPalette(initial, palettes.light, 'initial light')
  })
})

test('C-09 missing host aliases retain every existing standalone fallback color', async t => {
  await withFixture(undefined, 'light', async (_page, observed) => {
    diagnose(t, 'standalone fallback', observed)
    assertPalette(observed, palettes.fallback, 'standalone fallback')
  })
})
