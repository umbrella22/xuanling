import type { BlueprintDefinition, GraphNode, Presentation, PresentationNode, XY } from '../../../../../definition/types.ts'
import type { EditorEdge, EditorGroup, EditorNode, GraphDefinitionInput, GraphEditorState } from './graph-types.ts'
import { edgeKey } from './clipboard.ts'
import { EditorCommandError, nextEdgeId } from './graph-commands.ts'

export function graphNodeFromEditorNode(node: EditorNode): GraphNode {
  const result = { ...structuredClone(node.definition), id: node.id, kind: node.kind as GraphNode['kind'] }
  if (node.definition?.inputs !== undefined || Object.keys(node.inputs).length) result.inputs = structuredClone(node.inputs)
  if (node.definition?.outputs !== undefined || Object.keys(node.outputs).length) result.outputs = structuredClone(node.outputs)
  return result
}

export function exportGraphLayout(state: Pick<GraphEditorState, 'nodes' | 'edges' | 'groups' | 'definition'>): Presentation {
  const nodes: Record<string, PresentationNode> = Object.fromEntries(
    state.nodes.map(node => [node.id, { ...structuredClone(node.presentation), x: node.x, y: node.y }])
  )
  const edges = state.edges
    .filter(edge => edge.points !== undefined)
    .map(edge => ({ kind: edge.kind, from: edge.from, to: edge.to, points: structuredClone(edge.points!) }))
  const resources = state.definition?.presentation?.resources
  return {
    nodes,
    ...(resources ? { resources: structuredClone(resources) } : {}),
    groups: structuredClone(state.groups),
    ...(edges.length ? { edges } : {})
  }
}

export function importGraphLayout(state: GraphEditorState, layout: Partial<Presentation>): void {
  if (state.layoutBefore) throw new EditorCommandError('layout-pending')
  if (!layout || typeof layout !== 'object' || Array.isArray(layout) || ![Object.prototype, null].includes(Object.getPrototypeOf(layout)))
    throw new EditorCommandError('presentation-invalid')
  const complete = { ...layout, nodes: layout.nodes ?? {} }
  state.checkLayout(complete)
  for (const node of state.nodes) {
    const position = complete.nodes[node.id]
    if (position !== undefined) {
      const { x, y, ...attrs } = structuredClone(position)
      node.x = x
      node.y = y
      node.presentation = attrs
    }
  }
  if (layout.groups !== undefined) state.groups = layout.groups.map(group => ({ ...structuredClone(group), label: group.label ?? group.id }))
  if (layout.resources !== undefined && state.definition) {
    state.definition.presentation = { ...(state.definition.presentation ?? { nodes: {} }), resources: structuredClone(layout.resources) }
  }
  const routing = new Map((layout.edges ?? []).map(edge => [edgeKey(edge), edge.points]))
  for (const edge of state.edges) {
    const points = routing.get(edgeKey(edge))
    if (points !== undefined) edge.points = structuredClone(points)
    else delete edge.points
  }
  state.emit()
}

export function importGraphNodes(definition: GraphDefinitionInput): { nodes: EditorNode[]; edges: EditorEdge[]; groups: EditorGroup[] } {
  const presentation = definition.presentation?.nodes ?? {}
  const nodes = definition.graph.nodes.map((node, index) => ({
    definition: structuredClone(node) as GraphNode,
    id: node.id,
    kind: node.kind,
    label: node.name ?? `${node.kind} ${index + 1}`,
    x: presentation[node.id]?.x ?? 60 + (index % 4) * 220,
    y: presentation[node.id]?.y ?? 60 + Math.floor(index / 4) * 140,
    inputs: structuredClone(node.inputs ?? {}),
    outputs: structuredClone(node.outputs ?? {}),
    ...(presentation[node.id] ? { presentation: (({ x: _x, y: _y, ...attrs }) => attrs)(structuredClone(presentation[node.id]!)) } : {})
  }))
  const edges = definition.graph.edges.map(edge => ({
    id: nextEdgeId(),
    kind: edge.kind === 'control' ? ('control' as const) : ('data' as const),
    from: edge.from,
    to: edge.to
  }))
  const groups = (definition.presentation?.groups ?? []).map(group => ({ id: group.id, label: group.label ?? group.id, nodeIds: [...group.nodeIds] }))
  return { nodes, edges, groups }
}

export function importGraphDefinition(definition: GraphDefinitionInput): { nodes: EditorNode[]; edges: EditorEdge[]; groups: EditorGroup[] } {
  return importGraphNodes(definition)
}

export function exportGraphDefinition(state: GraphEditorState): BlueprintDefinition {
  if (!state.definition) throw new Error('no-definition')
  const definition = structuredClone(state.definition)
  definition.graph.nodes = state.nodes.map(graphNodeFromEditorNode)
  definition.graph.edges = state.edges.map(({ kind, from, to }) => ({ kind, from, to }))
  definition.presentation = state.exportLayout()
  return definition
}

export function presentationPosition(node: EditorNode): XY {
  return { x: node.x, y: node.y }
}
