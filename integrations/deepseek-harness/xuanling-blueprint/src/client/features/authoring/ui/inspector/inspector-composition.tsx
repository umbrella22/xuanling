/** Client-only editing drafts. The Host remains the authority on Save. */
import { useMemo, useSyncExternalStore, useRef, useEffect } from 'react'
import type { ResourceRef } from '../../../../../definition/types.ts'
import type { HostResourceCatalogEntry } from '../../../../adapters/host/remote.ts'
import type { EditorNode, GraphEditor } from '../../logic/graph/graph-editor.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'

export interface NodeInspectorProps {
  node: EditorNode
  disabled?: boolean
  editor: GraphEditor
  resources: Record<string, ResourceRef>
  resourceCatalog?: readonly HostResourceCatalogEntry[]
  t: BlueprintLocaleProps['t']
}

import { InspectorSession } from '../../logic/inspector/inspector-session.ts'
import { graphNode } from '../../logic/inspector/inspector-commands.ts'
import type { InspectorSnapshot, ResourceChoice } from '../../logic/inspector/inspector-commands.ts'
export { InspectorSession, applyInspectorPatch } from '../../logic/inspector/inspector-session.ts'
export { parseInspectorJson, referenceMembership, hostResourceRefId } from '../../logic/inspector/inspector-commands.ts'
export type { InspectorNodePatch, InspectorSnapshot, InspectorPortRow } from '../../logic/inspector/inspector-commands.ts'
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
export function NodeInspector(props: NodeInspectorProps) {
  const { node, editor, resources, resourceCatalog, t, disabled = false } = props
  const session = useMemo(() => new InspectorSession(editor, node.id), [editor, node.id])
  const owner = useRef({ session, props, active: true })
  owner.current = { session, props, active: true }
  useEffect(() => {
    owner.current.active = true
    return () => {
      if (owner.current.session === session) owner.current.active = false
    }
  }, [session])
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)
  return renderNodeInspector({ node, editor, resources, ...(resourceCatalog ? { resourceCatalog } : {}), t, disabled }, session, snapshot, {
    isCurrent: () => owner.current.active && owner.current.session === session,
    isDisabled: () => owner.current.props.disabled ?? false,
    currentProps: () => owner.current.props
  })
}

import { projectInspector } from '../../presenters/inspector-presenter.ts'
import type { BindingField, InspectorResourceOption } from '../../presenters/inspector-presenter.ts'
import { inspectorView } from './inspector-view.tsx'
import { dispatchInspectorIntent } from '../../logic/inspector/inspector-command-adapter.ts'
import type { InspectorViewIntent } from '../../logic/inspector/inspector-command-adapter.ts'
const bindingKind = { agentRef: 'agent', outputSchemaRef: 'schema', skillRefs: 'skill', toolsetRefs: 'mcp' } as const
function currentChoices(props: NodeInspectorProps, session: InspectorSession, field: BindingField): ResourceChoice[] {
  const node = session.currentNode() ?? props.node,
    definition = graphNode(node)
  const choices = resourceChoices(props.editor.exportDefinition().resources, props.resourceCatalog ?? [], bindingKind[field], props.t)
  const raw = definition[field],
    values = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const value of values) if (!choices.some(choice => choice.refId === value)) choices.push({ key: value, refId: value, label: value, unavailable: true })
  return choices
}
export interface InspectorAdmission {
  currentProps?: () => NodeInspectorProps
  isCurrent?: () => boolean
  isDisabled?: () => boolean
}
/** Compatibility tree export: only detached display data reaches the TSX view. */
export function renderNodeInspector(props: NodeInspectorProps, session: InspectorSession, snapshot: InspectorSnapshot, admission: InspectorAdmission = {}) {
  const node = session.currentNode() ?? props.node,
    definition = graphNode(node)
  const fields = ['agentRef', 'outputSchemaRef', 'skillRefs', 'toolsetRefs'] as const
  const choices = Object.fromEntries(
    fields.map(field => [
      field,
      currentChoices(props, session, field).map(choice => {
        const raw = definition[field],
          checked = choice.refId !== undefined && (Array.isArray(raw) ? raw.includes(choice.refId) : raw === choice.refId)
        return { key: choice.key, label: choice.label, checked, disabled: choice.unavailable && !checked }
      })
    ])
  ) as Record<BindingField, InspectorResourceOption[]>
  const model = projectInspector({ node, edges: props.editor.edges, snapshot, disabled: props.disabled ?? false, choices })
  const onIntent = (intent: InspectorViewIntent) =>
    dispatchInspectorIntent(
      {
        session,
        isCurrent: admission.isCurrent ?? (() => true),
        isDisabled: admission.isDisabled ?? (() => props.disabled ?? false),
        resourceChoices: field => currentChoices(admission.currentProps?.() ?? props, session, field)
      },
      intent
    )
  return inspectorView(model, props.t, onIntent)
}
