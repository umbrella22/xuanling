// The same recorder runs inside the actual DSH page and in deterministic timing
// tests. The latter prove event/frame mechanics, not a machine performance gate.
// Keep this installer self-contained: Playwright serializes it into the page.
export function installCanvasPaintRecorder() {
  const viewport = () => document.querySelector('.react-flow__viewport')?.style.transform
  const state = window.__bpPerf
  if (!state || !Array.isArray(state.samples)) throw new Error('canvas load timing was not initialized')
  let active = null
  function observe(event) {
    if (!active || active.startMs !== null || !event.isTrusted || !event.target?.closest('.react-flow__pane')) return
    if (active.kind === 'pan' ? event.type !== 'pointermove' || event.buttons !== 1 : event.type !== 'wheel') return
    const sample = active
    // Capture precedes d3's bubble/mousemove mutation. Do not start at pointerup,
    // and do not charge only the last frame of a completed gesture.
    sample.startMs = performance.now()
    sample.type = event.type
    const changedFrame = () => {
      if (active !== sample) return
      const after = viewport()
      if (typeof after !== 'string' || after === sample.before) {
        requestAnimationFrame(changedFrame)
        return
      }
      sample.changeObservedAt = performance.now()
      // The next rAF is a conservative completion bound for the changed frame.
      requestAnimationFrame(() => {
        if (active !== sample) return
        state.samples.push({ index: sample.index, kind: sample.kind, type: sample.type, trusted: true,
          startMs: sample.startMs, changeObservedAt: sample.changeObservedAt,
          latencyMs: performance.now() - sample.startMs, before: sample.before, after })
        active = null
      })
    }
    requestAnimationFrame(changedFrame)
  }
  document.addEventListener('pointermove', observe, { passive: true, capture: true })
  document.addEventListener('wheel', observe, { passive: true, capture: true })
  window.__bpPaint = {
    arm(index, kind) {
      if (active || index !== state.samples.length || !['pan', 'zoom'].includes(kind)) throw new Error('overlapping or out-of-order paint interaction')
      const before = viewport()
      if (typeof before !== 'string') throw new Error('mounted canvas viewport missing')
      active = { index, kind, before, startMs: null }
    },
    dispose() {
      active = null
      document.removeEventListener('pointermove', observe, { capture: true })
      document.removeEventListener('wheel', observe, { capture: true })
    },
  }
}
