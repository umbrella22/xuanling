/** One read-only view over DSH's existing Session model catalog. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelCatalogLink, ModelCatalogStatus } from './remote.ts'

export interface ModelCatalogSnapshot {
  readonly status: ModelCatalogStatus
  readonly value: ModelCatalog | null
  readonly error: string | null
}

const unavailable = (error: string | null = null): ModelCatalogSnapshot => ({ status: 'unavailable', value: null, error })

/**
 * Loads exactly the catalog served by DSH for the current Host generation.
 * It owns no provider configuration and never rewrites an existing Blueprint route.
 */
export class ModelCatalogController {
  private snapshot: ModelCatalogSnapshot
  private listeners = new Set<() => void>()
  private inflight: Promise<void> | undefined
  private link: ModelCatalogLink | undefined

  constructor(link: ModelCatalogLink | undefined) {
    this.link = link
    this.snapshot = link === undefined ? unavailable() : { status: 'loading', value: null, error: null }
  }

  getSnapshot = (): ModelCatalogSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setLink = (link: ModelCatalogLink | undefined): void => {
    if (this.link === link) return
    this.link = link
    if (link === undefined) {
      this.snapshot = unavailable()
      this.publish()
      return
    }
    this.snapshot = { status: 'loading', value: null, error: null }
    this.publish()
    void this.load()
  }

  load = async (): Promise<void> => {
    const link = this.link
    if (link === undefined || this.snapshot.status === 'ready' || this.inflight !== undefined) return
    this.snapshot = { status: 'loading', value: null, error: null }
    this.publish()
    const operation = link
      .modelCatalog()
      .then(response => {
        if (this.link !== link) return
        this.snapshot =
          response.ok && response.value
            ? { status: 'ready', value: response.value, error: null }
            : unavailable(response.error ? `${response.error.code}: ${response.error.message ?? 'model catalog unavailable'}` : 'model catalog unavailable')
        this.publish()
      })
      .catch((error: unknown) => {
        if (this.link !== link) return
        this.snapshot = unavailable(error instanceof Error ? error.message : String(error))
        this.publish()
      })
      .finally(() => {
        this.inflight = undefined
      })
    this.inflight = operation
    await operation
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
