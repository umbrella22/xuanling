import type { GraphEdge, XY } from '../../../../../definition/types.ts'
import { ClipboardError, decodeClipboard, edgeKey, endpointNode, referencedResourceIds } from './clipboard.ts'
import type { ClipboardFragment, ClipboardPasteResult } from './clipboard.ts'
import type { EditorEdge, GraphEditorState, NodeMeasurements } from './graph-types.ts'
import { EditorCommandError, nextEdgeId } from './graph-commands.ts'

export function createClipboardFragment(state: GraphEditorState, nodeIds: string[] = [...state.selection]): ClipboardFragment {
  if (!state.definition) throw new Error('no-definition')
  const selected = state.requireNodes(nodeIds)
  const ids = new Set(selected.map(node => node.id))
  const nodes = selected.map(node => state.graphNode(node))
  const edges = state.edges.filter(edge => ids.has(endpointNode(edge.from, edge.kind)) && ids.has(endpointNode(edge.to, edge.kind)))
  const incoming = state.edges.filter(edge => !ids.has(endpointNode(edge.from, edge.kind)) && ids.has(endpointNode(edge.to, edge.kind)))
  const layout = state.exportLayout()
  const resources = Object.fromEntries([...referencedResourceIds(nodes)].map(id => [id, structuredClone(state.definition!.resources[id])]))
  const presentationResources = layout.resources
    ? Object.fromEntries(
        Object.keys(resources)
          .filter(id => Object.hasOwn(layout.resources!, id))
          .map(id => [id, structuredClone(layout.resources![id]!)])
      )
    : undefined
  return decodeClipboard({
    version: 1,
    sourceBlueprintId: state.definition.id,
    nodes,
    edges: edges.map(({ kind, from, to }) => ({ kind, from, to })),
    incoming: incoming.map(({ kind, from, to }) => ({ kind, from, to })),
    resources,
    presentation: {
      nodes: Object.fromEntries(selected.map(node => [node.id, layout.nodes[node.id]])),
      ...(presentationResources && Object.keys(presentationResources).length ? { resources: presentationResources } : {}),
      groups: state.groups.map(group => ({ ...group, nodeIds: group.nodeIds.filter(id => ids.has(id)) })).filter(group => group.nodeIds.length),
      ...(layout.edges ? { edges: layout.edges.filter(edge => [...edges, ...incoming].some(known => edgeKey(edge) === edgeKey(known))) } : {})
    }
  })
}

export interface ClipboardPasteOptions {
  rigid?: boolean
  withIncoming?: boolean
  measurements?: NodeMeasurements | undefined
  displayPositions?: ReadonlyMap<string, XY> | undefined
}

export function pasteClipboardFragment(state: GraphEditorState, input: unknown, position: XY, options: ClipboardPasteOptions = {}): ClipboardPasteResult {
  if (!state.definition) return { ok: false, code: 'no-definition', nodeIds: [] }
  let fragment: ClipboardFragment
  try {
    fragment = decodeClipboard(input)
  } catch {
    return { ok: false, code: 'clipboard-invalid', nodeIds: [] }
  }
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return { ok: false, code: 'clipboard-invalid', nodeIds: [] }
  const same = fragment.sourceBlueprintId === state.definition.id
  if (options.withIncoming && !same) return { ok: false, code: 'clipboard-incoming-cross-blueprint', nodeIds: [] }
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, current: unknown) =>
      current && typeof current === 'object' && !Array.isArray(current)
        ? Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b)))
        : current
    )
  for (const [id, ref] of Object.entries(fragment.resources)) {
    const target = state.definition.resources[id]
    if (
      !Object.hasOwn(state.definition.resources, id) ||
      !target ||
      canonical(target) !== canonical(ref) ||
      (!same && !(ref.kind === 'mcp' || (ref.kind === 'skill' && ref.source?.kind === 'shared')))
    )
      return { ok: false, code: 'clipboard-resource-conflict', nodeIds: [] }
  }
  const ids = new Set(state.nodes.map(node => node.id))
  const groups = new Set(state.groups.map(group => group.id))
  const unique = (base: string, used: Set<string>): string => {
    let i = 1
    while (used.has(`${base}_copy${i}`)) i++
    const id = `${base}_copy${i}`
    used.add(id)
    return id
  }
  const remap = new Map(fragment.nodes.map(node => [node.id, unique(node.id, ids)]))
  const endpoint = (value: string, kind: GraphEdge['kind']): string => {
    const id = endpointNode(value, kind)
    return (remap.get(id) ?? id) + value.slice(id.length)
  }
  const edge = (value: GraphEdge): GraphEdge => ({ kind: value.kind, from: endpoint(value.from, value.kind), to: endpoint(value.to, value.kind) })
  const left = Math.min(...fragment.nodes.map(node => fragment.presentation.nodes[node.id]?.x ?? 0))
  const top = Math.min(...fragment.nodes.map(node => fragment.presentation.nodes[node.id]?.y ?? 0))
  const dx = position.x - left
  const dy = position.y - top
  const nodeIds = [...remap.values()]
  try {
    state.transaction(() => {
      if (fragment.presentation.resources) {
        state.definition!.presentation = {
          ...(state.definition!.presentation ?? { nodes: {} }),
          resources: { ...state.definition!.presentation?.resources, ...structuredClone(fragment.presentation.resources) }
        }
      }
      for (const node of fragment.nodes) {
        const presentation = fragment.presentation.nodes[node.id] ?? { x: 0, y: 0 }
        const { x, y, ...attrs } = presentation
        const id = remap.get(node.id)!
        state.addNode({
          id,
          definition: { ...node, id },
          kind: node.kind,
          label: node.kind,
          x: x + dx,
          y: y + dy,
          inputs: node.inputs ?? {},
          outputs: node.outputs ?? {},
          presentation: attrs
        })
      }
      for (const original of [...fragment.edges, ...(options.withIncoming ? fragment.incoming : [])]) {
        const mapped = edge(original)
        const temporary: EditorEdge = { ...mapped, id: '' }
        const internal = fragment.edges.includes(original)
        const from = state.portFor(temporary, 'from')
        const to = state.portFor(temporary, 'to')
        const verdict = internal ? state.checkedConnection(from, to, undefined, true) : state.connectionVerdict(from, to)
        if (!verdict.ok) {
          if (verdict.reason === 'port-hidden') throw new EditorCommandError('port-hidden')
          throw new ClipboardError('/edges')
        }
        const restored: EditorEdge = { ...mapped, id: nextEdgeId() }
        state.edges.push(restored)
        const route = fragment.presentation.edges?.find(candidate => edgeKey(candidate) === edgeKey(original))
        if (route) restored.points = route.points.map(point => ({ x: point.x + dx, y: point.y + dy }))
      }
      for (const group of fragment.presentation.groups ?? [])
        state.groups.push({ id: unique(group.id, groups), label: group.label ?? group.id, nodeIds: group.nodeIds.map(id => remap.get(id)!) })
      state.settleCreatedNodes(nodeIds, options.measurements, options.displayPositions, options.rigid)
      state.selection = new Set(nodeIds)
    })
    return { ok: true, code: 'clipboard-pasted', nodeIds }
  } catch (error) {
    if (error instanceof EditorCommandError && error.code === 'layout-collision-unresolved') throw error
    return { ok: false, code: error instanceof EditorCommandError && error.code === 'port-hidden' ? 'port-hidden' : 'clipboard-invalid', nodeIds: [] }
  }
}
