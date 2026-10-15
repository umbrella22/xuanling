/** Host-owned library. IDs are opaque; names and browser input never become paths. */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PackageBoundaryError } from './persist.ts'

const managedId = /^bp-[a-f0-9]{64}$/
export const createdBlueprintId = (requestId: string): string => `bp-${createHash('sha256').update(requestId).digest('hex')}`

export function libraryDocumentRoot(library: string, id: string): string | undefined {
  if (!managedId.test(id)) return undefined
  const root = join(resolve(library), id)
  try {
    if (!lstatSync(root).isDirectory()) throw new PackageBoundaryError()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return root
}

export function libraryIds(library: string): string[] {
  try {
    return readdirSync(library, { withFileTypes: true })
      .filter(entry => managedId.test(entry.name) && entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
