/** Canvas-first DSH workspace. Translation is a renderer seat, never graph state. */
import React from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, MarkerType, useReactFlow, NodeResizer, BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { Connection, Node, NodeProps, Edge, EdgeProps } from '@xyflow/react'
import type { ResourceRef, GraphNode, PresentationNode, XY } from '../definition/types.ts'
import { editorNodeDisplayTitle } from './graph-editor.ts'
import type { GraphEditor, CanvasPort } from './graph-editor.ts'
import { BlueprintWorkspace, isEditingTarget } from './workspace.ts'
import type { DraftStorage } from './workspace.ts'
import type { HostLink } from './remote.ts'
import type { BlueprintLocaleKey, BlueprintLocaleProps } from './locales.ts'
import { BUILTIN_NODE_CATALOG, nodeKindTitle, searchBuiltinNodes } from './node-catalog.ts'
import type { BuiltinNodeKind } from './node-catalog.ts'
import { connectionNotice } from './view-contract.ts'
import { renderAttemptDiagnostics } from './diagnostics.ts'
import { JsonEditor } from './json-editor.ts'
import { NodeInspector } from './inspector.ts'
import { executableNodeIds, flowAriaLabels, presentationGroupFrames, resourceDisplayName, resourceKindTitle, runStateTitle } from './presentation.ts'
import { flowEdgeEndpoints } from './flow-geometry.ts'
import { applyCanvasNodeChanges, applyCanvasEdgeSelection, CanvasInteractions, pointerPosition } from './flow-interactions.ts'
import { installCanvasStyles } from './styles.ts'
import { projectRuntimeMotion } from './runtime-motion.ts'
import type { NodeMotion, EdgeMotion } from './runtime-motion.ts'
import { placePaletteNode, paletteNodeShape, PALETTE_NODE_FOOTPRINT } from './node-placement.ts'
import type { PaletteReservation } from './node-placement.ts'
export type { HostLink } from './remote.ts'
import { resolveCanvasShortcut, commandDisabledReason, contextCommands } from './command-policy.ts'
import type { CanvasCommand, CommandFacts, ContextSurface } from './command-policy.ts'
import { ViewportStateStore, defaultViewportState } from './viewport-state.ts'
import type { ViewportBinding, ViewportState } from './viewport-state.ts'
import { InteractionOverlay, archiveBase64, archiveBytes, downloadBlueprint } from './interaction-overlays.ts'
import type { CanvasOverlay } from './interaction-overlays.ts'
import { iconControl } from './compact-chrome.ts'
import type { ChromeControl } from './compact-chrome.ts'
import { WorkspaceTooltip } from './tooltips.ts'
import type { TooltipContent } from './tooltips.ts'
import type { MenuAction } from './menu-model.ts'
import { blueprintIcon } from './icons.ts'
const h = React.createElement
// XYFlow shifts the reconnect center by this radius, beyond the port's 15px hit inset.
const RECONNECT_ANCHOR_RADIUS = 24
const PALETTE_DRAG_TYPE = 'application/x-xuanling-blueprint-node'
const EDITABLE_KINDS = new Set<string>(BUILTIN_NODE_CATALOG.map(p => p.kind))
interface NodeData extends Record<string, unknown> {
  label: string
  kind: string
  kindTitle: string
  inputs: Record<string, string>
  outputs: Record<string, string>
  summary: string
  state: string
  runtime: NodeMotion
  branches: string[]
  t: BlueprintLocaleProps['t']
  presentation: Omit<PresentationNode, 'x' | 'y'>
  editable: boolean
  minHeight: number
  onRename: () => void
  onResizeStart: () => void
  onResize: (size: { width: number; height: number; x: number; y: number }) => void
  onResizeEnd: (position: XY | undefined) => void
}
interface GroupData extends Record<string, unknown> {
  groupId: string
  label: string
  memberCount: number
  ariaLabel: string
  countLabel: string
  removeLabel: string
  removeText: string
  hint: string
  onRemove: () => void
  onMenu: (event: React.MouseEvent) => void
  onRename: () => void
  onPointerDown: (event: React.PointerEvent) => void
  onPointerMove: (event: React.PointerEvent) => void
  onPointerUp: (event: React.PointerEvent) => void
  onPointerCancel: () => void
}
type FlowNode = Node<NodeData, 'blueprint'>
type GroupNode = Node<GroupData, 'presentationGroup'>
type CanvasNode = FlowNode | GroupNode
const BlueprintNode = React.memo(function BlueprintNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { t } = data
  const port = (name: string, type: string, direction: 'in' | 'out', kind: 'data' | 'control', generated = false) => h('div', { className: `bp-port-row bp-port-${direction}`, key: `${direction}-${kind}-${name}` },
    h(Handle, { type: direction === 'in' ? 'target' : 'source', position: direction === 'in' ? Position.Left : Position.Right, id: `${kind}:${name}`, className: `bp-handle-${kind}`,
      'aria-label': t('node.portAria', { nodeId: id, direction: t(direction === 'in' ? 'port.input' : 'port.output'), kind: t(kind === 'data' ? 'port.data' : 'port.control'), port: name }),
      'data-bp-port': `${id}:${kind}:${name}`, ...(direction === 'out' ? { 'data-bp-port-out': `${id}:${kind}:${name}` } : {}) } as React.ComponentProps<typeof Handle> & { 'data-bp-port': string }),
    h('span', null, kind === 'control' ? generated ? t('port.control') : name : `${name} · ${type}`))
  return h('div', { className: `bp-node${selected ? ' bp-node-selected' : ''}`, 'data-bp-node': id, 'data-bp-kind': data.kind,
    'data-bp-raw-state': data.runtime.state, 'data-bp-motion': data.runtime.motion, 'data-bp-relation': data.runtime.relation,
    'data-bp-pinned': String(!!data.presentation.pinned), 'data-bp-collapsed': String(!!data.presentation.collapsed), 'data-bp-color': data.presentation.color ?? 'default',
    style: { width: '100%', height: '100%', minHeight: data.minHeight } },
    data.runtime.motion === 'pulse' && h('div', { className: 'bp-node-emphasis', 'aria-hidden': true }),
    h('div', { 'data-bp-resize': id, 'aria-label': t('interaction.resize') }, ...[false, true].map(corners => h(NodeResizer, { key: corners ? 'corners' : 'edges', nodeId: id, isVisible: selected && data.editable && !data.presentation.pinned,
      // Edges change one axis; corners keep the initial ratio and opposite anchor.
      keepAspectRatio: corners, ...(corners ? { lineStyle: { display: 'none' } } : { handleStyle: { display: 'none' } }),
      minWidth: 220, minHeight: data.minHeight, shouldResize: () => data.editable && !data.presentation.pinned,
      onResizeStart: data.onResizeStart, onResize: (_event, params) => data.onResize(params), onResizeEnd: event => data.onResizeEnd(pointerPosition(event)) }))),
    h('div', { className: 'bp-node-title', title: data.editable && !data.presentation.pinned ? t('interaction.dragNode') : undefined, onDoubleClick: (event: React.MouseEvent) => { event.stopPropagation(); data.onRename() } },
      h('span', { className: 'bp-node-grip', 'aria-hidden': true }, blueprintIcon(React, 'grip')),
      h('span', { className: 'bp-kind' }, data.kindTitle), h('strong', null, data.label)),
    h('div', { className: 'bp-node-summary', title: t('resource.availabilityUnchecked') }, data.summary),
    h('div', { className: 'bp-node-state', 'data-bp-node-state': id }, data.state),
    !EDITABLE_KINDS.has(data.kind) && h('div', { className: 'bp-node-note' }, t('node.importedKind', { kind: data.kind })),
    h('div', { className: 'bp-port-columns' }, h('div', null, ...Object.entries(data.inputs).map(([name, type]) => port(name, type, 'in', 'data'))), h('div', null, ...Object.entries(data.outputs).map(([name, type]) => port(name, type, 'out', 'data')))),
    h('div', { className: 'bp-port-columns bp-control-ports' }, h('div', null, port('control', 'control', 'in', 'control', true)), h('div', null, ...(data.branches.length ? data.branches : ['control']).map(name => port(name, 'control', 'out', 'control', !data.branches.length)))))
})
const PresentationGroup = React.memo(function PresentationGroup({ data }: NodeProps<GroupNode>) {
  return h('div', { className: 'bp-group-frame', 'data-bp-group': data.groupId, role: 'group', 'aria-label': data.ariaLabel, title: data.hint },
    h('div', { className: 'bp-group-header', 'data-bp-group-header': data.groupId, tabIndex: 0,
      onContextMenu: data.onMenu, onDoubleClick: data.onRename, onPointerDown: data.onPointerDown, onPointerMove: data.onPointerMove, onPointerUp: data.onPointerUp, onPointerCancel: data.onPointerCancel }, h('strong', null, data.label), h('span', null, data.countLabel),
      h('button', { type: 'button', className: 'nodrag nopan', 'data-bp-action': `ungroup-${data.groupId}`, 'aria-label': data.removeLabel, title: data.removeLabel, onClick: data.onRemove }, data.removeText)))
})
interface RouteData extends Record<string, unknown> {
  runtime: EdgeMotion
  points: XY[]
  editable: boolean
  t: BlueprintLocaleProps['t']
  positionAt: (position: XY) => XY
  onBegin: () => boolean
  onPreview: (points: XY[]) => void
  onCommit: (position: XY) => void
  onCancel: () => void
  onPoints: (points: XY[]) => void
}
type RouteEdge = Edge<RouteData, 'blueprintEdge'>
export const BlueprintEdge = React.memo(function BlueprintEdge(props: EdgeProps<RouteEdge>) {
  const data = props.data!, drag = React.useRef<{ index: number; points: XY[] } | null>(null)
  const [smooth, labelX, labelY] = getSmoothStepPath(props)
  const path = data.points.length ? `M ${props.sourceX} ${props.sourceY} ${data.points.map(p => `L ${p.x} ${p.y}`).join(' ')} L ${props.targetX} ${props.targetY}` : smooth
  return h('g', { 'data-bp-edge': props.id, 'data-bp-motion-edge': props.id, 'data-bp-motion': data.runtime.motion, 'data-bp-related': String(data.runtime.related) },
    h(BaseEdge, { id: props.id, path, ...(props.markerEnd ? { markerEnd: props.markerEnd } : {}), ...(props.style ? { style: props.style } : {}), label: props.label, labelX, labelY, interactionWidth: 20 }),
    data.runtime.motion === 'pulse' && h('path', { className: 'bp-directed-light', 'data-bp-motion': 'pulse',
      d: path, pathLength: 1, strokeDasharray: '0 2', strokeLinecap: 'round', pointerEvents: 'none', 'aria-hidden': true }),
    ...data.points.map((point, index) => h('circle', { key: index, cx: point.x, cy: point.y, r: 7, className: 'bp-reroute nodrag nopan',
      'data-bp-reroute': `${props.id}:${index}`, tabIndex: 0, role: 'button', 'aria-label': data.t('interaction.reroutePoint', { index: index + 1 }),
      onPointerDown: (event: React.PointerEvent<SVGCircleElement>) => {
        if (event.button !== 0 || !data.editable) return
        event.preventDefault(); event.stopPropagation()
        if (!data.onBegin()) return
        drag.current = { index, points: structuredClone(data.points) }; event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove: (event: React.PointerEvent) => {
        if (!drag.current) return
        event.stopPropagation(); const points = structuredClone(drag.current.points)
        points[drag.current.index] = data.positionAt({ x: event.clientX, y: event.clientY }); data.onPreview(points)
      },
      onPointerUp: (event: React.PointerEvent<SVGCircleElement>) => {
        if (!drag.current) return
        event.stopPropagation(); drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); data.onCommit({ x: event.clientX, y: event.clientY })
      },
      onPointerCancel: () => { drag.current = null; data.onCancel() },
      onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); event.stopPropagation(); if (data.editable) data.onPoints(data.points.filter((_p, i) => i !== index)) },
      onKeyDown: (event: React.KeyboardEvent) => {
        event.stopPropagation()
        if (event.nativeEvent.isComposing || event.keyCode === 229 || !data.editable) return
        if (event.key === 'Escape') { event.preventDefault(); drag.current = null; data.onCancel(); return }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); data.onPoints(data.points.filter((_p, i) => i !== index)); return }
        const delta: Record<string, XY> = { ArrowLeft: { x: -10, y: 0 }, ArrowRight: { x: 10, y: 0 }, ArrowUp: { x: 0, y: -10 }, ArrowDown: { x: 0, y: 10 } }
        const step = delta[event.key]
        if (step) { event.preventDefault(); data.onPoints(data.points.map((p, i) => i === index ? { x: p.x + step.x, y: p.y + step.y } : p)) }
      } })))
})
const edgeTypes = { blueprintEdge: BlueprintEdge }
const nodeTypes = { blueprint: BlueprintNode, presentationGroup: PresentationGroup }
function portOf(editor: GraphEditor, nodeId: string, handle: string | null | undefined, direction: 'in' | 'out'): CanvasPort | null {
  const node = editor.nodes.find(n => n.id === nodeId)
  if (!node || !handle) return null
  const delimiter = handle.indexOf(':'); const kind = handle.slice(0, delimiter); const name = handle.slice(delimiter + 1)
  if (kind === 'control') {
    if (direction === 'out' && name !== 'control' && !node.definition?.branches?.includes(name)) return null
    return { nodeId, port: name, type: 'control', direction, kind }
  }
  const type = (direction === 'out' ? node.outputs : node.inputs)[name]
  return kind === 'data' && type !== undefined ? { nodeId, port: name, type, direction, kind } : null
}
interface PanelNotice { key: BlueprintLocaleKey; params?: Record<string, unknown> }
/** Resource JSON draft identity is the resource/editor, never locale or JSON content. */
function ResourceJsonField({ label, value, onApply, t, disabled }: { label: string; value: ResourceRef; onApply: (text: string) => void; t: BlueprintLocaleProps['t']; disabled: boolean }) {
  const source = JSON.stringify(value, null, 2)
  const [text, setText] = React.useState(source)
  React.useEffect(() => setText(source), [source])
  return h('label', { className: 'bp-field' }, h('span', null, label), h(JsonEditor, { value: text, rows: 3, label, t, disabled, onChange: setText,
    onBlur: text => { if (text !== source) onApply(text) } }))
}
export interface PanelEnvironment { React?: typeof React; hostLink: HostLink | undefined; storage: DraftStorage | undefined }
export function createBlueprintPanel(env: PanelEnvironment): React.ComponentType<BlueprintLocaleProps> {
  function WorkspacePanel({ t }: BlueprintLocaleProps): React.ReactElement {
    const [workspace] = React.useState(() => new BlueprintWorkspace(env.hostLink, env.storage))
    const [, setTick] = React.useState(0)
    const [query, setQuery] = React.useState('')
    const [selected, setSelected] = React.useState<string | null>(null)
    const [selectedEdges, setSelectedEdges] = React.useState<string[]>([])
    const [notice, setNotice] = React.useState<PanelNotice | null>(null)
    const [overlay, setOverlay] = React.useState<CanvasOverlay | null>(null)
    const [tooltip, setTooltip] = React.useState<TooltipContent | null>(null)
    const [spacePan, setSpacePan] = React.useState(false)
    const [libraryCollapsed, setLibraryCollapsed] = React.useState(false)
    const [inspectorCollapsed, setInspectorCollapsed] = React.useState(false)
    const [sidebarId] = React.useState(() => `bp-sidebar-${crypto.randomUUID()}`)
    const [paletteOver, setPaletteOver] = React.useState(false)
    const paletteDrag = React.useRef<{ kind: BuiltinNodeKind; editor: GraphEditor; epoch: number } | null>(null)
    const composing = React.useRef(false)
    const focusBeforeOverlay = React.useRef<HTMLElement | null>(null)
    const overlayEpoch = React.useRef(0)
    const overlayBinding = React.useRef<{ editor: GraphEditor; blueprintId: string | null } | null>(null)
    const [viewportStore] = React.useState(() => new ViewportStateStore(env.storage))
    const preferences = React.useRef<{ id: string | null; binding: ViewportBinding | null; state: ViewportState }>({ id: null, binding: null, state: defaultViewportState() })
    const groupPointer = React.useRef<{ x: number; y: number } | null>(null)
    const connectOrigin = React.useRef<CanvasPort | undefined>(undefined)
    const navigationEpoch = React.useRef(0)
    const connectCancelled = React.useRef(false)
    const reconnecting = React.useRef<{ edgeId: string; copy: boolean } | null>(null)
    const currentContext = React.useRef({ editor: workspace.editor, blueprintId: workspace.blueprintId, documentRevision: workspace.document?.documentRevision ?? null, busy: workspace.busy, locked: false, composing: false })
    const [interactions] = React.useState(() => new CanvasInteractions(() => ({ ...currentContext.current, editor: workspace.editor, blueprintId: workspace.blueprintId,
      documentRevision: workspace.document?.documentRevision ?? null, busy: workspace.busy, locked: preferences.current.state.canvasLocked, composing: composing.current })))
    const [motionEnvironment, setMotionEnvironment] = React.useState(() => ({
      visible: typeof document !== 'undefined' && document.visibilityState === 'visible',
      reduced: typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : true,
    }))
    const [hovered, setHovered] = React.useState<{ editor: GraphEditor; id: string } | null>(null)
    const [focused, setFocused] = React.useState<{ editor: GraphEditor; id: string } | null>(null)
    React.useEffect(() => {
      const media = window.matchMedia('(prefers-reduced-motion: reduce)')
      const sample = () => setMotionEnvironment(previous => {
        const visible = document.visibilityState === 'visible', reduced = media.matches
        return previous.visible === visible && previous.reduced === reduced ? previous : { visible, reduced }
      })
      document.addEventListener('visibilitychange', sample); media.addEventListener('change', sample)
      sample()
      return () => { document.removeEventListener('visibilitychange', sample); media.removeEventListener('change', sample) }
    }, [])
    const flow = useReactFlow<CanvasNode>()
    const rootRef = React.useRef<HTMLDivElement>(null)
    React.useEffect(() => {
      const root = rootRef.current
      if (!root) return
      let narrow = false
      const observer = new ResizeObserver(entries => {
        const next = entries[0]!.contentRect.width <= 780
        if (next && !narrow) { setLibraryCollapsed(true); setInspectorCollapsed(true) }
        narrow = next
      })
      observer.observe(root)
      return () => observer.disconnect()
    }, [])
    const wheelHandler = React.useRef<((event: React.WheelEvent | WheelEvent) => void) | null>(null)
    React.useEffect(() => {
      // React delegates wheel through a passive listener. Native capture must run
      // first so handled horizontal wheels can also prevent page scrolling.
      const listener = (event: WheelEvent) => {
        if (rootRef.current?.contains(event.target as globalThis.Node) && (event.target as HTMLElement).closest?.('[data-bp-canvas=surface]')) wheelHandler.current?.(event)
      }
      window.addEventListener('wheel', listener, { capture: true, passive: false })
      return () => window.removeEventListener('wheel', listener, true)
    }, [])
    const placementRef = React.useRef<{ editor: GraphEditor; reservations: Map<string, PaletteReservation> } | null>(null)
    React.useEffect(() => { installCanvasStyles(); const off = workspace.subscribe(() => setTick(n => n + 1)); void workspace.initialize(t('document.newName')); return off }, [workspace])
    React.useEffect(() => {
      if (!workspace.runId) return
      const timer = setInterval(() => { if (!workspace.busy) void workspace.inspect().catch(() => {}) }, 750)
      const reconnect = () => { void workspace.inspect().catch(() => {}) }
      const disconnect = () => workspace.model.markDisconnected()
      window.addEventListener('online', reconnect); window.addEventListener('offline', disconnect)
      return () => { clearInterval(timer); window.removeEventListener('online', reconnect); window.removeEventListener('offline', disconnect) }
    }, [workspace, workspace.runId])
    const editor = workspace.editor
    if (preferences.current.id !== workspace.blueprintId) {
      const binding = workspace.blueprintId ? viewportStore.bind(workspace.blueprintId) : null
      if (!binding) viewportStore.invalidate()
      preferences.current = { id: workspace.blueprintId, binding, state: binding?.state ?? defaultViewportState() }
    }
    const viewportContext = preferences.current
    const prefs = viewportContext.state
    currentContext.current = { editor, blueprintId: workspace.blueprintId, documentRevision: workspace.document?.documentRevision ?? null, busy: workspace.busy, locked: prefs.canvasLocked, composing: composing.current }
    React.useEffect(() => {
      const bound = preferences.current
      if (bound.binding?.readStatus === 'restored') void flow.setViewport(bound.state.viewport, { duration: 0 })
      interactions.cancel(); setOverlay(null); setTooltip(null); connectOrigin.current = undefined; reconnecting.current = null; setSpacePan(false)
    }, [editor, workspace.blueprintId, flow, interactions])
    React.useEffect(() => { if (workspace.busy || prefs.canvasLocked) { interactions.cancel(); setSpacePan(false); setTick(n => n + 1) } }, [workspace.busy, prefs.canvasLocked, interactions])
    React.useEffect(() => {
      const release = () => { setSpacePan(false); interactions.cancel(); groupPointer.current = null; composing.current = false; setTick(n => n + 1) }
      const releaseSpace = (event: KeyboardEvent) => { if (event.key === ' ') setSpacePan(false) }
      window.addEventListener('blur', release); window.addEventListener('keyup', releaseSpace)
      return () => { window.removeEventListener('blur', release); window.removeEventListener('keyup', releaseSpace); interactions.dispose(); viewportStore.invalidate() }
    }, [interactions, viewportStore])
    const updatePrefs = (patch: Partial<ViewportState>) => {
      const bound = preferences.current, state = { ...bound.state, ...patch }
      const result = bound.binding?.write(state)
      if (result && !result.ok && result.reason === 'stale-context') return
      bound.state = state; setTick(n => n + 1)
    }
    const editable = !!workspace.blueprintId && !workspace.busy && !prefs.canvasLocked && !composing.current
    const withinRoot = (event: { clientX: number; clientY: number } | undefined): boolean => {
      if (!event) return true
      const rect = rootRef.current?.getBoundingClientRect()
      return !rect || event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
    }
    const graphPosition = (position?: XY): XY => {
      if (position) return flow.screenToFlowPosition(position)
      const rect = rootRef.current?.querySelector('[data-bp-canvas="surface"]')?.getBoundingClientRect()
      return rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 100, y: 100 }
    }
    const screenPosition = (position?: XY): XY => {
      const rect = rootRef.current?.getBoundingClientRect()
      return position ? { x: position.x - (rect?.left ?? 0), y: position.y - (rect?.top ?? 0) } : { x: Math.max(0, (rect?.width ?? 600) / 2 - 140), y: 64 }
    }
    const closeOverlay = React.useCallback(() => {
      interactions.cancel(); setOverlay(null); overlayBinding.current = null
      const original = focusBeforeOverlay.current
      if (original?.isConnected) original.focus()
      else rootRef.current?.querySelector<HTMLElement>('[data-bp-canvas="surface"]')?.focus()
    }, [interactions])
    const openOverlay = (next: CanvasOverlay) => {
      setTooltip(null)
      if (!overlay) focusBeforeOverlay.current = typeof document === 'undefined' ? null : document.activeElement as HTMLElement
      overlayEpoch.current++; overlayBinding.current = { editor, blueprintId: workspace.blueprintId }; setOverlay(next)
    }
    const overlayCurrent = () => overlayBinding.current?.editor === workspace.editor && overlayBinding.current.blueprintId === workspace.blueprintId
    const resultNotice = (code: string) => setNotice({ key: 'interaction.result', params: { code } })
    const guarded = (action: () => void) => {
      if (workspace.editor !== editor || workspace.blueprintId !== viewportContext.id || !workspace.blueprintId || workspace.busy || preferences.current.state.canvasLocked || composing.current) return
      try { setNotice(null); action() } catch (error) { resultNotice(typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'canvas-command-failed') }
      setTick(n => n + 1)
    }
    const cancelGesture = () => { interactions.cancel(); groupPointer.current = null; connectOrigin.current = undefined; reconnecting.current = null; connectCancelled.current = true; setTick(n => n + 1) }
    const commitGesture = () => guarded(() => { interactions.commitGesture(); setSelected([...editor.selection][0] ?? null) })
    const openSearch = (point?: XY, origin?: CanvasPort) => {
      if (!editable) return
      openOverlay({ kind: 'node-search', screen: screenPosition(point), position: graphPosition(point), ...(origin ? { origin } : {}) })
    }
    const rename = (id: string, group = false) => {
      if (!editable) return
      const node = editor.nodes.find(n => n.id === id), frame = editor.groups.find(g => g.id === id)
      if (group ? !frame : !node) return
      openOverlay({ kind: 'rename', screen: screenPosition(), targetId: id, group, value: group ? frame!.label : node!.presentation?.title ?? editorNodeDisplayTitle(node!, editor.nodes.indexOf(node!), t) })
    }
    const contextMenu = (surface: ContextSurface, event: React.MouseEvent | MouseEvent, targetId?: string) => {
      event.preventDefault(); event.stopPropagation()
      if (workspace.editor !== editor || composing.current || !workspace.blueprintId) return
      if (surface === 'node' && targetId && !editor.selection.has(targetId)) { editor.setSelection([targetId]); setSelected(targetId); setSelectedEdges([]) }
      if (surface === 'edge' && targetId && !selectedEdges.includes(targetId)) { editor.setSelection([]); setSelected(null); setSelectedEdges([targetId]) }
      openOverlay({ kind: 'context-menu', surface, screen: screenPosition({ x: event.clientX, y: event.clientY }), position: graphPosition({ x: event.clientX, y: event.clientY }), ...(targetId ? { targetId } : {}) })
    }
    const measurementsRef = React.useRef<{ editor: GraphEditor; values: Map<string, { width: number; height: number }> } | null>(null)
    if (measurementsRef.current?.editor !== editor) measurementsRef.current = { editor, values: new Map() }
    const measurements = measurementsRef.current.values
    const selectionChanged = React.useCallback((selection: { nodes: CanvasNode[]; edges: Edge[] }) => {
      if (workspace.editor !== editor) return
      const ids = executableNodeIds(editor.nodes, selection.nodes.map(n => n.id))
      const edgeIds = selection.edges.map(e => e.id).filter(id => editor.edges.some(edge => edge.id === id))
      editor.setSelection(ids)
      setSelected(current => current === (ids[0] ?? null) ? current : ids[0] ?? null)
      setSelectedEdges(current => current.length === edgeIds.length && current.every((id, i) => id === edgeIds[i]) ? current : edgeIds)
    }, [editor, workspace])
    const definition = workspace.definition
    const snapshot = workspace.model.view
    const overlayEligible = workspace.runOverlayEligible
    const motion = projectRuntimeMotion({ nodes: definition?.graph.nodes ?? [], edges: editor.edges, snapshot, overlayEligible,
      connectionState: workspace.model.connectionState, visible: motionEnvironment.visible, reducedMotion: motionEnvironment.reduced, userMotion: prefs.motion,
      hoveredNodeId: hovered?.editor === editor ? hovered.id : null, focusedNodeId: focused?.editor === editor ? focused.id : null })
    // The native bound t keeps its identity on language changes. Derive fresh data
    // every render so memoized custom nodes refresh WITHOUT a provider/editor remount.
    const executableNodes: FlowNode[] = editor.nodes.map((n, index) => {
      const runtime = motion.nodes[index]!
      const state = runtime.state
      const summary = [n.definition?.agentRef, ...(n.definition?.skillRefs ?? []), ...(n.definition?.toolsetRefs ?? []), n.definition?.outputSchemaRef, n.definition?.subflowRef].filter(ref => ref !== undefined)
        .map(id => resourceDisplayName(id, definition?.resources[id], workspace.resourceCatalog)).join(' · ')
      const label = editorNodeDisplayTitle(n, index, t)
      const measured = measurements.get(n.id)
      const gesture = interactions.gesture
      const dragPosition = gesture?.kind === 'drag' && !gesture.clone && gesture.positions.has(n.id) ? { x: n.x + gesture.dx, y: n.y + gesture.dy } : undefined
      const resize = gesture?.kind === 'resize' && gesture.nodeId === n.id ? gesture : undefined
      const size = resize?.size ?? n.presentation
      const minHeight = 103 + 40 * (Math.max(Object.keys(n.inputs).length, Object.keys(n.outputs).length) + Math.max(1, n.definition?.branches?.length ?? 0))
      return { draggable: editable && !n.presentation?.pinned, connectable: editable, style: { width: Math.max(220, size?.width ?? 220), ...(size?.height ? { height: Math.max(minHeight, size.height) } : {}) }, ...(measured ? { measured } : {}), id: n.id, type: 'blueprint', dragHandle: '.bp-node-title', position: resize?.position ?? dragPosition ?? { x: n.x, y: n.y }, selected: editor.selection.has(n.id), ariaLabel: label,
        data: { label, kind: n.kind, kindTitle: nodeKindTitle(n.kind, t), inputs: n.inputs, outputs: n.outputs, summary: summary || t('node.noResourceBinding'), runtime,
          state: state === 'idle' ? t('node.notRunning') : state === 'unknown' ? t('node.unknownState') : runStateTitle(state, t), branches: n.definition?.branches ?? [], t,
          presentation: n.presentation ?? {}, editable, minHeight, onRename: () => rename(n.id),
          onResizeStart: () => guarded(() => { interactions.beginResize(n.id) }),
          onResize: size => guarded(() => interactions.previewResize({ width: size.width, height: size.height }, { x: size.x, y: size.y })),
          onResizeEnd: position => { if (position && !withinRoot({ clientX: position.x, clientY: position.y })) cancelGesture(); else commitGesture() } } }
    })
    const gesture = interactions.gesture
    const previewNodes = gesture?.kind === 'drag' && gesture.clone ? executableNodes.filter(n => gesture.positions.has(n.id)).map(n => ({
      ...n, id: `preview-${n.id}`, position: { x: n.position.x + gesture.dx, y: n.position.y + gesture.dy }, selectable: false, draggable: false, connectable: false,
      data: { ...n.data, editable: false }, className: 'bp-clone-preview',
    })) : []
    const groupPositions = gesture?.kind === 'drag' && !gesture.clone ? editor.nodes.map(n => gesture.positions.has(n.id) ? { ...n, x: n.x + gesture.dx, y: n.y + gesture.dy } : n) : editor.nodes
    const groupNodes: GroupNode[] = presentationGroupFrames(editor.groups, groupPositions, [...measurements].map(([id, measured]) => ({ id, measured }))).map(frame => {
      const label = frame.label || t('group.title')
      return { id: frame.id, type: 'presentationGroup', position: { x: frame.x, y: frame.y }, measured: { width: frame.width, height: frame.height }, style: { width: frame.width, height: frame.height }, zIndex: -1,
        selectable: false, selected: false, draggable: false, deletable: false, connectable: false, focusable: false,
        data: { groupId: frame.groupId, label, memberCount: frame.nodeIds.length, ariaLabel: t('group.ariaLabel', { label }), countLabel: t('group.memberCount', { count: frame.nodeIds.length }), removeLabel: t('group.removeNamed', { label }), removeText: t('group.remove'), hint: t('group.presentationOnly'), onRemove: () => guarded(() => { editor.ungroup(frame.groupId) }),
          onMenu: event => contextMenu('group', event, frame.groupId), onRename: () => rename(frame.groupId, true),
          onPointerDown: event => {
            if (event.button !== 0 || !editable || isEditingTarget(event.target) || (event.target as HTMLElement).closest?.('button')) return
            event.preventDefault(); event.stopPropagation()
            guarded(() => {
              if (!interactions.beginDrag(frame.nodeIds, event.altKey)) return
              groupPointer.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId)
            })
          },
          onPointerMove: event => {
            if (!groupPointer.current) return
            event.stopPropagation(); const start = graphPosition(groupPointer.current), next = graphPosition({ x: event.clientX, y: event.clientY })
            guarded(() => interactions.previewDrag(next.x - start.x, next.y - start.y))
          },
          onPointerUp: event => {
            if (!groupPointer.current) return
            event.stopPropagation(); groupPointer.current = null; event.currentTarget.releasePointerCapture(event.pointerId)
            if (withinRoot(event)) commitGesture(); else cancelGesture()
          }, onPointerCancel: cancelGesture } }
    })
    const nodes: CanvasNode[] = [...groupNodes, ...executableNodes, ...previewNodes]
    const edges: RouteEdge[] = editor.edges.map((e, index) => ({ id: e.id, ...flowEdgeEndpoints(e), type: 'blueprintEdge', reconnectable: editable, selected: selectedEdges.includes(e.id), label: t(e.kind === 'data' ? 'port.data' : 'port.control'), className: `bp-edge-${e.kind} nokey`, markerEnd: { type: MarkerType.ArrowClosed },
      data: { kind: e.kind, runtime: motion.edges[index]!, points: interactions.gesture?.kind === 'route' && interactions.gesture.edgeId === e.id ? interactions.gesture.points : e.points ?? [], editable, t,
        positionAt: graphPosition, onBegin: () => editable && interactions.beginRoute(e.id),
        onPreview: points => guarded(() => interactions.previewRoute(points)), onCommit: position => { if (withinRoot({ clientX: position.x, clientY: position.y })) commitGesture(); else cancelGesture() }, onCancel: cancelGesture,
        onPoints: points => guarded(() => { interactions.route(e.id, points) }) } }))
    const perform = (action: () => Promise<unknown>) => { setNotice(null); void workspace.perform(action) }
    const button = (key: BlueprintLocaleKey, action: string, onClick: () => void, disabled = false, pressed?: boolean) => h('button', { type: 'button', 'data-bp-action': action, onClick, disabled, 'aria-pressed': pressed, title: t(key) }, t(key))
    const selectedNode = editor.nodes.find(n => n.id === selected)
    const parseResource = (value: string, callback: (parsed: ResourceRef) => void) => {
      let parsed: unknown
      try { parsed = JSON.parse(value) } catch { setNotice({ key: 'inspector.invalidJsonRetained' }); return }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { setNotice({ key: 'resource.objectRequired' }); return }
      if (typeof (parsed as ResourceRef).kind !== 'string') { setNotice({ key: 'resource.kindRequired' }); return }
      callback(parsed as ResourceRef); setNotice({ key: 'inspector.editApplied' })
    }
    const add = (kind: BuiltinNodeKind, position?: XY) => {
      if (!definition || !editable) return
      if (placementRef.current?.editor !== editor) placementRef.current = { editor, reservations: new Map() }
      const placement = position ? { ok: true as const, position, footprint: PALETTE_NODE_FOOTPRINT } : placePaletteNode(rootRef.current, flow, editor.nodes, placementRef.current.reservations)
      if (!placement.ok) { setNotice({ key: placement.reason === 'no-space' ? 'canvas.noSpace' : 'canvas.measurementsPending' }); return }
      setNotice(null)
      const id = `n-${crypto.randomUUID()}`
      // Generated identities/ports/branches are data, not translated captions.
      const behavior: GraphNode | undefined = kind === 'condition'
        ? { id, kind, inputs: { predicate: 'boolean' }, branches: ['true', 'false'], condition: { inputPort: 'predicate', trueBranch: 'true', falseBranch: 'false' } }
        : kind === 'join' ? { id, kind, join: 'all' } : undefined
      const n = editor.addNode({ id, kind, label: kind, ...(behavior === undefined ? {} : { definition: behavior }), x: placement.position.x, y: placement.position.y,
        inputs: behavior ? behavior.inputs ?? {} : kind === 'input' ? {} : { input: 'string' },
        outputs: behavior ? behavior.outputs ?? {} : kind === 'output' ? {} : { result: 'string' } })
      placementRef.current.reservations.set(n.id, { shape: paletteNodeShape(n), footprint: placement.footprint })
      editor.toggleSelect(n.id, false); setSelected(n.id)
    }
    const canDropPalette = () => editable && paletteDrag.current?.editor === workspace.editor && paletteDrag.current.epoch === navigationEpoch.current
    const endPaletteDrag = () => { paletteDrag.current = null; setPaletteOver(false) }
    const sidebarToggle = (side: 'library' | 'inspector', collapsed: boolean, toggle: () => void) => {
      const label = t(`sidebar.${side}.${collapsed ? 'expand' : 'collapse'}`)
      return h('div', { className: `bp-sidebar-rail bp-sidebar-rail-${side}` }, h('button', {
        type: 'button', className: 'bp-sidebar-toggle', 'data-bp-action': `toggle-${side}`, 'aria-label': label, title: label,
        'aria-expanded': !collapsed, 'aria-controls': `${sidebarId}-${side}`, onClick: () => {
          setTooltip(null)
          if (collapsed && rootRef.current && rootRef.current.clientWidth <= 780) {
            if (side === 'library') setInspectorCollapsed(true); else setLibraryCollapsed(true)
          }
          toggle()
        },
      }, blueprintIcon(React, (side === 'library') === collapsed ? 'chevron' : 'chevron-left')))
    }
    const targetGroup = overlay?.kind === 'context-menu' && overlay.surface === 'group' ? editor.groups.find(g => g.id === overlay.targetId) : undefined
    const commandFacts = (canvasFocused = true): CommandFacts => {
      const current = workspace.editor, members = targetGroup ? targetGroup.nodeIds : [...current.selection]
      return { canvasFocused, hasDefinition: !!workspace.blueprintId, busy: workspace.busy, canvasLocked: preferences.current.state.canvasLocked,
        selectedNodes: targetGroup ? 0 : current.selection.size, selectedEdges: targetGroup ? 0 : selectedEdges.length, selectedGroups: targetGroup ? 1 : 0,
        movableNodes: members.filter(id => current.nodes.some(n => n.id === id && !n.presentation?.pinned)).length,
        canUndo: current.canUndo, canRedo: current.canRedo,
        canPaste: typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function',
        canRun: !!workspace.host && !!workspace.blueprintId, canCancel: !!workspace.runId,
        canOpen: !!workspace.host?.importDefinition, canRefreshDefinitions: !!workspace.host }
    }
    const dispatch = (command: CanvasCommand) => {
      if (composing.current || commandDisabledReason(command, commandFacts())) return
      const menu = overlay?.kind === 'context-menu' ? overlay : undefined
      const position = menu?.position ?? graphPosition()
      const ids = targetGroup ? targetGroup.nodeIds : [...editor.selection]
      if (command === 'search') { openSearch(menu ? { x: menu.screen.x + (rootRef.current?.getBoundingClientRect().left ?? 0), y: menu.screen.y + (rootRef.current?.getBoundingClientRect().top ?? 0) } : undefined); return }
      if (command === 'rename') { if (targetGroup) rename(targetGroup.id, true); else if (ids[0]) rename(ids[0]); return }
      if (command === 'open') { openOverlay({ kind: 'import', screen: screenPosition() }); return }
      if (command === 'copy' || command === 'cut' || command === 'paste' || command === 'paste-with-incoming') {
        if (targetGroup) editor.setSelection(targetGroup.nodeIds)
        // Close before capturing the async generation; closing later cancels it.
        if (menu) closeOverlay()
        void interactions.clipboard(command, typeof navigator === 'undefined' ? undefined : navigator.clipboard, position).then(result => {
          if (result.code === 'clipboard-stale') return
          resultNotice(result.code); setSelected([...workspace.editor.selection][0] ?? null); setTick(n => n + 1)
        }); return
      }
      if (menu) closeOverlay()
      if (command === 'save') { perform(() => workspace.save()); return }
      if (command === 'run') { perform(() => workspace.run()); return }
      if (command === 'cancel') { perform(() => workspace.cancel()); return }
      if (command === 'refresh-definitions') { perform(() => workspace.initialize()); return }
      if (command === 'pan-start') { setSpacePan(true); return }
      if (command === 'toggle-minimap') { updatePrefs({ minimap: !preferences.current.state.minimap }); return }
      if (command === 'lock-canvas' || command === 'unlock-canvas') { cancelGesture(); updatePrefs({ canvasLocked: command === 'lock-canvas' }); return }
      if (command === 'fit-view' || command === 'fit-selection') { void flow.fitView({ duration: 0, padding: 0.2, ...(command === 'fit-selection' ? { nodes: ids.map(id => ({ id })) } : {}) }); return }
      if (command === 'zoom-in' || command === 'zoom-out') { void (command === 'zoom-in' ? flow.zoomIn({ duration: 0 }) : flow.zoomOut({ duration: 0 })); return }
      if (command === 'select-all') { editor.setSelection(editor.nodes.map(n => n.id)); setSelected(editor.nodes[0]?.id ?? null); return }
      if (command === 'clear-selection') { cancelGesture(); editor.setSelection([]); setSelected(null); setSelectedEdges([]); return }
      guarded(() => {
        if (command === 'undo' || command === 'redo') { cancelGesture(); editor[command](); setSelected(null); setSelectedEdges([]) }
        else if (command === 'delete') { editor.transaction(() => editor.deleteItems(ids, selectedEdges)); setSelected(null); setSelectedEdges([]) }
        else if (command === 'group') editor.groupSelection('')
        else if (command === 'ungroup' && targetGroup) editor.ungroup(targetGroup.id)
        else if (command === 'toggle-pin' || command === 'toggle-collapse') {
          const key = command === 'toggle-pin' ? 'pinned' : 'collapsed'
          const value = !ids.every(id => editor.nodes.find(n => n.id === id)?.presentation?.[key])
          editor.patchPresentation(ids, { [key]: value })
        } else if (command.startsWith('color-')) editor.patchPresentation(ids, { color: command.slice(6) as NonNullable<PresentationNode['color']> })
        else if (command.startsWith('align-')) editor.alignSelection(command.slice(6) as Parameters<GraphEditor['alignSelection']>[0], measurements)
        else if (command.startsWith('distribute-')) editor.distributeSelection(command.endsWith('x') ? 'x' : 'y', measurements)
        else if (command.startsWith('move-')) {
          const dx = command === 'move-left' ? -10 : command === 'move-right' ? 10 : 0
          const dy = command === 'move-up' ? -10 : command === 'move-down' ? 10 : 0
          // Pinned members remain fixed; the movable subset is one transaction.
          editor.transaction(() => { for (const n of editor.nodes) if (ids.includes(n.id) && !n.presentation?.pinned) editor.moveNode(n.id, n.x + dx, n.y + dy) })
        } else if (command === 'disconnect') {
          const edges = editor.edges.filter(e => selectedEdges.includes(e.id) || ids.includes(e.from.split(/[.@]/)[0]!) || ids.includes(e.to.split(/[.@]/)[0]!))
          editor.transaction(() => editor.deleteItems([], edges.map(e => e.id))); setSelectedEdges([])
        } else if (command === 'reroute') {
          editor.transaction(() => { for (const id of selectedEdges) { const edge = editor.edges.find(e => e.id === id); if (edge) edge.points = [...edge.points ?? [], position] } })
        }
      })
    }
    const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (overlay) return
      if (event.key === 'Escape' && tooltip) { setTooltip(null); return }
      const target = event.target as HTMLElement
      if (target?.closest?.('[data-bp-reroute], [data-bp-overlay=more-menu], summary, [data-bp-overlay=context-menu], [data-bp-overlay=node-search], [data-bp-overlay=rename], [data-bp-overlay=shortcuts], [data-bp-overlay=import], button, a, [role=button], .react-flow__controls, .react-flow__minimap')) return
      const focused = !!target?.closest?.('[data-bp-canvas="surface"]')
      const result = resolveCanvasShortcut({ key: event.key, target, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
        repeat: event.repeat, isComposing: composing.current || event.nativeEvent?.isComposing, keyCode: event.keyCode, defaultPrevented: event.defaultPrevented }, commandFacts(focused))
      if (result.preventDefault) { event.preventDefault(); event.stopPropagation?.() }
      if (result.kind === 'command') dispatch(result.command)
      else if (result.kind === 'disabled' && result.command === 'open') setNotice({ key: `interaction.disabled.${result.reason}` })
    }
    const connectionPorts = (connection: Connection | Edge) => ({ from: portOf(editor, connection.source, connection.sourceHandle, 'out'), to: portOf(editor, connection.target, connection.targetHandle, 'in') })
    wheelHandler.current = (event: React.WheelEvent | WheelEvent) => {
            if (workspace.editor !== editor || event.ctrlKey || event.metaKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)
              || isEditingTarget(event.target) || (event.target as HTMLElement).closest?.('.nowheel,.react-flow__controls,.react-flow__minimap')) return
            // Leave vertical wheels and ctrl/pinch to XYFlow's native zoom handler.
            event.preventDefault(); event.stopPropagation()
            const current = flow.getViewport(), scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (rootRef.current?.clientWidth ?? 600) : 1
            void flow.setViewport({ x: current.x - event.deltaX * scale, y: current.y - event.deltaY * scale, zoom: current.zoom }, { duration: 0 })
    }
    const palette = searchBuiltinNodes(query, t)
    const importDisabledReason = commandDisabledReason('open', commandFacts())
    const reason = (key: BlueprintLocaleKey | null) => key ? t(key) : null
    const editReason = () => !workspace.blueprintId ? 'interaction.disabled.no-definition' as const : workspace.busy ? 'interaction.disabled.busy' as const
      : preferences.current.state.canvasLocked ? 'interaction.disabled.canvas-locked' as const : null
    const hostReason = () => !workspace.blueprintId ? 'interaction.disabled.no-definition' as const : workspace.busy ? 'interaction.disabled.busy' as const : null
    let currentTooltip: TooltipContent | null = null
    const chrome = (control: ChromeControl) => {
      if (tooltip?.action === control.action) currentTooltip = { ...tooltip, labelKey: control.labelKey, shortcut: control.shortcut, reason: control.reason }
      return iconControl(React, t, control, setTooltip)
    }
    const moreAction = (action: MenuAction['action'], group: MenuAction['group'], labelKey: BlueprintLocaleKey, icon: string,
      blocked: () => BlueprintLocaleKey | null, onSelect: () => void, shortcut?: string, pressed?: boolean): MenuAction => ({ action, group, labelKey, icon,
      enabled: blocked() === null, reason: reason(blocked()), shortcut, pressed,
      onSelect: () => {
        if (workspace.editor !== editor || !overlayCurrent() || composing.current || blocked()) return
        closeOverlay(); onSelect()
      } })
    const moreActions: MenuAction[] = [
      moreAction('import-blueprint', 'files', 'interaction.import-blueprint', 'import', () => {
        const denied = commandDisabledReason('open', commandFacts())
        return denied ? `interaction.disabled.${denied}` : null
      }, () => openOverlay({ kind: 'import', screen: screenPosition() }), 'Ctrl / ⌘ O'),
      moreAction('export-blueprint', 'files', 'interaction.export-blueprint', 'export', () => hostReason() ?? (!workspace.host?.exportDefinition ? 'compact.exportUnavailable' : null),
        () => perform(async () => { const archive = await workspace.exportArchive(); downloadBlueprint(archiveBytes(archive.archiveBase64), `${archive.blueprintId}.zip`, 'application/zip') })),
      moreAction('motion-toggle', 'view', 'interaction.motion-toggle', 'motion', () => null, () => updatePrefs({ motion: preferences.current.state.motion === 'on' ? 'off' : 'on' }), undefined, prefs.motion === 'on'),
      moreAction('toggle-minimap', 'view', 'compact.minimap', 'minimap', () => null, () => updatePrefs({ minimap: !preferences.current.state.minimap }), 'M', prefs.minimap),
      moreAction('check-run', 'tools', 'preflight.check', 'check', hostReason, () => perform(() => workspace.checkRun())),
      moreAction('refresh-library', 'tools', 'library.refresh', 'refresh', () => workspace.busy ? 'interaction.disabled.busy' : null, () => perform(() => workspace.initialize())),
      moreAction('shortcuts', 'tools', 'interaction.shortcuts', 'keyboard', () => null, () => openOverlay({ kind: 'shortcuts', screen: screenPosition() })),
    ]
    const selectedForToggle = [...editor.selection].map(id => editor.nodes.find(node => node.id === id))
    const presentationState = { allPinned: selectedForToggle.length > 0 && selectedForToggle.every(node => node?.presentation?.pinned),
      allCollapsed: selectedForToggle.length > 0 && selectedForToggle.every(node => node?.presentation?.collapsed) }
    const preflightWarningCount = workspace.preflight?.report?.checks.filter(check => check.status === 'warning').length ?? 0
    const feedback = notice ?? workspace.notice
    const feedbackParams = 'params' in feedback ? feedback.params : undefined
    const message = t(feedback.key, feedback.key === 'status.runAdmitted' && feedbackParams && 'state' in feedbackParams ? { ...feedbackParams, state: runStateTitle(String(feedbackParams.state), t) } : feedbackParams)
    return h('div', { ref: rootRef, className: 'bp-workspace', 'aria-label': t('panel.ariaLabel'), 'data-bp-canvas': 'root', 'data-bp-blueprint': workspace.blueprintId ?? '', 'data-bp-mode': prefs.mode, 'data-bp-motion': prefs.motion, 'data-bp-canvas-locked': String(prefs.canvasLocked), onKeyDown: keyDown, onKeyDownCapture: keyDown, onKeyUp: (e: React.KeyboardEvent) => { if (e.key === ' ') setSpacePan(false) },
        'data-bp-motion-visible': String(motionEnvironment.visible), 'data-bp-motion-reduced': String(motionEnvironment.reduced), 'data-bp-motion-loops': String(motion.loopsAllowed),
        onFocusCapture: (event: React.FocusEvent) => {
          if (workspace.editor !== editor) return
          const id = (event.target as HTMLElement).closest?.('.react-flow__node[data-id]')?.getAttribute('data-id')
          setFocused(id && editor.nodes.some(n => n.id === id) ? { editor, id } : null)
        },
        onBlurCapture: (event: React.FocusEvent) => {
          if (workspace.editor !== editor) return
          const id = (event.relatedTarget as HTMLElement | null)?.closest?.('.react-flow__node[data-id]')?.getAttribute('data-id')
          setFocused(id && editor.nodes.some(n => n.id === id) ? { editor, id } : null)
        },
        onPointerCancel: cancelGesture, onCompositionStart: () => { composing.current = true; cancelGesture() }, onCompositionEnd: () => { composing.current = false }, tabIndex: -1 },
      h('header', { className: 'bp-toolbar' },
        h('div', { className: 'bp-blueprint-picker' }, h('select', { 'data-bp-select': 'blueprint', 'aria-label': t('library.configuredBlueprint'), disabled: workspace.busy, value: workspace.blueprintId ?? '',
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
              const requestedId = e.target.value
              if (workspace.busy || composing.current || workspace.dirty && !window.confirm(t('document.discardConfirm'))) return
              const epoch = ++navigationEpoch.current
              perform(async () => {
                await workspace.load(requestedId)
                if (epoch !== navigationEpoch.current || workspace.blueprintId !== requestedId) return
                const loadedEditor = workspace.editor, binding = viewportStore.bind(requestedId)
                const captured = { id: requestedId, binding, state: binding.state }; preferences.current = captured
                setSelected(null); setSelectedEdges([]); setTick(n => n + 1)
                requestAnimationFrame(() => {
                  if (epoch !== navigationEpoch.current || workspace.editor !== loadedEditor || workspace.blueprintId !== requestedId || preferences.current !== captured) return
                  if (binding.readStatus === 'restored') void flow.setViewport(binding.state.viewport, { duration: 0 })
                  else void flow.fitView({ duration: 0, padding: 0.2 })
                })
              })
            } },
          h('option', { value: '', disabled: true }, t('library.chooseId')),
          workspace.isNewDraft && h('option', { value: workspace.blueprintId! }, t('document.newDraft')),
          ...workspace.catalog.map(d => h('option', { value: d.blueprintId, key: d.blueprintId }, `${d.name} · ${d.blueprintId}`)))),
        h('button', { type: 'button', 'data-bp-action': 'new-blueprint', disabled: workspace.busy, onClick: () => {
          if (workspace.busy || composing.current || workspace.dirty && !window.confirm(t('document.newConfirm'))) return
          navigationEpoch.current++; closeOverlay(); setNotice(null); setSelected(null); setSelectedEdges([])
          workspace.newDraft(t('document.newName'))
        } }, t('action.newBlueprint')),
        h('button', { type: 'button', 'data-bp-action': 'delete-blueprint', disabled: workspace.busy || !workspace.blueprintId || !workspace.isNewDraft && !workspace.document, onClick: () => {
          if (workspace.busy || composing.current || !window.confirm(t(workspace.isNewDraft ? 'document.deleteDraftConfirm' : 'document.deleteConfirm', { name: workspace.definition?.name ?? '' }))) return
          const epoch = ++navigationEpoch.current
          closeOverlay()
          perform(async () => {
            await workspace.deleteCurrent(t('document.newName'))
            if (epoch !== navigationEpoch.current) return
            setNotice(null); setSelected(null); setSelectedEdges([])
          })
        } }, t('action.deleteBlueprint')),
        h('span', { className: 'bp-revision', 'data-bp-dirty': String(workspace.dirty) }, t(workspace.dirty ? 'document.unsaved' : workspace.isNewDraft ? 'document.newDraft' : workspace.document ? 'document.saved' : 'document.none')),
        h('div', { className: 'bp-toolbar-actions' },
          h('div', { className: 'bp-toolbar-group', 'data-bp-toolbar-group': 'history', role: 'group', 'aria-label': t('action.undo') + ' / ' + t('action.redo') + ' / ' + t('action.save') },
          chrome({ action: 'undo', labelKey: 'action.undo', icon: 'undo', shortcut: 'Ctrl / ⌘ Z', reason: editReason() ?? (!editor.canUndo ? 'interaction.disabled.history-unavailable' : null), onClick: () => dispatch('undo') }),
          chrome({ action: 'redo', labelKey: 'action.redo', icon: 'redo', shortcut: 'Ctrl / ⌘ Shift Z · Ctrl Y', reason: editReason() ?? (!editor.canRedo ? 'interaction.disabled.history-unavailable' : null), onClick: () => dispatch('redo') }),
          chrome({ action: 'save-layout', labelKey: 'action.save', icon: 'save', shortcut: 'Ctrl / ⌘ S', reason: hostReason(), onClick: () => perform(() => workspace.save()) })),
          h('div', { className: 'bp-toolbar-group', 'data-bp-toolbar-group': 'mode', role: 'group', 'aria-label': t('interaction.mode-pan') + ' / ' + t('interaction.mode-select') },
          chrome({ action: 'mode-pan', labelKey: 'interaction.mode-pan', icon: 'pan', shortcut: 'Space', pressed: prefs.mode === 'pan', onClick: () => updatePrefs({ mode: 'pan' }) }),
          chrome({ action: 'mode-select', labelKey: 'interaction.mode-select', icon: 'select', pressed: prefs.mode === 'select', onClick: () => updatePrefs({ mode: 'select' }) })),
          h('div', { className: 'bp-toolbar-group', 'data-bp-toolbar-group': 'run-tools', role: 'group', 'aria-label': t('run.title') + ' / ' + t('compact.more') },
          chrome({ action: 'start-run', labelKey: 'action.run', icon: 'run', shortcut: 'Ctrl / ⌘ Enter', reason: hostReason(), onClick: () => perform(() => workspace.run()) }),
          chrome({ action: 'cancel-run', labelKey: 'run.cancel', icon: 'cancel', shortcut: 'Ctrl / ⌘ Alt Enter', reason: workspace.busy ? 'interaction.disabled.busy' : !workspace.runId ? 'interaction.disabled.cancel-unavailable' : null, onClick: () => perform(() => workspace.cancel()) }),
          chrome({ action: 'more-actions', labelKey: 'compact.more', icon: 'more', menu: true, expanded: overlay?.kind === 'more-menu', onClick: event => {
            if (overlay?.kind === 'more-menu') closeOverlay()
            else {
              const anchor = event?.currentTarget?.getBoundingClientRect(), bounds = rootRef.current?.getBoundingClientRect()
              openOverlay({ kind: 'more-menu', screen: anchor && bounds ? { x: anchor.left - bounds.left, y: anchor.bottom - bounds.top + 6 } : screenPosition() })
            }
          } })))),
      h('div', { className: 'bp-body' },
        h('aside', { className: 'bp-library', id: `${sidebarId}-library`, hidden: libraryCollapsed, 'aria-label': t('library.ariaLabel') },
          definition && h('label', { className: 'bp-field' }, t('document.name'), h('input', { 'aria-label': t('document.name'), value: definition.name,
            disabled: !editable, onChange: (event: React.ChangeEvent<HTMLInputElement>) => guarded(() => editor.renameDefinition(event.target.value)) })),
          h('h2', null, t('palette.title')), h('input', { 'data-bp-palette-search': true, 'aria-label': t('palette.search'), placeholder: t('palette.placeholder'), value: query, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value) }),
          h('p', { className: 'bp-help bp-palette-hint' }, t('palette.dragHint')),
          ...palette.map(p => {
            const label = t('palette.add', { title: t(p.titleKey) }), disabled = !definition || !editable
            const show = (event: React.SyntheticEvent<HTMLElement>) => setTooltip({ action: `add-${p.kind}`, labelKey: p.descriptionKey, reason: editReason(), anchor: event.currentTarget })
            if (tooltip?.action === `add-${p.kind}`) currentTooltip = { ...tooltip, labelKey: p.descriptionKey, reason: editReason() }
            return h('span', { key: p.kind, className: 'bp-palette-anchor', tabIndex: disabled ? 0 : undefined, role: disabled ? 'group' : undefined,
              'aria-label': disabled ? `${label} · ${reason(editReason())}` : undefined, onMouseEnter: show, onMouseLeave: () => setTooltip(null), onFocus: show, onBlur: () => setTooltip(null) },
              h('button', { type: 'button', className: 'bp-palette-entry', 'data-bp-action': `add-${p.kind}`, 'aria-label': label,
                'aria-describedby': `bp-tooltip-add-${p.kind}`, draggable: !disabled,
                onDragStart: (event: React.DragEvent) => {
                  if (!editable) { event.preventDefault(); return }
                  setTooltip(null); paletteDrag.current = { kind: p.kind, editor, epoch: navigationEpoch.current }
                  event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(PALETTE_DRAG_TYPE, p.kind)
                }, onDragEnd: endPaletteDrag,
                // Pointer users choose a drop point. Native keyboard/AT activation
                // retains the visible-space placement path without requiring a mouse.
                onClick: (event: React.MouseEvent) => { setTooltip(null); if (!event?.detail) guarded(() => add(p.kind)) }, disabled }, blueprintIcon(React, p.kind), h('strong', null, t(p.titleKey))))
          }),
          !palette.length && h('p', { className: 'bp-help' }, t('palette.noMatches')),
          h('section', { 'data-bp-section': 'resources' }, h('h2', null, t('resource.title')), ...Object.entries(definition?.resources ?? {}).map(([id, ref]) => h('details', { key: id, 'data-bp-resource': id },
            h('summary', null, `${resourceDisplayName(id, ref, workspace.resourceCatalog)} · ${resourceKindTitle(ref.kind, t)}`), h('p', { className: 'bp-help' }, ref.source?.kind === 'host' ? `${t('resource.host')} · ${ref.source.id}` : ref.source?.kind === 'shared' ? t('resource.shared', { rootId: ref.source.rootId }) : t('resource.package')),
            h(ResourceJsonField, { key: `${workspace.blueprintId}-${id}`, label: t('resource.edit', { id }), value: ref, t, disabled: !editable, onApply: text => parseResource(text, parsed => guarded(() => editor.updateResource(id, parsed))) }))),
            h('details', null, h('summary', null, t('resource.add')), h('form', { key: workspace.blueprintId, onSubmit: (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const form = new FormData(e.currentTarget); const id = String(form.get('id')); if (!id || Object.hasOwn(definition?.resources ?? {}, id)) { setNotice({ key: 'resource.uniqueIdRequired' }); return } parseResource(String(form.get('ref')), ref => guarded(() => editor.updateResource(id, ref))) } },
              h('input', { name: 'id', placeholder: t('resource.logicalId'), 'aria-label': t('resource.newId'), required: true }), h(JsonEditor, { name: 'ref', label: t('resource.newJson'), t, disabled: !editable, defaultValue: '{"kind":"agent","path":"lib/agents/agent.md"}' }), h('button', { type: 'submit' }, t('resource.add')))))),
        sidebarToggle('library', libraryCollapsed, () => setLibraryCollapsed(value => !value)),
        h('main', { className: 'bp-canvas', 'data-bp-canvas': 'surface', 'data-bp-palette-over': String(paletteOver), 'data-bp-overlay': overlayEligible ? 'eligible' : 'suppressed', tabIndex: 0, 'aria-label': t('canvas.ariaLabel'),
          onDragOver: (event: React.DragEvent) => { if (canDropPalette()) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setPaletteOver(true) } },
          onDragLeave: (event: React.DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setPaletteOver(false) },
          onDrop: (event: React.DragEvent) => {
            const drag = paletteDrag.current
            if (drag && canDropPalette() && event.dataTransfer.getData(PALETTE_DRAG_TYPE) === drag.kind) {
              event.preventDefault(); event.stopPropagation()
              const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false })
              guarded(() => add(drag.kind, position))
            }
            endPaletteDrag()
          },
          onWheelCapture: event => wheelHandler.current?.(event),
          onDoubleClick: (event: React.MouseEvent) => { if (!(event.target as HTMLElement).closest?.('.react-flow__node,.react-flow__edge,.react-flow__controls,.react-flow__minimap')) { event.preventDefault(); openSearch({ x: event.clientX, y: event.clientY }) } } },
          h(ReactFlow<CanvasNode>, { nodes, edges, nodeTypes, edgeTypes, ariaLabelConfig: flowAriaLabels(t), minZoom: 0.1, maxZoom: 3, fitView: false, fitViewOptions: { padding: 0.2 }, deleteKeyCode: null, panOnDrag: spacePan || prefs.mode === 'pan' ? [0, 1] : [1], panActivationKeyCode: 'Space', selectionOnDrag: prefs.mode === 'select' && !spacePan, selectionKeyCode: 'Shift', multiSelectionKeyCode: ['Meta', 'Control'], zoomOnScroll: true, panOnScroll: false, zoomOnPinch: true, zoomOnDoubleClick: false, nodesDraggable: editable, nodesConnectable: editable, edgesReconnectable: editable, reconnectRadius: RECONNECT_ANCHOR_RADIUS, autoPanOnConnect: true, autoPanOnNodeDrag: true, onlyRenderVisibleElements: false,
            onNodeMouseEnter: (_event, node) => { if (workspace.editor === editor && editor.nodes.some(n => n.id === node.id)) setHovered({ editor, id: node.id }) },
            onNodeMouseLeave: (_event, node) => { if (workspace.editor === editor) setHovered(previous => previous?.editor === editor && previous.id === node.id ? null : previous) },
            onNodesChange: changes => {
              if (workspace.editor !== editor) return
              const actual = changes.filter(change => 'id' in change && editor.nodes.some(node => node.id === change.id))
              const gesture = interactions.gesture
              const move = actual.find(change => change.type === 'position' && change.position && gesture?.kind === 'drag' && gesture.positions.has(change.id))
              if (move?.type === 'position' && move.position && gesture?.kind === 'drag') {
                const origin = gesture.positions.get(move.id)!
                guarded(() => interactions.previewDrag(move.position!.x - origin.x, move.position!.y - origin.y))
              }
              // Resize and drag previews are rendered without mutating the draft.
              const transient = actual.filter(change => change.type !== 'position')
              applyCanvasNodeChanges(editor, editable ? transient : transient.filter(change => change.type === 'select' || change.type === 'dimensions'))
              // XYFlow controlled nodes must retain measured dimensions: otherwise a
              // fresh localized data object resets handleBounds in adoptUserNodes.
              // This cache is display-only and never exported by the editor.
              let resized = false
              for (const change of actual) {
                if (change.type !== 'dimensions' || !change.dimensions) continue
                const { width, height } = change.dimensions
                if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue
                const previous = measurements.get(change.id)
                if (previous?.width !== width || previous.height !== height) {
                  measurements.set(change.id, { width, height }); resized = true
                }
              }
              if (resized) setTick(n => n + 1)
            },
            onEdgesChange: changes => { if (workspace.editor === editor) setSelectedEdges(current => applyCanvasEdgeSelection(current, changes)) },
            onNodeDragStart: (event, node) => guarded(() => { interactions.beginDrag(editor.selection.has(node.id) ? [...editor.selection] : [node.id], event.altKey) }),
            onNodeDragStop: event => { if (withinRoot('changedTouches' in event ? event.changedTouches[0] : event)) commitGesture(); else cancelGesture() },
            onSelectionDragStart: event => guarded(() => { interactions.beginDrag([...editor.selection], event.altKey) }),
            onSelectionDragStop: event => { if (withinRoot(event)) commitGesture(); else cancelGesture() }, onSelectionChange: selectionChanged,
            onPaneContextMenu: event => contextMenu('canvas', event),
            onNodeContextMenu: (event, node) => { if (node.type !== 'presentationGroup') contextMenu('node', event, node.id) },
            onEdgeContextMenu: (event, edge) => contextMenu('edge', event, edge.id),
            onEdgeClick: (event, edge) => { if (event.altKey) { event.preventDefault(); guarded(() => { const original = editor.edges.find(e => e.id === edge.id); if (original) interactions.route(edge.id, [...original.points ?? [], graphPosition({ x: event.clientX, y: event.clientY })]) }) } },
            onMoveEnd: (_event, viewport) => {
              if (workspace.editor !== editor || workspace.blueprintId !== viewportContext.id || preferences.current !== viewportContext || !viewportContext.binding) return
              const state = { ...viewportContext.state, viewport }
              const result = viewportContext.binding.write(state)
              if (!result.ok && result.reason === 'stale-context') return
              viewportContext.state = state; setTick(n => n + 1)
            },
            onReconnectStart: (event, edge) => { if (editable) { connectCancelled.current = false; connectOrigin.current = undefined; reconnecting.current = { edgeId: edge.id, copy: 'shiftKey' in event && event.shiftKey } } },
            onReconnect: (edge, connection) => guarded(() => {
              if (connectCancelled.current || reconnecting.current?.edgeId !== edge.id) return
              const { from, to } = connectionPorts(connection)
              if (from && to) { const result = interactions.reconnect(edge.id, from, to, !!reconnecting.current?.copy); setNotice(result.ok ? { key: 'connection.added' } : connectionNotice(result)) }
              else setNotice({ key: 'connection.undeclaredPort' })
            }),
            onReconnectEnd: () => { reconnecting.current = null },
            onConnectStart: (_event, params) => { connectCancelled.current = false; connectOrigin.current = editable && params.nodeId ? portOf(editor, params.nodeId, params.handleId, params.handleType === 'source' ? 'out' : 'in') ?? undefined : undefined },
            isValidConnection: connection => { const { from, to } = connectionPorts(connection); return editable && !!from && !!to && editor.connectionVerdict(from, to, reconnecting.current?.copy ? undefined : reconnecting.current?.edgeId).ok },
            onConnect: connection => guarded(() => { if (connectCancelled.current) return; const { from, to } = connectionPorts(connection); if (from && to) { const result = editor.connect(from, to); setNotice(result.ok ? { key: 'connection.added' } : connectionNotice(result)) } else setNotice({ key: 'connection.undeclaredPort' }) }),
            onConnectEnd: (event, state) => {
              const origin = connectOrigin.current; connectOrigin.current = undefined
              if (connectCancelled.current || reconnecting.current) return
              if (!state.isValid && state.toNode) setNotice({ key: 'connection.incompatible' })
              else if (!state.isValid && origin && editable) {
                const pointer = 'changedTouches' in event ? event.changedTouches[0] : event
                if (pointer && withinRoot(pointer)) openSearch({ x: pointer.clientX, y: pointer.clientY }, origin)
              }
            },
          }, h(Background, { gap: 24, size: 1 }), h(Controls, { showInteractive: false }), prefs.minimap && h(MiniMap, { pannable: true, zoomable: true, nodeColor: 'var(--bp-muted)', nodeClassName: n => n.type === 'presentationGroup' ? 'bp-minimap-group' : '' })),
          !definition && h('div', { className: 'bp-empty' }, h('strong', null, t('canvas.chooseBlueprint')), h('p', null, t('canvas.emptyHelp')))),
        sidebarToggle('inspector', inspectorCollapsed, () => setInspectorCollapsed(value => !value)),
        h('aside', { className: 'bp-inspector', id: `${sidebarId}-inspector`, hidden: inspectorCollapsed, 'aria-label': t('inspector.ariaLabel') }, h('h2', null, t('inspector.title')),
          selectedNode ? h('section', null, h('h3', null, editorNodeDisplayTitle(selectedNode, editor.nodes.indexOf(selectedNode), t)), h('p', { className: 'bp-node-id', title: selectedNode.id }, selectedNode.id), h('p', { className: 'bp-help' }, nodeKindTitle(selectedNode.kind, t)),
            h('fieldset', { className: 'bp-inspector-guard', disabled: !editable }, h(NodeInspector, { key: selectedNode.id, node: selectedNode, disabled: !editable, editor, resources: definition?.resources ?? {}, resourceCatalog: workspace.resourceCatalog, t }))) : h('p', { className: 'bp-help' }, t('inspector.selectNode')),
          h('details', { 'data-bp-section': 'preflight', 'data-bp-disclosure': 'preflight', 'data-bp-preflight': workspace.preflight?.status ?? 'none' },
            h('summary', { 'data-bp-disclosure-toggle': 'preflight' }, h('strong', null, t('preflight.title')), h('span', { 'data-bp-summary-state': workspace.preflight?.status ?? 'none' }, t(`preflight.${workspace.preflight?.status ?? 'none'}`)),
              preflightWarningCount > 0 && h('small', { 'data-bp-summary-warning': 'warning', 'data-bp-preflight-warning-count': preflightWarningCount }, `${t('preflight.warning')} · ${preflightWarningCount}`)),
            workspace.preflight?.code && h('p', { 'data-bp-preflight-code': true }, workspace.preflight.code),
            workspace.preflight?.report && h('p', { 'data-bp-preflight-revision': workspace.preflight.documentRevision }, workspace.preflight.documentRevision),
            h('ul', null, ...(workspace.preflight?.report?.checks ?? []).map((check, index) => h('li', { key: index, 'data-bp-check-status': check.status },
              h('strong', null, t(`preflight.${check.status}`)), ' · ', check.code, ...[check.nodeId, check.resourceId, check.toolName].filter(value => value !== undefined).map(value => ` · ${value}`))))),
          h('details', { 'data-bp-section': 'run', 'data-bp-disclosure': 'run' }, h('summary', { 'data-bp-disclosure-toggle': 'run' }, h('strong', null, t('run.title')), h('span', { 'data-bp-summary-state': snapshot?.state ?? 'none' }, snapshot ? `${snapshot.runId} · ${runStateTitle(snapshot.state, t)}` : t(env.hostLink ? 'run.none' : 'status.hostUnavailable')), workspace.model.connectionState === 'stale' && h('small', null, t('run.stale')),
              ...[...new Set((snapshot?.attempts ?? []).filter(attempt => ['waiting_input', 'failed', 'timed_out', 'recovery_required'].includes(attempt.state)).map(attempt => attempt.state))].map(state => h('small', { key: state, 'data-bp-summary-warning': state }, runStateTitle(state, t)))), h('label', { className: 'bp-field' }, t('run.inputJson'), h(JsonEditor, { key: workspace.blueprintId, 'data-bp-run-input': true, label: t('run.inputJson'), t, value: workspace.inputJson, onChange: text => { workspace.inputJson = text }, rows: 3 })),
            h('form', { key: workspace.blueprintId, onSubmit: (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); const id = String(new FormData(e.currentTarget).get('runId')); if (id) { workspace.runId = id; perform(() => workspace.inspect()) } } }, h('input', { name: 'runId', 'aria-label': t('run.inspectId'), disabled: workspace.busy, placeholder: t('run.existingId') }), h('button', { type: 'submit', 'data-bp-action': 'inspect-run', disabled: workspace.busy }, t('run.inspectReconnect'))),
            h('p', { 'data-bp-run': snapshot?.state ?? 'none' }, snapshot ? `${snapshot.runId} · ${runStateTitle(snapshot.state, t)}` : t(env.hostLink ? 'run.none' : 'status.hostUnavailable')),
            snapshot && h('p', { className: 'bp-run-revision', 'data-bp-run-revision': snapshot.definitionRevision }, h('span', null, t('run.definitionRevision')), ' · ', snapshot.definitionRevision),
            snapshot && !overlayEligible && h('p', { className: 'bp-overlay-notice' }, t('run.overlayUnavailable')),
            h('p', { 'data-bp-connection': workspace.model.connectionState }, t(workspace.model.connectionState === 'stale' ? 'run.stale' : 'run.connected')),
            button('run.retryInspect', 'retry-inspect', () => perform(() => workspace.inspect()), !workspace.runId || workspace.busy),
            snapshot?.attempts.some(a => a.state === 'waiting_input') && h('div', null, button('run.approve', 'approve', () => perform(() => workspace.decide('approve')), workspace.busy), button('run.reject', 'reject', () => perform(() => workspace.decide('reject')), workspace.busy)),
            ...(snapshot?.attempts ?? []).map((a, index) => h('details', { key: `${a.nodeId}-${index}`, 'data-bp-attempt': a.nodeId }, h('summary', null, t('run.attempt', { nodeId: a.nodeId, attempt: a.attempt, state: runStateTitle(a.state, t) })), a.outputJson !== undefined && h('pre', { 'data-bp-output': a.nodeId }, a.outputJson), a.errorCode && h('p', null, a.errorCode), renderAttemptDiagnostics(a.diagnostics, t))),
            h('ol', { className: 'bp-log' }, ...(snapshot?.logTail ?? []).map(log => h('li', { key: log.seq }, `${log.seq} · ${log.kind}`)))))),
      overlay && h(InteractionOverlay, { key: `${workspace.blueprintId}-${overlay.kind}-${overlayEpoch.current}`, React, overlay, root: rootRef, t,
        commands: overlay.kind === 'context-menu' ? contextCommands(overlay.surface, commandFacts()) : [], moreActions, presentationState,
        onCommand: command => { if (workspace.editor === editor && overlayCurrent()) dispatch(command) },
        onAdd: kind => { if (overlay.kind !== 'node-search' || !overlayCurrent()) return; guarded(() => { const id = interactions.add(kind, overlay.position, overlay.origin); if (id) { setSelected(id); closeOverlay() } }) },
        onRename: value => { if (overlay.kind !== 'rename' || !overlayCurrent()) return; guarded(() => { if (overlay.group) editor.renameGroup(overlay.targetId, value); else editor.patchPresentation([overlay.targetId], { title: value }); closeOverlay() }) },
        onClose: closeOverlay, importDisabledReason, importTargets: workspace.catalog.map(item => ({ ...item, nonempty: item.documentRevision !== null || item.blueprintId === workspace.blueprintId && (workspace.dirty || editor.nodes.length > 0 || Object.keys(definition?.resources ?? {}).length > 0) })),
        onImportFile: (id, file) => {
          if (overlay.kind !== 'import' || !overlayCurrent() || workspace.busy || prefs.canvasLocked || composing.current) return
          const binding = overlayBinding.current
          perform(async () => {
            const bytes = new Uint8Array(await file.arrayBuffer())
            if (overlayBinding.current !== binding || !overlayCurrent()) return
            await workspace.importArchive(id, archiveBase64(bytes), id); closeOverlay()
          })
        } }),
      currentTooltip && !overlay && h(WorkspaceTooltip, { React, root: rootRef, content: currentTooltip, t, onClose: () => setTooltip(null) }),
      h('footer', { className: 'bp-status', role: 'status', 'data-bp-status': 'message', 'data-bp-status-key': feedback.key }, message))
  }
  return function BlueprintPanel({ t }: BlueprintLocaleProps) { return h(ReactFlowProvider, null, h(WorkspacePanel, { t })) }
}
