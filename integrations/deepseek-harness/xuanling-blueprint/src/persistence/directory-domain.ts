import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ZodType } from 'zod'
import type { DomainLike, KvTableLike, OpenedDomain } from './domain.ts'
import { recordsSchema, runIdSchema, RUN_RECORD_SCHEMA_VERSION } from './records.ts'
import { assertStoragePath, fsyncDirectory, mkdirDurable } from './durable-fs.ts'

/** Generic table identities use reversible filename encoding. Runs have a
 * separate domain ID grammar; the two boundaries must not share validation. */
function encodeTableKey(key: string): string {
  return encodeURIComponent(key)
}
function decodeTableKey(name: string): string {
  return decodeURIComponent(name)
}

/** Decode a generic table filename stem, or undefined when this encoder could
 * not have produced it (malformed escapes, non-canonical spellings, macOS
 * AppleDouble `._*` companions). Such files are foreign to the table: they are
 * skipped by enumeration instead of failing every listing. */
function ownedTableKey(stem: string): string | undefined {
  if (stem.startsWith('._')) return undefined
  try {
    const key = decodeTableKey(stem)
    return encodeTableKey(key) === stem ? key : undefined
  } catch {
    return undefined
  }
}

/** Temporary names produced by `atomicWrite` below. */
const TEMPORARY_RECORD = /\.json\.\d+\.\d+\.tmp$/
/** A temporary record older than this was abandoned by a crashed writer. */
const ABANDONED_TEMPORARY_MS = 60_000

function sweepAbandonedTemporaries(directory: string, now: number): void {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch {
    return
  }
  for (const name of names) {
    if (!TEMPORARY_RECORD.test(name)) continue
    const path = join(directory, name)
    try {
      const stat = lstatSync(path)
      if (stat.isFile() && now - stat.mtimeMs > ABANDONED_TEMPORARY_MS) rmSync(path, { force: true })
    } catch {
      // Best effort: a sweep never turns into an open failure.
    }
  }
}

function atomicWrite(path: string, value: unknown): void {
  mkdirDurable(dirname(path))
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    fsyncDirectory(dirname(path))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function appendEvent(path: string, value: unknown): void {
  mkdirDurable(dirname(path))
  const fd = openSync(path, 'a', 0o600)
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  fsyncDirectory(dirname(path))
}

class DirectoryTable<K extends string, V> implements KvTableLike<K, V> {
  private readonly tails = new Map<string, Promise<unknown>>()
  constructor(
    private readonly root: string,
    private readonly tableName: string,
    private readonly schema: ZodType<V> | undefined,
    private readonly isClosed: () => boolean,
    private readonly fence: () => void = () => {}
  ) {}

  private assertOpen(): void {
    if (this.isClosed()) throw new Error('directory domain is closed')
  }

  /** Settle every serialized mutation that was admitted before close. */
  async drain(): Promise<void> {
    await Promise.allSettled(this.tails.values())
  }

  private recordPath(key: string): string {
    if (this.tableName === 'runs') runIdSchema.parse(key)
    const path =
      this.tableName === 'runs'
        ? join(this.root, 'runs', key, 'run.json')
        : join(this.root, this.tableName === 'run_lifecycle' ? 'lifecycle' : this.tableName, `${encodeTableKey(key)}.json`)
    assertStoragePath(this.root, path)
    return path
  }

  private runEventPath(recordPath: string): string {
    const path = join(dirname(recordPath), 'events.jsonl')
    assertStoragePath(this.root, path)
    return path
  }

  private legacyRunValue(value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false
    const record = value as { schemaVersion?: unknown; definitionJson?: unknown }
    if (typeof record.definitionJson !== 'string') return false
    try {
      const definition = JSON.parse(record.definitionJson) as { schemaVersion?: unknown } | null
      return definition !== null && typeof definition === 'object' && definition.schemaVersion === 1
    } catch {
      return false
    }
  }

  private readRun(key: string, path: string): V | undefined {
    // Parse JSON separately from schema validation so a corrupt current Run
    // is a durability failure. Only an explicitly identified v1 Run is a
    // lazy archive and therefore omitted from the current runtime view.
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    if (this.legacyRunValue(raw)) return undefined
    return this.parse(key, raw)
  }

  private parse(key: string, value: unknown): V {
    if (this.schema === undefined) return value as V
    const result = this.schema.safeParse(value)
    if (!result.success) throw new Error(`directory record ${this.tableName}/${key} failed schema validation`)
    if (this.tableName === 'runs' && (result.data as { runId?: unknown }).runId !== key) throw new Error('Run identity does not match storage key')
    return result.data
  }

  async get(key: K): Promise<V | undefined> {
    this.assertOpen()
    const path = this.recordPath(key)
    if (!existsSync(path)) return undefined
    if (this.tableName === 'runs') return this.readRun(String(key), path)
    return this.parse(key, JSON.parse(readFileSync(path, 'utf8')))
  }

  async put(key: K, value: V): Promise<void> {
    this.assertOpen()
    await this.serial(String(key), async () => {
      this.assertOpen()
      this.fence()
      const checked = this.parse(String(key), value)
      const path = this.recordPath(String(key))
      const eventPath = this.tableName === 'runs' ? this.runEventPath(path) : undefined
      atomicWrite(path, this.tableName === 'runs' ? { ...(checked as object), schemaVersion: RUN_RECORD_SCHEMA_VERSION } : checked)
      if (eventPath !== undefined) {
        const seq = typeof checked === 'object' && checked !== null && 'seq' in checked ? (checked as { seq?: unknown }).seq : undefined
        appendEvent(eventPath, { seq, at: Date.now(), state: (checked as { state?: unknown }).state })
      }
    })
  }

  async delete(key: K): Promise<void> {
    this.assertOpen()
    await this.serial(String(key), async () => {
      this.assertOpen()
      this.fence()
      const checkedPath = this.recordPath(String(key))
      if (this.tableName === 'runs') {
        const directory = dirname(checkedPath)
        rmSync(directory, { recursive: true, force: true })
        fsyncDirectory(dirname(directory))
      } else {
        rmSync(checkedPath, { force: true })
        if (existsSync(dirname(checkedPath))) fsyncDirectory(dirname(checkedPath))
      }
    })
  }

  async update(key: K, updateFn: (value: V | undefined) => V): Promise<V> {
    this.assertOpen()
    return await this.serial(String(key), async () => {
      this.assertOpen()
      const current = await this.get(key)
      const next = this.parse(String(key), updateFn(current))
      const path = this.recordPath(String(key))
      this.fence()
      const eventPath = this.tableName === 'runs' ? this.runEventPath(path) : undefined
      atomicWrite(path, this.tableName === 'runs' ? { ...(next as object), schemaVersion: RUN_RECORD_SCHEMA_VERSION } : next)
      if (eventPath !== undefined) {
        const seq = typeof next === 'object' && next !== null && 'seq' in next ? (next as { seq?: unknown }).seq : undefined
        appendEvent(eventPath, { seq, at: Date.now(), state: (next as { state?: unknown }).state })
      }
      return next
    })
  }

  entries(): IterableIterator<[K, V]> {
    this.assertOpen()
    const directoryName = this.tableName === 'runs' ? 'runs' : this.tableName === 'run_lifecycle' ? 'lifecycle' : this.tableName
    const directory = join(this.root, directoryName)
    assertStoragePath(this.root, directory)
    if (!existsSync(directory)) return [][Symbol.iterator]() as IterableIterator<[K, V]>
    const values: Array<[K, V]> = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const isRun = this.tableName === 'runs'
      if (entry.isSymbolicLink()) throw new Error('storage symlink rejected')
      if (isRun && !entry.isDirectory()) continue
      if (!isRun && (!entry.isFile() || !entry.name.endsWith('.json'))) continue
      // Only names this table could have written are records. Anything else
      // (sync-tool conflict copies, editor backups, AppleDouble files) is
      // foreign and skipped; a record that IS ours but unreadable still fails
      // closed below, naming the exact record.
      const key = isRun ? (runIdSchema.safeParse(entry.name).success ? entry.name : undefined) : ownedTableKey(entry.name.slice(0, -'.json'.length))
      if (key === undefined) continue
      const path = this.recordPath(key)
      if (!existsSync(path) || !statSync(path).isFile()) continue
      const relativeRecord = isRun ? `runs/${key}/run.json` : `${directoryName}/${entry.name}`
      try {
        if (isRun) {
          const value = this.readRun(String(key), path)
          if (value !== undefined) values.push([key as K, value])
        } else values.push([key as K, this.parse(key, JSON.parse(readFileSync(path, 'utf8')))])
      } catch (cause) {
        throw new Error(`directory record ${relativeRecord} is unreadable: ${(cause as Error)?.message ?? String(cause)}`, { cause })
      }
    }
    return values[Symbol.iterator]()
  }

  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(key) ?? Promise.resolve()).then(task)
    const tail = result.catch(() => {})
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}

export interface DirectoryDomainOptions {
  /** Ownership fence run before every durable mutation; throws to refuse it. */
  fence?: () => void
}

class DirectoryDomain implements DomainLike {
  readonly name = 'blueprint_runs'
  readonly kind = 'directory'
  private readonly tables = new Map<string, DirectoryTable<string, unknown>>()
  private closed = false
  private readonly root: string
  private readonly fence: () => void
  constructor(root: string, options: DirectoryDomainOptions = {}) {
    mkdirDurable(root)
    this.root = realpathSync(root)
    this.fence = options.fence ?? (() => {})
    this.sweepTemporaries()
  }

  /** Remove temporary records abandoned by a writer that crashed between its
   * exclusive create and rename. Only names produced by `atomicWrite` that
   * are old enough to be outside any live write are touched. */
  private sweepTemporaries(): void {
    const now = Date.now()
    for (const table of ['commands', 'lifecycle']) sweepAbandonedTemporaries(join(this.root, table), now)
    const runs = join(this.root, 'runs')
    let entries: Dirent[]
    try {
      entries = readdirSync(runs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory() && runIdSchema.safeParse(entry.name).success) sweepAbandonedTemporaries(join(runs, entry.name), now)
    }
  }
  table(name: string): KvTableLike {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('invalid table name')
    const existing = this.tables.get(name)
    if (existing) return existing
    const schema =
      name === 'runs' ? recordsSchema.runs : name === 'commands' ? recordsSchema.commands : name === 'run_lifecycle' ? recordsSchema.run_lifecycle : undefined
    const table = new DirectoryTable(this.root, name, schema as ZodType<unknown> | undefined, () => this.closed, this.fence)
    this.tables.set(name, table)
    return table
  }
  async close(): Promise<void> {
    // New operations are refused immediately; mutations already admitted to a
    // key queue are settled before close resolves, so no write lands after it.
    this.closed = true
    await Promise.allSettled([...this.tables.values()].map(table => table.drain()))
  }
}

export async function openDirectoryDomain(path: string, options: DirectoryDomainOptions = {}): Promise<OpenedDomain> {
  const domain = new DirectoryDomain(path, options)
  return { ctx: {}, domain, close: () => domain.close() }
}
