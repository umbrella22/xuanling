// Canonical graph facts are the oracle; the asynchronously rendered DOM is a
// projection to wait for, never the source of an incremental count baseline.
export function canonicalCanvasGraph(definition) {
  return {
    nodes: definition.graph.nodes.map(({ id, kind }) => ({ id, kind })),
    edges: definition.graph.edges.map(({ kind, from, to }) => {
      if (kind === 'control') {
        const at = from.indexOf('@')
        return { kind, source: at < 0 ? from : from.slice(0, at), target: to,
          sourceHandle: `control:${at < 0 ? 'control' : from.slice(at + 1)}`, targetHandle: 'control:control' }
      }
      // The public endpoint delimiter is the FIRST dot; a port may contain dots.
      const sourceDot = from.indexOf('.'), targetDot = to.indexOf('.')
      return { kind, source: from.slice(0, sourceDot), target: to.slice(0, targetDot),
        sourceHandle: `data:${from.slice(sourceDot + 1)}`, targetHandle: `data:${to.slice(targetDot + 1)}` }
    }),
  }
}

// Self-contained for Playwright serialization. Observation only: no DOM writes,
// React internals, injected store, synthetic events, sleeps or timeout overrides.
// React Flow exposes node identity/handle attributes and the actual SVG path,
// but not handle IDs on the edge <g>. Resolve the rendered path's two endpoints
// to uniquely named handles in screen coordinates, not just its generic count.
export function renderedCanvasGraphReady({ graph, addedNodeKind, handles = [] }) {
  const root = document.querySelector('[data-bp-canvas="surface"]')
  if (!root) return false
  const nodes = Array.from(root.querySelectorAll('[data-bp-node]'), el => ({ id: el.getAttribute('data-bp-node'), kind: el.getAttribute('data-bp-kind') }))
  if (nodes.length !== graph.nodes.length + (addedNodeKind ? 1 : 0) || new Set(nodes.map(n => n.id)).size !== nodes.length) return false
  if (!graph.nodes.every(n => nodes.some(actual => actual.id === n.id && actual.kind === n.kind))) return false
  const addedNodes = nodes.filter(n => !graph.nodes.some(expected => expected.id === n.id))
  if (addedNodeKind && (addedNodes.length !== 1 || !addedNodes[0].id || addedNodes[0].kind !== addedNodeKind)) return false

  const namedHandles = Array.from(root.querySelectorAll('.react-flow__handle')).flatMap(el => {
    const nodeId = el.getAttribute('data-nodeid'), handleId = el.getAttribute('data-handleid')
    const direction = el.classList.contains('source') ? 'source' : el.classList.contains('target') ? 'target' : null
    if (!nodeId || !handleId || !direction || el.getAttribute('data-bp-port') !== `${nodeId}:${handleId}`
      || el.closest('.react-flow__node')?.getAttribute('data-id') !== nodeId) return []
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return []
    const position = el.getAttribute('data-handlepos')
    const x = position === 'left' ? r.left : position === 'right' ? r.right : r.left + r.width / 2
    const y = position === 'top' ? r.top : position === 'bottom' ? r.bottom : r.top + r.height / 2
    if (!['left', 'right', 'top', 'bottom'].includes(position) || !Number.isFinite(x) || !Number.isFinite(y)) return []
    return [{ nodeId, handleId, direction, x, y }]
  })
  if (!handles.every(expected => namedHandles.filter(h => h.nodeId === expected.nodeId && h.handleId === expected.handleId && h.direction === expected.direction).length === 1)) return false
  const edgeElements = Array.from(root.querySelectorAll('.react-flow__edge'))
  if (edgeElements.length !== graph.edges.length) return false
  const edges = []
  // One CSS pixel only accommodates DOM/SVG coordinate rounding; it is not a
  // connection-distance or domain identity tolerance. Ambiguous handles fail.
  const atPoint = (handle, point) => Math.abs(handle.x - point.x) <= 1 && Math.abs(handle.y - point.y) <= 1
  for (const el of edgeElements) {
    const path = el.querySelector('.react-flow__edge-path'), id = el.getAttribute('data-id')
    if (!path || !id) return false
    const matrix = path.getScreenCTM(), length = path.getTotalLength()
    if (!matrix || !Number.isFinite(length) || length <= 0) return false
    const start = path.getPointAtLength(0).matrixTransform(matrix), end = path.getPointAtLength(length).matrixTransform(matrix)
    const sources = namedHandles.filter(h => h.direction === 'source' && atPoint(h, start))
    const targets = namedHandles.filter(h => h.direction === 'target' && atPoint(h, end))
    const pairs = sources.flatMap(source => targets.filter(target => el.getAttribute('aria-label') === `Edge from ${source.nodeId} to ${target.nodeId}`).map(target => ({ source, target })))
    if (pairs.length !== 1) return false
    const kind = el.classList.contains('bp-edge-data') ? 'data' : el.classList.contains('bp-edge-control') ? 'control' : null
    if (!kind) return false
    const { source, target } = pairs[0]
    edges.push({ id, kind, source: source.nodeId, target: target.nodeId, sourceHandle: source.handleId, targetHandle: target.handleId })
  }
  if (new Set(edges.map(e => e.id)).size !== edges.length) return false
  const matched = graph.edges.map(expected => edges.filter(actual => actual.kind === expected.kind && actual.source === expected.source && actual.target === expected.target
    && actual.sourceHandle === expected.sourceHandle && actual.targetHandle === expected.targetHandle && (!expected.id || actual.id === expected.id)))
  if (matched.some(matches => matches.length !== 1) || new Set(matched.map(matches => matches[0].id)).size !== edges.length) return false
  return { nodes, edges: matched.map(matches => matches[0]) }
}

export async function waitForCanvasGraph(page, graph, options = {}) {
  const observed = await page.waitForFunction(renderedCanvasGraphReady, { graph, ...options })
  try { return await observed.jsonValue() }
  finally { await observed.dispose() }
}
