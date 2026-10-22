import type { BlueprintReferenceView } from '../../../../../conversation/blueprint-reference-contracts.ts'
import type { EditorNode, GraphEditor } from '../graph/graph-editor.ts'

export function compositionIdentity(node: EditorNode): string {
  return JSON.stringify([node.definition?.blueprintRef, node.inputs, node.outputs])
}
export function compositionChanges(node: EditorNode, candidate: BlueprintReferenceView) {
  return (['inputs', 'outputs'] as const).flatMap(side =>
    [...new Set([...Object.keys(node[side]), ...Object.keys(candidate[side])])]
      .filter(name => node[side][name] !== candidate[side][name])
      .map(name => ({ side, name, before: node[side][name], after: candidate[side][name] }))
  )
}
export function incompatibleCompositionEdges(editor: GraphEditor, node: EditorNode, candidate: BlueprintReferenceView): string[] {
  return editor.edges
    .filter(edge => {
      if (edge.kind !== 'data') return false
      const endpoints = [edge.from, edge.to].map(value => ({ id: value.slice(0, value.indexOf('.')), port: value.slice(value.indexOf('.') + 1) }))
      if (!endpoints.some(end => end.id === node.id)) return false
      const [from, to] = endpoints
      const output = from!.id === node.id ? candidate.outputs[from!.port] : editor.nodes.find(n => n.id === from!.id)?.outputs[from!.port]
      const input = to!.id === node.id ? candidate.inputs[to!.port] : editor.nodes.find(n => n.id === to!.id)?.inputs[to!.port]
      return output === undefined || input === undefined || output !== input
    })
    .map(edge => edge.id)
}
/** Compare the inspected base at the event; a pending read cannot overwrite a newer edit. */
export function applyBlueprintReference(editor: GraphEditor, nodeId: string, base: string, candidate: BlueprintReferenceView, removeEdges: boolean): boolean {
  const node = editor.nodes.find(node => node.id === nodeId)
  if (!node || node.kind !== 'blueprintCall' || compositionIdentity(node) !== base) return false
  const incompatible = incompatibleCompositionEdges(editor, node, candidate)
  if (incompatible.length && !removeEdges) return false
  editor.transaction(() => {
    for (const id of incompatible) editor.removeEdge(id)
    editor.updateNode(nodeId, {
      blueprintRef: { blueprintId: candidate.blueprintId, documentRevision: candidate.documentRevision },
      inputs: candidate.inputs,
      outputs: candidate.outputs
    })
  })
  return true
}
