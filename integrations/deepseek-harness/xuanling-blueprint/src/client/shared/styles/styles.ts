import { baseCss } from './base.ts'
import { canvasCss } from './canvas.ts'
import { panelCss } from './panel.ts'
import { compositionCss } from './composition.ts'

export function installCanvasStyles(): void {
  if (typeof document === 'undefined') return
  // Plugin updates can hot-swap the JSX while an old style element survives a
  // page that did not reload; always converge the injected sheet to this build
  // so fresh rules are never silently skipped.
  const css = baseCss + canvasCss + compositionCss + panelCss
  const existing = document.getElementById('xuanling-blueprint-canvas-css')
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css
    return
  }
  const style = document.createElement('style')
  style.id = 'xuanling-blueprint-canvas-css'
  // Panel host-control rules are the final cascade, outside all Flow previews.
  style.textContent = css
  document.head.appendChild(style)
}
