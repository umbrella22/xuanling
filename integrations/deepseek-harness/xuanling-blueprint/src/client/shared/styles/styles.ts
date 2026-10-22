import { baseCss } from './base.ts'
import { canvasCss } from './canvas.ts'
import { panelCss } from './panel.ts'
import { compositionCss } from './composition.ts'

export function installCanvasStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('xuanling-blueprint-canvas-css')) return
  const style = document.createElement('style')
  style.id = 'xuanling-blueprint-canvas-css'
  // Panel host-control rules are the final cascade, outside all Flow previews.
  style.textContent = baseCss + canvasCss + compositionCss + panelCss
  document.head.appendChild(style)
}
