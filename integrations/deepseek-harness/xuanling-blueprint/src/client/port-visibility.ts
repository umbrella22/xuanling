/** Display preferences are subordinate to canonical connected edges. */
import type { PresentationPorts } from '../definition/types.ts'
export type PortSide = keyof PresentationPorts
interface VisibleNode {
  id: string
  kind: string
  inputs?: Record<string, string>
  outputs?: Record<string, string>
  definition?: { branches?: readonly string[] }
  branches?: readonly string[]
  presentation?: { ports?: PresentationPorts }
}
interface VisibleEdge {
  kind: 'data' | 'control'
  from: string
  to: string
}
function endpoint(value: string, kind: VisibleEdge['kind']): string {
  const at = value.indexOf(kind === 'data' ? '.' : '@')
  return at < 0 ? value : value.slice(0, at)
}
export function connectedPortEdges(nodeId: string, side: PortSide, edges: readonly VisibleEdge[]): number {
  return edges.filter(edge =>
    side === 'control'
      ? edge.kind === 'control' && (endpoint(edge.from, edge.kind) === nodeId || endpoint(edge.to, edge.kind) === nodeId)
      : edge.kind === 'data' && endpoint(side === 'inputs' ? edge.to : edge.from, edge.kind) === nodeId
  ).length
}
export function effectivePortVisibility(node: VisibleNode, edges: readonly VisibleEdge[]): Required<PresentationPorts> {
  const preferred = node.presentation?.ports
  const visible = (side: PortSide, fallback: boolean) => connectedPortEdges(node.id, side, edges) > 0 || (preferred?.[side] ?? fallback)
  return {
    control: visible('control', !!(node.definition?.branches?.length ?? node.branches?.length) || node.kind === 'condition' || node.kind === 'humanDecision'),
    inputs: visible('inputs', Object.keys(node.inputs ?? {}).length > 0),
    outputs: visible('outputs', Object.keys(node.outputs ?? {}).length > 0)
  }
}
export function portSide(port: { kind?: 'control' | 'data'; direction: 'in' | 'out' }): PortSide {
  return port.kind === 'control' ? 'control' : port.direction === 'in' ? 'inputs' : 'outputs'
}
