// These tests prove collector fail-closed behavior, never mounted/provider acceptance.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import * as collector from '../../../../../test/blueprint/capabilities/comfy-motion-ui.mjs'
import { HOST_CONTROLS_PLAN_ID, reportPathAllowed, closePublicMore, prepareRunInput } from '../../../../../test/blueprint/capabilities/compact-ui-entry.mjs'
import { projectRuntimeMotion } from '../../src/client/runtime-motion.ts'
import { BLUEPRINT_INVOCATIONS, BLUEPRINT_PACKAGE } from '../../src/typert-descriptors.ts'
import { en, zh } from '../../src/client/locales.ts'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import { GraphEditor } from '../../src/client/graph-editor.ts'
import { resolveCanvasShortcut } from '../../src/client/command-policy.ts'
import { getHandlePosition, Position } from '@xyflow/system'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const TEST_PLAN_ID = process.env.BP_COLLECTOR_PLAN_ID ?? HOST_CONTROLS_PLAN_ID
const OWN =
  process.env.BP_COLLECTOR_TEST_REPORT_DIR ??
  join(ROOT, `docs/validation/blueprint/current/host-controls/w2/source-fixtures-motion-${process.pid}-${Date.now()}`)
assert.equal(TEST_PLAN_ID, HOST_CONTROLS_PLAN_ID, 'this source run requires the current host-controls plan')
assert.ok(reportPathAllowed(TEST_PLAN_ID, 'motion', OWN), 'source fixtures require a physically confined host-controls W2 path')
assert.match(OWN.slice(join(ROOT, 'docs/validation/blueprint/current/host-controls/w2').length + 1), /^source-fixtures-[^/]+(?:\/|$)/)
collector.parseCli(['--plan-id', TEST_PLAN_ID, '--report-dir', OWN])
const HERE = join(ROOT, 'test/blueprint/capabilities')
test('W3 loaded collector exposes an evidence oracle for actual motion frames and invariants', () => {
  assert.equal(typeof collector.validateMotionCase, 'function', 'W3_MOTION_EVIDENCE_ORACLE_MISSING')
})
function motionCase(id) {
  const definition = collector.motionDefinition(id === 'CM-REROUTED' ? 'motion-routed' : 'motion-ui', id === 'CM-REROUTED')
  const host = {
    blueprintId: definition.id,
    semanticRevision: 'actual-schema-unit-semantic',
    documentRevision: 'actual-schema-unit-document',
    definitionJson: JSON.stringify(definition)
  }
  const mode =
    {
      'CM-LATEST-ORDINAL': 'ordinal',
      'CM-LATEST-TIE': 'tie',
      'CM-STALE': 'stale',
      'CM-UNKNOWN': 'unknown',
      'CM-UNKNOWN-PATH': 'unknown-path',
      'CM-WAITING': 'waiting',
      'CM-TERMINAL': 'terminal'
    }[id] ?? 'active'
  const raw = collector.motionSnapshot(host, mode),
    hidden = id === 'CM-HIDDEN',
    reduced = id === 'CM-REDUCED',
    off = id === 'CM-OFF',
    disconnected = id === 'CM-DISCONNECTED'
  const hoveredNodeId = id === 'CM-HOVER' ? 'source' : null,
    focusedNodeId = id === 'CM-FOCUS' ? 'source' : null
  const p = projectRuntimeMotion({
    nodes: definition.graph.nodes,
    edges: definition.graph.edges,
    snapshot: raw,
    overlayEligible: mode !== 'stale',
    visible: !hidden,
    reducedMotion: reduced,
    userMotion: off ? 'off' : 'on',
    connectionState: disconnected ? 'stale' : 'connected',
    hoveredNodeId,
    focusedNodeId
  })
  const handles = []
  const edges = p.edges.map((e, i) => {
    const logical = definition.graph.edges[i],
      from = logical.from.split(/[.@]/)[0],
      to = logical.to.split('.')[0],
      kind = logical.kind
    const fromPort = kind === 'data' ? logical.from.slice(logical.from.indexOf('.') + 1) : (logical.from.split('@')[1] ?? 'control'),
      toPort = kind === 'data' ? 'value' : 'control'
    handles.push(
      { id: `${from}:${kind}:${fromPort}`, direction: 'out', position: Position.Right, rect: { x: -5, y: i * 200 - 5, width: 10, height: 10 } },
      { id: `${to}:${kind}:${toPort}`, direction: 'in', position: Position.Left, rect: { x: 195, y: i * 200 - 5, width: 10, height: 10 } }
    )
    const d = i === 0 && id === 'CM-REROUTED' ? 'M 5 0 L 330 180 L 380 180 L 195 0' : `M 5 ${i * 200} L 195 ${i * 200}`
    return {
      id: `edge-${i}`,
      motion: e.motion,
      related: String(e.related),
      d,
      lightD: e.motion === 'pulse' ? d : null,
      dashOffset: e.motion === 'pulse' ? -0.1 : null,
      pathLength: e.motion === 'pulse' ? 1 : null,
      dashArray: e.motion === 'pulse' ? '0 2' : null,
      phase: e.motion === 'pulse' ? 0.1 : null,
      length: 190,
      start: { x: 5, y: i * 200 },
      end: { x: 195, y: i * 200 }
    }
  })
  const keyframes = [
    { offset: 0, strokeDashoffset: '0', opacity: null },
    { offset: 1, strokeDashoffset: '-1', opacity: null }
  ]
  const animations = edges
    .filter(e => e.motion === 'pulse')
    .map(e => ({
      edgeId: e.id,
      nodeId: null,
      name: 'bp-directed-light',
      currentTime: 180,
      playState: 'running',
      duration: 1800,
      iterations: 'Infinity',
      direction: 'normal',
      progress: 0.1,
      keyframes
    }))
  for (const node of p.nodes.filter(n => n.motion === 'pulse'))
    animations.push({
      edgeId: null,
      nodeId: node.nodeId,
      name: 'bp-node-emphasis',
      currentTime: 180,
      playState: 'running',
      duration: 1800,
      iterations: 'Infinity',
      direction: 'normal',
      progress: 0.1,
      keyframes: [
        { offset: 0, opacity: '0.2', strokeDashoffset: null },
        { offset: 0.5, opacity: '0.8', strokeDashoffset: null },
        { offset: 1, opacity: '0.2', strokeDashoffset: null }
      ]
    })
  const events = [
    { type: 'visibilitychange', state: 'hidden', trusted: true },
    ...(!hidden ? [{ type: 'visibilitychange', state: 'visible', trusted: true }] : []),
    ...(disconnected ? [{ type: 'offline', trusted: true }] : []),
    ...(hoveredNodeId ? [{ type: 'pointerover', nodeId: 'source', trusted: true }] : []),
    ...(focusedNodeId ? [{ type: 'focusin', nodeId: 'source', trusted: true }] : [])
  ]
  const dom = {
    id: definition.id,
    runId: raw.runId,
    visible: String(!hidden),
    actualHidden: hidden,
    reduced: String(reduced),
    actualReduced: reduced,
    userMotion: off ? 'off' : 'on',
    loops: String(p.loopsAllowed),
    overlayEligible: mode !== 'stale',
    connection: disconnected ? 'stale' : 'connected',
    hoveredNodeId,
    focusedNodeId,
    timeline: 1000,
    nodes: p.nodes.map(n => ({
      id: n.nodeId,
      state: n.state,
      motion: n.motion,
      relation: n.relation,
      caption: n.state === 'idle' ? en['node.notRunning'] : n.state === 'unknown' ? en['node.unknownState'] : en[`state.${n.state}`],
      opacity: n.motion === 'pulse' ? 0.2 : null
    })),
    edges,
    animations,
    runningLoops: animations.length,
    events,
    history: { undo: false, redo: false, dirty: 'false' },
    geometry: {
      nodes: definition.graph.nodes.map(n => ({ id: n.id, rect: { x: 0, y: 0, width: 220, height: 240 } })),
      handles,
      viewport: 'translate(0px,0px) scale(1)'
    }
  }
  const before = { definition, host, dom },
    after = structuredClone(before),
    facts = { before, after, raw, locale: 'en' }
  if (hoveredNodeId || focusedNodeId) {
    facts[hoveredNodeId ? 'hoveredNodeId' : 'focusedNodeId'] = 'source'
    facts.offDom = structuredClone(dom)
    facts.offDom.userMotion = 'off'
    facts.offDom.loops = 'false'
    facts.offDom.animations = []
    facts.offDom.runningLoops = 0
    for (const n of facts.offDom.nodes) {
      n.motion = 'static'
      n.opacity = null
    }
    for (const e of facts.offDom.edges) {
      e.motion = 'static'
      e.lightD = null
    }
  }
  if (['CM-DIRECTED', 'CM-REROUTED', 'CM-ACTIVE-NODE', 'CM-VISIBLE'].includes(id)) {
    facts.frames = [structuredClone(dom), structuredClone(dom)]
    const second = facts.frames[1]
    second.timeline += 180
    for (const a of second.animations) {
      a.currentTime += 180
      a.progress += 0.1
    }
    for (const e of second.edges)
      if (e.motion === 'pulse') {
        e.dashOffset = -0.2
        e.phase = 0.2
      }
    for (const n of second.nodes) if (n.motion === 'pulse') n.opacity = 0.6
    facts.screenshots = [{ sha256: '1'.repeat(64) }, { sha256: '2'.repeat(64) }]
  }
  return { id, description: `synthetic fail-closed oracle ${id}; never native acceptance`, passed: true, facts }
}
for (const id of collector.MOTION_ASSERTIONS ?? [])
  test(`motion oracle accepts bounded actual-DTO witness ${id}`, () => assert.equal(collector.validateMotionCase(motionCase(id)), true))
test('native XYFlow side midpoint endpoints pass the production collector oracle while center endpoints remain rejected', () => {
  const c = motionCase('CM-DIRECTED'),
    node = { internals: { positionAbsolute: { x: 0, y: 0 } } }
  for (const dom of [c.facts.before.dom, c.facts.after.dom, ...c.facts.frames]) {
    for (const h of dom.geometry.handles) h.position = h.direction === 'out' ? Position.Right : Position.Left
    for (const edge of dom.edges) {
      const index = Number(edge.id.split('-')[1]),
        source = dom.geometry.handles[index * 2],
        target = dom.geometry.handles[index * 2 + 1]
      edge.start = getHandlePosition(node, { ...source.rect, position: source.position })
      edge.end = getHandlePosition(node, { ...target.rect, position: target.position })
      edge.d = `M ${edge.start.x} ${edge.start.y} L ${edge.end.x} ${edge.end.y}`
      if (edge.lightD !== null) edge.lightD = edge.d
    }
  }
  assert.doesNotThrow(() => collector.validateMotionCase(c), 'ACTUAL_XYFLOW_SIDE_ENDPOINTS_MUST_PASS_UNCHANGED_ONE_PX_ORACLE')
  c.facts.frames[0].edges[0].start.x -= 5
  assert.throws(() => collector.validateMotionCase(c), /named handle/)
})
test('native focus discovery checks current focus and uses only genuinely unbound Shift Tab traversal', async () => {
  const source = readFileSync(join(HERE, 'comfy-motion-ui.mjs'), 'utf8'),
    start = source.indexOf('const focusSource = async'),
    end = source.indexOf('\n  try {', start)
  const discover = Function('page', 'closePublicMore', 'prepareRunInput', `${source.slice(start, end)}; return focusSource`)
  for (const alreadyFocused of [false, true]) {
    let focused = alreadyFocused
    const keys = []
    const page = {
      locator: selector => ({
        isVisible: async () => false,
        count: async () => 1,
        getAttribute: async name => {
          assert.equal(name, 'open')
          assert.equal(selector, 'details[data-bp-disclosure="run"]')
          return ''
        },
        waitFor: async options => {
          assert.equal(selector, '[data-bp-run-input]')
          assert.deepEqual(options, { state: 'visible' })
        }
      }),
      evaluate: async () => focused,
      keyboard: {
        press: async chord => {
          const policy = resolveCanvasShortcut(
            { key: 'Tab', shiftKey: chord === 'Shift+Tab' },
            { canvasFocused: true, hasDefinition: true, busy: false, canvasLocked: false }
          )
          assert.equal(policy.kind, 'ignored', 'FOCUS_TRAVERSAL_MUST_NOT_OPEN_ACCEPTED_TAB_SEARCH')
          assert.equal(policy.reason, 'unbound')
          keys.push(chord)
          focused = true
        }
      }
    }
    await discover(page, closePublicMore, prepareRunInput)()
    assert.deepEqual(keys, alreadyFocused ? [] : ['Shift+Tab'])
  }
})
test('installed DSH RPC codec accepts only the actual motion route response correlated to its request', async () => {
  const installed = readFileSync(join(ROOT, 'test/blueprint/node_modules/@deepseek-ai/dsh-client-connection/lib/client.browser.js'), 'utf8')
  assert.equal(installed.split('return module.exports;').length, 2)
  let client
  // Expose the installed private caller in memory; its codec/correlation code is unchanged.
  runInNewContext(installed.replace('return module.exports;', 'return { ...module.exports, createWebConnectionRpc };'), {
    window: {
      __ModuleLoader__: {
        load: entry => {
          client = entry.factory()
        }
      }
    },
    crypto: globalThis.crypto
  })
  assert.equal(typeof client.createWebConnectionRpc, 'function')
  const source = readFileSync(join(HERE, 'comfy-motion-ui.mjs'), 'utf8'),
    start = source.indexOf('const transport = async route'),
    end = source.indexOf('\n  await page.route(', start)
  assert.ok(start >= 0 && end > start)
  const setup = new Function(
    'host',
    'raw',
    'requestArgs',
    'methodOf',
    'ensure',
    'BLUEPRINT_INVOCATIONS',
    'receipt',
    `const disconnected = false; ${source.slice(start, end)}; return transport`
  )
  const { host } = motionCase('CM-DIRECTED').facts.before,
    raw = collector.motionSnapshot(host),
    receipt = { transport: [] }
  const handler = setup(
    host,
    raw,
    request => request.postDataJSON().payload.args,
    request => new URL(request.url()).pathname.split('/').at(-1),
    (ok, message) => assert.ok(ok, message),
    BLUEPRINT_INVOCATIONS,
    receipt
  )
  for (const method of ['startRun', 'inspectRun']) {
    const args = method === 'startRun' ? { blueprintId: host.blueprintId, expectedRevision: host.documentRevision } : { runId: raw.runId }
    const expected = method === 'startRun' ? { runId: raw.runId, semanticRevision: host.semanticRevision, state: raw.state, replayed: false } : raw
    for (const variant of ['missing', 'wrong-type', 'missing-id', 'wrong-id', 'proper']) {
      const rpc = client.createWebConnectionRpc(async (input, init) => {
        const body = JSON.parse(init.body)
        let fulfilled
        await handler({
          request: () => ({ url: () => `http://127.0.0.1:3080/${input}`, method: () => init.method, postDataJSON: () => body }),
          fulfill: async response => {
            fulfilled = response
          },
          continue: () => assert.fail('real RPC forwarding forbidden'),
          abort: () => assert.fail('unexpected abort')
        })
        const envelope = structuredClone(fulfilled.json)
        if (variant === 'missing') {
          delete envelope.type
          delete envelope.rpcId
        }
        if (variant === 'wrong-type') envelope.type = 'client-request'
        if (variant === 'missing-id') delete envelope.rpcId
        if (variant === 'wrong-id') {
          envelope.type = 'server-response'
          envelope.rpcId = 'different-request'
        }
        return new Response(JSON.stringify(envelope), { status: fulfilled.status, headers: { 'content-type': fulfilled.contentType } })
      })
      const call = rpc.call('/api', `blueprint/${method}`, { args })
      if (variant === 'proper')
        assert.equal(JSON.stringify(await call), JSON.stringify({ ok: true, value: expected }), 'ACTUAL_DSH_CODEC_MUST_ACCEPT_CORRELATED_MOTION_ENVELOPE')
      else await assert.rejects(call, /invalid server-response envelope|rpcId mismatch/)
    }
  }
})
for (const [name, mutate] of [
  [
    'whole document change',
    c => {
      c.facts.after.definition.name = 'unrelated edit'
    }
  ],
  [
    'full Host revision change',
    c => {
      c.facts.after.host.documentRevision = 'new'
    }
  ],
  [
    'history mutation',
    c => {
      c.facts.after.dom.history.undo = true
    }
  ],
  [
    'handle drift',
    c => {
      c.facts.after.dom.geometry.handles[0].rect.x++
    }
  ],
  [
    'geometry drift',
    c => {
      c.facts.frames[1].geometry.nodes[0].rect.x++
    }
  ],
  [
    'stopped timeline',
    c => {
      c.facts.frames[1].timeline = c.facts.frames[0].timeline
    }
  ],
  [
    'stopped currentTime',
    c => {
      c.facts.frames[1].animations[0].currentTime = c.facts.frames[0].animations[0].currentTime
    }
  ],
  [
    'wrong directed path',
    c => {
      c.facts.frames[0].edges[0].lightD = 'M 1 1 L 2 2'
    }
  ],
  [
    'reverse dash direction',
    c => {
      c.facts.frames[0].animations[0].keyframes.reverse()
    }
  ],
  [
    'missing emphasis opacity',
    c => {
      c.facts.frames[1].nodes.find(n => n.id === 'target').opacity = null
    }
  ],
  [
    'identical screenshots',
    c => {
      c.facts.screenshots[1].sha256 = c.facts.screenshots[0].sha256
    }
  ],
  [
    'wrong caption',
    c => {
      c.facts.after.dom.nodes.find(n => n.id === 'target').caption = 'translated string controls running'
    }
  ],
  [
    'invented branch DTO',
    c => {
      c.facts.raw.attempts[0].branch = 'yes'
    }
  ],
  [
    'wrong normalized dash period',
    c => {
      c.facts.frames[0].edges[0].dashArray = '0 1'
    }
  ]
])
  test(`motion oracle rejects ${name}`, () => {
    const c = motionCase('CM-DIRECTED')
    mutate(c)
    assert.throws(() => collector.validateMotionCase(c))
  })
for (const [id, mutate] of [
  [
    'CM-HIDDEN',
    c => {
      c.facts.after.dom.events.at(-1).trusted = false
    }
  ],
  [
    'CM-VISIBLE',
    c => {
      c.facts.after.dom.events = [{ type: 'visibilitychange', state: 'visible', trusted: true }]
    }
  ],
  [
    'CM-DISCONNECTED',
    c => {
      c.facts.after.dom.events = []
    }
  ],
  [
    'CM-OFF',
    c => {
      c.facts.after.dom.runningLoops = 1
    }
  ],
  [
    'CM-REDUCED',
    c => {
      c.facts.after.dom.actualReduced = false
    }
  ],
  [
    'CM-STALE',
    c => {
      c.facts.after.dom.overlayEligible = true
    }
  ],
  [
    'CM-FOCUS',
    c => {
      c.facts.offDom.nodes.find(n => n.id === 'source').relation = 'none'
    }
  ],
  [
    'CM-LATEST-ORDINAL',
    c => {
      c.facts.after.dom.nodes.find(n => n.id === 'target').state = 'running'
    }
  ],
  [
    'CM-UNKNOWN-PATH',
    c => {
      c.facts.after.dom.edges[1].motion = 'pulse'
    }
  ]
])
  test(`motion oracle rejects lost specific witness ${id}`, () => {
    const c = motionCase(id)
    mutate(c)
    assert.throws(() => collector.validateMotionCase(c))
  })

function fixture(t) {
  mkdirSync(OWN, { recursive: true })
  const dir = mkdtempSync(join(OWN, 'synthetic-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const now = Date.now(),
    at = new Date(now).toISOString(),
    tools = join(dir, 'tools')
  mkdirSync(tools)
  const nested = { passed: true, plan_id: TEST_PLAN_ID },
    nestedPath = join(tools, 'report.json')
  writeFileSync(nestedPath, JSON.stringify(nested))
  // Header bytes are synthetic validation inputs; no screenshot/native claim.
  let imageIndex = 0
  const image = () => {
    const bytes = Buffer.alloc(25)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
    bytes.writeUInt32BE(1700, 16)
    bytes.writeUInt32BE(1100, 20)
    bytes[24] = imageIndex++
    const path = join(dir, `unit-${imageIndex}.png`)
    writeFileSync(path, bytes)
    return { screenshot: path, sha256: collector.sha256(bytes), provenance: 'actual Playwright native Edge screenshot' }
  }
  const cases = collector.MOTION_ASSERTIONS.map(id => {
    const c = motionCase(id)
    c.at = at
    if (c.facts.screenshots) c.facts.screenshots = [image(), image()]
    return c
  })
  const tempRoot = '/tmp/xuanling-bp-probe-unit',
    profile = join(tempRoot, 'motion-edge-unit')
  const rpcId = 'unit-ui-start',
    raw = cases[0].facts.raw
  const receipt = {
    planId: TEST_PLAN_ID,
    wave: 'W3',
    startedAt: at,
    finishedAt: at,
    keyRead: false,
    providerCalls: 0,
    providerEvidence: false,
    effectEvidence: false,
    fixtureScope: 'UI-only motion rendering',
    cases,
    rpc: [{ method: 'loadDefinition', status: 200, ok: true, at, provenance: 'real DSH gateway' }],
    requests: [
      { method: 'startRun', rpcId },
      { method: 'inspectRun', rpcId: 'unit-ui-inspect' }
    ],
    transport: [
      {
        method: 'startRun',
        rpcId,
        at,
        scope: 'UI-only',
        providerEvidence: false,
        effectEvidence: false,
        result: { runId: raw.runId, semanticRevision: raw.definitionRevision, state: 'running', replayed: false }
      },
      { method: 'inspectRun', rpcId: 'unit-ui-inspect', at, scope: 'UI-only', providerEvidence: false, effectEvidence: false, result: raw }
    ],
    themes: ['zh', 'en'].flatMap(locale =>
      ['light', 'dark'].map(scheme => {
        const state = structuredClone(cases.find(c => c.id === 'CM-THEMES').facts.before),
          dictionary = locale === 'zh' ? zh : en
        for (const node of state.dom.nodes) node.caption = dictionary[`state.${node.state}`]
        return { locale, scheme, state, width: 1700, height: 1100, overflow: false, ...image() }
      })
    )
  }
  for (const entry of receipt.transport)
    entry.response = { status: 200, body: { type: 'server-response', rpcId: entry.rpcId, result: { ok: true, value: entry.result } } }
  const report = {
    plan_id: TEST_PLAN_ID,
    passed: true,
    started_at: at,
    finished_at: at,
    assertions: collector.REQUIRED_ASSERTIONS.map(id => ({ id, description: cases.find(c => c.id === id)?.description ?? id, passed: true })),
    environment: {
      canvas_test: 'browser',
      temp_root: tempRoot,
      platform: 'darwin/arm64',
      node: process.version,
      dsh_version_output: '0.2.1-alpha.1',
      browser_version: 'unit-browser'
    },
    artifacts: {
      sidebar_screenshot: image().screenshot,
      host_tools_contract: { status: 0, reportPath: nestedPath, report: nested },
      plugin_source: Object.fromEntries(
        ['lib/index.js', 'lib/client.js', 'lib/typert.host.js'].map(p => [
          p,
          collector.sha256(readFileSync(join(ROOT, 'integrations/deepseek-harness/xuanling-blueprint', p)))
        ])
      ),
      auth_cookie_set: true,
      index_has_boot: true,
      client_bundle: { status: 200, closure: true },
      boot_entries: [{ id: BLUEPRINT_PACKAGE }],
      canvas_journey: { provenance: 'real DSH boot graph synthetic oracle input, never mounted', binding: ['unit-binding'], comfyMotion: receipt },
      motion_browser: {
        kind: 'owned native Edge CDP',
        noDefaults: true,
        defaultContext: true,
        closed: true,
        profileRemoved: true,
        pid: 123,
        profile,
        args: ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`]
      }
    }
  }
  const fingerprint = { revision: '1'.repeat(40), source_sha256: '2'.repeat(64), artifact_sha256: '3'.repeat(64) },
    provenance = {
      planId: TEST_PLAN_ID,
      probeSha256: '4'.repeat(64),
      adapterSha256: '5'.repeat(64),
      collectorSha256: '6'.repeat(64),
      entrySha256: collector.sha256(readFileSync(join(HERE, 'compact-ui-entry.mjs'))),
      canvasJourneySha256: collector.sha256(readFileSync(join(HERE, 'canvas-journey.mjs'))),
      performanceBudget: collector.PERFORMANCE_BUDGET,
      keyRead: false,
      providerCalls: 0
    }
  return {
    dir,
    report,
    receipt,
    context: {
      planId: TEST_PLAN_ID,
      reportDir: dir,
      invokedAt: now - 1,
      finishedAt: now + 1,
      processResult: { status: 0 },
      fingerprint,
      fingerprintAfter: structuredClone(fingerprint),
      provenance,
      expectedProvenance: structuredClone(provenance)
    }
  }
}
test('fresh synthetic final gate accepts complete original Host/browser and motion witnesses without native claim', t => {
  const f = fixture(t)
  assert.equal(collector.validateCollectorGate(f.report, f.context).ok, true)
})
test('final motion gate rejects missing or uncorrelated full responses despite valid result DTOs', t => {
  const f = fixture(t),
    baseline = structuredClone(f.receipt.transport)
  for (const entry of baseline)
    entry.response = { status: 200, body: { type: 'server-response', rpcId: entry.rpcId, result: { ok: true, value: entry.result } } }
  for (const mutate of [
    entry => {
      delete entry.response
    },
    entry => {
      delete entry.response.body.type
    },
    entry => {
      entry.response.body.type = 'client-request'
    },
    entry => {
      delete entry.response.body.rpcId
    },
    entry => {
      entry.response.body.rpcId = 'other-request'
    },
    entry => {
      entry.response.body.result.value = {}
    }
  ]) {
    f.receipt.transport = structuredClone(baseline)
    mutate(f.receipt.transport[0])
    assert.throws(() => collector.validateCollectorGate(f.report, f.context), /transport/, 'FULL_RESPONSE_CORRELATION_MUST_BE_VALIDATED')
  }
})
for (const [name, mutate] of [
  [
    'bad subprocess',
    f => {
      f.context.processResult.status = 1
    }
  ],
  [
    'absent subprocess',
    f => {
      f.context.processResult.status = null
    }
  ],
  [
    'subprocess error',
    f => {
      f.context.processResult.error = { code: 'ENOENT' }
    }
  ],
  [
    'source changed',
    f => {
      f.context.fingerprintAfter.source_sha256 = '9'.repeat(64)
    }
  ],
  [
    'artifact changed',
    f => {
      f.context.fingerprintAfter.artifact_sha256 = '9'.repeat(64)
    }
  ],
  [
    'missing fingerprint',
    f => {
      delete f.context.fingerprintAfter
    }
  ],
  [
    'adapter changed',
    f => {
      f.context.expectedProvenance.adapterSha256 = '9'.repeat(64)
    }
  ],
  [
    'relaxed budget',
    f => {
      f.context.provenance.performanceBudget = {}
      f.context.expectedProvenance = structuredClone(f.context.provenance)
    }
  ],
  [
    'missing original assertion',
    f => {
      f.report.assertions = f.report.assertions.filter(a => a.id !== 'P4r')
    }
  ],
  [
    'missing motion assertion',
    f => {
      f.report.assertions = f.report.assertions.filter(a => a.id !== 'CM-HIDDEN')
    }
  ],
  [
    'failed assertion',
    f => {
      f.report.assertions[0].passed = false
    }
  ],
  [
    'stale case',
    f => {
      f.receipt.cases[0].at = '2000-01-01T00:00:00Z'
    }
  ],
  [
    'missing timestamp',
    f => {
      delete f.receipt.finishedAt
    }
  ],
  [
    'missing invocation timestamp',
    f => {
      delete f.context.invokedAt
    }
  ],
  [
    'wrong exact boot identity',
    f => {
      f.report.artifacts.boot_entries[0].id = '@other/xuanling-blueprint'
    }
  ],
  [
    'missing native attach',
    f => {
      f.report.artifacts.motion_browser.noDefaults = false
    }
  ],
  [
    'leaked owned browser',
    f => {
      f.report.artifacts.motion_browser.closed = false
    }
  ],
  [
    'foreign profile',
    f => {
      f.report.artifacts.motion_browser.profile = '/Users/example/Default'
    }
  ],
  [
    'missing screenshot',
    f => {
      rmSync(f.receipt.themes[0].screenshot)
    }
  ],
  [
    'screenshot hash',
    f => {
      f.receipt.themes[0].sha256 = '9'.repeat(64)
    }
  ],
  [
    'symlink screenshot',
    f => {
      const p = f.receipt.themes[0].screenshot
      rmSync(p)
      symlinkSync(f.report.artifacts.sidebar_screenshot, p)
    }
  ],
  [
    'missing frame',
    f => {
      delete f.receipt.cases.find(c => c.id === 'CM-DIRECTED').facts.frames
    }
  ],
  [
    'missing real Host reads',
    f => {
      f.receipt.rpc = []
    }
  ],
  [
    'provider label',
    f => {
      f.receipt.providerEvidence = true
    }
  ],
  [
    'effect label',
    f => {
      f.receipt.effectEvidence = true
    }
  ],
  [
    'key label',
    f => {
      f.receipt.keyRead = true
    }
  ],
  [
    'start bypass',
    f => {
      f.receipt.requests.push({ method: 'startRun', rpcId: 'unfulfilled' })
    }
  ],
  [
    'provider-capable command',
    f => {
      f.receipt.requests.push({ method: 'hostProbe' })
    }
  ],
  [
    'wrong DTO fixture',
    f => {
      f.receipt.transport[1].result.branch = 'imagined'
    }
  ],
  [
    'fixture unlabeled',
    f => {
      f.receipt.transport[0].scope = 'real provider'
    }
  ],
  [
    'duplicate theme',
    f => {
      f.receipt.themes[1] = f.receipt.themes[0]
    }
  ],
  [
    'wrong native theme raw caption',
    f => {
      f.receipt.themes[0].state.dom.nodes[0].caption = en['state.succeeded']
    }
  ]
])
  test(`final motion gate rejects ${name}`, t => {
    const f = fixture(t)
    mutate(f)
    assert.throws(() => collector.validateCollectorGate(f.report, f.context))
  })
test('actual probe adapter preserves original assertions/budgets and uses owned public default context with cleanup on failure', t => {
  const f = fixture(t),
    original = readFileSync(join(HERE, 'probe.mjs'), 'utf8'),
    adapted = collector.adaptProbe(original)
  for (const id of collector.REQUIRED_ASSERTIONS.filter(id => id.startsWith('P') && original.includes(`'${id}'`))) assert.ok(adapted.includes(`'${id}'`))
  for (const budget of ['page.setDefaultTimeout(15000)', 'timeout: 180_000', 'timeout: 60_000'])
    assert.equal(adapted.includes(budget), original.includes(budget))
  assert.ok(adapted.includes('ownedEdge.context.newPage()'))
  assert.ok(adapted.includes('await ownedEdge?.close()'))
  assert.ok(!adapted.includes('pw.chromium.launch('))
  const path = join(f.dir, 'adapter.mjs')
  writeFileSync(path, adapted)
  assert.equal(spawnSync(process.execPath, ['--check', path]).status, 0)
  assert.throws(() => collector.adaptProbe(original.replace('let browserTried = false', 'missing anchor')))
  const source = readFileSync(join(HERE, 'comfy-motion-ui.mjs'), 'utf8')
  assert.ok(source.includes('connectOverCDP(endpoint, { noDefaults: true })'))
  assert.ok(source.includes('{ polling: 100 }'))
  assert.ok(!/document\.hidden\s*=|dispatchEvent\(|hiddenRAF|locator\.focus\(|\.evaluate\([^\n]*\.click\(/.test(source))
  assert.ok(
    source.includes("querySelector('g[data-bp-edge]')") &&
      source.includes("querySelector('.bp-node-emphasis')") &&
      source.includes("dictionary['node.unknownState']")
  )
  assert.equal(collector.measureCanvasPerformance.name, 'measureCanvasPerformance')
  assert.deepEqual(collector.PERFORMANCE_BUDGET, { loadMs: 2000, paintP95Ms: 100, interactions: 20, nodes: 200, edges: 300, resources: 20 })
})
test('production fixture decoder/validator and actual inspect codec accept only owned public definition and raw fields', t => {
  const f = fixture(t),
    fixtures = collector.prepareCanvasFixtures(join(f.dir, 'owned-fixture'), decodeDefinition, validateDefinition)
  for (const id of ['motion-ui', 'motion-routed']) {
    assert.ok(fixtures.config.blueprints[id].startsWith(f.dir))
    const definition = decodeDefinition(readFileSync(join(fixtures.config.blueprints[id], 'blueprint.json'), 'utf8'))
    validateDefinition(definition)
    assert.equal(definition.graph.nodes.find(n => n.id === 'source').outputs['part.中文'], 'string')
    assert.deepEqual(GraphEditor.fromDefinition(definition).exportDefinition(), definition, 'MOTION_FIXTURE_MUST_BE_EXACT_PUBLIC_EDITOR_SAVE_PREIMAGE')
  }
  assert.equal(fixtures.evidence.find(e => e.id === 'canvas-performance').nodes, 200)
  for (const mode of ['active', 'ordinal', 'tie', 'stale', 'unknown', 'unknown-path', 'waiting', 'terminal'])
    assert.equal(
      BLUEPRINT_INVOCATIONS.find(d => d.method === 'inspectRun')
        .result.create()
        .safeParse(collector.motionSnapshot(f.receipt.cases[0].facts.before.host, mode)).success,
      true
    )
})
test('passive DOM reader uses persistent static edge wrapper and decorative emphasis opacity', () => {
  const rect = () => ({ x: 0, y: 0, width: 220, height: 240 }),
    emphasis = { opacity: '0.42' }
  const node = {
    getAttribute: key => ({ 'data-bp-node': 'target', 'data-bp-raw-state': 'running', 'data-bp-motion': 'pulse', 'data-bp-relation': 'none' })[key],
    querySelector: selector => (selector === '.bp-node-emphasis' ? emphasis : selector === '[data-bp-node-state]' ? { textContent: 'Running' } : null)
  }
  const marked = { getAttribute: key => ({ 'data-bp-edge': 'actual-edge-id', 'data-bp-motion': 'static', 'data-bp-related': 'false' })[key] }
  const path = { getTotalLength: () => 100, getScreenCTM: () => ({}), getPointAtLength: x => ({ x, y: 0 }), getAttribute: () => 'M 0 0 L 100 0' }
  const group = { querySelector: selector => (selector === 'g[data-bp-edge]' ? marked : selector === '.react-flow__edge-path' ? path : null) }
  const root = {
    getAttribute: key =>
      ({
        'data-bp-blueprint': 'motion-ui',
        'data-bp-motion': 'on',
        'data-bp-motion-visible': 'true',
        'data-bp-motion-reduced': 'false',
        'data-bp-motion-loops': 'true'
      })[key],
    querySelectorAll: selector =>
      ({
        '[data-bp-node]': [node],
        '.react-flow__edge': [group],
        '.react-flow__node': [{ getAttribute: () => 'target', getBoundingClientRect: rect }],
        '[data-bp-port]': []
      })[selector] ?? [],
    querySelector: selector =>
      selector === '.react-flow__viewport'
        ? { getAttribute: () => 'translate(0px,0px) scale(1)' }
        : selector === '[data-bp-run]'
          ? { textContent: 'ui-only-motion-ui · Running' }
          : null
  }
  const dom = runInNewContext(`(${collector.motionDomProbe.toString()})()`, {
    document: {
      querySelector: () => root,
      activeElement: null,
      getAnimations: () => [],
      hidden: false,
      visibilityState: 'visible',
      timeline: { currentTime: 1000 }
    },
    getComputedStyle: el => ({ opacity: el === emphasis ? el.opacity : '1' }),
    DOMPoint: class {
      constructor(x, y) {
        this.x = x
        this.y = y
      }
      matrixTransform() {
        return this
      }
    },
    matchMedia: () => ({ matches: false }),
    window: {},
    structuredClone
  })
  assert.equal(dom.nodes[0].opacity, 0.42)
  assert.equal(dom.edges[0].id, 'actual-edge-id')
  assert.equal(dom.edges[0].motion, 'static')
  assert.equal(dom.edges[0].lightD, null)
})
test('CLI explicit plan and new W3/W4 confinement, help and existing-directory refusal never launch', t => {
  const f = fixture(t),
    path = join(HERE, 'comfy-motion-ui.mjs')
  assert.deepEqual(collector.parseCli(['--plan-id', TEST_PLAN_ID, '--report-dir', join(OWN, 'native-new')]), {
    planId: TEST_PLAN_ID,
    reportDir: join(OWN, 'native-new')
  })
  for (const args of [
    [],
    ['--help', '--plan-id', TEST_PLAN_ID],
    ['--plan-id', TEST_PLAN_ID, '--report-dir', '/tmp/foreign'],
    ['--plan-id', 'old', '--report-dir', f.dir],
    ['--key', 'forbidden']
  ])
    assert.throws(() => collector.parseCli(args))
  const env = { PATH: process.env.PATH },
    help = spawnSync(process.execPath, [path, '--help'], { env, encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.ok(help.stdout.includes(TEST_PLAN_ID))
  const refused = spawnSync(process.execPath, [path, '--plan-id', TEST_PLAN_ID, '--report-dir', f.dir], { env, encoding: 'utf8' })
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /directory exists/)
  assert.equal(existsSync(join(f.dir, 'isolated-motion-probe.mjs')), false)
})
test('navigation timeout diagnostics capture only public sanitized request lifecycle and immediate DOM evidence', async t => {
  assert.equal(typeof collector.observeNavigation, 'function', 'PUBLIC_NAVIGATION_TIMEOUT_DIAGNOSTICS_MISSING')
  const f = fixture(t),
    listeners = new Map(),
    request = { url: () => 'http://user:secret@127.0.0.1:3080/api/loading?token=SECRET#hidden', resourceType: () => 'fetch' }
  const page = {
    on: (event, fn) => listeners.set(event, fn),
    off: event => listeners.delete(event),
    url: request.url,
    evaluate: async () => ({ readyState: 'interactive', title: 'DSH', visibility: 'hidden', body: 'loading http://127.0.0.1:3080/?token=SECRET' }),
    screenshot: async ({ path }) => writeFileSync(path, 'unit screenshot; no native claim')
  }
  const observer = collector.observeNavigation(page, f.dir)
  listeners.get('request')(request)
  listeners.get('requestfinished')(request)
  listeners.get('request')(request)
  listeners.get('pageerror')(new Error('failed http://127.0.0.1:3080/?token=SECRET'))
  listeners.get('console')({ type: () => 'error', text: () => 'failed http://127.0.0.1:3080/?token=SECRET' })
  const facts = await observer.failed(new Error('goto networkidle timeout http://127.0.0.1:3080/?token=SECRET'))
  assert.equal(facts.dom.readyState, 'interactive')
  assert.equal(facts.dom.visibility, 'hidden')
  assert.equal(facts.activeRequests.length, 1)
  assert.ok(facts.activeRequests[0].ageMs >= 0)
  assert.deepEqual(
    facts.timeline.map(e => e.phase),
    ['request', 'finished', 'request']
  )
  assert.equal(facts.timeline[0].url, 'http://127.0.0.1:3080/api/loading')
  assert.equal(facts.pageErrors.length, 1)
  assert.equal(facts.consoleErrors.length, 1)
  assert.equal(existsSync(facts.screenshot), true)
  assert.ok(!/SECRET|secret|token=|#hidden/.test(JSON.stringify(facts)))
  observer.stop()
  assert.equal(listeners.size, 0)
})
test('adapter navigation retains primary goto failure when diagnostic screenshot fails and removes passive observers', async t => {
  assert.equal(typeof collector.observeNavigation, 'function', 'PUBLIC_NAVIGATION_TIMEOUT_DIAGNOSTICS_MISSING')
  const f = fixture(t),
    listeners = new Map(),
    primary = new Error('original networkidle timeout'),
    report = { artifacts: {} },
    options = []
  const page = {
    on: (event, fn) => listeners.set(event, fn),
    off: event => listeners.delete(event),
    url: () => 'about:blank',
    goto: async (_url, opts) => {
      options.push(opts)
      throw primary
    },
    evaluate: async () => ({ readyState: 'loading', visibility: 'hidden' }),
    screenshot: async () => {
      throw new Error('screenshot unavailable')
    }
  }
  const adapted = collector.adaptProbe(readFileSync(join(HERE, 'probe.mjs'), 'utf8')),
    start = adapted.indexOf('const navigation ='),
    end = adapted.indexOf('    await page.waitForTimeout(3000)', start)
  assert.ok(start >= 0 && end > start)
  const run = new Function('page', 'observeNavigation', 'report', 'process', 'baseUrl', `return (async () => {${adapted.slice(start, end)}})()`)
  await assert.rejects(
    run(page, collector.observeNavigation, report, { env: { BP_MOTION_ARTIFACT_DIR: f.dir } }, 'http://127.0.0.1:3080/'),
    error => error === primary
  )
  assert.deepEqual(options, [{ waitUntil: 'networkidle', timeout: 60_000 }])
  assert.equal(listeners.size, 0)
  assert.match(JSON.stringify(report.artifacts.motion_navigation), /screenshot unavailable/)
})
test('navigation facts persist before a stalled DOM read and its 15s timeout survives screenshot failure', async t => {
  const f = fixture(t),
    path = join(f.dir, 'initial-navigation-diagnostic.json'),
    listeners = new Map()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const page = {
    on: (event, fn) => listeners.set(event, fn),
    off: event => listeners.delete(event),
    url: () => 'about:blank',
    evaluate: () => new Promise(() => {}),
    screenshot: async options => {
      assert.equal(options.timeout, 15000)
      throw new Error('screenshot unavailable')
    }
  }
  const observer = collector.observeNavigation(page, f.dir),
    primary = new Error('original networkidle timeout')
  listeners.get('request')({ url: () => 'http://127.0.0.1:3080/?token=SECRET', resourceType: () => 'document' })
  const pending = observer.failed(primary)
  assert.equal(existsSync(path), true, 'NAVIGATION_FACTS_MUST_PERSIST_BEFORE_STALLED_DOM_READ')
  const early = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(early.error, primary.message)
  assert.equal(early.activeRequests.length, 1)
  assert.ok(!/SECRET|token=/.test(JSON.stringify(early)))
  t.mock.timers.tick(15000)
  const facts = await pending
  observer.stop()
  assert.equal(facts.error, primary.message)
  assert.equal(facts.dom, undefined)
  assert.equal(listeners.size, 0)
  assert.deepEqual(
    facts.diagnosticErrors.map(e => e.phase),
    ['dom', 'screenshot']
  )
  assert.equal(facts.diagnosticErrors[0].timedOut, true)
  assert.equal(facts.diagnosticErrors[0].timeoutMs, 15000)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), facts)
})
