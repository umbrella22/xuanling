// Harness adapter tests only: no DSH profile/browser, persistence or native
// acceptance is claimed. Main independently runs the unchanged real Host gates.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { setNativeSettingsLocale } from '../../../../../test/blueprint/capabilities/native-settings-journey.mjs'

const settingsSelector = '[data-shortcut-modal="settings"]'
const panelSelector = '[data-bp-canvas="root"]'
const englishSteps = [
  'account.click',
  'settings.click',
  'settings.visible',
  'language.click',
  'menuitem:English.click',
  'row:Language.visible',
  'close.click',
  'settings.hidden'
]

function fixture(initial = 'zh', { failAt, failure, entry = false } = {}) {
  const events = []
  let locale = initial,
    open = false,
    menu = false,
    accountMenu = false,
    visibleObserved = false,
    rowObserved = false,
    closedObserved = false
  let onboarded = !entry,
    sidebarActivated = false
  // No DOM evaluation, storage, RPC or private runtime escape hatch is exposed.
  const publicOnly = object =>
    new Proxy(object, {
      get(target, key) {
        if (key === 'then') return undefined // Async helpers may return a public locator.
        assert.ok(Object.hasOwn(target, key), `non-public adapter operation: ${String(key)}`)
        return target[key]
      }
    })
  const record = name => {
    events.push(name)
    if (name === failAt) throw failure
  }
  const button = (name, activate) =>
    publicOnly({
      async click(options) {
        assert.equal(options, undefined, 'ordinary hit-tested clicks only; no force/trial options')
        record(name)
        activate()
      }
    })
  const modal = publicOnly({
    async waitFor(options) {
      assert.deepEqual(options, { state: open ? 'visible' : 'hidden' })
      record(`settings.${options.state}`)
      if (open) visibleObserved = true
      else closedObserved = true
    },
    getByRole(role, options) {
      assert.equal(role, 'button')
      assert.ok(open && visibleObserved, 'wait for the native Settings modal before using its controls')
      if (options.name instanceof RegExp && options.name.source === '^(中文|English)$') {
        assert.deepEqual(options, { name: /^(中文|English)$/ })
        return button('language.click', () => {
          menu = true
        })
      }
      assert.deepEqual(options, { name: /^(关闭|Close)$/ })
      assert.ok(rowObserved, 'wait for the translated Language row before Close')
      return button('close.click', () => {
        open = false
      })
    },
    getByText(text, options) {
      assert.deepEqual(options, { exact: true })
      assert.equal(text, locale === 'en' ? 'Language' : '语言')
      assert.ok(open && !menu, 'the native menu selection must settle before the Language row')
      return publicOnly({
        async waitFor(options) {
          assert.deepEqual(options, { state: 'visible' })
          record(`row:${text}.visible`)
          rowObserved = true
        }
      })
    }
  })
  const page = publicOnly({
    getByRole(role, options) {
      if (role === 'menuitem' && options.name instanceof RegExp) {
        assert.deepEqual(options, { name: /^(设置|Settings)$/ })
        assert.ok(accountMenu, 'Settings must be chosen from the public account menu')
        return button('settings.click', () => {
          accountMenu = false
          open = true
        })
      }
      if (role === 'menuitem') {
        assert.ok(open && menu, 'open the native portalled language menu first')
        assert.ok(['English', '中文'].includes(options.name))
        assert.deepEqual(options, { name: options.name, exact: true })
        return button(`menuitem:${options.name}.click`, () => {
          locale = options.name === 'English' ? 'en' : 'zh'
          menu = false
        })
      }
      assert.equal(role, 'button')
      if (options.name === 'XuanLing Blueprint') {
        assert.deepEqual(options, { name: 'XuanLing Blueprint', exact: true })
        assert.ok(onboarded && closedObserved && !open && locale === 'en', 'English Settings bootstrap must finish before the unchanged exact sidebar click')
        return button('sidebar.click', () => {
          sidebarActivated = true
        })
      }
      assert.deepEqual(options, { name: /^(账号菜单|Account menu)$/ })
      assert.ok(onboarded, 'never bypass onboarding')
      return button('account.click', () => {
        accountMenu = true
      })
    },
    locator(selector) {
      if (selector === settingsSelector) return modal
      assert.equal(selector, panelSelector, 'the helper must not depend on any Blueprint panel action')
      assert.ok(sidebarActivated, 'the original panel wait must follow exact sidebar activation')
      return publicOnly({
        async waitFor(options) {
          assert.deepEqual(options, { state: 'visible', timeout: 15000 }, 'retain the original panel timeout')
          record('panel.visible')
        }
      })
    }
  })
  return {
    page,
    events,
    dismiss: async received => {
      assert.equal(received, page)
      record('onboarding.dismiss')
      onboarded = true
    }
  }
}

for (const initial of ['zh', 'en']) {
  test(`English bootstrap from ${initial} follows native Settings/menu/row/Close in order before any panel`, async () => {
    const f = fixture(initial)
    await setNativeSettingsLocale(f.page, 'en')
    assert.deepEqual(f.events, englishSteps)
  })
}

test('supported Chinese selection uses exact native menu/row labels, not an English fallback', async () => {
  const f = fixture('en')
  await setNativeSettingsLocale(f.page, 'zh')
  assert.deepEqual(f.events, [
    'account.click',
    'settings.click',
    'settings.visible',
    'language.click',
    'menuitem:中文.click',
    'row:语言.visible',
    'close.click',
    'settings.hidden'
  ])
})

test('unsupported acceptance locales reject before touching the page without aliasing/normalizing them', async () => {
  const f = fixture()
  for (const id of ['fr', 'en-US', 'zh-CN', 'EN', '', undefined, null]) {
    await assert.rejects(setNativeSettingsLocale(f.page, id), { message: 'unsupported acceptance locale' })
  }
  assert.deepEqual(f.events, [])
})

for (const failAt of englishSteps) {
  test(`native Settings failure at ${failAt} propagates unchanged without retries or bypass`, async () => {
    const failure = new Error(`controlled adapter failure: ${failAt}`)
    const f = fixture('zh', { failAt, failure })
    await assert.rejects(setNativeSettingsLocale(f.page, 'en'), error => error === failure)
    assert.deepEqual(f.events, englishSteps.slice(0, englishSteps.indexOf(failAt) + 1))
  })
}

test('canonical probe entry keeps onboarding → English Settings → exact sidebar → original bounded panel wait', async () => {
  const probe = readFileSync(new URL('../../../../../test/blueprint/capabilities/probe.mjs', import.meta.url), 'utf8')
  const start = probe.indexOf('    await dismissOnboardingDialogs(page)\n')
  const end = probe.indexOf("    assert('P6b'", start)
  assert.ok(start >= 0 && end > start, 'original probe entry landmarks must remain')
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  // Execute the actual trusted repository entry, not an invented wrapper or a
  // mocked translation. This is still only adapter evidence, not browser input.
  const entry = new AsyncFunction(
    'page',
    'dismissOnboardingDialogs',
    'setNativeSettingsLocale',
    'EXPECT',
    'PANEL_BUTTON_NAMES',
    'PANEL_SELECTOR',
    probe.slice(start, end)
  )
  const f = fixture('zh', { entry: true })
  await entry(f.page, f.dismiss, setNativeSettingsLocale, 'blueprint', ['XuanLing Blueprint'], panelSelector)
  assert.deepEqual(f.events, ['onboarding.dismiss', ...englishSteps, 'sidebar.click', 'panel.visible'])
})
