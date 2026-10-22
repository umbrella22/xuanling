import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RuntimeHandle } from '../index.ts'
import { decodeDefinition } from '../definition/codec.ts'
import type { DefinitionPackage } from '../definition/persist.ts'
import type { BlueprintDefinition } from '../definition/types.ts'
import type { FrozenBlueprint } from '../persistence/records.ts'

export interface AdmissionPackage {
  rootDir: string
  children: DefinitionPackage[]
}

export async function freezeBlueprintClosure(
  handle: RuntimeHandle,
  children: DefinitionPackage[],
  materialize: (snapshot: DefinitionPackage, root: string) => void,
  capture: (
    handle: RuntimeHandle,
    snapshotId: string,
    definition: BlueprintDefinition
  ) => Promise<{ digests: FrozenBlueprint['bindingDigests']; modelSelections: FrozenBlueprint['bindingSelections'] }>
): Promise<FrozenBlueprint[]> {
  const frozen: FrozenBlueprint[] = []
  for (const snapshot of children) {
    const snapshotId = `run-${randomUUID()}`
    const root = mkdtempSync(join(tmpdir(), 'bp-child-admission-'))
    try {
      materialize(snapshot, root)
      const definition = decodeDefinition(snapshot.document.definitionJson)
      await handle.snapshots.freezePackage(snapshotId, definition, root)
      const bindings = await capture(handle, snapshotId, definition)
      const { blueprintId, documentRevision, semanticRevision, definitionJson } = snapshot.document
      frozen.push({
        blueprintId,
        documentRevision,
        semanticRevision,
        definitionJson,
        snapshotId,
        bindingDigests: bindings.digests,
        bindingSelections: bindings.modelSelections
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  return frozen
}
