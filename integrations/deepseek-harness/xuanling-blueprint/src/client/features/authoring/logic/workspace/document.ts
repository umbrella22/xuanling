/** Read a document already accepted by the host's canonical schema. This is
 * intentionally not a second schema/decoder: local drafts must use host.validate
 * first. Identity and schema version are the browser's binding boundary. */
import { SCHEMA_VERSION, type BlueprintDefinition } from '../../../../../definition/types.ts'

export function readHostDefinition(definitionJson: string, blueprintId: string): BlueprintDefinition {
  const value: unknown = JSON.parse(definitionJson)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid host document')
  const identity = value as { id?: unknown; schemaVersion?: unknown }
  if (identity.id !== blueprintId || identity.schemaVersion !== SCHEMA_VERSION) throw new Error('Unrelated or unsupported host document')
  return value as BlueprintDefinition
}
