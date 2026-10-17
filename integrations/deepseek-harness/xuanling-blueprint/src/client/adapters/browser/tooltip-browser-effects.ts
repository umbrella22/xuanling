import { clampOverlay } from '../../features/authoring/ui/overlays/interaction-overlays.tsx'
/** Browser lifecycle adapter; pure tooltip view owns no observers or listeners. */
export function installTooltipBrowserEffects(
  element: HTMLDivElement,
  container: HTMLDivElement,
  anchorElement: HTMLElement,
  setPosition: (value: { x: number; y: number }) => void,
  onClose: () => void
): () => void {
  const place = () => {
    const bounds = container.getBoundingClientRect(),
      anchor = anchorElement.getBoundingClientRect(),
      size = element.getBoundingClientRect()
    const below = anchor.bottom - bounds.top + 6
    setPosition(
      clampOverlay({ x: anchor.left - bounds.left, y: below + size.height <= bounds.height ? below : anchor.top - bounds.top - size.height - 6 }, size, bounds)
    )
  }
  place()
  const observer = new ResizeObserver(place)
  observer.observe(element)
  observer.observe(container)
  const dismiss = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') onClose()
  }
  document.addEventListener('keydown', dismiss)
  document.addEventListener('pointerdown', onClose, true)
  window.addEventListener('resize', place)
  return () => {
    observer.disconnect()
    document.removeEventListener('keydown', dismiss)
    document.removeEventListener('pointerdown', onClose, true)
    window.removeEventListener('resize', place)
  }
}
