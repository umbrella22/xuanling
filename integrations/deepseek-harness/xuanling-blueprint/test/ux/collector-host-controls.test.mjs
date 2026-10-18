import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as compact from '../../../../../test/blueprint/capabilities/compact-ux-ui.mjs'
import * as entry from '../../../../../test/blueprint/capabilities/compact-ui-entry.mjs'
import { parseCli as comfy } from '../../../../../test/blueprint/capabilities/comfy-interactions-ui.mjs'
import { parseCli as motion } from '../../../../../test/blueprint/capabilities/comfy-motion-ui.mjs'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '')
const plan = 'dsh-blueprint-host-controls-v1'
for (const [name, parse] of [
  ['compact', compact.parseCli],
  ['comfy', comfy],
  ['motion', motion]
]) {
  test(`${name} callable boundary accepts only the explicit host plan in its confined W2 tree`, () => {
    const reportDir = `${root}/docs/validation/blueprint/current/host-controls/w2/new-${name}`
    assert.deepEqual(parse(['--plan-id', plan, '--report-dir', reportDir]), { planId: plan, reportDir })
    for (const badPlan of ['other', `${plan}-other`, '', 'dsh-blueprint-host-controls-v2'])
      assert.throws(() => parse(['--plan-id', badPlan, '--report-dir', reportDir]))
    for (const path of [
      `${root}/test/blueprint/reports/host-controls/w2/native`,
      `${root}/docs/validation/blueprint/archives/host-controls/w2/native`,
      `${root}/docs/validation/blueprint/current/host-controls/w2`,
      `${root}/docs/validation/blueprint/current/host-controls/w1/collector-b`,
      `${root}/docs/validation/blueprint/current/host-controls/w2/../w1/collector-b`,
      `${reportDir}/../alias`,
      '/tmp/escape',
      `${reportDir}\n`
    ])
      assert.throws(() => parse(['--plan-id', plan, '--report-dir', path]))
    for (const oldPlan of ['dsh-blueprint-compact-ux-v1', 'dsh-blueprint-comfy-interactions-v1'])
      assert.throws(() => parse(['--plan-id', oldPlan, '--report-dir', reportDir]))
  })
}
test('loaded collector exposes host computed-style/focus fact validator and two additive cases', () => {
  assert.equal(entry.HOST_CONTROLS_PLAN_ID, plan, 'HOST_CONTROLS_PLAN_ID_MISSING')
  assert.equal(typeof compact.validateHostControlFacts, 'function', 'HOST_CONTROL_FACT_VALIDATOR_MISSING')
  assert.deepEqual(
    compact.HOST_CONTROL_CASES?.map(c => c.id),
    ['HC-STYLE', 'HC-FOCUS']
  )
  assert.equal(compact.UX_CASES.length, 16)
})

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { motionDefinition, motionSnapshot } from '../../../../../test/blueprint/capabilities/comfy-motion-ui.mjs'
const event = (type = 'pointerdown', key = null) => ({ type, key, trusted: true })
const box = { left: 300, top: 100, right: 400, bottom: 140, width: 100, height: 40 }
// DTO fixture for the existing full-state oracle, independent of CSS production.
function retainedState() {
  const definition = motionDefinition('unit-host-controls')
  definition.graph.nodes.push({ id: 'gate', kind: 'humanDecision' })
  const host = { blueprintId: definition.id, semanticRevision: 'unit-semantic', documentRevision: 'unit-document', definitionJson: JSON.stringify(definition) }
  const snapshot = motionSnapshot(host, 'waiting'),
    prefs = { version: 1, viewport: { x: 17, y: -12, zoom: 0.947573 }, mode: 'select', minimap: false, motion: 'off', canvasLocked: false }
  const matrix = { m11: 0.947573, m12: 0, m21: 0, m22: 0.947573, m41: 17, m42: -12 },
    computedTransform = 'matrix(0.947573,0,0,0.947573,17,-12)'
  const publicPrefs = {
    blueprintId: definition.id,
    key: `xuanling-blueprint:viewport:${definition.id}`,
    raw: JSON.stringify(prefs),
    state: prefs,
    status: 'present'
  }
  return {
    definition,
    host,
    inputJson: '{"unchanged":"中文"}',
    selection: ['gate'],
    history: { undo: false, redo: false, dirty: 'false' },
    draft: null,
    viewport: {
      ...publicPrefs,
      inlineTransform: 'transform: translate(17px,-12px) scale(0.947573)',
      computedTransform,
      matrix,
      css: {
        publicPrefs,
        actual: { matrix, computedTransform },
        expected: {
          provenance: 'attached owned hidden reference / getComputedStyle / DOMMatrix',
          viewport: prefs.viewport,
          matrix: structuredClone(matrix),
          computedTransform
        }
      }
    },
    run: {
      id: snapshot.runId,
      state: snapshot.state,
      revision: snapshot.definitionRevision,
      snapshot,
      inspectInput: '',
      connection: 'connected',
      nodeStates: [],
      attempts: [],
      logTail: []
    }
  }
}
const retained = () => {
  const before = retainedState()
  return { before, after: structuredClone(before) }
}
const panes = () => ({
  bounds: { ...box, right: 1700, bottom: 1100, width: 1400, height: 1000 },
  picker: { count: 1, inToolbar: true, visible: true, name: 'Blueprint library' },
  toggles: ['toggle-library', 'toggle-inspector'],
  library: { count: 1, mounted: true, visible: true, rect: { ...box } },
  inspector: { count: 1, mounted: true, visible: true, rect: { ...box } }
})
// Fixed oracle inputs use contract token names and separate color values. They
// do not call a production style helper to generate their expected output.
const fixtureTokens = {
  radiusMd: ['--dsw-radius-md', '12px'],
  radiusSm: ['--dsw-radius-sm', '8px'],
  label: ['--dsw-alias-label-primary', 'rgb(20, 20, 20)'],
  placeholder: ['--dsw-alias-label-dimmed', 'rgb(100, 100, 100)'],
  background: ['--dsw-alias-bg-layer-1', 'rgb(230, 230, 230)'],
  inputBorder: ['--dsw-alias-border-l4', 'rgb(180, 180, 180)'],
  buttonBorder: ['--dsw-alias-border-l3', 'rgb(160, 160, 160)'],
  focus: ['--dsw-alias-state-business-primary', 'rgb(12, 80, 250)'],
  hover: ['--dsw-alias-interactive-bg-hover', 'rgb(200, 200, 200)'],
  active: ['--dsw-alias-interactive-bg-active', 'rgb(190, 190, 190)'],
  primary: ['--dsw-alias-button-primary-fill', 'rgb(0, 70, 240)'],
  primaryHover: ['--dsw-alias-button-primary-hover', 'rgb(0, 60, 220)'],
  foreground: ['--dsw-alias-label-primary-foreground', 'rgb(255, 255, 255)']
}
const selectors = {
  picker: '[data-bp-select="blueprint"]',
  search: '[data-bp-palette-search]',
  inspectorSelect: '.bp-node-inspector select[data-bp-field="agentRef"]',
  runInput: '[data-bp-run-input]',
  formInput: 'input[name="runId"]',
  textButton: '[data-bp-action="inspect-run"]',
  portButton: '[data-bp-action="add-input-port"]',
  neutral: '[data-bp-action="more-actions"]',
  primary: '[data-bp-action="start-run"]'
}
function hostFacts(id) {
  const themes = ['zh', 'en'].flatMap(locale =>
    ['light', 'dark'].map(scheme => {
      const tokens = Object.fromEntries(Object.entries(fixtureTokens).map(([key, [name, color]]) => [key, { name, raw: color, resolved: color }]))
      const controls = Object.fromEntries(
        Object.entries(selectors).map(([role, selector]) => {
          const tag = ['picker', 'inspectorSelect'].includes(role)
            ? 'SELECT'
            : role === 'runInput'
              ? 'TEXTAREA'
              : ['search', 'formInput'].includes(role)
                ? 'INPUT'
                : 'BUTTON'
          return [
            role,
            {
              selector,
              count: 1,
              tag,
              value: '',
              options: tag === 'SELECT' ? [{ value: '', label: 'No binding', disabled: false }] : [],
              name: 'Actual form name',
              visible: true,
              rect: { ...box },
              width: 100,
              height: 40,
              disabled: false,
              svgHidden: true,
              radius: ['portButton', 'neutral', 'primary'].includes(role) ? '8px' : '12px',
              appearance: 'none',
              color: tokens[role === 'primary' ? 'foreground' : 'label'].resolved,
              background: tokens[role === 'primary' ? 'primary' : 'background'].resolved,
              border: tokens[['textButton', 'portButton'].includes(role) ? 'buttonBorder' : 'inputBorder'].resolved,
              placeholderColor: tokens.placeholder.resolved
            }
          ]
        })
      )
      const state = retainedState()
      return {
        locale,
        scheme,
        width: 1700,
        height: 1100,
        overflow: false,
        ...retained(),
        events: [event(), event('keydown', 'Tab')],
        style: {
          provenance: 'actual getComputedStyle controls / themed document.body tokens / owned CSS reference in body',
          selectedNode: 'gate',
          tokens,
          controls
        },
        sidebar: {
          collapseBefore: true,
          openCollapsed: true,
          collapseAfter: true,
          events: [event(), event()],
          before: panes(),
          collapsed: panes(),
          after: panes(),
          stateBefore: state,
          stateCollapsed: structuredClone(state),
          stateAfter: structuredClone(state)
        },
        focus: ['picker', 'search', 'formInput', 'runInput', 'neutral'].map(role => ({
          role,
          selector: selectors[role],
          active: true,
          focusVisible: true,
          outlineStyle: 'solid',
          outlineWidth: '2px',
          outlineColor: tokens.focus.resolved,
          border: tokens.focus.resolved
        })),
        feedback: { neutralHover: tokens.hover.resolved, neutralActive: tokens.active.resolved, primaryHover: tokens.primaryHover.resolved },
        disabled: {
          ...retained(),
          disabled: true,
          ariaDisabled: 'true',
          name: 'Undo',
          reason: 'No history',
          tooltipVisible: true,
          executionRequests: 0,
          activationEvents: 0,
          events: [event('keydown', 'Enter')]
        }
      }
    })
  )
  return { id, facts: { events: [event()], themes } }
}
for (const id of ['HC-STYLE', 'HC-FOCUS']) {
  test(`${id} loaded oracle accepts full synthetic facts only as validator evidence`, () => assert.equal(compact.validateHostControlFacts(hostFacts(id)), true))
  for (const [name, mutate] of [
    [
      'missing facts',
      c => {
        c.facts = {}
      }
    ],
    [
      'missing theme',
      c => {
        c.facts.themes.pop()
      }
    ],
    [
      'duplicate theme',
      c => {
        c.facts.themes[1].scheme = 'light'
      }
    ],
    [
      'untrusted input',
      c => {
        c.facts.events[0].trusted = false
      }
    ],
    [
      'untrusted theme input',
      c => {
        c.facts.themes[0].events[0].trusted = false
      }
    ],
    [
      'missing root token',
      c => {
        delete c.facts.themes[0].style.tokens.background
      }
    ],
    [
      'wrong token identity',
      c => {
        c.facts.themes[0].style.tokens.focus.name = '--invented-focus'
      }
    ],
    [
      'fallback radius disguised as host',
      c => {
        c.facts.themes[0].style.tokens.radiusMd.raw = ''
      }
    ],
    [
      'coherently wrong radius token',
      c => {
        const t = c.facts.themes[0]
        t.style.tokens.radiusMd.resolved = '3px'
        for (const control of Object.values(t.style.controls)) if (control.radius === '12px') control.radius = '3px'
      }
    ],
    [
      'wrong form radius',
      c => {
        c.facts.themes[0].style.controls.formInput.radius = '4px'
      }
    ],
    [
      'wrong icon radius',
      c => {
        c.facts.themes[0].style.controls.neutral.radius = '12px'
      }
    ],
    [
      'native select restored bevel',
      c => {
        c.facts.themes[0].style.controls.picker.appearance = 'auto'
      }
    ],
    [
      'select options lost',
      c => {
        c.facts.themes[0].style.controls.inspectorSelect.options = []
      }
    ],
    [
      'wrong native tag',
      c => {
        c.facts.themes[0].style.controls.formInput.tag = 'DIV'
      }
    ],
    [
      'missing control',
      c => {
        delete c.facts.themes[0].style.controls.portButton
      }
    ],
    [
      'small icon',
      c => {
        c.facts.themes[0].style.controls.primary.width = 32
      }
    ],
    [
      'wrong primary fill',
      c => {
        c.facts.themes[0].style.controls.primary.background = 'rgb(1, 1, 1)'
      }
    ],
    [
      'wrong text button stroke',
      c => {
        c.facts.themes[0].style.controls.textButton.border = 'transparent'
      }
    ],
    [
      'hidden actual textarea',
      c => {
        c.facts.themes[0].style.controls.runInput.visible = false
      }
    ],
    [
      'Inspector absent',
      c => {
        delete c.facts.themes[0].style.selectedNode
      }
    ],
    [
      'lost full state',
      c => {
        delete c.facts.themes[0].after.run
      }
    ],
    [
      'changed exact viewport bytes',
      c => {
        c.facts.themes[0].after.viewport.raw += ' '
      }
    ]
  ])
    test(`${id} rejects ${name}`, () => {
      const c = hostFacts(id)
      mutate(c)
      assert.throws(() => compact.validateHostControlFacts(c))
    })
}
for (const [name, mutate] of [
  [
    'focus absent',
    t => {
      delete t.focus
    }
  ],
  [
    'fake keyboard focus',
    t => {
      t.focus[0].focusVisible = false
    }
  ],
  [
    'transparent ring',
    t => {
      t.focus[1].outlineColor = 'rgba(0, 0, 0, 0)'
    }
  ],
  [
    'missing ring',
    t => {
      t.focus[2].outlineStyle = 'none'
    }
  ],
  [
    'wrong focus border',
    t => {
      t.focus[3].border = 'rgb(180, 180, 180)'
    }
  ],
  [
    'transitional active color',
    t => {
      t.feedback.neutralActive = 'rgb(195, 195, 195)'
    }
  ],
  [
    'primary hover absent',
    t => {
      delete t.feedback.primaryHover
    }
  ],
  [
    'disabled wrong activation request',
    t => {
      t.disabled.executionRequests = 1
    }
  ],
  [
    'disabled wrong activation event',
    t => {
      t.disabled.activationEvents = 1
    }
  ],
  [
    'disabled mislabel',
    t => {
      t.disabled.disabled = false
    }
  ],
  [
    'disabled reason absent',
    t => {
      t.disabled.reason = ''
    }
  ],
  [
    'disabled input untrusted',
    t => {
      t.disabled.events[0].trusted = false
    }
  ],
  [
    'disabled state changed',
    t => {
      t.disabled.after.history.undo = true
    }
  ]
])
  test(`HC-FOCUS rejects ${name}`, () => {
    const c = hostFacts('HC-FOCUS')
    mutate(c.facts.themes[0])
    assert.throws(() => compact.validateHostControlFacts(c))
  })
for (const [name, mutate] of [
  [
    'host collapse missing',
    t => {
      t.sidebar.openCollapsed = false
    }
  ],
  [
    'host click untrusted',
    t => {
      t.sidebar.events[0].trusted = false
    }
  ],
  [
    'inspector handle missing',
    t => {
      t.sidebar.collapsed.toggles = ['toggle-library']
    }
  ],
  [
    'library unmounted by host',
    t => {
      t.sidebar.collapsed.library.mounted = false
    }
  ],
  [
    'inspector hidden by host',
    t => {
      t.sidebar.after.inspector.visible = false
    }
  ],
  [
    'picker duplicated',
    t => {
      t.sidebar.collapsed.picker.count = 2
    }
  ],
  [
    'geometry omitted',
    t => {
      delete t.sidebar.before.bounds
    }
  ],
  [
    'collapsed state missing',
    t => {
      delete t.sidebar.stateCollapsed
    }
  ],
  [
    'host collapse input changed',
    t => {
      t.sidebar.stateCollapsed.inputJson = '{}'
    }
  ]
])
  test(`HC-STYLE rejects ${name}`, () => {
    const c = hostFacts('HC-STYLE')
    mutate(c.facts.themes[0])
    assert.throws(() => compact.validateHostControlFacts(c))
  })
test('host receipt cannot use an old sixteen-case pass or an arbitrary plan ID', () => {
  const before = Date.now(),
    ui = {
      planId: plan,
      wave: 'W2',
      keyRead: false,
      providerCalls: 0,
      nativeClipboardEvidence: false,
      startedAt: new Date(before).toISOString(),
      finishedAt: new Date(before).toISOString(),
      cases: Array.from({ length: 16 }, (_, i) => ({ id: `case-${i}` }))
    }
  const context = { planId: plan, startedAt: before, finishedAt: before, assertions: [] }
  assert.throws(() => compact.validateCompactReceipt(ui, context), /cases missing/)
  assert.throws(() => compact.validateCompactReceipt({ ...ui, planId: 'arbitrary' }, { ...context, planId: 'arbitrary' }), /plan/)
  assert.equal(compact.casesForPlan(plan).length, 18)
})
test('all callable host collectors reject physical symlink escapes before creating or launching', t => {
  const owned = `${root}/docs/validation/blueprint/current/host-controls/w2/source-fixtures-path-${process.pid}-${Date.now()}`
  mkdirSync(owned, { recursive: true })
  const dir = mkdtempSync(join(owned, 'negative-'))
  t.after(() => rmSync(dir, { force: true, recursive: true }))
  const alias = join(dir, 'alias')
  symlinkSync(`${root}/integrations/deepseek-harness/xuanling-blueprint`, alias)
  const dangling = join(dir, 'dangling')
  symlinkSync(join(dir, 'absent-target'), dangling)
  for (const parse of [compact.parseCli, comfy, motion])
    for (const path of [join(alias, 'never-create'), join(dangling, 'never-create')]) assert.throws(() => parse(['--plan-id', plan, '--report-dir', path]))
})
test('host collector registry counts remain aligned with the current public probe contract', async () => {
  const comfyModule = await import('../../../../../test/blueprint/capabilities/comfy-interactions-ui.mjs')
  const motionModule = await import('../../../../../test/blueprint/capabilities/comfy-motion-ui.mjs')
  const canvas = await import('../../../../../test/blueprint/capabilities/canvas-suite.mjs')
  assert.equal(comfyModule.UI_ASSERTIONS.length, 63)
  assert.equal(comfyModule.REQUIRED_ASSERTIONS.length, 118)
  assert.equal(motionModule.MOTION_ASSERTIONS.length, 19)
  assert.equal(motionModule.REQUIRED_ASSERTIONS.length, 74)
  assert.equal(canvas.requiredCanvasAssertions('browser').length, 55)
  assert.equal(canvas.requiredCanvasAssertions('performance').length, 37)
  assert.equal(compact.UX_CASES.length, 16)
})

import { runInNewContext } from 'node:vm'
test('serialized computed-style probe reads actual DOM CSS and host tokens rather than inventing expected values', () => {
  const control = {
    tagName: 'SELECT',
    value: 'awkward.中文',
    options: [{ value: 'awkward.中文', label: '实际选项', disabled: false }],
    getBoundingClientRect: () => ({ ...box }),
    getAttribute: name => (name === 'aria-label' ? 'Real native selector' : null),
    matches: () => false,
    querySelector: () => null,
    checkVisibility: () => true
  }
  const host = { appendChild: () => {} },
    workspace = { querySelectorAll: () => [control], querySelector: () => ({ getAttribute: () => 'gate' }) }
  let referenceRemoved = false
  const document = {
    documentElement: host,
    body: host,
    querySelector: () => workspace,
    createElement: () => ({
      style: {},
      setAttribute: () => {},
      remove: () => {
        referenceRemoved = true
      }
    })
  }
  const getComputedStyle = el =>
    el === host
      ? { getPropertyValue: () => '3px' }
      : el === control
        ? {
            display: 'block',
            visibility: 'visible',
            borderRadius: '3px',
            appearance: 'auto',
            color: 'rgb(11, 12, 13)',
            backgroundColor: 'rgb(100, 101, 102)',
            borderTopColor: 'rgb(70, 71, 72)'
          }
        : { borderRadius: '3px' }
  const facts = runInNewContext(
    `(${compact.hostControlStyleProbe.toString()})({selectors:{picker:'[data-bp-select="blueprint"]'},tokenNames:{radiusMd:'--dsw-radius-md'}})`,
    { document, getComputedStyle }
  )
  assert.equal(referenceRemoved, true)
  assert.equal(facts.tokens.radiusMd.raw, '3px')
  assert.equal(facts.tokens.radiusMd.resolved, '3px')
  assert.equal(facts.controls.picker.radius, '3px')
  assert.equal(facts.controls.picker.appearance, 'auto')
  assert.equal(facts.controls.picker.value, 'awkward.中文')
  assert.equal(facts.controls.picker.options[0].label, '实际选项')
  assert.equal(facts.selectedNode, 'gate')
})
test('real public host-control view preparation clears old pan multiselection with Escape before selecting the only gate', async () => {
  const trace = [],
    open = { preflight: true, run: false },
    state = { selection: ['gate', 'out'], focused: null, inspectorVisible: true }
  const inspector = { checkVisibility: () => state.inspectorVisible, getBoundingClientRect: () => ({ width: 250, height: 300 }) }
  const workspace = { querySelectorAll: () => state.selection.map(id => ({ getAttribute: () => id })), querySelector: () => inspector }
  const document = { querySelector: () => workspace }
  const locator = selector => ({
    count: async () => 1,
    isVisible: async () => !selector.includes('more-menu'),
    getAttribute: async name => (name === 'open' ? (open[selector.includes('preflight') ? 'preflight' : 'run'] ? '' : null) : null),
    locator: child => locator(child),
    waitFor: async options => trace.push(['wait', selector, options]),
    focus: async () => {
      state.focused = selector
      trace.push(['focus', selector])
    },
    scrollIntoViewIfNeeded: async () => trace.push(['scroll', selector]),
    click: async options => {
      assert.equal(options?.force, undefined)
      trace.push(['click', selector])
      if (selector.startsWith('.react-flow__node') && !state.selection.includes('gate')) state.selection.push('gate')
      if (selector.startsWith('summary')) {
        const id = selector.includes('preflight') ? 'preflight' : 'run'
        open[id] = !open[id]
      }
    }
  })
  const page = {
    locator,
    evaluate: () => assert.fail('public view preparation must not mutate DOM by evaluation'),
    keyboard: {
      press: async key => {
        assert.equal(key, 'Escape')
        assert.equal(state.focused, '[data-bp-canvas="surface"]')
        state.selection = []
        trace.push(['key', key])
      }
    },
    waitForFunction: async (fn, ...args) => {
      assert.deepEqual(args, [], 'retain original default wait bound and polling')
      const read = () => Function('document', `return (${fn.toString()})()`)(document)
      assert.equal(read(), true)
      state.selection.push('out')
      assert.equal(read(), false, 'multiselection must not pass the readiness oracle')
      state.selection = []
      assert.equal(read(), false, 'missing selected gate must not pass')
      state.selection = ['gate']
      state.inspectorVisible = false
      assert.equal(read(), false, 'unavailable Inspector must not pass')
      state.inspectorVisible = true
      trace.push(['selection-ready'])
    }
  }
  await compact.prepareHostControlView(page)
  assert.deepEqual(state.selection, ['gate'], 'PUBLIC_ESCAPE_MUST_CLEAR_OLD_PAN_SELECTION')
  assert.deepEqual(trace.slice(0, 4), [
    ['focus', '[data-bp-canvas="surface"]'],
    ['key', 'Escape'],
    ['click', '.react-flow__node[data-id="gate"] .bp-node-title'],
    ['selection-ready']
  ])
  assert.deepEqual(
    trace.filter(t => t[0] === 'click').map(t => t[1]),
    ['.react-flow__node[data-id="gate"] .bp-node-title', 'summary[data-bp-disclosure-toggle="preflight"]', 'summary[data-bp-disclosure-toggle="run"]']
  )
  assert.deepEqual(open, { preflight: false, run: true })
  assert.equal(
    trace.some(t => t[0] === 'wait' && t[1] === '[data-bp-node-inspector="gate"]'),
    true
  )
})

import { spawnSync } from 'node:child_process'
test('all three actual CLI help commands describe host confinement without native launch', () => {
  for (const name of ['compact-ux-ui', 'comfy-interactions-ui', 'comfy-motion-ui']) {
    const script = `${root}/test/blueprint/capabilities/${name}.mjs`
    const run = spawnSync(process.execPath, ['--experimental-transform-types', script, '--help'], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /dsh-blueprint-host-controls-v1/)
    assert.match(run.stdout, /docs\/validation\/blueprint\/current\/host-controls\/w2/)
    assert.match(run.stdout, /--experimental-transform-types/)
    assert.match(run.stdout, /200\/300\/20/)
    assert.match(readFileSync(script, 'utf8'), /reportPathAllowed/)
  }
})

test('serialized host style probe resolves body themed aliases absent on html while inheriting radius tokens', () => {
  for (const dark of [false, true]) {
    let parent = null,
      removed = false
    const rootTokens = { '--dsw-radius-md': '12px' }
    const bodyTokens = { ...rootTokens, '--dsw-alias-button-primary-fill': dark ? 'rgb(30, 90, 230)' : 'rgb(0, 60, 220)' }
    const html = {
      appendChild: () => {
        parent = 'HTML'
      }
    }
    const body = {
      tagName: 'BODY',
      appendChild: () => {
        parent = 'BODY'
      },
      hasAttribute: () => dark,
      getAttribute: () => (dark ? '' : null)
    }
    const workspace = { querySelectorAll: () => [], querySelector: () => null }
    const document = {
      documentElement: html,
      body,
      querySelector: () => workspace,
      createElement: () => ({
        style: {},
        setAttribute: () => {},
        remove: () => {
          removed = true
        }
      })
    }
    const getComputedStyle = el =>
      el === html
        ? { getPropertyValue: key => rootTokens[key] ?? '' }
        : el === body
          ? { getPropertyValue: key => bodyTokens[key] ?? '' }
          : { borderRadius: parent === 'BODY' ? '12px' : '12px', color: parent === 'BODY' ? bodyTokens['--dsw-alias-button-primary-fill'] : 'rgb(0, 0, 0)' }
    assert.equal(getComputedStyle(html).getPropertyValue('--dsw-alias-button-primary-fill'), '')
    const facts = runInNewContext(`(${compact.hostControlStyleProbe.toString()})(arg)`, {
      document,
      getComputedStyle,
      arg: { selectors: {}, tokenNames: { radiusMd: '--dsw-radius-md', primary: '--dsw-alias-button-primary-fill' } }
    })
    assert.equal(facts.tokens.primary.raw, bodyTokens['--dsw-alias-button-primary-fill'], 'BODY_THEME_ALIAS_RAW_REQUIRED')
    assert.equal(facts.tokens.primary.resolved, bodyTokens['--dsw-alias-button-primary-fill'], 'BODY_THEME_COLOR_RESOLUTION_REQUIRED')
    assert.equal(facts.tokens.radiusMd.raw, '12px')
    assert.equal(facts.tokens.radiusMd.resolved, '12px')
    assert.equal(parent, 'BODY')
    assert.equal(removed, true)
  }
})

test('compact portButton role accepts actual 8px while textButton stays 12px and wrong port 12px fails', () => {
  const c = hostFacts('HC-STYLE')
  assert.equal(c.facts.themes[0].style.controls.portButton.radius, '8px')
  assert.equal(c.facts.themes[0].style.controls.textButton.radius, '12px')
  assert.equal(compact.validateHostControlFacts(c), true)
  c.facts.themes[0].style.controls.portButton.radius = '12px'
  assert.throws(() => compact.validateHostControlFacts(c), /wrong radius: portButton/)
})

import { stringifyProbeEvidence, redactProbeEvidenceText } from '../../../../../test/blueprint/capabilities/probe-evidence.mjs'
function stageHarness({ sampleFails = false, screenshotFails = false } = {}) {
  const writes = new Map(),
    dir = `${root}/docs/validation/blueprint/current/host-controls/w2/source-fixtures-stage-virtual`,
    ui = { planId: plan, phase: 'HC-STYLE' }
  const pixels = Buffer.from('SYNTHETIC screenshot bytes for diagnostic code only')
  let samples = 0,
    screenshots = 0
  // Execute the loaded function with an in-memory file boundary. No source
  // fixture directory, native report or screenshot is created by this test.
  const observe = Function(
    'reportPathAllowed',
    'ensure',
    'join',
    'stringifyProbeEvidence',
    'writeFileSync',
    'hostControlStyleProbe',
    'HOST_CONTROL_SELECTORS',
    'HOST_STYLE_TOKENS',
    'redactProbeEvidenceText',
    'sha256',
    'readFileSync',
    `return (${compact.observeHostControlStage.toString()})`
  )(
    entry.reportPathAllowed,
    (ok, why) => assert.ok(ok, why),
    join,
    stringifyProbeEvidence,
    (path, bytes) => {
      assert.ok(path.startsWith(dir + '/'))
      writes.set(path, bytes)
    },
    compact.hostControlStyleProbe,
    compact.HOST_CONTROL_SELECTORS,
    compact.HOST_STYLE_TOKENS,
    redactProbeEvidenceText,
    compact.sha256,
    path => writes.get(path)
  )
  const page = {
    evaluate: async (fn, args) => {
      assert.equal(fn, compact.hostControlStyleProbe)
      assert.equal(args.tokenNames, compact.HOST_STYLE_TOKENS)
      samples++
      if (sampleFails) throw Error('controlled unavailable passive sample')
      return { sampleNumber: samples, tokens: { primary: { raw: 'body alias', resolved: samples === 1 ? 'rgb(0, 0, 0)' : 'rgb(10, 20, 30)' } } }
    },
    screenshot: async options => {
      assert.deepEqual(Object.keys(options).sort(), ['fullPage', 'path'])
      assert.equal(options.fullPage, true)
      assert.ok(options.path.startsWith(dir + '/'))
      screenshots++
      if (screenshotFails) throw Error('controlled screenshot failure')
      writes.set(options.path, pixels)
    }
  }
  return {
    observe,
    page,
    ui,
    dir,
    writes,
    stats: () => ({ samples, screenshots }),
    options: { ui, dir, stage: 'baseline-primary-fill', locale: 'zh', scheme: 'light' }
  }
}
test('HC stage diagnostics persist pre-wait sample and original failure plus passive actual sample and screenshot hash', async () => {
  const f = stageHarness(),
    timeout = Error('controlled original 15s timeout')
  timeout.name = 'TimeoutError'
  await assert.rejects(
    f.observe(f.page, f.options, async () => {
      const pending = JSON.parse(f.writes.get(join(f.dir, 'host-control-stage-1.json')))
      assert.equal(pending.status, 'pending')
      assert.equal(pending.before.style.sampleNumber, 1)
      assert.equal(JSON.parse(f.writes.get(join(f.dir, 'compact-ux-evidence.json'))).hostControlStages[0].stage, 'baseline-primary-fill')
      throw timeout
    }),
    error => error === timeout
  )
  const receipt = JSON.parse(f.writes.get(join(f.dir, 'host-control-stage-1.json')))
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.failure.name, 'TimeoutError')
  assert.equal(receipt.failure.message, timeout.message)
  assert.equal(receipt.before.style.tokens.primary.resolved, 'rgb(0, 0, 0)')
  assert.equal(receipt.after.style.tokens.primary.resolved, 'rgb(10, 20, 30)')
  assert.equal(receipt.screenshot.sha256, compact.sha256(f.writes.get(receipt.screenshot.path)))
  assert.deepEqual(f.stats(), { samples: 2, screenshots: 1 })
})
test('HC stage diagnostics cannot replace the original rejection when passive sampling or screenshot fails', async () => {
  const f = stageHarness({ sampleFails: true, screenshotFails: true }),
    original = Error('original focus failure')
  await assert.rejects(
    f.observe(f.page, f.options, async () => {
      throw original
    }),
    error => error === original
  )
  const receipt = JSON.parse(f.writes.get(join(f.dir, 'host-control-stage-1.json')))
  assert.equal(receipt.failure.message, original.message)
  assert.equal(receipt.before, null)
  assert.equal(receipt.after, null)
  assert.deepEqual(
    receipt.diagnosticErrors.map(item => item.kind),
    ['sample', 'sample', 'screenshot']
  )
})
test('HC stage diagnostics retain successful result with no screenshot and reject unconstrained report before observation', async () => {
  const f = stageHarness(),
    result = { strict: 'unchanged operation result' }
  assert.equal(await f.observe(f.page, f.options, async () => result), result)
  const receipt = JSON.parse(f.writes.get(join(f.dir, 'host-control-stage-1.json')))
  assert.equal(receipt.status, 'complete')
  assert.equal(receipt.before.style.sampleNumber, 1)
  assert.equal(receipt.after.style.sampleNumber, 2)
  assert.deepEqual(f.stats(), { samples: 2, screenshots: 0 })
  await assert.rejects(
    f.observe(f.page, { ...f.options, dir: '/tmp/unconfined' }, async () => assert.fail('unconfined diagnostic operation')),
    /confined/
  )
  assert.deepEqual(f.stats(), { samples: 2, screenshots: 0 })
})

test('actual loaded caseRun persists complete pending facts before strict validation and retains them on rejection', async () => {
  const source = compact.runCompactJourney.toString(),
    start = source.indexOf('const caseRun ='),
    end = source.indexOf('const boundsFacts =', start)
  assert.ok(start >= 0 && end > start)
  for (const valid of [false, true]) {
    const ui = { cases: [] },
      events = [],
      saved = [],
      recorded = []
    const facts = hostFacts('HC-STYLE').facts
    if (!valid)
      for (const theme of facts.themes) {
        theme.before.selection.push('source')
        theme.after.selection.push('source')
      }
    const caseRun = Function(
      'casesForPlan',
      'planId',
      'events',
      'ui',
      'save',
      'page',
      'HOST_CONTROL_CASES',
      'validateHostControlFacts',
      'validateCompactCase',
      'record',
      `${source.slice(start, end)}; return caseRun`
    )(
      compact.casesForPlan,
      plan,
      events,
      ui,
      () => saved.push(JSON.parse(stringifyProbeEvidence(ui))),
      { evaluate: async fn => fn() },
      compact.HOST_CONTROL_CASES,
      c => {
        assert.ok(saved.at(-1).pendingCase, 'ACTUAL_PENDING_CASE_MUST_BE_SAVED_BEFORE_VALIDATION')
        assert.deepEqual(saved.at(-1).pendingCase.facts, facts, 'ACTUAL_FACTS_MUST_BE_SAVED_BEFORE_VALIDATION')
        return compact.validateHostControlFacts(c)
      },
      compact.validateCompactCase,
      (...args) => recorded.push(args)
    )
    const operation = async () => {
      events.push(event())
      return facts
    }
    if (valid) {
      assert.equal((await caseRun('HC-STYLE', operation)).passed, true)
      assert.equal(Object.hasOwn(ui, 'pendingCase'), false)
      assert.equal(Object.hasOwn(saved.at(-1), 'pendingCase'), false)
      assert.equal(ui.cases.length, 1)
      assert.equal(recorded.length, 1)
    } else {
      await assert.rejects(caseRun('HC-STYLE', operation), /actual gate Inspector\/selection missing/)
      assert.equal(ui.pendingCase.facts, facts)
      assert.deepEqual(saved.at(-1).pendingCase.facts, facts)
      assert.equal(ui.cases.length, 0)
      assert.equal(recorded.length, 0)
    }
  }
})
