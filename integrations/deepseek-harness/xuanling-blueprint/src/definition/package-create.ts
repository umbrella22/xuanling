import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BlueprintDefinition } from './types.ts'
import type { AuthoringCandidate } from './authoring.ts'
import { loadDefinitionPackage, type DefinitionDocument } from './persist.ts'

/** Publish only a complete validated new package. A competing publisher is
 * resolved by the caller's document/operation lock and content comparison. */
export function publishPackage(root: string, definition: BlueprintDefinition, files: AuthoringCandidate['files']): DefinitionDocument {
  mkdirSync(dirname(root), { recursive: true })
  const stage = mkdtempSync(join(dirname(root), '.authoring-stage-'))
  try {
    for (const file of [{ path: 'blueprint.json', text: JSON.stringify(definition, null, 2) + '\n' }, ...files]) {
      const target = join(stage, file.path)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      const fd = openSync(target, 'wx', 0o600)
      try {
        writeFileSync(fd, file.text)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }
    const snapshot = loadDefinitionPackage(stage)
    if (existsSync(root)) throw new Error('package-target-exists')
    renameSync(stage, root)
    return snapshot.document
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
