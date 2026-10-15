/** Shared display geometry. Saved sizes are lower bounds, never content clips. */
import type React from 'react'
export interface NodeContentShape {
  title: string
  summary?: string
  state: string
  note?: string
  members?: readonly string[]
  inputs: Record<string, string>
  outputs: Record<string, string>
  controlOutputs: readonly string[]
  visibility: { control: boolean; inputs: boolean; outputs: boolean }
}
export function nodeContentKey(shape: NodeContentShape, width: number): string {
  return JSON.stringify([width, shape])
}
export function nodeContentMinimum(shape: NodeContentShape): { width: number; height: number } {
  // Existing CSS: title 46px; text rows 20.5px; port rows 40px,
  // columns padding 8px. Wrapped text is refined by natural-content measurement.
  const dataRows = Math.max(shape.visibility.inputs ? Object.keys(shape.inputs).length : 0, shape.visibility.outputs ? Object.keys(shape.outputs).length : 0)
  const controlRows = shape.visibility.control ? Math.max(1, shape.controlOutputs.length) : 0
  return {
    width: 220,
    height:
      46 +
      20.5 +
      (shape.summary ? 20.5 : 0) +
      (shape.note ? 20.5 : 0) +
      (shape.members?.length ?? 0) * 20.5 +
      (dataRows ? 8 + dataRows * 40 : 0) +
      (controlRows ? 8 + controlRows * 40 : 0)
  }
}
/** Measure the unconstrained content wrapper, not the user-sized outer shell.
 * Border-box observer sizes stay in world CSS pixels even under viewport zoom. */
export function useNodeContentMeasurement(
  key: string,
  runtime: Pick<typeof React, 'useRef' | 'useState' | 'useEffect'>,
  onMeasure?: (height: number) => void
): { ref: React.RefObject<HTMLDivElement | null>; height?: number } {
  const ref = runtime.useRef<HTMLDivElement | null>(null)
  const [measurement, setMeasurement] = runtime.useState<{ key: string; height: number } | null>(null)
  runtime.useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let active = true
    const observer = new ResizeObserver(entries => {
      if (!active) return
      const entry = entries[0]
      const box = entry?.borderBoxSize?.[0]
      const height = box?.blockSize ?? element.offsetHeight
      if (!Number.isFinite(height) || height <= 0) return
      onMeasure?.(height)
      setMeasurement(old => (old?.key === key && old.height === height ? old : { key, height }))
    })
    observer.observe(element)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [key])
  return { ref, ...(measurement?.key === key ? { height: measurement.height } : {}) }
}
