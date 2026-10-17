import type { EditorEdge, EditorNode, AlignmentMode, NodeMeasurements, GraphEditorState } from './graph-types.ts'
import { nodeContentMinimum } from './node-geometry.ts'
import { effectivePortVisibility } from './port-visibility.ts'
import { projectLayoutCollisions } from './layout-collisions.ts'
import type { Presentation, XY } from '../../../../../definition/types.ts'
import { EditorCommandError } from './graph-commands.ts'

export interface LayoutRect {
  id: string
  x: number
  y: number
  width: number
  height: number
  pinned: boolean
}

function minimumRect(node: EditorNode, edges: EditorEdge[], measured?: { width: number; height: number }): { width: number; height: number } {
  const minimum = nodeContentMinimum({
    title: node.label,
    state: 'idle',
    inputs: node.inputs,
    outputs: node.outputs,
    controlOutputs: node.definition?.branches ?? [],
    visibility: effectivePortVisibility(node, edges)
  })
  return {
    width: Math.max(minimum.width, node.presentation?.width ?? 0, measured?.width ?? 0),
    height: Math.max(minimum.height, node.presentation?.height ?? 0, measured?.height ?? 0)
  }
}

export function collisionRects(nodes: EditorNode[], edges: EditorEdge[], measurements: NodeMeasurements = new Map()): LayoutRect[] {
  return nodes.map(node => {
    const size = minimumRect(node, edges, measurements.get(node.id))
    return { id: node.id, x: node.x, y: node.y, ...size, pinned: node.presentation?.pinned ?? false }
  })
}

export function placementRects(
  nodes: EditorNode[],
  edges: EditorEdge[],
  newIds: readonly string[],
  measurements: NodeMeasurements = new Map(),
  displayPositions: ReadonlyMap<string, XY> = new Map()
): LayoutRect[] {
  const created = new Set(newIds)
  return nodes.map(node => {
    const measured = measurements.get(node.id)
    const minimum = minimumRect(node, edges, measured)
    const position = !created.has(node.id) ? displayPositions.get(node.id) : undefined
    return {
      id: node.id,
      x: position?.x ?? node.x,
      y: position?.y ?? node.y,
      width: measured?.width ?? Math.max(minimum.width, node.presentation?.width ?? 0),
      height: measured?.height ?? Math.max(minimum.height, node.presentation?.height ?? 0),
      pinned: !created.has(node.id) || !!node.presentation?.pinned
    }
  })
}

export function alignNodes(nodes: Array<EditorNode & { width: number; height: number }>, mode: AlignmentMode): Map<string, XY> {
  const left = Math.min(...nodes.map(node => node.x))
  const top = Math.min(...nodes.map(node => node.y))
  const right = Math.max(...nodes.map(node => node.x + node.width))
  const bottom = Math.max(...nodes.map(node => node.y + node.height))
  return new Map(
    nodes.map(node => [
      node.id,
      {
        x: mode === 'left' ? left : mode === 'right' ? right - node.width : mode === 'center-x' ? (left + right - node.width) / 2 : node.x,
        y: mode === 'top' ? top : mode === 'bottom' ? bottom - node.height : mode === 'center-y' ? (top + bottom - node.height) / 2 : node.y
      }
    ])
  )
}

export function distributeNodes(nodes: Array<EditorNode & { width: number; height: number }>, axis: 'x' | 'y'): Map<string, XY> {
  const ordered = [...nodes].sort((a, b) => a[axis] - b[axis] || a.id.localeCompare(b.id))
  const size = axis === 'x' ? 'width' : 'height'
  const start = ordered[0]![axis]
  const end = ordered[ordered.length - 1]![axis] + ordered[ordered.length - 1]![size]
  const gap = (end - start - ordered.reduce((sum, node) => sum + node[size], 0)) / (ordered.length - 1)
  const result = new Map<string, XY>()
  let position = start
  for (const [index, node] of ordered.entries()) {
    result.set(node.id, {
      x: axis === 'x' && index > 0 && index < ordered.length - 1 ? position : node.x,
      y: axis === 'y' && index > 0 && index < ordered.length - 1 ? position : node.y
    })
    position += node[size] + gap
  }
  return result
}

export function applyCollisionProjection(
  state: Pick<GraphEditorState, 'nodes' | 'edges'>,
  measurements: NodeMeasurements,
  rigidGroups: readonly (readonly string[])[]
) {
  return projectLayoutCollisions(collisionRects(state.nodes, state.edges, measurements), rigidGroups)
}

export function defaultLayoutProjection(nodes: EditorNode[], edges: EditorEdge[], presentation: Partial<Presentation> | undefined) {
  const saved = presentation?.nodes ?? {}
  return projectLayoutCollisions(
    nodes.map(node => {
      const size = minimumRect(node, edges)
      return {
        id: node.id,
        x: node.x,
        y: node.y,
        ...size,
        pinned: saved[node.id]?.x !== undefined && saved[node.id]?.y !== undefined
      }
    })
  )
}

export function requireMeasurements(nodes: EditorNode[], measurements?: NodeMeasurements): Array<EditorNode & { width: number; height: number }> {
  return nodes.map(node => {
    const size = measurements?.get(node.id)
    const width = size?.width ?? node.presentation?.width
    const height = size?.height ?? node.presentation?.height
    if (width === undefined || height === undefined || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new EditorCommandError('missing-measurement')
    return { ...node, width, height }
  })
}
