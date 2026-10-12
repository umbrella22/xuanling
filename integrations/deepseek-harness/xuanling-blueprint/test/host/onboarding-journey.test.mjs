// Source helper / Playwright public-locator contract only: no DSH boot, profile,
// browser, credentials or native remote. Green is NOT actual host acceptance.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dismissOnboardingDialogs } from '../../../../../test/blueprint/capabilities/onboarding-journey.mjs'

const copy = {
  en: { preview: 'Preview Notice', next: 'Continue', keyless: 'Add an API key to get started', later: 'Configure later', save: 'Save and continue' },
  zh: { preview: '预览版说明', next: '继续', keyless: '添加一个 API Key 开始使用', later: '稍后配置', save: '保存并继续' },
}

function deferred() {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

function modal(title, actions, visible = true) {
  const dialog = { role: 'dialog', name: title, visible, buttons: [] }
  dialog.buttons = actions.map(name => ({ role: 'button', name, visible, dialog }))
  return dialog
}

// Locators re-query current DOM on every operation, as Playwright does. A click
// resolves after pointer input, NOT after the application's asynchronous work.
// waitFor uses explicit DOM barriers; no sleep, timer or event-turn oracle.
function fixture(locale = 'en', start = 'preview', options = {}) {
  const text = copy[locale]
  const preview = modal(text.preview, [text.next])
  const keyless = modal(text.keyless, [text.later, text.save])
  let dialogs = options.dialogs ?? (start === 'preview' ? [preview] : start === 'keyless' ? [keyless] : [])
  const bodyButtons = (options.bodyButtons ?? []).map(name => ({ role: 'button', name, visible: true }))
  const clicks = [], waits = [], attemptedClicks = [], observers = []
  const matches = (element, role, opts) => element.visible && element.role === role
    && (opts.name === undefined || (opts.exact ? element.name === opts.name : element.name.includes(opts.name)))
  const visible = elements => elements.filter(element => element.visible)
  const single = (elements, method) => {
    if (elements.length !== 1) throw new Error(`locator.${method}: expected one matching element, found ${elements.length}`)
    return elements[0]
  }
  const satisfied = wait => wait.state === 'hidden' ? visible(wait.query()).length === 0 : visible(wait.query()).length > 0
  const notify = () => {
    for (const wait of waits) {
      if (!wait.settled && satisfied(wait)) { wait.settled = true; wait.resolve() }
    }
    for (const observer of observers) {
      const wait = waits.find(observer.predicate)
      if (wait) observer.resolve(wait)
    }
  }
  function locator(query, description) {
    return {
      async count() {
        if (options.countError) throw options.countError
        return query().length
      },
      first: () => locator(() => query().slice(0, 1), description),
      async isVisible() { return visible(query()).length > 0 },
      async getAttribute(name) {
        assert.equal(name, 'aria-label', 'fixture follows actual DSH Modal accessible title')
        return single(query(), 'getAttribute').name
      },
      getByRole(role, opts) {
        return locator(() => query().flatMap(dialog => dialog.buttons ?? []).filter(element => matches(element, role, opts)), { role, ...opts, parent: description })
      },
      async click(opts) {
        attemptedClicks.push(description)
        assert.deepEqual(opts, { timeout: 3000 }, 'ordinary hit-tested click retains the old 3000 ms bound; no force')
        const button = single(visible(query()), 'click')
        if (options.clickError) throw options.clickError
        assert.equal(button.role, 'button')
        clicks.push({ dialog: button.dialog?.name ?? null, name: button.name, options: opts })
        if (options.onClick) options.onClick(button, api)
        else if (button.name === text.next) api.setDialogs([keyless])
        else if (button.name === text.later) api.setDialogs([])
        notify()
      },
      async waitFor(opts) {
        assert.deepEqual(Object.keys(opts).sort(), ['state', 'timeout'])
        assert.equal(opts.timeout, 3000, 'DOM observation uses the existing bound, not an expanded timeout')
        assert.ok(['visible', 'hidden'].includes(opts.state))
        const gate = deferred()
        const wait = { ...description, ...opts, query, settled: false, ...gate }
        waits.push(wait)
        notify()
        return gate.promise
      },
    }
  }
  const page = {
    locator(selector) {
      assert.equal(selector, '[role="dialog"]:visible', 'only real visible dialog DOM is authoritative')
      return locator(() => visible(dialogs), { selector })
    },
    getByRole(role, opts) {
      return locator(() => [...dialogs, ...dialogs.flatMap(dialog => dialog.buttons), ...bodyButtons].filter(element => matches(element, role, opts)), { role, ...opts })
    },
    evaluate() { throw new Error('fixture: DOM evaluation is forbidden') },
    waitForTimeout() { throw new Error('fixture: sleep is forbidden') },
  }
  const api = {
    page, text, preview, keyless, clicks, waits, attemptedClicks,
    setDialogs(value) { dialogs = value; notify() },
    visibleTitles: () => visible(dialogs).map(dialog => dialog.name),
    whenWait(predicate) {
      const gate = deferred()
      observers.push({ predicate, ...gate })
      notify()
      return gate.promise
    },
  }
  return api
}

for (const locale of ['en', 'zh']) {
  test(`TARGET: ${locale} sequential Preview → keyless API dismissal settles both dialogs`, async () => {
    const f = fixture(locale)
    await dismissOnboardingDialogs(f.page)
    assert.deepEqual(f.visibleTitles(), [], 'TARGET: keyless API onboarding must be dismissed, not left blocking pointer input')
    assert.deepEqual(f.clicks.map(click => [click.dialog, click.name]), [[f.text.preview, f.text.next], [f.text.keyless, f.text.later]])
  })
  test(`TARGET: ${locale} already-visible keyless API dialog uses Configure later`, async () => {
    const f = fixture(locale, 'keyless')
    await dismissOnboardingDialogs(f.page)
    assert.deepEqual(f.visibleTitles(), [], 'TARGET: Configure later / 稍后配置 must settle the already-visible keyless API dialog')
    assert.deepEqual(f.clicks.map(click => [click.dialog, click.name]), [[f.text.keyless, f.text.later]])
  })
}

test('CONTROL: no visible onboarding is a no-op without browser acceptance claims', async () => {
  const f = fixture('en', 'none')
  await dismissOnboardingDialogs(f.page)
  assert.deepEqual(f.clicks, [])
  assert.deepEqual(f.visibleTitles(), [])
})

test('CONTROL: real pointer hit-testing error propagates without force or fallback', async () => {
  const failure = new Error('locator.click: intercepted by another element')
  const f = fixture('en', 'preview', { clickError: failure })
  await assert.rejects(dismissOnboardingDialogs(f.page), error => error === failure)
  assert.deepEqual(f.clicks, [])
  assert.deepEqual(f.visibleTitles(), [f.text.preview])
})

test('CONTROL: only the recognized dialog action is clicked, never an unrelated body Continue', async () => {
  const f = fixture('en', 'preview', { bodyButtons: ['Continue', 'Configure later', 'Got it'] })
  await dismissOnboardingDialogs(f.page)
  assert.deepEqual(f.clicks.map(click => [click.dialog, click.name]), [[f.text.preview, f.text.next], [f.text.keyless, f.text.later]])
  assert.deepEqual(f.visibleTitles(), [])
})

test('CONTROL: body dismissal labels without a dialog are not onboarding', async () => {
  const f = fixture('zh', 'none', { bodyButtons: ['Continue', '继续', 'Configure later', '稍后配置', 'Got it', '知道了'] })
  await dismissOnboardingDialogs(f.page)
  assert.deepEqual(f.attemptedClicks, [])
})

test('CONTROL: unknown visible dialog with Continue remains a blocking failure', async () => {
  const unknown = modal('Unrelated confirmation', ['Continue', 'Configure later'])
  const f = fixture('en', 'none', { dialogs: [unknown] })
  await assert.rejects(dismissOnboardingDialogs(f.page), /unrecognized visible dialog/)
  assert.deepEqual(f.visibleTitles(), ['Unrelated confirmation'])
  assert.deepEqual(f.attemptedClicks, [])
})

test('CONTROL: hidden onboarding is ignored while a visible API-key dialog is processed', async () => {
  const hidden = modal(copy.zh.preview, [copy.zh.next], false)
  const shown = modal(copy.zh.keyless, [copy.zh.later, copy.zh.save])
  const f = fixture('zh', 'none', { dialogs: [hidden, shown] })
  await dismissOnboardingDialogs(f.page)
  assert.deepEqual(f.clicks.map(click => [click.dialog, click.name]), [[copy.zh.keyless, copy.zh.later]])
  assert.deepEqual(f.visibleTitles(), [])
})

test('CONTROL: multiple visible dialogs are not resolved by arbitrary first-button clicks', async () => {
  const f = fixture('en', 'none', { dialogs: [modal(copy.en.preview, [copy.en.next]), modal('Unrelated blocking dialog', ['Continue'])] })
  await assert.rejects(dismissOnboardingDialogs(f.page), /multiple visible dialogs/)
  assert.deepEqual(f.attemptedClicks, [])
  assert.deepEqual(f.visibleTitles(), [copy.en.preview, 'Unrelated blocking dialog'])
})

test('CONTROL: locator/browser failure is propagated rather than interpreted as no modal', async () => {
  const failure = new Error('browser context closed while querying dialogs')
  const f = fixture('en', 'preview', { countError: failure })
  await assert.rejects(dismissOnboardingDialogs(f.page), error => error === failure)
  assert.deepEqual(f.attemptedClicks, [])
})

test('CONTROL: missing Configure later cannot fall back to Save and continue or another body action', async () => {
  const onlySave = modal(copy.en.keyless, [copy.en.save])
  const f = fixture('en', 'none', { dialogs: [onlySave], bodyButtons: ['Configure later'] })
  await assert.rejects(dismissOnboardingDialogs(f.page), /locator\.click: expected one matching element, found 0/)
  assert.deepEqual(f.clicks, [])
  assert.equal(f.attemptedClicks.length, 1)
  assert.equal(f.attemptedClicks[0].name, copy.en.later)
  assert.equal(f.attemptedClicks[0].parent.name, copy.en.keyless)
  assert.deepEqual(f.visibleTitles(), [copy.en.keyless])
})

test('CONTROL: unknown next dialog after Preview remains a failure, not a Continue fallback', async () => {
  const f = fixture('en', 'preview', { onClick: (_button, api) => api.setDialogs([modal('Unexpected next step', ['Continue'])]) })
  await assert.rejects(dismissOnboardingDialogs(f.page), /unrecognized visible dialog/)
  assert.deepEqual(f.clicks.map(click => click.name), [copy.en.next])
  assert.deepEqual(f.visibleTitles(), ['Unexpected next step'])
})

test('CONTROL: dialog remaining after Configure later is not silently accepted or clicked', async () => {
  const f = fixture('zh', 'keyless', { onClick: (_button, api) => api.setDialogs([modal('Another blocking dialog', ['Continue'])]) })
  await assert.rejects(dismissOnboardingDialogs(f.page), /visible dialog remains after keyless onboarding/)
  assert.deepEqual(f.clicks.map(click => click.name), [copy.zh.later])
  assert.deepEqual(f.visibleTitles(), ['Another blocking dialog'])
})

test('CONTROL: a repeated Preview step is rejected without a second acknowledgement', async () => {
  const f = fixture('en', 'preview', { onClick: (_button, api) => api.setDialogs([modal(copy.zh.preview, [copy.zh.next])]) })
  await assert.rejects(dismissOnboardingDialogs(f.page), /already-dismissed step/)
  assert.deepEqual(f.clicks.map(click => click.name), [copy.en.next])
  assert.deepEqual(f.visibleTitles(), [copy.zh.preview])
})

for (const locale of ['en', 'zh']) {
  test(`TARGET: ${locale} asynchronous settlement and the no-dialog gap wait on DOM barriers`, async () => {
    // Pointer clicks finish immediately, while actual acknowledgement, models
    // loading and keyless skip each remain separately controlled by the test.
    const f = fixture(locale, 'preview', { onClick: () => {} })
    const journey = dismissOnboardingDialogs(f.page)
    const nextPendingWait = () => Promise.race([
      journey.then(() => ({ finished: true })),
      f.whenWait(wait => !wait.settled),
    ])
    const previewWait = await nextPendingWait()
    assert.equal(previewWait.finished, undefined, 'TARGET: Continue click must not finish before acknowledgement hides the Preview')
    assert.equal(previewWait.role, 'dialog')
    assert.equal(previewWait.name, f.text.preview)
    assert.equal(previewWait.state, 'hidden')
    assert.deepEqual(f.clicks.map(click => click.name), [f.text.next])
    assert.deepEqual(f.visibleTitles(), [f.text.preview])

    f.setDialogs([])
    const modelsWait = await nextPendingWait()
    assert.equal(modelsWait.finished, undefined, 'TARGET: a transient no-dialog gap must not finish the keyless onboarding journey')
    assert.equal(modelsWait.selector, '[role="dialog"]:visible')
    assert.equal(modelsWait.state, 'visible')
    assert.deepEqual(f.visibleTitles(), [])
    assert.deepEqual(f.clicks.map(click => click.name), [f.text.next])

    f.setDialogs([f.keyless])
    const keylessWait = await nextPendingWait()
    assert.equal(keylessWait.finished, undefined, 'TARGET: Configure later click must wait for actual keyless modal settlement')
    assert.equal(keylessWait.role, 'dialog')
    assert.equal(keylessWait.name, f.text.keyless)
    assert.equal(keylessWait.state, 'hidden')
    assert.deepEqual(f.clicks.map(click => click.name), [f.text.next, f.text.later])
    assert.deepEqual(f.visibleTitles(), [f.text.keyless])

    f.setDialogs([])
    await journey
    assert.deepEqual(f.visibleTitles(), [])
    assert.deepEqual(f.waits.map(wait => [wait.state, wait.timeout]), [['hidden', 3000], ['visible', 3000], ['hidden', 3000]])
  })
}
