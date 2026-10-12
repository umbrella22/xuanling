/** Client-only editing drafts. The Host remains the authority on Save. */
import { createElement as h, useMemo, useSyncExternalStore } from 'react'
import type { ChangeEvent } from 'react'
import type { GraphNode, ResourceRef } from '../definition/types.ts'
import type { EditorNode, GraphEditor } from './graph-editor.ts'
import type { BlueprintLocaleProps } from './locales.ts'

export interface NodeInspectorProps {
  node: EditorNode
  editor: GraphEditor
  resources: Record<string, ResourceRef>
  t: BlueprintLocaleProps['t']
}

type PortField = 'inputs' | 'outputs'
type JsonField = PortField | 'options'
type OptionKey = Exclude<keyof GraphNode, 'id' | 'kind'>
/** Undefined clears an optional field through the editor's merge/JSON boundary. */
export type InspectorNodePatch = { [K in OptionKey]?: GraphNode[K] | undefined }
type InspectorIssue = 'invalid-json' | 'port-types-required' | 'identity-not-option' | 'node-options-shape' | 'duplicate-port-name' | 'node-unavailable'
type InspectorResult = { ok: true; changed: boolean } | { ok: false; issue: InspectorIssue }
type InspectorNotice = { key: 'inspector.editApplied' | 'inspector.invalidJsonRetained' | 'inspector.portTypesRequired' | 'inspector.identityNotOption' }
  | { key: 'inspector.invalidJson'; params: { code: InspectorIssue } }
export interface InspectorPortRow { id: number; name: string; type: string }
export interface InspectorSnapshot {
  json: Record<JsonField, string>
  rows: Record<PortField, InspectorPortRow[]>
  notice: InspectorNotice | null
}

const optionKeys = ['inputs', 'outputs', 'agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef', 'join', 'branches', 'budget', 'subflowRef', 'condition', 'toolAllowlist'] as const satisfies readonly OptionKey[]
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
  return Object.fromEntries(Object.entries(definition).filter(([key]) => key === 'id' || key === 'kind' || optionKeys.some(option => option === key))) as unknown as GraphNode
}
function validOption(key: typeof optionKeys[number], value: unknown): boolean {
  switch (key) {
    case 'inputs': case 'outputs': return ports(value)
    case 'skillRefs': case 'toolsetRefs': case 'branches': case 'toolAllowlist': return stringList(value)
    case 'agentRef': case 'outputSchemaRef': case 'subflowRef': return typeof value === 'string' && value.length > 0
    case 'condition': return object(value) && Object.keys(value).length === 3
      && ['inputPort', 'trueBranch', 'falseBranch'].every(key => typeof value[key] === 'string' && value[key] !== '')
    case 'join': return value === 'all' || value === 'any'
    case 'budget': return object(value) && Object.keys(value).every(key => key === 'maxIterations' || key === 'maxDurationMs')
      && Number.isInteger(value.maxIterations) && Number.isInteger(value.maxDurationMs)
  }
}

/** Only JSON and field shape preflight, not reference/graph/Host validation. */
export function parseInspectorJson(node: EditorNode, field: JsonField, text: string): { ok: true; patch: InspectorNodePatch } | { ok: false; issue: InspectorIssue } {
  let value: unknown
  try { value = JSON.parse(text) } catch { return { ok: false, issue: 'invalid-json' } }
  if (field !== 'options') return ports(value) ? { ok: true, patch: { [field]: value } } : { ok: false, issue: 'port-types-required' }
  if (!object(value)) return { ok: false, issue: 'node-options-shape' }
  if ((Object.hasOwn(value, 'id') && value.id !== node.id) || (Object.hasOwn(value, 'kind') && value.kind !== node.kind)) return { ok: false, issue: 'identity-not-option' }
  const entries = Object.entries(value).filter(([key]) => key !== 'id' && key !== 'kind')
  if (entries.some(([key, item]) => !optionKeys.some(option => option === key) || !validOption(key as typeof optionKeys[number], item))) return { ok: false, issue: 'node-options-shape' }
  // Omitted fields deliberately retain the legacy merge behavior (not deletion).
  return { ok: true, patch: Object.fromEntries(entries) as InspectorNodePatch }
}

export function applyInspectorPatch(editor: GraphEditor, nodeId: string, patch: InspectorNodePatch): InspectorResult {
  const node = editor.nodes.find(item => item.id === nodeId)
  if (!node) return { ok: false, issue: 'node-unavailable' }
  const entries = Object.entries(patch)
  if (entries.some(([key, value]) => !optionKeys.some(option => option === key) || (value !== undefined && !validOption(key as typeof optionKeys[number], value)))) return { ok: false, issue: 'node-options-shape' }
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

  constructor(private readonly editor: GraphEditor, readonly nodeId: string) {
    const node = editor.nodes.find(item => item.id === nodeId)
    if (!node) throw new Error('node-unavailable')
    this.observed = structuredClone(nodeOptions(node))
    this.jsonBase = structuredClone({ inputs: node.inputs, outputs: node.outputs, options: this.observed })
    this.snapshot = {
      json: { inputs: this.serialize(node.inputs), outputs: this.serialize(node.outputs), options: this.serialize(this.observed) },
      rows: { inputs: this.portRows(node.inputs), outputs: this.portRows(node.outputs) }, notice: null,
    }
  }

  getSnapshot = (): InspectorSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    this.unsubscribeEditor ??= this.editor.subscribe(this.refresh)
    this.refresh()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) { this.unsubscribeEditor?.(); this.unsubscribeEditor = undefined }
    }
  }
  currentNode(): EditorNode | undefined { return this.editor.nodes.find(item => item.id === this.nodeId) }
  private serialize(value: unknown): string { return JSON.stringify(value, null, 2) }
  private portRows(value: Record<string, string>, previous: InspectorPortRow[] = []): InspectorPortRow[] {
    return Object.entries(value).map(([name, type], index) => ({ id: previous[index]?.id ?? ++this.rowSequence, name, type }))
  }
  private publish(snapshot: InspectorSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
  private refresh = (): void => {
    const node = this.currentNode()
    if (!node) { this.publish({ ...this.snapshot, notice: issueNotice('node-unavailable') }); return }
    const options = nodeOptions(node)
    if (equivalent(this.observed, options)) return
    this.observed = structuredClone(options)
    const json = { ...this.snapshot.json }
    const rows = { ...this.snapshot.rows }
    for (const field of ['inputs', 'outputs', 'options'] as const) {
      const value = field === 'options' ? options : node[field]
      if (!this.jsonDirty.has(field)) { json[field] = this.serialize(value); this.jsonBase[field] = structuredClone(value) }
      if (field !== 'options' && !this.rowsDirty.has(field) && !equivalent(rows[field].map(row => [row.name, row.type]), Object.entries(node[field]))) rows[field] = this.portRows(node[field], rows[field])
    }
    this.publish({ ...this.snapshot, json, rows })
  }

  setJson(field: JsonField, text: string): void {
    this.jsonDirty.add(field)
    this.publish({ ...this.snapshot, json: { ...this.snapshot.json, [field]: text } })
  }
  setPort(field: PortField, id: number, property: 'name' | 'type', value: string): void {
    this.rowsDirty.add(field)
    this.publish({ ...this.snapshot, rows: { ...this.snapshot.rows, [field]: this.snapshot.rows[field].map(row => row.id === id ? { ...row, [property]: value } : row) } })
  }
  addPort(field: PortField): void {
    this.rowsDirty.add(field)
    this.publish({ ...this.snapshot, rows: { ...this.snapshot.rows, [field]: [...this.snapshot.rows[field], { id: ++this.rowSequence, name: '', type: 'string' }] } })
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
  applyJson(field: JsonField): void {
    const node = this.currentNode()
    if (!node) { this.publish({ ...this.snapshot, notice: issueNotice('node-unavailable') }); return }
    const parsed = parseInspectorJson(node, field, this.snapshot.json[field])
    if (!parsed.ok) { this.publish({ ...this.snapshot, notice: issueNotice(parsed.issue) }); return }
    const base = this.jsonBase[field]
    const patch = field === 'options' && object(base)
      ? Object.fromEntries(Object.entries(parsed.patch).filter(([key, value]) => !equivalent(base[key], value))) as InspectorNodePatch
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
    if (new Set(rows.map(row => row.name)).size !== rows.length) { this.publish({ ...this.snapshot, notice: issueNotice('duplicate-port-name') }); return }
    const value = Object.fromEntries(rows.map(row => [row.name, row.type]))
    if (!ports(value)) { this.publish({ ...this.snapshot, notice: issueNotice('port-types-required') }); return }
    if (this.patch({ [field]: value }).ok) this.rowsDirty.delete(field)
  }
}

export function NodeInspector({ node, editor, resources, t }: NodeInspectorProps) {
  const session = useMemo(() => new InspectorSession(editor, node.id), [editor, node.id])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  return renderNodeInspector({ node, editor, resources, t }, session, snapshot)
}

/** The same real React props/handlers used by the component, exposed for tests. */
export function renderNodeInspector({ node: suppliedNode, resources, t }: NodeInspectorProps, session: InspectorSession, snapshot: InspectorSnapshot) {
  const node = session.currentNode() ?? suppliedNode
  const definition = graphNode(node)
  const select = (field: 'agentRef' | 'outputSchemaRef', kind: ResourceRef['kind'], label: 'inspector.agentBinding' | 'inspector.outputSchemaBinding', placeholder: 'inspector.selectAgent' | 'inspector.selectOutputSchema') => {
    const value = definition[field] ?? ''
    const refs = Object.entries(resources).filter(([, resource]) => resource.kind === kind).map(([ref]) => ref)
    if (value && !refs.includes(value)) refs.push(value)
    return h('label', { key: field, className: 'bp-field' }, t(label),
      h('select', { 'data-bp-field': field, value, onChange: (event: ChangeEvent<HTMLSelectElement>) => session.patch({ [field]: event.currentTarget.value || undefined }) },
        h('option', { value: '' }, t(placeholder)), ...refs.map(ref => h('option', { key: ref, value: ref }, ref))))
  }
  const references = (field: 'skillRefs' | 'toolsetRefs', kind: ResourceRef['kind'], label: 'inspector.skillBindings' | 'inspector.toolsetBindings') => {
    const values = definition[field] ?? []
    const refs = Object.entries(resources).filter(([, resource]) => resource.kind === kind).map(([ref]) => ref)
    for (const ref of values) if (!refs.includes(ref)) refs.push(ref)
    return h('fieldset', { key: field, className: 'bp-resource-bindings' }, h('legend', null, t(label)), ...refs.map(ref => h('label', { key: ref },
      h('input', { type: 'checkbox', 'data-bp-field': field, 'data-bp-ref': ref, checked: values.includes(ref),
        onChange: (event: ChangeEvent<HTMLInputElement>) => session.patch({ [field]: referenceMembership(graphNode(session.currentNode() ?? node)[field] ?? [], ref, event.currentTarget.checked) }) }),
      field === 'skillRefs' ? t('resource.skillBinding', { id: ref }) : `${t('resource.kind.mcp')} · ${ref}`)))
  }
  const portEditor = (field: PortField) => {
    const direction = field === 'inputs' ? 'input' : 'output'
    return h('fieldset', { key: field, className: 'bp-port-editor' }, h('legend', null, t(field === 'inputs' ? 'inspector.inputPorts' : 'inspector.outputPorts')),
      ...snapshot.rows[field].map(row => h('div', { key: row.id, className: 'bp-port-row' },
        ...(['name', 'type'] as const).map(property => h('label', { key: property }, t(property === 'name' ? 'inspector.portName' : 'inspector.portType'),
          h('input', { 'data-bp-field': `${field}.${property}`, 'data-bp-port-row': row.id, value: row[property],
            onChange: (event: ChangeEvent<HTMLInputElement>) => session.setPort(field, row.id, property, event.currentTarget.value) }))),
        h('button', { type: 'button', 'data-bp-action': `remove-${direction}-port`, 'data-bp-port-row': row.id, onClick: () => session.removePort(field, row.id) }, t('inspector.removePort')))),
      h('button', { type: 'button', 'data-bp-action': `add-${direction}-port`, onClick: () => session.addPort(field) }, t('inspector.addPort')),
      h('button', { type: 'button', 'data-bp-action': `apply-${direction}-ports`, onClick: () => session.applyPorts(field) }, t('inspector.applyPorts')))
  }
  return h('div', { className: 'bp-node-inspector', 'data-bp-node-inspector': node.id },
    node.kind === 'condition' && h('fieldset', { 'data-bp-condition': true }, h('legend', null, t('inspector.condition')),
      ...(['inputPort', 'trueBranch', 'falseBranch'] as const).map(field => {
        const defaults = { inputPort: Object.keys(node.inputs).find(port => node.inputs[port] === 'boolean') ?? '', trueBranch: definition.branches?.[0] ?? '', falseBranch: definition.branches?.[1] ?? '' }
        const config = definition.condition ?? defaults
        const choices = field === 'inputPort' ? Object.keys(node.inputs).filter(port => node.inputs[port] === 'boolean') : definition.branches ?? []
        return h('label', { key: field }, t(`inspector.condition.${field}`), h('select', { 'data-bp-field': `condition.${field}`, value: definition.condition?.[field] ?? '',
          onChange: (event: ChangeEvent<HTMLSelectElement>) => session.patch({ condition: { ...config, [field]: event.currentTarget.value } }) },
          h('option', { value: '' }, t('inspector.conditionUnset')), ...choices.map(value => h('option', { key: value, value }, value))))
      }),
      h('button', { type: 'button', 'data-bp-action': 'clear-condition', onClick: () => session.patch({ condition: undefined }) }, t('inspector.conditionClear'))),
    node.kind === 'join' && h('label', { 'data-bp-join': true }, t('inspector.join'), h('select', { 'data-bp-field': 'join', value: definition.join ?? 'all',
      onChange: () => session.patch({ join: 'all' }) }, h('option', { value: 'all' }, t('inspector.joinAll')),
      definition.join === 'any' && h('option', { value: 'any', disabled: true }, t('inspector.joinAnyUnavailable')))),
    select('agentRef', 'agent', 'inspector.agentBinding', 'inspector.selectAgent'),
    references('skillRefs', 'skill', 'inspector.skillBindings'), references('toolsetRefs', 'mcp', 'inspector.toolsetBindings'),
    select('outputSchemaRef', 'schema', 'inspector.outputSchemaBinding', 'inspector.selectOutputSchema'),
    h('p', { className: 'bp-muted' }, t('resource.availabilityUnchecked')), portEditor('inputs'), portEditor('outputs'),
    h('details', { key: 'advanced' }, h('summary', { 'data-bp-inspector-advanced': true }, t('inspector.advanced')),
      ...(['inputs', 'outputs', 'options'] as const).map(field => h('label', { key: field }, t(field === 'options' ? 'inspector.nodeOptions' : field === 'inputs' ? 'inspector.inputPorts' : 'inspector.outputPorts'),
        h('textarea', { key: `json-${field}`, 'data-bp-json': field, value: snapshot.json[field], rows: field === 'options' ? 8 : 3,
          onChange: (event: ChangeEvent<HTMLTextAreaElement>) => session.setJson(field, event.currentTarget.value), onBlur: () => session.applyJson(field) }))),
      h('button', { type: 'button', 'data-bp-action': 'apply-node-options', onClick: () => session.applyJson('options') }, t('inspector.applyNodeOptions'))),
    snapshot.notice ? h('p', { role: 'status', 'data-bp-inspector-notice': snapshot.notice.key }, t(snapshot.notice.key, 'params' in snapshot.notice ? snapshot.notice.params : undefined)) : null)
}
