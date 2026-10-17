import type { BlueprintWorkspace } from '../../features/authoring/logic/workspace/workspace-controller.ts'

export interface MotionEnvironment {
  visible: boolean
  reduced: boolean
}

export interface PanelRootRef {
  current: HTMLElement | null
}

/** Install the browser-owned motion observers and return an idempotent cleanup. */
export function installMotionEnvironment(onChange: (value: MotionEnvironment) => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const media = window.matchMedia('(prefers-reduced-motion: reduce)')
  let disposed = false
  const sample = () => {
    if (disposed) return
    onChange({ visible: document.visibilityState === 'visible', reduced: media.matches })
  }
  document.addEventListener('visibilitychange', sample)
  media.addEventListener('change', sample)
  sample()
  return () => {
    if (disposed) return
    disposed = true
    document.removeEventListener('visibilitychange', sample)
    media.removeEventListener('change', sample)
  }
}

/** Observe the panel root without leaking a ResizeObserver between mounts. */
export function installRootResize(rootRef: PanelRootRef, onNarrow: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}
  const root = rootRef.current
  if (!root) return () => {}
  let narrow = false
  const observer = new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width
    const next = width !== undefined && width <= 780
    if (next && !narrow) onNarrow()
    narrow = next
  })
  observer.observe(root)
  return () => observer.disconnect()
}

/** Own the native capture listener needed to intercept horizontal canvas wheels. */
export function installWheelCapture(rootRef: PanelRootRef, onWheel: (event: WheelEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = (event: WheelEvent) => {
    const target = event.target as HTMLElement | null
    if (rootRef.current?.contains(target as globalThis.Node) && target?.closest?.('[data-bp-canvas=surface]')) onWheel(event)
  }
  window.addEventListener('wheel', listener, { capture: true, passive: false })
  return () => window.removeEventListener('wheel', listener, true)
}

/** Poll a run and react to online/offline transitions while the run is bound. */
export function installRunObservation(workspace: BlueprintWorkspace, intervalMs: number, inspect: () => void, disconnect: () => void): () => void {
  if (typeof window === 'undefined' || !workspace.runId) return () => {}
  const setTimer = typeof window.setInterval === 'function' ? window.setInterval.bind(window) : globalThis.setInterval
  const clearTimer = typeof window.clearInterval === 'function' ? window.clearInterval.bind(window) : globalThis.clearInterval
  if (typeof setTimer !== 'function') return () => {}
  const timer = setTimer(() => inspect(), intervalMs)
  window.addEventListener('online', inspect)
  window.addEventListener('offline', disconnect)
  return () => {
    if (typeof clearTimer === 'function') clearTimer(timer)
    window.removeEventListener('online', inspect)
    window.removeEventListener('offline', disconnect)
  }
}

/** Release transient pointer/IME state when the browser window loses focus. */
export function installInteractionRelease(onBlur: () => void, onKeyUp: (event: KeyboardEvent) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener('blur', onBlur)
  window.addEventListener('keyup', onKeyUp)
  return () => {
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('keyup', onKeyUp)
  }
}
