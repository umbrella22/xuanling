/** Pure document revisions: presentation CAS is distinct from execution meaning.
 * Files are already boundary-checked package bytes, never machine locators. */
import { createHash } from 'node:crypto'
import type { BlueprintDefinition } from './types.ts'
import { semanticProjection } from './revision.ts'

export function canonicalJson(value: unknown): string {
  const ordered = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(ordered)
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, child]) => [k, ordered(child)])
      )
    return v
  }
  return JSON.stringify(ordered(value))
}
export function documentRevisions(
  definition: BlueprintDefinition,
  files: Record<string, string>
): { documentRevision: string; semanticRevision: string; layoutRevision: string } {
  const hash = (namespace: string, value: unknown) =>
    createHash('sha256')
      .update(`${namespace}\0${canonicalJson(value)}`)
      .digest('hex')
  const semanticRevision = hash('xuanling-blueprint-document-semantic-v1', { definition: semanticProjection(definition), files })
  const layoutRevision = hash('xuanling-blueprint-document-layout-v1', definition.presentation ?? null)
  const documentRevision = hash('xuanling-blueprint-document-v1', { definition, semanticRevision })
  return { documentRevision, semanticRevision, layoutRevision }
}
