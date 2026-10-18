/** Pure Inspector parsing and patch decisions; semantic mutations stay in the session adapter. */
import type { GraphNode, ResourceRef } from '../../../../../definition/types.ts'
import type { EditorNode } from '../graph/graph-editor.ts'
import type { HostResourceCatalogEntry } from '../../../../adapters/host/remote.ts'
export type PortField = 'inputs' | 'outputs'
export type JsonField = PortField | 'options'
export type OptionKey = Exclude<keyof GraphNode, 'id' | 'kind'>
/** Undefined clears an optional field through the editor's merge/JSON boundary. */
export type InspectorNodePatch = { [K in OptionKey]?: GraphNode[K] | undefined }
export type InspectorIssue = 'invalid-json' | 'port-types-required' | 'identity-not-option' | 'node-options-shape' | 'duplicate-port-name' | 'node-unavailable'
export type InspectorResult = { ok: true; changed: boolean } | { ok: false; issue: InspectorIssue }
export type InspectorNotice =
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
  'condition',
  'toolAllowlist',
  'modelSelection'
] as const satisfies readonly OptionKey[]
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function ports(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every(item => typeof item === 'string' && item.length > 0)
}
function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0)
}
/** JSON value equivalence: object key order is not an edit; array order is. */
export function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => equivalent(item, b[index]))
  if (!object(a) || !object(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equivalent(a[key], b[key]))
}
export function graphNode(node: EditorNode): GraphNode {
  return node.definition ?? { id: node.id, kind: node.kind as GraphNode['kind'], inputs: node.inputs, outputs: node.outputs }
}
export function nodeOptions(node: EditorNode): GraphNode {
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
      return typeof value === 'string' && value.length > 0
    case 'condition':
      return (
        object(value) &&
        Object.keys(value).length === 3 &&
        ['inputPort', 'trueBranch', 'falseBranch'].every(key => typeof value[key] === 'string' && value[key] !== '')
      )
    case 'join':
      return value === 'all'
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

/** Derive a field delta without mutating the editor or its node. */
export function deriveInspectorPatch(
  node: EditorNode,
  patch: InspectorNodePatch
): { ok: true; changed: boolean; changes: InspectorNodePatch } | { ok: false; issue: InspectorIssue } {
  const entries = Object.entries(patch)
  if (
    entries.some(
      ([key, value]) => !optionKeys.some(option => option === key) || (value !== undefined && !validOption(key as (typeof optionKeys)[number], value))
    )
  )
    return { ok: false, issue: 'node-options-shape' }
  const current = graphNode(node)
  const changes = Object.fromEntries(Object.entries(patch).filter(([key, value]) => !equivalent(current[key as OptionKey], value)))
  if (Object.keys(changes).length === 0) return { ok: true, changed: false, changes: {} }
  return { ok: true, changed: true, changes: changes as InspectorNodePatch }
}
/** Full options buffers apply only fields changed from their draft baseline. */
export function inspectorOptionDelta(base: unknown, patch: InspectorNodePatch): InspectorNodePatch {
  return object(base) ? (Object.fromEntries(Object.entries(patch).filter(([key, value]) => !equivalent(base[key], value))) as InspectorNodePatch) : patch
}
/** Add/remove just this declaration; never normalize the other references. */
export function referenceMembership(refs: readonly string[], ref: string, checked: boolean): string[] {
  return checked ? (refs.includes(ref) ? [...refs] : [...refs, ref]) : refs.filter(item => item !== ref)
}

export interface ResourceChoice {
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
export function issueNotice(issue: InspectorIssue): InspectorNotice {
  if (issue === 'invalid-json') return { key: 'inspector.invalidJsonRetained' }
  if (issue === 'port-types-required') return { key: 'inspector.portTypesRequired' }
  if (issue === 'identity-not-option') return { key: 'inspector.identityNotOption' }
  return { key: 'inspector.invalidJson', params: { code: issue } }
}
