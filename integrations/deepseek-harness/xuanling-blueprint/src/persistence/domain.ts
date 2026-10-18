/**
 * Storage domain bootstrap for the blueprint runtime (C-08). In the host the
 * domain comes from `ctx.storageDomain.open(spec)` (W4 wiring); this module
 * lets the coordinator and tests open the SAME public stack standalone —
 * real json/sqlite backends on a real medium (W0.3 evidence), never an
 * in-memory fake.
 */
import type {} from '@deepseek-ai/dsh-storage-domain'
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  commandRecordSchema,
  recordsSchema,
  runLifecycleSchema,
  runRecordSchema,
  type CommandRecord,
  type RunLifecycleRecord,
  type RunRecord
} from './records.ts'

export class StoredRecordInvalidError extends Error {
  readonly code = 'STORED_RECORD_INVALID'
  constructor(
    readonly table: string,
    readonly key: string,
    reason: string
  ) {
    super(`stored ${table} record ${key} is invalid: ${reason}`)
  }
}

/**
 * The JSON per-record backend intentionally treats unreadable documents as
 * absent. Runs are canonical facts, so an unreadable run document is moved to
 * a reversible backup before the domain opens; malformed command or lifecycle
 * documents fail closed because silently dropping either can change replay or
 * history semantics. SQLite has no per-record backup facet and therefore
 * retains its backend-level fail-closed behavior.
 */
function quarantineJsonRecords(spec: BlueprintDomainSpec): void {
  if (spec.backend !== 'json') return
  const unitRoot = join(spec.path, spec.domainName ?? 'blueprint_runs')
  const tables = [
    ['commands', commandRecordSchema, false],
    ['run_lifecycle', runLifecycleSchema, false],
    ['runs', runRecordSchema, true]
  ] as const
  const invalidRuns: Array<{ file: string; key: string }> = []
  for (const [table, schema, quarantine] of tables) {
    const tableRoot = join(unitRoot, table)
    if (!existsSync(tableRoot)) continue
    for (const entry of readdirSync(tableRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const key = entry.name.slice(0, -'.json'.length)
      const file = join(tableRoot, entry.name)
      let parsed: unknown
      let valid = false
      try {
        const document = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
        if (document.version === 1 && 'record' in document) valid = schema.safeParse(document.record).success
        parsed = document
      } catch {
        parsed = undefined
      }
      if (valid) continue
      if (!quarantine) throw new StoredRecordInvalidError(table, key, parsed === undefined ? 'malformed-json' : 'schema-invalid')
      invalidRuns.push({ file, key })
    }
  }
  for (const { file, key } of invalidRuns) {
    try {
      renameSync(file, `${file}.bak.${Date.now()}-${randomUUID()}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new StoredRecordInvalidError('runs', key, 'quarantine-failed')
    }
  }
}

export interface KvTableLike<K = string, V = unknown> {
  get(key: K): Promise<V | undefined>
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<void>
  update(key: K, updateFn: (value: V | undefined) => V): Promise<V>
  entries?(): IterableIterator<[K, V]>
}

export interface DomainLike {
  name: string
  table(name: string): KvTableLike
  close(): Promise<void>
}

export interface OpenedDomain {
  ctx: { stop?: () => Promise<void>; destroy?: () => Promise<void> }
  domain: DomainLike
  close(): Promise<void>
}

export interface BlueprintDomainSpec {
  /** Storage backend key: 'json' | 'sqlite' (both W0.3-proven). */
  backend: 'json' | 'sqlite'
  /** Backend medium: json root dir or sqlite db file (inside the runtime root). */
  path: string
  domainName?: string
}

/** Open the blueprint_runs domain on a real backend via a minimal cordis
 * context. Domain name must match UNIT_NAME_RE. */
export async function openBlueprintDomain(spec: BlueprintDomainSpec): Promise<OpenedDomain> {
  quarantineJsonRecords(spec)
  const { Context } = await import('@deepseek-ai/cordis')
  const Storage = (await import('@deepseek-ai/dsh-storage')).default
  const domainMod = await import('@deepseek-ai/dsh-storage-domain')
  const backendMod = spec.backend === 'json' ? await import('@deepseek-ai/dsh-storage-json') : await import('@deepseek-ai/dsh-storage-sqlite')

  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(backendMod, spec.backend === 'json' ? { root: spec.path } : { path: spec.path })
  await ctx.plugin(domainMod, { backend: spec.backend })
  // Pin the table value types at this boundary.  Alpha.3's DomainSpec
  // projection otherwise recursively expands the large zod TeamStage schema
  // while inferring `defineDomain`, producing TS2589 without changing the
  // runtime validators used by the durable store.
  // The alpha.3 package carries its own zod 4.4 type identity while the
  // plugin currently resolves zod 4.6, so cross-package schema arguments are
  // deliberately narrowed through the function's public parameter type.
  const runsTable = domainMod.domainTable<string, RunRecord>(recordsSchema.runs as unknown as never)
  const commandsTable = domainMod.domainTable<string, CommandRecord>(recordsSchema.commands as unknown as never)
  const lifecycleTable = domainMod.domainTable<string, RunLifecycleRecord>(recordsSchema.run_lifecycle as unknown as never)
  const domain = await ctx.storageDomain.open(
    domainMod.defineDomain({
      name: spec.domainName ?? 'blueprint_runs',
      version: 1,
      layout: 'per-record',
      // The per-record JSON backend quarantines a semantically invalid
      // document and keeps the other canonical records readable. SQLite has
      // no backupRecord facet, so it continues to fail closed at open time.
      invalidRecords: 'backup-and-skip',
      tables: {
        runs: runsTable,
        commands: commandsTable,
        run_lifecycle: lifecycleTable
      }
    })
  )
  const closable = ctx as unknown as { stop?: () => Promise<void>; destroy?: () => Promise<void> }
  const close = async (): Promise<void> => {
    await domain.close()
    if (closable.stop) await closable.stop()
  }
  return { ctx: closable, domain: domain as unknown as DomainLike, close }
}
