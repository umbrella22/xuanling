// Canonical journey + unchanged onboarding helper / public-locator contracts.
// This fixture models observable reload/modal/actionability, not DSH rendering,
// trusted browser input, real transport or acceptance. Main owns those gates.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { runInNewContext } from 'node:vm'
import { dismissOnboardingDialogs } from '../../../../../test/blueprint/capabilities/onboarding-journey.mjs'
import { preparePublicAction, preparePublicDisclosure, closePublicMore } from '../../../../../test/blueprint/capabilities/compact-ui-entry.mjs'

const journeyUrl = new URL('../../../../../test/blueprint/capabilities/canvas-journey.mjs', import.meta.url)
// Optional trusted before snapshot permits old-path replay without reverting the
// shared checkout. Default always reads the actual current canonical journey.
const source = readFileSync(process.env.BP_CANVAS_RELOAD_SOURCE ?? journeyUrl, 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const copy = {
  en: { preview: 'Preview Notice', next: 'Continue', keyless: 'Add an API key to get started', later: 'Configure later', save: 'Save and continue' },
  zh: { preview: '预览版说明', next: '继续', keyless: '添加一个 API Key 开始使用', later: '稍后配置', save: '保存并继续' },
}
const paths = ['saved-document reopen', 'recent-run refresh']
const savedDefinition = { graph: { nodes: ['in', 'out', 'spare', 'input-added', 'output-added'].map(id => ({ id })) } }
const draftPosition = 'translate(107px, 99px)'
const succeeded = { runId: 'run-beta', state: 'succeeded', seq: 7, logTail: [{ seq: 7, type: 'run.succeeded' }], attempts: [], revision: 'terminal-revision' }

function segment(start, end, from = 0) {
  const a = source.indexOf(start, from)
  const b = source.indexOf(end, a + start.length)
  assert.ok(a >= from && b > a, `canonical fixture landmarks must exist: ${start} -> ${end}`)
  return source.slice(a, b)
}
// Execute trusted repository declarations and each complete existing navigation
// block, including its original draft/binding assertion and follow-up operations.
// This is not an invented wrapper calling only the newly inserted barrier.
const definitions = segment('function value(response, label) {', 'async function dragNode(')
  + segment('async function waitRun(', 'async function unboundCanvas(')
  + segment('const readOnlyRequests =', 'async function runBindingJourney(')
function canonical(path) {
  const body = path === paths[0]
    ? segment("  await page.reload({ waitUntil: 'networkidle' })", '  // Genuine second writer',
      source.indexOf('  // Reopen a local unsaved layout:'))
    : segment('  const refreshing = observeBlueprintRequests(page)', '  // Hold a real host response')
  return new AsyncFunction('page', 'assert', 'api', 'isDeepStrictEqual', 'dismissOnboardingDialogs',
    'savedDefinition', 'draftPosition', 'succeeded', 'preparePublicAction', 'preparePublicDisclosure', 'closePublicMore', `${definitions}\n${body}`)
}
const calls = new Map(paths.map(path => [path, canonical(path)]))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function modal(name, actions) {
  const result = { role: 'dialog', name, visible: true }
  result.buttons = actions.map(name => ({ role: 'button', name, visible: true, dialog: result }))
  return result
}
function fixture(locale = 'en', options = {}) {
  const text = copy[locale]
  const keyless = () => modal(text.keyless, [text.later, text.save])
  let dialogs = [], panelVisible = true, selected = 'canvas-alpha'
  const events = [], waits = [], observers = [], requests = [], assertions = []
  const listeners = new Set()
  const visible = values => values.filter(value => value.visible)
  const single = (values, method) => {
    assert.equal(values.length, 1, `locator.${method}: expected one matching element, found ${values.length}`)
    return values[0]
  }
  const notify = () => {
    for (const wait of waits) {
      if (wait.settled) continue
      const done = wait.state === 'hidden' ? visible(wait.query()).length === 0 : visible(wait.query()).length > 0
      if (done) { wait.settled = true; wait.resolve() }
    }
    for (const observer of observers) {
      const wait = waits.find(observer.predicate)
      if (wait) observer.resolve(wait)
    }
  }
  function query(selector) {
    if (selector === '[role="dialog"]:visible') return visible(dialogs)
    // Old expanded layout: public actions are visible; no More or run details.
    if (['[data-bp-action="more-actions"]', '[data-bp-overlay="more-menu"]', 'details[data-bp-disclosure="run"]'].includes(selector)) return []
    if (selector === '[data-bp-canvas="root"]') return [{ visible: panelVisible }]
    if (selector === '[data-bp-node]') return Array.from({ length: selected === 'canvas-alpha' ? savedDefinition.graph.nodes.length : 2 }, () => ({ visible: panelVisible }))
    if (/^\[data-bp-action="(?:refresh-library|save-layout|undo)"\]$/.test(selector)) return [{ visible: panelVisible, disabled: selector.includes('undo') }]
    if (selector === '[data-bp-run="succeeded"]') return selected === 'canvas-beta' ? [{ visible: panelVisible }] : []
    if (selector === '[data-bp-run]') return [{ visible: panelVisible, textContent: `${succeeded.runId} · succeeded` }]
    if (selector === '.react-flow__node[data-id="in"]') return [{ visible: panelVisible, style: { transform: selected === 'canvas-alpha' ? draftPosition : 'translate(80px, 80px)' } }]
    throw new Error(`fixture does not support unexpected canonical locator ${selector}`)
  }
  function locator(get, description) {
    return {
      count: async () => get().length,
      first: () => locator(() => get().slice(0, 1), description),
      isVisible: async () => visible(get()).length > 0,
      isDisabled: async () => single(get(), 'isDisabled').disabled,
      textContent: async () => single(get(), 'textContent').textContent,
      getAttribute: async name => {
        assert.equal(name, 'aria-label', 'actual DSH Modal title contract')
        return single(get(), 'getAttribute').name
      },
      getByRole: (role, opts) => locator(() => get().flatMap(value => value.buttons ?? [])
        .filter(value => value.role === role && value.name === opts.name), { role, ...opts, parent: description }),
      evaluate: async fn => fn(single(get(), 'evaluate')),
      async selectOption(id) {
        assert.equal(description.role, 'combobox')
        assert.ok(panelVisible && dialogs.length === 0, 'canonical choose requires a navigable unmasked panel')
        assert.ok(['canvas-alpha', 'canvas-beta'].includes(id))
        selected = id
        events.push({ type: 'choose', id })
      },
      async click(opts) {
        const element = single(visible(get()), 'click')
        if (element.dialog) {
          assert.deepEqual(opts, { timeout: 3000 }, 'ordinary onboarding click uses existing bound; no force')
          if (options.dismissError) throw options.dismissError
          events.push({ type: 'dismiss', name: element.name, title: element.dialog.name, options: opts })
          if (element.name === text.next) setDialogs([keyless()])
          else { assert.equal(element.name, text.later, 'never enter credentials or use Save and continue'); setDialogs([]) }
          return
        }
        assert.equal(element.name, 'XuanLing Blueprint')
        assert.equal(opts, undefined, 'canonical sidebar ordinary .click() is unchanged')
        events.push({ type: 'sidebar-attempt', blocked: dialogs.length > 0 })
        if (dialogs.length > 0) {
          const error = new Error('Timeout 3000ms: XuanLing Blueprint sidebar click intercepted by recognized DSH modal mask')
          error.name = 'TimeoutError'
          throw error
        }
        if (options.sidebarError) throw options.sidebarError
        panelVisible = true
        events.push({ type: 'sidebar' })
      },
      async waitFor(opts) {
        if (description.selector === '[role="dialog"]:visible' || description.role === 'dialog') {
          assert.deepEqual(Object.keys(opts).sort(), ['state', 'timeout'])
          assert.equal(opts.timeout, 3000, 'modal readiness/settlement must retain original action bound')
        } else assert.deepEqual(opts, { state: 'visible' }, 'old non-onboarding waits unchanged')
        const gate = deferred()
        const wait = { ...description, ...opts, ...gate, query: get, settled: false }
        waits.push(wait)
        events.push({ type: 'wait', ...description, ...opts })
        notify()
        return gate.promise
      },
    }
  }
  function setDialogs(values) { dialogs = values; notify() }
  const page = {
    locator: selector => locator(() => query(selector), { selector }),
    getByRole(role, opts) {
      assert.equal(opts.exact, role === 'dialog' || role === 'button' ? true : undefined)
      if (role === 'dialog') return locator(() => dialogs.filter(value => value.name === opts.name), { role, ...opts })
      if (role === 'combobox') {
        assert.equal(opts.name, 'Configured blueprint')
        return locator(() => [{ role, visible: panelVisible }], { role, ...opts })
      }
      assert.equal(role, 'button')
      assert.equal(opts.name, 'XuanLing Blueprint')
      return locator(() => [{ role, name: opts.name, visible: true }], { role, ...opts })
    },
    async reload(opts) {
      assert.deepEqual(opts, { waitUntil: 'networkidle' }, 'actual canonical reload/networkidle is preserved')
      events.push({ type: 'reload', options: opts })
      panelVisible = false
      selected = 'canvas-alpha'
      setDialogs(options.delayed ? [] : options.dialogs ?? [options.preview ? modal(text.preview, [text.next]) : keyless()])
    },
    async waitForFunction(fn, arg, opts) {
      assert.equal(opts, undefined, 'old waits gain no timeout expansion')
      const document = { querySelectorAll: query, querySelector: selector => query(selector)[0] }
      assert.equal(runInNewContext(`(${fn.toString()})(arg)`, { document, arg }), true, 'matching loaded graph/control preconditions')
    },
    async evaluate(fn) {
      const localStorage = { getItem: key => {
        assert.equal(key, 'xuanling-blueprint:draft:canvas-beta')
        return null
      } }
      return runInNewContext(`(${fn.toString()})()`, { localStorage })
    },
    on(event, handler) { assert.equal(event, 'request'); listeners.add(handler) },
    off(event, handler) { assert.equal(event, 'request'); listeners.delete(handler) },
    waitForTimeout() { throw new Error('fixture: sleep forbidden') },
  }
  async function api(method, args) {
    assert.ok(['loadDefinition', 'inspectRun'].includes(method), 'navigation must not replay save/start/cancel/decision')
    requests.push({ method, ...args })
    const request = { url: () => `http://fixture.invalid/api/blueprint/${method}`, method: () => 'POST', postDataJSON: () => ({ method: `blueprint/${method}`, payload: { args } }) }
    for (const listener of listeners) listener(request)
    if (method === 'inspectRun') {
      assert.deepEqual(args, { runId: succeeded.runId })
      return { status: 200, body: { result: { ok: true, value: structuredClone(succeeded) } } }
    }
    assert.deepEqual(args, { blueprintId: 'canvas-beta' })
    return { status: 200, body: { result: { ok: true, value: { definitionJson: JSON.stringify({ presentation: { nodes: { in: { x: 80 } } } }) } } } }
  }
  const recordAssert = (id, title, ok, detail) => { assert.equal(ok, true, `${id}: ${title}: ${detail}`); assertions.push(id) }
  return { page, text, events, waits, requests, assertions, api, setDialogs, keyless,
    run: path => calls.get(path)(page, recordAssert, api, isDeepStrictEqual, dismissOnboardingDialogs, savedDefinition, draftPosition, succeeded, preparePublicAction, preparePublicDisclosure, closePublicMore),
    pendingWait(predicate) {
      const gate = deferred()
      observers.push({ ...gate, predicate })
      notify()
      return gate.promise
    },
    state: () => ({ panelVisible, selected, visibleTitles: dialogs.map(value => value.name), listenerCount: listeners.size }),
  }
}
function completed(f, path) {
  assert.deepEqual(f.assertions, [path === paths[0] ? 'B-DRAFT' : 'B-BINDING-REFRESH'], 'original canonical assertions execute, unmodified')
  assert.equal(f.events.filter(event => event.type === 'reload').length, 1)
  assert.deepEqual(f.events.filter(event => event.type === 'choose').map(event => event.id), path === paths[0] ? ['canvas-alpha', 'canvas-beta', 'canvas-alpha'] : ['canvas-beta'])
  assert.deepEqual(f.state(), { panelVisible: true, selected: path === paths[0] ? 'canvas-alpha' : 'canvas-beta', visibleTitles: [], listenerCount: 0 })
  const dismiss = f.events.findLastIndex(event => event.type === 'dismiss')
  const sidebar = f.events.findIndex(event => event.type === 'sidebar')
  assert.ok(dismiss >= 0 && sidebar > dismiss, 'ordinary known dismissal precedes unchanged sidebar activation')
  assert.deepEqual(f.requests.map(request => request.method), [path === paths[0] ? 'loadDefinition' : 'inspectRun'])
}

test('CONTROL: matching reload/state/control fixture allows the unchanged helper and canonical sidebar action when the recognized modal is dismissed', async () => {
  const f = fixture()
  assert.deepEqual(f.state(), { panelVisible: true, selected: 'canvas-alpha', visibleTitles: [], listenerCount: 0 })
  await f.page.reload({ waitUntil: 'networkidle' })
  assert.deepEqual(f.state().visibleTitles, [f.text.keyless])
  assert.equal(await f.page.locator('[data-bp-canvas="root"]').isVisible(), false)
  assert.equal(await f.page.getByRole('button', { name: 'XuanLing Blueprint', exact: true }).isVisible(), true)
  await dismissOnboardingDialogs(f.page)
  const reopen = new AsyncFunction('page', `${segment('async function reopenPanel(', 'async function unboundCanvas(')}; return reopenPanel(page)`)
  await reopen(f.page)
  assert.equal(f.state().panelVisible, true)
  assert.deepEqual(f.events.filter(event => ['dismiss', 'sidebar'].includes(event.type)).map(event => event.type), ['dismiss', 'sidebar'])
})

for (const path of paths) {
  for (const locale of ['en', 'zh']) {
    test(`canonical ${path}: recognized ${locale} reload modal must be dismissed before the ordinary sidebar action`, async t => {
      const f = fixture(locale)
      await f.run(path)
      completed(f, path)
      t.diagnostic(JSON.stringify({ path, locale, originalAssertion: f.assertions[0], events: f.events, evidenceBoundary: 'local locator contracts, not actual DSH/browser' }))
    })
    test(`canonical ${path}: delayed first ${locale} modal gap cannot be mistaken for reload completion`, async () => {
      const f = fixture(locale, { delayed: true })
      const pending = f.pendingWait(wait => wait.selector === '[role="dialog"]:visible' && wait.state === 'visible')
      let settled = false
      const run = f.run(path).finally(() => { settled = true })
      const wait = await pending
      assert.equal(wait.timeout, 3000)
      assert.equal(wait.settled, false)
      assert.equal(settled, false)
      assert.deepEqual(f.state().visibleTitles, [])
      assert.equal(f.events.some(event => event.type === 'sidebar-attempt'), false, 'no premature sidebar in the empty-DOM interval')
      f.setDialogs([f.keyless()])
      await run
      completed(f, path)
    })
  }
  for (const [kind, expected] of [['unrelated', /unrecognized visible dialog/], ['multiple', /multiple visible dialogs/]]) {
    test(`CONTROL canonical ${path}: ${kind} visible dialogs remain blocking failures with zero dismissal/sidebar/navigation mutation`, async () => {
      const dialogs = kind === 'unrelated' ? [modal('Unrelated confirmation', ['Continue', 'Configure later'])]
        : [modal(copy.en.keyless, [copy.en.later]), modal('Unrelated confirmation', ['Continue'])]
      const f = fixture('en', { dialogs })
      await assert.rejects(f.run(path), expected)
      assert.deepEqual(f.state().visibleTitles, dialogs.map(value => value.name))
      assert.equal(f.events.some(event => ['dismiss', 'sidebar-attempt', 'choose'].includes(event.type)), false)
      assert.deepEqual(f.requests, [])
      assert.deepEqual(f.assertions, [])
      assert.equal(f.state().listenerCount, 0, 'original refresh finally still disposes its request observer on failure')
    })
  }
  test(`CONTROL canonical ${path}: absent first modal propagates the existing 3000ms locator bound failure rather than treating empty DOM as ready`, async () => {
    const f = fixture('en', { delayed: true })
    const pending = f.pendingWait(wait => wait.selector === '[role="dialog"]:visible' && wait.state === 'visible')
    const run = f.run(path)
    const failure = new Error('Timeout 3000ms: expected keyless reload modal was not rendered')
    const rejection = assert.rejects(run, error => error === failure)
    const wait = await pending
    assert.equal(wait.timeout, 3000)
    wait.reject(failure) // Explicit locator-failure control; no sleep or fake elapsed-time measurement.
    await rejection
    assert.equal(f.events.some(event => ['sidebar-attempt', 'choose'].includes(event.type)), false)
    assert.deepEqual(f.requests, [])
    assert.equal(f.state().listenerCount, 0)
  })
  test(`CONTROL canonical ${path}: ordinary modal pointer failure propagates unchanged without navigation or credential fallback`, async () => {
    const failure = new Error('native Configure later pointer was intercepted')
    const f = fixture('zh', { dismissError: failure })
    await assert.rejects(f.run(path), error => error === failure)
    assert.deepEqual(f.state().visibleTitles, [copy.zh.keyless])
    assert.equal(f.events.some(event => ['dismiss', 'sidebar-attempt', 'choose'].includes(event.type)), false)
    assert.deepEqual(f.requests, [])
    assert.equal(f.state().listenerCount, 0)
  })
  test(`CONTROL canonical ${path}: ordinary sidebar pointer failure still propagates after known modal dismissal`, async () => {
    const failure = new Error('native sidebar pointer failed after onboarding')
    const f = fixture('en', { sidebarError: failure })
    await assert.rejects(f.run(path), error => error === failure)
    assert.equal(f.events.filter(event => event.type === 'dismiss').length, 1)
    assert.equal(f.events.filter(event => event.type === 'sidebar-attempt').length, 1)
    assert.equal(f.events.some(event => ['sidebar', 'choose'].includes(event.type)), false)
    assert.deepEqual(f.requests, [])
    assert.equal(f.state().listenerCount, 0)
  })
}
for (const [index, locale] of ['en', 'zh'].entries()) {
  test(`CONTROL canonical ${paths[index]}: known ${locale} preview then keyless steps reuse the unchanged sequential onboarding helper`, async () => {
    const f = fixture(locale, { preview: true })
    await f.run(paths[index])
    completed(f, paths[index])
    assert.deepEqual(f.events.filter(event => event.type === 'dismiss').map(event => event.name), [copy[locale].next, copy[locale].later])
  })
}
