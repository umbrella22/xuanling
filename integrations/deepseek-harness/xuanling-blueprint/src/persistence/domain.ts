/**
 * Storage domain bootstrap for the blueprint runtime (C-08). In the host the
 * domain comes from `ctx.storageDomain.open(spec)` (W4 wiring); this module
 * lets the coordinator and tests open the SAME public stack standalone —
 * real json/sqlite backends on a real medium (W0.3 evidence), never an
 * in-memory fake.
 */
import type {} from '@deepseek-ai/dsh-storage-domain'
import { recordsSchema } from './records.ts'

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
  const { Context } = await import('@deepseek-ai/cordis')
  const Storage = (await import('@deepseek-ai/dsh-storage')).default
  const domainMod = await import('@deepseek-ai/dsh-storage-domain')
  const backendMod = spec.backend === 'json'
    ? await import('@deepseek-ai/dsh-storage-json')
    : await import('@deepseek-ai/dsh-storage-sqlite')

  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(backendMod, spec.backend === 'json' ? { root: spec.path } : { path: spec.path })
  await ctx.plugin(domainMod, { backend: spec.backend })
  const domain = await ctx.storageDomain.open(domainMod.defineDomain({
    name: spec.domainName ?? 'blueprint_runs',
    version: 1,
    layout: 'per-record',
    tables: {
      runs: domainMod.domainTable(recordsSchema.runs),
      commands: domainMod.domainTable(recordsSchema.commands),
    },
  }))
  const closable = ctx as unknown as { stop?: () => Promise<void>; destroy?: () => Promise<void> }
  const close = async (): Promise<void> => {
    await domain.close()
    if (closable.stop) await closable.stop()
  }
  return { ctx: closable, domain: domain as unknown as DomainLike, close }
}
