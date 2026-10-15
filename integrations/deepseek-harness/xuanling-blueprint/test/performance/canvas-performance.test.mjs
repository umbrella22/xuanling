// Deterministic mechanics/report oracles, NOT real mounted timing measurements.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'
import {
  canvasDefinitions,
  fixtureEvidence,
  performanceDefinition,
  prepareCanvasFixtures
} from '../../../../../test/blueprint/capabilities/canvas-fixtures.mjs'
import { percentile95, PERFORMANCE_BUDGET } from '../../../../../test/blueprint/capabilities/canvas-journey.mjs'
import { installCanvasPaintRecorder } from '../../../../../test/blueprint/capabilities/canvas-timing.mjs'
import { validatePerformanceEvidence } from '../../../../../test/blueprint/capabilities/canvas-suite.mjs'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function syntheticPerformanceEvidence() {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    index: i,
    kind: i % 2 === 0 ? 'pan' : 'zoom',
    type: i % 2 === 0 ? 'pointermove' : 'wheel',
    trusted: true,
    startMs: i * 100,
    changeObservedAt: i * 100 + 15,
    latencyMs: 32,
    before: `translate(${i}px) scale(1)`,
    after: `translate(${i + 1}px) scale(1)`
  }))
  return {
    provenance: 'real DSH closure factory (synthetic REPORT fixture only)',
    budget: PERFORMANCE_BUDGET,
    fixture: fixtureEvidence(performanceDefinition()),
    measured: { loadMs: 1500, paintP95Ms: 32 },
    samples,
    viewports: samples.map(s => ({ before: s.before, after: s.after })),
    canonicalUnchanged: true
  }
}
const environment = { platform: 'darwin/arm64', node: process.version, browser_version: 'synthetic-source-fixture', dsh_version_output: '0.2.1-alpha.1' }

test('all probe fixtures and the full 200/300/20 performance graph pass the actual production decoder/validator', t => {
  for (const definition of canvasDefinitions()) validateDefinition(decodeDefinition(JSON.stringify(definition)))
  const definition = performanceDefinition()
  assert.equal(definition.graph.nodes.length, 200)
  assert.equal(definition.graph.edges.length, 300)
  assert.equal(Object.keys(definition.resources).length, 20)
  assert.ok(definition.graph.edges.every(e => e.from.includes('.value') && /\.[abc]$/.test(e.to)))
  const evidence = fixtureEvidence(definition)
  assert.equal(createHash('sha256').update(evidence.json).digest('hex'), evidence.sha256)
  const root = mkdtempSync(join(tmpdir(), 'bp-canvas-fixture-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(root, { recursive: true })
  const fixtures = prepareCanvasFixtures(root, decodeDefinition, validateDefinition)
  assert.deepEqual(
    fixtures.evidence.find(f => f.id === 'canvas-performance'),
    evidence
  )
  for (const d of canvasDefinitions()) {
    assert.equal(readFileSync(join(fixtures.config.blueprints[d.id], 'blueprint.json'), 'utf8'), JSON.stringify(d))
    for (const ref of Object.values(d.resources))
      if (ref.path) assert.match(readFileSync(join(fixtures.config.blueprints[d.id], ref.path), 'utf8'), /fixture-agent/)
  }
  assert.match(readFileSync(join(fixtures.skillDir, 'SKILL.md'), 'utf8'), /CONTENT-H1/)
})

test('p95 is nearest-rank over all finite nonnegative samples and cannot discard invalid timings', () => {
  assert.equal(percentile95(Array.from({ length: 20 }, (_, i) => i + 1)), 19)
  for (const values of [[], [NaN], [Infinity], [-1], ['32'], null]) assert.throws(() => percentile95(values))
})

function timingHarness() {
  let now = 0
  const listeners = new Map(),
    frames = []
  const viewport = { style: { transform: 'translate(0px) scale(1)' } }
  const document = {
    querySelector: selector => (selector === '.react-flow__viewport' ? viewport : null),
    addEventListener: (type, fn, options) => {
      listeners.set(type, { fn, options })
    },
    removeEventListener: type => listeners.delete(type)
  }
  const window = { __bpPerf: { samples: [] } }
  const context = vm.createContext({ document, window, performance: { now: () => now }, requestAnimationFrame: cb => frames.push(cb) })
  vm.runInContext(`(${installCanvasPaintRecorder.toString()})()`, context)
  return {
    window,
    viewport,
    listeners,
    setNow: time => {
      now = time
    },
    frame(time) {
      now = time
      const work = frames.splice(0)
      for (const fn of work) fn(time)
    },
    event(type, props = {}) {
      listeners.get(type)?.fn({ type, isTrusted: true, buttons: 1, target: { closest: () => true }, ...props })
    }
  }
}

test('real recorder starts on FIRST trusted pointermove CAPTURE, waits for viewport mutation and then a later rAF; pointerup never starts it', () => {
  const h = timingHarness()
  assert.equal(h.listeners.has('pointerup'), false)
  assert.equal(h.listeners.get('pointermove').options.capture, true)
  h.window.__bpPaint.arm(0, 'pan')
  h.setNow(3)
  h.event('pointermove', { isTrusted: false })
  h.setNow(5)
  h.event('pointermove', { buttons: 0 })
  h.setNow(7)
  h.event('pointermove', { target: { closest: () => false } })
  h.setNow(8)
  h.event('wheel')
  h.setNow(10)
  h.event('pointermove')
  h.setNow(13)
  h.event('pointermove')
  h.frame(16)
  assert.equal(h.window.__bpPerf.samples.length, 0, 'unchanged viewport is NOT a painted sample')
  h.viewport.style.transform = 'translate(24px) scale(1)'
  h.frame(32)
  assert.equal(h.window.__bpPerf.samples.length, 0, 'must wait for the changed frame to complete')
  h.frame(48)
  const [s] = h.window.__bpPerf.samples
  assert.equal(s.type, 'pointermove')
  assert.equal(s.startMs, 10)
  assert.equal(s.changeObservedAt, 32)
  assert.equal(s.latencyMs, 38)
  assert.equal(s.before, 'translate(0px) scale(1)')
  assert.equal(s.after, 'translate(24px) scale(1)')
  h.frame(64)
  assert.equal(h.window.__bpPerf.samples.length, 1, 'one gesture exactly one sample')
})

test('wheel timing starts at its trusted capture, never accepts synthetic/no-change samples and forbids overlapping interactions', () => {
  const h = timingHarness()
  h.window.__bpPaint.arm(0, 'zoom')
  assert.throws(() => h.window.__bpPaint.arm(1, 'zoom'), /overlapping/)
  h.setNow(10)
  h.event('wheel', { isTrusted: false })
  h.frame(16)
  assert.equal(h.window.__bpPerf.samples.length, 0)
  h.setNow(20)
  h.event('wheel')
  h.setNow(24)
  h.event('wheel')
  h.frame(32)
  assert.equal(h.window.__bpPerf.samples.length, 0)
  h.viewport.style.transform = 'translate(0px) scale(1.2)'
  h.frame(48)
  h.frame(64)
  assert.equal(h.window.__bpPerf.samples[0].startMs, 20)
  assert.equal(h.window.__bpPerf.samples[0].latencyMs, 44)
  assert.throws(() => h.window.__bpPaint.arm(0, 'zoom'), /out-of-order/)
  h.window.__bpPaint.arm(1, 'pan')
  h.event('pointermove')
  h.window.__bpPaint.dispose()
  h.frame(80)
  h.frame(96)
  assert.equal(h.window.__bpPerf.samples.length, 1)
  assert.equal(h.listeners.size, 0)
})

test('performance report boundary enforces full fixture/hash, trusted 20 samples, exact budget and actual percentile; assertions alone cannot pass', async t => {
  assert.doesNotThrow(() => validatePerformanceEvidence(syntheticPerformanceEvidence(), environment))
  const mutations = {
    'pointerup origin': p => {
      p.samples[0].type = 'pointerup'
    },
    'missing sample': p => {
      p.samples.pop()
    },
    'extra sample': p => {
      p.samples.push(p.samples[0])
    },
    untrusted: p => {
      p.samples[0].trusted = false
    },
    'missing timestamp': p => {
      delete p.samples[0].startMs
    },
    'mutation precedes start': p => {
      p.samples[0].changeObservedAt = -1
    },
    'only final frame charged': p => {
      p.samples[0].latencyMs = 1
    },
    'no viewport change': p => {
      p.samples[0].after = p.samples[0].before
    },
    'lost resource': p => {
      p.fixture.resources = 19
    },
    'bad fixture hash': p => {
      p.fixture.sha256 = 'old-hash'
    },
    'bad generator': p => {
      p.fixture.generator = 'standalone-demo'
    },
    'semantic mutation': p => {
      p.canonicalUnchanged = false
    },
    'budget expansion': p => {
      p.budget.paintP95Ms = 1000
    },
    'load too slow': p => {
      p.measured.loadMs = 2001
    },
    'fake low percentile': p => {
      p.measured.paintP95Ms = 1
    },
    'paint too slow': p => {
      p.samples.forEach(s => {
        s.latencyMs = 101
      })
      p.measured.paintP95Ms = 101
    },
    'standalone provenance': p => {
      p.provenance = 'standalone React demo'
    }
  }
  for (const [name, mutate] of Object.entries(mutations))
    await t.test(name, () => {
      const p = structuredClone(syntheticPerformanceEvidence())
      mutate(p)
      assert.throws(() => validatePerformanceEvidence(p, environment), undefined, name)
    })
  assert.throws(() => validatePerformanceEvidence(syntheticPerformanceEvidence(), { ...environment, browser_version: '' }))
  assert.throws(() => validatePerformanceEvidence(syntheticPerformanceEvidence(), { ...environment, platform: 'linux/arm64' }))
})
