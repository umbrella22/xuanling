import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { WriterLease } from '../persistence/lease.ts'

const deletionCodec = z.strictObject({
  stateVersion: z.literal(1),
  blueprintId: z.string(),
  documentRevision: z.string(),
  requestId: z.string(),
  deletedAt: z.number().finite()
})
export type LibraryDeletion = z.infer<typeof deletionCodec>
export class LibraryStateError extends Error {
  readonly code = 'blueprint/library-state-invalid'
}
function directory(path: string, create: boolean): boolean {
  try {
    if (!lstatSync(path).isDirectory()) throw new LibraryStateError()
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (create) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
      return true
    }
    return false
  }
}
function stateRoot(library: string, create: boolean): string | undefined {
  const root = join(library, '.library-state')
  return directory(root, create) ? root : undefined
}
const deletionName = (id: string) => createHash('sha256').update(id).digest('hex') + '.json'
export function readLibraryDeletion(library: string, id: string): LibraryDeletion | undefined {
  const root = stateRoot(library, false)
  if (!root || !directory(join(root, 'deleted'), false)) return undefined
  const file = join(root, 'deleted', deletionName(id))
  try {
    if (!lstatSync(file).isFile()) throw new LibraryStateError()
    const result = deletionCodec.safeParse(JSON.parse(readFileSync(file, 'utf8')))
    if (!result.success || result.data.blueprintId !== id) throw new LibraryStateError()
    return result.data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new LibraryStateError()
  }
}
export function acquireLibraryWriter(library: string): WriterLease {
  return WriterLease.acquire(stateRoot(library, true)!)
}
export function writeLibraryDeletion(library: string, value: LibraryDeletion): void {
  const root = join(stateRoot(library, true)!, 'deleted')
  directory(root, true)
  const temporary = join(root, `.delete-${randomUUID()}`)
  try {
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      writeFileSync(fd, JSON.stringify(deletionCodec.parse(value)))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temporary, join(root, deletionName(value.blueprintId)))
  } finally {
    rmSync(temporary, { force: true })
  }
}
