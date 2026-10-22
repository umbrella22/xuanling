/**
 * Private run backup / restore (C-15, W5.3). A backup is NOT a shareable
 * blueprint: it carries the runtime root's store plus a journal, and restore
 * is re-entrant — a crash mid-restore leaves enough journal state to either
 * finish or roll back, and the previous data is retained until the restored
 * copy fully validates. Unknown formats fail closed: the original medium is
 * never rewritten, and no data is dropped.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { readZip, writeZip } from '../portability/zip.ts'

export class FormatUnsupportedError extends Error {
  override readonly name = 'FormatUnsupportedError'
  readonly code = 'FORMAT_UNSUPPORTED'
  readonly detail: string
  constructor(detail: string) {
    super(`format unsupported: ${detail}`)
    this.detail = detail
  }
}

export class BackupIncompleteError extends Error {
  override readonly name = 'BackupIncompleteError'
  readonly code = 'BACKUP_INCOMPLETE'
  readonly detail: string
  constructor(detail: string) {
    super(`backup incomplete: ${detail}`)
    this.detail = detail
  }
}

export class RestoreInterruptedError extends Error {
  override readonly name = 'RestoreInterruptedError'
  readonly code = 'RESTORE_INTERRUPTED'
  readonly detail: string
  constructor(detail: string) {
    super(`restore interrupted: ${detail}`)
    this.detail = detail
  }
}

export const BACKUP_FORMAT_VERSION = 1

export interface BackupManifest {
  kind: 'blueprint-run-backup'
  formatVersion: number
  createdAt: string
  /** Runtime root identity recorded at backup time (advisory only). */
  sourceRoot: string
  files: Record<string, string>
}

export interface BackupResult {
  archive: Buffer
  manifest: BackupManifest
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function collectTree(root: string, prefix: string, out: Map<string, Buffer>): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) collectTree(full, `${prefix}${entry.name}/`, out)
    else if (entry.isFile()) out.set(`${prefix}${entry.name}`, readFileSync(full))
  }
}

/** The workspace-native runtime root also contains the writer lease, host
 * resource configuration and workflow definitions. Only these subtrees are
 * part of the durable Run boundary; the lease is deliberately excluded so a
 * restored medium never claims a writer that no longer exists. */
const DIRECTORY_DURABLE_ROOTS = new Set(['runs', 'commands', 'lifecycle', 'snapshots', 'store'])
const DIRECTORY_LAYOUT_MARKERS = new Set(['runs', 'commands', 'lifecycle', 'snapshots', 'coordinator-lease.json', 'root-bindings.json'])

function collectDirectoryBoundary(root: string, out: Map<string, Buffer>): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !DIRECTORY_DURABLE_ROOTS.has(entry.name)) continue
    collectTree(join(root, entry.name), `${entry.name}/`, out)
  }
}

/** Create a private backup of one runtime root (the JSON/SQLite `store/`
 * medium or the workspace-native directory medium, plus no lease). */
export function createBackup(runtimeRoot: string, options: { createdAt?: string } = {}): BackupResult {
  const root = resolve(runtimeRoot)
  if (!existsSync(root)) throw new BackupIncompleteError(`runtime root has no durable run medium: ${root}`)
  const files = new Map<string, Buffer>()
  const rootEntries = readdirSync(root, { withFileTypes: true })
  const directoryMedium = rootEntries.some(entry => DIRECTORY_LAYOUT_MARKERS.has(entry.name))
  if (directoryMedium) {
    collectDirectoryBoundary(root, files)
  } else {
    const storeEntry = rootEntries.find(entry => entry.name === 'store' && entry.isDirectory())
    const store = storeEntry === undefined ? root : join(root, 'store')
    collectTree(store, store === root ? '' : 'store/', files)
  }
  const manifestFiles: Record<string, string> = {}
  for (const [path, bytes] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    manifestFiles[path] = sha256(bytes)
  }
  const manifest: BackupManifest = {
    kind: 'blueprint-run-backup',
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: options.createdAt ?? new Date().toISOString(),
    sourceRoot: root,
    files: manifestFiles
  }
  const archiveEntries = [...files.entries()].map(([name, data]) => ({ name, data }))
  archiveEntries.push({ name: 'backup.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) })
  return { archive: writeZip(archiveEntries), manifest }
}

export interface RestoreResult {
  targetRoot: string
  filesRestored: string[]
  /** true when a previous run's journal was found and resumed. */
  resumed: boolean
}

interface JournalRecord {
  phase: 'staging-done' | 'publishing' | 'complete'
  target: string
  staging: string
  previous?: string
}

function journalPathFor(target: string): string {
  return join(dirname(target), `.bp-restore-journal-${basename(target)}.json`)
}

/** Re-entrant restore. Phases: extract to staging (validated) → journal
 * 'staging-done' → move previous aside → journal 'publishing' → publish →
 * journal 'complete' → drop previous. A crash at any point is resumable by
 * calling restore again with the same archive; the previous data survives
 * until publication completes. */
export function restoreBackup(archive: Buffer, targetRoot: string): RestoreResult {
  const target = resolve(targetRoot)
  const journalPath = journalPathFor(target)

  // Resume an interrupted restore before doing anything new.
  if (existsSync(journalPath)) {
    let record: JournalRecord
    try {
      record = JSON.parse(readFileSync(journalPath, 'utf8')) as JournalRecord
    } catch {
      throw new RestoreInterruptedError(`unreadable journal at ${journalPath}; original data untouched`)
    }
    if (record.phase === 'staging-done' || record.phase === 'publishing') {
      const resumed = resumeFromJournal(record)
      rmSync(journalPath, { force: true })
      return { targetRoot: target, filesRestored: resumed.filesRestored, resumed: true }
    }
    if (record.phase === 'complete') rmSync(journalPath, { force: true })
  }

  const entries = readZip(archive)
  const byName = new Map(entries.map(e => [e.name, e]))
  const manifestEntry = byName.get('backup.json')
  if (manifestEntry === undefined) throw new FormatUnsupportedError('archive has no backup.json')
  let manifest: BackupManifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as BackupManifest
  } catch {
    throw new FormatUnsupportedError('backup.json is not valid JSON')
  }
  if (manifest.kind !== 'blueprint-run-backup') throw new FormatUnsupportedError(`unexpected kind ${String(manifest.kind)}`)
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new FormatUnsupportedError(`backup formatVersion ${manifest.formatVersion} is not supported by this build (fail closed; original data untouched)`)
  }
  for (const [path, digest] of Object.entries(manifest.files)) {
    const entry = byName.get(path)
    if (entry === undefined) throw new BackupIncompleteError(`missing ${path}`)
    if (sha256(entry.data) !== digest) throw new BackupIncompleteError(`digest mismatch for ${path}`)
  }

  const previous = join(dirname(target), `.bp-restore-previous-${basename(target)}`)
  rmSync(previous, { recursive: true, force: true })
  const staging = join(dirname(target), `.bp-restore-staging-${basename(target)}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  for (const entry of entries) {
    if (entry.name === 'backup.json') continue
    const destination = join(staging, entry.name)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, entry.data)
  }
  const writeJournal = (record: JournalRecord): void => {
    writeFileSync(journalPath, JSON.stringify(record, null, 2))
  }
  writeJournal({ phase: 'staging-done', target, staging })
  if (existsSync(target)) renameSync(target, previous)
  writeJournal({ phase: 'publishing', target, staging, previous })
  renameSync(staging, target)
  writeJournal({ phase: 'complete', target, staging, previous })
  rmSync(previous, { recursive: true, force: true })
  rmSync(journalPath, { force: true })
  const filesRestored: string[] = []
  collectRestored(target, '', filesRestored)
  return { targetRoot: target, filesRestored: filesRestored.sort(), resumed: false }
}

function resumeFromJournal(record: JournalRecord): { filesRestored: string[] } {
  const { target, staging } = record
  // Phase-1 journals may predate the `previous` rename; derive the path so a
  // resume can always finish or clean up.
  const previous = record.previous ?? join(dirname(target), `.bp-restore-previous-${basename(target)}`)
  if (record.phase === 'staging-done') {
    if (!existsSync(staging)) {
      throw new RestoreInterruptedError('staging directory lost; rerun restore with the archive')
    }
    if (existsSync(target)) {
      rmSync(previous, { recursive: true, force: true })
      renameSync(target, previous)
    }
    renameSync(staging, target)
    rmSync(previous, { recursive: true, force: true })
  } else {
    // 'publishing': staging may already have been renamed.
    if (existsSync(staging)) {
      if (existsSync(target) && !existsSync(previous)) {
        // Target was published but 'previous' never moved: treat as done.
        rmSync(staging, { recursive: true, force: true })
      } else {
        renameSync(staging, target)
      }
    }
    rmSync(previous, { recursive: true, force: true })
  }
  const filesRestored: string[] = []
  collectRestored(target, '', filesRestored)
  return { filesRestored: filesRestored.sort() }
}

function collectRestored(root: string, prefix: string, out: string[]): void {
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) collectRestored(full, `${prefix}${entry.name}/`, out)
    else out.push(`${prefix}${entry.name}`)
  }
}

/** Restore must never run while a writer is live: the caller holds the lease
 * gate; this helper only reports whether a lease file is present. */
export function restoreSafetyCheck(runtimeRoot: string): { safe: boolean; reason?: string } {
  const lease = join(resolve(runtimeRoot), 'coordinator-lease.json')
  if (existsSync(lease)) {
    return { safe: false, reason: 'coordinator lease present — a writer may be live' }
  }
  return { safe: true }
}
