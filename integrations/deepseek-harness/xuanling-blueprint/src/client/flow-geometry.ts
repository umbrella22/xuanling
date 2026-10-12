import type { EditorEdge } from './graph-editor.ts'
/** Node IDs cannot contain a dot; port names can. Split exactly the FIRST dot,
 * matching the definition validator, rather than truncating a legal port. */
export function flowEdgeEndpoints(edge: Pick<EditorEdge, 'kind' | 'from' | 'to'>): { source: string; target: string; sourceHandle: string; targetHandle: string } {
  if (edge.kind === 'control') {
    const at = edge.from.indexOf('@')
    return { source: at < 0 ? edge.from : edge.from.slice(0, at), target: edge.to,
      sourceHandle: `control:${at < 0 ? 'control' : edge.from.slice(at + 1)}`, targetHandle: 'control:control' }
  }
  const fromDot = edge.from.indexOf('.')
  const toDot = edge.to.indexOf('.')
  return { source: edge.from.slice(0, fromDot), target: edge.to.slice(0, toDot),
    sourceHandle: `data:${edge.from.slice(fromDot + 1)}`, targetHandle: `data:${edge.to.slice(toDot + 1)}` }
}
