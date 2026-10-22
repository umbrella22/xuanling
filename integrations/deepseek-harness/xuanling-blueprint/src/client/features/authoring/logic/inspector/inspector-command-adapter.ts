/** Framework-neutral view intent admission and existing session command adapter. */
import { graphNode } from './inspector-commands.ts'
import type { PortField, JsonField, ResourceChoice } from './inspector-commands.ts'
import type { BindingField } from '../../presenters/inspector-presenter.ts'
import type { InspectorSession } from './inspector-session.ts'
export type InspectorViewIntent =
  | { type: 'interaction'; managed: boolean }
  | { type: 'bind-resource'; field: BindingField; key: string; checked?: boolean }
  | { type: 'port-row'; field: PortField; id: number; property: 'name' | 'type'; value: string }
  | { type: 'remove-port'; field: PortField; id: number }
  | { type: 'add-port' | 'apply-ports'; field: PortField }
  | { type: 'condition'; field: 'inputPort' | 'trueBranch' | 'falseBranch'; value: string }
  | { type: 'clear-condition' | 'join-all' | 'apply-model' }
  | { type: 'model-mode'; explicit: boolean }
  | { type: 'model-route'; field: 'provider' | 'model' | 'reasoningEffort'; value: string }
  | { type: 'port-visibility'; side: 'control' | 'inputs' | 'outputs'; visible: boolean }
  | { type: 'json-buffer'; field: JsonField; text: string }
  | { type: 'json-commit'; field: JsonField }
export interface InspectorCommandContext {
  session: InspectorSession
  isCurrent: () => boolean
  isDisabled: () => boolean
  resourceChoices: (field: BindingField) => readonly ResourceChoice[]
}
export type InspectorDispatchResult =
  | { ok: true; status: 'dispatched' }
  | { ok: false; reason: 'stale' | 'disabled' | 'missing-node' | 'invalid-intent' | 'unavailable-resource' }
/** This in-process boundary checks action and field types; it is not a transport decoder. */
export function isInspectorViewIntent(value: unknown): value is InspectorViewIntent {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  const oneOf = (value: unknown, options: readonly string[]) => typeof value === 'string' && options.includes(value)
  const port = () => item.field === 'inputs' || item.field === 'outputs'
  const json = () => port() || item.field === 'options'
  switch (item.type) {
    case 'interaction':
      return typeof item.managed === 'boolean'
    case 'bind-resource':
      return (
        oneOf(item.field, ['agentRef', 'outputSchemaRef', 'skillRefs', 'toolsetRefs']) &&
        typeof item.key === 'string' &&
        (item.checked === undefined || typeof item.checked === 'boolean')
      )
    case 'port-row':
      return (
        port() &&
        typeof item.id === 'number' &&
        Number.isInteger(item.id) &&
        item.id > 0 &&
        oneOf(item.property, ['name', 'type']) &&
        typeof item.value === 'string'
      )
    case 'remove-port':
      return port() && typeof item.id === 'number' && Number.isInteger(item.id) && item.id > 0
    case 'add-port':
    case 'apply-ports':
      return port()
    case 'condition':
      return oneOf(item.field, ['inputPort', 'trueBranch', 'falseBranch']) && typeof item.value === 'string'
    case 'clear-condition':
    case 'join-all':
    case 'apply-model':
      return true
    case 'model-mode':
      return typeof item.explicit === 'boolean'
    case 'model-route':
      return oneOf(item.field, ['provider', 'model', 'reasoningEffort']) && typeof item.value === 'string'
    case 'port-visibility':
      return oneOf(item.side, ['control', 'inputs', 'outputs']) && typeof item.visible === 'boolean'
    case 'json-buffer':
      return json() && typeof item.text === 'string'
    case 'json-commit':
      return json()
    default:
      return false
  }
}
export function dispatchInspectorIntent(context: InspectorCommandContext, value: unknown): InspectorDispatchResult {
  if (!isInspectorViewIntent(value)) return { ok: false, reason: 'invalid-intent' }
  const intent = value
  if (!context.isCurrent()) return { ok: false, reason: 'stale' }
  if (context.isDisabled()) return { ok: false, reason: 'disabled' }
  const { session } = context
  const current = session.currentNode()
  if (!current) return { ok: false, reason: 'missing-node' }
  if ((intent.type === 'port-row' || intent.type === 'remove-port') && !session.getSnapshot().rows[intent.field].some(row => row.id === intent.id))
    return { ok: false, reason: 'invalid-intent' }
  if (intent.type === 'interaction') {
    if (current.kind !== 'agentTask' || current.definition?.teamStage !== undefined) return { ok: false, reason: 'invalid-intent' }
    session.patch({ interaction: intent.managed ? 'managed' : undefined })
  } else if (intent.type === 'bind-resource') {
    const choice = context.resourceChoices(intent.field).find(choice => choice.key === intent.key)
    if (choice) {
      const value = graphNode(current)[intent.field]
      const selected = choice.refId !== undefined && (Array.isArray(value) ? value.includes(choice.refId) : value === choice.refId)
      if (choice.unavailable && !selected) return { ok: false, reason: 'unavailable-resource' }
      session.bindResource(intent.field, choice, intent.checked ?? true)
    } else if (intent.key === '' && (intent.field === 'agentRef' || intent.field === 'outputSchemaRef')) session.patch({ [intent.field]: undefined })
    else return { ok: false, reason: 'invalid-intent' }
  } else if (intent.type === 'port-row') session.setPort(intent.field, intent.id, intent.property, intent.value)
  else if (intent.type === 'remove-port') session.removePort(intent.field, intent.id)
  else if (intent.type === 'add-port') session.addPort(intent.field)
  else if (intent.type === 'apply-ports') session.applyPorts(intent.field)
  else if (intent.type === 'condition') {
    const definition = graphNode(current),
      defaults = {
        inputPort: Object.keys(current.inputs).find(port => current.inputs[port] === 'boolean') ?? '',
        trueBranch: definition.branches?.[0] ?? '',
        falseBranch: definition.branches?.[1] ?? ''
      }
    session.patch({ condition: { ...(definition.condition ?? defaults), [intent.field]: intent.value } })
  } else if (intent.type === 'clear-condition') session.patch({ condition: undefined })
  else if (intent.type === 'join-all') session.patch({ join: 'all' })
  else if (intent.type === 'model-mode') session.setExplicitModel(intent.explicit)
  else if (intent.type === 'model-route') session.setModelRoute(intent.field, intent.value)
  else if (intent.type === 'apply-model') session.applyModelRoute()
  else if (intent.type === 'port-visibility') session.setPortVisibility(intent.side, intent.visible)
  else if (intent.type === 'json-buffer') session.setJson(intent.field, intent.text)
  else if (intent.type === 'json-commit') session.applyJson(intent.field)
  return { ok: true, status: 'dispatched' }
}
