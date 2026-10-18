// Production panel callback + real Workspace/GraphEditor source regression.
// Public React/Flow hook seats and observable pane geometry are controlled;
// this is NOT mounted DSH/native-pointer acceptance and does not run a browser.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { canvasDefinitions } from '../../../../../test/blueprint/capabilities/canvas-fixtures.mjs'
import { decodeDefinition, validateDefinition } from '../../src/definition/index.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'

// Explicit injected-locale fixture seat, not native DSH locale acceptance.
const fixtureT = (key, params = {}) => {
  assert.ok(Object.hasOwn(en, key), `existing English dictionary key: ${key}`)
  return en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
}

const seat = { active: null }
const seatKey = Symbol.for('xuanling.blueprint.test.palette-placement')
globalThis[seatKey] = seat
const panelUrl = new URL('../../src/client/features/authoring/ui/panel/panel-composition.tsx', import.meta.url).href
const panelControllerUrl = new URL('../../src/client/features/authoring/ui/panel/panel-controller.tsx', import.meta.url).href
const canvasSurfaceUrl = new URL('../../src/client/features/authoring/ui/canvas/canvas-surface.tsx', import.meta.url).href
const canvasRendererUrl = new URL('../../src/client/features/authoring/ui/canvas/canvas-renderers.tsx', import.meta.url).href
seat.react = {
  createElement: (type, props, ...children) =>
    type?.name === 'CanvasSurface' ? type(props ?? {}) : { type, props: props ?? {}, children: children.length ? children : [props?.children] },
  memo: component => component,
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  useState(initial) {
    const f = seat.active,
      i = f.stateCursor++
    if (!(i in f.states)) f.states[i] = typeof initial === 'function' ? initial() : initial
    return [
      f.states[i],
      update => {
        f.states[i] = typeof update === 'function' ? update(f.states[i]) : update
      }
    ]
  },
  useRef(initial) {
    const f = seat.active,
      i = f.refCursor++
    return (f.refs[i] ??= { current: initial })
  },
  useMemo: factory => factory(),
  useCallback: callback => callback,
  useEffect(effect) {
    if (seat.runBridgeEffect) seat.active.bridgeCleanup = effect()
  }
}
const moduleUrl = source => `data:text/javascript,${encodeURIComponent(source)}`
const reactUrl = moduleUrl(`export default globalThis[Symbol.for('xuanling.blueprint.test.palette-placement')].react`)
const flowUrl = moduleUrl(`const seat = globalThis[Symbol.for('xuanling.blueprint.test.palette-placement')];
export const useReactFlow = () => seat.active.flow;
export const Position = { Left: 'left', Right: 'right' }, MarkerType = { ArrowClosed: 'arrowclosed' };
export const ReactFlow = 'flow', ReactFlowProvider = 'provider', Background = 'background', Controls = 'controls', MiniMap = 'minimap', Handle = 'handle', NodeResizer = 'resizer', BaseEdge = 'base-edge'; export const getSmoothStepPath=()=>['M 0 0 L 1 1',0,0];`)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      (context.parentURL === panelUrl ||
        context.parentURL === panelControllerUrl ||
        context.parentURL === canvasSurfaceUrl ||
        context.parentURL === canvasRendererUrl ||
        (specifier === 'react' && context.parentURL?.includes('/src/client/features/authoring/ui/panel/'))) &&
      ['react', '@xyflow/react'].includes(specifier)
    )
      return { url: specifier === 'react' ? reactUrl : flowUrl, shortCircuit: true }
    return next(specifier, context)
  }
})
const { createBlueprintPanel } = await import(panelUrl)
hooks.deregister()
const { findVisibleNodePosition, placePaletteNode, PALETTE_NODE_FOOTPRINT } = await import('../../src/client/features/authoring/logic/graph/node-placement.ts')

const box = (x, y, width, height) => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height })
const DEFAULT_SIZE = { width: 220, height: 183 }
const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
const contains = (rect, point) => rect.left <= point.x && point.x < rect.right && rect.top <= point.y && point.y < rect.bottom
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return undefined
  if (predicate(tree)) return tree
  for (const child of tree.children ?? []) {
    for (const item of Array.isArray(child) ? child : [child]) {
      const found = find(item, predicate)
      if (found) return found
    }
  }
}
async function panelFixture(options = {}) {
  const definition = structuredClone(canvasDefinitions().find(d => d.id === 'canvas-alpha'))
  // Main title diagnostic r1: actual pane, pan/zoom and post-drag Input.
  definition.presentation.nodes.in = { x: 113.431, y: 103.754 }
  validateDefinition(decodeDefinition(JSON.stringify(definition)))
  const pane = options.pane ?? box(504, 52, 818, 918)
  const rootBox = options.root ?? box(280, 0, 1320, 1000)
  const viewport = options.viewport ?? { x: -22.9333, y: 48.095, zoom: 1.13667 }
  const f = {
    states: [],
    refs: [],
    stateCursor: 0,
    refCursor: 0,
    transforms: [],
    viewportMutations: [],
    measuredIds: new Set(definition.graph.nodes.map(n => n.id)),
    sizes: new Map([['in', { width: 220, height: 223 }]]),
    overflow: new Map(),
    overlays: [],
    pane,
    viewport
  }
  const toScreen = point => ({ x: pane.left + viewport.x + point.x * viewport.zoom, y: pane.top + viewport.y + point.y * viewport.zoom })
  f.screenBox = (node, size = f.sizes.get(node.id) ?? DEFAULT_SIZE) => {
    const p = toScreen(node)
    return box(p.x, p.y, size.width * viewport.zoom, size.height * viewport.zoom)
  }
  const wrappers = () =>
    f.workspace.editor.nodes
      .filter(n => f.measuredIds.has(n.id))
      .map(n => ({
        getAttribute: key => (key === 'data-id' ? n.id : null),
        getBoundingClientRect: () => f.screenBox(n),
        querySelectorAll: () =>
          (f.overflow.get(n.id) ?? []).map(rect => ({
            getBoundingClientRect: () => {
              const p = toScreen({ x: n.x + rect.x, y: n.y + rect.y })
              return box(p.x, p.y, rect.width * viewport.zoom, rect.height * viewport.zoom)
            }
          }))
      }))
  f.root = {
    getBoundingClientRect: () => rootBox,
    clientWidth: rootBox.width,
    querySelector: selector => (selector === '.react-flow__pane' ? { getBoundingClientRect: () => pane } : null),
    querySelectorAll: selector =>
      selector === '.react-flow__node'
        ? wrappers()
        : selector === '.react-flow__controls, .react-flow__minimap'
          ? f.overlays.map(rect => ({ getBoundingClientRect: () => rect }))
          : []
  }
  f.flow = {
    screenToFlowPosition(point, config) {
      f.transforms.push({ ...point, config })
      return { x: (point.x - pane.left - viewport.x) / viewport.zoom, y: (point.y - pane.top - viewport.y) / viewport.zoom }
    },
    getNodes: () =>
      f.workspace.editor.nodes.map(n => ({
        id: n.id,
        position: { x: n.x, y: n.y },
        measured: f.measuredIds.has(n.id) ? (f.sizes.get(n.id) ?? DEFAULT_SIZE) : {}
      })),
    getViewport: () => ({ ...viewport }),
    setViewport: () => f.viewportMutations.push('setViewport'),
    fitView: () => f.viewportMutations.push('fitView')
  }
  const host = {
    async listDefinitions() {
      return {
        definitions: [{ blueprintId: definition.id, name: definition.name, documentRevision: 'placement-doc-1', semanticRevision: 'placement-semantic-1' }]
      }
    },
    async loadDefinition(blueprintId) {
      assert.equal(blueprintId, definition.id)
      return {
        blueprintId,
        definitionJson: JSON.stringify(definition),
        documentRevision: 'placement-doc-1',
        semanticRevision: 'placement-semantic-1',
        layoutRevision: 'placement-layout-1'
      }
    }
  }
  const Panel = createBlueprintPanel({ hostLink: host, storage: undefined })
  const owner = { states: [], refs: [], stateCursor: 0, refCursor: 0 }
  f.render = () => {
    seat.active = owner
    owner.stateCursor = owner.refCursor = 0
    const entry = Panel({ t: fixtureT })
    f.workspace = entry.props.workspace
    assert.equal(f.workspace, owner.states[0])
    assert.equal(entry.props.workspaceSnapshot, f.workspace.getSnapshot())
    seat.active = f
    f.stateCursor = f.refCursor = 0
    f.tree = entry.type(entry.props)
    const provider = find(f.tree, el => el.type === 'provider')
    assert.ok(provider)
    if (f.providerKey !== provider.props.key) {
      f.bridgeCleanup?.()
      const bridge = find(provider, el => typeof el.type === 'function' && typeof el.props.onReady === 'function')
      assert.ok(bridge)
      seat.runBridgeEffect = true
      try {
        bridge.type(bridge.props)
      } finally {
        seat.runBridgeEffect = false
      }
      f.providerKey = provider.props.key
      f.stateCursor = f.refCursor = 0
      f.tree = entry.type(entry.props)
    }
    find(f.tree, el => el.props.className === 'bp-workspace').props.ref.current = f.root
    return f.tree
  }
  f.render()
  await f.workspace.initialize()
  await f.workspace.load(definition.id)
  // Preserve the already accepted legal in -> spare connection; Add must not
  // mutate edges, resources or loaded positions to manufacture a free slot.
  assert.equal(
    f.workspace.editor.connect(
      { nodeId: 'in', port: 'request', type: 'string', direction: 'out' },
      { nodeId: 'spare', port: 'value', type: 'string', direction: 'in' }
    ).ok,
    true
  )
  f.render()
  f.clickAdd = kind => {
    f.render()
    const button = find(f.tree, el => el.props['data-bp-action'] === `add-${kind}`)
    assert.equal(button.props.disabled, false)
    button.props.onClick()
    f.render()
    return f.workspace.editor.nodes.at(-1)
  }
  f.toScreen = toScreen
  f.status = () => find(f.render(), el => el.props['data-bp-status'] === 'message').children[0]
  return f
}

test('production palette Add keeps the earlier Input title unobstructed by the following Output at actual pane/pan/zoom', async () => {
  const f = await panelFixture()
  const input = f.clickAdd('input'),
    output = f.clickAdd('output')
  const inputBox = f.screenBox(input),
    outputBox = f.screenBox(output)
  const titleCenter = { x: inputBox.left + inputBox.width / 2, y: inputBox.top + 23 * f.viewport.zoom }
  assert.equal(contains(outputBox, titleCenter), false, 'PRODUCTION_PALETTE_TITLE_OCCLUDED: following Output must not cover the earlier Input title')
  assert.notDeepEqual({ x: input.x, y: input.y }, { x: output.x, y: output.y })
})

function assertVisible(f, node) {
  const rect = f.screenBox(node)
  assert.ok(
    rect.left >= f.pane.left && rect.right <= f.pane.right && rect.top >= f.pane.top && rect.bottom <= f.pane.bottom,
    'new node must fit the real pane, not the library/inspector root'
  )
  assert.deepEqual(f.viewportMutations, [], 'Add never changes viewport/fit to manufacture space')
  assert.ok(
    f.transforms.every(call => call.config?.snapToGrid === false),
    'official screen -> graph conversion is unsnapped and applied once'
  )
}
function assertExistingUnchanged(f, before) {
  const after = f.workspace.editor.exportDefinition()
  assert.deepEqual(after.graph.edges, before.graph.edges, 'legal in -> spare connection and all edges retained')
  assert.deepEqual(after.resources, before.resources)
  assert.deepEqual(after.metadata, before.metadata)
  for (const node of before.graph.nodes) {
    assert.deepEqual(
      after.graph.nodes.find(n => n.id === node.id),
      node
    )
    assert.deepEqual(after.presentation.nodes[node.id], before.presentation.nodes[node.id], 'never reflow existing nodes')
  }
}

test('production Add uses the observed pane rather than the library+inspector root, reserving repeated not-yet-measured additions', async () => {
  const f = await panelFixture(),
    before = structuredClone(f.workspace.editor.exportDefinition())
  const added = ['input', 'output', 'agentTask'].map(kind => f.clickAdd(kind))
  assert.equal(new Set(added.map(n => n.id)).size, 3, 'all three clicks must actually create nodes, not reuse a last-node return after refusal')
  for (const node of added) {
    assert.equal(f.measuredIds.has(node.id), false, 'new nodes intentionally have no DOM/Flow measurement yet')
    assertVisible(f, node)
    for (const other of f.workspace.editor.nodes.filter(n => n !== node)) assert.equal(overlaps(f.screenBox(node), f.screenBox(other)), false)
  }
  assertExistingUnchanged(f, before)
  assert.deepEqual([...f.workspace.editor.selection], [added.at(-1).id], 'existing single-selection behavior remains')
})
for (const viewport of [
  { x: -350, y: 220, zoom: 0.5 },
  { x: 300, y: -200, zoom: 2.2 }
]) {
  test(`production placement accounts for nonzero pane origin/pan and zoom ${viewport.zoom} without changing viewport`, async () => {
    const f = await panelFixture({ pane: box(504, 52, 1200, 1900), root: box(10, -70, 2100, 2250), viewport })
    const input = f.clickAdd('input'),
      output = f.clickAdd('output')
    assert.notEqual(input.id, output.id)
    assertVisible(f, input)
    assertVisible(f, output)
    assert.equal(overlaps(f.screenBox(input), f.screenBox(output)), false)
  })
}

test('production placement uses actual varying node heights and overflowing long port text rather than a blanket default rectangle', async () => {
  const f = await panelFixture()
  f.sizes.set('in', { width: 270, height: 350 })
  f.overflow.set('in', [{ x: -30, y: 90, width: 560, height: 21 }])
  const longPort = 'input.value.with.a.long.valid.port.name'
  f.workspace.editor.updateNode('in', { outputs: { request: 'string', number: 'number', [longPort]: 'string' } })
  const before = structuredClone(f.workspace.editor.exportDefinition()),
    input = f.clickAdd('input')
  assert.ok(!before.graph.nodes.some(n => n.id === input.id), 'Add must execute, not return an existing node')
  assertVisible(f, input)
  const origin = f.toScreen(f.workspace.editor.nodes.find(n => n.id === 'in'))
  const measuredUnion = box(origin.x - 30 * f.viewport.zoom, origin.y, 560 * f.viewport.zoom, 350 * f.viewport.zoom)
  assert.equal(overlaps(f.screenBox(input), measuredUnion), false, 'long port overflow is part of occupied geometry')
  assertExistingUnchanged(f, before)
})

test('rendered footprint wins over stale Flow size, and current editor coordinates own placement after a drag/Undo', async () => {
  const f = await panelFixture()
  f.sizes.set('in', { width: 310, height: 370 })
  f.flow.getNodes = () => f.workspace.editor.nodes.map(n => ({ id: n.id, measured: { width: 1, height: 1 } }))
  const current = f.workspace.editor.nodes.find(n => n.id === 'in')
  const oldPosition = { x: current.x, y: current.y },
    oldRect = f.screenBox(current)
  current.x += 60
  current.y += 120
  const originalQuery = f.root.querySelectorAll
  f.root.querySelectorAll = selector =>
    selector === '.react-flow__node'
      ? originalQuery(selector).map(wrapper => (wrapper.getAttribute('data-id') === 'in' ? { ...wrapper, getBoundingClientRect: () => oldRect } : wrapper))
      : originalQuery(selector)
  const node = f.clickAdd('output')
  assertVisible(f, node)
  assert.equal(overlaps(f.screenBox(node), f.screenBox(current)), false)
  assert.deepEqual({ x: current.x, y: current.y }, { x: oldPosition.x + 60, y: oldPosition.y + 120 })
})

test('production saturated-pane refusal is visible/typed and leaves graph, positions, resources, selection and Undo history untouched', async () => {
  const f = await panelFixture({ pane: box(504, 52, 245, 195), viewport: { x: 0, y: 0, zoom: 1 } })
  f.workspace.editor.toggleSelect('in', false)
  const before = structuredClone(f.workspace.editor.exportDefinition()),
    selection = [...f.workspace.editor.selection]
  assert.deepEqual(placePaletteNode(f.root, f.flow, f.workspace.editor.nodes, new Map()), { ok: false, reason: 'no-space' })
  f.clickAdd('input')
  f.clickAdd('output')
  assert.match(f.status(), /No visible canvas space/)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  assert.deepEqual([...f.workspace.editor.selection], selection)
  assert.equal(f.workspace.editor.undo(), true, 'only the previously accepted connection is in history')
  assert.equal(f.workspace.editor.exportDefinition().graph.edges.length, before.graph.edges.length - 1)
  assert.equal(f.workspace.editor.undo(), false, 'failed Adds pushed no history entries')
  assert.deepEqual(f.viewportMutations, [])
})

test('unknown/unmeasured imported geometry refuses before mutation; partially measured new Add still uses its renderer-owned reservation', async () => {
  const f = await panelFixture(),
    before = structuredClone(f.workspace.editor.exportDefinition())
  f.measuredIds.delete('in')
  assert.deepEqual(placePaletteNode(f.root, f.flow, f.workspace.editor.nodes, new Map()), { ok: false, reason: 'canvas-unmeasured' })
  f.clickAdd('input')
  assert.match(f.status(), /Canvas measurements are not ready/)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  f.measuredIds.add('in')
  const input = f.clickAdd('input'),
    output = f.clickAdd('output')
  assert.notEqual(input.id, output.id)
  assert.equal(overlaps(f.screenBox(input), f.screenBox(output)), false)
  assert.doesNotMatch(f.status(), /not ready/, 'successful Add clears only its previous placement notice')
})

test('changed shape invalidates an unmeasured reservation rather than hiding increased port geometry; measured shape then permits Add', async () => {
  const f = await panelFixture(),
    input = f.clickAdd('input')
  f.workspace.editor.updateNode(input.id, { outputs: { result: 'string', second: 'string', third: 'string' } })
  const before = structuredClone(f.workspace.editor.exportDefinition())
  f.clickAdd('output')
  assert.match(f.status(), /Canvas measurements are not ready/)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  f.sizes.set(input.id, { width: 220, height: 263 })
  f.measuredIds.add(input.id)
  const output = f.clickAdd('output')
  assert.notEqual(input.id, output.id)
  assert.equal(overlaps(f.screenBox(input), f.screenBox(output)), false)
  assertVisible(f, output)
})

test('one Undo/Redo transaction per successful Add preserves existing semantics/positions and restores the same placements', async () => {
  const f = await panelFixture(),
    editor = f.workspace.editor,
    before = structuredClone(editor.exportDefinition())
  const input = f.clickAdd('input'),
    output = f.clickAdd('output'),
    after = structuredClone(editor.exportDefinition())
  assert.equal(editor.undo(), true)
  assert.equal(
    editor.nodes.some(n => n.id === output.id),
    false
  )
  assert.equal(
    editor.nodes.some(n => n.id === input.id),
    true
  )
  assert.equal(editor.undo(), true)
  assert.deepEqual(editor.exportDefinition(), before)
  assert.equal(editor.redo(), true)
  assert.deepEqual(
    editor.nodes.find(n => n.id === input.id),
    input
  )
  assert.equal(editor.redo(), true)
  assert.deepEqual(editor.exportDefinition(), after)
  assertExistingUnchanged(f, before)
})

test('production placement avoids the actually measured Controls/MiniMap overlay without changing either DOM or viewport', async () => {
  const f = await panelFixture()
  const vacant = placePaletteNode(f.root, f.flow, f.workspace.editor.nodes, new Map())
  assert.equal(vacant.ok, true)
  const corner = f.toScreen(vacant.position)
  f.overlays.push(box(corner.x, corner.y, 190 * f.viewport.zoom, 100 * f.viewport.zoom))
  const before = structuredClone(f.overlays),
    node = f.clickAdd('input')
  assert.equal(overlaps(f.screenBox(node), f.overlays[0]), false)
  assert.deepEqual(f.overlays, before)
  assertVisible(f, node)
})

test('empty/hidden pane rejects with canvas-unmeasured before mutation, never a root midpoint fallback', async () => {
  const f = await panelFixture(),
    before = structuredClone(f.workspace.editor.exportDefinition())
  f.root.querySelector = () => null
  f.clickAdd('input')
  assert.match(f.status(), /Canvas measurements are not ready/)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  assert.deepEqual(placePaletteNode(null, f.flow, f.workspace.editor.nodes, new Map()), { ok: false, reason: 'canvas-unmeasured' })
})

test('free-space search accepts compact exact-fit slots and reports true exhaustion without moving blockers or choosing overlaps', () => {
  const footprint = { width: 220, height: 183 },
    visible = { x: -50, y: 100, width: 260, height: 223 }
  assert.deepEqual(findVisibleNodePosition(visible, [], footprint), { x: -30, y: 120 })
  const blocker = { x: -30, y: 120, width: 40, height: 70 },
    before = structuredClone(blocker)
  assert.equal(findVisibleNodePosition(visible, [blocker], footprint), null)
  assert.deepEqual(blocker, before)
  assert.deepEqual(findVisibleNodePosition({ ...visible, width: 650 }, [{ x: -30, y: 120, width: 270, height: 350 }], footprint), { x: 244, y: 120 })
})

test('fallback silhouette has current BlueprintNode/styles rendering provenance for all four fresh palette kinds, not a giant product cap', async () => {
  const source = readFileSync(new URL('../../src/client/shared/styles/base.ts', import.meta.url), 'utf8')
  const match = /export const baseCss =\s*("(?:\\.|[^"\\])*")/s.exec(source)
  assert.ok(match, 'canonical base style fragment must expose the vendor CSS string')
  const css = JSON.parse(match[1])
  assert.match(css, /\.bp-node\{width:220px;/)
  assert.match(css, /\.bp-workspace\{[^}]*line-height:1\.5/)
  assert.match(css, /\.bp-node\{[^}]*font-size:11px/)
  assert.match(css, /\.bp-kind\{[^}]*font-size:9px/)
  assert.match(css, /\.bp-node-title\{padding:8px 12px;[^}]*min-height:40px/)
  assert.match(css, /\.bp-port-row\{[^}]*min-height:40px/)
  assert.match(css, /\.bp-port-columns\{[^}]*padding:4px 0/)
  assert.match(css, /\.bp-node-summary,\.bp-node-state,\.bp-node-note\{padding:2px 12px/)
  assert.deepEqual(PALETTE_NODE_FOOTPRINT, DEFAULT_SIZE)
  for (const kind of ['input', 'output', 'agentTask', 'humanDecision']) {
    const f = await panelFixture(),
      node = f.clickAdd(kind),
      flow = find(f.tree, el => el.type === 'flow')
    const projected = flow.props.nodes.find(n => n.id === node.id)
    const rendered = flow.props.nodeTypes.blueprint({ id: node.id, data: projected.data, selected: true })
    assert.ok(find(rendered, el => el.props.className === 'bp-node-title'))
    const rowCount = tree =>
      (tree?.props?.className?.startsWith('bp-port-row ') ? 1 : 0) +
      (tree?.children ?? []).flat().reduce((count, child) => count + (typeof child === 'object' && child ? rowCount(child) : 0), 0)
    const content = find(rendered, el => el.props['data-bp-node-content'] === node.id)
    const columns = content.children.filter(el => el?.props?.className?.startsWith('bp-port-columns'))
    const control = kind === 'humanDecision'
    assert.equal(columns.length, control ? 2 : 1, 'data section plus effective control section only')
    assert.deepEqual(
      columns.map(section => Math.max(...section.children.map(rowCount))),
      control ? [1, 1] : [1],
      `${kind} visible rows remain parallel`
    )
    assert.equal(
      rowCount(rendered),
      control ? 4 : ['input', 'output'].includes(kind) ? 1 : 2,
      `${kind} retains all visible typed ports; ordinary unconnected control defaults off`
    )
    assertVisible(f, node)
  }
})

function paletteDragEvent(x = 0, y = 0) {
  const values = new Map()
  return {
    clientX: x,
    clientY: y,
    preventDefault() {},
    stopPropagation() {},
    dataTransfer: {
      setData: (key, value) => values.set(key, value),
      getData: key => values.get(key) ?? ''
    }
  }
}

test('palette pointer clicks do not add; a drop uses the exact pan/zoom converted location once and is one Undo', async () => {
  const f = await panelFixture(),
    editor = f.workspace.editor
  const before = editor.exportDefinition(),
    count = editor.nodes.length
  const entry = () => find(f.render(), el => el.props['data-bp-action'] === 'add-agentTask')
  entry().props.onClick({ detail: 1 })
  assert.equal(editor.nodes.length, count, 'pointer activation must not create at an unrelated location')
  assert.equal(entry().props.draggable, true)
  const point = { x: 371.25, y: 210.5 },
    screen = f.toScreen(point),
    event = paletteDragEvent(screen.x, screen.y)
  entry().props.onDragStart(event)
  const surface = find(f.render(), el => el.props['data-bp-canvas'] === 'surface')
  surface.props.onDragOver(event)
  assert.equal(event.dataTransfer.dropEffect, 'copy')
  surface.props.onDrop(event)
  const node = editor.nodes.at(-1)
  assert.equal(node.kind, 'agentTask')
  assert.equal(editor.nodes.length, count + 1)
  assert.ok(Math.abs(node.x - point.x) < 1e-8 && Math.abs(node.y - point.y) < 1e-8)
  assertExistingUnchanged(f, before)
  assert.deepEqual(f.viewportMutations, [])
  surface.props.onDrop(event)
  assert.equal(editor.nodes.length, count + 1, 'a repeated drop cannot replay the creation')
  editor.undo()
  assert.deepEqual(editor.exportDefinition(), before)
  editor.redo()
  assert.equal(editor.nodes.at(-1).id, node.id)
})

test('palette drag cancellation, foreign drops, busy workspace and switched editor never create nodes', async () => {
  const f = await panelFixture()
  const entry = () => find(f.render(), el => el.props['data-bp-action'] === 'add-input')
  const surface = () => find(f.render(), el => el.props['data-bp-canvas'] === 'surface')
  const before = f.workspace.editor.exportDefinition(),
    event = paletteDragEvent(700, 300)
  surface().props.onDrop(event)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  entry().props.onDragStart(event)
  entry().props.onDragEnd()
  surface().props.onDrop(event)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  entry().props.onDragStart(event)
  let releaseBusy
  const busyWork = f.workspace.perform(
    () =>
      new Promise(resolve => {
        releaseBusy = resolve
      })
  )
  surface().props.onDrop(event)
  assert.deepEqual(f.workspace.editor.exportDefinition(), before)
  releaseBusy()
  await busyWork
  entry().props.onDragStart(event)
  f.workspace.newDraft('Drag isolation')
  surface().props.onDrop(event)
  assert.equal(f.workspace.editor.nodes.length, 0)
})

test('sidebar handles hide rather than unmount editor forms, and leave definition and history unchanged', async () => {
  const f = await panelFixture(),
    editor = f.workspace.editor
  const before = editor.exportDefinition(),
    history = [editor.canUndo, editor.canRedo]
  for (const side of ['library', 'inspector']) {
    const toggle = () => find(f.render(), el => el.props['data-bp-action'] === `toggle-${side}`)
    const aside = () => find(f.render(), el => el.props.className === `bp-${side}`)
    assert.equal(toggle().props['aria-expanded'], true)
    toggle().props.onClick()
    assert.equal(aside().props.hidden, true)
    assert.equal(toggle().props['aria-expanded'], false)
    assert.equal(toggle().props['aria-controls'], aside().props.id)
    toggle().props.onClick()
    assert.equal(aside().props.hidden, false)
  }
  assert.deepEqual([editor.canUndo, editor.canRedo], history)
  assert.deepEqual(editor.exportDefinition(), before)
  editor.undo()
  assert.equal(editor.edges.length, before.graph.edges.length - 1, 'Undo still targets the prior connection, not pane visibility')
})
