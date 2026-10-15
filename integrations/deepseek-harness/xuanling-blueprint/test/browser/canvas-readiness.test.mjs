// Deterministic rendered-projection fixture only, NOT mounted DSH acceptance.
// Executes the real journey, production GraphEditor and legal canonical fixture.
import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { canvasDefinitions } from '../../../../../test/blueprint/capabilities/canvas-fixtures.mjs'
import { runCanvasJourney } from '../../../../../test/blueprint/capabilities/canvas-journey.mjs'
import { canonicalCanvasGraph, renderedCanvasGraphReady, waitForCanvasGraph } from '../../../../../test/blueprint/capabilities/canvas-readiness.mjs'
import { GraphEditor } from '../../src/client/graph-editor.ts'
import { flowEdgeEndpoints } from '../../src/client/flow-geometry.ts'
import { decodeDefinition } from '../../src/definition/codec.ts'
import { validateDefinition } from '../../src/definition/validator.ts'

function projectionFixture(definition = canvasDefinitions().find(d => d.id === 'canvas-alpha')) {
  validateDefinition(decodeDefinition(JSON.stringify(definition)))
  const editor = GraphEditor.fromDefinition(definition)
  const countRequests = [],
    samples = [],
    pointer = [],
    assertions = []
  const pending = new Error('controlled rendered projection remains pending')
  const complete = new Error('requested P6f frontier reached')
  let missingReads = 0,
    added = 0,
    selectedSource,
    selectedTarget
  let projectEdges = edges => edges,
    projectHandles = handles => handles
  let transform = { a: 1, d: 1, e: 0, f: 0 }
  const rect = (x, y, width = 10, height = 10) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height })
  const point = (x, y) => ({ x, y, matrixTransform: matrix => ({ x: matrix.a * x + matrix.e, y: matrix.d * y + matrix.f }) })
  const attribute = attrs => name => attrs[name] ?? null
  function renderedNodes() {
    return editor.nodes.map(n => ({ getAttribute: attribute({ 'data-bp-node': n.id, 'data-bp-kind': n.kind, 'data-id': n.id }) }))
  }
  function renderedHandles() {
    return editor.nodes.flatMap(n =>
      ['source', 'target'].flatMap(direction => {
        const ports = direction === 'source' ? n.outputs : n.inputs
        const dataPorts = Object.keys(ports).map(port => `data:${port}`)
        const controlPorts =
          direction === 'source' && n.definition?.branches?.length ? n.definition.branches.map(branch => `control:${branch}`) : ['control:control']
        return [...dataPorts, ...controlPorts].map((handleId, index) => {
          const box = rect(
            (direction === 'source' ? n.x + 170 : n.x - 5) * transform.a + transform.e,
            (n.y + 70 + index * 24) * transform.d + transform.f,
            10 * transform.a,
            10 * transform.d
          )
          const attrs = {
            'data-nodeid': n.id,
            'data-handleid': handleId,
            'data-bp-port': `${n.id}:${handleId}`,
            'data-handlepos': direction === 'source' ? 'right' : 'left'
          }
          return {
            getAttribute: attribute(attrs),
            getBoundingClientRect: () => box,
            classList: { contains: name => name === direction },
            closest: () => ({ getAttribute: attribute({ 'data-id': n.id }) })
          }
        })
      })
    )
  }
  function renderedEdges() {
    if (missingReads > 0) {
      missingReads--
      samples.push(0)
      return []
    }
    const projected = projectEdges(editor.edges)
    samples.push(projected.length)
    const handles = renderedHandles()
    return projected.map(e => {
      const endpoint = flowEdgeEndpoints(e)
      const source = handles
        .find(
          h => h.getAttribute('data-nodeid') === endpoint.source && h.getAttribute('data-handleid') === endpoint.sourceHandle && h.classList.contains('source')
        )
        .getBoundingClientRect()
      const target = handles
        .find(
          h => h.getAttribute('data-nodeid') === endpoint.target && h.getAttribute('data-handleid') === endpoint.targetHandle && h.classList.contains('target')
        )
        .getBoundingClientRect()
      const path = {
        getTotalLength: () => 100,
        getScreenCTM: () => transform,
        getPointAtLength: length =>
          length === 0
            ? point((source.right - transform.e) / transform.a, (source.top + source.height / 2 - transform.f) / transform.d)
            : point((target.left - transform.e) / transform.a, (target.top + target.height / 2 - transform.f) / transform.d)
      }
      return {
        getAttribute: attribute({ 'data-id': e.id, 'aria-label': `Edge from ${endpoint.source} to ${endpoint.target}` }),
        classList: { contains: name => name === `bp-edge-${e.kind}` },
        querySelector: () => path
      }
    })
  }
  const root = {
    closest: () => root,
    getBoundingClientRect: () => rect(0, 0, 900, 600),
    querySelector: selector => (selector === '.react-flow__handle' ? renderedHandles()[0] : { disabled: false }),
    querySelectorAll: selector => {
      if (selector === '[data-bp-node]') return renderedNodes()
      if (selector === '.react-flow__edge') return renderedEdges()
      if (selector.startsWith('.react-flow__handle'))
        return projectHandles(renderedHandles()).filter(
          h => (!selector.endsWith('.source') && !selector.endsWith('.target')) || h.classList.contains(selector.split('.').at(-1))
        )
      throw new Error(`unsupported projection selector ${selector}`)
    }
  }
  const document = {
    querySelector: selector => (selector === '[data-bp-canvas="surface"]' ? root : { disabled: false }),
    querySelectorAll: selector => root.querySelectorAll(selector),
    getElementById: () => ({})
  }
  const context = vm.createContext({ document, getComputedStyle: () => ({ display: 'flex', position: 'absolute', width: '10px' }) })
  const evaluate = (fn, arg, el) => {
    context.arg = arg
    context.el = el
    return vm.runInContext(`(${fn.toString()})(${el ? 'el' : 'arg'})`, context)
  }
  function locator(selector, last = false) {
    return {
      isVisible: async () => {
        // This expanded-layout fixture exposes refresh directly and has no More.
        if (selector === '[data-bp-action="refresh-library"]') return true
        if (selector === '[data-bp-overlay="more-menu"]') return false
        throw new Error(`unsupported projection visibility selector ${selector}`)
      },
      waitFor: async () => {},
      boundingBox: async () => {
        const port = selector.match(/data-bp-port="([^"]+)"/)?.[1]
        const direction = selector.endsWith('.source') ? 'source' : 'target'
        const handle = renderedHandles().find(h => h.getAttribute('data-bp-port') === port && h.classList.contains(direction))
        if (direction === 'source') selectedSource = port
        else selectedTarget = port
        return handle?.getBoundingClientRect() ?? null
      },
      count: async () => (selector === '[data-bp-action="add-agentTask"]' ? 0 : root.querySelectorAll(selector).length),
      last: () => locator(selector, true),
      getAttribute: async name => (last ? renderedNodes().at(-1) : renderedNodes()[0]).getAttribute(name),
      evaluate: async fn => evaluate(fn, undefined, root),
      press: async key => {
        assert.equal(key, 'Enter')
        await locator(selector, last).click()
      },
      click: async () => {
        const kind = selector.match(/data-bp-action="add-(input|output)"/)?.[1]
        if (!kind) throw new Error(`unsupported projection action ${selector}`)
        added++
        editor.addNode({
          id: `added-${kind}-${added}`,
          kind,
          label: kind,
          x: 700,
          y: added * 150,
          inputs: kind === 'output' ? { value: 'string' } : {},
          outputs: kind === 'input' ? { request: 'string' } : {}
        })
        missingReads = 1
      }
    }
  }
  const page = {
    on: () => {},
    locator,
    getByRole: (role, { name }) => {
      if (role === 'combobox' && name === 'Blueprint library') return { selectOption: async id => assert.equal(id, definition.id) }
      if (role === 'textbox' && name === 'Search nodes') return { fill: async () => {} }
      throw new Error(`unsupported projection role ${role}/${name}`)
    },
    waitForFunction: async (fn, arg, ...options) => {
      assert.deepEqual(options, [], 'readiness must preserve the default Playwright timeout')
      if (arg?.selector === '.react-flow__edge') countRequests.push(arg.count)
      // Finite deterministic projection polls, not real Playwright timeout changes.
      for (let poll = 0; poll < 8; poll++) {
        const result = evaluate(fn, arg)
        if (result) return { jsonValue: async () => structuredClone(result), dispose: async () => {} }
      }
      throw pending
    },
    mouse: {
      move: async (...args) => pointer.push(['move', ...args]),
      down: async () => pointer.push(['down']),
      up: async () => {
        pointer.push(['up'])
        const [sourceId, , sourcePort] = selectedSource.split(':')
        const [targetId, , targetPort] = selectedTarget.split(':')
        const result = editor.connect(
          { nodeId: sourceId, port: sourcePort, type: 'string', direction: 'out', kind: 'data' },
          { nodeId: targetId, port: targetPort, type: 'string', direction: 'in', kind: 'data' }
        )
        assert.equal(result.ok, true, 'legal connection must succeed in the production editor fixture')
      }
    }
  }
  return {
    definition,
    editor,
    page,
    countRequests,
    samples,
    pointer,
    assertions,
    pending,
    complete,
    observe(graph, options = {}) {
      return structuredClone(evaluate(renderedCanvasGraphReady, { graph, ...options }))
    },
    transientEdges(reads = 1) {
      missingReads = reads
    },
    projectEdges(fn) {
      projectEdges = fn
    },
    projectHandles(fn) {
      projectHandles = fn
    },
    screenTransform(matrix) {
      transform = matrix
    },
    record(id, label, passed, detail) {
      assertions.push({ id, passed, detail })
      assert.equal(passed, true, `${id}: ${label} (${detail})`)
      if (id === 'P6f') throw complete
    }
  }
}

test('journey uses canonical one-edge readiness, not transient zero, before the legal drag expecting graph two', async () => {
  const f = projectionFixture()
  assert.equal(f.definition.graph.edges.length, 1)
  let stopped
  try {
    await runCanvasJourney(f.page, f.record, async () => ({
      status: 200,
      body: { result: { ok: true, value: { definitionJson: JSON.stringify(f.definition) } } }
    }))
  } catch (error) {
    if (error !== f.pending && error !== f.complete) throw error
    stopped = error
  }
  assert.equal(f.editor.edges.length, 2, 'legal drag genuinely adds the requested edge; this is not a product connection failure')
  assert.deepEqual(f.countRequests, [2], 'incremental count target must be canonical baseline 1 + valid drag 1, never transient DOM 0 + 1')
  assert.equal(stopped, f.complete)
  assert.equal(f.assertions.find(a => a.id === 'P6f')?.passed, true)
  assert.ok(f.samples.includes(0), 'regression must exercise the documented transient projection')
  assert.deepEqual(
    f.pointer.map(event => event[0]),
    ['move', 'down', 'move', 'up'],
    'ordinary pointer sequence remains unchanged'
  )
  assert.equal(f.pointer[2].at(-1).steps, 8)
})

const identities = graph => graph.edges.map(({ kind, source, target, sourceHandle, targetHandle }) => ({ kind, source, target, sourceHandle, targetHandle }))
const requested = { kind: 'data', source: 'in', target: 'spare', sourceHandle: 'data:request', targetHandle: 'data:value' }
const requestedHandles = [
  { nodeId: 'in', handleId: 'data:request', direction: 'source' },
  { nodeId: 'spare', handleId: 'data:value', direction: 'target' }
]
function withAlternatePorts() {
  const definition = canvasDefinitions().find(d => d.id === 'canvas-alpha')
  definition.graph.nodes.find(n => n.id === 'in').outputs['request.alt'] = 'string'
  definition.graph.nodes.find(n => n.id === 'out').inputs['value.alt'] = 'string'
  return definition
}

test('readiness is pending at transient zero and resolves only at the known canonical one-edge graph with named handles', async () => {
  const f = projectionFixture(),
    graph = canonicalCanvasGraph(f.definition)
  f.transientEdges()
  assert.equal(f.observe(graph, { handles: requestedHandles }), false)
  const ready = await waitForCanvasGraph(f.page, graph, { handles: requestedHandles })
  assert.deepEqual(ready.nodes, graph.nodes)
  assert.deepEqual(identities(ready), graph.edges)
  assert.equal(ready.edges.length, 1)
  assert.deepEqual(f.samples, [0, 1])
})

test('a permanently missing canonical edge remains pending and fails the readiness wait, never adopting zero as baseline', async () => {
  const f = projectionFixture(),
    graph = canonicalCanvasGraph(f.definition)
  f.projectEdges(() => [])
  assert.equal(f.observe(graph), false)
  await assert.rejects(waitForCanvasGraph(f.page, graph), error => error === f.pending)
  assert.ok(f.samples.every(count => count === 0))
  assert.equal(graph.edges.length, 1)
})

test('same edge count with the wrong legal target remains pending/fails rather than replacing the canonical endpoint identity', async () => {
  const f = projectionFixture(),
    graph = canonicalCanvasGraph(f.definition)
  f.projectEdges(edges => edges.map(e => ({ ...e, to: 'spare.value' })))
  assert.equal(f.observe(graph), false)
  assert.equal(f.samples.at(-1), 1)
  await assert.rejects(waitForCanvasGraph(f.page, graph), error => error === f.pending)
})

for (const [label, patch] of [
  ['source', { from: 'in.request.alt' }],
  ['target', { to: 'out.value.alt' }]
]) {
  test(`same nodes/count/aria label with the wrong legal ${label} handle remains pending/fails`, async () => {
    const f = projectionFixture(withAlternatePorts()),
      graph = canonicalCanvasGraph(f.definition)
    f.projectEdges(edges => edges.map(e => ({ ...e, ...patch })))
    assert.equal(f.observe(graph), false)
    assert.equal(f.samples.at(-1), 1)
    await assert.rejects(waitForCanvasGraph(f.page, graph), error => error === f.pending)
  })
}

test('valid production connection renders exactly canonical graph two including the requested source, target and both named handles', async () => {
  const f = projectionFixture(withAlternatePorts()),
    graph = canonicalCanvasGraph(f.definition)
  const result = f.editor.connect(
    { nodeId: 'in', port: 'request', type: 'string', direction: 'out', kind: 'data' },
    { nodeId: 'spare', port: 'value', type: 'string', direction: 'in', kind: 'data' }
  )
  assert.equal(result.ok, true)
  const expected = { ...graph, edges: [...graph.edges, requested] }
  const ready = await waitForCanvasGraph(f.page, expected, { handles: requestedHandles })
  assert.equal(ready.edges.length, 2)
  assert.deepEqual(identities(ready), expected.edges)
  // A generic count of two and unchanged source/target labels are insufficient.
  f.projectEdges(edges => edges.map(e => (e.to === 'spare.value' ? { ...e, from: 'in.request.alt' } : e)))
  assert.equal(f.observe(expected), false)
  assert.equal(f.samples.at(-1), 2)
  await assert.rejects(waitForCanvasGraph(f.page, expected), error => error === f.pending)
  f.projectEdges(edges => edges)
  assert.deepEqual(identities(await waitForCanvasGraph(f.page, expected)), expected.edges)
})

test('an unrendered or zero-size requested named handle stays pending even when the canonical existing edge is present', async () => {
  const f = projectionFixture(),
    graph = canonicalCanvasGraph(f.definition)
  f.projectHandles(handles => handles.filter(h => h.getAttribute('data-nodeid') !== 'spare' || h.getAttribute('data-handleid') !== 'data:value'))
  assert.equal(f.observe(graph, { handles: requestedHandles }), false)
  await assert.rejects(waitForCanvasGraph(f.page, graph, { handles: requestedHandles }), error => error === f.pending)
  f.projectHandles(handles =>
    handles.map(h =>
      h.getAttribute('data-nodeid') === 'spare' && h.getAttribute('data-handleid') === 'data:value'
        ? { ...h, getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) }
        : h
    )
  )
  assert.equal(f.observe(graph, { handles: requestedHandles }), false)
  f.projectHandles(handles => handles)
  assert.ok(f.observe(graph, { handles: requestedHandles }))
})

test('palette addition readiness requires all known node identities, the requested added kind and canonical edges before exposing a generated ID', async () => {
  const f = projectionFixture(),
    graph = canonicalCanvasGraph(f.definition)
  await f.page.locator('[data-bp-action="add-input"]').click()
  assert.equal(f.observe(graph, { addedNodeKind: 'input' }), false, 'the palette update temporarily has zero rendered edges')
  assert.equal(f.observe(graph), false, 'the old graph cannot silently accept an extra node')
  assert.equal(f.observe(graph, { addedNodeKind: 'output' }), false, 'a different node kind is not the requested palette action')
  const ready = await waitForCanvasGraph(f.page, graph, { addedNodeKind: 'input' })
  assert.equal(ready.nodes.length, graph.nodes.length + 1)
  assert.deepEqual(
    ready.nodes.filter(n => !graph.nodes.some(previous => previous.id === n.id)),
    [{ id: 'added-input-1', kind: 'input' }]
  )
  assert.deepEqual(identities(ready), graph.edges)
  const wrongNodeIdentity = { ...ready, nodes: ready.nodes.map(n => (n.id === 'in' ? { ...n, id: 'not-in' } : n)) }
  assert.equal(f.observe(wrongNodeIdentity), false, 'equal count never hides a missing canonical node')
})

test('selection Delete/Undo readiness follows exact known node/edge identities, not incremental transient counts', async () => {
  const f = projectionFixture(),
    canonical = canonicalCanvasGraph(f.definition)
  const baseline = await waitForCanvasGraph(f.page, canonical)
  f.editor.deleteItems([], [baseline.edges[0].id])
  assert.equal(f.observe(baseline), false)
  const edgeDeleted = await waitForCanvasGraph(f.page, { ...baseline, edges: [] })
  assert.equal(edgeDeleted.nodes.length, baseline.nodes.length)
  assert.equal(f.editor.undo(), true)
  assert.deepEqual(await waitForCanvasGraph(f.page, baseline), baseline)
  f.editor.deleteItems(['in', 'spare'], [])
  const nodeDeleted = { nodes: baseline.nodes.filter(n => !['in', 'spare'].includes(n.id)), edges: [] }
  assert.deepEqual(await waitForCanvasGraph(f.page, nodeDeleted), nodeDeleted)
  assert.equal(f.observe(baseline), false)
  assert.equal(f.editor.undo(), true)
  assert.deepEqual(await waitForCanvasGraph(f.page, baseline), baseline)
})

test('edge kind and unique mounted ID are part of readiness; same-count duplicate or replaced IDs cannot fake Undo restoration', async () => {
  const f = projectionFixture(),
    graph = canonicalCanvasGraph(f.definition)
  const baseline = await waitForCanvasGraph(f.page, graph)
  f.projectEdges(edges => edges.map(e => ({ ...e, id: 'replacement-id' })))
  assert.equal(f.observe(baseline), false)
  // Initial canonical documents do not persist ephemeral editor edge IDs.
  assert.ok(f.observe(graph))
  f.projectEdges(edges => edges.map(e => ({ ...e, kind: 'control', from: 'in', to: 'out' })))
  assert.equal(f.observe(graph), false, 'the same nodes/count with control handles is not the canonical data edge')
  f.projectEdges(edges => [...edges, { ...edges[0] }])
  assert.equal(f.observe({ ...graph, edges: [...graph.edges, graph.edges[0]] }), false)
  f.projectEdges(edges => edges)
  assert.deepEqual(await waitForCanvasGraph(f.page, baseline), baseline)
})

test('canonical readiness endpoint mapping matches production geometry, retaining dotted ports and control handles', async () => {
  const dotted = withAlternatePorts()
  dotted.graph.edges[0] = { kind: 'data', from: 'in.request.alt', to: 'out.value.alt' }
  for (const definition of [...canvasDefinitions(), dotted]) {
    validateDefinition(decodeDefinition(JSON.stringify(definition)))
    const expected = canonicalCanvasGraph(definition)
    assert.deepEqual(
      expected.edges,
      definition.graph.edges.map(edge => ({ kind: edge.kind, ...flowEdgeEndpoints(edge) }))
    )
  }
  for (const definition of [dotted, canvasDefinitions().find(d => d.id === 'canvas-approval')]) {
    const f = projectionFixture(definition),
      graph = canonicalCanvasGraph(definition)
    assert.deepEqual(identities(await waitForCanvasGraph(f.page, graph)), graph.edges)
  }
})

test('rendered edge identity uses SVG screen CTM and named handle geometry through a pan/zoom transform', async () => {
  const f = projectionFixture(withAlternatePorts()),
    graph = canonicalCanvasGraph(f.definition)
  f.screenTransform({ a: 0.73, d: 0.73, e: -103.25, f: 51.5 })
  assert.deepEqual(identities(await waitForCanvasGraph(f.page, graph)), graph.edges)
  f.projectEdges(edges => edges.map(e => ({ ...e, from: 'in.request.alt' })))
  assert.equal(f.observe(graph), false, 'screen coordinates still distinguish the alternate named handle')
})
