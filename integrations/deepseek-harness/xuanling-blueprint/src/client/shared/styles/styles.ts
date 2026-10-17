import { baseCss } from './base.ts'
import { canvasCss } from './canvas.ts'
import { panelCss } from './panel.ts'

export function installCanvasStyles(): void {
  if (typeof document === 'undefined' || document.getElementById('xuanling-blueprint-canvas-css')) return
  const style = document.createElement('style')
  style.id = 'xuanling-blueprint-canvas-css'
  style.textContent = baseCss + canvasCss + panelCss
  document.head.appendChild(style)
}
