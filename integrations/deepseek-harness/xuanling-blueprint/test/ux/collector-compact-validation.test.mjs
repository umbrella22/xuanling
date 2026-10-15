import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { BUILTIN_NODE_CATALOG } from '../../src/client/node-catalog.ts'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { BLUEPRINT_INVOCATIONS } from '../../src/typert-descriptors.ts'
import { motionDefinition, motionSnapshot } from '../../../../../test/blueprint/capabilities/comfy-motion-ui.mjs'
import { MORE_ACTION_GROUPS, OBJECT_COMMAND_GROUPS } from '../../../../../test/blueprint/capabilities/compact-ui-entry.mjs'
import {
  UX_CASES,
  UX_ASSERTIONS,
  PALETTE_KINDS,
  validateCompactCase,
  validateCompactReceipt,
  validateRetentionState,
  validateRetentionFacts,
  validateCollectorGate,
  adaptProbe
} from '../../../../../test/blueprint/capabilities/compact-ux-ui.mjs'
import { compactMenuBoundsProbe, waitForCompactMenuBounds } from '../../../../../test/blueprint/capabilities/compact-ux-ui.mjs'
const bounds = { left: 0, top: 0, right: 1700, bottom: 1000, width: 1700, height: 1000 }
const rect = { left: 20, top: 20, right: 60, bottom: 60, width: 40, height: 40 }
const events = [{ type: 'pointerdown', trusted: true }]
function state() {
  const definition = motionDefinition('unit-retention'),
    host = { blueprintId: definition.id, semanticRevision: 'unit-semantic', documentRevision: 'unit-document', definitionJson: JSON.stringify(definition) }
  validateDefinition(decodeDefinition(host.definitionJson))
  const snapshot = motionSnapshot(host, 'waiting')
  assert.equal(
    BLUEPRINT_INVOCATIONS.find(c => c.method === 'inspectRun')
      .result.create()
      .safeParse(snapshot).success,
    true
  )
  const prefs = { version: 1, viewport: { x: 17, y: -12, zoom: 0.947573 }, mode: 'select', minimap: false, motion: 'off', canvasLocked: false }
  const matrix = { m11: 0.947573, m12: 0, m21: 0, m22: 0.947573, m41: 17, m42: -12 },
    computedTransform = 'matrix(0.947573,0,0,0.947573,17,-12)'
  const css = {
    publicPrefs: {
      blueprintId: definition.id,
      key: `xuanling-blueprint:viewport:${definition.id}`,
      raw: JSON.stringify(prefs),
      state: prefs,
      status: 'present'
    },
    actual: { matrix, computedTransform },
    expected: {
      provenance: 'attached owned hidden reference / getComputedStyle / DOMMatrix',
      viewport: prefs.viewport,
      matrix: structuredClone(matrix),
      computedTransform
    }
  }
  return {
    definition,
    host,
    inputJson: '{"untouched":"中文"}',
    selection: ['source'],
    history: { undo: false, redo: false, dirty: 'false' },
    draft: null,
    viewport: {
      blueprintId: definition.id,
      key: `xuanling-blueprint:viewport:${definition.id}`,
      raw: JSON.stringify(prefs),
      state: prefs,
      status: 'present',
      inlineTransform: 'transform: translate(17px,-12px) scale(0.947573)',
      computedTransform,
      matrix,
      css
    },
    run: {
      id: snapshot.runId,
      state: snapshot.state,
      revision: snapshot.definitionRevision,
      snapshot,
      inspectInput: '',
      connection: 'connected',
      nodeStates: [{ id: 'source', state: 'running' }],
      attempts: [],
      logTail: []
    }
  }
}
const retained = () => {
  const before = state()
  return { before, after: structuredClone(before) }
}
const buttons = () =>
  ['undo', 'redo', 'save-layout', 'mode-pan', 'mode-select', 'start-run', 'more-actions'].map(id => ({
    id,
    visible: true,
    name: id,
    svgHidden: true,
    width: 40,
    height: 40
  }))
function caseInput(id) {
  const facts = {
    'UX-ICONS': () => ({ buttons: buttons() }),
    'UX-TOOLTIP': () => ({
      tooltips: ['hover', 'focus'].map(kind => ({ kind, role: 'tooltip', visible: true, name: 'Save', text: 'Save Ctrl S', shortcut: 'Ctrl S' }))
    }),
    'UX-DISABLED': () => ({
      ...retained(),
      actions: [{ disabled: true, ariaDisabled: 'true', name: 'Undo', reason: 'No history', tooltipVisible: true, tooltip: 'Undo No history' }],
      executionRequests: 0
    }),
    'UX-BLUEPRINT': () => ({
      count: 1,
      inToolbar: true,
      visible: true,
      toggles: ['toggle-library', 'toggle-inspector'],
      library: { count: 1, mounted: true, visible: true },
      inspector: { count: 1, mounted: true, visible: true },
      name: 'Blueprint library'
    }),
    'UX-MORE': () => ({
      actions: Object.entries(MORE_ACTION_GROUPS).map(([id, group]) => ({ id, group, visible: true, name: id, disabled: false, ariaDisabled: 'false' })),
      groups: ['files', 'view', 'tools'].map(id => ({ id, haspopup: 'menu', expanded: 'true', role: 'menu' }))
    }),
    'UX-MENU': () => ({
      groups: ['appearance', 'layout'].map(id => ({ id, haspopup: 'menu', expanded: 'true', role: 'menu', visible: true })),
      commands: Object.entries(OBJECT_COMMAND_GROUPS).map(([command, group]) => ({
        command,
        group,
        visible: true,
        name: command,
        disabled: false,
        ariaDisabled: 'false'
      }))
    }),
    'UX-FOCUS': () => ({
      ...retained(),
      rightOpened: true,
      leftRestoredParent: true,
      escapeRestoredParent: true,
      secondEscapeRestoredInitiator: true,
      navigation: ['ArrowDown', 'ArrowUp', 'Home', 'End'].map(key => ({ key, inCurrentLevel: true }))
    }),
    'UX-BOUNDARY': () => ({ bounds, menus: [{ rect }, { rect }], pageOverflow: false }),
    'UX-PALETTE': () => ({
      entries: PALETTE_KINDS.map(kind => ({ kind, visible: true, name: kind, icon: true, description: 'Readable description', descriptionVisible: true }))
    }),
    'UX-DISCLOSURE': () => ({
      ...retained(),
      disclosures: ['preflight', 'run'].map(id => ({
        id,
        tag: 'DETAILS',
        summaryTag: 'SUMMARY',
        folded: true,
        expanded: true,
        childrenRetained: true,
        summary: 'waiting_input'
      }))
    }),
    'UX-RETENTION': retained,
    'UX-RETENTION-WAITING': retained,
    'UX-TOP-ROW': () => ({ width: 1700, pageOverflow: false, toolbar: bounds, controls: [...buttons(), { id: 'blueprint' }].map(b => ({ ...b, rect })) }),
    'UX-THEMES': () => ({
      themes: ['zh', 'en'].flatMap(locale => ['light', 'dark'].map(scheme => ({ locale, scheme, width: 1700, height: 1100, overflow: false, ...retained() })))
    }),
    'UX-NARROW': () => ({ width: 1100, bounds, menus: [{ rect }, { rect }], pageOverflow: false, buttons: buttons() }),
    'UX-ZERO-PROVIDER': () => ({ keyRead: false, providerCalls: 0, defaultProfilesRead: false })
  }[id]()
  return { ...UX_CASES.find(c => c.id === id), passed: true, at: '2026-10-08T04:00:01.000Z', facts: { ...facts, events: structuredClone(events) } }
}
const corrupt = {
  'UX-ICONS': f => {
    f.buttons[0].name = ''
  },
  'UX-TOOLTIP': f => {
    f.tooltips[1].shortcut = ''
  },
  'UX-DISABLED': f => {
    f.actions[0].reason = ''
  },
  'UX-BLUEPRINT': f => {
    f.count = 2
  },
  'UX-MORE': f => {
    f.actions[0].group = 'wrong'
  },
  'UX-MENU': f => {
    f.groups[1].haspopup = null
  },
  'UX-FOCUS': f => {
    f.leftRestoredParent = false
  },
  'UX-BOUNDARY': f => {
    f.menus[1].rect = { ...rect, right: 1701 }
  },
  'UX-PALETTE': f => {
    f.entries[2].kind = 'approval'
  },
  'UX-DISCLOSURE': f => {
    f.disclosures[0].childrenRetained = false
  },
  'UX-RETENTION': f => {
    f.after.inputJson = '{}'
  },
  'UX-RETENTION-WAITING': f => {
    f.after.run.snapshot.logTail.push({ seq: 1, kind: 'changed' })
  },
  'UX-TOP-ROW': f => {
    f.controls[0].rect = { ...rect, top: 80, bottom: 120 }
  },
  'UX-THEMES': f => {
    f.themes[3].scheme = 'light'
  },
  'UX-NARROW': f => {
    f.pageOverflow = true
  },
  'UX-ZERO-PROVIDER': f => {
    f.providerCalls = 1
  }
}
test('fixed sixteen-case registry and palette kinds bind to actual public catalogue', () => {
  assert.equal(UX_CASES.length, 16)
  assert.equal(new Set(UX_ASSERTIONS).size, 16)
  assert.deepEqual(
    PALETTE_KINDS,
    BUILTIN_NODE_CATALOG.map(n => n.kind)
  )
  assert.equal(PALETTE_KINDS.includes('approval'), false)
})
for (const id of UX_ASSERTIONS) {
  test(`${id}: loaded collector accepts complete bounded validator input; this is not native evidence`, () =>
    assert.equal(validateCompactCase(caseInput(id)), true))
  test(`${id}: loaded collector rejects missing facts, wrong observed behavior and untrusted input`, () => {
    assert.throws(() => validateCompactCase({ ...caseInput(id), facts: {} }))
    const wrong = caseInput(id)
    corrupt[id](wrong.facts)
    assert.throws(() => validateCompactCase(wrong))
    const untrusted = caseInput(id)
    untrusted.facts.events[0].trusted = false
    assert.throws(() => validateCompactCase(untrusted), /trusted public input/)
    assert.throws(() => validateCompactCase({ ...caseInput(id), id: `${id}-wrong` }), /unknown compact/)
  })
}
test('full retention rejects every missing surface, changed bytes and a malformed actual inspectRun DTO', () => {
  assert.equal(validateRetentionState(state()), true)
  for (const key of ['definition', 'host', 'inputJson', 'selection', 'run', 'history', 'draft', 'viewport']) {
    const facts = retained()
    delete facts.after[key]
    assert.throws(() => validateRetentionFacts(facts), key)
  }
  for (const mutate of [
    s => {
      s.viewport.raw += ' '
    },
    s => {
      s.viewport.matrix.m41 += 0.000001
    },
    s => {
      s.selection = []
    },
    s => {
      s.history.undo = true
    },
    s => {
      s.run.snapshot.attempts = 'invalid'
    },
    s => {
      s.host.documentRevision = 'other'
    }
  ]) {
    const facts = retained()
    mutate(facts.after)
    assert.throws(() => validateRetentionFacts(facts))
  }
})
test('More and object menu disabled ARIA and reasons are independently required for each actual entry', () => {
  for (const id of ['UX-MORE', 'UX-MENU']) {
    const c = caseInput(id),
      items = c.facts.actions ?? c.facts.commands
    for (const item of items) {
      item.disabled = true
      item.ariaDisabled = 'true'
      item.reason = 'Canvas locked'
      item.reasonVisible = true
    }
    assert.equal(validateCompactCase(c), true)
    for (let index = 0; index < items.length; index++)
      for (const field of ['ariaDisabled', 'reason', 'reasonVisible']) {
        const bad = structuredClone(c)
        delete (bad.facts.actions ?? bad.facts.commands)[index][field]
        assert.throws(() => validateCompactCase(bad))
      }
  }
})
function receipt() {
  const cases = UX_ASSERTIONS.map(caseInput)
  return {
    planId: 'dsh-blueprint-compact-ux-v1',
    wave: 'W2',
    keyRead: false,
    providerCalls: 0,
    nativeClipboardEvidence: false,
    startedAt: '2026-10-08T04:00:00.000Z',
    finishedAt: '2026-10-08T04:00:02.000Z',
    cases,
    requests: [],
    trustedEvents: { pointerdown: 1, keydown: 1 },
    untrustedEvents: 0
  }
}
const context = ui => ({
  startedAt: Date.parse(ui.startedAt),
  finishedAt: Date.parse(ui.finishedAt),
  assertions: ui.cases.map(c => ({ ...c, facts: undefined }))
})
test('receipt accepts only exact complete fixed cases and matching current report assertions', () => {
  const ui = receipt()
  assert.equal(validateCompactReceipt(ui, context(ui)).ok, true)
  for (const mutate of [
    ui => {
      ui.cases.pop()
    },
    ui => {
      ui.cases[0] = ui.cases[1]
    },
    ui => {
      ui.cases[0].passed = false
    },
    ui => {
      ui.cases[0].at = '2026-10-07T04:00:01.000Z'
    },
    ui => {
      ui.cases[0].id = 'wrong'
    },
    ui => {
      ui.untrustedEvents = 1
    },
    ui => {
      ui.keyRead = true
    }
  ]) {
    const bad = receipt()
    mutate(bad)
    assert.throws(() => validateCompactReceipt(bad, context(bad)))
  }
  assert.throws(() => validateCompactReceipt(ui, { ...context(ui), assertions: [] }), /assertion/)
})
test('outer collector gate refuses failed process and changed or missing code provenance before reading any report file', () => {
  assert.throws(() => validateCollectorGate({}, { processResult: { status: 1 } }), /subprocess/)
  const fingerprint = { revision: 'a'.repeat(40), source_sha256: 'b'.repeat(64), artifact_sha256: 'c'.repeat(64) }
  assert.throws(
    () => validateCollectorGate({}, { processResult: { status: 0 }, fingerprint, fingerprintAfter: { ...fingerprint, source_sha256: 'd'.repeat(64) } }),
    /fingerprint/
  )
})
test('actual original native probe adapter preserves all budgets and codec bodies without launching', () => {
  const original = readFileSync(new URL('../../../../../test/blueprint/capabilities/probe.mjs', import.meta.url), 'utf8'),
    adapted = adaptProbe(original)
  assert.ok(adapted.includes('compact-ux-ui.mjs'))
  assert.ok(adapted.includes('launchOwnedEdge'))
  for (const token of ['timeout: 180_000', 'page.setDefaultTimeout(15000)', 'timeout: 60_000', "'P4q'", "'P4r'", "'P6z'", 'const apiForCanvas = async'])
    assert.equal(adapted.includes(token), original.includes(token))
})

const objectTarget = { overlay: 'context-menu', group: 'appearance' }
// Observed native geometry: diagnostic-boundary-r2/failed-first-boundary-facts
// and diagnostic-boundary-r1/passive-layout-facts, not invented acceptances.
const workspaceBounds = { left: 280, right: 1700, top: 0, bottom: 1100, width: 1420, height: 1100 }
function boundsDom(options = {}) {
  const shift = options.transient ? 105.5 : 0
  const parentRect = { left: 697, right: 937, top: 349.5 + shift, bottom: 1100 + shift, width: 240, height: 750.5, ...options.parentRect }
  const submenuRect = { left: 718, right: 928, top: 787 + shift, bottom: 1045 + shift, width: 210, height: 258, ...options.submenuRect }
  const element = (attrs, box) => ({
    getAttribute: name => attrs[name] ?? null,
    getBoundingClientRect: () => box,
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false
  })
  const group = options.group ?? 'appearance',
    overlay = options.overlay ?? 'context-menu'
  const parent = element({ 'data-bp-overlay': overlay, role: 'menu', 'aria-label': 'Edit menu' }, parentRect)
  const submenu = element({ 'data-bp-submenu': group, role: 'menu', 'aria-label': 'Appearance' }, submenuRect)
  const trigger = element({ 'aria-expanded': 'true' }, rect)
  parent.querySelector = selector => (selector === `[data-bp-menu-group="${group}"]` ? trigger : null)
  parent.contains = el => el === submenu && !options.foreignSubmenu
  const items = buttons().map(item => {
    const el = element({ 'data-bp-action': item.id, 'aria-label': item.name }, rect)
    el.querySelector = selector => (selector === 'svg[data-bp-icon]' ? element({ 'aria-hidden': 'true' }, rect) : null)
    return el
  })
  const toolbar = element({}, { ...workspaceBounds, bottom: 52, height: 52 })
  toolbar.querySelectorAll = () => items
  const menus = [parent, ...(options.missingSubmenu ? [] : [submenu])]
  const root = element({}, workspaceBounds)
  root.querySelector = selector => (selector === '.bp-toolbar' ? toolbar : null)
  root.querySelectorAll = selector => {
    if (selector === '[role="menu"]') return menus
    if (selector === `[data-bp-overlay="${overlay}"]`) return [parent]
    if (selector === `[data-bp-submenu="${group}"]`) return options.missingSubmenu ? [] : [submenu]
    return []
  }
  return {
    innerWidth: 1700,
    innerHeight: 1100,
    document: { documentElement: { scrollWidth: options.overflow ? 1701 : 1700 }, querySelector: () => (options.missingRoot ? null : root) },
    getComputedStyle: el => ({ display: 'grid', visibility: options.hiddenSubmenu && el === submenu ? 'hidden' : 'visible' })
  }
}
function boundsRead(fn, arg, options) {
  // Execute the actual serialized browser probe, without its module closures.
  return structuredClone(runInNewContext(`(${fn.toString()})(arg)`, { ...boundsDom(options), arg }))
}
function boundsPage(frames) {
  let reads = 0,
    waits = 0,
    disposed = false
  const timeout = new Error('controlled public bounds wait failed at the existing bound')
  timeout.name = 'TimeoutError'
  const read = (fn, arg) => {
    assert.equal(fn, compactMenuBoundsProbe)
    return boundsRead(fn, arg, frames[Math.min(reads++, frames.length - 1)])
  }
  return {
    timeout,
    stats: () => ({ reads, waits, disposed }),
    page: {
      evaluate: async (fn, arg) => read(fn, arg),
      async waitForFunction(fn, arg, ...options) {
        assert.deepEqual(options, [], 'no timeout or polling overrides; original caller configuration remains')
        assert.equal(arg.waitForBounds, true)
        waits++
        // Finite controlled DOM projections, not a claim of native elapsed time.
        for (let poll = 0; poll < frames.length; poll++) {
          const sample = read(fn, arg)
          if (sample)
            return {
              jsonValue: async () => sample,
              dispose: async () => {
                disposed = true
              }
            }
        }
        throw timeout
      }
    }
  }
}
test('compact bounds probe rejects the actual unclamped first geometry and accepts exact clamped public geometry with the original validator', () => {
  const first = boundsRead(compactMenuBoundsProbe, objectTarget, { transient: true })
  assert.equal(first.ready, false)
  assert.equal(first.facts.menus[0].rect.bottom, 1205.5)
  assert.equal(first.facts.menus[1].rect.bottom, 1150.5)
  assert.equal(first.facts.pageOverflow, false)
  assert.throws(() => validateCompactCase({ ...caseInput('UX-BOUNDARY'), facts: { ...first.facts, events } }), /menu clamped bounds/)
  const reached = boundsRead(compactMenuBoundsProbe, objectTarget, {})
  assert.equal(reached.ready, true)
  assert.equal(reached.facts.menus[0].rect.bottom, reached.facts.bounds.bottom)
  assert.equal(validateCompactCase({ ...caseInput('UX-BOUNDARY'), facts: { ...reached.facts, events } }), true)
  assert.equal(boundsRead(compactMenuBoundsProbe, { ...objectTarget, waitForBounds: true }, { transient: true }), false)
  assert.equal(boundsRead(compactMenuBoundsProbe, { ...objectTarget, waitForBounds: true }, {}).ready, true)
})
test('compact bounds wait preserves its transient first sample and returns the same ready facts without a second DOM read', async t => {
  const f = boundsPage([{ transient: true }, { transient: true }, {}]),
    records = []
  let latest
  const facts = await waitForCompactMenuBounds(f.page, objectTarget, evidence => {
    latest = evidence
    records.push(structuredClone(evidence))
  })
  assert.deepEqual(f.stats(), { reads: 3, waits: 1, disposed: true })
  assert.deepEqual(
    records.map(r => r.status),
    ['pending', 'ready']
  )
  assert.equal(records[0].first.ready, false)
  assert.equal(records[0].first.facts.menus[0].rect.bottom, 1205.5)
  assert.deepEqual(records[1].first, records[0].first)
  assert.equal(records[1].reached.ready, true)
  assert.ok(Date.parse(records[0].first.at) <= Date.parse(records[1].reached.at))
  assert.equal(facts, latest.reached.facts, 'the ready sample itself reaches the unchanged validator')
  assert.equal(validateCompactCase({ ...caseInput('UX-BOUNDARY'), facts: { ...facts, events } }), true)
  t.diagnostic(
    JSON.stringify({
      syntheticOnly: true,
      firstAt: records[0].first.at,
      reachedAt: records[1].reached.at,
      firstBottom: records[0].first.facts.menus[0].rect.bottom,
      reachedBottom: facts.menus[0].rect.bottom
    })
  )
})
test('compact bounds wait preserves an already ready first sample without changing public input or polling', async () => {
  const f = boundsPage([{}]),
    records = []
  const facts = await waitForCompactMenuBounds(f.page, objectTarget, evidence => records.push(structuredClone(evidence)))
  assert.deepEqual(f.stats(), { reads: 1, waits: 0, disposed: false })
  assert.deepEqual(records[1].reached, records[0].first)
  assert.deepEqual(facts, records[0].first.facts)
})
test('permanent public bounds failure retains the original rejection plus first and timeout facts', async t => {
  const f = boundsPage([{ transient: true }]),
    records = []
  await assert.rejects(
    waitForCompactMenuBounds(f.page, objectTarget, evidence => records.push(structuredClone(evidence))),
    error => error === f.timeout
  )
  assert.deepEqual(f.stats(), { reads: 3, waits: 1, disposed: false })
  assert.deepEqual(
    records.map(r => r.status),
    ['pending', 'failed']
  )
  const failure = records[1]
  assert.deepEqual(failure.first, records[0].first)
  assert.equal(failure.reached, null)
  assert.equal(failure.failure.name, 'TimeoutError')
  assert.equal(failure.failure.message, f.timeout.message)
  assert.equal(failure.failure.sample.ready, false)
  assert.equal(failure.failure.sample.facts.menus[0].rect.bottom, 1205.5)
  assert.ok(Date.parse(failure.first.at) <= Date.parse(failure.failure.at) && Date.parse(failure.failure.at) <= Date.parse(failure.failure.sample.at))
  assert.throws(() => validateCompactCase({ ...caseInput('UX-BOUNDARY'), facts: { ...failure.failure.sample.facts, events } }), /menu clamped bounds/)
  t.diagnostic(
    JSON.stringify({
      syntheticOnly: true,
      firstAt: failure.first.at,
      failedAt: failure.failure.at,
      failureSampleAt: failure.failure.sample.at,
      failureBottom: failure.failure.sample.facts.menus[0].rect.bottom
    })
  )
})
test('compact bounds readiness rejects missing or wrong parent/submenu, hidden submenu, overflow and fractional boundary violations', async () => {
  for (const options of [
    { missingRoot: true },
    { missingSubmenu: true },
    { overlay: 'more-menu' },
    { group: 'layout' },
    { foreignSubmenu: true },
    { hiddenSubmenu: true },
    { overflow: true },
    { parentRect: { left: 279.999 } },
    { parentRect: { right: 1700.001 } },
    { submenuRect: { top: -0.001 } },
    { submenuRect: { bottom: 1100.001 } },
    { submenuRect: { width: 0 } },
    { parentRect: { right: NaN } }
  ]) {
    assert.equal(boundsRead(compactMenuBoundsProbe, objectTarget, options).ready, false, JSON.stringify(options))
    assert.equal(boundsRead(compactMenuBoundsProbe, { ...objectTarget, waitForBounds: true }, options), false)
    const f = boundsPage([options]),
      records = []
    await assert.rejects(
      waitForCompactMenuBounds(f.page, objectTarget, evidence => records.push(structuredClone(evidence))),
      error => error === f.timeout
    )
    assert.deepEqual(
      records.map(r => r.status),
      ['pending', 'failed']
    )
    assert.equal(records[1].failure.sample.ready, false)
    assert.deepEqual(records[1].first.target, records[1].failure.sample.target)
  }
})
test('narrow bounds readiness requires the specified More/files target rather than a bounded object/appearance menu', async () => {
  const target = { overlay: 'more-menu', group: 'files' }
  assert.equal(boundsRead(compactMenuBoundsProbe, target, {}).ready, false)
  const f = boundsPage([{ overlay: 'more-menu', group: 'files' }]),
    records = []
  const facts = await waitForCompactMenuBounds(f.page, target, evidence => records.push(structuredClone(evidence)))
  assert.equal(records[1].reached.target.submenuInParent, true)
  assert.equal(records[1].reached.target.expanded, 'true')
  assert.equal(facts.menus.length, 2)
  assert.deepEqual(f.stats(), { reads: 1, waits: 0, disposed: false })
})
