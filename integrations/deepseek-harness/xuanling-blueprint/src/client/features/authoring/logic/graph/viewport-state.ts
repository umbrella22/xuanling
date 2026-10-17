/** This record lives only in UI storage. It never becomes presentation or history. */
export interface ViewportState {
  version: 1
  viewport: { x: number; y: number; zoom: number }
  mode: 'pan' | 'select'
  minimap: boolean
  motion: 'on' | 'off'
  canvasLocked: boolean
}
export interface ViewportStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
export const viewportKey = (blueprintId: string): string => `xuanling-blueprint:viewport:${encodeURIComponent(blueprintId)}`
export function defaultViewportState(): ViewportState {
  return { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, mode: 'pan', minimap: true, motion: 'on', canvasLocked: false }
}
function objectWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value, key))
  )
}
/** Strict decode; invalid values are rejected rather than clamped or partially adopted. */
export function decodeViewportState(value: unknown): ViewportState | null {
  if (
    !objectWithKeys(value, ['version', 'viewport', 'mode', 'minimap', 'motion', 'canvasLocked']) ||
    value.version !== 1 ||
    !objectWithKeys(value.viewport, ['x', 'y', 'zoom'])
  )
    return null
  const { x, y, zoom } = value.viewport
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof zoom !== 'number' ||
    !Number.isFinite(zoom) ||
    zoom <= 0 ||
    (value.mode !== 'pan' && value.mode !== 'select') ||
    typeof value.minimap !== 'boolean' ||
    (value.motion !== 'on' && value.motion !== 'off') ||
    typeof value.canvasLocked !== 'boolean'
  )
    return null
  return { version: 1, viewport: { x, y, zoom }, mode: value.mode, minimap: value.minimap, motion: value.motion, canvasLocked: value.canvasLocked }
}
export type ViewportReadStatus = 'restored' | 'missing' | 'corrupt' | 'unavailable'
export type ViewportWriteResult = { ok: true } | { ok: false; reason: 'stale-context' | 'invalid-state' | 'storage-unavailable' }
export interface ViewportBinding {
  blueprintId: string
  generation: number
  state: ViewportState
  readStatus: ViewportReadStatus
  write(state: ViewportState): ViewportWriteResult
}

/** One store per mounted workspace. Bind at navigation, invalidate on unmount.
 * A callback captures both identity and generation, including A -> B -> A. */
export class ViewportStateStore {
  private generation = 0
  constructor(private readonly storage?: ViewportStorage) {}
  invalidate(): void {
    this.generation++
  }
  bind(blueprintId: string): ViewportBinding {
    const generation = ++this.generation
    const key = viewportKey(blueprintId)
    let state = defaultViewportState()
    let readStatus: ViewportReadStatus = 'unavailable'
    if (this.storage) {
      try {
        const stored = this.storage.getItem(key)
        if (stored === null) readStatus = 'missing'
        else {
          const decoded = decodeViewportState(JSON.parse(stored))
          readStatus = decoded ? 'restored' : 'corrupt'
          if (decoded) state = decoded
        }
      } catch (error) {
        readStatus = error instanceof SyntaxError ? 'corrupt' : 'unavailable'
      }
    }
    return {
      blueprintId,
      generation,
      state,
      readStatus,
      write: value => {
        if (generation !== this.generation) return { ok: false, reason: 'stale-context' }
        const decoded = decodeViewportState(value)
        if (!decoded) return { ok: false, reason: 'invalid-state' }
        if (!this.storage) return { ok: false, reason: 'storage-unavailable' }
        try {
          this.storage.setItem(key, JSON.stringify(decoded))
          return { ok: true }
        } catch {
          return { ok: false, reason: 'storage-unavailable' }
        }
      }
    }
  }
}
