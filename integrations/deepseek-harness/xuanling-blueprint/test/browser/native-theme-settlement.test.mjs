// Public Playwright adapter tests only: no browser/profile, persistence or Host
// acceptance is claimed. Main owns frozen real-Host/full-repository acceptance.
import assert from 'node:assert/strict'
import test from 'node:test'
import { setNativeTheme } from '../../../../../test/blueprint/capabilities/i18n-workspace-journey.mjs'

const settingsSelector = '[data-shortcut-modal="settings"]'
const themeOracle =
  "scheme => getComputedStyle(document.documentElement).colorScheme === scheme && document.body.hasAttribute('data-ds-dark-theme') === (scheme === 'dark')"
const acceptedBody = scheme => ({ result: { ok: true, value: { ns: 'ui-theme', revision: 1, value: { preference: scheme, fontSize: 14 } } } })
const mutationArgs = scheme => ({ ns: 'ui-theme', ops: [{ op: 'set', path: ['preference'], value: scheme }], expectedRevision: 0 })
const changedSteps = [
  'account.click',
  'settings.click',
  'settings.visible',
  'theme.aria-pressed',
  'response.register',
  'theme.click',
  'response.json',
  'scheme.wait',
  'close.click',
  'settings.hidden'
]
const noOpSteps = changedSteps.filter(step => !['response.register', 'response.json'].includes(step))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function publicOnly(object) {
  return new Proxy(object, {
    get(target, key) {
      // Promise assimilation probes every object; keep this adapter non-thenable.
      if (key === 'then') return undefined
      assert.ok(Object.hasOwn(target, key), `non-public adapter operation: ${String(key)}`)
      return target[key]
    }
  })
}

function fixture({ scheme = 'dark', selected = false, autoReply = true, ignored = [], reply = {}, failAt, failure = new Error('native failure') } = {}) {
  const events = [],
    matches = []
  const registered = deferred(),
    clicked = deferred(),
    jsonRead = deferred(),
    responseWait = deferred()
  let open = false,
    visible = false,
    predicate
  const record = name => {
    events.push(name)
    if (name === failAt) throw failure
  }
  function response({
    path = '/api/settings/mutate',
    httpMethod = 'POST',
    rpc = 'settings/mutate',
    args = mutationArgs(scheme),
    envelope = { method: rpc, payload: { args } },
    status = 200,
    body = acceptedBody(scheme),
    bodyWait,
    postDataError,
    jsonError
  } = {}) {
    const request = publicOnly({
      url: () => `http://127.0.0.1:3456${path}`,
      method: () => httpMethod,
      postDataJSON() {
        if (postDataError) throw postDataError
        return envelope
      }
    })
    return publicOnly({
      request: () => request,
      url: () => request.url(),
      status: () => status,
      async json() {
        record('response.json')
        jsonRead.resolve()
        if (jsonError) throw jsonError
        return bodyWait ? bodyWait.promise : body
      }
    })
  }
  function offer(candidate) {
    assert.equal(typeof predicate, 'function', 'register the response predicate before delivering a reply')
    const match = predicate(candidate)
    matches.push(match)
    if (match) responseWait.resolve(candidate)
    return match
  }
  const themeButton = publicOnly({
    async getAttribute(name) {
      assert.equal(name, 'aria-pressed', 'use the real Appearance selection, not resolved DOM scheme')
      record('theme.aria-pressed')
      return selected ? 'true' : 'false'
    },
    async click(options) {
      assert.equal(options, undefined, 'ordinary hit-tested native click; no force/trial/timeout')
      record('theme.click')
      clicked.resolve()
      // Deliver replies during click: a listener registered afterwards loses them.
      if (predicate && autoReply) {
        for (const options of ignored) offer(response(options))
        offer(response(reply))
      }
    }
  })
  const modal = publicOnly({
    async waitFor(options) {
      assert.deepEqual(options, { state: open ? 'visible' : 'hidden' })
      record(`settings.${options.state}`)
      visible = open
    },
    getByRole(role, options) {
      assert.equal(role, 'button')
      assert.ok(open && visible, 'open and observe native Settings before its controls')
      if (options.name.source === '^(关闭|Close)$') {
        assert.deepEqual(options, { name: /^(关闭|Close)$/ })
        return publicOnly({
          async click(options) {
            assert.equal(options, undefined, 'ordinary native Close only')
            record('close.click')
            open = false
          }
        })
      }
      assert.deepEqual(options, { name: scheme === 'dark' ? /^(深色|Dark)$/ : /^(浅色|Light)$/ })
      return themeButton
    }
  })
  const page = publicOnly({
    getByRole(role, options) {
      assert.ok(['button', 'menuitem'].includes(role))
      assert.deepEqual(options, { name: role === 'button' ? /^(账号菜单|Account menu)$/ : /^(设置|Settings)$/ })
      return publicOnly({
        async click(options) {
          assert.equal(options, undefined, 'ordinary native Settings only')
          record(role === 'button' ? 'account.click' : 'settings.click')
          if (role === 'menuitem') open = true
        }
      })
    },
    locator(selector) {
      assert.equal(selector, settingsSelector, 'no plugin/storage/runtime fallback')
      return modal
    },
    waitForResponse(received, options) {
      assert.equal(options, undefined, 'no changed response timeout/budget')
      assert.equal(typeof received, 'function')
      record('response.register')
      predicate = received
      registered.resolve()
      if (failAt === 'response.wait') responseWait.reject(failure)
      return responseWait.promise
    },
    async waitForFunction(callback, argument, options) {
      assert.equal(callback.toString(), themeOracle, 'retain the exact original scheme AND body-marker condition')
      assert.equal(argument, scheme)
      assert.equal(options, undefined, 'no changed original wait timeout/budget')
      // Optimistic DOM already satisfies the oracle, even with Host unanswered.
      record('scheme.wait')
    }
  })
  return { page, scheme, events, matches, registered, clicked, jsonRead, responseWait, response, offer }
}

test('changed native selection cannot resolve on optimistic DOM before deferred matching Host reply/body', async () => {
  const f = fixture({ autoReply: false })
  const run = setNativeTheme(f.page, f.scheme)
  const beforeHost = await Promise.race([run.then(() => 'helper resolved before Host reply'), f.registered.promise.then(() => 'response wait registered')])
  assert.equal(beforeHost, 'response wait registered', 'premature theme settlement: helper resolved on optimistic DOM before deferred matching Host reply')
  await f.clicked.promise
  assert.ok(!f.events.includes('scheme.wait'), 'do not observe optimistic DOM as accepted preference')
  const bodyWait = deferred()
  assert.equal(f.offer(f.response({ bodyWait })), true)
  const beforeBody = await Promise.race([run.then(() => 'helper resolved before Host body'), f.jsonRead.promise.then(() => 'reading Host body')])
  assert.equal(beforeBody, 'reading Host body', 'matching response headers alone are not acceptance')
  assert.ok(!f.events.includes('scheme.wait'), 'await the accepted JSON body before the original DOM wait')
  bodyWait.resolve(acceptedBody(f.scheme))
  await run
  assert.deepEqual(f.events, changedSteps)
})

for (const scheme of ['dark', 'light']) {
  test(`${scheme} changed selection registers before native click, then accepts Host before original wait/Close`, async () => {
    const f = fixture({ scheme })
    await setNativeTheme(f.page, scheme)
    assert.deepEqual(f.events, changedSteps)
    assert.deepEqual(f.matches, [true])
  })
  test(`${scheme} already aria-pressed still uses native click, original wait and Close without a missing-response wait`, async () => {
    const f = fixture({ scheme, selected: true })
    await setNativeTheme(f.page, scheme)
    assert.deepEqual(f.events, noOpSteps)
    assert.deepEqual(f.matches, [])
  })
}

const unrelated = [
  ['other route', { path: '/api/blueprint/mutate' }],
  ['route suffix', { path: '/api/settings/mutate/extra' }],
  ['route prefix', { path: '/prefix/api/settings/mutate' }],
  ['non-POST HTTP', { httpMethod: 'GET' }],
  ['describe RPC', { rpc: 'settings/describe' }],
  ['other RPC on mutate route', { rpc: 'blueprint/mutate' }],
  ['other namespace', { args: { ...mutationArgs('dark'), ns: 'ui-locale' } }],
  ['other operation', { args: { ns: 'ui-theme', ops: [{ op: 'delete', path: ['preference'], value: 'dark' }] } }],
  ['other field', { args: { ns: 'ui-theme', ops: [{ op: 'set', path: ['fontSize'], value: 'dark' }] } }],
  ['nested preference path', { args: { ns: 'ui-theme', ops: [{ op: 'set', path: ['preference', 'other'], value: 'dark' }] } }],
  ['non-array path', { args: { ns: 'ui-theme', ops: [{ op: 'set', path: 'preference', value: 'dark' }] } }],
  ['old/other scheme', { args: mutationArgs('light') }],
  ['system preference', { args: mutationArgs('system') }],
  ['multiple operations', { args: { ns: 'ui-theme', ops: [...mutationArgs('dark').ops, { op: 'set', path: ['fontSize'], value: 16 }] } }],
  ['empty operations', { args: { ns: 'ui-theme', ops: [] } }],
  ['non-array operations', { args: { ns: 'ui-theme', ops: {} } }],
  ['missing payload', { envelope: { method: 'settings/mutate' } }],
  ['wrong args nesting', { envelope: { method: 'settings/mutate', payload: { args: { args: mutationArgs('dark') } } } }],
  ['non-JSON request', { postDataError: new SyntaxError('not JSON') }]
]
for (const [label, ignoredReply] of unrelated) {
  test(`response predicate ignores ${label} before matching the actual ui-theme/preference/dark write`, async () => {
    const f = fixture({ ignored: [ignoredReply] })
    await setNativeTheme(f.page, f.scheme)
    assert.deepEqual(f.matches, [false, true])
    assert.deepEqual(f.events, changedSteps, 'unrelated responses must not be read or used as acceptance')
  })
}

test('exact mutation pathname can carry a query without broadening route matching', async () => {
  const f = fixture({ reply: { path: '/api/settings/mutate?request=public-fixture' } })
  await setNativeTheme(f.page, f.scheme)
  assert.deepEqual(f.matches, [true])
  assert.deepEqual(f.events, changedSteps)
})

const invalidReplies = [
  ['HTTP 201', { status: 201 }],
  ['HTTP 500', { status: 500 }],
  ['rejected result', { body: { result: { ok: false, error: { code: 'revision-conflict' } } } }],
  ['truthy non-boolean ok', { body: { result: { ...acceptedBody('dark').result, ok: 'true' } } }],
  ['wrong returned namespace', { body: { result: { ok: true, value: { ns: 'ui-locale', value: { preference: 'dark' } } } } }],
  ['wrong returned preference', { body: acceptedBody('light') }],
  ['missing namespace view', { body: { result: { ok: true } } }],
  ['missing preference', { body: { result: { ok: true, value: { ns: 'ui-theme', value: {} } } } }],
  ['missing result', { body: {} }],
  ['null JSON', { body: null }],
  ['non-object JSON', { body: 'not a result' }]
]
for (const [label, reply] of invalidReplies) {
  test(`${label} matching Host response rejects instead of optimistic success or retry`, async () => {
    const f = fixture({ reply })
    await assert.rejects(setNativeTheme(f.page, f.scheme), /native dark theme mutation was not accepted/)
    assert.deepEqual(f.events, changedSteps.slice(0, 7), 'no DOM wait, Close, fallback or retry after invalid acceptance')
    assert.deepEqual(f.matches, [true])
  })
}

test('malformed JSON parsing failure is the original error, not an accepted/fallback response', async () => {
  const error = new SyntaxError('invalid public fixture JSON')
  const f = fixture({ reply: { jsonError: error } })
  await assert.rejects(setNativeTheme(f.page, f.scheme), received => received === error)
  assert.deepEqual(f.events, changedSteps.slice(0, 7))
})

for (const stage of [
  'account.click',
  'settings.click',
  'settings.visible',
  'theme.aria-pressed',
  'response.register',
  'response.wait',
  'theme.click',
  'response.json',
  'scheme.wait',
  'close.click',
  'settings.hidden'
]) {
  test(`${stage} error propagates unchanged with no bypass/retry`, async () => {
    const error = new Error(`public native failure: ${stage}`)
    const f = fixture({ failAt: stage, failure: error })
    await assert.rejects(setNativeTheme(f.page, f.scheme), received => received === error)
    const expected = stage === 'response.wait' ? changedSteps.slice(0, 6) : changedSteps.slice(0, changedSteps.indexOf(stage) + 1)
    assert.deepEqual(f.events, expected)
    // A click failure must not leave an unhandled later wait rejection.
    if (stage === 'theme.click') f.responseWait.reject(new Error('later response wait failure after click failure'))
  })
}

for (const stage of ['theme.click', 'scheme.wait', 'close.click', 'settings.hidden']) {
  test(`already-selected ${stage} error propagates unchanged without response registration`, async () => {
    const error = new Error(`public no-op failure: ${stage}`)
    const f = fixture({ selected: true, failAt: stage, failure: error })
    await assert.rejects(setNativeTheme(f.page, f.scheme), received => received === error)
    assert.deepEqual(f.events, noOpSteps.slice(0, noOpSteps.indexOf(stage) + 1))
  })
}
