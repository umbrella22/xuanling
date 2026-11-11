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
export interface NodeContentMetrics {
  /** Header block: title row, kind caption, padding and its hairline. */
  title: number
  /** Dedicated state row; the read-only runtime seat moves state into the header. */
  stateRow: number
  /** One note/summary/member text row. */
  row: number
  /** One port caption row including its handle row height. */
  portRow: number
  /** Vertical padding of a port section, borders included. */
  sectionPadding: number
}
/** Authoring geometry: 40 px rows stay reachable for wiring gestures. */
export const editorNodeMetrics: NodeContentMetrics = { title: 46, stateRow: 20.5, row: 20.5, portRow: 40, sectionPadding: 8 }
/** Read-only runtime geometry: no wiring gesture, so captions can be dense. */
export const runtimeNodeMetrics: NodeContentMetrics = { title: 53, stateRow: 0, row: 18, portRow: 26, sectionPadding: 17 }
export function nodeContentMinimum(shape: NodeContentShape, metrics: NodeContentMetrics = editorNodeMetrics): { width: number; height: number } {
  // Wrapped text is refined by natural-content measurement.
  const dataRows = Math.max(shape.visibility.inputs ? Object.keys(shape.inputs).length : 0, shape.visibility.outputs ? Object.keys(shape.outputs).length : 0)
  const controlRows = shape.visibility.control ? Math.max(1, shape.controlOutputs.length) : 0
  return {
    width: 220,
    height:
      metrics.title +
      metrics.stateRow +
      (shape.summary ? metrics.row : 0) +
      (shape.note ? metrics.row : 0) +
      (shape.members?.length ?? 0) * metrics.row +
      (dataRows ? metrics.sectionPadding + dataRows * metrics.portRow : 0) +
      (controlRows ? metrics.sectionPadding + controlRows * metrics.portRow : 0)
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
