/**
 * Resource snapshotter (C-04): every attempt preparation reads the CURRENT
 * shared skill content — the full tree (instructions, scripts, references,
 * assets), never only the entry markdown. A stable read requires two digest
 * passes to agree; a detected mid-read change retries within a bounded
 * budget and then fails typed instead of freezing a mixed snapshot. Digests
 * serve integrity and dedup only — no user-facing versioning (C-04).
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface SnapshotFile {
  /** Path relative to the snapshot root, '/'-separated. */
  path: string
  digest: string
  bytes: Buffer
}

export interface ResourceSnapshot {
  /** What was snapshotted: a shared skill dir or a package file/dir. */
  source: { kind: 'shared-skill'; rootId: string; skillDir: string; skillName: string } | { kind: 'package-path'; absolutePath: string }
  files: SnapshotFile[]
  /** Digest over the sorted (path, digest) pairs — the tree identity. */
  treeDigest: string
}

export class ResourceChangedDuringReadError extends Error {
  override readonly name = 'ResourceChangedDuringReadError'
  readonly code = 'RESOURCE_CHANGED_DURING_READ'
  readonly attempts: number
  readonly root: string
  constructor(root: string, attempts: number) {
    super(`resource under ${root} changed during read after ${attempts} bounded attempts; no snapshot committed`)
    this.root = root
    this.attempts = attempts
  }
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function walkFiles(rootDir: string): string[] {
  const out: string[] = []
  const physicalRoot = realpathSync(rootDir)
  const ancestry = new Set<string>()
  const walk = (dir: string): void => {
    const physical = realpathSync(dir)
    const rel = relative(physicalRoot, physical)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || ancestry.has(physical)) throw new Error('snapshot directory escapes root or cycles')
    ancestry.add(physical)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() || (entry.isSymbolicLink() && statSync(full).isDirectory())) walk(full)
      else if (entry.isFile() || entry.isSymbolicLink()) out.push(full)
    }
    ancestry.delete(physical)
  }
  walk(rootDir)
  return out
}

function readTree(rootDir: string): SnapshotFile[] {
  const files: SnapshotFile[] = []
  for (const absolute of walkFiles(rootDir)) {
    const rel = relative(rootDir, absolute).split(sep).join('/')
    const physical = relative(realpathSync(rootDir), realpathSync(absolute))
    if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) throw new Error('snapshot symlink escapes root')
    const bytes = readFileSync(absolute)
    files.push({ path: rel, digest: sha256(bytes), bytes })
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

function treeDigestOf(files: SnapshotFile[]): string {
  const merged = files.map(f => `${f.path}\u0000${f.digest}\n`).join('')
  return sha256(merged)
}

export interface SnapshotOptions {
  /** Bounded retry budget for unstable reads (plan §8.4). Default 3. */
  maxAttempts?: number
  /** Test/observer seam invoked between digest passes; lets fault tests
   * mutate the tree deterministically (production callers omit it). */
  onBetweenPasses?: (pass: number) => void
}

/** Snapshot a directory tree with change detection: two passes must agree
 * before the snapshot is returned. No cache is consulted — the medium is
 * read every time (W0.3 S4 evidence: watch:false still sees updates). */
export function snapshotDirectory(dir: string, source: ResourceSnapshot['source'], options: SnapshotOptions = {}): ResourceSnapshot {
  const root = resolve(dir)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    const error = new Error(`snapshot source missing: ${root}`)
    error.name = 'ResourceUnavailableError'
    ;(error as { code?: string }).code = 'RESOURCE_UNAVAILABLE'
    throw error
  }
  const maxAttempts = options.maxAttempts ?? 3
  let previous: { files: SnapshotFile[]; digest: string } | null = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) options.onBetweenPasses?.(attempt)
    const files = readTree(root)
    const digest = treeDigestOf(files)
    if (previous !== null && previous.digest === digest) {
      return { source, files, treeDigest: digest }
    }
    previous = { files, digest }
  }
  throw new ResourceChangedDuringReadError(root, maxAttempts)
}

/** Snapshot a single package file (agent/prompt/schema/script). */
export function snapshotFile(absolutePath: string, source: ResourceSnapshot['source']): ResourceSnapshot {
  const file = resolve(absolutePath)
  if (!existsSync(file) || !statSync(file).isFile()) {
    const error = new Error(`snapshot source missing: ${file}`)
    error.name = 'ResourceUnavailableError'
    ;(error as { code?: string }).code = 'RESOURCE_UNAVAILABLE'
    throw error
  }
  const bytes = readFileSync(file)
  const rel =
    relative(resolve(source.kind === 'shared-skill' ? source.skillDir : file), file)
      .split(sep)
      .join('/') || 'file'
  const files: SnapshotFile[] = [{ path: rel, digest: sha256(bytes), bytes }]
  return { source, files, treeDigest: treeDigestOf(files) }
}
