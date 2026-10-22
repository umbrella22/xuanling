/**
 * Canonical definition CAS and history-first persistence. A normal save stages
 * one blueprint.json. Closure restoration records a durable replay intent
 * before changing package bytes; interrupted commits block reads until replay
 * succeeds and report DEFINITION_COMMIT_PENDING.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { assertStoragePath, fsyncDirectory, mkdirDurable } from '../persistence/durable-fs.ts'
import { isPackageReservedPath } from '../security/resource-admission.ts'
import { DefinitionInvalidError, IoWriteFailedError, RevisionConflictError, type BlueprintDefinition } from './types.ts'
import { decodeDefinition } from './codec.ts'
import { validateDefinition } from './validator.ts'
import { canonicalJson, documentRevisions } from './document.ts'
import { snapshotDirectory, snapshotFile } from '../resources/snapshotter.ts'
import { computeRevision, type DefinitionRevision } from './revision.ts'
import { z } from 'zod'

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
    mkdirDurable(root)
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

export type RevisionOrigin = 'canvas' | 'conversation' | 'import' | 'revert'
export interface RevisionPackageFile {
  digest: string
  /** Base64 keeps the immutable package closure self-contained in history. */
  base64: string
}
export interface DefinitionRevisionRecord {
  schemaVersion: 1
  revision: string
  parentRevision: string | null
  createdAt: number
  origin: RevisionOrigin
  message?: string
  document: DefinitionDocument
  /** Optional only for pre-closure history entries. New entries always carry
   * the package bytes needed for a resource-complete revert. */
  packageFiles?: Record<string, RevisionPackageFile>
}

const revisionDocumentSchema = z.strictObject({
  blueprintId: z.string().min(1),
  definitionJson: z.string().min(1),
  documentRevision: z.string().min(1),
  semanticRevision: z.string().min(1),
  layoutRevision: z.string().min(1)
})

const revisionRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.string().min(1),
  parentRevision: z.string().min(1).nullable(),
  createdAt: z.number().finite(),
  origin: z.enum(['canvas', 'conversation', 'import', 'revert']),
  message: z.string().optional(),
  document: revisionDocumentSchema,
  packageFiles: z.record(z.string().min(1), z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/), base64: z.string() })).optional()
})

const revisionHistorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(revisionRecordSchema)
})

export class RevisionHistoryInvalidError extends Error {
  override readonly name = 'RevisionHistoryInvalidError'
  readonly code = 'REVISION_HISTORY_INVALID'
  constructor(readonly detail: string) {
    super(`revision history invalid: ${detail}`)
  }
}

const revisionHistoryDir = (root: string): string => join(resolve(root), '.revisions')
const revisionHistoryIndex = (root: string): string => join(revisionHistoryDir(root), 'index.json')

function writeAtomicText(path: string, text: string): void {
  const dir = resolve(path, '..')
  mkdirDurable(dir)
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    fsyncDirectory(dir)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function packageFilesValue(files: Map<string, Buffer>): Record<string, RevisionPackageFile> {
  return Object.fromEntries(
    [...files.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, bytes]) => [
        path,
        {
          digest: snapshotDigest(bytes),
          base64: bytes.toString('base64')
        }
      ])
  )
}

function validatePackageFiles(entry: DefinitionRevisionRecord): void {
  if (entry.packageFiles === undefined) return
  validateFileClosure(Object.keys(entry.packageFiles))
  for (const [path, file] of Object.entries(entry.packageFiles)) {
    try {
      const bytes = Buffer.from(file.base64, 'base64')
      validateClosurePath(path)
      if (bytes.toString('base64') !== file.base64 || snapshotDigest(bytes) !== file.digest) throw new Error(`digest mismatch for ${path}`)
    } catch {
      throw new RevisionHistoryInvalidError(`revision ${entry.revision} contains invalid package bytes`)
    }
  }
}

export type DefinitionRevisionMetadata = Omit<DefinitionRevisionRecord, 'packageFiles'>

function revisionEntryPath(rootDir: string, revision: string): string {
  return join(revisionHistoryDir(rootDir), `${revision}.json`)
}

function stripPackageFiles(entry: DefinitionRevisionRecord): DefinitionRevisionMetadata {
  const { packageFiles: _packageFiles, ...metadata } = entry
  return metadata
}

/** Parse the canonical index. Older indexes may still carry packageFiles; they
 * are accepted for reading but never rewritten into the metadata-only index. */
function readRevisionIndex(rootDir: string): DefinitionRevisionRecord[] {
  const file = revisionHistoryIndex(rootDir)
  assertStoragePath(rootDir, file)
  if (!existsSync(file)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new RevisionHistoryInvalidError('index is not valid JSON')
  }
  const checked = revisionHistorySchema.safeParse(parsed)
  if (!checked.success) throw new RevisionHistoryInvalidError('index or entry shape rejected')
  return checked.data.entries as DefinitionRevisionRecord[]
}

function validateRevisionEntry(entry: DefinitionRevisionRecord, packageBytes: boolean): void {
  if (entry.revision !== entry.document.documentRevision) throw new RevisionHistoryInvalidError(`revision ${entry.revision} does not match documentRevision`)
  try {
    const definition = decodeDefinition(entry.document.definitionJson)
    if (definition.id !== entry.document.blueprintId) throw new Error('blueprint ID mismatch')
    if (entry.packageFiles !== undefined) {
      const files = Object.fromEntries(Object.entries(entry.packageFiles).map(([path, file]) => [path, file.digest]))
      const revisions = documentRevisions(definition, files)
      if (Object.entries(revisions).some(([key, value]) => entry.document[key as keyof DefinitionDocument] !== value)) throw new Error('revision mismatch')
    }
  } catch {
    throw new RevisionHistoryInvalidError(`revision ${entry.revision} contains an unsupported definition`)
  }
  if (packageBytes) validatePackageFiles(entry)
}

export function readRevisionHistory(rootDir: string): DefinitionRevisionMetadata[] {
  const entries = readRevisionIndex(rootDir)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.revision)) throw new RevisionHistoryInvalidError(`duplicate revision ${entry.revision}`)
    seen.add(entry.revision)
    validateRevisionEntry(entry, false)
  }
  return entries.map(stripPackageFiles)
}

/** Load the stored entry for an indexed revision, falling back to the index
 * record itself for pre-entry-file histories. No inheritance is applied. */
function loadRevisionEntry(rootDir: string, listed: DefinitionRevisionRecord): DefinitionRevisionRecord {
  const revision = listed.revision
  const file = revisionEntryPath(rootDir, revision)
  assertStoragePath(rootDir, file)
  if (!existsSync(file)) return listed
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new RevisionHistoryInvalidError(`revision ${revision} entry is not valid JSON`)
  }
  const checked = revisionRecordSchema.safeParse(parsed)
  if (!checked.success) throw new RevisionHistoryInvalidError(`revision ${revision} entry shape rejected`)
  return checked.data as DefinitionRevisionRecord
}

export function readRevision(rootDir: string, revision: string): DefinitionRevisionRecord | undefined {
  const listed = readRevisionIndex(rootDir).find(item => item.revision === revision)
  if (listed === undefined) return undefined
  let entry = loadRevisionEntry(rootDir, listed)
  validateRevisionEntry(entry, false)
  if (entry.packageFiles === undefined) {
    const inherited = inheritedPackageFiles(rootDir, entry, new Set([revision]))
    if (inherited !== undefined) entry = { ...entry, packageFiles: structuredClone(inherited) }
  }
  if (entry.packageFiles !== undefined) validateRevisionEntry(entry, true)
  return entry
}

export function appendRevisionHistory(
  rootDir: string,
  document: DefinitionDocument,
  options: { parentRevision: string | null; origin: RevisionOrigin; message?: string; packageFiles?: Map<string, Buffer> }
): DefinitionRevisionRecord {
  assertStoragePath(rootDir, revisionHistoryIndex(rootDir))
  const entries = readRevisionIndex(rootDir)
  const existing = entries.find(item => item.revision === document.documentRevision)
  if (existing !== undefined) return readRevision(rootDir, existing.revision) ?? existing
  const entry: DefinitionRevisionRecord = {
    schemaVersion: 1,
    revision: document.documentRevision,
    parentRevision: options.parentRevision,
    createdAt: Date.now(),
    origin: options.origin,
    ...(options.message === undefined ? {} : { message: options.message }),
    document: structuredClone(document),
    ...(options.packageFiles === undefined ? {} : { packageFiles: packageFilesValue(options.packageFiles) })
  }
  writeAtomicText(revisionEntryPath(rootDir, document.documentRevision), `${JSON.stringify(entry, null, 2)}\n`)
  const next = [...entries, entry]
  let kept = next
  if (next.length > RETAINED_REVISIONS + REVISION_PRUNE_SLACK) {
    try {
      kept = materializeForPrune(rootDir, next, next.length - RETAINED_REVISIONS)
    } catch {
      // Pruning is housekeeping: if any retained entry cannot be made
      // self-contained, keep the full history rather than lose a revert target.
      kept = next
    }
  }
  writeAtomicText(revisionHistoryIndex(rootDir), `${JSON.stringify({ schemaVersion: 1, entries: kept.map(stripPackageFiles) }, null, 2)}\n`)
  if (kept !== next) {
    const keptIds = new Set(kept.map(item => item.revision))
    for (const item of next) {
      if (keptIds.has(item.revision)) continue
      try {
        const file = revisionEntryPath(rootDir, item.revision)
        assertStoragePath(rootDir, file)
        rmSync(file, { force: true })
      } catch {
        // An orphaned entry file is unreachable once it leaves the index.
      }
    }
  }
  return entry
}

/** History keeps the most recent revisions instead of one full document (and
 * package closure) per save forever. Pruning runs in batches so a save does
 * not rescan the retained window every time. */
export const RETAINED_REVISIONS = 100
const REVISION_PRUNE_SLACK = 20

/** Before the oldest `drop` entries leave the index, every retained entry whose
 * package files are inherited through a dropped ancestor gets those files
 * written into its own entry, so readRevision resolves the same bytes after
 * the prune. Entries are processed oldest first so a materialized entry ends
 * the walk for its descendants. Returns the retained index entries. */
function materializeForPrune(rootDir: string, entries: DefinitionRevisionRecord[], drop: number): DefinitionRevisionRecord[] {
  const listed = new Map(entries.map(item => [item.revision, item]))
  const dropped = new Set(entries.slice(0, drop).map(item => item.revision))
  const retained = entries.slice(drop)
  const loaded = new Map<string, DefinitionRevisionRecord>()
  const load = (revision: string): DefinitionRevisionRecord => {
    let entry = loaded.get(revision)
    if (entry === undefined) {
      entry = loadRevisionEntry(rootDir, listed.get(revision)!)
      loaded.set(revision, entry)
    }
    return entry
  }
  for (const item of retained) {
    const own = load(item.revision)
    if (own.packageFiles !== undefined) continue
    const seen = new Set([item.revision])
    let crossesDropped = false
    let inherited: Record<string, RevisionPackageFile> | undefined
    for (let cursor = own.parentRevision; cursor !== null && listed.has(cursor) && !seen.has(cursor);) {
      seen.add(cursor)
      if (dropped.has(cursor)) crossesDropped = true
      const parent = load(cursor)
      if (parent.packageFiles !== undefined) {
        inherited = parent.packageFiles
        break
      }
      cursor = parent.parentRevision
    }
    if (!crossesDropped || inherited === undefined) continue
    const materialized: DefinitionRevisionRecord = { ...own, packageFiles: structuredClone(inherited) }
    validateRevisionEntry(materialized, true)
    writeAtomicText(revisionEntryPath(rootDir, item.revision), `${JSON.stringify(materialized, null, 2)}\n`)
    loaded.set(item.revision, materialized)
  }
  return retained
}

/** Layout-only revisions reference the nearest ancestor closure with the same
 * semantic revision instead of copying package bytes into every entry. */
function inheritedPackageFiles(rootDir: string, entry: DefinitionRevisionRecord, seen: Set<string>): Record<string, RevisionPackageFile> | undefined {
  if (entry.packageFiles !== undefined) return entry.packageFiles
  if (entry.parentRevision === null || seen.has(entry.parentRevision)) return undefined
  seen.add(entry.parentRevision)
  const parent = readRevision(rootDir, entry.parentRevision)
  if (parent === undefined) return undefined
  if (parent.packageFiles !== undefined && parent.document.semanticRevision === entry.document.semanticRevision) return parent.packageFiles
  return inheritedPackageFiles(rootDir, parent, seen)
}

function validateClosurePath(path: string): void {
  if (
    !path ||
    path.includes('\\') ||
    isAbsolute(path) ||
    path.split('/').some(part => part === '' || part === '.' || part === '..') ||
    isPackageReservedPath(path)
  )
    throw new PackageBoundaryError()
}

function validateFileClosure(paths: string[]): void {
  const names = new Set(paths)
  for (const path of paths) {
    validateClosurePath(path)
    const parts = path.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (names.has(parts.join('/'))) throw new RevisionHistoryInvalidError('package contains conflicting file paths')
    }
  }
}
function assertPackageDestination(root: string, path: string): void {
  try {
    assertStoragePath(root, path)
  } catch (error) {
    // A previous file may become a directory in the desired closure. Existing
    // prefix components were still checked for symlinks by assertStoragePath.
    if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
  }
}
function removeEmptyDirectory(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error('restore destination contains an uncaptured file')
    removeEmptyDirectory(join(path, entry.name))
  }
  rmdirSync(path)
  fsyncDirectory(dirname(path))
}
function applyPackageClosure(root: string, files: Map<string, Buffer>, cleanup: string[]): void {
  for (const path of cleanup) {
    if (files.has(path)) continue
    const full = join(root, path)
    let current
    try {
      current = lstatSync(full)
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue
      throw error
    }
    // During replay an old file path can already be a desired directory.
    if (current.isDirectory()) continue
    rmSync(full)
    fsyncDirectory(dirname(full))
  }
  for (const [path, bytes] of files) {
    const full = join(root, path)
    try {
      if (lstatSync(full).isDirectory()) removeEmptyDirectory(full)
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    atomicWriteBytes(full, bytes)
  }
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
    try {
      validateClosurePath(path)
      const full = resolve(root, path)
      const rel = relative(root, full)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PackageBoundaryError()
      if (isAbsent(full)) throw new PackageResourceMissingError(path)
      containedPath(root, full)
      const entries = statSync(full).isDirectory()
        ? snapshotDirectory(full, { kind: 'package-path', absolutePath: full }).files
        : snapshotFile(full, { kind: 'package-path', absolutePath: full }).files
      for (const file of entries) {
        const logical = statSync(full).isDirectory() ? `${path}/${file.path}` : path
        files.set(logical, Buffer.from(file.bytes))
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new PackageResourceMissingError(path)
      if (code === 'EACCES' || code === 'EPERM' || code === 'EIO') throw new PackageResourceUnreadableError()
      throw error
    }
  }
  if (!isAbsent(join(root, 'lib'))) collect('lib')
  for (const ref of Object.values(definition.resources)) {
    if (ref.path !== undefined) collect(ref.path)
  }
  return files
}

export class PackageResourceMissingError extends Error {
  readonly code = 'PACKAGE_RESOURCE_MISSING'
  constructor(readonly resourcePath: string) {
    super(`package resource is missing: ${resourcePath}`)
  }
}

export class PackageResourceUnreadableError extends Error {
  readonly code = 'PACKAGE_RESOURCE_UNREADABLE'
  constructor() {
    super('package resource is unreadable')
  }
}

function atomicWriteBytes(path: string, bytes: Buffer): void {
  const dir = resolve(path, '..')
  mkdirDurable(dir)
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    fsyncDirectory(dir)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function packagePathSet(root: string, cleanupPaths: string[]): Set<string> {
  const paths = new Set<string>()
  const walk = (directory: string, prefix: string): void => {
    assertStoragePath(root, directory)
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name)
      assertStoragePath(root, full)
      const relativePath = `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(full, relativePath)
      else paths.add(relativePath)
    }
  }
  walk(join(root, 'lib'), 'lib')
  for (const path of cleanupPaths) {
    validateClosurePath(path)
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PackageBoundaryError()
    if (isAbsent(full)) continue
    if (statSync(full).isDirectory()) walk(full, rel.split(sep).join('/'))
    else paths.add(rel.split(sep).join('/'))
  }
  return paths
}

/** Restore the package closure captured in an immutable revision. */
export function restorePackageFiles(rootDir: string, packageFiles: Record<string, RevisionPackageFile>, cleanupPaths: string[] = []): void {
  const root = resolve(rootDir)
  const desired = new Map<string, Buffer>()
  for (const [path, file] of Object.entries(packageFiles)) {
    validateClosurePath(path)
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PackageBoundaryError()
    const bytes = Buffer.from(file.base64, 'base64')
    if (snapshotDigest(bytes) !== file.digest) throw new RevisionHistoryInvalidError(`invalid package digest for ${path}`)
    assertPackageDestination(root, full)
    desired.set(rel.split(sep).join('/'), bytes)
  }
  validateFileClosure([...desired.keys()])
  const existing = packagePathSet(root, cleanupPaths)
  applyPackageClosure(root, desired, [...existing])
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
  recoverDefinitionCommit(root)
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
export function saveDefinitionDocument(
  rootDir: string,
  definition: BlueprintDefinition,
  expectedRevision: string | null,
  history: { origin?: RevisionOrigin; message?: string } = {},
  packageFilesOverride?: Map<string, Buffer>
): DefinitionDocument {
  const root = resolve(rootDir)
  let stored: DefinitionDocument | undefined
  try {
    stored = loadDefinitionDocument(root)
  } catch (error) {
    if (!(error instanceof DefinitionDocumentMissingError)) throw error
  }
  if ((stored?.documentRevision ?? null) !== expectedRevision) throw new DocumentRevisionConflictError(expectedRevision, stored?.documentRevision ?? null)
  validateDefinition(decodeDefinition(JSON.stringify(definition)))
  const packageFiles = packageFilesOverride ?? readPackageFiles(root, definition)
  const document = documentValue(definition, packageFiles)
  const payload = `${JSON.stringify(definition, null, 2)}\n`
  let staging: string | undefined
  let fd: number | undefined
  try {
    mkdirDurable(root)
    staging = mkdtempSync(join(root, '.blueprint-stage-'))
    const stagedFile = join(staging, 'blueprint.json')
    fd = openSync(stagedFile, 'wx', 0o600)
    writeFileSync(fd, payload)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    // A layout-only save has the same semantic revision as its parent. Reuse
    // the parent entry's closure only when that closure is actually readable;
    // the first history entry must always carry the bytes.
    const storedHistory = packageFilesOverride === undefined && stored !== undefined ? readRevision(root, stored.documentRevision) : undefined
    const historyPackageFiles = storedHistory?.packageFiles !== undefined && stored?.semanticRevision === document.semanticRevision ? undefined : packageFiles
    appendRevisionHistory(root, document, {
      parentRevision: stored?.documentRevision ?? null,
      origin: history.origin ?? 'canvas',
      ...(history.message === undefined ? {} : { message: history.message }),
      ...(historyPackageFiles === undefined ? {} : { packageFiles: historyPackageFiles })
    })
    if (packageFilesOverride !== undefined) {
      const cleanup = stored === undefined ? [] : [...readPackageFiles(root, decodeDefinition(stored.definitionJson)).keys()]
      const commit = { schemaVersion: 1 as const, document, packageFiles: packageFilesValue(packageFiles), cleanup }
      validateDefinitionCommit(root, commit)
      writeAtomicText(join(root, '.blueprint-commit.json'), JSON.stringify(commit))
      recoverDefinitionCommit(root)
    } else {
      renameSync(stagedFile, join(root, 'blueprint.json'))
      fsyncDirectory(root)
    }
  } catch (cause) {
    if (existsSync(join(root, '.blueprint-commit.json'))) throw new DefinitionCommitPendingError()
    throw new IoWriteFailedError('definition-document', cause)
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
  }
  return document
}

/** The closure intent is durable; a read retries it before exposing canonical
 * state. This error never implies that a partially restored package is usable. */
export class DefinitionCommitPendingError extends Error {
  readonly code = 'DEFINITION_COMMIT_PENDING'
  constructor() {
    super('definition commit requires recovery; reload to retry the durable commit')
  }
}

const definitionCommitSchema = z.strictObject({
  schemaVersion: z.literal(1),
  document: revisionDocumentSchema,
  packageFiles: z.record(z.string(), z.strictObject({ digest: z.string().regex(/^[a-f0-9]{64}$/), base64: z.string() })),
  cleanup: z.array(z.string())
})
type DefinitionCommit = z.infer<typeof definitionCommitSchema>
function validateDefinitionCommit(root: string, commit: DefinitionCommit): void {
  const definition = decodeDefinition(commit.document.definitionJson)
  validateDefinition(definition)
  const files = new Map(
    Object.entries(commit.packageFiles).map(([path, file]) => {
      validateClosurePath(path)
      assertPackageDestination(root, join(root, path))
      const bytes = Buffer.from(file.base64, 'base64')
      if (snapshotDigest(bytes) !== file.digest || bytes.toString('base64') !== file.base64)
        throw new RevisionHistoryInvalidError('commit package bytes rejected')
      return [path, bytes] as const
    })
  )
  for (const path of commit.cleanup) {
    validateClosurePath(path)
    assertPackageDestination(root, join(root, path))
  }
  assertStoragePath(root, join(root, 'blueprint.json'))
  const checked = documentValue(definition, files)
  if (canonicalJson(checked) !== canonicalJson(commit.document)) throw new RevisionHistoryInvalidError('commit document revision rejected')
}

export function recoverDefinitionCommit(rootDir: string): void {
  const root = resolve(rootDir)
  const intent = join(root, '.blueprint-commit.json')
  if (isAbsent(intent)) return
  try {
    assertStoragePath(root, intent)
    const commit = definitionCommitSchema.parse(JSON.parse(readFileSync(intent, 'utf8')))
    validateDefinitionCommit(root, commit)
    // History must already contain this exact closure. Never replay an intent
    // that was not admitted by the history-first writer.
    const entry = readRevision(root, commit.document.documentRevision)
    if (entry === undefined || canonicalJson(entry.packageFiles) !== canonicalJson(commit.packageFiles))
      throw new RevisionHistoryInvalidError('commit history unavailable')
    const files = new Map(Object.entries(commit.packageFiles).map(([path, file]) => [path, Buffer.from(file.base64, 'base64')]))
    applyPackageClosure(root, files, commit.cleanup)
    const definition = decodeDefinition(commit.document.definitionJson)
    for (const ref of Object.values(definition.resources)) {
      if (ref.path === undefined || [...files.keys()].some(path => path === ref.path || path.startsWith(`${ref.path}/`))) continue
      // No file in a captured declared resource means it was an empty directory.
      validateClosurePath(ref.path)
      assertPackageDestination(root, join(root, ref.path))
      mkdirDurable(join(root, ref.path))
    }
    if (canonicalJson(documentValue(definition, readPackageFiles(root, definition))) !== canonicalJson(commit.document))
      throw new RevisionHistoryInvalidError('restored closure does not match commit')
    writeAtomicText(join(root, 'blueprint.json'), `${JSON.stringify(decodeDefinition(commit.document.definitionJson), null, 2)}\n`)
    rmSync(intent)
    fsyncDirectory(root)
  } catch {
    throw new DefinitionCommitPendingError()
  }
}
