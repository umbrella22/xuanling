import { selectStyledOption } from './styled-control-entry.mjs'
// Real DSH boot-graph factory only. This module does not mount a standalone
// renderer or synthesize pointer events. page.evaluate is observation/timing,
// never el.click(), mask removal, React injection, or fabricated run state.
import { isDeepStrictEqual } from 'node:util'
import { installCanvasPaintRecorder } from './canvas-timing.mjs'
import { canonicalCanvasGraph, waitForCanvasGraph } from './canvas-readiness.mjs'
import { dismissOnboardingDialogs } from './onboarding-journey.mjs'
import { preparePublicAction, preparePublicDisclosure, prepareRunInput, closePublicMore } from './compact-ui-entry.mjs'

export const BROWSER_ASSERTIONS = [
  'P6d',
  'P6e',
  'P6f',
  'P6g',
  'P6h',
  'P6i',
  'P6j',
  'P6k',
  'B-CSS',
  'B-INVALID',
  'B-KEYBOARD',
  'B-DELETE',
  'B-SELECTION',
  'B-VIEWPORT',
  'B-BINDINGS',
  'B-DRAFT',
  'B-CAS',
  'B-RUN',
  'B-BINDING-SWITCH',
  'B-BINDING-REFRESH',
  'B-BINDING-ASYNC',
  'B-DECISION',
  'B-CANCEL',
  'B-STALE'
]
export const PERFORMANCE_ASSERTIONS = ['P6d', 'B-CSS', 'PERF-FIXTURE', 'PERF-LOAD', 'PERF-PAINT', 'PERF-UNCHANGED']
export const PERFORMANCE_BUDGET = Object.freeze({
  loadMs: 2000,
  paintP95Ms: 100,
  interactions: 20,
  nodes: 200,
  edges: 300,
  resources: 20
})
export function percentile95(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some(v => !Number.isFinite(v) || v < 0)) throw new Error('invalid measured paint samples')
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]
}
function value(response, label) {
  if (response?.status !== 200 || response?.body?.result?.ok !== true)
    throw new Error(`${label}: real RPC failed (${response?.body?.result?.error?.code ?? response?.status})`)
  return response.body.result.value
}
const action = (page, id) => page.locator(`[data-bp-action="${id}"]`)
const canvas = page => page.locator('[data-bp-canvas="surface"]')
const nodes = page => page.locator('[data-bp-node]')
const edges = page => page.locator('.react-flow__edge')
const node = (page, id) => page.locator(`.react-flow__node[data-id="${id}"]`)
async function checkCount(page, selector, count) {
  await page.waitForFunction(({ selector, count }) => document.querySelectorAll(selector).length === count, { selector, count })
}
async function choose(page, id, expectedNodes) {
  await preparePublicAction(page, 'refresh-library')
  await action(page, 'refresh-library').waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('[data-bp-action="refresh-library"]').disabled)
  await closePublicMore(page)
  // The production surface exposes a stable data selector, while the
  // canonical projection fixtures expose the existing accessible combobox
  // contract. Use the data selector in a real browser and retain the role
  // contract for deterministic fixtures that intentionally do not model DOM
  // select behavior on generic locators.
  const select = page.locator('[data-bp-select="blueprint"]')
  await selectStyledOption(page, select, id)
  await checkCount(page, '[data-bp-node]', expectedNodes)
  await page.waitForFunction(() => !document.querySelector('[data-bp-action="save-layout"]').disabled)
}
async function position(page, id) {
  return await node(page, id).evaluate(el => el.style.transform)
}
async function dragNode(page, id, dx = 45, dy = 32) {
  const title = node(page, id).locator('.bp-node-title')
  await title.scrollIntoViewIfNeeded()
  const box = await title.boundingBox()
  if (!box || box.width <= 0 || box.height <= 0) throw new Error('node title is not hit-testable')
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 6 })
  await page.mouse.up()
}
async function connect(page, from, to) {
  const source = page.locator(`[data-bp-port="${from}"].source`)
  const target = page.locator(`[data-bp-port="${to}"].target`)
  const a = await source.boundingBox(),
    b = await target.boundingBox()
  if (!a || !b || a.width <= 0 || b.width <= 0) throw new Error('named handles are not hit-testable')
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 })
  await page.mouse.up()
}
async function panePoint(page) {
  return await canvas(page).evaluate(el => {
    const r = el.getBoundingClientRect()
    for (const [x, y] of [
      [r.right - 35, r.top + 35],
      [r.left + 35, r.top + 35],
      [r.right - 35, r.bottom - 35],
      [r.left + r.width / 2, r.bottom - 25]
    ]) {
      const hit = document.elementFromPoint(x, y)
      if (hit?.closest('.react-flow__pane') && !hit.closest('.react-flow__node,.react-flow__controls,.react-flow__minimap')) return { x, y }
    }
    throw new Error('no unobstructed pane point for genuine pan input')
  })
}
async function cssEvidence(page, assert) {
  const measured = await canvas(page).evaluate(el => {
    const root = el.closest('[data-bp-canvas="root"]')
    const handle = el.querySelector('.react-flow__handle')
    return {
      style: !!document.getElementById('xuanling-blueprint-canvas-css'),
      height: el.getBoundingClientRect().height,
      rootDisplay: getComputedStyle(root).display,
      panePosition: getComputedStyle(el.querySelector('.react-flow__pane')).position,
      handleWidth: handle ? parseFloat(getComputedStyle(handle).width) : 0
    }
  })
  assert(
    'P6d',
    'real mounted React Flow canvas has measurable dimensions and rendered named handles',
    measured.height >= 300 && measured.handleWidth >= 10,
    JSON.stringify(measured)
  )
  assert(
    'B-CSS',
    'packed client closure actually installed the React Flow stylesheet and DSH workspace styles',
    measured.style && measured.rootDisplay === 'flex' && measured.panePosition === 'absolute',
    JSON.stringify(measured)
  )
  return measured
}
async function save(page) {
  await action(page, 'save-layout').click()
  await page.waitForFunction(() => document.querySelector('[data-bp-status="message"]')?.textContent?.includes('Saved host document.'))
}
async function waitRun(page, state) {
  await preparePublicDisclosure(page, 'run')
  try {
    await page.locator(`[data-bp-run="${state}"]`).waitFor({ state: 'visible' })
  } catch (error) {
    const observed = await page.locator('[data-bp-run]').evaluateAll(elements => elements.map(element => ({ state: element.getAttribute('data-bp-run'), text: element.textContent })))
    const notice = await page.locator('[data-bp-status="message"]').textContent().catch(() => '')
    throw new Error(`${error.message}; observedRun=${JSON.stringify(observed)}; notice=${JSON.stringify(notice)}`)
  }
}
function runIdFrom(text) {
  const id = text?.split(' · ')[0]
  if (!id) throw new Error('mounted inspector did not expose a runId')
  return id
}
async function currentRun(page, api) {
  const runId = runIdFrom(await page.locator('[data-bp-run]').textContent())
  return value(await api('inspectRun', { runId }), 'inspectRun')
}

function observeBlueprintRequests(page) {
  const requests = []
  const observe = request => {
    if (!/\/api\/blueprint\//.test(request.url()) || request.method() !== 'POST') return
    const body = request.postDataJSON()
    const args = body?.payload?.args?.args ?? body?.payload?.args
    requests.push({ method: body?.method, runId: args?.runId, blueprintId: args?.blueprintId })
  }
  page.on('request', observe)
  return { requests, stop: () => page.off('request', observe) }
}
async function reopenPanel(page) {
  const panel = page.locator('[data-bp-canvas="root"]')
  if (!(await panel.isVisible().catch(() => false))) await page.getByRole('button', { name: 'XuanLing Blueprint', exact: true }).click()
}
async function unboundCanvas(page) {
  await preparePublicDisclosure(page, 'run')
  return (
    (await page.locator('[data-bp-run="none"]').isVisible()) &&
    (await action(page, 'cancel-run').isDisabled()) &&
    (await page.getByRole('textbox', { name: 'Inspect run ID', exact: true }).inputValue()) === '' &&
    (await page.locator('[data-bp-output]').count()) === 0 &&
    (await page.locator('[data-bp-node-state]').allTextContents()).every(text => text === 'Not running') &&
    (await page.locator('[data-bp-connection="connected"]').isVisible())
  )
}
const readOnlyRequests = requests =>
  requests.length > 0 && !requests.some(r => ['blueprint/startRun', 'blueprint/cancelRun', 'blueprint/decide'].includes(r.method))
async function runBindingJourney(page, assert, api, succeeded, alphaNodeCount) {
  const switching = observeBlueprintRequests(page)
  let switchEvidence
  try {
    await choose(page, 'canvas-alpha', alphaNodeCount)
    const unbound = await unboundCanvas(page)
    await choose(page, 'canvas-beta', 2)
    await waitRun(page, 'succeeded')
    const restored = await currentRun(page, api)
    const binding = await page.evaluate(() => JSON.parse(localStorage.getItem('xuanling-blueprint:recent-run:canvas-beta')))
    switchEvidence = { requests: switching.requests, unbound, binding, restored }
    assert(
      'B-BINDING-SWITCH',
      'changing blueprint clears old run, outputs, node overlay and command entry; returning inspects only its ID-scoped recent run',
      unbound &&
        binding?.blueprintId === 'canvas-beta' &&
        binding?.runId === succeeded.runId &&
        isDeepStrictEqual(restored, succeeded) &&
        readOnlyRequests(switching.requests) &&
        switching.requests.some(r => r.method === 'blueprint/inspectRun' && r.runId === succeeded.runId),
      JSON.stringify(switchEvidence)
    )
  } finally {
    switching.stop()
  }
  const refreshing = observeBlueprintRequests(page)
  let refreshEvidence
  try {
    await page.reload({ waitUntil: 'networkidle' })
    // Configure later persists no key; an empty post-reload DOM is not ready.
    await page.locator('[role="dialog"]:visible').first().waitFor({ state: 'visible', timeout: 3000 })
    await dismissOnboardingDialogs(page)
    await reopenPanel(page)
    await choose(page, 'canvas-beta', 2)
    await waitRun(page, 'succeeded')
    const restored = await currentRun(page, api)
    refreshEvidence = { requests: refreshing.requests, restored }
    assert(
      'B-BINDING-REFRESH',
      'actual page reload re-fetches the bound run via inspect, preserves the entire terminal aggregate and never replays a command',
      isDeepStrictEqual(restored, succeeded) &&
        readOnlyRequests(refreshing.requests) &&
        refreshing.requests.some(r => r.method === 'blueprint/inspectRun' && r.runId === succeeded.runId),
      JSON.stringify(refreshEvidence)
    )
  } finally {
    refreshing.stop()
  }

  // Hold a real host response to an automatic read (not a fabricated snapshot).
  // The panel remains navigable while the background read is in flight.
  let arrived, release
  const responseArrived = new Promise(resolve => {
    arrived = resolve
  })
  const releaseResponse = new Promise(resolve => {
    release = resolve
  })
  let held = false
  const routePattern = '**/api/blueprint/inspectRun'
  const handler = async route => {
    const body = route.request().postDataJSON()
    const args = body?.payload?.args?.args ?? body?.payload?.args
    if (held || args?.runId !== succeeded.runId) {
      await route.continue()
      return
    }
    held = true
    const response = await route.fetch()
    arrived()
    await releaseResponse
    await route.fulfill({ response })
  }
  await page.route(routePattern, handler)
  let asyncEvidence
  try {
    // Bound the wait without a sleep: the existing read-only 750ms refresh must
    // reach the host, or this is a failed gate, not a missing-case pass.
    let timer
    try {
      await Promise.race([
        responseArrived,
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('background inspect did not reach the real host')), 5000)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
    await choose(page, 'canvas-alpha', alphaNodeCount)
    const beforeRelease = await unboundCanvas(page)
    const completed = page.waitForResponse(response => response.url().includes('/api/blueprint/inspectRun'))
    release()
    await completed
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const afterRelease = await unboundCanvas(page)
    const terminalAfter = value(await api('inspectRun', { runId: succeeded.runId }), 'late read terminal inspection')
    asyncEvidence = { held, beforeRelease, afterRelease, terminalAfter }
    assert(
      'B-BINDING-ASYNC',
      'a delayed genuine inspect cannot overwrite the later blueprint, overlay or connection status, and cannot mutate its terminal host aggregate',
      held && beforeRelease && afterRelease && isDeepStrictEqual(terminalAfter, succeeded),
      JSON.stringify(asyncEvidence)
    )
  } finally {
    release()
    await page.unroute(routePattern, handler)
  }
  return { switch: switchEvidence, refresh: refreshEvidence, asynchronous: asyncEvidence }
}

// JsonEditor mounts CodeMirror only after its wrapper enters the viewport.
// Use ordinary scrolling and the public contenteditable, never textarea APIs.
export async function prepareNodeOptionsEditor(page) {
  const summary = page.locator('[data-bp-inspector-advanced]')
  if (await summary.locator('..').getAttribute('open') === null) await summary.click()
  await page.locator('.bp-node-inspector [data-bp-json-editor]').last().scrollIntoViewIfNeeded()
  const editor = page.locator('[data-bp-json="options"][contenteditable="true"]')
  await editor.waitFor({ state: 'visible' })
  return editor
}

export async function runCanvasJourney(page, assert, api) {
  const trace = []
  await choose(page, 'canvas-alpha', 3)
  const loaded = value(await api('loadDefinition', { blueprintId: 'canvas-alpha' }), 'load alpha')
  trace.push({ action: 'load', id: 'canvas-alpha', document: loaded })
  const canonicalGraph = canonicalCanvasGraph(JSON.parse(loaded.definitionJson))
  const connectionHandles = [
    { nodeId: 'in', handleId: 'data:request', direction: 'source' },
    { nodeId: 'in', handleId: 'data:number', direction: 'source' },
    { nodeId: 'spare', handleId: 'data:value', direction: 'target' },
    { nodeId: 'out', handleId: 'data:value', direction: 'target' }
  ]
  let graph = await waitForCanvasGraph(page, canonicalGraph, { handles: connectionHandles })
  const css = await cssEvidence(page, assert)
  const search = page.getByRole('textbox', { name: 'Search nodes', exact: true })
  await search.fill('input')
  await action(page, 'add-input').press('Enter')
  const withInput = await waitForCanvasGraph(page, graph, {
    addedNodeKind: 'input',
    handles: connectionHandles
  })
  const newInput = withInput.nodes.find(n => !graph.nodes.some(previous => previous.id === n.id)).id
  graph = withInput
  await search.fill('output')
  await action(page, 'add-output').press('Enter')
  graph = await waitForCanvasGraph(page, graph, {
    addedNodeKind: 'output',
    handles: connectionHandles
  })
  const countAfterAdd = await nodes(page).count()
  assert(
    'P6e',
    'palette search and native keyboard activation create supported nodes in the actual DSH canvas',
    countAfterAdd === 5 && (await action(page, 'add-agentTask').count()) === 0,
    `3 -> ${countAfterAdd}`
  )
  await search.fill('')
  graph = await waitForCanvasGraph(page, graph, { handles: connectionHandles })
  const beforeEdges = canonicalGraph.edges.length
  const requestedEdge = {
    kind: 'data',
    source: 'in',
    target: 'spare',
    sourceHandle: 'data:request',
    targetHandle: 'data:value'
  }
  await connect(page, 'in:data:request', 'spare:data:value')
  await checkCount(page, '.react-flow__edge', beforeEdges + 1)
  graph = await waitForCanvasGraph(page, { ...graph, edges: [...graph.edges, requestedEdge] }, { handles: connectionHandles })
  const requestedEndpoint = graph.edges.some(
    e =>
      e.kind === requestedEdge.kind &&
      e.source === requestedEdge.source &&
      e.target === requestedEdge.target &&
      e.sourceHandle === requestedEdge.sourceHandle &&
      e.targetHandle === requestedEdge.targetHandle
  )
  assert(
    'P6f',
    'dragging legal named source/target handles adds the typed data edge',
    (await edges(page).count()) === beforeEdges + 1 && requestedEndpoint,
    JSON.stringify({ count: await edges(page).count(), requestedEdge, renderedEdges: graph.edges })
  )
  await connect(page, 'in:data:number', 'spare:data:value')
  await connect(page, 'in:data:request', 'out:data:value')
  await waitForCanvasGraph(page, graph, { handles: connectionHandles })
  assert(
    'B-INVALID',
    'type mismatch and duplicate edge are refused by real handles, leaving valid edges unchanged',
    (await edges(page).count()) === beforeEdges + 1,
    'number -> string and duplicate string connection'
  )
  const beforeDrag = await position(page, 'in')
  await dragNode(page, 'in')
  const afterDrag = await position(page, 'in')
  await action(page, 'undo').click()
  const afterUndo = await position(page, 'in')
  await action(page, 'redo').click()
  const afterRedo = await position(page, 'in')
  assert(
    'P6g',
    'one real pointer drag is exactly one Undo/Redo transaction',
    beforeDrag !== afterDrag && afterUndo === beforeDrag && afterRedo === afterDrag,
    JSON.stringify({ beforeDrag, afterDrag, afterUndo, afterRedo })
  )
  const command = process.platform === 'darwin' ? 'Meta' : 'Control'
  await waitForCanvasGraph(page, graph)
  const keyboardCount = graph.nodes.length
  await search.fill('input')
  await search.press(`${command}+z`)
  await search.press('Delete')
  await prepareRunInput(page)
  const input = page.getByRole('textbox', { name: 'Run input JSON', exact: true })
  await input.fill('{"request":"keyboard protection"}')
  await input.press(`${command}+z`)
  await input.press('Delete')
  assert(
    'B-KEYBOARD',
    'Undo/Delete in input and textarea never mutate the canvas or steal text editing',
    (await nodes(page).count()) === keyboardCount && (await position(page, 'in')) === afterDrag,
    'actual keyboard in palette search and run input'
  )
  await search.fill('')
  await node(page, newInput).locator('.bp-node-title').click()
  await page.keyboard.press('Delete')
  await checkCount(page, '[data-bp-node]', keyboardCount - 1)
  await waitForCanvasGraph(page, {
    nodes: graph.nodes.filter(n => n.id !== newInput),
    edges: graph.edges.filter(e => e.source !== newInput && e.target !== newInput)
  })
  await action(page, 'undo').click()
  await waitForCanvasGraph(page, graph)
  assert(
    'B-DELETE',
    'real node selection/Delete removes only selected items, and Undo restores the complete edit',
    (await nodes(page).count()) === keyboardCount,
    `selected=${newInput}`
  )
  await canvas(page).focus()
  await page.keyboard.press('Escape')
  assert(
    'P6h',
    'canvas keyboard Escape clears selection instead of changing the graph',
    (await page.locator('.react-flow__node.selected').count()) === 0 && (await nodes(page).count()) === keyboardCount,
    'keyboard focus on canvas'
  )
  // Controlled node/edge props must apply actual selection deltas. Observe the
  // path geometry only to target a genuine pointer; never invoke el.click().
  await waitForCanvasGraph(page, graph)
  const beforeSelectionEdges = graph.edges.length
  const edgePoint = await edges(page)
    .first()
    .locator('.react-flow__edge-interaction')
    .evaluate(path => {
      const point = path.getPointAtLength(path.getTotalLength() / 2)
      const matrix = path.getScreenCTM()
      if (!matrix) throw new Error('edge has no mounted screen transform')
      const screen = point.matrixTransform(matrix)
      return { x: screen.x, y: screen.y }
    })
  await page.mouse.click(edgePoint.x, edgePoint.y)
  await checkCount(page, '.react-flow__edge.selected', 1)
  const selectedEdgeId = await page.locator('.react-flow__edge.selected').getAttribute('data-id')
  await canvas(page).focus()
  await page.keyboard.press('Delete')
  await checkCount(page, '.react-flow__edge', beforeSelectionEdges - 1)
  await waitForCanvasGraph(page, {
    ...graph,
    edges: graph.edges.filter(e => e.id !== selectedEdgeId)
  })
  const edgeDeleteOnly = (await nodes(page).count()) === keyboardCount
  await action(page, 'undo').click()
  await checkCount(page, '.react-flow__edge', beforeSelectionEdges)
  await waitForCanvasGraph(page, graph)
  await node(page, 'in').locator('.bp-node-title').click()
  await page.keyboard.down(command)
  try {
    await node(page, 'spare').locator('.bp-node-title').click()
  } finally {
    await page.keyboard.up(command)
  }
  await checkCount(page, '.react-flow__node.selected', 2)
  const selectedIds = await page.locator('.react-flow__node.selected').evaluateAll(items => items.map(item => item.getAttribute('data-id')).sort())
  await canvas(page).focus()
  await page.keyboard.press('Delete')
  await checkCount(page, '[data-bp-node]', keyboardCount - 2)
  await waitForCanvasGraph(page, {
    nodes: graph.nodes.filter(n => !['in', 'spare'].includes(n.id)),
    edges: graph.edges.filter(e => !['in', 'spare'].includes(e.source) && !['in', 'spare'].includes(e.target))
  })
  const multiDeleteOnly = (await node(page, 'in').count()) === 0 && (await node(page, 'spare').count()) === 0 && (await node(page, 'out').count()) === 1
  await action(page, 'undo').click()
  await checkCount(page, '[data-bp-node]', keyboardCount)
  await checkCount(page, '.react-flow__edge', beforeSelectionEdges)
  await waitForCanvasGraph(page, graph)
  assert(
    'B-SELECTION',
    'genuine edge and modifier multi-node selection drive precise Delete/Undo through controlled React Flow props',
    edgeDeleteOnly && multiDeleteOnly && isDeepStrictEqual(selectedIds, ['in', 'spare']) && (await edges(page).count()) === beforeSelectionEdges,
    JSON.stringify({
      selectedIds,
      edgeDeleteOnly,
      multiDeleteOnly,
      restoredEdges: beforeSelectionEdges
    })
  )
  await canvas(page).focus()
  await page.keyboard.press('Escape')
  const viewport = page.locator('.react-flow__viewport')
  const initialViewport = await viewport.getAttribute('style')
  const point = await panePoint(page)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x - 38, point.y + 25, { steps: 6 })
  await page.mouse.up()
  const afterPan = await viewport.getAttribute('style')
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, -180)
  await page.waitForFunction(before => document.querySelector('.react-flow__viewport').getAttribute('style') !== before, afterPan)
  const afterZoom = await viewport.getAttribute('style')
  await page.getByRole('button', { name: 'Fit View', exact: true }).click()
  assert(
    'B-VIEWPORT',
    'genuine pane pan, wheel zoom and fit controls change viewport without editing graph',
    initialViewport !== afterPan && afterPan !== afterZoom && (await nodes(page).count()) === keyboardCount,
    JSON.stringify({ initialViewport, afterPan, afterZoom })
  )

  // Agent/Skill/toolset options are document facts; preserve every field.
  await search.fill('agent')
  await action(page, 'add-agentTask').press('Enter')
  await search.fill('')
  const withAgent = await waitForCanvasGraph(page, graph, { addedNodeKind: 'agentTask' })
  const agentId = withAgent.nodes.find(n => !graph.nodes.some(previous => previous.id === n.id)).id
  await selectStyledOption(page, page.getByRole('combobox', { name: 'Agent binding', exact: true }), 'a')
  await page.getByRole('checkbox', { name: 'Skill · skill', exact: true }).check()
  await page.locator('[data-bp-action="add-resource"]').click()
  await page.getByRole('textbox', { name: 'New resource ID', exact: true }).fill('tools')
  await selectStyledOption(page, page.getByRole('combobox', { name: 'Resource type', exact: true }), 'mcp')
  await page.getByRole('textbox', { name: 'New resource JSON', exact: true }).fill('{"kind":"mcp","bindingId":"bp_probe"}')
  await page.locator('[data-bp-action="resource-apply"]').click()
  const options = await prepareNodeOptionsEditor(page)
  const edited = JSON.parse(await options.innerText())
  edited.toolsetRefs = ['tools']
  await options.fill(JSON.stringify(edited))
  await options.press('Tab')
  await page.locator('[data-bp-resource-row="blueprint:a"]').click()
  const resource = page.getByRole('textbox', { name: 'New resource JSON', exact: true })
  const originalResource = JSON.parse(await resource.innerText())
  await resource.fill(JSON.stringify(originalResource))
  await page.locator('[data-bp-action="resource-apply"]').click()
  await save(page)
  const saved = value(await api('loadDefinition', { blueprintId: 'canvas-alpha' }), 'load saved alpha')
  const savedDefinition = JSON.parse(saved.definitionJson)
  const savedAgent = savedDefinition.graph.nodes.find(n => n.id === agentId)
  assert(
    'B-BINDINGS',
    'actual inspector edits persist Agent/Skill/toolset bindings, resources and existing metadata through document CAS',
    savedAgent?.agentRef === 'a' &&
      isDeepStrictEqual(savedAgent?.skillRefs, ['skill']) &&
      isDeepStrictEqual(savedAgent?.toolsetRefs, ['tools']) &&
      isDeepStrictEqual(savedDefinition.resources.a, originalResource) &&
      savedDefinition.resources.tools?.bindingId === 'bp_probe' &&
      savedDefinition.metadata?.retained?.note === 'Keep all existing document fields',
    JSON.stringify(savedAgent)
  )
  const localDraft = await page.evaluate(id => JSON.parse(localStorage.getItem(`xuanling-blueprint:draft:${encodeURIComponent(id)}`)), 'canvas-alpha')
  assert(
    'P6j',
    'Save persists the host document and an ID-scoped draft with the exact document revision',
    localDraft?.documentRevision === saved.documentRevision && !!localDraft.layout?.nodes && !!localDraft.definitionJson,
    `CAS=${saved.documentRevision}`
  )
  assert(
    'P6k',
    'resource browser and durable run inspector render genuine host-backed sections',
    (await page.locator('[data-bp-section="resources"]').isVisible()) && (await page.locator('[data-bp-section="run"]').isVisible()),
    'no invented logs or provider success'
  )
  assert(
    'P6i',
    'canvas reports honest loaded/saved/typed status text, not fabricated success',
    (await page.locator('[data-bp-status="message"]').textContent()).includes('Saved host document.'),
    await page.locator('[data-bp-status="message"]').textContent()
  )

  // Reopen a local unsaved layout: it cannot consume an Undo or leak into beta.
  await dragNode(page, 'in', 27, 19)
  const draftPosition = await position(page, 'in')
  await page.reload({ waitUntil: 'networkidle' })
  // Use the unchanged onboarding action bound before native panel navigation.
  await page.locator('[role="dialog"]:visible').first().waitFor({ state: 'visible', timeout: 3000 })
  await dismissOnboardingDialogs(page)
  const panel = page.locator('[data-bp-canvas="root"]')
  if (!(await panel.isVisible().catch(() => false))) await page.getByRole('button', { name: 'XuanLing Blueprint', exact: true }).click()
  await choose(page, 'canvas-alpha', savedDefinition.graph.nodes.length)
  const restoredPosition = await position(page, 'in')
  const restoredNoUndo = await action(page, 'undo').isDisabled()
  await choose(page, 'canvas-beta', 2)
  const betaDoc = value(await api('loadDefinition', { blueprintId: 'canvas-beta' }), 'load beta')
  const betaDraft = await page.evaluate(() => localStorage.getItem('xuanling-blueprint:draft:canvas-beta'))
  await choose(page, 'canvas-alpha', savedDefinition.graph.nodes.length)
  assert(
    'B-DRAFT',
    'real page reopen restores the ID-scoped local draft without Undo; switching IDs cannot contaminate another package',
    restoredPosition === draftPosition &&
      restoredNoUndo &&
      (await position(page, 'in')) === restoredPosition &&
      JSON.parse(betaDoc.definitionJson).presentation.nodes.in.x === 80 &&
      betaDraft === null,
    JSON.stringify({ draftPosition, restoredPosition, restoredNoUndo })
  )

  // Genuine second writer produces a document CAS conflict; browser must keep
  // its local draft and must not overwrite the new host document.
  const concurrent = JSON.parse(saved.definitionJson)
  concurrent.presentation.nodes.in.x += 17
  const external = value(
    await api('saveDefinition', {
      blueprintId: 'canvas-alpha',
      definitionJson: JSON.stringify(concurrent),
      expectedRevision: saved.documentRevision
    }),
    'external CAS writer'
  )
  await action(page, 'save-layout').click()
  await page.waitForFunction(() => document.querySelector('[data-bp-status="message"]').textContent.includes('blueprint/revision-conflict'))
  const conflictDoc = value(await api('loadDefinition', { blueprintId: 'canvas-alpha' }), 'load after CAS conflict')
  assert(
    'B-CAS',
    'typed CAS conflict preserves the local canvas draft and the concurrent host document, never last-write-wins',
    conflictDoc.documentRevision === external.documentRevision &&
      conflictDoc.definitionJson === external.definitionJson &&
      (await position(page, 'in')) === restoredPosition,
    'blueprint/revision-conflict'
  )
  trace.push({ action: 'CAS-conflict', documentRevision: conflictDoc.documentRevision })

  await choose(page, 'canvas-beta', 2)
  await prepareRunInput(page)
  await page.getByRole('textbox', { name: 'Run input JSON', exact: true }).fill('{"request":"real mounted run"}')
  await action(page, 'start-run').click()
  await waitRun(page, 'succeeded')
  const succeeded = await currentRun(page, api)
  const betaSaved = value(await api('loadDefinition', { blueprintId: 'canvas-beta' }), 'load run document')
  assert(
    'B-RUN',
    'real Run saves first and inspector observes the host durable result/attempt outputs for that semantic revision',
    succeeded.state === 'succeeded' &&
      succeeded.definitionRevision === betaSaved.semanticRevision &&
      succeeded.attempts.length === 2 &&
      succeeded.attempts.every(a => a.state === 'succeeded') &&
      succeeded.attempts.some(a => a.outputJson?.includes('real mounted run')),
    JSON.stringify(succeeded)
  )
  await prepareRunInput(page)
  await page.getByRole('textbox', { name: 'Inspect run ID', exact: true }).fill(succeeded.runId)
  await action(page, 'inspect-run').click()
  const inspectedAgain = await currentRun(page, api)
  if (!isDeepStrictEqual(inspectedAgain, succeeded)) throw new Error('read-only inspect mutated the successful terminal aggregate')

  const binding = await runBindingJourney(page, assert, api, succeeded, savedDefinition.graph.nodes.length)

  await choose(page, 'canvas-approval', 2)
  await prepareRunInput(page)
  await page.getByRole('textbox', { name: 'Run input JSON', exact: true }).fill('{}')
  await action(page, 'start-run').click()
  await waitRun(page, 'waiting_input')
  const waiting = await currentRun(page, api)
  await action(page, 'approve').click()
  await waitRun(page, 'succeeded')
  const approved = await currentRun(page, api)
  assert(
    'B-DECISION',
    'real Approve consumes the durable waiting node, persists decision and resumes to a host terminal',
    waiting.attempts.some(a => a.nodeId === 'gate' && a.state === 'waiting_input') &&
      approved.runId === waiting.runId &&
      approved.state === 'succeeded' &&
      approved.seq > waiting.seq &&
      approved.logTail.some(l => l.kind === 'decision'),
    JSON.stringify(approved)
  )
  // Different input guarantees a distinct admission without depending on UUID.
  await prepareRunInput(page)
  await page.getByRole('textbox', { name: 'Run input JSON', exact: true }).fill('{"cancelCase":true}')
  await action(page, 'start-run').click()
  await waitRun(page, 'waiting_input')
  const beforeCancel = await currentRun(page, api)
  await action(page, 'cancel-run').click()
  // The UI action dispatches the RPC asynchronously. Wait for the durable
  // terminal projection before taking the explicit inspect snapshot, so the
  // assertion observes cancellation settlement rather than a legitimate
  // read that raced the request in flight.
  await waitRun(page, 'cancelled')
  const afterCancelRpc = value(await api('inspectRun', { runId: beforeCancel.runId }), 'inspect cancelled run after cancel RPC')
  const cancelled = await currentRun(page, api)
  assert(
    'B-CANCEL',
    'real Cancel settles a waiting run and inspector reads the durable cancelled aggregate',
    beforeCancel.runId !== approved.runId && afterCancelRpc.runId === beforeCancel.runId && afterCancelRpc.state === 'cancelled'
      && cancelled.runId === beforeCancel.runId && cancelled.state === 'cancelled' && cancelled.seq > beforeCancel.seq,
    JSON.stringify({ afterCancelRpc, cancelled })
  )
  await page.context().setOffline(true)
  try {
    await page.locator('[data-bp-connection="stale"]').waitFor({ state: 'visible' })
  } finally {
    await page.context().setOffline(false)
  }
  await action(page, 'retry-inspect').click()
  await page.locator('[data-bp-connection="connected"]').waitFor({ state: 'visible' })
  const afterReconnect = await currentRun(page, api)
  assert(
    'B-STALE',
    'real network loss shows stale; reconnect/retry only inspect and leaves the entire terminal aggregate unchanged',
    isDeepStrictEqual(afterReconnect, cancelled),
    'offline -> stale -> read-only reconnect'
  )
  trace.push({
    action: 'runs',
    succeeded: succeeded.runId,
    approved: approved.runId,
    cancelled: cancelled.runId
  })
  return {
    provenance: 'real DSH boot graph + system Edge; Playwright mouse/keyboard, no DOM-native clicks',
    css,
    trace,
    binding
  }
}

export async function measureCanvasPerformance(page, assert, fixture, api) {
  if (!fixture || fixture.nodes !== 200 || fixture.edges !== 300 || fixture.resources < 20)
    throw new Error('performance fixture does not satisfy frozen contract')
  // Measure from the actual change handler that initiates ID loading, not from
  // page boot, installation time, or a fabricated timeout. Two rAFs provide a
  // paint completion upper bound; MutationObserver discovers the complete DOM.
  await page.evaluate(() => {
    const select = document.querySelector('[data-bp-select="blueprint"]')
    const canvas = document.querySelector('[data-bp-canvas="surface"]')
    if (!select || !canvas) throw new Error('performance journey could not locate the mounted blueprint picker/canvas')
    window.__bpPerf = { samples: [], loadStart: null, loadMs: null }
    document.addEventListener(
      'click',
      function beginLoad(event) {
        if (!event.target.closest?.('[data-bp-option-value="canvas-performance"]')) return
        document.removeEventListener('click', beginLoad, true)
        const perf = window.__bpPerf
        perf.loadStart = performance.now()
        const check = () => {
          const n = [...document.querySelectorAll('.react-flow__node')]
          if (
            n.length !== 200 ||
            document.querySelectorAll('.react-flow__edge').length !== 300 ||
            !n.every(el => el.getBoundingClientRect().width > 0 && el.querySelector('.react-flow__handle'))
          )
            return
          observer.disconnect()
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              perf.loadMs = performance.now() - perf.loadStart
            })
          )
        }
        const observer = new MutationObserver(check)
        observer.observe(canvas, { childList: true, subtree: true, attributes: true })
        check()
      },
      { capture: true }
    )
  })
  await choose(page, 'canvas-performance', 200)
  await page.waitForFunction(() => Number.isFinite(window.__bpPerf?.loadMs))
  const css = await cssEvidence(page, assert)
  const beforeDocument = await page.locator('[data-bp-dirty]').getAttribute('data-bp-dirty')
  const canonicalBefore = value(await api('loadDefinition', { blueprintId: 'canvas-performance' }), 'performance canonical before')
  if (!isDeepStrictEqual(JSON.parse(canonicalBefore.definitionJson), JSON.parse(fixture.json)))
    throw new Error('mounted performance document differs from the production-validated fixture')
  assert(
    'PERF-FIXTURE',
    'all 200 nodes, 300 named edges and 20 resources are mounted, not replaced/hidden to satisfy budget',
    (await nodes(page).count()) === 200 && (await edges(page).count()) === 300 && (await page.locator('[data-bp-resource-row]').count()) >= 20,
    JSON.stringify({
      nodes: fixture.nodes,
      edges: fixture.edges,
      resources: fixture.resources,
      generator: fixture.generator,
      sha256: fixture.sha256
    })
  )
  const loadMs = await page.evaluate(() => window.__bpPerf.loadMs)
  assert(
    'PERF-LOAD',
    'real configured-document load through DSH mounted canvas is <= 2000ms',
    Number.isFinite(loadMs) && loadMs > 0 && loadMs <= PERFORMANCE_BUDGET.loadMs,
    `${loadMs}ms <= ${PERFORMANCE_BUDGET.loadMs}ms`
  )
  await page.evaluate(installCanvasPaintRecorder)
  const viewports = []
  for (let i = 0; i < PERFORMANCE_BUDGET.interactions; i++) {
    const point = await panePoint(page)
    const before = await page.locator('.react-flow__viewport').getAttribute('style')
    await page.mouse.move(point.x, point.y)
    await page.evaluate(({ index, kind }) => window.__bpPaint.arm(index, kind), {
      index: i,
      kind: i % 2 === 0 ? 'pan' : 'zoom'
    })
    if (i % 2 === 0) {
      await page.mouse.down()
      await page.mouse.move(point.x + (i % 4 === 0 ? -24 : 24), point.y + 18, { steps: 3 })
      await page.mouse.up()
    } else await page.mouse.wheel(0, i % 4 === 1 ? -70 : 70)
    await page.waitForFunction(count => window.__bpPerf.samples.length === count + 1, i)
    const after = await page.locator('.react-flow__viewport').getAttribute('style')
    viewports.push({ before, after })
  }
  const samples = await page.evaluate(() => {
    window.__bpPaint.dispose()
    return window.__bpPerf.samples
  })
  const p95 = percentile95(samples.map(s => s.latencyMs))
  const valid =
    samples.length === 20 &&
    samples.every(
      (s, i) => s.trusted && s.index === i && s.type === (i % 2 === 0 ? 'pointermove' : 'wheel') && s.before !== s.after && s.changeObservedAt >= s.startMs
    ) &&
    viewports.every(v => v.before !== v.after)
  assert(
    'PERF-PAINT',
    '20 genuine mouse pan/wheel zoom interactions have rAF paint-latency p95 <= 100ms',
    valid && p95 <= PERFORMANCE_BUDGET.paintP95Ms,
    JSON.stringify({
      sampleCount: samples.length,
      trusted: samples.every(s => s.trusted),
      p95,
      budget: PERFORMANCE_BUDGET.paintP95Ms
    })
  )
  const canonicalAfter = value(await api('loadDefinition', { blueprintId: 'canvas-performance' }), 'performance canonical after')
  assert(
    'PERF-UNCHANGED',
    'pan/zoom preserves every mounted node/edge/resource and does not dirty the definition',
    isDeepStrictEqual(canonicalBefore, canonicalAfter) &&
      beforeDocument === 'false' &&
      (await page.locator('[data-bp-dirty]').getAttribute('data-bp-dirty')) === 'false' &&
      (await nodes(page).count()) === 200 &&
      (await edges(page).count()) === 300 &&
      (await page.locator('[data-bp-resource-row]').count()) >= 20,
    'presentation viewport is transient, no semantics deleted'
  )
  return {
    provenance: 'real DSH closure factory, full mounted React Flow; trusted Playwright pan/wheel events',
    budget: PERFORMANCE_BUDGET,
    measured: { loadMs, paintP95Ms: p95 },
    samples,
    viewports,
    css,
    fixture,
    canonicalUnchanged: isDeepStrictEqual(canonicalBefore, canonicalAfter)
  }
}
