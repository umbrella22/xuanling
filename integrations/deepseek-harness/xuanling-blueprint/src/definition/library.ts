/** Host-owned library. IDs are opaque; names and browser input never become paths. */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { PackageBoundaryError } from './persist.ts'

/**
 * Workflow IDs are logical names, never path fragments.  The generated
 * `bp-<sha256>` IDs remain valid, while workspace definitions can use stable
 * names such as `code-review`.  Keeping this check here makes every caller
 * share the same path boundary instead of relying on a browser or RPC codec.
 */
const logicalId = /^(?!\.\.?$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export const isLogicalWorkflowId = (id: string): boolean => logicalId.test(id)
export const createdBlueprintId = (requestId: string): string => `bp-${createHash('sha256').update(requestId).digest('hex')}`

function contained(root: string, candidate: string): void {
  const absoluteRoot = resolve(root)
  const absoluteCandidate = resolve(candidate)
  const lexical = relative(absoluteRoot, absoluteCandidate)
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) throw new PackageBoundaryError()

  // Check the physical path as well. This rejects a workflow directory that
  // is a symlink outside `.xuanling/workflows`, including a not-yet-created
  // `blueprint.json` below that symlink.
  let physicalRoot: string
  try {
    physicalRoot = realpathSync(absoluteRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    physicalRoot = absoluteRoot
  }
  let physicalCandidate: string
  try {
    physicalCandidate = realpathSync(absoluteCandidate)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    try {
      physicalCandidate = join(realpathSync(dirname(absoluteCandidate)), basename(absoluteCandidate))
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw parentError
      physicalCandidate = absoluteCandidate
    }
  }
  const physical = relative(physicalRoot, physicalCandidate)
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) throw new PackageBoundaryError()
}

export function libraryDocumentRoot(library: string, id: string): string | undefined {
  if (!isLogicalWorkflowId(id)) return undefined
  const root = join(resolve(library), id)
  contained(library, root)
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
      .filter(entry => isLogicalWorkflowId(entry.name) && entry.isDirectory())
      .map(entry => entry.name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
