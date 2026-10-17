/** Pure display projection. Resource identities and Host configuration stay in the adapter. */
import { nodeDisplayCapabilities } from '../logic/graph/node-capabilities.ts'
import { effectivePortVisibility, connectedPortEdges } from '../logic/graph/port-visibility.ts'
import { graphNode } from '../logic/inspector/inspector-commands.ts'
import type { InspectorSnapshot } from '../logic/inspector/inspector-commands.ts'
import type { EditorNode, EditorEdge } from '../logic/graph/graph-editor.ts'
export type BindingField = 'agentRef' | 'outputSchemaRef' | 'skillRefs' | 'toolsetRefs'
export interface InspectorResourceOption {
  readonly key: string
  readonly label: string
  readonly checked: boolean
  readonly disabled: boolean
}
export function projectInspector(input: {
  node: EditorNode
  edges: readonly EditorEdge[]
  snapshot: InspectorSnapshot
  disabled: boolean
  choices: Record<BindingField, readonly InspectorResourceOption[]>
}) {
  const { node, snapshot, disabled } = input,
    definition = graphNode(node)
  const legacy: Record<string, unknown> = {}
  for (const field of ['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef', 'modelSelection'] as const) {
    const value = definition[field]
    if (field === 'modelSelection') {
      if (value && typeof value === 'object' && !Array.isArray(value))
        legacy[field] = Object.fromEntries(
          Object.entries(value).filter(([key, item]) => ['provider', 'model', 'reasoningEffort'].includes(key) && typeof item === 'string')
        )
    } else if (Array.isArray(value)) legacy[field] = value.filter(item => typeof item === 'string')
    else if (typeof value === 'string') legacy[field] = value
  }
  const notice = snapshot.notice
  const displayNotice: InspectorSnapshot['notice'] = !notice
    ? null
    : notice.key === 'connection.portVisibilityConnected'
      ? { key: notice.key, params: { edgeCount: notice.params.edgeCount } }
      : notice.key === 'inspector.invalidJson'
        ? { key: notice.key, params: { code: notice.params.code } }
        : { key: notice.key }
  const displaySnapshot: InspectorSnapshot = {
    json: { inputs: snapshot.json.inputs, outputs: snapshot.json.outputs, options: snapshot.json.options },
    rows: {
      inputs: snapshot.rows.inputs.map(({ id, name, type }) => ({ id, name, type })),
      outputs: snapshot.rows.outputs.map(({ id, name, type }) => ({ id, name, type }))
    },
    notice: displayNotice,
    modelRoute: {
      explicit: snapshot.modelRoute.explicit,
      provider: snapshot.modelRoute.provider,
      model: snapshot.modelRoute.model,
      reasoningEffort: snapshot.modelRoute.reasoningEffort
    }
  }
  const conditions = (['inputPort', 'trueBranch', 'falseBranch'] as const).map(field => ({
    field,
    value: definition.condition?.[field] ?? '',
    choices: field === 'inputPort' ? Object.keys(node.inputs).filter(port => node.inputs[port] === 'boolean') : [...(definition.branches ?? [])]
  }))
  return {
    node: { id: node.id, kind: node.kind },
    disabled,
    capability: nodeDisplayCapabilities(definition),
    choices: Object.fromEntries(
      (['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef'] as const).map(field => [
        field,
        input.choices[field].map(({ key, label, checked, disabled }) => ({ key, label, checked, disabled }))
      ])
    ) as Record<BindingField, InspectorResourceOption[]>,
    selected: { agentRef: definition.agentRef ?? '', outputSchemaRef: definition.outputSchemaRef ?? '' },
    conditionFields: conditions,
    joinValue: definition.join ?? 'all',
    legacyBindingsText: Object.keys(legacy).length ? JSON.stringify(legacy, null, 2) : null,
    visibility: effectivePortVisibility(node, [...input.edges]),
    connectedPriority: Object.fromEntries(
      (['control', 'inputs', 'outputs'] as const).map(side => [
        side,
        node.presentation?.ports?.[side] === false && connectedPortEdges(node.id, side, [...input.edges]) > 0
      ])
    ) as Record<'control' | 'inputs' | 'outputs', boolean>,
    snapshot: displaySnapshot
  }
}
export type InspectorViewModel = ReturnType<typeof projectInspector>
