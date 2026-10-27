/** Stable JSON digest for template identities and evidence facts. */
import { createHash } from 'node:crypto'

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
