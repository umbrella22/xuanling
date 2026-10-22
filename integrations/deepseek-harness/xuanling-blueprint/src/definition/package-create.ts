import { closeSync, fsyncSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BlueprintDefinition } from './types.ts'
import type { AuthoringCandidate } from './authoring.ts'
import { appendRevisionHistory, loadDefinitionPackage, type DefinitionDocument } from './persist.ts'

import { fsyncDirectory, mkdirDurable } from '../persistence/durable-fs.ts'

/** Publish only a complete validated new package. A competing publisher is
 * resolved by the caller's document/operation lock and content comparison. */
export function publishPackage(root: string, definition: BlueprintDefinition, files: AuthoringCandidate['files']): DefinitionDocument {
  mkdirDurable(dirname(root))
  const stage = mkdtempSync(join(dirname(root), '.authoring-stage-'))
  try {
    for (const file of [{ path: 'blueprint.json', text: JSON.stringify(definition, null, 2) + '\n' }, ...files]) {
      const target = join(stage, file.path)
      mkdirDurable(dirname(target))
      const fd = openSync(target, 'wx', 0o600)
      try {
        writeFileSync(fd, file.text)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      fsyncDirectory(dirname(target))
    }
    const snapshot = loadDefinitionPackage(stage)
    if (existsSync(root)) throw new Error('package-target-exists')
    appendRevisionHistory(stage, snapshot.document, { parentRevision: null, origin: 'conversation', packageFiles: snapshot.files })
    renameSync(stage, root)
    fsyncDirectory(dirname(root))
    return snapshot.document
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}
