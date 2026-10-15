/** Client-only editing drafts. The Host remains the authority on Save. */
import { effectivePortVisibility, connectedPortEdges } from './port-visibility.ts'
import type { PortSide } from './port-visibility.ts'
import { nodeDisplayCapabilities } from './node-capabilities.ts'
import { JsonEditor } from './json-editor.ts'
import { createElement as h, useMemo, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import type { GraphNode, ResourceRef } from '../definition/types.ts'
import type { HostResourceCatalogEntry } from './remote.ts'
import type { EditorNode, GraphEditor } from './graph-editor.ts'
import type { BlueprintLocaleProps } from './locales.ts'

export interface NodeInspectorProps {
  node: EditorNode
  disabled?: boolean
  editor: GraphEditor
  resources: Record<string, ResourceRef>
  resourceCatalog?: readonly HostResourceCatalogEntry[]
  t: BlueprintLocaleProps['t']
}

type PortField = 'inputs' | 'outputs'
type JsonField = PortField | 'options'
type OptionKey = Exclude<keyof GraphNode, 'id' | 'kind'>
/** Undefined clears an optional field through the editor's merge/JSON boundary. */
export type InspectorNodePatch = { [K in OptionKey]?: GraphNode[K] | undefined }
type InspectorIssue = 'invalid-json' | 'port-types-required' | 'identity-not-option' | 'node-options-shape' | 'duplicate-port-name' | 'node-unavailable'
type InspectorResult = { ok: true; changed: boolean } | { ok: false; issue: InspectorIssue }
type InspectorNotice =
  | { key: 'connection.portVisibilityConnected'; params: { edgeCount: number } }
  | { key: 'inspector.editApplied' | 'inspector.invalidJsonRetained' | 'inspector.portTypesRequired' | 'inspector.identityNotOption' }
  | { key: 'inspector.invalidJson'; params: { code: InspectorIssue } }
export interface InspectorPortRow {
  id: number
  name: string
  type: string
}
export interface InspectorSnapshot {
  json: Record<JsonField, string>
  rows: Record<PortField, InspectorPortRow[]>
  notice: InspectorNotice | null
  modelRoute: { explicit: boolean; provider: string; model: string; reasoningEffort: string }
}

const optionKeys = [
  'inputs',
  'outputs',
  'agentRef',
  'skillRefs',
  'toolsetRefs',
  'outputSchemaRef',
  'join',
  'branches',
  'budget',
  'subflowRef',
  'condition',
  'toolAllowlist',
  'modelSelection'
] as const satisfies readonly OptionKey[]
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function ports(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every(item => typeof item === 'string' && item.length > 0)
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
}
/** JSON value equivalence: object key order is not an edit; array order is. */
function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equivalent(item, b[index]))
  if (!object(a) || !object(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equivalent(a[key], b[key]))
}
function graphNode(node: EditorNode): GraphNode {
  return node.definition ?? { id: node.id, kind: node.kind as GraphNode['kind'], inputs: node.inputs, outputs: node.outputs }
}
function nodeOptions(node: EditorNode): GraphNode {
  const definition = graphNode(node)
  // Client-compatible extra names are display metadata, not Host node options.
  return Object.fromEntries(
    Object.entries(definition).filter(([key]) => key === 'id' || key === 'kind' || optionKeys.some(option => option === key))
  ) as unknown as GraphNode
}
function validOption(key: (typeof optionKeys)[number], value: unknown): boolean {
  switch (key) {
    case 'inputs':
    case 'outputs':
      return ports(value)
    case 'skillRefs':
    case 'toolsetRefs':
    case 'branches':
    case 'toolAllowlist':
      return stringList(value)
    case 'agentRef':
    case 'outputSchemaRef':
    case 'subflowRef':
      return typeof value === 'string' && value.length > 0
    case 'condition':
      return (
        object(value) &&
        Object.keys(value).length === 3 &&
        ['inputPort', 'trueBranch', 'falseBranch'].every(key => typeof value[key] === 'string' && value[key] !== '')
      )
    case 'join':
      return value === 'all' || value === 'any'
    case 'budget':
      return (
        object(value) &&
        Object.keys(value).every(key => key === 'maxIterations' || key === 'maxDurationMs') &&
        Number.isInteger(value.maxIterations) &&
        Number.isInteger(value.maxDurationMs)
      )
    case 'modelSelection':
      return (
        object(value) &&
        Object.keys(value).every(key => ['provider', 'model', 'reasoningEffort'].includes(key)) &&
        ['provider', 'model'].every(key => typeof value[key] === 'string' && (value[key] as string).trim().length > 0) &&
        (value.reasoningEffort === undefined || (typeof value.reasoningEffort === 'string' && value.reasoningEffort.trim().length > 0))
      )
  }
}

/** Only JSON and field shape preflight, not reference/graph/Host validation. */
export function parseInspectorJson(
  node: EditorNode,
  field: JsonField,
  text: string
): { ok: true; patch: InspectorNodePatch } | { ok: false; issue: InspectorIssue } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { ok: false, issue: 'invalid-json' }
  }
  if (field !== 'options') return ports(value) ? { ok: true, patch: { [field]: value } } : { ok: false, issue: 'port-types-required' }
  if (!object(value)) return { ok: false, issue: 'node-options-shape' }
  if ((Object.hasOwn(value, 'id') && value.id !== node.id) || (Object.hasOwn(value, 'kind') && value.kind !== node.kind))
    return { ok: false, issue: 'identity-not-option' }
  const entries = Object.entries(value).filter(([key]) => key !== 'id' && key !== 'kind')
  if (entries.some(([key, item]) => !optionKeys.some(option => option === key) || !validOption(key as (typeof optionKeys)[number], item)))
    return { ok: false, issue: 'node-options-shape' }
  // Omitted fields deliberately retain the legacy merge behavior (not deletion).
  return { ok: true, patch: Object.fromEntries(entries) as InspectorNodePatch }
}

export function applyInspectorPatch(editor: GraphEditor, nodeId: string, patch: InspectorNodePatch): InspectorResult {
  const node = editor.nodes.find(item => item.id === nodeId)
  if (!node) return { ok: false, issue: 'node-unavailable' }
  const entries = Object.entries(patch)
  if (
    entries.some(
      ([key, value]) => !optionKeys.some(option => option === key) || (value !== undefined && !validOption(key as (typeof optionKeys)[number], value))
    )
  )
    return { ok: false, issue: 'node-options-shape' }
  const current = graphNode(node)
  const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !equivalent(current[key as OptionKey], value)))
  if (Object.keys(changes).length === 0) return { ok: true, changed: false }
  // GraphEditor merges and snapshots undefined; export JSON omits the optional
  // field. This narrow cast does not bypass history or mutate editor objects.
  editor.updateNode(nodeId, changes as Partial<GraphNode>)
  return { ok: true, changed: true }
}

/** Add/remove just this declaration; never normalize the other references. */
export function referenceMembership(refs: readonly string[], ref: string, checked: boolean): string[] {
  return checked ? (refs.includes(ref) ? [...refs] : [...refs, ref]) : refs.filter(item => item !== ref)
}

interface ResourceChoice {
  key: string
  refId?: string
  host?: HostResourceCatalogEntry
  label: string
  unavailable: boolean
}
/** Host identities remain opaque. Generated definition keys encode bytes instead of sanitizing identities. */
export function hostResourceRefId(entry: Pick<HostResourceCatalogEntry, 'kind' | 'id'>, resources: Record<string, ResourceRef>): string {
  const existing = Object.entries(resources).find(([, ref]) => ref.kind === entry.kind && ref.source?.kind === 'host' && ref.source.id === entry.id)
  if (existing) return existing[0]
  const identityBytes = new TextEncoder().encode(entry.id)
  const base = `dsh-${entry.kind}-${Array.from(identityBytes, byte => byte.toString(16).padStart(2, '0')).join('')}`
  let key = base
  for (let index = 2; Object.hasOwn(resources, key); index++) key = `${base}-${index}`
  return key
}
function resourceChoices(
  resources: Record<string, ResourceRef>,
  catalog: readonly HostResourceCatalogEntry[],
  kind: ResourceRef['kind'],
  t: BlueprintLocaleProps['t']
): ResourceChoice[] {
  const consumed = new Set<string>()
  const choices: ResourceChoice[] = catalog
    .filter(entry => entry.kind === kind)
    .map(entry => {
      const refId = Object.entries(resources).find(([, ref]) => ref.kind === kind && ref.source?.kind === 'host' && ref.source.id === entry.id)?.[0]
      if (refId) consumed.add(refId)
      return {
        key: refId ?? `host:${entry.kind}:${entry.id}`,
        ...(refId ? { refId } : {}),
        host: entry,
        label: `${entry.displayName} · ${t('resource.host')}${entry.availability === 'unavailable' ? ` · ${t('resource.unavailable')}` : ''}`,
        unavailable: entry.availability === 'unavailable'
      }
    })
  for (const [refId, ref] of Object.entries(resources)) {
    if (ref.kind !== kind || consumed.has(refId)) continue
    const host = ref.source?.kind === 'host'
    const label = kind === 'skill' ? `Skill · ${refId}` : kind === 'mcp' ? `MCP · ${refId}` : refId
    choices.push({ key: refId, refId, label: `${label}${host ? ` · ${t('resource.host')} · ${t('resource.unavailable')}` : ''}`, unavailable: host })
  }
  return choices
}
function issueNotice(issue: InspectorIssue): InspectorNotice {
  if (issue === 'invalid-json') return { key: 'inspector.invalidJsonRetained' }
  if (issue === 'port-types-required') return { key: 'inspector.portTypesRequired' }
  if (issue === 'identity-not-option') return { key: 'inspector.identityNotOption' }
  return { key: 'inspector.invalidJson', params: { code: issue } }
}

/** Draft lifetime is editor+node, never locale or serialized initial values. */
export class InspectorSession {
  private snapshot: InspectorSnapshot
  private jsonBase: Record<JsonField, unknown>
  private jsonDirty = new Set<JsonField>()
  private rowsDirty = new Set<PortField>()
  private rowSequence = 0
  private listeners = new Set<() => void>()
  private unsubscribeEditor: (() => void) | undefined
  private observed: GraphNode
  private modelDirty = false

  constructor(
    private readonly editor: GraphEditor,
    readonly nodeId: string
  ) {
    const node = editor.nodes.find(item => item.id === nodeId)
    if (!node) throw new Error('node-unavailable')
    this.observed = structuredClone(nodeOptions(node))
    this.jsonBase = structuredClone({ inputs: node.inputs, outputs: node.outputs, options: this.observed })
    this.snapshot = {
      json: { inputs: this.serialize(node.inputs), outputs: this.serialize(node.outputs), options: this.serialize(this.observed) },
      rows: { inputs: this.portRows(node.inputs), outputs: this.portRows(node.outputs) },
      notice: null,
      modelRoute: this.modelRoute(this.observed)
    }
  }

  getSnapshot = (): InspectorSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.unsubscribeEditor ??= this.editor.subscribe(this.refresh)
    this.refresh()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.unsubscribeEditor?.()
        this.unsubscribeEditor = undefined
      }
    }
  }
  currentNode(): EditorNode | undefined {
    return this.editor.nodes.find(item => item.id === this.nodeId)
  }
  private serialize(value: unknown): string {
    return JSON.stringify(value, null, 2)
  }
  private modelRoute(node: GraphNode): InspectorSnapshot['modelRoute'] {
    const route = node.modelSelection
    return { explicit: route !== undefined, provider: route?.provider ?? '', model: route?.model ?? '', reasoningEffort: route?.reasoningEffort ?? '' }
  }
  private portRows(value: Record<string, string>, previous: InspectorPortRow[] = []): InspectorPortRow[] {
    return Object.entries(value).map(([name, type], index) => ({ id: previous[index]?.id ?? ++this.rowSequence, name, type }))
  }
  private publish(snapshot: InspectorSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
  private refresh = (): void => {
    const node = this.currentNode()
    if (!node) {
      this.publish({ ...this.snapshot, notice: issueNotice('node-unavailable') })
      return
    }
    const options = nodeOptions(node)
    if (equivalent(this.observed, options)) return
    this.observed = structuredClone(options)
    const json = { ...this.snapshot.json }
    const rows = { ...this.snapshot.rows }
    for (const field of ['inputs', 'outputs', 'options'] as const) {
      const value = field === 'options' ? options : node[field]
      if (!this.jsonDirty.has(field)) {
        json[field] = this.serialize(value)
        this.jsonBase[field] = structuredClone(value)
      }
      if (
        field !== 'options' &&
        !this.rowsDirty.has(field) &&
        !equivalent(
          rows[field].map(row => [row.name, row.type]),
          Object.entries(node[field])
        )
      )
        rows[field] = this.portRows(node[field], rows[field])
    }
    this.publish({ ...this.snapshot, json, rows, modelRoute: this.modelDirty ? this.snapshot.modelRoute : this.modelRoute(options) })
  }

  setJson(field: JsonField, text: string): void {
    this.jsonDirty.add(field)
    this.publish({ ...this.snapshot, json: { ...this.snapshot.json, [field]: text } })
  }
  setPort(field: PortField, id: number, property: 'name' | 'type', value: string): void {
    this.rowsDirty.add(field)
    this.publish({
      ...this.snapshot,
      rows: { ...this.snapshot.rows, [field]: this.snapshot.rows[field].map(row => (row.id === id ? { ...row, [property]: value } : row)) }
    })
  }
  addPort(field: PortField): void {
    this.rowsDirty.add(field)
    this.publish({
      ...this.snapshot,
      rows: { ...this.snapshot.rows, [field]: [...this.snapshot.rows[field], { id: ++this.rowSequence, name: '', type: 'string' }] }
    })
  }
  removePort(field: PortField, id: number): void {
    this.rowsDirty.add(field)
    this.publish({ ...this.snapshot, rows: { ...this.snapshot.rows, [field]: this.snapshot.rows[field].filter(row => row.id !== id) } })
  }
  patch(patch: InspectorNodePatch): InspectorResult {
    const result = applyInspectorPatch(this.editor, this.nodeId, patch)
    this.refresh()
    this.publish({ ...this.snapshot, notice: result.ok ? { key: 'inspector.editApplied' } : issueNotice(result.issue) })
    return result
  }
  setPortVisibility(side: PortSide, visible: boolean): void {
    try {
      this.editor.patchPresentation([this.nodeId], { ports: { [side]: visible } })
      this.publish({ ...this.snapshot, notice: { key: 'inspector.editApplied' } })
    } catch (error) {
      if ((error as { code?: string }).code !== 'port-visibility-connected') throw error
      this.publish({
        ...this.snapshot,
        notice: { key: 'connection.portVisibilityConnected', params: { edgeCount: (error as { params: { edgeCount: number } }).params.edgeCount } }
      })
    }
  }
  bindResource(field: 'agentRef' | 'outputSchemaRef' | 'skillRefs' | 'toolsetRefs', choice: ResourceChoice, checked = true): void {
    const current = this.currentNode()
    if (!current) return
    this.editor.transaction(() => {
      let refId = choice.refId
      if (!refId && choice.host) {
        const resources = this.editor.exportDefinition().resources
        refId = hostResourceRefId(choice.host, resources)
        const source = { kind: 'host' as const, id: choice.host.id }
        this.editor.updateResource(refId, {
          kind: choice.host.kind,
          source,
          ...(choice.host.kind === 'mcp' ? { bindingId: choice.host.bindingId ?? choice.host.id } : {})
        })
      }
      if (!refId) return
      if (field === 'skillRefs' || field === 'toolsetRefs') this.patch({ [field]: referenceMembership(graphNode(current)[field] ?? [], refId, checked) })
      else this.patch({ [field]: refId })
    })
  }
  setModelRoute(field: 'provider' | 'model' | 'reasoningEffort', value: string): void {
    this.modelDirty = true
    this.publish({ ...this.snapshot, modelRoute: { ...this.snapshot.modelRoute, [field]: value } })
  }
  setExplicitModel(explicit: boolean): void {
    this.modelDirty = explicit
    this.publish({ ...this.snapshot, modelRoute: { ...this.snapshot.modelRoute, explicit } })
    if (!explicit) this.patch({ modelSelection: undefined })
  }
  applyModelRoute(): void {
    const route = this.snapshot.modelRoute
    if (!route.explicit) return
    const modelSelection = { provider: route.provider, model: route.model, ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) }
    const result = this.patch({ modelSelection })
    if (result.ok) this.modelDirty = false
  }
  applyJson(field: JsonField): void {
    const node = this.currentNode()
    if (!node) {
      this.publish({ ...this.snapshot, notice: issueNotice('node-unavailable') })
      return
    }
    const parsed = parseInspectorJson(node, field, this.snapshot.json[field])
    if (!parsed.ok) {
      this.publish({ ...this.snapshot, notice: issueNotice(parsed.issue) })
      return
    }
    const base = this.jsonBase[field]
    const patch =
      field === 'options' && object(base)
        ? (Object.fromEntries(Object.entries(parsed.patch).filter(([key, value]) => !equivalent(base[key], value))) as InspectorNodePatch)
        : parsed.patch
    const result = this.patch(patch)
    if (!result.ok) return
    this.jsonDirty.delete(field)
    const current = this.currentNode()!
    const value = field === 'options' ? nodeOptions(current) : current[field]
    this.jsonBase[field] = structuredClone(value)
    // A successful full options apply includes current concurrent field edits.
    this.publish({ ...this.snapshot, json: { ...this.snapshot.json, [field]: this.serialize(value) } })
  }
  applyPorts(field: PortField): void {
    const rows = this.snapshot.rows[field]
    if (new Set(rows.map(row => row.name)).size !== rows.length) {
      this.publish({ ...this.snapshot, notice: issueNotice('duplicate-port-name') })
      return
    }
    const value = Object.fromEntries(rows.map(row => [row.name, row.type]))
    if (!ports(value)) {
      this.publish({ ...this.snapshot, notice: issueNotice('port-types-required') })
      return
    }
    if (this.patch({ [field]: value }).ok) this.rowsDirty.delete(field)
  }
}

export function NodeInspector({ node, editor, resources, resourceCatalog, t, disabled = false }: NodeInspectorProps) {
  const session = useMemo(() => new InspectorSession(editor, node.id), [editor, node.id])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  return renderNodeInspector({ node, editor, resources, ...(resourceCatalog ? { resourceCatalog } : {}), t, disabled }, session, snapshot)
}

/** The same real React props/handlers used by the component, exposed for tests. */
export function renderNodeInspector(
  { node: suppliedNode, editor, resources, resourceCatalog = [], t, disabled = false }: NodeInspectorProps,
  session: InspectorSession,
  snapshot: InspectorSnapshot
) {
  const node = session.currentNode() ?? suppliedNode
  const definition = graphNode(node)
  const capability = nodeDisplayCapabilities(definition)
  const visibility = effectivePortVisibility(node, editor.edges)
  const legacyBindings = Object.fromEntries(
    ['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef', 'modelSelection']
      .filter(key => Object.hasOwn(definition, key))
      .map(key => [key, definition[key as keyof GraphNode]])
  )
  const select = (
    field: 'agentRef' | 'outputSchemaRef',
    kind: ResourceRef['kind'],
    label: 'inspector.agentBinding' | 'inspector.outputSchemaBinding',
    placeholder: 'inspector.selectAgent' | 'inspector.selectOutputSchema'
  ) => {
    const value = definition[field] ?? ''
    const choices = resourceChoices(resources, resourceCatalog, kind, t)
    if (value && !choices.some(choice => choice.refId === value)) choices.push({ key: value, refId: value, label: value, unavailable: true })
    return h(
      'label',
      { key: field, className: 'bp-field' },
      t(label),
      h(
        'select',
        {
          'data-bp-field': field,
          value,
          onChange: (event: ChangeEvent<HTMLSelectElement>) => {
            const choice = choices.find(choice => choice.key === event.currentTarget.value)
            if (choice) session.bindResource(field, choice)
            else session.patch({ [field]: undefined })
          }
        },
        h('option', { value: '' }, t(placeholder)),
        ...choices.map(choice => h('option', { key: choice.key, value: choice.key, disabled: choice.unavailable && choice.refId !== value }, choice.label))
      )
    )
  }
  const references = (field: 'skillRefs' | 'toolsetRefs', kind: ResourceRef['kind'], label: 'inspector.skillBindings' | 'inspector.toolsetBindings') => {
    const values = definition[field] ?? []
    const choices = resourceChoices(resources, resourceCatalog, kind, t)
    for (const ref of values) if (!choices.some(choice => choice.refId === ref)) choices.push({ key: ref, refId: ref, label: ref, unavailable: true })
    return h(
      'fieldset',
      { key: field, className: 'bp-resource-bindings' },
      h('legend', null, t(label)),
      !choices.length && h('p', { className: 'bp-help bp-binding-empty' }, t('inspector.noResources')),
      ...choices.map(choice =>
        h(
          'label',
          { key: choice.key },
          h('input', {
            type: 'checkbox',
            'data-bp-field': field,
            'data-bp-ref': choice.key,
            checked: choice.refId !== undefined && values.includes(choice.refId),
            disabled: choice.unavailable && (choice.refId === undefined || !values.includes(choice.refId)),
            onChange: (event: ChangeEvent<HTMLInputElement>) => session.bindResource(field, choice, event.currentTarget.checked)
          }),
          choice.label
        )
      )
    )
  }
  const portEditor = (field: PortField) => {
    const direction = field === 'inputs' ? 'input' : 'output'
    return h(
      'fieldset',
      { key: field, className: 'bp-port-editor' },
      h('legend', null, t(field === 'inputs' ? 'inspector.inputPorts' : 'inspector.outputPorts')),
      ...snapshot.rows[field].map(row =>
        h(
          'div',
          { key: row.id, className: 'bp-port-row' },
          ...(['name', 'type'] as const).map(property =>
            h(
              'label',
              { key: property },
              t(property === 'name' ? 'inspector.portName' : 'inspector.portType'),
              h('input', {
                'data-bp-field': `${field}.${property}`,
                'data-bp-port-row': row.id,
                value: row[property],
                onChange: (event: ChangeEvent<HTMLInputElement>) => session.setPort(field, row.id, property, event.currentTarget.value)
              })
            )
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'bp-port-remove',
              'aria-label': `${t('inspector.removePort')} ${row.name}`,
              title: t('inspector.removePort'),
              'data-bp-action': `remove-${direction}-port`,
              'data-bp-port-row': row.id,
              onClick: () => session.removePort(field, row.id)
            },
            h(
              'svg',
              {
                width: 16,
                height: 16,
                viewBox: '0 0 24 24',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.6,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true
              },
              h('path', { d: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7' })
            )
          )
        )
      ),
      h(
        'div',
        { className: 'bp-port-actions' },
        h('button', { type: 'button', 'data-bp-action': `add-${direction}-port`, onClick: () => session.addPort(field) }, t('inspector.addPort')),
        h('button', { type: 'button', 'data-bp-action': `apply-${direction}-ports`, onClick: () => session.applyPorts(field) }, t('inspector.applyPorts'))
      )
    )
  }
  return h(
    'div',
    { className: 'bp-node-inspector', 'data-bp-node-inspector': node.id },
    node.kind === 'condition' &&
      h(
        'fieldset',
        { 'data-bp-condition': true },
        h('legend', null, t('inspector.condition')),
        ...(['inputPort', 'trueBranch', 'falseBranch'] as const).map(field => {
          const defaults = {
            inputPort: Object.keys(node.inputs).find(port => node.inputs[port] === 'boolean') ?? '',
            trueBranch: definition.branches?.[0] ?? '',
            falseBranch: definition.branches?.[1] ?? ''
          }
          const config = definition.condition ?? defaults
          const choices = field === 'inputPort' ? Object.keys(node.inputs).filter(port => node.inputs[port] === 'boolean') : (definition.branches ?? [])
          return h(
            'label',
            { key: field },
            t(`inspector.condition.${field}`),
            h(
              'select',
              {
                'data-bp-field': `condition.${field}`,
                value: definition.condition?.[field] ?? '',
                onChange: (event: ChangeEvent<HTMLSelectElement>) => session.patch({ condition: { ...config, [field]: event.currentTarget.value } })
              },
              h('option', { value: '' }, t('inspector.conditionUnset')),
              ...choices.map(value => h('option', { key: value, value }, value))
            )
          )
        }),
        h(
          'button',
          { type: 'button', 'data-bp-action': 'clear-condition', onClick: () => session.patch({ condition: undefined }) },
          t('inspector.conditionClear')
        )
      ),
    node.kind === 'join' &&
      h(
        'label',
        { 'data-bp-join': true },
        t('inspector.join'),
        h(
          'select',
          { 'data-bp-field': 'join', value: definition.join ?? 'all', onChange: () => session.patch({ join: 'all' }) },
          h('option', { value: 'all' }, t('inspector.joinAll')),
          definition.join === 'any' && h('option', { value: 'any', disabled: true }, t('inspector.joinAnyUnavailable'))
        )
      ),
    capability.agentBindings && select('agentRef', 'agent', 'inspector.agentBinding', 'inspector.selectAgent'),
    capability.modelRoute &&
      h(
        'fieldset',
        { className: 'bp-model-route', 'data-bp-model-route': true },
        h('legend', null, t('inspector.modelRoute')),
        h(
          'label',
          null,
          h(
            'select',
            {
              'data-bp-field': 'model-mode',
              'aria-label': t('inspector.modelRoute'),
              value: snapshot.modelRoute.explicit ? 'explicit' : 'default',
              onChange: (event: ChangeEvent<HTMLSelectElement>) => session.setExplicitModel(event.currentTarget.value === 'explicit')
            },
            h('option', { value: 'default' }, t('inspector.hostModelDefault')),
            h('option', { value: 'explicit' }, t('inspector.explicitModel'))
          )
        ),
        snapshot.modelRoute.explicit &&
          h(
            'div',
            { className: 'bp-model-fields' },
            ...(['provider', 'model', 'reasoningEffort'] as const).map(field =>
              h(
                'label',
                { key: field, className: 'bp-field' },
                t(field === 'provider' ? 'inspector.modelProvider' : field === 'model' ? 'inspector.modelName' : 'inspector.reasoningEffort'),
                h('input', {
                  'data-bp-field': `modelSelection.${field}`,
                  value: snapshot.modelRoute[field],
                  onChange: (event: ChangeEvent<HTMLInputElement>) => session.setModelRoute(field, event.currentTarget.value)
                })
              )
            ),
            h('button', { type: 'button', 'data-bp-action': 'apply-model-route', onClick: () => session.applyModelRoute() }, t('inspector.applyNodeOptions'))
          )
      ),
    capability.agentBindings && references('skillRefs', 'skill', 'inspector.skillBindings'),
    capability.agentBindings && references('toolsetRefs', 'mcp', 'inspector.toolsetBindings'),
    capability.agentBindings && select('outputSchemaRef', 'schema', 'inspector.outputSchemaBinding', 'inspector.selectOutputSchema'),
    capability.agentBindings && h('p', { className: 'bp-muted' }, t('resource.availabilityUnchecked')),
    !capability.agentBindings &&
      Object.keys(legacyBindings).length > 0 &&
      h(
        'details',
        { 'data-bp-legacy-bindings': true },
        h('summary', null, t('inspector.legacyBindings')),
        h('p', null, t('inspector.legacyBindingsUnused')),
        h('pre', null, JSON.stringify(legacyBindings, null, 2))
      ),
    h(
      'fieldset',
      { 'data-bp-port-visibility': true },
      h('legend', null, t('port.visibility')),
      h('p', null, t('port.visibilityHelp')),
      ...(['control', 'inputs', 'outputs'] as const).map(side =>
        h(
          'label',
          { key: side, style: { display: 'flex', alignItems: 'center', minHeight: 40, cursor: 'pointer' } },
          h('input', {
            type: 'checkbox',
            'data-bp-port-toggle': side,
            'aria-label': t(`port.visibility.${side}`),
            checked: visibility[side],
            disabled,
            onChange: (event: ChangeEvent<HTMLInputElement>) => session.setPortVisibility(side, event.currentTarget.checked)
          }),
          t(`port.visibility.${side}`),
          node.presentation?.ports?.[side] === false &&
            connectedPortEdges(node.id, side, editor.edges) > 0 &&
            h('small', { 'data-bp-port-edge-priority': side }, t('port.connectedVisible'))
        )
      )
    ),
    portEditor('inputs'),
    portEditor('outputs'),
    h(
      'details',
      { key: 'advanced' },
      h('summary', { 'data-bp-inspector-advanced': true }, t('inspector.advanced')),
      ...(['inputs', 'outputs', 'options'] as const).map(field =>
        h(
          'label',
          { key: field },
          t(field === 'options' ? 'inspector.nodeOptions' : field === 'inputs' ? 'inspector.inputPorts' : 'inspector.outputPorts'),
          h(JsonEditor, {
            key: `json-${field}`,
            'data-bp-json': field,
            label: t(field === 'options' ? 'inspector.nodeOptions' : field === 'inputs' ? 'inspector.inputPorts' : 'inspector.outputPorts'),
            t,
            disabled,
            value: snapshot.json[field],
            rows: field === 'options' ? 8 : 3,
            onChange: text => session.setJson(field, text),
            onBlur: () => session.applyJson(field)
          })
        )
      ),
      h('button', { type: 'button', 'data-bp-action': 'apply-node-options', onClick: () => session.applyJson('options') }, t('inspector.applyNodeOptions'))
    ),
    snapshot.notice
      ? h(
          'p',
          { role: 'status', 'data-bp-inspector-notice': snapshot.notice.key },
          t(snapshot.notice.key, 'params' in snapshot.notice ? snapshot.notice.params : undefined)
        )
      : null
  )
}
