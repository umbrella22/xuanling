/** Palette placement owns graph coordinates; the pane and DOM own screen coordinates. */
import type { EditorNode } from './graph-editor.ts'

interface Point { x: number; y: number }
interface Size { width: number; height: number }
export interface PlacementRect extends Point, Size {}
export interface PaletteReservation { shape: string; footprint: Size }
interface FlowMeasurements {
  getNodes(): Array<{ id: string; measured?: { width?: number; height?: number } }>
  screenToFlowPosition(point: Point, options: { snapToGrid: boolean }): Point
}
export type PalettePlacement = { ok: true; position: Point; footprint: Size } | { ok: false; reason: 'no-space' | 'canvas-unmeasured' }

// Current BlueprintNode/styles.ts silhouette, not a graph/product size limit:
// width 220; title 8*2 + (9+11)*1.5 = 46; summary/state each 2*2+11*1.5;
// one 40px data row and one control row, each with column padding 4*2.
// All four freshly added palette kinds render this same unbound silhouette.
export const PALETTE_NODE_FOOTPRINT: Readonly<Size> = Object.freeze({ width: 220, height: 46 + 2 * 20.5 + 2 * 48 })
// Current selected-node paint has a 2px outline on each node. Keep bodies
// separated by both outlines, not a blanket handle-sized inter-node gap.
const PAINT_CLEARANCE = 2 * 2
// Pane-edge inset owns the 10px handle with :before inset -15px.
const PANE_INSET = 10 / 2 + 15
export function paletteNodeShape(node: EditorNode): string {
  return JSON.stringify([node.kind, node.label, node.inputs, node.outputs, node.definition])
}
const hasSize = (size: { width?: number; height?: number } | undefined): size is Size => !!size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width! > 0 && size.height! > 0

/** Earliest visible free rectangle; never moves existing nodes or the viewport. */
export function findVisibleNodePosition(visible: PlacementRect, occupied: PlacementRect[], footprint: Size): Point | null {
  const inset = PANE_INSET
  const left = visible.x + inset, top = visible.y + inset
  const right = visible.x + visible.width - inset, bottom = visible.y + visible.height - inset
  if (left + footprint.width > right || top + footprint.height > bottom) return null
  const rows = [...new Set([top, ...occupied.map(rect => rect.y + rect.height + PAINT_CLEARANCE)])].filter(y => y >= top && y + footprint.height <= bottom).sort((a, b) => a - b)
  for (const y of rows) {
    let x = left
    const blockers = occupied.filter(rect => y < rect.y + rect.height + PAINT_CLEARANCE && y + footprint.height > rect.y - PAINT_CLEARANCE).sort((a, b) => a.x - b.x)
    for (const rect of blockers) {
      if (x < rect.x + rect.width + PAINT_CLEARANCE && x + footprint.width > rect.x - PAINT_CLEARANCE) x = rect.x + rect.width + PAINT_CLEARANCE
    }
    if (x + footprint.width <= right) return { x, y }
  }
  return null
}

/** Read observable measurements before creating the editor's single Add transaction. */
export function placePaletteNode(root: HTMLElement | null, flow: FlowMeasurements, nodes: EditorNode[], reservations: Map<string, PaletteReservation>): PalettePlacement {
  const pane = root?.querySelector<HTMLElement>('.react-flow__pane')?.getBoundingClientRect()
  if (!pane || !hasSize(pane)) return { ok: false, reason: 'canvas-unmeasured' }
  // Official converter subtracts the pane origin and viewport pan/zoom once.
  const toFlow = (point: Point) => flow.screenToFlowPosition(point, { snapToGrid: false })
  const start = toFlow({ x: pane.left, y: pane.top }), end = toFlow({ x: pane.right, y: pane.bottom })
  const visible = { ...start, width: end.x - start.x, height: end.y - start.y }
  const measured = new Map(flow.getNodes().map(node => [node.id, node.measured]))
  const rendered = new Map<string, { rect: Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom'>; body: DOMRect }>()
  for (const element of root!.querySelectorAll<HTMLElement>('.react-flow__node')) {
    const id = element.getAttribute('data-id'), body = element.getBoundingClientRect()
    if (!id || !hasSize(body)) continue
    // Include actual overflowing port text and varying title/summary/port geometry,
    // not just the fixed-width node wrapper. No DOM writes or measurement probes.
    const parts = [body, ...Array.from(element.querySelectorAll<HTMLElement>('.bp-node-title, .bp-node-summary, .bp-node-state, .bp-node-note, .bp-port-row span'), part => part.getBoundingClientRect()).filter(hasSize)]
    const left = Math.min(...parts.map(part => part.left)), top = Math.min(...parts.map(part => part.top))
    const right = Math.max(...parts.map(part => part.right)), bottom = Math.max(...parts.map(part => part.bottom))
    rendered.set(id, { body, rect: { left, top, right, bottom } })
  }
  const occupied: PlacementRect[] = []
  for (const node of nodes) {
    const actual = rendered.get(node.id)
    if (actual) {
      const body = toFlow({ x: actual.body.left, y: actual.body.top })
      const a = toFlow({ x: actual.rect.left, y: actual.rect.top }), b = toFlow({ x: actual.rect.right, y: actual.rect.bottom })
      // Anchor measurements to current editor positions, even before Flow catches
      // up with a drag/Undo. Measurements supply extents, not semantic positions.
      occupied.push({ x: node.x + a.x - body.x, y: node.y + a.y - body.y, width: b.x - a.x, height: b.y - a.y })
    } else {
      const reservation = reservations.get(node.id)
      const size = measured.get(node.id)
      const footprint = hasSize(size) ? size : reservation?.shape === paletteNodeShape(node) ? reservation.footprint : undefined
      if (!hasSize(footprint)) return { ok: false, reason: 'canvas-unmeasured' }
      occupied.push({ x: node.x, y: node.y, ...footprint })
    }
  }
  for (const overlay of root!.querySelectorAll<HTMLElement>('.react-flow__controls, .react-flow__minimap')) {
    const rect = overlay.getBoundingClientRect()
    if (!hasSize(rect)) continue
    const a = toFlow({ x: rect.left, y: rect.top }), b = toFlow({ x: rect.right, y: rect.bottom })
    occupied.push({ ...a, width: b.x - a.x, height: b.y - a.y })
  }
  const position = findVisibleNodePosition(visible, occupied, PALETTE_NODE_FOOTPRINT)
  return position ? { ok: true, position, footprint: PALETTE_NODE_FOOTPRINT } : { ok: false, reason: 'no-space' }
}
