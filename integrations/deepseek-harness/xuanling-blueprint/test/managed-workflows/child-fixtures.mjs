export function echoDefinition(id = 'child') {
  return {
    schemaVersion: 2,
    id,
    name: id,
    resources: {},
    graph: {
      nodes: [
        { id: 'in', kind: 'input', outputs: { value: 'string' } },
        { id: 'out', kind: 'output', inputs: { value: 'string' } }
      ],
      edges: [{ kind: 'data', from: 'in.value', to: 'out.value' }]
    }
  }
}

export function parentDefinition(child, id = 'parent') {
  const doc = echoDefinition(id)
  doc.graph.nodes.splice(1, 0, {
    id: 'call',
    kind: 'blueprintCall',
    blueprintRef: { blueprintId: child.blueprintId, documentRevision: child.documentRevision },
    inputs: { value: 'string' },
    outputs: { value: 'string' }
  })
  doc.graph.edges = [
    { kind: 'data', from: 'in.value', to: 'call.value' },
    { kind: 'data', from: 'call.value', to: 'out.value' }
  ]
  return doc
}

export const save = (service, definition, expectedRevision = null) =>
  service.saveDefinition({ blueprintId: definition.id, definitionJson: JSON.stringify(definition), expectedRevision })
export const check = (service, document) =>
  service.preflightRun({ blueprintId: document.blueprintId, expectedRevision: document.documentRevision, inputJson: '{"value":"echo"}' })
