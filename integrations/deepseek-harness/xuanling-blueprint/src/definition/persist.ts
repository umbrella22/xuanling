/**
 * Atomic definition persistence (C-02): staging directory + platform rename,
 * with optimistic concurrency on the stored semantic revision. A failed save
 * never leaves a partial blueprint.json: the staged copy is removed and the
 * previous file (if any) stays untouched.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DefinitionInvalidError, IoWriteFailedError, RevisionConflictError, type BlueprintDefinition } from './types.ts'
import { decodeDefinition } from './codec.ts'
import { validateDefinition } from './validator.ts'
import { canonicalJson, documentRevisions } from './document.ts'
import { snapshotDirectory, snapshotFile } from '../resources/snapshotter.ts'
import { computeRevision, type DefinitionRevision } from './revision.ts'

export interface SaveResult {
  revision: DefinitionRevision
  bytesWritten: number
}

export interface SaveOptions {
  /** Optimistic concurrency: fail with REVISION_CONFLICT when the stored
   * file's semantic revision differs from this value. `null` requires the
   * file to not exist (first save). Omit to save unconditionally. */
  expectedRevision?: string | null
  stagingDir?: string
}

export function readStoredRevision(rootDir: string): string | null {
  const file = join(resolve(rootDir), 'blueprint.json')
  if (!existsSync(file)) return null
  const stored = decodeDefinition(readFileSync(file, 'utf8'))
  return computeRevision({ rootDir, definition: stored }).semantic
}

export function saveDefinition(rootDir: string, definition: BlueprintDefinition, options: SaveOptions = {}): SaveResult {
  const root = resolve(rootDir)
  const file = join(root, 'blueprint.json')
  const payload = `${JSON.stringify(definition, null, 2)}\n`

  // Concurrency check happens on the stored bytes before any write.
  if (options.expectedRevision !== undefined) {
    const stored = readStoredRevision(root)
    if (stored !== options.expectedRevision) {
      throw new RevisionConflictError(options.expectedRevision, stored ?? '<absent>')
    }
  }

  // Fresh semantic check of the incoming definition (shape + graph) so a
  // save can never publish something load() would reject.
  try {
    decodeDefinition(payload)
  } catch (error) {
    if (error instanceof DefinitionInvalidError) throw error
    throw new DefinitionInvalidError([{ code: 'invalid-value', message: String(error) }])
  }
  const revision = computeRevision({ rootDir: root, definition })

  const staging = resolve(options.stagingDir ?? join(root, '.blueprint-staging'))
  const stagedFile = join(staging, 'blueprint.json')
  try {
    mkdirSync(staging, { recursive: true })
    writeFileSync(stagedFile, payload)
    mkdirSync(root, { recursive: true })
    renameSync(stagedFile, file)
    rmSync(staging, { recursive: true, force: true })
  } catch (cause) {
    try {
      if (existsSync(stagedFile)) rmSync(stagedFile, { force: true })
      if (existsSync(staging)) rmSync(staging, { recursive: true, force: true })
    } catch {
      // best-effort staging cleanup; the original error is reported
    }
    if (cause instanceof Error && 'code' in cause && (cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new IoWriteFailedError(root, cause)
    }
    throw new IoWriteFailedError(file, cause)
  }
  return { revision, bytesWritten: Buffer.byteLength(payload) }
}

export function loadDefinition(rootDir: string): { definition: BlueprintDefinition; revision: DefinitionRevision } {
  const file = join(resolve(rootDir), 'blueprint.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (cause) {
    throw new IoWriteFailedError(file, cause)
  }
  const definition = decodeDefinition(text)
  return { definition, revision: computeRevision({ rootDir, definition }) }
}

export class DefinitionDocumentMissingError extends Error {
  readonly code = 'DEFINITION_NOT_FOUND'
  constructor() {
    super('definition document is absent')
  }
}
export class DocumentRevisionConflictError extends Error {
  readonly code = 'DOCUMENT_REVISION_CONFLICT'
  constructor(
    readonly expected: string | null,
    readonly actual: string | null
  ) {
    super('document revision conflict')
  }
}
export class PackageBoundaryError extends Error {
  readonly code = 'PACKAGE_BOUNDARY_REJECTED'
  constructor() {
    super('package boundary rejected')
  }
}
export interface DefinitionDocument {
  blueprintId: string
  definitionJson: string
  documentRevision: string
  semanticRevision: string
  layoutRevision: string
}

/** Check the physical boundary before any content read, including the lib root. */
function containedPath(root: string, path: string): void {
  const rel = relative(realpathSync(root), realpathSync(path))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PackageBoundaryError()
}
function isAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }
}
/** Complete package lib plus declared resources; shared roots are NOT revision inputs. */
export function readPackageFiles(rootDir: string, definition: BlueprintDefinition): Map<string, Buffer> {
  const root = resolve(rootDir)
  const files = new Map<string, Buffer>()
  const collect = (path: string): void => {
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PackageBoundaryError()
    containedPath(root, full)
    const entries = statSync(full).isDirectory()
      ? snapshotDirectory(full, { kind: 'package-path', absolutePath: full }).files
      : snapshotFile(full, { kind: 'package-path', absolutePath: full }).files
    for (const file of entries) {
      const logical = statSync(full).isDirectory() ? `${path}/${file.path}` : path
      files.set(logical, Buffer.from(file.bytes))
    }
  }
  if (!isAbsent(join(root, 'lib'))) collect('lib')
  for (const ref of Object.values(definition.resources)) {
    if (ref.path !== undefined) collect(ref.path)
  }
  return files
}
function documentValue(definition: BlueprintDefinition, bytes: Map<string, Buffer>): DefinitionDocument {
  const files = Object.fromEntries([...bytes].map(([path, content]) => [path, snapshotDigest(content)]))
  return { blueprintId: definition.id, definitionJson: canonicalJson(definition), ...documentRevisions(definition, files) }
}
/** One checked read set owns both its revisions and immutable admission/export bytes. */
export interface DefinitionPackage {
  document: DefinitionDocument
  files: Map<string, Buffer>
}
function snapshotDigest(bytes: Buffer): string {
  // snapshotFile's digest semantics are sha256(bytes); keep the pure helper's input explicit.
  return createHash('sha256').update(bytes).digest('hex')
}
export function loadDefinitionPackage(rootDir: string): DefinitionPackage {
  const root = resolve(rootDir)
  const file = join(root, 'blueprint.json')
  if (isAbsent(file)) throw new DefinitionDocumentMissingError()
  containedPath(root, file)
  const definition = decodeDefinition(readFileSync(file, 'utf8'))
  validateDefinition(definition)
  const files = readPackageFiles(root, definition)
  return { document: documentValue(definition, files), files }
}
export function loadDefinitionDocument(rootDir: string): DefinitionDocument {
  return loadDefinitionPackage(rootDir).document
}

/** Synchronous read-check-stage-rename document CAS; legacy semantic CAS above is unchanged. */
export function saveDefinitionDocument(rootDir: string, definition: BlueprintDefinition, expectedRevision: string | null): DefinitionDocument {
  const root = resolve(rootDir)
  let stored: DefinitionDocument | undefined
  try {
    stored = loadDefinitionDocument(root)
  } catch (error) {
    if (!(error instanceof DefinitionDocumentMissingError)) throw error
  }
  if ((stored?.documentRevision ?? null) !== expectedRevision) throw new DocumentRevisionConflictError(expectedRevision, stored?.documentRevision ?? null)
  validateDefinition(decodeDefinition(JSON.stringify(definition)))
  const document = documentValue(definition, readPackageFiles(root, definition))
  const payload = `${JSON.stringify(definition, null, 2)}\n`
  let staging: string | undefined
  let fd: number | undefined
  try {
    mkdirSync(root, { recursive: true })
    staging = mkdtempSync(join(root, '.blueprint-stage-'))
    const stagedFile = join(staging, 'blueprint.json')
    fd = openSync(stagedFile, 'wx', 0o600)
    writeFileSync(fd, payload)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(stagedFile, join(root, 'blueprint.json'))
  } catch (cause) {
    throw new IoWriteFailedError('definition-document', cause)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
  }
  return document
}
