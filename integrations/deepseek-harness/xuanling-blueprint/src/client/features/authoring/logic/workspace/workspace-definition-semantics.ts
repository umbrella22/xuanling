import type { BlueprintDefinition } from '../../../../../definition/types.ts'

/** Browser-side equivalence to the saved definition, NOT a host revision hash.
 * Matches definition/revision.ts semanticProjection: exclude presentation only,
 * recursively order object keys, preserve arrays and all identity-bearing values.
 * Host semanticRevision still supplies authority for resources unavailable here.
 * Do not import the host revision module: it depends on filesystem/Node APIs.
 */
export function definitionSemantics(definition: BlueprintDefinition): string {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, ordered(item)])
      )
    }
    return value
  }
  const { presentation: _presentation, ...semantic } = definition
  return JSON.stringify(ordered(semantic))
}
