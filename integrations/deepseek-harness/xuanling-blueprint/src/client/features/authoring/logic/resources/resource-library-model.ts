import type { ResourceRef, PresentationResourceMetadata } from '../../../../../definition/types.ts'
import type { HostResourceCatalogEntry } from '../../../../adapters/host/remote.ts'
import { resourceConfiguration, resourceMetadataDetail } from './resource-details.ts'

export type ResourceCategory = 'agent' | 'skill' | 'mcp' | 'other'
export interface ResourceLibraryRow {
  key: string
  id: string
  kind: ResourceRef['kind']
  displayName: string
  source: 'dsh' | 'blueprint'
  availability: 'available' | 'unavailable' | 'unknown'
  description: string
  configuration: ReturnType<typeof resourceConfiguration>
  metadata: ReturnType<typeof resourceMetadataDetail>
  refId?: string
  ref?: ResourceRef
}
const resourceCategory = (kind: ResourceRef['kind']): ResourceCategory => (kind === 'agent' || kind === 'skill' || kind === 'mcp' ? kind : 'other')
export function resourceRows(
  definition: { resources?: Record<string, ResourceRef>; presentation?: { resources?: Record<string, PresentationResourceMetadata> } } | null,
  catalog: readonly HostResourceCatalogEntry[],
  catalogState: 'loading' | 'current' | 'unavailable'
): Record<ResourceCategory, ResourceLibraryRow[]> {
  const rows: ResourceLibraryRow[] = []
  const refs = definition?.resources ?? {}
  const seenHost = new Set<string>()
  for (const entry of catalog) {
    const matching = Object.entries(refs).find(([, ref]) => ref.kind === entry.kind && ref.source?.kind === 'host' && ref.source.id === entry.id)
    const refId = matching?.[0]
    const metadata = refId ? definition?.presentation?.resources?.[refId] : undefined
    const ref = matching?.[1]
    rows.push({
      key: `dsh:${entry.kind}:${entry.id}`,
      id: entry.id,
      kind: entry.kind,
      displayName: metadata?.title?.trim() || entry.displayName || entry.id,
      source: 'dsh',
      availability: catalogState === 'current' ? entry.availability : 'unknown',
      description: metadata?.description ?? entry.description ?? '',
      configuration: resourceConfiguration(ref, entry.id),
      metadata: resourceMetadataDetail(ref, entry.id, metadata, entry.displayName, entry.description),
      ...(refId && ref ? { refId, ref: structuredClone(ref) } : {})
    })
    seenHost.add(`${entry.kind}:${entry.id}`)
  }
  for (const [id, ref] of Object.entries(refs)) {
    if (ref.source?.kind === 'host' && (ref.kind === 'agent' || ref.kind === 'skill' || ref.kind === 'mcp')) {
      const key = `${ref.kind}:${ref.source.id}`
      if (seenHost.has(key)) continue
      const metadata = definition?.presentation?.resources?.[id]
      rows.push({
        key: `dsh:${key}`,
        id: ref.source.id,
        kind: ref.kind,
        displayName: metadata?.title?.trim() || ref.source.id,
        source: 'dsh',
        availability: catalogState === 'loading' || catalogState === 'unavailable' ? 'unknown' : 'unavailable',
        description: metadata?.description ?? '',
        configuration: resourceConfiguration(ref, ref.source.id),
        metadata: resourceMetadataDetail(ref, ref.source.id, metadata),
        refId: id,
        ref: structuredClone(ref)
      })
      seenHost.add(key)
      continue
    }
    const metadata = definition?.presentation?.resources?.[id]
    const displayName = metadata?.title?.trim() || id
    rows.push({
      key: `blueprint:${id}`,
      id,
      kind: ref.kind,
      displayName,
      source: 'blueprint',
      availability: 'available',
      description: metadata?.description ?? '',
      configuration: resourceConfiguration(ref, id),
      metadata: resourceMetadataDetail(ref, id, metadata),
      refId: id,
      ref: structuredClone(ref)
    })
  }
  const grouped: Record<ResourceCategory, ResourceLibraryRow[]> = { agent: [], skill: [], mcp: [], other: [] }
  for (const row of rows) grouped[resourceCategory(row.kind)].push(row)
  for (const group of Object.values(grouped)) group.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
  return grouped
}
