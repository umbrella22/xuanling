/** Pure, client-only projections. No display value is written to graph/run facts. */
import type { AriaLabelConfig } from '@xyflow/react'
import type { EditorGroup, EditorNode } from './graph-editor.ts'
import type { BlueprintLocaleProps } from './locales.ts'
import { PALETTE_NODE_FOOTPRINT } from './node-placement.ts'

type Translator = BlueprintLocaleProps['t']
export function runStateTitle(state: string, t: Translator): string {
  switch (state) {
    case 'queued': return t('state.queued')
    case 'preparing': return t('state.preparing')
    case 'ready': return t('state.ready')
    case 'running': return t('state.running')
    case 'cancelling': return t('state.cancelling')
    case 'recovery_required': return t('state.recovery_required')
    case 'timed_out': return t('state.timed_out')
    case 'waiting_input': return t('state.waiting_input')
    case 'succeeded': return t('state.succeeded')
    case 'failed': return t('state.failed')
    case 'cancelled': return t('state.cancelled')
    case 'skipped': return t('state.skipped')
    default: return state
  }
}
export function resourceKindTitle(kind: string, t: Translator): string {
  switch (kind) {
    case 'agent': return t('resource.kind.agent')
    case 'prompt': return t('resource.kind.prompt')
    case 'skill': return t('resource.kind.skill')
    case 'schema': return t('resource.kind.schema')
    case 'script': return t('resource.kind.script')
    case 'mcp': return t('resource.kind.mcp')
    case 'subflow': return t('resource.kind.subflow')
    default: return kind
  }
}
/** Every aria seat in installed XYFlow 12.12; unknown live directions stay raw. */
export function flowAriaLabels(t: Translator): AriaLabelConfig {
  return {
    'node.a11yDescription.default': t('flow.node.a11yDescription.default'),
    'node.a11yDescription.keyboardDisabled': t('flow.node.a11yDescription.keyboardDisabled'),
    'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }) => {
      const label = direction === 'left' ? t('flow.direction.left') : direction === 'right' ? t('flow.direction.right') : direction === 'up' ? t('flow.direction.up') : direction === 'down' ? t('flow.direction.down') : direction
      return t('flow.node.a11yDescription.ariaLiveMessage', { direction: label, x, y })
    },
    'edge.a11yDescription.default': t('flow.edge.a11yDescription.default'),
    'controls.ariaLabel': t('flow.controls.ariaLabel'),
    'controls.zoomIn.ariaLabel': t('flow.controls.zoomIn.ariaLabel'),
    'controls.zoomOut.ariaLabel': t('flow.controls.zoomOut.ariaLabel'),
    'controls.fitView.ariaLabel': t('flow.controls.fitView.ariaLabel'),
    'controls.interactive.ariaLabel': t('flow.controls.interactive.ariaLabel'),
    'minimap.ariaLabel': t('flow.minimap.ariaLabel'),
    'handle.ariaLabel': t('flow.handle.ariaLabel'),
  }
}

interface Measurement { id: string; measured?: { width?: number; height?: number } }
export interface PresentationGroupFrame {
  id: string
  groupId: string
  label: string
  nodeIds: string[]
  x: number
  y: number
  width: number
  height: number
}
const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0
/** Match the unmeasured node silhouette; actual XYFlow dimensions take precedence. */
function fallbackHeight(node: EditorNode): number {
  const dataRows = Math.max(1, Object.keys(node.inputs).length, Object.keys(node.outputs).length)
  const controlRows = Math.max(1, node.definition?.branches?.length ?? 0)
  return PALETTE_NODE_FOOTPRINT.height + (dataRows + controlRows - 2) * 40
}
/** Frames use absolute graph positions, NOT parent-relative positions. Unknown/missing
 * members are ignored, never fabricated. Synthetic IDs cannot shadow executable IDs. */
export function presentationGroupFrames(groups: readonly EditorGroup[], nodes: readonly EditorNode[], measurements: readonly Measurement[] = []): PresentationGroupFrame[] {
  const byId = new Map(nodes.map(node => [node.id, node]))
  const measured = new Map(measurements.map(node => [node.id, node.measured]))
  const used = new Set(nodes.map(node => node.id))
  const frames: PresentationGroupFrame[] = []
  for (const group of groups) {
    const members = [...new Set(group.nodeIds)].flatMap(id => byId.has(id) ? [byId.get(id)!] : [])
    if (!members.length) continue
    const left = Math.min(...members.map(n => n.x)), top = Math.min(...members.map(n => n.y))
    const right = Math.max(...members.map(n => n.x + (positive(measured.get(n.id)?.width) ? measured.get(n.id)!.width! : PALETTE_NODE_FOOTPRINT.width)))
    const bottom = Math.max(...members.map(n => n.y + (positive(measured.get(n.id)?.height) ? measured.get(n.id)!.height! : fallbackHeight(n))))
    let id = `bp:presentation-group:${group.id}`
    while (used.has(id)) id += ':'
    used.add(id)
    // 24px paint margin and 44px header are display geometry, not domain limits.
    frames.push({ id, groupId: group.id, label: group.label, nodeIds: members.map(n => n.id), x: left - 24, y: top - 68, width: right - left + 48, height: bottom - top + 92 })
  }
  return frames
}
/** Renderer selection/deletion seats accept executable IDs only. */
export function executableNodeIds(nodes: readonly Pick<EditorNode, 'id'>[], ids: Iterable<string>): string[] {
  const allowed = new Set(nodes.map(node => node.id))
  return [...new Set(ids)].filter(id => allowed.has(id))
}
