/**
 * Library identities (C-01). A library is either the profile-global store or
 * one Host-registered workspace. Physical roots stay Host-owned; every public
 * DTO carries logical identities only.
 */
import { z } from 'zod'

const logicalId = z.string().min(1).max(128)

export const libraryRefCodec = () =>
  z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('global') }), z.strictObject({ kind: z.literal('workspace'), workspaceId: logicalId })])
export type LibraryRef = z.infer<ReturnType<typeof libraryRefCodec>>

export const assetRefCodec = () =>
  z.strictObject({
    library: libraryRefCodec(),
    blueprintId: logicalId
  })
export type AssetRef = z.infer<ReturnType<typeof assetRefCodec>>

export type LibraryStatus = 'absent' | 'empty' | 'ready' | 'unavailable'
export type AssetStatus = 'ready' | 'invalid' | 'deleted'

export interface AssetSummary {
  readonly blueprintId: string
  readonly name: string
  readonly documentRevision: string | null
  readonly semanticRevision: string | null
  readonly status: AssetStatus
  readonly diagnostic?: string
}

export interface LibrarySummary {
  readonly library: LibraryRef
  readonly title: string
  readonly status: LibraryStatus
  readonly assets: AssetSummary[]
  readonly diagnostics: string[]
}

export interface ListBlueprintLibrariesValue {
  readonly libraries: LibrarySummary[]
  /** Library the Host would use for an unscoped request in this context. */
  readonly defaultLibrary: LibraryRef
}

export const assetSummaryCodec = () =>
  z.strictObject({
    blueprintId: logicalId,
    name: z.string(),
    documentRevision: z.string().nullable(),
    semanticRevision: z.string().nullable(),
    status: z.enum(['ready', 'invalid', 'deleted']),
    diagnostic: z.string().min(1).optional()
  })

export const librarySummaryCodec = () =>
  z.strictObject({
    library: libraryRefCodec(),
    title: z.string(),
    status: z.enum(['absent', 'empty', 'ready', 'unavailable']),
    assets: z.array(assetSummaryCodec()),
    diagnostics: z.array(z.string().min(1))
  })

export const listBlueprintLibrariesCodec = () => z.strictObject({ libraries: z.array(librarySummaryCodec()), defaultLibrary: libraryRefCodec() })

export function libraryKey(ref: LibraryRef): string {
  return ref.kind === 'global' ? 'global' : `workspace:${ref.workspaceId}`
}

export function libraryTitle(ref: LibraryRef, workspaceTitle?: string): string {
  if (ref.kind === 'global') return 'Global'
  return workspaceTitle ?? ref.workspaceId
}
