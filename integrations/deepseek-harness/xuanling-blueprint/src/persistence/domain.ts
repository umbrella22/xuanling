/** Workspace-native directory domain for Blueprint Run facts. */
import { openDirectoryDomain } from './directory-domain.ts'

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
  path: string
  /** Writer-ownership fence checked before every durable mutation. */
  fence?: () => void
}

/** Open the canonical directory domain. The old JSON/SQLite adapters are
 * intentionally absent from this contract after the workspace cutover. */
export async function openBlueprintDomain(spec: BlueprintDomainSpec): Promise<OpenedDomain> {
  return await openDirectoryDomain(spec.path, spec.fence === undefined ? {} : { fence: spec.fence })
}
