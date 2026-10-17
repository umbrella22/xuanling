import type { PresentationResourceMetadata, ResourceRef } from '../../../../../definition/types.ts'

export type ResourceMetadataSource = 'presentation' | 'host' | 'reference' | 'none'

export interface ResourceConfigurationDetail {
  source: 'host' | 'shared' | 'package' | 'unbound'
  identity: string
  path?: string
  bindingId?: string
  format?: ResourceRef['format']
}

export interface ResourceMetadataDetail {
  titleSource: ResourceMetadataSource
  descriptionSource: ResourceMetadataSource
}

/** Pure resource projection and draft normalization shared by the model and
 * the resource dialog renderer. Host URL/header/env/credential/preset bodies
 * never enter this projection. */
export function resourceConfiguration(ref: ResourceRef | undefined, fallbackId: string): ResourceConfigurationDetail {
  if (!ref) return { source: 'unbound', identity: fallbackId }
  if (ref.source?.kind === 'host')
    return {
      source: 'host',
      identity: ref.source.id,
      ...(ref.bindingId ? { bindingId: ref.bindingId } : {})
    }
  if (ref.source?.kind === 'shared') return { source: 'shared', identity: ref.source.rootId, path: ref.source.path }
  if (ref.source?.kind === 'package')
    return {
      source: 'package',
      identity: ref.source.path,
      path: ref.source.path,
      ...(ref.format ? { format: ref.format } : {})
    }
  return {
    source: 'package',
    identity: ref.path ?? fallbackId,
    ...(ref.path ? { path: ref.path } : {}),
    ...(ref.bindingId ? { bindingId: ref.bindingId } : {}),
    ...(ref.format ? { format: ref.format } : {})
  }
}

export function resourceMetadataDetail(
  ref: ResourceRef | undefined,
  fallbackId: string,
  metadata: PresentationResourceMetadata | undefined,
  hostTitle?: string,
  hostDescription?: string
): ResourceMetadataDetail {
  const configuration = resourceConfiguration(ref, fallbackId)
  return {
    titleSource: metadata?.title?.trim() ? 'presentation' : hostTitle?.trim() ? 'host' : configuration.identity ? 'reference' : 'none',
    descriptionSource: metadata?.description?.trim() ? 'presentation' : hostDescription?.trim() ? 'host' : 'none'
  }
}

export function resourceMetadataFromDraft(title: string, description: string): PresentationResourceMetadata {
  const next: PresentationResourceMetadata = {}
  const cleanTitle = title.trim(),
    cleanDescription = description.trim()
  if (cleanTitle) next.title = cleanTitle
  if (cleanDescription) next.description = cleanDescription
  return next
}

export function resourceDraftFromMetadata(metadata: PresentationResourceMetadata | undefined): {
  title: string
  description: string
} {
  return { title: metadata?.title ?? '', description: metadata?.description ?? '' }
}
