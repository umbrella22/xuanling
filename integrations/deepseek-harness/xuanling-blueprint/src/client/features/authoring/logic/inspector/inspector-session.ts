/** Per-editor/node draft lifetime. No framework, browser, or Host effects. */
import type { GraphNode } from '../../../../../definition/types.ts'
import type { EditorNode, GraphEditor } from '../graph/graph-editor.ts'
import type { PortSide } from '../graph/port-visibility.ts'
import {
  nodeOptions,
  graphNode,
  equivalent,
  ports,
  parseInspectorJson,
  deriveInspectorPatch,
  inspectorOptionDelta,
  issueNotice,
  hostResourceRefId,
  referenceMembership
} from './inspector-commands.ts'
import type { InspectorSnapshot, InspectorNodePatch, InspectorResult, InspectorPortRow, JsonField, PortField, ResourceChoice } from './inspector-commands.ts'
/** The only patch mutation adapter: decisions are pure, history stays with GraphEditor. */
export function applyInspectorPatch(editor: GraphEditor, nodeId: string, patch: InspectorNodePatch): InspectorResult {
  const node = editor.nodes.find(item => item.id === nodeId)
  if (!node) return { ok: false, issue: 'node-unavailable' }
  const decision = deriveInspectorPatch(node, patch)
  if (!decision.ok) return decision
  if (decision.changed) editor.updateNode(nodeId, decision.changes as Partial<GraphNode>)
  return { ok: true, changed: decision.changed }
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
    const patch = field === 'options' ? inspectorOptionDelta(base, parsed.patch) : parsed.patch
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
