// Synthetic fail-closed oracle tests. These NEVER prove mounted DSH behavior.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import {
  UI_ASSERTIONS,
  REQUIRED_ASSERTIONS,
  parseCli,
  adaptProbe,
  prepareCanvasFixtures,
  validateCollectorGate,
  verifyArchiveDownload,
  sha256
} from '../../../../../test/blueprint/capabilities/comfy-interactions-ui.mjs'
import { HOST_CONTROLS_PLAN_ID, reportPathAllowed } from '../../../../../test/blueprint/capabilities/compact-ui-entry.mjs'
import * as diagnostics from '../../../../../test/blueprint/capabilities/comfy-interactions-ui.mjs'
import { PERFORMANCE_BUDGET } from '../../../../../test/blueprint/capabilities/canvas-journey.mjs'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { BLUEPRINT_INVOCATIONS, BLUEPRINT_PACKAGE } from '../../src/typert-descriptors.ts'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const PLAN_ID = process.env.BP_COLLECTOR_PLAN_ID ?? HOST_CONTROLS_PLAN_ID
const RECEIPTS =
  process.env.BP_COLLECTOR_TEST_REPORT_DIR ??
  join(ROOT, `docs/validation/blueprint/current/host-controls/w2/source-fixtures-comfy-${process.pid}-${Date.now()}`)
assert.equal(PLAN_ID, HOST_CONTROLS_PLAN_ID, 'this source run requires the current host-controls plan')
assert.ok(reportPathAllowed(PLAN_ID, 'comfy', RECEIPTS), 'source fixtures require a physically confined host-controls W2 path')
assert.match(relative(join(ROOT, 'docs/validation/blueprint/current/host-controls/w2'), RECEIPTS), /^source-fixtures-[^/]+(?:\/|$)/)
parseCli(['--plan-id', PLAN_ID, '--report-dir', RECEIPTS])
const HERE = join(ROOT, 'test/blueprint/capabilities')
const iso = ms => new Date(ms).toISOString()
test('collector catalog lookup serializes actual probe noarg envelope matching descriptor and preserves parameterized archive legacy envelopes', async () => {
  const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8'),
    probe = readFileSync(join(HERE, 'probe.mjs'), 'utf8'),
    receipt = { rpc: [] },
    envelopes = []
  const page = {
    request: {
      post: async (_url, { data }) => {
        const wire = JSON.parse(JSON.stringify(data)),
          method = wire.method.replace('blueprint/', ''),
          descriptor = BLUEPRINT_INVOCATIONS.find(item => item.method === method)
        assert.ok(descriptor)
        assert.deepEqual(
          Object.keys(wire.payload.args),
          descriptor.parameters.map(parameter => parameter.wire),
          'RPC_WIRE_FIELDS_MUST_MATCH_ACTUAL_DESCRIPTOR'
        )
        for (const parameter of descriptor.parameters) assert.equal(parameter.codec.create().safeParse(wire.payload.args[parameter.wire]).success, true)
        envelopes.push(wire)
        return { status: () => 200, json: async () => ({ result: { ok: true, value: {} } }) }
      }
    }
  }
  const api = Function(
    'page',
    'baseUrl',
    `${probe.slice(probe.indexOf('const apiForCanvas = async'), probe.indexOf("if (CANVAS_TEST === 'performance')"))}; return apiForCanvas`
  )(page, 'http://127.0.0.1:1')
  const realApi = Function(
    'api',
    'receipt',
    `${source.slice(source.indexOf('const realApi = async'), source.indexOf('const doc = (id'))}; return realApi`
  )(api, receipt)
  await Function('realApi', `return async () => ${source.match(/await realApi\('listDefinitions'[^)\n]*\)/)[0]}`)(realApi)()
  assert.deepEqual(envelopes[0].payload, { args: {} })
  assert.equal(receipt.rpc[0].method, 'listDefinitions')
  assert.equal(receipt.rpc[0].blueprintId, undefined)
  for (const [method, args] of [
    ['loadDefinition', { blueprintId: 'comfy-empty' }],
    ['saveDefinition', { blueprintId: 'comfy-empty', definitionJson: '{}', expectedRevision: null }],
    ['exportDefinition', { blueprintId: 'comfy-empty' }],
    ['importDefinition', { blueprintId: 'comfy-empty', archiveBase64: 'synthetic-unit-value' }],
    ['validate', { definitionJson: '{}' }]
  ]) {
    await realApi(method, args)
    assert.deepEqual(envelopes.at(-1).payload, { args: { args } })
  }
})
function emptyFixtureAssertion() {
  if (diagnostics.assertEmptyImportFixture) return diagnostics.assertEmptyImportFixture
  // Execute the actual old lexical-vs-canonical guard after its module loads.
  const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8')
  const confined = Function(
    'isAbsolute',
    'relative',
    'resolve',
    `return (${source.slice(source.indexOf('function confined('), source.indexOf('function realFile('))})`
  )(isAbsolute, relative, resolve)
  return Function(
    'ensure',
    'confined',
    'realpathSync',
    'resolve',
    `return fixture => { ${source.match(/ensure\(fixture\.initiallyEmpty[^\n]+/)[0]} }`
  )((condition, message) => assert.ok(condition, message), confined, realpathSync, resolve)
}
test('empty archive fixture accepts actual owned macOS var alias while retaining exact lexical identity and initially-empty requirement', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'xuanling-bp-probe-path-')),
    empty = join(tempRoot, '.xuanling', 'workflows', 'comfy-empty')
  try {
    mkdirSync(empty, { recursive: true })
    if (process.platform === 'darwin') {
      assert.ok(tempRoot.startsWith('/var/'))
      assert.notEqual(realpathSync(empty), resolve(empty))
    }
    const validate = emptyFixtureAssertion(),
      fixture = { tempRoot, empty, initiallyEmpty: true }
    assert.doesNotThrow(() => validate(fixture), 'OS_VAR_ALIAS_IS_NOT_FIXTURE_ESCAPE')
    assert.throws(() => validate({ ...fixture, initiallyEmpty: false }), /empty import fixture/)
    assert.throws(() => validate({ ...fixture, empty: join(tempRoot, '.xuanling', 'workflows', 'identity-substitute') }), /empty import fixture/)
    assert.throws(() => validate({ ...fixture, empty: `${tempRoot}/.xuanling/workflows/../workflows/comfy-empty` }), /empty import fixture/)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
test('empty archive fixture rejects escaping target or parent symlink before canonical target lookup', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'xuanling-bp-probe-path-')),
    foreign = mkdtempSync(join(tmpdir(), 'xuanling-bp-probe-path-foreign-'))
  const workflows = join(tempRoot, '.xuanling', 'workflows'),
    empty = join(workflows, 'comfy-empty'),
    validate = emptyFixtureAssertion()
  try {
    mkdirSync(workflows, { recursive: true })
    symlinkSync(foreign, empty)
    assert.throws(() => validate({ tempRoot, empty, initiallyEmpty: true }), /empty import fixture/)
    unlinkSync(empty)
    rmSync(workflows, { recursive: true })
    mkdirSync(join(foreign, 'comfy-empty'))
    mkdirSync(join(tempRoot, '.xuanling'), { recursive: true })
    symlinkSync(foreign, workflows)
    assert.throws(() => validate({ tempRoot, empty, initiallyEmpty: true }), /empty import fixture/)
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
    rmSync(foreign, { recursive: true, force: true })
  }
})
test('cold reopen waits through blank readiness for exact bilingual keyless dialog before ordinary dismissal and sidebar click', async () => {
  const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8')
  const { dismissOnboardingDialogs } = await import('../../../../../test/blueprint/capabilities/onboarding-journey.mjs')
  const reopen = Function(
    'dismissOnboardingDialogs',
    'SELECTORS',
    `return (${source.slice(source.indexOf('async function reopen('), source.indexOf('/** Explicit permission seam'))})`
  )(dismissOnboardingDialogs, diagnostics.SELECTORS)
  for (const [title, later] of [
    ['Add an API key to get started', 'Configure later'],
    ['添加一个 API Key 开始使用', '稍后配置']
  ]) {
    let visible = false,
      opened = false
    const trace = [],
      dialog = {
        waitFor: async options => {
          if (options.state === 'visible') {
            assert.equal(options.timeout, 15000)
            trace.push('blank-loading')
            await Promise.resolve()
            visible = true
            trace.push('keyless-visible')
          } else assert.equal(visible, false)
        },
        getByRole: (role, options) => {
          assert.equal(role, 'button')
          assert.deepEqual(options, { name: later, exact: true })
          return {
            click: async options => {
              assert.deepEqual(options, { timeout: 3000 })
              assert.equal(visible, true)
              trace.push('configure-later')
              visible = false
            }
          }
        }
      }
    const dialogs = {
      count: async () => (visible ? 1 : 0),
      first() {
        return this
      },
      getAttribute: async () => title
    }
    const page = {
      locator: selector =>
        selector === '[role="dialog"]:visible' ? dialogs : { isVisible: async () => opened, waitFor: async () => assert.equal(opened, true) },
      getByRole: (role, options) => {
        if (role === 'dialog') {
          assert.ok(options.name === title || options.name.test(title))
          if (options.name instanceof RegExp) {
            assert.equal(options.name.test('unrelated dialog'), false)
            assert.equal(options.name.test(title + ' unrelated'), false)
          }
          return dialog
        }
        return {
          click: async () => {
            assert.equal(role, 'button')
            await Promise.resolve()
            assert.ok(trace.includes('configure-later'), 'SIDEBAR_MASKED_BY_DELAYED_KEYLESS_DIALOG')
            opened = true
            trace.push('sidebar')
          }
        }
      }
    }
    await assert.doesNotReject(reopen(page), 'cold loading blank interval must not be treated as completed keyless onboarding')
    assert.deepEqual(trace, ['blank-loading', 'keyless-visible', 'configure-later', 'sidebar'])
  }
})
test('journey cleanup works without mounted root and preserves the identical original error when observer cleanup fails', async () => {
  assert.equal(typeof diagnostics.cleanupComfyJourney, 'function', 'PRIMARY_ERROR_RETENTION_CLEANUP_MISSING')
  const original = new Error('primary native reopen failure'),
    cleanup = new Error('observer cleanup failed'),
    receipt = {},
    calls = []
  const page = {
    locator: () => {
      throw new Error('cleanup must not wait for root locator')
    },
    evaluate: async (_fn, args) => {
      calls.push(args?.action ?? 'page-cleanup')
      if (calls.length === 1) throw cleanup
    }
  }
  const run = async () => {
    try {
      throw original
    } finally {
      await diagnostics.cleanupComfyJourney(page, receipt, original)
    }
  }
  await assert.rejects(run(), error => error === original)
  assert.equal(receipt.cleanupErrors.length, 1)
  assert.match(receipt.cleanupErrors[0].message, /observer cleanup failed/)
  assert.ok(calls.length >= 3, 'remaining cleanup must still run after the first failure')
  const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8'),
    probe = Function(`return (${source.slice(source.indexOf('function reconnectBrowserProbe('), source.indexOf('async function navigationGeometry('))})`)()
  const oldWindow = globalThis.window
  globalThis.window = {}
  try {
    assert.deepEqual(await probe(null, { action: 'stop' }), [])
    assert.deepEqual(await probe({ action: 'stop' }), [])
  } finally {
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
  }
  const journey = diagnostics.runCanvasJourney.toString()
  assert.ok(journey.includes('receipt.primaryFailure ='), 'PRIMARY_FAILURE_CATCH_MISSING')
  for (const value of [
    'error.stack',
    'latestCase',
    "join(dir, 'failure.png')",
    "page.on('pageerror'",
    "page.on('console'",
    'throw error',
    'cleanupComfyJourney(page, receipt, primaryError)'
  ])
    assert.ok(journey.includes(value))
  for (const step of ['select', 'color', 'save', 'read', 'reload', 'reopen', 'choose']) assert.ok(journey.includes(`save-load-\${pass}/${step}`))
  for (const step of ['save', 'choose-other', 'choose-edit']) assert.ok(journey.includes(`'cas-reconciliation/${step}'`))
  const final = journey.slice(journey.lastIndexOf('} finally {'))
  assert.equal(final.includes('page.locator'), false)
  assert.ok(journey.includes("await page.reload({ waitUntil: 'domcontentloaded' })"))
})
test('journey successful-run cleanup fails closed and reports cleanup errors separately', async () => {
  assert.equal(typeof diagnostics.cleanupComfyJourney, 'function', 'PRIMARY_ERROR_RETENTION_CLEANUP_MISSING')
  const failure = new Error('cleanup on success failed'),
    receipt = {}
  await assert.rejects(
    diagnostics.cleanupComfyJourney(
      {
        evaluate: async () => {
          throw failure
        }
      },
      receipt,
      null
    ),
    error => error === failure
  )
  assert.ok(receipt.cleanupErrors.length >= 3)
})
async function blankPointFixture(hitAt, bounds = { left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 }) {
  const receipts = [],
    samples = [],
    pane = {
      tagName: 'DIV',
      getAttribute: key => (key === 'class' ? 'react-flow__pane' : null),
      parentElement: null,
      getBoundingClientRect: () => bounds,
      closest: selector => (selector === '.react-flow__pane' ? pane : null)
    }
  const obstruction = (kind = 'group') => ({
    tagName: 'DIV',
    parentElement: pane,
    getAttribute: key =>
      ({
        class: kind === 'group' ? 'react-flow__node bp-group-frame' : kind === 'edge' ? 'react-flow__edge' : 'bp-overlay',
        'data-bp-group': kind === 'group' ? 'group-1' : null,
        'data-bp-overlay': kind === 'overlay' ? 'context-menu' : null
      })[key] ?? null,
    closest: selector => (selector === '.react-flow__pane' ? pane : {})
  })
  const surface = { getBoundingClientRect: () => bounds, querySelector: () => pane }
  const priorDocument = globalThis.document,
    priorWindow = globalThis.window
  globalThis.document = {
    elementFromPoint: (x, y) => {
      samples.push({ x, y })
      return hitAt(x, y, pane, obstruction)
    }
  }
  globalThis.window = {
    __bpComfyBlankObserve: facts => {
      receipts.push(facts)
      return Promise.resolve()
    }
  }
  try {
    if (typeof diagnostics.blankCanvasPoint === 'function') return { point: await diagnostics.blankCanvasPoint(surface), receipts, samples, bounds }
    // Run the old mounted four-candidate policy after the module loads.
    const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8')
    const oldBlank = Function(
      'SELECTORS',
      `return (${source.slice(source.indexOf('async function blank(page)'), source.indexOf('/** Invariance gestures'))})`
    )(diagnostics.SELECTORS)
    return { point: await oldBlank({ locator: () => ({ evaluate: fn => fn(surface) }) }), receipts, samples, bounds }
  } catch (error) {
    return { error, receipts, samples, bounds }
  } finally {
    if (priorDocument === undefined) delete globalThis.document
    else globalThis.document = priorDocument
    if (priorWindow === undefined) delete globalThis.window
    else globalThis.window = priorWindow
  }
}
test('blank point discovery preserves original four candidates in order and all previously usable native coordinates', async () => {
  const candidates = [
    [870, 620],
    [870, 85],
    [135, 85],
    [500, 622]
  ]
  for (let usable = 0; usable < 4; usable++) {
    const f = await blankPointFixture((x, y, pane, obstruction) => (x === candidates[usable][0] && y === candidates[usable][1] ? pane : obstruction()))
    assert.equal(f.error, undefined)
    assert.deepEqual(f.point, { x: candidates[usable][0], y: candidates[usable][1] })
    assert.deepEqual(
      f.samples,
      candidates.slice(0, usable + 1).map(([x, y]) => ({ x, y }))
    )
  }
})
test('blank point discovery finds strict interior pane after all four old candidates are blocked and records their full hit facts', async () => {
  const f = await blankPointFixture((x, y, pane, obstruction) => (x === 500 && y === 350 ? pane : obstruction()))
  assert.equal(f.error, undefined, 'OLD_FOUR_CANDIDATES_BLOCKED_DESPITE_VALID_INTERIOR_PANE')
  assert.deepEqual(f.point, { x: 500, y: 350 })
  assert.equal(f.receipts.length, 1)
  assert.equal(f.receipts[0].strategy, 'interior-grid')
  assert.equal(f.receipts[0].oldAttempts.length, 4)
  for (const attempt of f.receipts[0].oldAttempts) {
    assert.equal(attempt.hit.ancestors[0].group, 'group-1')
    assert.equal(attempt.accepted, false)
  }
  assert.equal(f.receipts[0].chosen.hit.equalsPane, true)
  assert.ok(Object.values(f.receipts[0].chosen.edgeDistances).every(value => value >= 64))
})
test('blank point discovery fails finitely with all hits obstructed and persists old and fallback attempts before failure', async () => {
  assert.equal(typeof diagnostics.blankCanvasPoint, 'function', 'BLANK_INTERIOR_DISCOVERY_CAPABILITY_MISSING')
  const f = await blankPointFixture((_x, _y, _pane, obstruction) => obstruction())
  assert.match(f.error.message, /no genuine unobstructed canvas point/)
  assert.equal(f.samples.length, 4 + 17 * 17)
  assert.equal(f.receipts[0].oldAttempts.length, 4)
  assert.equal(f.receipts[0].fallbackAttempts.length, 17 * 17)
  assert.equal(f.receipts[0].chosen, null)
})
test('blank point interior fallback excludes edge and overlay descendants even when their closest pane exists', async () => {
  assert.equal(typeof diagnostics.blankCanvasPoint, 'function', 'BLANK_INTERIOR_DISCOVERY_CAPABILITY_MISSING')
  const f = await blankPointFixture((x, y, pane, obstruction) => {
    if (x === 500 && y === 350) return obstruction('edge')
    if (x < 300 && y >= 114 && y <= 586) return pane
    return obstruction('overlay')
  })
  assert.equal(f.error, undefined)
  assert.ok(f.point.x < 300)
  assert.ok(f.receipts[0].fallbackAttempts.some(attempt => attempt.hit.className === 'react-flow__edge' && attempt.accepted === false))
  assert.equal(f.receipts[0].chosen.hit.equalsPane, true)
  const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8'),
    section = source.slice(source.indexOf('export async function blankCanvasPoint'), source.indexOf('/** Invariance gestures'))
  assert.ok(section.includes('hit === pane'))
  assert.ok(section.includes('evaluate(blankCanvasPoint)'))
  assert.ok(diagnostics.runCanvasJourney.toString().includes("exposeFunction('__bpComfyBlankObserve'"))
  assert.equal(section.includes('.click('), false)
  assert.equal(section.includes('remove('), false)
  assert.equal(section.includes('setViewport'), false)
})
async function interiorPolicy(delta, blocked = () => false, bounds = { left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 }) {
  let hitCount = 0
  const pane = { getBoundingClientRect: () => bounds }
  const surface = { getBoundingClientRect: () => bounds, querySelector: () => pane }
  const page = {
    locator: () => ({
      evaluate: (fn, argument) => {
        const previous = globalThis.document
        globalThis.document = {
          elementFromPoint: (x, y) => {
            hitCount++
            if (blocked(x, y)) return { closest: selector => (selector.includes('__pane') ? pane : {}) }
            pane.closest = selector => (selector.includes('__pane') ? pane : null)
            return pane
          }
        }
        try {
          return fn(surface, argument)
        } finally {
          if (previous === undefined) delete globalThis.document
          else globalThis.document = previous
        }
      }
    })
  }
  let result
  if (typeof diagnostics.interiorNavigationDrag === 'function') result = await diagnostics.interiorNavigationDrag(page, delta)
  else {
    // Execute the actual old point policy after the module loads. Red must
    // be the unsafe coordinates, never an absent import or compilation.
    const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8')
    const oldBlank = Function(
      'SELECTORS',
      `return (${source.slice(source.indexOf('async function blank(page)'), source.indexOf('async function drag(page,'))})`
    )(diagnostics.SELECTORS)
    const from = await oldBlank(page),
      to = { x: from.x + delta.x, y: from.y + delta.y }
    result = { from, to, samples: Array.from({ length: 9 }, (_, i) => ({ x: from.x + (delta.x * i) / 8, y: from.y + (delta.y * i) / 8 })) }
  }
  return { result, hitCount, bounds }
}
test('navigation interior policy rejects old edge-zone points and keeps every Space/ordinary path sample beyond 60 CSS px', async () => {
  for (const delta of [
    { x: -45, y: -25 },
    { x: -20, y: -15 }
  ]) {
    const { result, bounds } = await interiorPolicy(delta)
    assert.equal(result.samples.length, 9)
    for (const p of result.samples)
      assert.ok(Math.min(p.x - bounds.left, bounds.right - p.x, p.y - bounds.top, bounds.bottom - p.y) >= 60, 'NAVIGATION_PATH_INSIDE_AUTOPAN_ZONE')
    assert.deepEqual(result.to, { x: result.from.x + delta.x, y: result.from.y + delta.y })
  }
})
test('navigation interior policy searches past obstructed candidates and rejects any obstructed sample', async () => {
  const blocked = (x, _y) => x > 350 && x < 650
  const { result, hitCount } = await interiorPolicy({ x: -20, y: -15 }, blocked)
  assert.ok(hitCount > 9)
  assert.ok(result.samples.every(p => !blocked(p.x, p.y)))
  // The central candidate's endpoints are blank, but its midpoint is not.
  const middleBlocked = (x, y) => Math.abs(x - 500) < 1 && Math.abs(y - 350) < 1
  const midway = await interiorPolicy({ x: -20, y: -15 }, middleBlocked)
  assert.ok(midway.hitCount > 9)
  assert.ok(midway.result.samples.every(p => !middleBlocked(p.x, p.y)))
})
test('navigation interior policy fails closed with a finite search on covered or undersized panes', async () => {
  let attempts = 0
  await assert.rejects(
    interiorPolicy({ x: -20, y: -15 }, () => {
      attempts++
      return true
    }),
    /unobstructed interior/
  )
  assert.ok(attempts > 0 && attempts <= 17 * 17 * 9, 'navigation search must remain finite')
  await assert.rejects(
    interiorPolicy({ x: -20, y: -15 }, () => false, { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    /interior/
  )
  await assert.rejects(interiorPolicy({ x: NaN, y: 0 }), /finite/)
})
test('navigation interior policy is wired to Space and ordinary drags with trusted mouse gestures and unchanged strict oracle', () => {
  const source = diagnostics.runCanvasJourney.toString()
  assert.ok(source.includes('interiorNavigationDrag(page, { x: -45, y: -25 })'), 'Space still uses edge point policy')
  assert.ok(source.includes('interiorNavigationDrag(page, { x: -20, y: -15 })'), 'ordinary drag still uses edge point policy')
  assert.ok(source.includes('await drag(page, spacePath.from, spacePath.to)'))
  assert.ok(source.includes('await drag(page, ordinaryPath.from, ordinaryPath.to)'))
  assert.ok(
    source.includes(
      'spaceAfter === postOrdinary.style && spaceFacts.invariants.historyUnchanged && spaceFacts.invariants.hostUnchanged && spaceFacts.invariants.definitionUnchanged'
    )
  )
})
function spaceDiagnosticInput() {
  const before = {
    style: 'translate(36px, 20px) scale(0.8)',
    viewport: { x: 36, y: 20, zoom: 0.8 },
    paneBounds: { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 },
    history: { undo: true, redo: true, dirty: 'false' },
    definition: { graph: { nodes: [], edges: [] }, resources: { shared: { path: '中文' } }, metadata: { intact: true } },
    hostDocument: { definitionJson: '{"entire":"Host value"}', documentRevision: 'revision-1' }
  }
  const postSpace = structuredClone(before)
  postSpace.style = 'translate(-9px, -5px) scale(0.8)'
  postSpace.viewport = { x: -9, y: -5, zoom: 0.8 }
  return {
    before,
    postSpace,
    postOrdinary: structuredClone(postSpace),
    targets: {
      ordinary: {
        from: { x: 770, y: 570, hit: { className: 'react-flow__pane', inPane: true }, edgeDistances: { left: 770, right: 30, top: 570, bottom: 30 } },
        to: { x: 750, y: 555 }
      }
    },
    input: [
      { type: 'keydown', key: ' ', code: 'Space', trusted: true },
      { type: 'keyup', key: ' ', code: 'Space', trusted: true },
      { type: 'pointerdown', clientX: 770, clientY: 570, trusted: true }
    ]
  }
}
function viewportDiagnosticInput() {
  const { before } = spaceDiagnosticInput()
  const baseline = {
    kind: 'before-wheel',
    ...before,
    browser: {
      viewport: {
        inlineStyle: 'transform: translate(36px,20px) scale(0.8);',
        inlineTransform: 'translate(36px,20px) scale(0.8)',
        computedTransform: 'matrix(0.8,0,0,0.8,36,20)',
        matrix: { m11: 0.8, m12: 0, m21: 0, m22: 0.8, m41: 36, m42: 20 },
        rendered: { x: 36, y: 20, zoom: 0.8 }
      },
      publicPrefs: {
        key: 'xuanling-blueprint:viewport:comfy-edit',
        blueprintId: 'comfy-edit',
        status: 'present',
        raw: '{"version":1,"viewport":{"zoom":0.8}}',
        state: { version: 1, viewport: { zoom: 0.8 } }
      }
    }
  }
  const after = structuredClone(baseline)
  after.kind = 'after-wheel-before-wait'
  after.browser.viewport.rendered.zoom = 0.947862
  after.browser.viewport.matrix.m11 = 0.947862
  after.browser.viewport.matrix.m22 = 0.947862
  after.browser.viewport.inlineTransform = 'translate(36px,20px) scale(0.947862)'
  after.browser.viewport.computedTransform = 'matrix(0.947862,0,0,0.947862,36,20)'
  after.browser.publicPrefs.state.viewport.zoom = 0.9478617584528319
  after.browser.publicPrefs.raw = JSON.stringify(after.browser.publicPrefs.state)
  return { baseline, after }
}
test('viewport diagnostic distinguishes actual zoom change from full-precision prefs/CSS mismatch using unchanged wait predicates', () => {
  assert.equal(typeof diagnostics.viewportDiagnosticFacts, 'function', 'VIEWPORT_WAIT_DIAGNOSTIC_CAPABILITY_MISSING')
  const { baseline, after } = viewportDiagnosticInput()
  const facts = diagnostics.viewportDiagnosticFacts(baseline, [baseline, after], { zoomBefore: 0.8, zoomAfter: 0.947862 })
  const last = facts.stages[1]
  assert.equal(last.predicates.renderedZoomChanged, true)
  assert.equal(last.predicates.storedZoomMatchesWaitArgument, false)
  assert.equal(last.differences.storedMinusRenderedZoom, 0.9478617584528319 - 0.947862)
  assert.equal(last.differences.absoluteStoredMinusWaitArgument, Math.abs(0.9478617584528319 - 0.947862))
  assert.equal(last.publicPrefs.raw, after.browser.publicPrefs.raw)
  assert.deepEqual(last.publicPrefs.state, after.browser.publicPrefs.state)
  assert.deepEqual(last.viewport.matrix, after.browser.viewport.matrix)
  assert.ok(Object.values(facts.invariants).every(Boolean))
})
test('viewport diagnostic records no-effect wheel and missing wait argument without falsely treating either as persisted match', () => {
  assert.equal(typeof diagnostics.viewportDiagnosticFacts, 'function', 'VIEWPORT_WAIT_DIAGNOSTIC_CAPABILITY_MISSING')
  const { baseline } = viewportDiagnosticInput(),
    last = structuredClone(baseline)
  last.kind = 'failure-finally'
  const facts = diagnostics.viewportDiagnosticFacts(baseline, [last], { zoomBefore: 0.8, zoomAfter: null })
  assert.equal(facts.stages[0].predicates.renderedZoomChanged, false)
  assert.equal(facts.stages[0].predicates.storedZoomMatchesWaitArgument, null)
  assert.equal(facts.stages[0].predicates.waitArgumentAvailable, false)
})
test('viewport diagnostic retains full document/Host/history independently and exposes mutations even before the case assertion', () => {
  assert.equal(typeof diagnostics.viewportDiagnosticFacts, 'function', 'VIEWPORT_WAIT_DIAGNOSTIC_CAPABILITY_MISSING')
  const { baseline, after } = viewportDiagnosticInput()
  after.definition.resources.shared.path = 'changed'
  after.hostDocument.documentRevision = 'changed'
  after.history.redo = false
  const facts = diagnostics.viewportDiagnosticFacts(baseline, [after], { zoomBefore: 0.8, zoomAfter: 0.947862 })
  assert.deepEqual(facts.stages[0].document, after.definition)
  assert.deepEqual(facts.stages[0].hostDocument, after.hostDocument)
  assert.equal(facts.stages[0].documentSha256, sha256(JSON.stringify(after.definition)))
  assert.equal(facts.stages[0].hostDocumentSha256, sha256(JSON.stringify(after.hostDocument)))
  assert.ok(Object.values(facts.invariants).every(v => v === false))
})
test('viewport reload diagnostic preserves full expected/current prefs, exact CSS mismatch, root seat and canonical facts without treating restoration as passed', () => {
  const { baseline, after } = viewportDiagnosticInput(),
    css = viewportCssInput(),
    expectedPrefs = structuredClone(css.publicPrefs.state)
  after.kind = 'failure-finally'
  after.browser.css = css
  after.browser.css.actual.matrix = { m11: 0.802353, m12: 0, m21: 0, m22: 0.802353, m41: 36.9059, m42: 194.091 }
  after.browser.seat = { blueprintId: 'comfy-edit', mode: 'select', motion: 'off', canvasLocked: 'false' }
  const facts = diagnostics.viewportDiagnosticFacts(baseline, [after], { zoomBefore: 0.947573, zoomAfter: null, expectedPrefs })
  const final = facts.stages[0]
  assert.deepEqual(final.expectedPrefs, expectedPrefs, 'RELOAD_EXPECTED_FULL_PREFS_DIAGNOSTIC_MISSING')
  assert.deepEqual(final.css, after.browser.css)
  assert.deepEqual(final.seat, after.browser.seat)
  assert.equal(final.cssOracle.passed, false)
  assert.equal(final.cssOracle.invariants.renderedExactlyEncoded, false)
  assert.equal(final.cssOracle.invariants.preferencesExactlyExpected, true)
  assert.deepEqual(final.document, after.definition)
  assert.deepEqual(final.hostDocument, after.hostDocument)
  assert.deepEqual(final.history, after.history)
  assert.ok(Object.values(facts.invariants).every(Boolean))
})
test('viewport reload mounted diagnostic preserves exact reload wait/assertion and all native inputs while persisting distinct phases and failure-finally', () => {
  const source = diagnostics.runCanvasJourney.toString(),
    begin = source.indexOf('const reloadFacts'),
    end = source.indexOf("await selectNodes(page, ['source']); before = await doc()", begin),
    section = source.slice(begin, end)
  assert.ok(begin > 0, 'RELOAD_WAIT_PHASE_DIAGNOSTIC_MISSING')
  for (const phase of ['before-reload', 'after-reload', 'after-reopen', 'after-choose', 'wait-reload-exact-css', 'failure-finally'])
    assert.ok(section.includes(`'${phase}'`))
  assert.ok(section.includes("await page.reload({ waitUntil: 'domcontentloaded' })"))
  assert.ok(section.includes('await reopen(page)'))
  assert.ok(section.includes("await choose(page, 'comfy-edit')"))
  assert.ok(section.includes("await page.waitForFunction(viewportCssProbe, { action: 'wait', blueprintId: 'comfy-edit', expectedPrefs: viewState })"))
  assert.ok(section.includes('same(viewState, reloadedView) && reloadOracle.passed && Object.values(reloadInvariants).every(Boolean)'))
  assert.ok(section.includes("realApi('loadDefinition', { blueprintId: 'comfy-edit' })"))
  assert.ok(section.includes('viewportDiagnosticFacts(viewportBaseline, reloadStages,'))
  assert.ok(section.includes('catch (error)'))
  assert.ok(section.includes('finally'))
  assert.equal(section.includes('timeout:'), false)
  assert.equal(section.includes('force:'), false)
  assert.equal(section.includes('dispatchEvent'), false)
})
test('viewport mounted oracle preserves diagnostic snapshots and native gestures while requiring stored zoom change and exact browser CSS', () => {
  const source = diagnostics.runCanvasJourney.toString(),
    begin = source.indexOf('const bp = await blank(page), zoomBefore'),
    end = source.indexOf("await choose(page, 'comfy-other'); await action(page, 'mode-pan')", begin),
    section = source.slice(begin, end)
  for (const phase of ['before-wheel', 'after-wheel-before-wait', 'wait-stored-zoom-change-and-css-match', 'failure-finally'])
    assert.ok(section.includes(`'${phase}'`), `VIEWPORT_DIAGNOSTIC_PHASE_MISSING:${phase}`)
  assert.ok(section.includes('await page.mouse.move(bp.x, bp.y); await page.mouse.wheel(0, -120)'))
  assert.ok(section.includes("page.waitForFunction(viewportCssProbe, { action: 'wait', blueprintId: 'comfy-edit', beforeZoom: storedZoomBefore })"))
  assert.ok(section.includes('viewportFacts.oracle.passed'))
  assert.equal(section.includes('1e-8'), false)
  assert.ok(section.includes('catch (error)'))
  assert.ok(section.includes('finally'))
  assert.equal(section.includes('timeout:'), false)
  assert.equal(section.includes('dispatchEvent'), false)
  assert.equal(section.includes('force:'), false)
})
function viewportCssInput() {
  const prefs = {
    version: 1,
    viewport: { x: -99.03664098406466, y: 76.82373943475864, zoom: 0.9475729354058113 },
    mode: 'select',
    minimap: false,
    motion: 'off',
    canvasLocked: false
  }
  const matrix = { m11: 0.947573, m12: 0, m21: 0, m22: 0.947573, m41: -99.0366, m42: 76.8237 }
  return {
    publicPrefs: { status: 'present', blueprintId: 'comfy-edit', key: 'xuanling-blueprint:viewport:comfy-edit', raw: JSON.stringify(prefs), state: prefs },
    actual: { computedTransform: 'matrix(0.947573, 0, 0, 0.947573, -99.0366, 76.8237)', matrix },
    expected: {
      provenance: 'attached owned hidden reference / getComputedStyle / DOMMatrix',
      viewport: structuredClone(prefs.viewport),
      computedTransform: 'matrix(0.947573, 0, 0, 0.947573, -99.0366, 76.8237)',
      matrix: structuredClone(matrix)
    }
  }
}
test('viewport exact CSS oracle accepts captured native representation despite raw numeric zoom difference exceeding old tolerance', () => {
  const browser = viewportCssInput()
  let result
  if (typeof diagnostics.viewportStateOracle === 'function') result = diagnostics.viewportStateOracle(browser, { beforeZoom: 0.8023529411764706 }).passed
  else {
    // Execute the old mounted predicate after the actual module loads. The red
    // is the wrong representation comparison, never a missing import/compile.
    const source = diagnostics.runCanvasJourney.toString(),
      match = source.match(
        /after => \{ const raw = localStorage.getItem\('xuanling-blueprint:viewport:comfy-edit'\); return raw && Math.abs\(JSON.parse\(raw\).viewport.zoom - after\) < 1e-8 \}/
      )
    assert.ok(match, 'old mounted viewport predicate absent')
    result = !!Function('localStorage', `return (${match[0]})`)({ getItem: () => browser.publicPrefs.raw })(browser.actual.matrix.m11)
  }
  assert.equal(result, true, 'VALID_NATIVE_CSS_REPRESENTATION_REJECTED')
  assert.equal(browser.publicPrefs.state.viewport.zoom - browser.actual.matrix.m11, -6.459418866455735e-8)
})
for (const [name, mutate, options] of [
  ['no-effect wheel', () => {}, { beforeZoom: 0.9475729354058113 }],
  [
    'missing state',
    f => {
      f.publicPrefs.raw = null
      f.publicPrefs.state = null
      f.publicPrefs.status = 'missing'
    },
    {}
  ],
  [
    'wrong rendered zoom',
    f => {
      f.actual.matrix.m11 += 1e-7
    },
    {}
  ],
  [
    'wrong rendered translation',
    f => {
      f.actual.matrix.m41 += 1e-7
    },
    {}
  ],
  [
    'wrong skew component',
    f => {
      f.actual.matrix.m12 = 1e-7
    },
    {}
  ],
  [
    'precision-changed persisted object',
    f => {
      f.publicPrefs.state.viewport.zoom = 0.947573
      f.publicPrefs.raw = JSON.stringify(f.publicPrefs.state)
    },
    { expectedPrefs: viewportCssInput().publicPrefs.state }
  ],
  [
    'precision-changed reload object',
    f => {
      f.publicPrefs.state.viewport.x = -99.0366
      f.publicPrefs.raw = JSON.stringify(f.publicPrefs.state)
    },
    { expectedPrefs: viewportCssInput().publicPrefs.state }
  ],
  [
    'changed nonviewport preference',
    f => {
      f.publicPrefs.state.minimap = true
      f.publicPrefs.raw = JSON.stringify(f.publicPrefs.state)
    },
    { expectedPrefs: viewportCssInput().publicPrefs.state }
  ],
  [
    'raw/state disagreement',
    f => {
      f.publicPrefs.raw = '{}'
    },
    {}
  ],
  [
    'wrong encoded full viewport',
    f => {
      f.expected.viewport.zoom = 0.947573
    },
    {}
  ]
])
  test(`viewport exact CSS oracle rejects ${name}`, () => {
    assert.equal(typeof diagnostics.viewportStateOracle, 'function', 'VIEWPORT_EXACT_CSS_ORACLE_MISSING')
    const browser = viewportCssInput()
    mutate(browser)
    assert.equal(diagnostics.viewportStateOracle(browser, options).passed, false)
  })
test('viewport switch/reload mounted source checks full preference object and all browser-encoded matrix components with complete invariants', () => {
  const source = diagnostics.runCanvasJourney.toString(),
    begin = source.indexOf("await choose(page, 'comfy-other'); await action(page, 'mode-pan')"),
    end = source.indexOf("await selectNodes(page, ['source']); before = await doc()", begin),
    section = source.slice(begin, end)
  assert.ok(section.includes('beforeZoom: otherZoomBefore'))
  assert.ok(section.includes('viewportStateOracle(switchedCss, { expectedPrefs: viewState })'))
  assert.ok(section.includes('viewportStateOracle(reloadedCss, { expectedPrefs: viewState })'))
  assert.ok(section.includes('same(otherBefore, otherAfter)'))
  assert.ok(section.includes('same(viewportBaseline.history, switched.history)'))
  assert.ok(section.includes('same(viewportBaseline.history, reloaded.history)'))
  assert.equal(section.includes('1e-8'), false)
  assert.equal(section.includes('1e-5'), false)
  assert.equal(section.includes('waitForFunction(() => !!localStorage.getItem'), false)
  assert.ok(section.includes('await page.mouse.move(otherPoint.x, otherPoint.y); await page.mouse.wheel(0, 120)'))
})
function cssBrowserFixture(args = {}, overrides = {}) {
  assert.equal(typeof diagnostics.viewportCssProbe, 'function', 'VIEWPORT_NATIVE_CSS_CODEC_MISSING')
  const input = viewportCssInput(),
    saved = structuredClone(input.publicPrefs.state),
    references = [],
    reads = [],
    matrices = []
  const actual = {},
    root = { getAttribute: () => 'comfy-edit', querySelector: () => actual }
  const globals = {
    document: {
      querySelector: () => root,
      createElement: () => {
        const reference = {
          style: {},
          connected: false,
          removed: false,
          remove() {
            this.connected = false
            this.removed = true
          }
        }
        references.push(reference)
        return reference
      },
      body: {
        appendChild: reference => {
          reference.connected = true
        }
      }
    },
    localStorage: {
      getItem: key => {
        reads.push(key)
        return overrides.missing ? null : JSON.stringify(saved)
      },
      setItem: () => {
        throw new Error('codec must not write prefs')
      }
    },
    getComputedStyle: element => {
      if (element === actual) return { transform: overrides.actualCss ?? input.actual.computedTransform }
      assert.equal(element.connected, true, 'reference must be attached before computed CSS read')
      assert.equal(element.style.position, 'fixed')
      assert.equal(element.style.width, '0')
      assert.equal(element.style.height, '0')
      assert.equal(element.style.visibility, 'hidden')
      assert.equal(element.style.pointerEvents, 'none')
      const expected = args.expectedPrefs?.viewport ?? saved.viewport
      assert.equal(element.style.transform, `translate(${expected.x}px, ${expected.y}px) scale(${expected.zoom})`, 'codec must receive full unrounded values')
      if (overrides.failReferenceRead) throw new Error('computed reference read unavailable')
      return { transform: input.expected.computedTransform }
    },
    DOMMatrix: class {
      constructor(text) {
        matrices.push(text)
        assert.ok(text.startsWith('matrix('), 'DIRECT_INLINE_PARSE_FORBIDDEN')
        const values = text.slice(7, -1).split(',').map(Number)
        Object.assign(this, Object.fromEntries(['m11', 'm12', 'm21', 'm22', 'm41', 'm42'].map((key, i) => [key, values[i]])))
      }
    }
  }
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, { present: Object.hasOwn(globalThis, key), value: globalThis[key] }]))
  let result, error
  try {
    Object.assign(globalThis, globals)
    result = diagnostics.viewportCssProbe({ blueprintId: 'comfy-edit', ...args })
  } catch (caught) {
    error = caught
  } finally {
    for (const [key, old] of Object.entries(previous)) {
      if (old.present) globalThis[key] = old.value
      else delete globalThis[key]
    }
  }
  return { result, error, references, reads, matrices }
}
test('viewport native codec attaches a hidden zero-size owned reference and uses computed CSS DOMMatrix with full unrounded values', () => {
  const f = cssBrowserFixture({ beforeZoom: 0.8023529411764706 })
  assert.equal(f.error, undefined)
  assert.equal(f.result.passed, true)
  assert.deepEqual(f.result.expected.viewport, viewportCssInput().publicPrefs.state.viewport)
  assert.deepEqual(f.result.expected.matrix, viewportCssInput().expected.matrix)
  assert.equal(f.references.length, 1)
  assert.equal(f.references[0].removed, true)
  assert.deepEqual(f.reads, ['xuanling-blueprint:viewport:comfy-edit'])
  assert.equal(f.matrices.length, 2)
  assert.equal(diagnostics.viewportStateOracle(f.result, { beforeZoom: 0.8023529411764706 }).passed, true)
})
test('viewport native codec wait fails no-effect/missing/wrong-render/precision-changed expected prefs and always removes its reference', () => {
  for (const [args, overrides] of [
    [{ beforeZoom: 0.9475729354058113 }, {}],
    [{}, { missing: true }],
    [{}, { actualCss: 'matrix(0.947574,0,0,0.947573,-99.0366,76.8237)' }],
    [{ expectedPrefs: { ...viewportCssInput().publicPrefs.state, viewport: { ...viewportCssInput().publicPrefs.state.viewport, zoom: 0.947573 } } }, {}]
  ]) {
    const f = cssBrowserFixture({ action: 'wait', ...args }, overrides)
    assert.equal(f.error, undefined)
    assert.equal(f.result, false)
    assert.ok(f.references.every(reference => reference.removed))
  }
  const failed = cssBrowserFixture({}, { failReferenceRead: true })
  assert.match(failed.error.message, /unavailable/)
  assert.equal(failed.references[0].removed, true)
})
test('viewport actual DOM reader observes passive native wheel geometry/deltas/modifiers and reads only public blueprint storage', async () => {
  assert.equal(typeof diagnostics.viewportBrowserProbe, 'function', 'VIEWPORT_BROWSER_DIAGNOSTIC_CAPABILITY_MISSING')
  const trace = [],
    reads = [],
    listeners = new Map(),
    attrs = { class: 'react-flow__pane', 'data-bp-canvas': 'surface' }
  const target = { tagName: 'DIV', parentElement: null, getAttribute: key => attrs[key] ?? null }
  const bounds = { x: 100, y: 20, left: 100, top: 20, right: 900, bottom: 620, width: 800, height: 600 }
  const viewport = { getAttribute: () => 'transform: translate(12px,34px) scale(0.8)', style: { transform: 'translate(12px,34px) scale(0.8)' } }
  const root = {
    getAttribute: key =>
      ({ 'data-bp-blueprint': 'comfy-edit', 'data-bp-mode': 'select', 'data-bp-motion': 'off', 'data-bp-canvas-locked': 'false' })[key] ?? null,
    querySelector: selector => (selector === '.react-flow__viewport' ? viewport : null),
    getBoundingClientRect: () => bounds
  }
  const prefs = { version: 1, viewport: { x: 12.000000001, y: 34, zoom: 0.80000012345 }, mode: 'select', motion: 'off', minimap: false }
  const overrides = {
    document: {
      elementFromPoint: () => target,
      addEventListener: (type, listener, options) => listeners.set(type, { listener, options }),
      removeEventListener: (type, listener, capture) => {
        assert.equal(listeners.get(type).listener, listener)
        assert.equal(capture, true)
        listeners.delete(type)
      }
    },
    window: {
      __bpComfyViewportWheelObserve: event => {
        trace.push(event)
        return Promise.resolve()
      }
    },
    getComputedStyle: () => ({ transform: 'matrix(0.8,0,0,0.8,12,34)' }),
    DOMMatrix: class {
      constructor() {
        Object.assign(this, { m11: 0.8, m12: 0, m21: 0, m22: 0.8, m41: 12, m42: 34 })
      }
    },
    localStorage: {
      getItem: key => {
        reads.push(key)
        return JSON.stringify(prefs)
      },
      setItem: () => {
        throw new Error('viewport diagnostic must not write storage')
      }
    }
  }
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, { present: Object.hasOwn(globalThis, key), value: globalThis[key] }]))
  try {
    Object.assign(globalThis, overrides)
    const state = diagnostics.viewportBrowserProbe(root, { action: 'state', point: { x: 700, y: 500 } })
    assert.deepEqual(state.publicPrefs.state, prefs)
    assert.equal(state.publicPrefs.raw, JSON.stringify(prefs))
    assert.deepEqual(reads, ['xuanling-blueprint:viewport:comfy-edit'])
    assert.deepEqual(state.viewport.rendered, { x: 12, y: 34, zoom: 0.8 })
    assert.equal(state.target.hit.ancestors[0].canvas, 'surface')
    assert.deepEqual(state.seat, { blueprintId: 'comfy-edit', mode: 'select', motion: 'off', canvasLocked: 'false' }, 'RELOAD_ROOT_SEAT_DIAGNOSTIC_MISSING')
    diagnostics.viewportBrowserProbe(root, { action: 'observe' })
    assert.deepEqual(listeners.get('wheel').options, { capture: true, passive: true })
    listeners.get('wheel').listener({
      type: 'wheel',
      isTrusted: true,
      clientX: 700,
      clientY: 500,
      deltaX: 0,
      deltaY: -120,
      deltaZ: 0,
      deltaMode: 0,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      metaKey: false,
      timeStamp: 123,
      defaultPrevented: false,
      eventPhase: 1,
      composedPath: () => [target],
      target
    })
    await diagnostics.viewportBrowserProbe(root, { action: 'stop' })
    assert.equal(trace.length, 1)
    assert.equal(trace[0].trusted, true)
    assert.equal(trace[0].deltaY, -120)
    assert.equal(trace[0].shiftKey, true)
    assert.equal(trace[0].observationPhase, 'document-capture')
    assert.equal(trace[0].target.ancestors[0].canvas, 'surface')
    assert.equal(listeners.size, 0)
    assert.equal(globalThis.window.__bpComfyViewportWheelTracing, undefined)
    // Reload can briefly unmount the seat. Read its absence immediately while
    // retaining owned public prefs, instead of implicitly waiting for a seat.
    globalThis.document.querySelector = () => null
    const unmounted = diagnostics.viewportBrowserProbe({ action: 'state', blueprintId: 'comfy-edit' })
    assert.equal(unmounted.rootMounted, false)
    assert.equal(unmounted.viewport.rendered, null)
    assert.deepEqual(unmounted.seat, { blueprintId: null, mode: null, motion: null, canvasLocked: null })
    assert.deepEqual(unmounted.history, { undo: null, redo: null, dirty: null })
    assert.deepEqual(unmounted.publicPrefs.state, prefs)
  } finally {
    for (const [key, old] of Object.entries(previous)) {
      if (old.present) globalThis[key] = old.value
      else delete globalThis[key]
    }
  }
})
test('CI-SPACE-PAN diagnostic retains exact postOrdinary transform and fails changed view with unchanged document/history', () => {
  assert.equal(typeof diagnostics.spacePanDiagnosticFacts, 'function', 'SPACE_PAN_DIAGNOSTIC_CAPABILITY_MISSING')
  const sample = spaceDiagnosticInput()
  sample.postOrdinary.style = 'translate(-10px, -6px) scale(0.8)'
  sample.postOrdinary.viewport.x = -10
  const facts = diagnostics.spacePanDiagnosticFacts(sample)
  assert.equal(facts.postOrdinary.style, sample.postOrdinary.style)
  assert.deepEqual(facts.postOrdinary.viewport, sample.postOrdinary.viewport)
  assert.deepEqual(facts.invariants, {
    spaceMoved: true,
    ordinaryViewportUnchanged: false,
    historyUnchanged: true,
    definitionUnchanged: true,
    hostUnchanged: true
  })
  assert.equal(Object.values(facts.invariants).every(Boolean), false)
})
test('CI-SPACE-PAN diagnostic compares complete definition resources/metadata, complete Host response and history independently', () => {
  assert.equal(typeof diagnostics.spacePanDiagnosticFacts, 'function')
  const sample = spaceDiagnosticInput()
  sample.postOrdinary.definition.resources.shared.path = 'changed'
  sample.postOrdinary.definition.metadata.intact = false
  sample.postOrdinary.hostDocument.documentRevision = 'revision-2'
  sample.postOrdinary.history.undo = false
  const facts = diagnostics.spacePanDiagnosticFacts(sample)
  assert.equal(facts.invariants.ordinaryViewportUnchanged, true)
  for (const name of ['historyUnchanged', 'definitionUnchanged', 'hostUnchanged']) assert.equal(facts.invariants[name], false)
  assert.equal(facts.baseline.definitionSha256, sha256(JSON.stringify(sample.before.definition)))
  assert.equal(facts.postOrdinary.hostDocumentSha256, sha256(JSON.stringify(sample.postOrdinary.hostDocument)))
  assert.notEqual(facts.baseline.definitionSha256, facts.postOrdinary.definitionSha256)
  assert.notEqual(facts.baseline.hostDocumentSha256, facts.postOrdinary.hostDocumentSha256)
})
test('CI-SPACE-PAN diagnostic retains pane bounds, actual hit/edge distances and trusted key release without mutating snapshots', () => {
  assert.equal(typeof diagnostics.spacePanDiagnosticFacts, 'function')
  const sample = spaceDiagnosticInput(),
    preimage = structuredClone(sample),
    facts = diagnostics.spacePanDiagnosticFacts(sample)
  assert.deepEqual(facts.postOrdinary.paneBounds, sample.postOrdinary.paneBounds)
  assert.equal(facts.before, sample.before.style)
  assert.equal(facts.after, sample.postSpace.style)
  assert.deepEqual(facts.targets, sample.targets)
  assert.deepEqual(facts.input, sample.input)
  assert.equal(facts.targets.ordinary.from.edgeDistances.right, 30)
  assert.ok(facts.input.some(event => event.type === 'keyup' && event.code === 'Space' && event.trusted))
  assert.deepEqual(sample, preimage)
  assert.equal(Object.values(facts.invariants).every(Boolean), true)
})
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
test('valid reconnect diagnostic retains entire graph/document/history and complete Host digest with before/after identity', () => {
  assert.equal(typeof diagnostics.reconnectDiagnosticFacts, 'function', 'RECONNECT_DIAGNOSTIC_CAPABILITY_MISSING')
  const before = { ...spaceDiagnosticInput().before, edgeId: 'edge-1', notices: [{ key: 'ready', text: 'Ready' }] }
  before.definition.graph.edges = [{ kind: 'data', from: 'source.part.中文', to: 'sink.part.中文' }]
  const after = structuredClone(before)
  after.definition.graph.edges[0].to = 'spare.part.中文'
  after.history.undo = false
  const facts = diagnostics.reconnectDiagnosticFacts(before, after)
  assert.deepEqual(facts.before.document, before.definition)
  assert.deepEqual(facts.after.graph, after.definition.graph)
  assert.equal(facts.before.documentSha256, sha256(JSON.stringify(before.definition)))
  assert.equal(facts.after.hostDocumentSha256, sha256(JSON.stringify(after.hostDocument)))
  assert.equal(facts.before.edgeId, 'edge-1')
  assert.equal(facts.after.edgeId, 'edge-1')
  assert.equal(facts.comparisons.graphUnchanged, false)
  assert.equal(facts.comparisons.documentUnchanged, false)
  assert.equal(facts.comparisons.historyUnchanged, false)
  assert.equal(facts.comparisons.hostUnchanged, true)
  assert.deepEqual(facts.after.notices, after.notices)
})
function groupMoveInput() {
  const group = { id: 'group-1', label: '组.中文', nodeIds: ['a', 'b', 'pinned'] }
  const before = {
    ...spaceDiagnosticInput().before,
    edgeId: 'edge-1',
    notices: [],
    definition: {
      graph: { nodes: [{ id: 'a' }, { id: 'b' }, { id: 'pinned' }], edges: [] },
      resources: {},
      presentation: { groups: [group], nodes: { a: { x: 0, y: 0 }, b: { x: 10, y: 100 }, pinned: { x: 50, y: 50, pinned: true } } }
    }
  }
  return { group, before, after: structuredClone(before) }
}
test('group move diagnostic retains precise unequal member deltas instead of rounding into a pass', () => {
  assert.equal(typeof diagnostics.groupMoveDiagnosticFacts, 'function', 'GROUP_MOVE_DIAGNOSTIC_CAPABILITY_MISSING')
  const { group, before, after } = groupMoveInput()
  after.definition.presentation.nodes.a.x = 0.1
  after.definition.presentation.nodes.b.x = 10.1
  const facts = diagnostics.groupMoveDiagnosticFacts(before, after, group)
  assert.deepEqual(facts.before.document, before.definition)
  assert.deepEqual(facts.after.graph, after.definition.graph)
  assert.equal(facts.after.hostDocumentSha256, sha256(JSON.stringify(after.hostDocument)))
  const [a, b] = facts.members
  assert.equal(a.delta.x, 0.1)
  assert.equal(b.delta.x, 10.1 - 10)
  assert.notEqual(a.precision.x, b.precision.x)
  assert.equal(b.differenceFromFirst.x, 10.1 - 10 - 0.1)
  assert.equal(b.exactDeltaMatchesFirst, false)
})
test('group move diagnostic records canonical members, pinned nodes and unchanged wrong-path state with prepared evidence', () => {
  const { group, before, after } = groupMoveInput(),
    prepared = diagnostics.groupMoveDiagnosticFacts(before, null, group)
  assert.equal(prepared.after, null)
  assert.deepEqual(prepared.groupBefore, group)
  const facts = diagnostics.groupMoveDiagnosticFacts(before, after, group)
  assert.deepEqual(facts.groupAfter.nodeIds, group.nodeIds)
  assert.equal(facts.members.find(member => member.id === 'pinned').pinnedBefore, true)
  assert.equal(facts.members.find(member => member.id === 'pinned').pinnedAfter, true)
  assert.ok(facts.members.every(member => member.delta.x === 0 && member.delta.y === 0))
  assert.equal(facts.comparisons.documentUnchanged, true)
  assert.equal(facts.comparisons.hostUnchanged, true)
})
test('group move mounted source preserves header-center path with fresh geometry after both cancellations and exact document oracle', () => {
  const source = diagnostics.runCanvasJourney.toString(),
    begin = source.indexOf('const beforeGroupRename'),
    end = source.indexOf('CI-GROUP-FIT', begin),
    section = source.slice(begin, end)
  assert.ok(begin > 0, 'GROUP_MOVE_FULL_WITNESS_MISSING')
  assert.ok(section.includes('const hp = await point(header)'))
  assert.ok(section.includes('await drag(page, hp, { x: hp.x + 40, y: hp.y + 25 })'))
  assert.ok(section.includes("kind: 'group-move'"))
  assert.ok(section.includes('finally'))
  assert.ok(section.includes('groupMoveDiagnosticFacts(groupBaseline, await reconnectSnapshot(), newGroup)'))
  assert.ok(section.includes('cancelledDrags(header, () => header.focus(), beforeGroupRename)'))
  assert.ok(section.indexOf('cancelledDrags(') < section.indexOf('const groupBaseline'))
  assert.ok(section.indexOf('const groupBaseline') < section.indexOf('const hp = await point(header)'))
  assert.ok(section.includes('groupFacts.oracle = groupMoveOracle(groupFacts)'))
  assert.ok(section.includes('groupFacts.oracle.passed, groupFacts'))
  assert.ok(section.includes('await undoRoundtrip(before, after)'))
  assert.equal(section.includes('same(d, deltas[0])'), false)
  assert.equal(section.includes('dispatchEvent'), false)
  assert.equal(section.includes('force:'), false)
})
// Captured numeric inputs from main's 0240 diagnostic, embedded independently.
// Tests never read an old actual report or treat this synthetic trace as live.
function capturedGroupOracleInput() {
  const group = { id: 'g-6ho4etvu-31', label: '组.中文', nodeIds: ['source', 'wrong', 'zeroTask'] }
  const document = {
    schemaVersion: 2,
    id: 'comfy-edit',
    name: 'Comfy · comfy-edit',
    resources: { shared: { kind: 'skill', source: { kind: 'shared', rootId: 'probe-skills', path: 'sample' } } },
    graph: {
      nodes: ['source', 'sink', 'spare', 'wrong', 'sharedTask', 'zeroTask'].map(id => ({ id })),
      edges: [{ kind: 'data', from: 'source.part.中文', to: 'sink.part.中文' }]
    },
    presentation: {
      groups: [{ id: 'edit-group', label: 'Fixture group 中文', nodeIds: ['sink', 'spare'] }, group],
      nodes: {
        source: { title: ' 标题.中文 🐳 ', width: 279, height: 306, color: 'blue', x: 40, y: 70 },
        sink: { x: 360, y: 70 },
        spare: { x: 360, y: 340 },
        wrong: { x: 670, y: 70 },
        sharedTask: { x: 40, y: 370 },
        zeroTask: { x: 670, y: 350 }
      }
    }
  }
  const snapshot = definition => ({
    definition,
    history: { undo: false, redo: true, dirty: 'true' },
    hostDocument: { definition: structuredClone(document), documentRevision: 'unchanged-host' },
    edgeId: 'edge-1',
    edgeIds: ['edge-1'],
    notices: [],
    selection: {}
  })
  const before = snapshot(document),
    after = snapshot(structuredClone(document))
  Object.assign(after.definition.presentation.nodes.source, { x: 89.85337243401761, y: 101.158357771261 })
  Object.assign(after.definition.presentation.nodes.wrong, { x: 719.8533724340176, y: 101.158357771261 })
  Object.assign(after.definition.presentation.nodes.zeroTask, { x: 719.8533724340176, y: 381.15835777126097 })
  const header = { groupHeader: group.id, button: null, ancestors: [{ tag: 'STRONG' }, { tag: 'DIV', groupHeader: group.id }] }
  const geometry = {
    groupId: group.id,
    from: { x: 914, y: 355.2658996582031, hit: header },
    to: { x: 954, y: 380.2658996582031, hit: header },
    renderer: { rect: { x: 504, y: 98, left: 504, right: 1322, top: 98, bottom: 970, width: 818, height: 872 } },
    viewport: {
      inlineStyle: 'transform: translate(36.9059px, 237.207px) scale(0.802353);',
      inlineTransform: 'translate(36.9059px, 237.207px) scale(0.802353)',
      computedTransform: 'matrix(0.802353, 0, 0, 0.802353, 36.9059, 237.207)',
      rendered: { x: 36.9059, y: 237.207, zoom: 0.802353 }
    },
    uiViewportPrefs: {
      provenance: 'public per-blueprint persisted UI state',
      blueprintId: 'comfy-edit',
      key: 'xuanling-blueprint:viewport:comfy-edit',
      status: 'present',
      state: {
        version: 1,
        viewport: { x: 36.90588235294115, y: 237.2070588235294, zoom: 0.8023529411764706 },
        mode: 'pan',
        minimap: true,
        motion: 'on',
        canvasLocked: false
      }
    }
  }
  const event = (type, x, y, buttons) => ({
    type,
    observationPhase: 'document-capture',
    trusted: true,
    clientX: x,
    clientY: y,
    button: type === 'pointermove' ? -1 : 0,
    buttons,
    pointerId: 1,
    target: header,
    hit: header,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false
  })
  const trace = [
    event('pointerdown', 914, 355.2658996582031, 1),
    event('pointermove', 954, 380.2658996582031, 1),
    event('pointerup', 954, 380.2658996582031, 0)
  ]
  return { kind: 'group-move', ...diagnostics.groupMoveDiagnosticFacts(before, after, group), geometry, geometryAfter: structuredClone(geometry), trace }
}
test('group exact oracle reconstructs captured shared flow delta and complete document without reverse-subtraction tolerance', () => {
  assert.equal(typeof diagnostics.groupMoveOracle, 'function', 'GROUP_EXACT_DOCUMENT_ORACLE_MISSING')
  const facts = capturedGroupOracleInput(),
    result = diagnostics.groupMoveOracle(facts)
  assert.equal(result.passed, true)
  assert.deepEqual(result.delta, { x: 49.853372434017615, y: 31.158357771260995 })
  assert.equal(result.expectedDocumentSha256, facts.after.documentSha256)
  assert.equal(facts.members[2].differenceFromFirst.y, -2.842170943040401e-14)
  assert.equal(facts.members[2].exactDeltaMatchesFirst, false)
})
const groupOracleNegatives = [
  [
    'zero gesture',
    f => {
      for (const e of f.trace) {
        e.clientX = f.geometry.from.x
        e.clientY = f.geometry.from.y
      }
      f.geometry.to = structuredClone(f.geometry.from)
    }
  ],
  [
    'mis-hit header',
    f => {
      f.trace[0].hit.groupHeader = 'other'
    }
  ],
  [
    'button mis-hit',
    f => {
      f.trace[0].target.ancestors.unshift({ tag: 'BUTTON' })
    }
  ],
  [
    'untrusted input',
    f => {
      f.trace[0].trusted = false
    }
  ],
  [
    'missing release',
    f => {
      f.trace.pop()
    }
  ],
  [
    'member mismove',
    f => {
      f.after.document.presentation.nodes.zeroTask.y += 1
    }
  ],
  [
    'other node mutation',
    f => {
      f.after.document.presentation.nodes.sink.x += 1
    }
  ],
  [
    'other presentation mutation',
    f => {
      f.after.document.presentation.nodes.source.color = 'red'
    }
  ],
  [
    'graph mutation',
    f => {
      f.after.document.graph.edges = []
    }
  ],
  [
    'group mutation',
    f => {
      f.after.document.presentation.groups[1].label = 'changed'
    }
  ],
  [
    'resource mutation',
    f => {
      f.after.document.resources.shared.source.path = 'changed'
    }
  ],
  [
    'stale viewport',
    f => {
      f.geometryAfter.uiViewportPrefs.state.viewport.zoom = 1
    }
  ],
  [
    'persisted viewport stale in both snapshots',
    f => {
      f.geometry.uiViewportPrefs.state.viewport.zoom = 1
      f.geometryAfter.uiViewportPrefs.state.viewport.zoom = 1
    }
  ],
  [
    'rendered viewport drift',
    f => {
      f.geometryAfter.viewport.rendered.x += 1
    }
  ],
  [
    'renderer drift',
    f => {
      f.geometryAfter.renderer.rect.left += 1
    }
  ],
  [
    'missing public viewport',
    f => {
      f.geometry.uiViewportPrefs.status = 'missing'
    }
  ],
  [
    'nonfinite viewport',
    f => {
      f.geometry.uiViewportPrefs.state.viewport.zoom = NaN
    }
  ],
  [
    'Host mutation',
    f => {
      f.after.hostDocumentSha256 = '0'.repeat(64)
    }
  ],
  [
    'document digest mismatch',
    f => {
      f.after.documentSha256 = '0'.repeat(64)
    }
  ]
]
for (const [name, mutate] of groupOracleNegatives)
  test(`group exact oracle rejects ${name}`, () => {
    assert.equal(typeof diagnostics.groupMoveOracle, 'function', 'GROUP_EXACT_DOCUMENT_ORACLE_MISSING')
    const facts = capturedGroupOracleInput()
    mutate(facts)
    // Keep digests valid for semantic negatives so rejection must come from the
    // position/gesture/whole-document contract, rather than a stale hash alone.
    if (name !== 'document digest mismatch')
      for (const state of [facts.before, facts.after]) {
        state.documentSha256 = sha256(JSON.stringify(state.document))
        state.graph = state.document.graph
        state.graphSha256 = sha256(JSON.stringify(state.graph))
      }
    assert.equal(diagnostics.groupMoveOracle(facts).passed, false)
  })
test('group exact oracle preserves pinned member while moving each unpinned member by the independently captured delta', () => {
  assert.equal(typeof diagnostics.groupMoveOracle, 'function', 'GROUP_EXACT_DOCUMENT_ORACLE_MISSING')
  const facts = capturedGroupOracleInput()
  facts.before.document.presentation.nodes.zeroTask.pinned = true
  facts.after.document.presentation.nodes.zeroTask = structuredClone(facts.before.document.presentation.nodes.zeroTask)
  for (const state of [facts.before, facts.after]) state.documentSha256 = sha256(JSON.stringify(state.document))
  assert.equal(diagnostics.groupMoveOracle(facts).passed, true)
  facts.after.document.presentation.nodes.zeroTask.x += 1
  assert.equal(diagnostics.groupMoveOracle(facts).passed, false)
})
test('group geometry diagnostics read renderer/actual transform and independent public persisted prefs without private store or writes', () => {
  // Execute the actual DOM reader against synthetic, explicitly independent
  // rendered/storage values. This is an oracle test, never browser evidence.
  const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8')
  const probe = Function(`return (${source.slice(source.indexOf('function reconnectBrowserProbe('), source.indexOf('async function navigationGeometry('))})`)()
  const attrs = { 'data-bp-group-header': 'g' },
    bounds = { x: 100, y: 50, left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600 }
  const header = {
    tagName: 'DIV',
    parentElement: null,
    children: [],
    textContent: '组',
    classList: { contains: () => false },
    getAttribute: key => attrs[key] ?? null,
    getBoundingClientRect: () => bounds,
    querySelectorAll: () => [],
    closest: () => null
  }
  const renderer = { ...header },
    viewport = {
      ...header,
      getAttribute: key => (key === 'style' ? 'transform: translate(12px,34px) scale(0.8)' : null),
      style: { transform: 'translate(12px,34px) scale(0.8)' }
    }
  const root = {
    getAttribute: key => (key === 'data-bp-blueprint' ? 'comfy-edit' : null),
    querySelectorAll: selector => (selector === '[data-bp-group-header]' ? [header] : []),
    querySelector: selector => ({ '.react-flow__renderer': renderer, '.react-flow__viewport': viewport, '.react-flow__pane': header })[selector] ?? null
  }
  const prefs = { version: 1, viewport: { x: 99, y: 98, zoom: 2 }, mode: 'pan', minimap: true, motion: 'on', canvasLocked: false },
    reads = []
  const overrides = {
    document: { elementFromPoint: () => header },
    getComputedStyle: () => ({ transform: 'matrix(0.8, 0, 0, 0.8, 12, 34)' }),
    DOMMatrix: class {
      constructor() {
        this.m11 = 0.8
        this.m12 = 0
        this.m21 = 0
        this.m22 = 0.8
        this.m41 = 12
        this.m42 = 34
      }
    },
    localStorage: {
      getItem: key => {
        reads.push(key)
        return JSON.stringify(prefs)
      },
      setItem: () => {
        throw new Error('diagnostics must not write UI prefs')
      }
    }
  }
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, { present: Object.hasOwn(globalThis, key), value: globalThis[key] }]))
  try {
    Object.assign(globalThis, overrides)
    const facts = probe(root, { action: 'group-geometry', groupId: 'g', from: { x: 200, y: 200 }, to: { x: 240, y: 225 } })
    assert.ok(facts.renderer?.rect, 'GROUP_RENDERER_GEOMETRY_MISSING')
    assert.deepEqual(facts.renderer.rect, bounds)
    assert.equal(facts.viewport.inlineTransform, viewport.style.transform)
    assert.equal(facts.viewport.computedTransform, 'matrix(0.8, 0, 0, 0.8, 12, 34)')
    assert.deepEqual(facts.viewport.rendered, { x: 12, y: 34, zoom: 0.8 })
    assert.deepEqual(facts.uiViewportPrefs.state, prefs)
    assert.equal(facts.uiViewportPrefs.state.viewport.zoom, 2)
    assert.deepEqual(reads, ['xuanling-blueprint:viewport:comfy-edit'])
    assert.deepEqual(facts.pointerCssDelta, { x: 40, y: 25 })
    assert.deepEqual(facts.flowDeltaFromRenderedZoom, { x: 50, y: 31.25 })
  } finally {
    for (const [key, old] of Object.entries(previous)) {
      if (old.present) globalThis[key] = old.value
      else delete globalThis[key]
    }
  }
})
test('valid reconnect diagnostic preserves unchanged wrong-path state and changed Host revision instead of inferring successful reconnect', () => {
  assert.equal(typeof diagnostics.reconnectDiagnosticFacts, 'function')
  const before = { ...spaceDiagnosticInput().before, edgeId: 'edge-1', notices: [] },
    after = structuredClone(before)
  after.hostDocument.documentRevision = 'changed'
  after.notices = [{ key: 'connection.invalid', text: 'Rejected' }]
  const facts = diagnostics.reconnectDiagnosticFacts(before, after)
  assert.equal(facts.comparisons.graphUnchanged, true)
  assert.equal(facts.comparisons.documentUnchanged, true)
  assert.equal(facts.comparisons.hostUnchanged, false)
  assert.notEqual(facts.before.hostDocumentSha256, facts.after.hostDocumentSha256)
  assert.deepEqual(facts.after.notices, after.notices)
})
test('valid reconnect mounted diagnostic preserves original hit coordinates, trusted drag, strict identity/endpoints and partial trace', () => {
  const source = diagnostics.runCanvasJourney.toString(),
    start = source.indexOf('for (let pass = 1; pass <= 3; pass++) {\n      before = await doc(); const oldId'),
    end = source.indexOf('CI-RECONNECT-INVALID', start),
    section = source.slice(start, end)
  assert.ok(section.includes("await point(edgeLocator(page).locator('.react-flow__edgeupdater-target'))"))
  assert.ok(section.includes("await point(port(page, 'spare:data:part.中文', 'target'))"))
  assert.ok(section.includes('await drag(page, from, to)'))
  assert.ok(section.includes("after.graph.edges[0].to === 'spare.part.中文'"))
  assert.ok(section.includes("getAttribute('data-id') === oldId"))
  assert.ok(section.includes('receipt.reconnectDiagnostics.push'))
  assert.ok(section.includes('finally'))
  assert.equal(section.includes('dispatchEvent'), false)
})
async function shiftTraceOracle(swallowed, checkpointBeforeCancellation = false) {
  // Synthetic reader/lifecycle oracle only. No browser or product input is
  // dispatched; invoke the actual passive reader's callbacks as unit inputs.
  const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8')
  const probe = Function(`return (${source.slice(source.indexOf('function reconnectBrowserProbe('), source.indexOf('async function navigationGeometry('))})`)()
  const observers = new Map(),
    trace = []
  const element = (name, attrs = {}) => ({
    tagName: name,
    parentElement: null,
    getAttribute: key => attrs[key] ?? null,
    closest: selector => (selector.includes('edgeupdater') ? circle : null),
    getBoundingClientRect: () => ({ x: 10, y: 20, left: 10, right: 30, top: 20, bottom: 40, width: 20, height: 20 })
  })
  const circle = element('circle', { class: 'react-flow__edgeupdater-target' })
  const listen = name => ({
    addEventListener: (type, fn, options) => observers.set(`${name}:${type}:${typeof options === 'boolean' ? options : options.capture}`, fn),
    removeEventListener: (type, _fn, capture) => observers.delete(`${name}:${type}:${capture}`)
  })
  const pane = Object.assign(element('DIV', { class: 'react-flow__pane selection' }), listen('pane'), { classList: { contains: name => name === 'selection' } })
  let selectionRect = null
  const root = {
    querySelectorAll: () => [],
    querySelector: selector => (selector === '.react-flow__pane' ? pane : selector === '.react-flow__selection' ? selectionRect : null)
  }
  const oldDocument = globalThis.document,
    oldWindow = globalThis.window
  globalThis.document = { ...listen('document'), elementFromPoint: () => circle }
  globalThis.window = {
    __bpComfyReconnectObserve: entry => {
      trace.push(entry)
      return Promise.resolve()
    }
  }
  try {
    probe(root, { action: 'observe' })
    const event = {
      type: 'pointerdown',
      isTrusted: true,
      shiftKey: true,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      timeStamp: 123,
      clientX: 20,
      clientY: 30,
      button: 0,
      buttons: 1,
      pointerId: 7,
      eventPhase: 1,
      defaultPrevented: false,
      cancelBubble: false,
      composedPath: () => [circle],
      target: circle
    }
    observers.get('document:pointerdown:true')(event)
    if (checkpointBeforeCancellation) await Promise.resolve()
    if (swallowed) {
      event.defaultPrevented = true
      selectionRect = element('DIV', { style: 'width:20px;height:20px' })
    } else {
      event.eventPhase = 1
      observers.get('pane:pointerdown:true')?.(event)
      event.eventPhase = 3
      observers.get('pane:pointerdown:false')?.(event)
      observers.get('document:pointerdown:false')?.(event)
    }
    event.eventPhase = 0
    await Promise.resolve()
    await probe(root, { action: 'stop' })
    return {
      trace,
      remainingListeners: observers.size,
      stateRemoved: !globalThis.window.__bpComfyReconnectTracing,
      fixtureDefaultPreventedAfterCallbacks: event.defaultPrevented
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document
    else globalThis.document = oldDocument
    if (oldWindow === undefined) delete globalThis.window
    else globalThis.window = oldWindow
  }
}
test('Shift diagnostic labels the microtask checkpoint accurately without inferring final defaultPrevented', async () => {
  const { trace, remainingListeners, stateRemoved } = await shiftTraceOracle(true)
  const initial = trace.find(entry => entry.observationPhase === 'document-capture'),
    checkpoint = trace.find(entry => entry.observationPhase === 'microtask-checkpoint')
  assert.ok(initial && checkpoint, 'SHIFT_MICROTASK_CHECKPOINT_LABEL_MISSING')
  assert.equal(initial.defaultPrevented, false)
  assert.equal(checkpoint.defaultPrevented, true)
  assert.equal(checkpoint.shiftKey, true)
  assert.equal(initial.eventId, checkpoint.eventId)
  assert.equal(
    trace.some(entry => entry.observationPhase === 'pane-capture'),
    false
  )
  assert.equal(checkpoint.selection.userSelectionRectMounted, true)
  assert.equal(checkpoint.selection.paneSelectionClassActive, true)
  assert.equal(remainingListeners, 0)
  assert.equal(stateRemoved, true)
  // A native-listener checkpoint can precede later cancellation. This unit
  // fixture checks that the reader reports only the value at its checkpoint.
  const early = await shiftTraceOracle(true, true)
  assert.equal(early.trace.find(entry => entry.observationPhase === 'microtask-checkpoint').defaultPrevented, false)
  assert.equal(early.fixtureDefaultPreventedAfterCallbacks, true)
  assert.equal(
    early.trace.some(entry => entry.observationPhase === 'after-dispatch'),
    false
  )
})
test('Shift diagnostic observes actual Pane capture/bubble and cleans passive listeners without preventing events', async () => {
  const { trace, remainingListeners } = await shiftTraceOracle(false)
  for (const phase of ['document-capture', 'pane-capture', 'pane-bubble', 'document-bubble', 'microtask-checkpoint'])
    assert.ok(trace.some(entry => entry.observationPhase === phase))
  assert.ok(trace.every(entry => entry.defaultPrevented === false && entry.shiftKey === true))
  assert.equal(remainingListeners, 0)
})
test('Shift copy source preserves exact original gesture and assertion while adding full snapshots/geometry and shared trace', () => {
  const source = diagnostics.runCanvasJourney.toString(),
    begin = source.indexOf('const shiftBaseline'),
    end = source.indexOf('// Both selected incident edges', begin),
    section = source.slice(begin, end)
  assert.ok(begin > 0, 'SHIFT_COPY_FULL_WITNESS_MISSING')
  assert.ok(section.includes("await point(edgeLocator(page).locator('.react-flow__edgeupdater-target'))"))
  assert.ok(section.includes("await point(port(page, 'spare:data:part.中文', 'target'))"))
  assert.ok(section.includes("await drag(page, shiftFrom, shiftTo, ['Shift'])"))
  assert.ok(section.includes('reconnectDiagnosticFacts(shiftBaseline, await reconnectSnapshot())'))
  assert.ok(section.includes('after.graph.edges.length === before.graph.edges.length + 1 && before.graph.edges.every'))
  assert.ok(section.includes("edge.from === 'source.part.中文' && edge.to === 'spare.part.中文'"))
  assert.ok(section.includes('finally'))
  assert.equal(section.includes('dispatchEvent'), false)
})
test('search cancellation diagnostic detects temporary native doubleclick zoom even when Escape restores final viewport', () => {
  assert.equal(typeof diagnostics.searchCancelDiagnosticFacts, 'function')
  const baseline = spaceDiagnosticInput().before
  const stages = ['tab-open', 'tab-cancel', 'doubleclick-open', 'doubleclick-cancel'].map(kind => ({ kind, ...structuredClone(baseline) }))
  stages[2].viewport.zoom *= 2
  const facts = diagnostics.searchCancelDiagnosticFacts(baseline, stages)
  assert.equal(facts.invariants.viewportUnchanged, false)
  assert.equal(facts.invariants.historyUnchanged, true)
  assert.equal(facts.invariants.definitionUnchanged, true)
  assert.equal(facts.invariants.hostUnchanged, true)
  assert.equal(facts.stages[2].viewport.zoom, baseline.viewport.zoom * 2)
  assert.deepEqual(facts.stages[3].viewport, facts.baseline.viewport)
})
test('search cancellation diagnostic retains complete full definition/Host digests and undo/redo/dirty for all genuine gesture stages', () => {
  const baseline = spaceDiagnosticInput().before
  const stages = ['tab-open', 'tab-cancel', 'doubleclick-open', 'doubleclick-cancel'].map(kind => ({ kind, ...structuredClone(baseline) }))
  const facts = diagnostics.searchCancelDiagnosticFacts(baseline, stages)
  assert.ok(Object.values(facts.invariants).every(Boolean))
  for (const state of facts.stages) {
    assert.equal(state.definitionSha256, sha256(JSON.stringify(baseline.definition)))
    assert.equal(state.hostDocumentSha256, sha256(JSON.stringify(baseline.hostDocument)))
    assert.deepEqual(state.history, baseline.history)
  }
  stages[0].definition.resources.shared.path = 'changed'
  stages[1].hostDocument.documentRevision = 'changed'
  stages[3].history.redo = false
  const changed = diagnostics.searchCancelDiagnosticFacts(baseline, stages)
  for (const key of ['definitionUnchanged', 'hostUnchanged', 'historyUnchanged']) assert.equal(changed.invariants[key], false)
})
test('search cancellation mounted source retains genuine Tab/doubleclick/Escape and strict full witness without synthetic input', () => {
  const source = diagnostics.runCanvasJourney.toString(),
    begin = source.indexOf('const searchBaseline'),
    end = source.indexOf('const outsideMenuPoint', begin),
    section = source.slice(begin, end)
  for (const gesture of ["page.keyboard.press('Tab')", 'page.mouse.dblclick(q.x, q.y)', "page.keyboard.press('Escape')"]) assert.ok(section.includes(gesture))
  for (const name of ['tab-open', 'tab-cancel', 'doubleclick-open', 'doubleclick-cancel']) assert.ok(section.includes(`recordSearch('${name}')`))
  assert.ok(section.includes('Object.values(searchFacts.invariants).every(Boolean)'))
  assert.ok(
    section.indexOf("recordSearch('doubleclick-open')") < section.lastIndexOf("waitFor({ state: 'visible' })"),
    'native failure must retain pre-timeout witness'
  )
  assert.equal(section.includes('dispatchEvent'), false)
})
function png() {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name),
      head = Buffer.alloc(4),
      tail = Buffer.alloc(4)
    head.writeUInt32BE(bytes.length)
    tail.writeUInt32BE(crc32(Buffer.concat([type, bytes])))
    return Buffer.concat([head, type, bytes, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(800)
  ihdr.writeUInt32BE(500, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(500 * (800 * 3 + 1)))),
    chunk('IEND', Buffer.alloc(0))
  ])
}
function synthetic(t) {
  mkdirSync(RECEIPTS, { recursive: true })
  const dir = mkdtempSync(join(RECEIPTS, 'synthetic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const packageRoot = join(dir, 'synthetic-package')
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  const plugin_source = {}
  for (const name of ['lib/index.js', 'lib/client.js', 'lib/typert.host.js']) {
    writeFileSync(join(packageRoot, name), `// SYNTHETIC ${name}`)
    plugin_source[name] = sha256(readFileSync(join(packageRoot, name)))
  }
  const started = Date.parse('2026-10-08T00:00:00.000Z'),
    finished = started + 1000
  const sidebar = join(dir, 'sidebar.png')
  writeFileSync(sidebar, png())
  const nested = { passed: true, plan_id: PLAN_ID, started_at: iso(started), finished_at: iso(finished) }
  mkdirSync(join(dir, 'tools'))
  const nestedPath = join(dir, 'tools/security.json')
  writeFileSync(nestedPath, JSON.stringify(nested))
  const cancellation = kind => ({
    kind,
    before: { documentSha256: '1'.repeat(64), hostDocumentSha256: '2'.repeat(64), history: { undo: false, redo: true, dirty: 'true' } },
    after: { documentSha256: '1'.repeat(64), hostDocumentSha256: '2'.repeat(64), history: { undo: false, redo: true, dirty: 'true' } },
    priorDocumentSha256: '3'.repeat(64),
    undoDocumentSha256: '3'.repeat(64),
    redoDocumentSha256: '1'.repeat(64)
  })
  const searchState = {
    style: 'translate(10px,20px) scale(0.8)',
    viewport: { x: 10, y: 20, zoom: 0.8 },
    history: { undo: true, redo: false, dirty: 'false' },
    definitionSha256: '1'.repeat(64),
    hostDocumentSha256: '2'.repeat(64)
  }
  const searchFacts = {
    baseline: structuredClone(searchState),
    stages: ['tab-open', 'tab-cancel', 'doubleclick-open', 'doubleclick-cancel'].map(kind => ({ kind, ...structuredClone(searchState) })),
    invariants: { viewportUnchanged: true, historyUnchanged: true, definitionUnchanged: true, hostUnchanged: true }
  }
  const cases = UI_ASSERTIONS.map(id => ({
    id,
    description: `SYNTHETIC oracle ${id}`,
    passed: true,
    at: iso(started + 500),
    facts: ['CI-RESIZE', 'CI-REROUTE-MOVE', 'CI-GROUP-MOVE'].includes(id)
      ? { ...(id === 'CI-GROUP-MOVE' ? capturedGroupOracleInput() : {}), cancellations: ['escape', 'outside-release'].map(cancellation) }
      : id === 'CI-SEARCH-CANCEL'
        ? searchFacts
        : {}
  }))
  const groupCase = cases.find(c => c.id === 'CI-GROUP-MOVE')
  groupCase.facts.oracle = diagnostics.groupMoveOracle(groupCase.facts)
  for (const result of groupCase.facts.cancellations) {
    result.before = {
      documentSha256: groupCase.facts.before.documentSha256,
      hostDocumentSha256: groupCase.facts.before.hostDocumentSha256,
      history: structuredClone(groupCase.facts.before.history)
    }
    result.after = structuredClone(result.before)
    result.redoDocumentSha256 = result.before.documentSha256
  }
  const canonical = {
    definition: { graph: { nodes: [], edges: [] }, resources: {} },
    hostDocument: { definitionJson: '{}', documentRevision: 'synthetic-only' },
    history: { undo: true, redo: true, dirty: 'false' }
  }
  const importState = { ...structuredClone(canonical), locked: false, importButtonVisible: true, importDisabled: false, importVisible: false }
  cases.find(c => c.id === 'CI-IMPORT-LOCK').facts = {
    before: structuredClone(importState),
    stages: ['locked', 'control-o', 'meta-o', 'unlocked', 'ordinary-import'].map((kind, index) => ({
      kind,
      ...structuredClone(importState),
      locked: index < 3,
      importDisabled: index < 3,
      importVisible: index === 4,
      noticeVisible: true,
      noticeKey: 'interaction.disabled.canvas-locked',
      noticeText: 'Canvas locked'
    })),
    keys: ['h', 'o', 'o', 'v'].map((key, index) => ({
      key,
      trusted: true,
      canvasFocused: true,
      ctrlKey: index === 1,
      metaKey: index === 2,
      altKey: false,
      shiftKey: false
    }))
  }
  const prefsCase = cases.find(c => c.id === 'CI-VIEWPORT-PREFERENCES'),
    css = viewportCssInput(),
    expectedPrefs = structuredClone(css.publicPrefs.state)
  const wheel = deltaY => [
    {
      type: 'wheel',
      trusted: true,
      deltaX: 0,
      deltaY,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      target: { className: 'react-flow__pane' }
    }
  ]
  prefsCase.facts = {
    css,
    expectedPrefs,
    storedZoomBefore: 0.8023529411764706,
    oracle: diagnostics.viewportStateOracle(css, { beforeZoom: 0.8023529411764706, expectedPrefs }),
    invariants: { documentUnchanged: true, hostUnchanged: true, historyUnchanged: true },
    wheel: wheel(-120),
    baseline: { document: canonical.definition, hostDocument: canonical.hostDocument, history: canonical.history },
    stages: [
      { kind: 'before-wheel', document: canonical.definition, hostDocument: canonical.hostDocument, history: canonical.history },
      { kind: 'before-case-assertion', document: canonical.definition, hostDocument: canonical.hostDocument, history: canonical.history }
    ]
  }
  for (const id of ['CI-VIEWPORT-SWITCH', 'CI-VIEWPORT-RELOAD']) {
    const c = cases.find(item => item.id === id),
      current = structuredClone(css)
    c.facts = {
      css: current,
      expectedPrefs: structuredClone(expectedPrefs),
      oracle: diagnostics.viewportStateOracle(current, { expectedPrefs }),
      before: structuredClone(canonical),
      after: structuredClone(canonical),
      invariants: { documentUnchanged: true, hostUnchanged: true, historyUnchanged: true }
    }
    if (id === 'CI-VIEWPORT-SWITCH')
      c.facts.otherWheel = {
        storedZoomBefore: 0.8023529411764706,
        css: structuredClone(css),
        wheel: wheel(120),
        oracle: diagnostics.viewportStateOracle(css, { beforeZoom: 0.8023529411764706 }),
        before: structuredClone(canonical),
        after: structuredClone(canonical)
      }
  }
  const themes = []
  for (const locale of ['zh', 'en'])
    for (const scheme of ['light', 'dark']) {
      const screenshot = join(dir, `${locale}-${scheme}.png`)
      writeFileSync(screenshot, png())
      themes.push({ locale, scheme, screenshot, sha256: sha256(readFileSync(screenshot)), width: 800, height: 500, overflow: false })
    }
  const rpc = ['loadDefinition', 'saveDefinition', 'exportDefinition', 'importDefinition', 'listDefinitions', 'validate'].map(method => ({
    method,
    status: 200,
    ok: true,
    code: null,
    provenance: 'real DSH gateway',
    at: iso(started + 500)
  }))
  for (const [method, code] of [
    ['saveDefinition', 'blueprint/revision-conflict'],
    ['importDefinition', 'blueprint/import-failed']
  ])
    rpc.push({ method, code, ok: false, status: 200, provenance: 'real DSH gateway', at: iso(started + 500) })
  const downloads = ['archive'].map(kind => {
    const path = join(dir, `synthetic-${kind}`)
    writeFileSync(path, `SYNTHETIC ${kind}`)
    return { kind, path, sha256: sha256(readFileSync(path)), provenance: 'actual Playwright synthetic validator input; not live evidence' }
  })
  const ui = {
    planId: PLAN_ID,
    wave: 'W2',
    startedAt: iso(started),
    finishedAt: iso(finished),
    keyRead: false,
    providerCalls: 0,
    providerEvidence: false,
    nativeClipboardEvidence: false,
    transportFixtures: [],
    clipboardSeams: [{ kind: 'disposable-page-permission-and-late-result', scope: 'UI-only', osClipboardRead: false, osClipboardWrite: false }],
    cases,
    themes,
    rpc,
    downloads,
    requests: [],
    trustedEvents: { pointerdown: 10, pointerup: 10, keydown: 10, wheel: 1, compositionstart: 1 },
    untrustedEvents: 0,
    fixtureRotation: {
      sameConfiguredId: 'comfy-empty',
      archiveIdRewritten: false,
      userData: false,
      source: '/tmp/xuanling-bp-probe-synthetic/.xuanling/workflows/comfy-empty',
      backup: '/tmp/xuanling-bp-probe-synthetic/backup'
    }
  }
  const report = {
    passed: true,
    plan_id: PLAN_ID,
    started_at: iso(started),
    finished_at: iso(finished),
    environment: {
      canvas_test: 'browser',
      node: 'v24.11.1',
      dsh_version_output: '0.2.1-rc.2',
      browser_version: 'synthetic Chromium',
      temp_root: '/tmp/xuanling-bp-probe-synthetic'
    },
    assertions: REQUIRED_ASSERTIONS.map(id => ({ id, description: cases.find(c => c.id === id)?.description ?? `SYNTHETIC host ${id}`, passed: true })),
    artifacts: {
      sidebar_screenshot: sidebar,
      plugin_source,
      auth_cookie_set: true,
      index_has_boot: true,
      client_bundle: { status: 200, closure: true },
      boot_entries: [{ id: BLUEPRINT_PACKAGE }],
      host_tools_contract: { status: 0, reportPath: nestedPath, report: nested },
      canvas_journey: { provenance: 'real DSH boot graph / SYNTHETIC gate input, not mounted receipt', binding: { synthetic: true }, comfyInteractions: ui }
    }
  }
  const fp = { revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) }
  const provenance = {
    planId: PLAN_ID,
    probeSha256: 'd'.repeat(64),
    adapterSha256: 'e'.repeat(64),
    collectorSha256: 'f'.repeat(64),
    entrySha256: sha256(readFileSync(join(HERE, 'compact-ui-entry.mjs'))),
    canvasJourneySha256: sha256(readFileSync(join(HERE, 'canvas-journey.mjs'))),
    keyRead: false,
    providerCalls: 0,
    performanceBudget: PERFORMANCE_BUDGET
  }
  const context = {
    reportDir: dir,
    invokedAt: started,
    finishedAt: finished,
    planId: PLAN_ID,
    packageRoot,
    processResult: { status: 0, signal: null },
    fingerprint: fp,
    fingerprintAfter: structuredClone(fp),
    provenance,
    expectedProvenance: structuredClone(provenance)
  }
  return { dir, report, context, ui }
}
test('W2 gate accepts complete freshly bound synthetic evidence only as an oracle test', t => {
  const f = synthetic(t)
  assert.equal(validateCollectorGate(f.report, f.context).ok, true)
})
test('W2 gate accepts saved native auth boot closure field shape and rejects missing or substituted package identity', t => {
  const f = synthetic(t)
  // Exact r20 report fragment; all other inputs remain explicitly synthetic.
  const native = {
    auth_status: 303,
    auth_cookie_set: true,
    index_has_boot: true,
    client_bundle: { status: 200, closure: true, bytes: 810453 },
    boot_entries: [{ id: '@xuanling-rs/xuanling-dsh-blueprint', url: 'plugins/??@xuanling-rs/xuanling-dsh-blueprint/client.js&rev=f79d8b6a42c5' }]
  }
  assert.equal(native.boot_entries[0].id, BLUEPRINT_PACKAGE)
  Object.assign(f.report.artifacts, structuredClone(native))
  assert.doesNotThrow(() => assert.equal(validateCollectorGate(f.report, f.context).ok, true), 'NATIVE_BOOT_PACKAGE_ID_MAPPING_MISMATCH')
  for (const id of [null, '@ikaros/xuanling-blueprint', 'foreign/xuanling-blueprint', native.boot_entries[0].id + '-foreign']) {
    f.report.artifacts.boot_entries = id === null ? [] : [{ ...native.boot_entries[0], id }]
    assert.throws(() => validateCollectorGate(f.report, f.context), /boot\/closure provenance/)
  }
})
test('native import lock case requires trusted H both open chords V and visible availability with exact document Host history invariants', t => {
  assert.ok(UI_ASSERTIONS.includes('CI-IMPORT-LOCK'), 'CI_IMPORT_LOCK_NATIVE_CASE_MISSING')
  const source = diagnostics.runCanvasJourney.toString()
  for (const input of ["press('h')", "'Control+o'", "'Meta+o'", "press('v')", "check('CI-IMPORT-LOCK'"]) assert.ok(source.includes(input))
  const f = synthetic(t),
    item = f.ui.cases.find(c => c.id === 'CI-IMPORT-LOCK'),
    original = structuredClone(item.facts)
  assert.equal(validateCollectorGate(f.report, f.context).ok, true)
  for (const mutate of [
    facts => {
      facts.stages[0].importDisabled = false
    },
    facts => {
      facts.stages[1].importVisible = true
    },
    facts => {
      facts.stages[2].hostDocument.documentRevision = 'changed'
    },
    facts => {
      facts.stages[1].definition.resources = { changed: true }
    },
    facts => {
      facts.stages[2].history.undo = false
    },
    facts => {
      facts.stages[3].locked = true
    },
    facts => {
      facts.stages[4].importVisible = false
    },
    facts => {
      facts.keys[1].trusted = false
    },
    facts => {
      facts.keys[2].metaKey = false
    },
    facts => {
      facts.stages[1].noticeVisible = false
    },
    facts => {
      facts.stages[2].noticeKey = 'status.saved'
    }
  ]) {
    item.facts = structuredClone(original)
    mutate(item.facts)
    assert.throws(() => validateCollectorGate(f.report, f.context), /import lock/)
  }
})
const negatives = [
  [
    'CI-VIEWPORT-PREFERENCES missing codec witness',
    f => {
      delete f.ui.cases.find(c => c.id === 'CI-VIEWPORT-PREFERENCES').facts.css
    },
    /viewport/
  ],
  [
    'CI-VIEWPORT-PREFERENCES no-effect wheel',
    f => {
      const facts = f.ui.cases.find(c => c.id === 'CI-VIEWPORT-PREFERENCES').facts
      facts.storedZoomBefore = facts.expectedPrefs.viewport.zoom
    },
    /viewport/
  ],
  [
    'CI-VIEWPORT-PREFERENCES document mutation',
    f => {
      f.ui.cases.find(c => c.id === 'CI-VIEWPORT-PREFERENCES').facts.stages[1].document = { changed: true }
    },
    /viewport/
  ],
  [
    'CI-VIEWPORT-PREFERENCES missing trusted wheel',
    f => {
      f.ui.cases.find(c => c.id === 'CI-VIEWPORT-PREFERENCES').facts.wheel = []
    },
    /viewport/
  ],
  [
    'CI-VIEWPORT-SWITCH precision-changed full preference object',
    f => {
      f.ui.cases.find(c => c.id === 'CI-VIEWPORT-SWITCH').facts.expectedPrefs.viewport.zoom = 0.947573
    },
    /viewport/
  ],
  [
    'CI-VIEWPORT-SWITCH other wheel missing witness',
    f => {
      delete f.ui.cases.find(c => c.id === 'CI-VIEWPORT-SWITCH').facts.otherWheel
    },
    /viewport/
  ],
  [
    'CI-VIEWPORT-SWITCH other wheel no-effect',
    f => {
      const facts = f.ui.cases.find(c => c.id === 'CI-VIEWPORT-SWITCH').facts.otherWheel
      facts.storedZoomBefore = facts.css.publicPrefs.state.viewport.zoom
    },
    /viewport/
  ],
  [
    'CI-VIEWPORT-RELOAD precision changed despite identical CSS',
    f => {
      const facts = f.ui.cases.find(c => c.id === 'CI-VIEWPORT-RELOAD').facts
      facts.css.publicPrefs.state.viewport.zoom = 0.947573
      facts.css.publicPrefs.raw = JSON.stringify(facts.css.publicPrefs.state)
    },
    /viewport/
  ],
  [
    'CI-VIEWPORT-RELOAD history mutation',
    f => {
      f.ui.cases.find(c => c.id === 'CI-VIEWPORT-RELOAD').facts.after.history.redo = false
    },
    /viewport/
  ],
  [
    'CI-GROUP-MOVE missing exact gesture witness',
    f => {
      delete f.ui.cases.find(c => c.id === 'CI-GROUP-MOVE').facts.trace
    },
    /group move/
  ],
  [
    'CI-GROUP-MOVE false green whole document',
    f => {
      f.ui.cases.find(c => c.id === 'CI-GROUP-MOVE').facts.after.document.resources = {}
    },
    /group move/
  ],
  [
    'CI-GROUP-MOVE forged delta',
    f => {
      f.ui.cases.find(c => c.id === 'CI-GROUP-MOVE').facts.oracle.delta.x += 1
    },
    /group move/
  ],
  [
    'CI-GROUP-MOVE Escape changes Host',
    f => {
      f.ui.cases.find(c => c.id === 'CI-GROUP-MOVE').facts.cancellations[0].after.hostDocumentSha256 = '4'.repeat(64)
    },
    /cancellation/
  ],
  [
    'CI-GROUP-MOVE stale cancellation baseline',
    f => {
      const result = f.ui.cases.find(c => c.id === 'CI-GROUP-MOVE').facts.cancellations[0]
      result.before.documentSha256 = '4'.repeat(64)
      result.after.documentSha256 = '4'.repeat(64)
      result.redoDocumentSha256 = '4'.repeat(64)
    },
    /cancellation baseline/
  ],
  [
    'CI-SEARCH-CANCEL missing full witness',
    f => {
      f.ui.cases.find(c => c.id === 'CI-SEARCH-CANCEL').facts = {}
    },
    /search cancellation/
  ],
  [
    'CI-SEARCH-CANCEL missing doubleclick stage',
    f => {
      f.ui.cases.find(c => c.id === 'CI-SEARCH-CANCEL').facts.stages.pop()
    },
    /search cancellation/
  ],
  [
    'CI-SEARCH-CANCEL doubleclick changes numeric zoom',
    f => {
      f.ui.cases.find(c => c.id === 'CI-SEARCH-CANCEL').facts.stages[2].viewport.zoom = 1.6
    },
    /search cancellation/
  ],
  [
    'CI-SEARCH-CANCEL Escape changes history',
    f => {
      f.ui.cases.find(c => c.id === 'CI-SEARCH-CANCEL').facts.stages[3].history.redo = true
    },
    /search cancellation/
  ],
  [
    'CI-SEARCH-CANCEL Tab changes full definition',
    f => {
      f.ui.cases.find(c => c.id === 'CI-SEARCH-CANCEL').facts.stages[0].definitionSha256 = '3'.repeat(64)
    },
    /search cancellation/
  ],
  [
    'CI-SEARCH-CANCEL Escape changes full Host',
    f => {
      f.ui.cases.find(c => c.id === 'CI-SEARCH-CANCEL').facts.stages[1].hostDocumentSha256 = '3'.repeat(64)
    },
    /search cancellation/
  ],
  [
    'CI-SEARCH-CANCEL reported invariant false',
    f => {
      f.ui.cases.find(c => c.id === 'CI-SEARCH-CANCEL').facts.invariants.viewportUnchanged = false
    },
    /search cancellation/
  ],
  ...['CI-RESIZE', 'CI-REROUTE-MOVE', 'CI-GROUP-MOVE'].flatMap(id => [
    [
      `${id} missing cancellation proof`,
      f => {
        delete f.ui.cases.find(c => c.id === id).facts.cancellations
      },
      /cancellation/
    ],
    [
      `${id} missing outside release`,
      f => {
        f.ui.cases.find(c => c.id === id).facts.cancellations.pop()
      },
      /cancellation/
    ],
    [
      `${id} changed document on Escape`,
      f => {
        f.ui.cases.find(c => c.id === id).facts.cancellations[0].after.documentSha256 = '4'.repeat(64)
      },
      /cancellation/
    ],
    [
      `${id} changed history on outside release`,
      f => {
        f.ui.cases.find(c => c.id === id).facts.cancellations[1].after.history.redo = false
      },
      /cancellation/
    ],
    [
      `${id} spurious history entry`,
      f => {
        f.ui.cases.find(c => c.id === id).facts.cancellations[0].undoDocumentSha256 = '1'.repeat(64)
      },
      /cancellation/
    ],
    [
      `${id} lost redo state`,
      f => {
        f.ui.cases.find(c => c.id === id).facts.cancellations[1].redoDocumentSha256 = '4'.repeat(64)
      },
      /cancellation/
    ]
  ]),
  [
    'probe failed',
    f => {
      f.report.passed = false
    },
    /probe failed/
  ],
  [
    'wrong plan',
    f => {
      f.report.plan_id = 'old-plan'
    },
    /plan/
  ],
  [
    'wrong canvas mode',
    f => {
      f.report.environment.canvas_test = 'performance'
    },
    /mode/
  ],
  [
    'missing assertion array',
    f => {
      delete f.report.assertions
    },
    /assertions missing/
  ],
  [
    'missing Host assertion',
    f => {
      f.report.assertions = f.report.assertions.filter(a => a.id !== 'P4r')
    },
    /missing/
  ],
  [
    'missing original browser assertion',
    f => {
      f.report.assertions = f.report.assertions.filter(a => a.id !== 'B-CAS')
    },
    /missing/
  ],
  [
    'missing W2 case assertion',
    f => {
      f.report.assertions = f.report.assertions.filter(a => a.id !== 'CI-IME')
    },
    /missing/
  ],
  [
    'failed required assertion',
    f => {
      f.report.assertions[0].passed = false
    },
    /failed/
  ],
  [
    'duplicate assertion',
    f => {
      f.report.assertions.push(f.report.assertions[0])
    },
    /duplicate/
  ],
  [
    'stale start timestamp',
    f => {
      f.report.started_at = iso(f.context.invokedAt - 1)
    },
    /timestamp/
  ],
  [
    'future end timestamp',
    f => {
      f.report.finished_at = iso(f.context.finishedAt + 1)
    },
    /timestamp/
  ],
  [
    'missing end timestamp',
    f => {
      delete f.report.finished_at
    },
    /timestamp/
  ],
  [
    'NaN invocation timestamp',
    f => {
      f.context.invokedAt = NaN
    },
    /timestamp/
  ],
  [
    'stale mounted timestamp',
    f => {
      f.ui.finishedAt = iso(f.context.finishedAt + 1)
    },
    /timestamp/
  ],
  [
    'missing mounted case',
    f => {
      f.ui.cases.pop()
    },
    /case assertions/
  ],
  [
    'duplicate mounted case',
    f => {
      f.ui.cases[1] = f.ui.cases[0]
    },
    /duplicate/
  ],
  [
    'case description mismatch',
    f => {
      f.ui.cases[0].description = 'screenshots-only'
    },
    /mismatch/
  ],
  [
    'stale case timestamp',
    f => {
      f.ui.cases[0].at = iso(f.context.invokedAt - 1)
    },
    /stale/
  ],
  [
    'nonzero subprocess',
    f => {
      f.context.processResult.status = 1
    },
    /subprocess/
  ],
  [
    'missing launch',
    f => {
      f.context.processResult.status = null
    },
    /subprocess/
  ],
  [
    'signal',
    f => {
      f.context.processResult.signal = 'SIGTERM'
    },
    /subprocess/
  ],
  [
    'spawn error',
    f => {
      f.context.processResult.error = { code: 'ENOENT' }
    },
    /subprocess/
  ],
  [
    'source hash changed',
    f => {
      f.context.fingerprintAfter.source_sha256 = '1'.repeat(64)
    },
    /fingerprint/
  ],
  [
    'artifact hash changed',
    f => {
      f.context.fingerprintAfter.artifact_sha256 = '1'.repeat(64)
    },
    /fingerprint/
  ],
  [
    'missing fingerprint',
    f => {
      delete f.context.fingerprint
    },
    /fingerprint/
  ],
  [
    'invalid revision',
    f => {
      f.context.fingerprint.revision = 'unknown'
    },
    /fingerprint/
  ],
  [
    'packed artifact changed',
    f => {
      f.report.artifacts.plugin_source['lib/client.js'] = '0'.repeat(64)
    },
    /fingerprint/
  ],
  [
    'adapter hash mismatch',
    f => {
      f.context.provenance.adapterSha256 = '0'.repeat(64)
    },
    /provenance/
  ],
  [
    'collector hash mismatch',
    f => {
      f.context.provenance.collectorSha256 = '0'.repeat(64)
    },
    /provenance/
  ],
  [
    'missing probe provenance',
    f => {
      delete f.context.provenance.probeSha256
    },
    /provenance/
  ],
  [
    'relaxed original budget',
    f => {
      f.context.provenance.performanceBudget = { ...PERFORMANCE_BUDGET, paintP95Ms: 101 }
      f.context.expectedProvenance = structuredClone(f.context.provenance)
    },
    /budgets/
  ],
  [
    'standalone React provenance',
    f => {
      f.report.artifacts.canvas_journey.provenance = 'standalone React preview'
    },
    /mounted|provenance/
  ],
  [
    'missing DSH version',
    f => {
      delete f.report.environment.dsh_version_output
    },
    /provenance/
  ],
  [
    'missing browser version',
    f => {
      delete f.report.environment.browser_version
    },
    /provenance/
  ],
  [
    'missing real boot manifest',
    f => {
      delete f.report.artifacts.boot_entries
    },
    /provenance/
  ],
  [
    'unauthenticated shell',
    f => {
      f.report.artifacts.auth_cookie_set = false
    },
    /provenance/
  ],
  [
    'missing closure bundle',
    f => {
      f.report.artifacts.client_bundle.closure = false
    },
    /provenance/
  ],
  [
    'nonisolated default profile',
    f => {
      f.report.environment.temp_root = '/Users/example/.dsh'
    },
    /provenance/
  ],
  [
    'missing sidebar screenshot',
    f => {
      rmSync(f.report.artifacts.sidebar_screenshot)
    },
    /screenshot/
  ],
  [
    'missing native screenshot',
    f => {
      rmSync(f.ui.themes[0].screenshot)
    },
    /screenshot/
  ],
  [
    'native screenshot hash mismatch',
    f => {
      f.ui.themes[0].sha256 = '0'.repeat(64)
    },
    /screenshot hash/
  ],
  [
    'screenshots outside fresh run',
    f => {
      f.ui.themes[0].screenshot = '/tmp/historical.png'
    },
    /screenshot/
  ],
  [
    'duplicate theme',
    f => {
      f.ui.themes[1] = f.ui.themes[0]
    },
    /theme matrix/
  ],
  [
    'missing theme',
    f => {
      f.ui.themes.pop()
    },
    /screenshots/
  ],
  [
    'fake PNG',
    f => {
      writeFileSync(f.ui.themes[0].screenshot, 'not an image')
    },
    /PNG/
  ],
  [
    'symlink screenshot',
    f => {
      const p = f.ui.themes[0].screenshot
      rmSync(p)
      symlinkSync(f.report.artifacts.sidebar_screenshot, p)
    },
    /screenshot/
  ],
  [
    'failed nested Tools process',
    f => {
      f.report.artifacts.host_tools_contract.status = 1
    },
    /nested tools/
  ],
  [
    'symlink nested report',
    f => {
      const p = f.report.artifacts.host_tools_contract.reportPath
      rmSync(p)
      symlinkSync(f.report.artifacts.sidebar_screenshot, p)
    },
    /nested security/
  ],
  [
    'stale nested Tools content',
    f => {
      writeFileSync(f.report.artifacts.host_tools_contract.reportPath, JSON.stringify({ passed: true, plan_id: 'old-plan' }))
    },
    /nested tools/
  ],
  [
    'missing real RPC',
    f => {
      f.ui.rpc = f.ui.rpc.filter(r => r.method !== 'importDefinition')
    },
    /Host importDefinition/
  ],
  [
    'missing real CAS rejection',
    f => {
      f.ui.rpc = f.ui.rpc.filter(r => r.code !== 'blueprint/revision-conflict')
    },
    /negative Host/
  ],
  [
    'fake storage transport',
    f => {
      f.ui.rpc[0].provenance = 'transport fixture'
    },
    /RPC provenance/
  ],
  [
    'missing archive',
    f => {
      rmSync(f.ui.downloads[0].path)
    },
    /download/
  ],
  [
    'download hash mismatch',
    f => {
      f.ui.downloads[0].sha256 = '0'.repeat(64)
    },
    /download/
  ],
  [
    'rewritten archive ID',
    f => {
      f.ui.fixtureRotation.archiveIdRewritten = true
    },
    /identity/
  ],
  [
    'rotation outside isolated fixture',
    f => {
      f.ui.fixtureRotation.source = '/Users/example/blueprint'
    },
    /rotation/
  ],
  [
    'provider calls',
    f => {
      f.ui.providerCalls = 1
    },
    /provider/
  ],
  [
    'provider-capable command',
    f => {
      f.ui.requests.push({ method: 'hostProbe' })
    },
    /provider-capable/
  ],
  [
    'key read',
    f => {
      f.ui.keyRead = true
    },
    /key/
  ],
  [
    'unlabeled clipboard seam',
    f => {
      f.ui.clipboardSeams[0].scope = 'native'
    },
    /clipboard/
  ],
  [
    'global OS clipboard write',
    f => {
      f.ui.clipboardSeams[0].osClipboardWrite = true
    },
    /clipboard/
  ],
  [
    'W3 transport fixture in W2',
    f => {
      f.ui.transportFixtures.push({ kind: 'motion' })
    },
    /transport/
  ],
  [
    'untrusted events',
    f => {
      f.ui.untrustedEvents = 1
    },
    /genuine/
  ],
  [
    'missing trusted IME',
    f => {
      f.ui.trustedEvents.compositionstart = 0
    },
    /genuine/
  ],
  [
    'old report directory',
    f => {
      f.context.reportDir = join(ROOT, 'docs/validation/blueprint/current/runtime-contracts/w4/old')
    },
    /fresh W2/
  ],
  [
    'symlink report directory outside W2',
    f => {
      const alias = join(f.dir, 'outside-report')
      symlinkSync(join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint'), alias)
      f.context.reportDir = alias
    },
    /physical report isolation/
  ]
]
for (const [name, change, expected] of negatives)
  test(`W2 oracle rejects ${name}`, t => {
    const f = synthetic(t)
    change(f)
    assert.throws(() => validateCollectorGate(f.report, f.context), expected)
  })

test('CLI requires explicit frozen plan and absolute fresh W2 report directory, rejecting duplicate/unknown/control values', () => {
  const reportDir = join(RECEIPTS, 'new-live-run')
  assert.deepEqual(parseCli(['--plan-id', PLAN_ID, '--report-dir', reportDir]), { planId: PLAN_ID, reportDir })
  assert.deepEqual(parseCli([`--plan-id=${PLAN_ID}`, `--report-dir=${reportDir}`]), { planId: PLAN_ID, reportDir })
  assert.deepEqual(parseCli(['--help']), { help: true })
  for (const args of [
    [],
    ['--report-dir', reportDir],
    ['--plan-id', 'other', '--report-dir', reportDir],
    ['--plan-id', PLAN_ID, '--report-dir', 'relative'],
    ['--plan-id', PLAN_ID, '--report-dir', '/tmp/old'],
    ['--key', 'forbidden'],
    ['--help', '--plan-id', PLAN_ID],
    ['--plan-id', PLAN_ID, '--report-dir', reportDir, '--report-dir', reportDir],
    ['--plan-id', PLAN_ID, '--report-dir'],
    ['--plan-id', PLAN_ID, '--report-dir', reportDir + '\n']
  ])
    assert.throws(() => parseCli(args))
})
test('archive oracle compares the same real export response and rejects hash/bytes/ID or failed RPC', () => {
  const bytes = Buffer.from('PK operator-owned archive fixture'),
    archive = { blueprintId: 'comfy-empty', archiveSha256: sha256(bytes), archiveBase64: bytes.toString('base64') }
  const response = () => ({ status: 200, body: { result: { ok: true, value: structuredClone(archive) } } })
  assert.deepEqual(verifyArchiveDownload(bytes, response(), 'comfy-empty'), archive)
  for (const change of [
    r => {
      r.body.result.value.archiveSha256 = '0'.repeat(64)
    },
    r => {
      r.body.result.value.archiveBase64 = Buffer.from('other export with another exportedAt').toString('base64')
    },
    r => {
      r.body.result.value.blueprintId = 'different-id'
    },
    r => {
      r.body.result.ok = false
    }
  ]) {
    const r = response()
    change(r)
    assert.throws(() => verifyArchiveDownload(bytes, r, 'comfy-empty'))
  }
})
test('UI import records only the same POST response after Apply and rejects failed missing or wrong configured identity', async () => {
  const source = readFileSync(join(HERE, 'comfy-interactions-ui.mjs'), 'utf8'),
    start = source.indexOf('const importResponseEvent =')
  assert.ok(start > 0, 'MOUNTED_UI_IMPORT_SUCCESS_RESPONSE_CAPTURE_MISSING')
  const block = source.slice(start, source.indexOf('await page.waitForFunction(', start))
  const capture = Function('page', 'action', 'idle', 'value', 'ensure', 'receipt', `return async () => { ${block} }`)
  const ensure = (condition, message) => assert.ok(condition, message)
  const value = Function('ensure', `return (${source.slice(source.indexOf('function value('), source.indexOf('function confined('))})`)(ensure)
  const success = () => ({ status: 200, body: { result: { ok: true, value: { blueprintId: 'comfy-empty', filesWritten: 4, closureDigest: 'a'.repeat(64) } } } })
  assert.equal(
    BLUEPRINT_INVOCATIONS.find(item => item.method === 'importDefinition')
      .result.create()
      .safeParse(success().body.result.value).success,
    true
  )
  for (const mutate of [
    null,
    wire => {
      wire.status = 500
    },
    wire => {
      wire.body.result.ok = false
    },
    wire => {
      delete wire.body.result
    },
    wire => {
      delete wire.body.result.value
    },
    wire => {
      wire.body.result.value.blueprintId = 'other-id'
    }
  ]) {
    const wire = success()
    mutate?.(wire)
    const receipt = { rpc: [] },
      trace = [],
      response = {
        status: () => wire.status,
        json: async () => {
          trace.push('response-json')
          return wire.body
        }
      }
    const page = {
      waitForResponse: predicate => {
        trace.push('wait-registered')
        const candidate = (url, method) => ({ url: () => url, request: () => ({ method: () => method }) })
        assert.equal(predicate(candidate('http://127.0.0.1/api/blueprint/importDefinition', 'POST')), true)
        assert.equal(predicate(candidate('http://127.0.0.1/api/blueprint/importDefinition', 'GET')), false)
        assert.equal(predicate(candidate('http://127.0.0.1/api/blueprint/loadDefinition', 'POST')), false)
        return Promise.resolve(response)
      }
    }
    const action = (_page, id) => ({
      click: async () => {
        assert.equal(id, 'import-apply')
        assert.deepEqual(trace, ['wait-registered'])
        trace.push('apply')
      }
    })
    const run = capture(page, action, async () => trace.push('idle'), value, ensure, receipt)
    if (mutate) {
      await assert.rejects(run())
      assert.deepEqual(receipt.rpc, [])
    } else {
      await run()
      assert.deepEqual(trace, ['wait-registered', 'apply', 'idle', 'response-json'])
      assert.deepEqual(receipt.rpc, [
        { method: 'importDefinition', blueprintId: 'comfy-empty', status: 200, ok: true, code: null, at: receipt.rpc[0].at, provenance: 'real DSH gateway' }
      ])
      assert.ok(Number.isFinite(Date.parse(receipt.rpc[0].at)))
    }
  }
})
test('actual original probe adapts with unique anchors, preserves Host assertions/budgets and parses without launch', t => {
  const f = synthetic(t),
    original = readFileSync(join(HERE, 'probe.mjs'), 'utf8'),
    adapted = adaptProbe(original)
  for (const id of ['P4q', 'P4r', 'P4s', 'P4h', 'P4i', 'P4k', 'P4j-raw', 'P6z']) assert.ok(adapted.includes(`'${id}'`))
  for (const budget of ['timeout: 180_000', 'page.setDefaultTimeout(15000)', 'timeout: 60_000'])
    assert.equal(adapted.includes(budget), original.includes(budget))
  assert.ok(adapted.includes('comfy-interactions-ui.mjs'))
  assert.ok(adapted.includes('--from-default-profile')) // Template copied only into probe's isolated HOME.
  const driver = join(f.dir, 'adapted-probe.mjs')
  writeFileSync(driver, adapted)
  const result = spawnSync(process.execPath, ['--check', driver], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(sha256(readFileSync(join(HERE, 'probe.mjs'))), sha256(original))
  assert.throws(() => adaptProbe(original.replace("const pw = await import('playwright')", 'no anchor')), /anchor/)
  assert.throws(() => adaptProbe(original + "\nconst pw = await import('playwright')"), /ambiguous/)
})
test('actual --help and existing report directory rejection never launch or produce probe artifacts', t => {
  const f = synthetic(t),
    collector = join(HERE, 'comfy-interactions-ui.mjs')
  const env = { PATH: process.env.PATH }
  const help = spawnSync(process.execPath, [collector, '--help'], { encoding: 'utf8', env })
  assert.equal(help.status, 0, help.stderr)
  assert.ok(help.stdout.includes(`--plan-id ${PLAN_ID}`))
  assert.ok(help.stdout.includes('Main review/freeze/official build'))
  const refused = spawnSync(process.execPath, [collector, '--plan-id', PLAN_ID, '--report-dir', f.dir], { encoding: 'utf8', env })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /already exists/)
  assert.equal(existsSync(join(f.dir, 'isolated-comfy-probe.mjs')), false)
  assert.equal(existsSync(join(f.dir, 'w0.2-probe-report.json')), false)
})
test('new wrapper uses real decoder/validator, keeps original fixture and budget, adds exact dotted/shared/MCP/zero and initially EMPTY same-ID target', t => {
  const f = synthetic(t),
    temp = join(f.dir, 'operator-fixture')
  mkdirSync(temp)
  const previous = process.env.BP_COMFY_ARTIFACT_DIR,
    previousPlan = process.env.BP_COLLECTOR_PLAN_ID
  process.env.BP_COMFY_ARTIFACT_DIR = f.dir
  process.env.BP_COLLECTOR_PLAN_ID = PLAN_ID
  try {
    const fixtures = prepareCanvasFixtures(temp, decodeDefinition, validateDefinition)
    assert.equal(fixtures.evidence.find(e => e.id === 'canvas-performance').nodes, 200)
    assert.equal(fixtures.evidence.find(e => e.id === 'canvas-performance').edges, 300)
    assert.equal(fixtures.evidence.find(e => e.id === 'canvas-performance').resources, 20)
    const workflowRoot = join(fixtures.config.workspaceRoot, '.xuanling', 'workflows')
    const edit = decodeDefinition(readFileSync(join(workflowRoot, 'comfy-edit', 'blueprint.json'), 'utf8'))
    validateDefinition(edit)
    assert.equal(edit.graph.nodes.find(n => n.id === 'source').outputs['part.中文'], 'string')
    assert.equal(edit.graph.edges[0].to, 'sink.part.中文')
    assert.equal(edit.resources.shared.source.kind, 'shared')
    assert.equal(edit.resources.mcp.kind, 'mcp')
    assert.deepEqual(edit.graph.nodes.find(n => n.id === 'zeroTask').toolAllowlist, [])
    assert.deepEqual(readdirSync(join(workflowRoot, 'comfy-empty')), [])
    const manifest = JSON.parse(readFileSync(join(f.dir, 'comfy-fixtures.json'), 'utf8'))
    assert.equal(manifest.seed.id, 'comfy-empty')
    assert.equal(manifest.empty, join(workflowRoot, 'comfy-empty'))
    assert.equal(existsSync(join(workflowRoot, 'probe-portable', 'lib/agents/a.md')), true)
  } finally {
    if (previous === undefined) delete process.env.BP_COMFY_ARTIFACT_DIR
    else process.env.BP_COMFY_ARTIFACT_DIR = previous
    if (previousPlan === undefined) delete process.env.BP_COLLECTOR_PLAN_ID
    else process.env.BP_COLLECTOR_PLAN_ID = previousPlan
  }
})
