/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import { StyledSelect, ConfirmationDialog } from '../../../../shared/controls/styled-controls.ts'
/** Canvas-first DSH workspace. Translation is a renderer seat, never graph state. */
import React from 'react'
import { projectLayoutCollisions } from '../../logic/graph/layout-collisions.ts'
import { nodeContentMinimum, nodeContentKey } from '../../logic/graph/node-geometry.ts'
import { effectivePortVisibility, connectedPortEdges } from '../../logic/graph/port-visibility.ts'
import { nodeDisplayCapabilities } from '../../logic/graph/node-capabilities.ts'
import { MarkerType } from '@xyflow/react'
import type { Connection, Edge, ReactFlowInstance } from '@xyflow/react'
import type { ResourceRef, GraphNode, PresentationNode, XY } from '../../../../../definition/types.ts'
import { idPattern, isValidResourceRef, resourceRefSchema } from '../../../../../definition/resource-ref.ts'
import { editorNodeDisplayTitle } from '../../logic/graph/graph-editor.ts'
import type { GraphEditor, CanvasPort } from '../../logic/graph/graph-editor.ts'
import { isEditingTarget } from '../../logic/workspace/workspace-controller.ts'
import type { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import type { DraftStorage } from '../../logic/workspace/workspace-controller.ts'
import type { HostLink } from '../../../../adapters/host/remote.ts'
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import { BUILTIN_NODE_CATALOG, nodeKindTitle, searchBuiltinNodes } from '../../logic/graph/node-catalog.ts'
import type { BuiltinNodeKind } from '../../logic/graph/node-catalog.ts'
import { renderAttemptDiagnostics } from '../../../../shared/diagnostics/diagnostics.ts'
import { JsonEditor } from '../../logic/inspector/json-editor.ts'
import { NodeInspector } from '../inspector/inspector-composition.tsx'
import { executableNodeIds, presentationGroupFrames, resourceDisplayName, resourceKindTitle, runStateTitle } from '../../presenters/canvas-presentation.ts'
import { flowEdgeEndpoints } from '../../logic/graph/flow-geometry.ts'
import { CanvasInteractions } from '../../logic/graph/flow-interactions.ts'
import { installCanvasStyles } from '../../../../shared/styles/styles.ts'
import { projectRuntimeMotion } from '../../../../shared/styles/runtime-motion.ts'
import { placePaletteNode, paletteNodeShape, PALETTE_NODE_FOOTPRINT } from '../../logic/graph/node-placement.ts'
import type { PaletteReservation } from '../../logic/graph/node-placement.ts'
export type { HostLink } from '../../../../adapters/host/remote.ts'
import { resolveCanvasShortcut, commandDisabledReason, contextCommands } from '../../../../shared/controls/command-policy.ts'
import type { CanvasCommand, CommandFacts, ContextSurface } from '../../../../shared/controls/command-policy.ts'
import { ViewportStateStore, defaultViewportState } from '../../logic/graph/viewport-state.ts'
import type { ViewportBinding, ViewportState } from '../../logic/graph/viewport-state.ts'
import { InteractionOverlay, archiveBase64, archiveBytes, downloadBlueprint } from '../overlays/interaction-overlays.tsx'
import type { CanvasOverlay } from '../overlays/interaction-overlays.tsx'
import { iconControl } from '../../../compact/logic/compact-chrome.ts'
import type { ChromeControl } from '../../../compact/logic/compact-chrome.ts'
import { WorkspaceTooltip } from '../../../../shared/controls/tooltips.ts'
import type { TooltipContent } from '../../../../shared/controls/tooltips.ts'
import type { MenuAction } from '../../presenters/menu-model.ts'
import { blueprintIcon } from '../../../../shared/icons/icons.ts'
import { resourceConfiguration, resourceDraftFromMetadata, resourceMetadataFromDraft } from '../../logic/resources/resource-details.ts'
import type { OpenExecutionChat } from '../../../conversation/logic/chat-navigation.ts'
import { resourceRows } from '../../logic/resources/resource-library-model.ts'
import type { ResourceLibraryRow } from '../../logic/resources/resource-library-model.ts'
export { resourceRows } from '../../logic/resources/resource-library-model.ts'
import { deriveCommandFacts } from '../../../../shared/controls/command-facts.ts'
import type { usePanelWorkspaceStore } from '../../logic/workspace/panel-workspace-store.ts'
import { presentWorkspace } from '../../presenters/workspace-presenter.ts'
import { panelView } from './panel-view.tsx'
import type { CanvasNode, FlowNode, GroupNode, RouteEdge } from '../canvas/canvas-renderers.tsx'
export { BlueprintEdge, BlueprintNode, PresentationGroup } from '../canvas/canvas-renderers.tsx'
import { CanvasSurface, PALETTE_DRAG_TYPE } from '../canvas/canvas-surface.tsx'
import type { PaletteDragState } from '../canvas/canvas-surface.tsx'
import {
  installInteractionRelease,
  installMotionEnvironment,
  installRootResize,
  installRunObservation,
  installWheelCapture
} from '../../../../adapters/browser/panel-browser-effects.ts'
const RESOURCE_KINDS = ['agent', 'prompt', 'skill', 'schema', 'script', 'mcp', 'subflow'] as const
type ResourceKind = (typeof RESOURCE_KINDS)[number]
const resourceSourceLabel = (row: ResourceLibraryRow, t: BlueprintLocaleProps['t']): string =>
  row.source === 'dsh' ? t('resource.host') : t('resource.blueprint')
const resourceDescriptionLabel = (description: string, t: BlueprintLocaleProps['t']): string => description.trim() || t('resource.noDescription')
const resourceCardTitle = (row: ResourceLibraryRow, t: BlueprintLocaleProps['t']): string => `${row.displayName} - ${resourceSourceLabel(row, t)}`
const resourceConfigurationSourceLabel = (source: ReturnType<typeof resourceConfiguration>['source'], t: BlueprintLocaleProps['t']): string => {
  if (source === 'host') return t('resource.host')
  if (source === 'shared') return t('resource.sharedLabel')
  if (source === 'package') return t('resource.packageLabel')
  return t('resource.unbound')
}
const resourceConfigurationFormatLabel = (format: ResourceRef['format'], t: BlueprintLocaleProps['t']): string | undefined => {
  if (format === 'agent-preset') return t('resource.format.agentPreset')
  if (format === 'mcp-definition') return t('resource.format.mcpDefinition')
  return undefined
}
const EDITABLE_KINDS = new Set<string>(BUILTIN_NODE_CATALOG.map(p => p.kind))
function portOf(editor: GraphEditor, nodeId: string, handle: string | null | undefined, direction: 'in' | 'out'): CanvasPort | null {
  const node = editor.nodes.find(n => n.id === nodeId)
  if (!node || !handle) return null
  const delimiter = handle.indexOf(':')
  const kind = handle.slice(0, delimiter)
  const name = handle.slice(delimiter + 1)
  if (kind === 'control') {
    if (direction === 'out' && name !== 'control' && !node.definition?.branches?.includes(name)) return null
    return { nodeId, port: name, type: 'control', direction, kind }
  }
  const type = (direction === 'out' ? node.outputs : node.inputs)[name]
  return kind === 'data' && type !== undefined ? { nodeId, port: name, type, direction, kind } : null
}
interface PanelNotice {
  key: BlueprintLocaleKey
  params?: Record<string, unknown>
}
export interface PanelEnvironment {
  React?: typeof React
  hostLink: HostLink | undefined
  storage: DraftStorage | undefined
  openSession?: OpenExecutionChat
}
export function WorkspacePanel({
  t,
  env,
  workspace,
  workspaceSnapshot,
  workspaceBinding
}: BlueprintLocaleProps & {
  env: PanelEnvironment
  workspace: BlueprintWorkspace
  workspaceSnapshot: ReturnType<BlueprintWorkspace['getSnapshot']>
  workspaceBinding: ReturnType<typeof usePanelWorkspaceStore>['binding']
}): React.ReactElement {
  const workspaceView = presentWorkspace(workspaceSnapshot)
  const workspaceLease = workspaceBinding.capture(workspaceSnapshot.binding)
  const [, setTick] = React.useState(0)
  const flowRef = React.useRef<ReactFlowInstance<CanvasNode> | null>(null)
  const flowReady = React.useCallback((flow: ReactFlowInstance<CanvasNode> | null) => {
    flowRef.current = flow
    setTick(tick => tick + 1)
  }, [])
  const flow = flowRef.current!
  const [query, setQuery] = React.useState('')
  const [selected, setSelected] = React.useState<string | null>(null)
  const [selectedEdges, setSelectedEdges] = React.useState<string[]>([])
  const [notice, setNotice] = React.useState<PanelNotice | null>(null)
  const [chatUnavailable, setChatUnavailable] = React.useState(false)
  const openChat = (sessionId: string, ownerId?: string) => {
    void Promise.resolve(env.openSession?.(sessionId, ownerId)).then(
      opened => setChatUnavailable(opened !== true),
      () => setChatUnavailable(true)
    )
  }
  const [resourceDialog, setResourceDialog] = React.useState<{
    mode: 'add' | 'edit' | 'view'
    editor: GraphEditor
    blueprintId: string | null
    refId?: string
    id: string
    kind: ResourceRef['kind']
    title: string
    description: string
    source: 'dsh' | 'blueprint'
    availability: 'available' | 'unavailable' | 'unknown'
    json: string
  } | null>(null)
  const [overlay, setOverlay] = React.useState<CanvasOverlay | null>(null)
  const [tooltip, setTooltip] = React.useState<TooltipContent | null>(null)
  const [spacePan, setSpacePan] = React.useState(false)
  const [libraryCollapsed, setLibraryCollapsed] = React.useState(false)
  const [resourceCollapsed, setResourceCollapsed] = React.useState<Partial<Record<'agent' | 'skill' | 'mcp' | 'other', boolean>>>({})
  const [inspectorCollapsed, setInspectorCollapsed] = React.useState(false)
  const [sidebarId] = React.useState(() => `bp-sidebar-${crypto.randomUUID()}`)
  const [paletteOver, setPaletteOver] = React.useState(false)
  const paletteDrag = React.useRef<PaletteDragState | null>(null)
  const composing = React.useRef(false)
  const focusBeforeOverlay = React.useRef<HTMLElement | null>(null)
  const overlayEpoch = React.useRef(0)
  const overlayBinding = React.useRef<{ editor: GraphEditor; blueprintId: string | null } | null>(null)
  const [viewportStore] = React.useState(() => new ViewportStateStore(env.storage))
  const preferences = React.useRef<{ id: string | null; binding: ViewportBinding | null; state: ViewportState }>({
    id: null,
    binding: null,
    state: defaultViewportState()
  })
  const groupPointer = React.useRef<{ x: number; y: number } | null>(null)
  const connectOrigin = React.useRef<CanvasPort | undefined>(undefined)
  const navigationEpoch = React.useRef(0)
  const connectCancelled = React.useRef(false)
  const reconnecting = React.useRef<{ edgeId: string; copy: boolean } | null>(null)
  const resourceDialogTrigger = React.useRef<HTMLElement | null>(null)
  const resourceReturnFocus = React.useRef<{ trigger: HTMLElement | null; editor: GraphEditor; blueprintId: string | null } | null>(null)
  const resourceDialogRef = React.useRef<HTMLDivElement | null>(null)
  const confirmation = React.useRef<{ title: string; description: string; accept: () => void } | null>(null)
  const closeConfirmation = () => {
    confirmation.current = null
    setTick(n => n + 1)
  }
  const requestConfirmation = (title: string, description: string, action: () => void, required = true) => {
    if (!workspaceLease.isCurrent() || workspace.busy || composing.current || confirmation.current) return
    if (!required) {
      action()
      return
    }
    const capturedEditor = workspace.editor,
      capturedId = workspace.blueprintId,
      capturedEpoch = navigationEpoch.current
    const pending = {
      title,
      description,
      accept: () => {
        if (confirmation.current !== pending) return
        closeConfirmation()
        if (
          !workspaceLease.isCurrent() ||
          workspace.busy ||
          composing.current ||
          workspace.editor !== capturedEditor ||
          workspace.blueprintId !== capturedId ||
          navigationEpoch.current !== capturedEpoch
        )
          return
        action()
      }
    }
    confirmation.current = pending
    setTick(n => n + 1)
  }
  React.useEffect(() => {
    if (resourceDialog) {
      resourceDialogRef.current?.focus?.()
      return
    }
    const pending = resourceReturnFocus.current
    resourceReturnFocus.current = null
    if (!pending || pending.editor !== workspace.editor || pending.blueprintId !== workspace.blueprintId) return
    const trigger = pending.trigger
    const current = trigger?.isConnected ? trigger : rootRef.current?.querySelector<HTMLElement>('[data-bp-action="add-resource"]')
    if (current && !(current as HTMLButtonElement).disabled) current.focus()
  }, [resourceDialog?.editor, resourceDialog?.blueprintId, resourceDialog?.refId, resourceDialog?.mode])
  const collisionContext = React.useRef<{ positions: Map<string, XY>; measurements: Map<string, { width: number; height: number }> }>({
    positions: new Map(),
    measurements: new Map()
  })
  const currentContext = React.useRef({
    editor: workspace.editor,
    blueprintId: workspace.blueprintId,
    documentRevision: workspace.document?.documentRevision ?? null,
    busy: workspace.busy,
    locked: false,
    composing: false
  })
  const [interactions] = React.useState(
    () =>
      new CanvasInteractions(() => ({
        ...currentContext.current,
        editor: workspace.editor,
        blueprintId: workspace.blueprintId,
        documentRevision: workspace.document?.documentRevision ?? null,
        busy: workspace.busy,
        locked: preferences.current.state.canvasLocked,
        composing: composing.current,
        displayPositions: collisionContext.current.positions,
        measurements: collisionContext.current.measurements
      }))
  )
  const [motionEnvironment, setMotionEnvironment] = React.useState(() => ({
    visible: typeof document !== 'undefined' && document.visibilityState === 'visible',
    reduced: typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : true
  }))
  const [hovered, setHovered] = React.useState<{ editor: GraphEditor; id: string } | null>(null)
  const [focused, setFocused] = React.useState<{ editor: GraphEditor; id: string } | null>(null)
  React.useEffect(() => {
    return installMotionEnvironment(value =>
      setMotionEnvironment(previous => (previous.visible === value.visible && previous.reduced === value.reduced ? previous : value))
    )
  }, [])
  const rootRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    return installRootResize(rootRef, () => {
      setLibraryCollapsed(true)
      setInspectorCollapsed(true)
    })
  }, [])
  const wheelHandler = React.useRef<((event: React.WheelEvent | WheelEvent) => void) | null>(null)
  React.useEffect(() => {
    // React delegates wheel through a passive listener. Native capture must run
    // first so handled horizontal wheels can also prevent page scrolling.
    return installWheelCapture(rootRef, event => wheelHandler.current?.(event))
  }, [])
  const placementRef = React.useRef<{ editor: GraphEditor; reservations: Map<string, PaletteReservation> } | null>(null)
  React.useEffect(() => {
    installCanvasStyles()
    void workspace.initialize(t('document.newName'))
  }, [workspace])
  React.useEffect(() => {
    return installRunObservation(
      workspace,
      750,
      () => {
        if (!workspace.busy) void workspace.inspect().catch(() => {})
      },
      () => workspace.model.markDisconnected()
    )
  }, [workspace, workspace.runId])
  const editor = workspace.editor
  if (preferences.current.id !== workspace.blueprintId) {
    const binding = workspace.blueprintId ? viewportStore.bind(workspace.blueprintId) : null
    if (!binding) viewportStore.invalidate()
    preferences.current = { id: workspace.blueprintId, binding, state: binding?.state ?? defaultViewportState() }
  }
  const viewportContext = preferences.current
  const prefs = viewportContext.state
  currentContext.current = {
    editor,
    blueprintId: workspace.blueprintId,
    documentRevision: workspace.document?.documentRevision ?? null,
    busy: workspace.busy,
    locked: prefs.canvasLocked,
    composing: composing.current
  }
  React.useEffect(() => {
    const bound = preferences.current
    if (flow && bound.binding?.readStatus === 'restored') void flow.setViewport(bound.state.viewport, { duration: 0 })
    interactions.cancel()
    setOverlay(null)
    setTooltip(null)
    setResourceDialog(null)
    resourceDialogTrigger.current = null
    connectOrigin.current = undefined
    reconnecting.current = null
    setSpacePan(false)
  }, [editor, workspace.blueprintId, flow, interactions])
  React.useEffect(() => {
    if (workspace.busy || prefs.canvasLocked) {
      interactions.cancel()
      setSpacePan(false)
      setTick(n => n + 1)
    }
  }, [workspace.busy, prefs.canvasLocked, interactions])
  React.useEffect(() => {
    const release = () => {
      setSpacePan(false)
      interactions.cancel()
      groupPointer.current = null
      composing.current = false
      setTick(n => n + 1)
    }
    const releaseSpace = (event: KeyboardEvent) => {
      if (event.key === ' ') setSpacePan(false)
    }
    const disposeBrowser = installInteractionRelease(release, releaseSpace)
    return () => {
      disposeBrowser()
      interactions.dispose()
      viewportStore.invalidate()
    }
  }, [interactions, viewportStore])
  const updatePrefs = (patch: Partial<ViewportState>) => {
    const bound = preferences.current,
      state = { ...bound.state, ...patch }
    const result = bound.binding?.write(state)
    if (result && !result.ok && result.reason === 'stale-context') return
    bound.state = state
    setTick(n => n + 1)
  }
  const editable = !!workspace.blueprintId && !workspace.busy && !prefs.canvasLocked && !composing.current
  const withinRoot = (event: { clientX: number; clientY: number } | undefined): boolean => {
    if (!event) return true
    const rect = rootRef.current?.getBoundingClientRect()
    return !rect || (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom)
  }
  const graphPosition = (position?: XY): XY => {
    if (!flow) return { x: 100, y: 100 }
    if (position) return flow.screenToFlowPosition(position)
    const rect = rootRef.current?.querySelector('[data-bp-canvas="surface"]')?.getBoundingClientRect()
    return rect ? flow.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 100, y: 100 }
  }
  const screenPosition = (position?: XY): XY => {
    const rect = rootRef.current?.getBoundingClientRect()
    return position ? { x: position.x - (rect?.left ?? 0), y: position.y - (rect?.top ?? 0) } : { x: Math.max(0, (rect?.width ?? 600) / 2 - 140), y: 64 }
  }
  const closeOverlay = React.useCallback(() => {
    interactions.cancel()
    setOverlay(null)
    overlayBinding.current = null
    const original = focusBeforeOverlay.current
    if (original?.isConnected) original.focus()
    else rootRef.current?.querySelector<HTMLElement>('[data-bp-canvas="surface"]')?.focus()
  }, [interactions])
  const openOverlay = (next: CanvasOverlay) => {
    setTooltip(null)
    if (!overlay) focusBeforeOverlay.current = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement)
    overlayEpoch.current++
    overlayBinding.current = { editor, blueprintId: workspace.blueprintId }
    setOverlay(next)
  }
  const overlayCurrent = () => overlayBinding.current?.editor === workspace.editor && overlayBinding.current.blueprintId === workspace.blueprintId
  const resultNotice = (code: string) => setNotice(code === 'port-hidden' ? { key: 'connection.portHidden' } : { key: 'interaction.result', params: { code } })
  const guarded = (action: () => void): boolean => {
    if (
      workspace.editor !== editor ||
      workspace.blueprintId !== viewportContext.id ||
      !workspace.blueprintId ||
      workspace.busy ||
      preferences.current.state.canvasLocked ||
      composing.current
    )
      return false
    try {
      setNotice(null)
      action()
      setTick(n => n + 1)
      return true
    } catch (error) {
      resultNotice(typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'canvas-command-failed')
      setTick(n => n + 1)
      return false
    }
  }
  const cancelGesture = () => {
    interactions.cancel()
    groupPointer.current = null
    connectOrigin.current = undefined
    reconnecting.current = null
    connectCancelled.current = true
    setTick(n => n + 1)
  }
  const commitGesture = () =>
    guarded(() => {
      interactions.commitGesture()
      setSelected([...editor.selection][0] ?? null)
    })
  const openSearch = (point?: XY, origin?: CanvasPort) => {
    if (!editable) return
    openOverlay({ kind: 'node-search', screen: screenPosition(point), position: graphPosition(point), ...(origin ? { origin } : {}) })
  }
  const rename = (id: string, group = false) => {
    if (!editable) return
    const node = editor.nodes.find(n => n.id === id),
      frame = editor.groups.find(g => g.id === id)
    if (group ? !frame : !node) return
    openOverlay({
      kind: 'rename',
      screen: screenPosition(),
      targetId: id,
      group,
      value: group ? frame!.label : (node!.presentation?.title ?? editorNodeDisplayTitle(node!, editor.nodes.indexOf(node!), t))
    })
  }
  const contextMenu = (surface: ContextSurface, event: React.MouseEvent | MouseEvent, targetId?: string) => {
    event.preventDefault()
    event.stopPropagation()
    if (workspace.editor !== editor || composing.current || !workspace.blueprintId) return
    if (surface === 'node' && targetId && !editor.selection.has(targetId)) {
      editor.setSelection([targetId])
      setSelected(targetId)
      setSelectedEdges([])
    }
    if (surface === 'edge' && targetId && !selectedEdges.includes(targetId)) {
      editor.setSelection([])
      setSelected(null)
      setSelectedEdges([targetId])
    }
    openOverlay({
      kind: 'context-menu',
      surface,
      screen: screenPosition({ x: event.clientX, y: event.clientY }),
      position: graphPosition({ x: event.clientX, y: event.clientY }),
      ...(targetId ? { targetId } : {})
    })
  }
  const measurementsRef = React.useRef<{ editor: GraphEditor; values: Map<string, { width: number; height: number }>; shapes: Map<string, string> } | null>(
    null
  )
  if (measurementsRef.current?.editor !== editor) measurementsRef.current = { editor, values: new Map(), shapes: new Map() }
  const measurements = measurementsRef.current.values
  const selectionChanged = React.useCallback(
    (selection: { nodes: CanvasNode[]; edges: Edge[] }) => {
      if (workspace.editor !== editor) return
      const ids = executableNodeIds(
        editor.nodes,
        selection.nodes.map(n => n.id)
      )
      const edgeIds = selection.edges.map(e => e.id).filter(id => editor.edges.some(edge => edge.id === id))
      editor.setSelection(ids)
      setSelected(current => (current === (ids[0] ?? null) ? current : (ids[0] ?? null)))
      setSelectedEdges(current => (current.length === edgeIds.length && current.every((id, i) => id === edgeIds[i]) ? current : edgeIds))
    },
    [editor, workspace]
  )
  const definition = workspace.definition
  const libraryRows = resourceRows(definition, workspace.resourceCatalog, workspace.resourceCatalogState)
  const snapshot = workspace.model.view
  const overlayEligible = workspace.runOverlayEligible
  const motion = projectRuntimeMotion({
    nodes: definition?.graph.nodes ?? [],
    edges: editor.edges,
    snapshot,
    overlayEligible,
    connectionState: workspace.model.connectionState,
    visible: motionEnvironment.visible,
    reducedMotion: motionEnvironment.reduced,
    userMotion: prefs.motion,
    hoveredNodeId: hovered?.editor === editor ? hovered.id : null,
    focusedNodeId: focused?.editor === editor ? focused.id : null
  })
  // The native bound t keeps its identity on language changes. Derive fresh data
  // every render so memoized custom nodes refresh WITHOUT a provider/editor remount.
  const executableNodes: FlowNode[] = editor.nodes.map((n, index) => {
    const runtime = motion.nodes[index]!
    const state = runtime.state
    const capability = nodeDisplayCapabilities(n.definition ?? n)
    const summary = capability.agentBindings
      ? [n.definition?.agentRef, ...(n.definition?.skillRefs ?? []), ...(n.definition?.toolsetRefs ?? []), n.definition?.outputSchemaRef]
          .filter(ref => ref !== undefined)
          .map(id => resourceDisplayName(id, definition?.resources[id], workspace.resourceCatalog, definition?.presentation?.resources))
          .join(' · ')
      : ''
    const label = editorNodeDisplayTitle(n, index, t)
    const gesture = interactions.gesture
    const dragPosition =
      gesture?.kind === 'drag' && !gesture.clone && gesture.positions.has(n.id)
        ? { x: gesture.positions.get(n.id)!.x + gesture.dx, y: gesture.positions.get(n.id)!.y + gesture.dy }
        : undefined
    const resize = gesture?.kind === 'resize' && gesture.nodeId === n.id ? gesture : undefined
    const size = resize?.size ?? n.presentation
    const visibility = effectivePortVisibility(n, editor.edges)
    const shape = {
      title: `${nodeKindTitle(n.kind, t)} ${label}`,
      summary: capability.agentBindings ? summary || t('node.noResourceBinding') : '',
      state: state === 'idle' ? t('node.notRunning') : runStateTitle(state, t),
      inputs: n.inputs,
      outputs: n.outputs,
      controlOutputs: n.definition?.branches ?? [],
      visibility,
      ...(!EDITABLE_KINDS.has(n.kind) ||
      (['control', 'inputs', 'outputs'] as const).some(side => n.presentation?.ports?.[side] === false && connectedPortEdges(n.id, side, editor.edges))
        ? { note: !EDITABLE_KINDS.has(n.kind) ? t('node.importedKind', { kind: n.kind }) : t('port.connectedVisible') }
        : {})
    }
    const contentKey = nodeContentKey(shape, Math.max(220, size?.width ?? 220))
    if (measurementsRef.current!.shapes.get(n.id) !== contentKey) measurements.delete(n.id)
    measurementsRef.current!.shapes.set(n.id, contentKey)
    const measured = measurements.get(n.id)
    const minHeight = nodeContentMinimum(shape).height
    return {
      draggable: editable && !n.presentation?.pinned,
      connectable: editable,
      style: { width: Math.max(220, size?.width ?? 220), minHeight: Math.max(minHeight, size?.height ?? 0) },
      ...(measured ? { measured } : {}),
      id: n.id,
      type: 'blueprint',
      dragHandle: '.bp-node-title',
      position: resize?.position ?? dragPosition ?? (gesture ? collisionContext.current.positions.get(n.id) : undefined) ?? { x: n.x, y: n.y },
      selected: editor.selection.has(n.id),
      ariaLabel: label,
      data: {
        label,
        kind: n.kind,
        kindTitle: nodeKindTitle(n.kind, t),
        inputs: n.inputs,
        outputs: n.outputs,
        graphEdges: editor.edges,
        summary: capability.agentBindings ? summary || t('node.noResourceBinding') : '',
        runtime,
        state: state === 'idle' ? t('node.notRunning') : state === 'unknown' ? t('node.unknownState') : runStateTitle(state, t),
        branches: n.definition?.branches ?? [],
        t,
        presentation: { ...n.presentation, ...resize?.size },
        editable,
        minHeight,
        contentKey,
        onContentMeasure: height => {
          if (workspace.editor !== editor || measurementsRef.current?.shapes.get(n.id) !== contentKey) return
          const value = { width: Math.max(220, size?.width ?? 220), height: Math.max(minHeight, size?.height ?? 0, height) }
          const old = measurements.get(n.id)
          if (old?.width !== value.width || old.height !== value.height) {
            measurements.set(n.id, value)
            setTick(tick => tick + 1)
          }
        },
        onRename: () => rename(n.id),
        onResizeStart: () =>
          guarded(() => {
            interactions.beginResize(n.id)
          }),
        onResize: size => guarded(() => interactions.previewResize({ width: size.width, height: size.height }, { x: size.x, y: size.y })),
        onResizeEnd: position => {
          if (position && !withinRoot({ clientX: position.x, clientY: position.y })) cancelGesture()
          else commitGesture()
        }
      }
    }
  })
  const collision = projectLayoutCollisions(
    executableNodes.map(node => ({
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      width: node.measured?.width ?? Number(node.style?.width ?? 220),
      height: Math.max(node.data.minHeight, Number(node.style?.minHeight ?? 0), node.measured?.height ?? 0),
      pinned: node.data.presentation.pinned ?? false
    }))
  )
  if (collision.ok && !interactions.gesture) for (const node of executableNodes) node.position = collision.positions.get(node.id)!
  collisionContext.current = { positions: new Map(executableNodes.map(node => [node.id, node.position])), measurements }
  const gesture = interactions.gesture
  const previewNodes =
    gesture?.kind === 'drag' && gesture.clone
      ? executableNodes
          .filter(n => gesture.positions.has(n.id))
          .map(n => ({
            ...n,
            id: `preview-${n.id}`,
            position: { x: n.position.x + gesture.dx, y: n.position.y + gesture.dy },
            selectable: false,
            draggable: false,
            connectable: false,
            data: { ...n.data, editable: false },
            className: 'bp-clone-preview'
          }))
      : []
  const groupPositions = editor.nodes.map(n => {
    const view = executableNodes.find(node => node.id === n.id)!
    return { ...n, x: view.position.x, y: view.position.y }
  })
  const groupNodes: GroupNode[] = presentationGroupFrames(
    editor.groups,
    groupPositions,
    [...measurements].map(([id, measured]) => ({ id, measured }))
  ).map(frame => {
    const label = frame.label || t('group.title')
    return {
      id: frame.id,
      type: 'presentationGroup',
      position: { x: frame.x, y: frame.y },
      measured: { width: frame.width, height: frame.height },
      style: { width: frame.width, height: frame.height },
      zIndex: -1,
      selectable: false,
      selected: false,
      draggable: false,
      deletable: false,
      connectable: false,
      focusable: false,
      data: {
        groupId: frame.groupId,
        label,
        memberCount: frame.nodeIds.length,
        ariaLabel: t('group.ariaLabel', { label }),
        countLabel: t('group.memberCount', { count: frame.nodeIds.length }),
        removeLabel: t('group.removeNamed', { label }),
        removeText: t('group.remove'),
        hint: t('group.presentationOnly'),
        onRemove: () =>
          guarded(() => {
            editor.ungroup(frame.groupId)
          }),
        onMenu: event => contextMenu('group', event, frame.groupId),
        onRename: () => rename(frame.groupId, true),
        onPointerDown: event => {
          if (event.button !== 0 || !editable || isEditingTarget(event.target) || (event.target as HTMLElement).closest?.('button')) return
          event.preventDefault()
          event.stopPropagation()
          guarded(() => {
            if (!interactions.beginDrag(frame.nodeIds, event.altKey)) return
            groupPointer.current = { x: event.clientX, y: event.clientY }
            event.currentTarget.setPointerCapture(event.pointerId)
          })
        },
        onPointerMove: event => {
          if (!groupPointer.current) return
          event.stopPropagation()
          const start = graphPosition(groupPointer.current),
            next = graphPosition({ x: event.clientX, y: event.clientY })
          guarded(() => interactions.previewDrag(next.x - start.x, next.y - start.y))
        },
        onPointerUp: event => {
          if (!groupPointer.current) return
          event.stopPropagation()
          groupPointer.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          if (withinRoot(event)) commitGesture()
          else cancelGesture()
        },
        onPointerCancel: cancelGesture
      }
    }
  })
  const nodes: CanvasNode[] = [...groupNodes, ...executableNodes, ...previewNodes]
  const edges: RouteEdge[] = editor.edges.map((e, index) => ({
    id: e.id,
    ...flowEdgeEndpoints(e),
    type: 'blueprintEdge',
    reconnectable: editable,
    selected: selectedEdges.includes(e.id),
    label: t(e.kind === 'data' ? 'port.data' : 'port.control'),
    className: `bp-edge-${e.kind} nokey`,
    markerEnd: { type: MarkerType.ArrowClosed },
    data: {
      kind: e.kind,
      runtime: motion.edges[index]!,
      points:
        interactions.gesture?.kind === 'route' && interactions.gesture.edgeId === e.id
          ? interactions.gesture.points
          : collision.ok && collision.changed
            ? []
            : (e.points ?? []),
      editable,
      t,
      positionAt: graphPosition,
      onBegin: () => editable && interactions.beginRoute(e.id),
      onPreview: points => guarded(() => interactions.previewRoute(points)),
      onCommit: position => {
        if (withinRoot({ clientX: position.x, clientY: position.y })) commitGesture()
        else cancelGesture()
      },
      onCancel: cancelGesture,
      onPoints: points =>
        guarded(() => {
          interactions.route(e.id, points)
        })
    }
  }))
  const perform = (action: () => Promise<unknown>) => {
    if (!workspaceLease.isCurrent()) return
    setNotice(null)
    void workspaceLease.perform(() => action())
  }
  const button = (key: BlueprintLocaleKey, action: string, onClick: () => void, disabled = false, pressed?: boolean) => (
    <button type={'button'} data-bp-action={action} onClick={onClick} disabled={disabled} aria-pressed={pressed} title={t(key)}>
      {t(key)}
    </button>
  )
  const selectedNode = editor.nodes.find(n => n.id === selected)
  const parseResource = (value: string, callback: (parsed: ResourceRef) => boolean, expectedKind?: ResourceKind): boolean => {
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      setNotice({ key: 'inspector.invalidJsonRetained' })
      return false
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setNotice({ key: 'resource.objectRequired' })
      return false
    }
    const kind = (parsed as { kind?: unknown }).kind
    if (typeof kind !== 'string') {
      setNotice({ key: 'resource.kindRequired' })
      return false
    }
    if (!RESOURCE_KINDS.includes(kind as ResourceKind)) {
      setNotice({ key: 'resource.kindUnknown' })
      return false
    }
    if (expectedKind !== undefined && kind !== expectedKind) {
      setNotice({ key: 'resource.kindMismatch' })
      return false
    }
    if (!resourceRefSchema.safeParse(parsed).success) {
      setNotice({ key: 'resource.invalidReference' })
      return false
    }
    const applied = callback(parsed as ResourceRef)
    if (applied !== false) setNotice({ key: 'inspector.editApplied' })
    return applied !== false
  }
  const closeResourceDialog = () => {
    resourceReturnFocus.current = { trigger: resourceDialogTrigger.current, editor: workspace.editor, blueprintId: workspace.blueprintId }
    resourceDialogTrigger.current = null
    // Responsive resize can hide the still-connected opener. Reveal its sidebar
    // before the post-commit effect restores focus; a microtask cannot focus it.
    setLibraryCollapsed(false)
    if (rootRef.current && rootRef.current.clientWidth <= 780) setInspectorCollapsed(true)
    setResourceDialog(null)
  }
  const openResourceRow = (row: ResourceLibraryRow, trigger?: HTMLElement) => {
    resourceDialogTrigger.current = trigger ?? null
    const metadata = row.refId ? definition?.presentation?.resources?.[row.refId] : undefined
    if (row.ref === undefined || row.refId === undefined) {
      setResourceDialog({
        mode: 'view',
        editor,
        blueprintId: workspace.blueprintId,
        id: row.id,
        kind: row.kind,
        title: row.displayName,
        description: row.description,
        source: row.source,
        availability: row.availability,
        json: JSON.stringify({ kind: row.kind, source: { kind: 'host', id: row.id } }, null, 2)
      })
      return
    }
    const draft = resourceDraftFromMetadata(metadata)
    setResourceDialog({
      mode: editable ? 'edit' : 'view',
      editor,
      blueprintId: workspace.blueprintId,
      refId: row.refId,
      id: row.refId,
      kind: row.kind,
      source: row.source,
      availability: row.availability,
      ...draft,
      json: JSON.stringify(row.ref, null, 2)
    })
  }
  const applyResourceDialog = () => {
    if (!resourceDialog || resourceDialog.mode === 'view') return
    if (resourceDialog.editor !== editor || resourceDialog.blueprintId !== workspace.blueprintId) {
      setNotice({ key: 'resource.editUnavailable' })
      return
    }
    if (resourceDialog.mode === 'add' && (!idPattern.test(resourceDialog.id) || Object.hasOwn(definition?.resources ?? {}, resourceDialog.id))) {
      setNotice({ key: 'resource.uniqueIdRequired' })
      return
    }
    if (
      parseResource(
        resourceDialog.json,
        parsed => {
          const refId = resourceDialog.refId ?? resourceDialog.id
          if (!isValidResourceRef(parsed)) {
            setNotice({ key: 'resource.invalidReference' })
            return false
          }
          const metadata = resourceMetadataFromDraft(resourceDialog.title, resourceDialog.description)
          const applied = guarded(() => editor.updateResource(refId, parsed, metadata))
          if (!applied) setNotice({ key: 'resource.editUnavailable' })
          return applied
        },
        resourceDialog.kind
      )
    )
      setResourceDialog(null)
  }
  const add = (kind: BuiltinNodeKind, position?: XY) => {
    if (!definition || !editable || !flow) return
    if (placementRef.current?.editor !== editor) placementRef.current = { editor, reservations: new Map() }
    const placement = position
      ? { ok: true as const, position, footprint: PALETTE_NODE_FOOTPRINT }
      : placePaletteNode(rootRef.current, flow, editor.nodes, placementRef.current.reservations)
    if (!placement.ok) {
      setNotice({ key: placement.reason === 'no-space' ? 'canvas.noSpace' : 'canvas.measurementsPending' })
      return
    }
    setNotice(null)
    const id = `n-${crypto.randomUUID()}`
    // Generated identities/ports/branches are data, not translated captions.
    const behavior: GraphNode | undefined =
      kind === 'condition'
        ? {
            id,
            kind,
            inputs: { predicate: 'boolean' },
            branches: ['true', 'false'],
            condition: { inputPort: 'predicate', trueBranch: 'true', falseBranch: 'false' }
          }
        : kind === 'join'
          ? { id, kind, join: 'all' }
          : undefined
    let n!: ReturnType<GraphEditor['addNode']>
    editor.transaction(() => {
      n = editor.addNode({
        id,
        kind,
        label: kind,
        ...(behavior === undefined ? {} : { definition: behavior }),
        x: placement.position.x,
        y: placement.position.y,
        inputs: behavior ? (behavior.inputs ?? {}) : kind === 'input' ? {} : { input: 'string' },
        outputs: behavior ? (behavior.outputs ?? {}) : kind === 'output' ? {} : { result: 'string' }
      })
      editor.settleCreatedNodes([id], measurements, collisionContext.current.positions)
    })
    placementRef.current.reservations.set(n.id, { shape: paletteNodeShape(n), footprint: placement.footprint })
    editor.toggleSelect(n.id, false)
    setSelected(n.id)
  }
  const canDropPalette = () => editable && paletteDrag.current?.editor === workspace.editor && paletteDrag.current.epoch === navigationEpoch.current
  const endPaletteDrag = () => {
    paletteDrag.current = null
    setPaletteOver(false)
  }
  const sidebarToggle = (side: 'library' | 'inspector', collapsed: boolean, toggle: () => void) => {
    const label = t(`sidebar.${side}.${collapsed ? 'expand' : 'collapse'}`)
    return (
      <div className={`bp-sidebar-rail bp-sidebar-rail-${side}`}>
        <button
          type={'button'}
          className={'bp-sidebar-toggle'}
          data-bp-action={`toggle-${side}`}
          aria-label={label}
          title={label}
          aria-expanded={!collapsed}
          aria-controls={`${sidebarId}-${side}`}
          onClick={() => {
            setTooltip(null)
            if (collapsed && rootRef.current && rootRef.current.clientWidth <= 780) {
              if (side === 'library') setInspectorCollapsed(true)
              else setLibraryCollapsed(true)
            }
            toggle()
          }}
        >
          {blueprintIcon(React, (side === 'library') === collapsed ? 'chevron' : 'chevron-left')}
        </button>
      </div>
    )
  }
  const targetGroup = overlay?.kind === 'context-menu' && overlay.surface === 'group' ? editor.groups.find(g => g.id === overlay.targetId) : undefined
  const commandFacts = (canvasFocused = true): CommandFacts => {
    const current = workspace.editor
    return deriveCommandFacts({
      editor: current,
      targetGroupId: overlay?.kind === 'context-menu' && overlay.surface === 'group' ? overlay.targetId : undefined,
      selectedEdges: selectedEdges.length,
      canvasFocused,
      hasDefinition: !!workspace.blueprintId,
      busy: workspace.busy,
      canvasLocked: preferences.current.state.canvasLocked,
      canPaste: typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function',
      canRun: !!workspace.host && !!workspace.blueprintId,
      canCancel: !!workspace.runId,
      canOpen: !!workspace.host?.importDefinition,
      canRefreshDefinitions: !!workspace.host
    })
  }
  const dispatch = (command: CanvasCommand) => {
    if (composing.current || commandDisabledReason(command, commandFacts())) return
    const menu = overlay?.kind === 'context-menu' ? overlay : undefined
    const position = menu?.position ?? graphPosition()
    const ids = targetGroup ? targetGroup.nodeIds : [...editor.selection]
    if (command === 'search') {
      openSearch(
        menu
          ? {
              x: menu.screen.x + (rootRef.current?.getBoundingClientRect().left ?? 0),
              y: menu.screen.y + (rootRef.current?.getBoundingClientRect().top ?? 0)
            }
          : undefined
      )
      return
    }
    if (command === 'rename') {
      if (targetGroup) rename(targetGroup.id, true)
      else if (ids[0]) rename(ids[0])
      return
    }
    if (command === 'open') {
      openOverlay({ kind: 'import', screen: screenPosition() })
      return
    }
    if (command === 'copy' || command === 'cut' || command === 'paste' || command === 'paste-with-incoming') {
      if (targetGroup) editor.setSelection(targetGroup.nodeIds)
      // Close before capturing the async generation; closing later cancels it.
      if (menu) closeOverlay()
      void interactions.clipboard(command, typeof navigator === 'undefined' ? undefined : navigator.clipboard, position).then(result => {
        if (result.code === 'clipboard-stale') return
        resultNotice(result.code)
        setSelected([...workspace.editor.selection][0] ?? null)
        setTick(n => n + 1)
      })
      return
    }
    if (menu) closeOverlay()
    if (command === 'save') {
      perform(() => workspace.save())
      return
    }
    if (command === 'run') {
      perform(() => workspace.run())
      return
    }
    if (command === 'cancel') {
      perform(() => workspace.cancel())
      return
    }
    if (command === 'refresh-definitions') {
      perform(() => workspace.initialize())
      return
    }
    if (command === 'pan-start') {
      setSpacePan(true)
      return
    }
    if (command === 'toggle-minimap') {
      updatePrefs({ minimap: !preferences.current.state.minimap })
      return
    }
    if (command === 'lock-canvas' || command === 'unlock-canvas') {
      cancelGesture()
      updatePrefs({ canvasLocked: command === 'lock-canvas' })
      return
    }
    if (command === 'fit-view' || command === 'fit-selection') {
      if (!flow) return
      void flow.fitView({ duration: 0, padding: 0.2, ...(command === 'fit-selection' ? { nodes: ids.map(id => ({ id })) } : {}) })
      return
    }
    if (command === 'zoom-in' || command === 'zoom-out') {
      if (!flow) return
      void (command === 'zoom-in' ? flow.zoomIn({ duration: 0 }) : flow.zoomOut({ duration: 0 }))
      return
    }
    if (command === 'select-all') {
      editor.setSelection(editor.nodes.map(n => n.id))
      setSelected(editor.nodes[0]?.id ?? null)
      return
    }
    if (command === 'clear-selection') {
      cancelGesture()
      editor.setSelection([])
      setSelected(null)
      setSelectedEdges([])
      return
    }
    guarded(() => {
      if (command === 'undo' || command === 'redo') {
        cancelGesture()
        editor[command]()
        setSelected(null)
        setSelectedEdges([])
      } else if (command === 'delete') {
        editor.transaction(() => editor.deleteItems(ids, selectedEdges))
        setSelected(null)
        setSelectedEdges([])
      } else if (command === 'group') editor.groupSelection('')
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
        editor.transaction(() => {
          for (const n of editor.nodes) if (ids.includes(n.id) && !n.presentation?.pinned) editor.moveNode(n.id, n.x + dx, n.y + dy)
        })
      } else if (command === 'disconnect') {
        const edges = editor.edges.filter(e => selectedEdges.includes(e.id) || ids.includes(e.from.split(/[.@]/)[0]!) || ids.includes(e.to.split(/[.@]/)[0]!))
        editor.transaction(() =>
          editor.deleteItems(
            [],
            edges.map(e => e.id)
          )
        )
        setSelectedEdges([])
      } else if (command === 'reroute') {
        editor.transaction(() => {
          for (const id of selectedEdges) {
            const edge = editor.edges.find(e => e.id === id)
            if (edge) edge.points = [...(edge.points ?? []), position]
          }
        })
      }
    })
  }
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (overlay || confirmation.current) return
    if (event.key === 'Escape' && tooltip) {
      setTooltip(null)
      return
    }
    const target = event.target as HTMLElement
    if (
      target?.closest?.(
        '.bp-select, [role=listbox], [role=dialog], [data-bp-reroute], [data-bp-overlay=more-menu], summary, [data-bp-overlay=context-menu], [data-bp-overlay=node-search], [data-bp-overlay=rename], [data-bp-overlay=shortcuts], [data-bp-overlay=import], button, a, [role=button], .react-flow__controls, .react-flow__minimap'
      )
    )
      return
    const focused = !!target?.closest?.('[data-bp-canvas="surface"]')
    const result = resolveCanvasShortcut(
      {
        key: event.key,
        target,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        isComposing: composing.current || event.nativeEvent?.isComposing,
        keyCode: event.keyCode,
        defaultPrevented: event.defaultPrevented
      },
      commandFacts(focused)
    )
    if (result.preventDefault) {
      event.preventDefault()
      event.stopPropagation?.()
    }
    if (result.kind === 'command') dispatch(result.command)
    else if (result.kind === 'disabled' && result.command === 'open') setNotice({ key: `interaction.disabled.${result.reason}` })
  }
  const connectionPorts = (connection: Connection | Edge) => ({
    from: portOf(editor, connection.source, connection.sourceHandle, 'out'),
    to: portOf(editor, connection.target, connection.targetHandle, 'in')
  })
  wheelHandler.current = (event: React.WheelEvent | WheelEvent) => {
    if (
      workspace.editor !== editor ||
      event.ctrlKey ||
      event.metaKey ||
      Math.abs(event.deltaX) <= Math.abs(event.deltaY) ||
      isEditingTarget(event.target) ||
      (event.target as HTMLElement).closest?.('.bp-select,.bp-confirm-dialog,.bp-resource-dialog,.nowheel,.react-flow__controls,.react-flow__minimap')
    )
      return
    // Leave vertical wheels and ctrl/pinch to XYFlow's native zoom handler.
    event.preventDefault()
    event.stopPropagation()
    if (!flow) return
    const current = flow.getViewport(),
      scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (rootRef.current?.clientWidth ?? 600) : 1
    void flow.setViewport({ x: current.x - event.deltaX * scale, y: current.y - event.deltaY * scale, zoom: current.zoom }, { duration: 0 })
  }
  const palette = searchBuiltinNodes(query, t)
  const importDisabledReason = commandDisabledReason('open', commandFacts())
  const reason = (key: BlueprintLocaleKey | null) => (key ? t(key) : null)
  const editReason = () =>
    !workspace.blueprintId
      ? ('interaction.disabled.no-definition' as const)
      : workspace.busy
        ? ('interaction.disabled.busy' as const)
        : preferences.current.state.canvasLocked
          ? ('interaction.disabled.canvas-locked' as const)
          : null
  const hostReason = () =>
    !workspace.blueprintId ? ('interaction.disabled.no-definition' as const) : workspace.busy ? ('interaction.disabled.busy' as const) : null
  let currentTooltip: TooltipContent | null = null
  const chrome = (control: ChromeControl) => {
    if (tooltip?.action === control.action) currentTooltip = { ...tooltip, labelKey: control.labelKey, shortcut: control.shortcut, reason: control.reason }
    return iconControl(React, t, control, setTooltip)
  }
  const moreAction = (
    action: MenuAction['action'],
    group: MenuAction['group'],
    labelKey: BlueprintLocaleKey,
    icon: string,
    blocked: () => BlueprintLocaleKey | null,
    onSelect: () => void,
    shortcut?: string,
    pressed?: boolean
  ): MenuAction => ({
    action,
    group,
    labelKey,
    icon,
    enabled: blocked() === null,
    reason: reason(blocked()),
    shortcut,
    pressed,
    onSelect: () => {
      if (workspace.editor !== editor || !overlayCurrent() || composing.current || blocked()) return
      closeOverlay()
      onSelect()
    }
  })
  const moreActions: MenuAction[] = [
    moreAction(
      'import-blueprint',
      'files',
      'interaction.import-blueprint',
      'import',
      () => {
        const denied = commandDisabledReason('open', commandFacts())
        return denied ? `interaction.disabled.${denied}` : null
      },
      () => openOverlay({ kind: 'import', screen: screenPosition() }),
      'Ctrl / ⌘ O'
    ),
    moreAction(
      'export-blueprint',
      'files',
      'interaction.export-blueprint',
      'export',
      () => hostReason() ?? (!workspace.host?.exportDefinition ? 'compact.exportUnavailable' : null),
      () =>
        perform(async () => {
          const archive = await workspace.exportArchive()
          downloadBlueprint(archiveBytes(archive.archiveBase64), `${archive.blueprintId}.zip`, 'application/zip')
        })
    ),
    moreAction(
      'motion-toggle',
      'view',
      'interaction.motion-toggle',
      'motion',
      () => null,
      () => updatePrefs({ motion: preferences.current.state.motion === 'on' ? 'off' : 'on' }),
      undefined,
      prefs.motion === 'on'
    ),
    moreAction(
      'toggle-minimap',
      'view',
      'compact.minimap',
      'minimap',
      () => null,
      () => updatePrefs({ minimap: !preferences.current.state.minimap }),
      'M',
      prefs.minimap
    ),
    moreAction('check-run', 'tools', 'preflight.check', 'check', hostReason, () => perform(() => workspace.checkRun())),
    moreAction(
      'refresh-library',
      'tools',
      'library.refresh',
      'refresh',
      () => (workspace.busy ? 'interaction.disabled.busy' : null),
      () => perform(() => workspace.initialize())
    ),
    moreAction(
      'shortcuts',
      'tools',
      'interaction.shortcuts',
      'keyboard',
      () => null,
      () => openOverlay({ kind: 'shortcuts', screen: screenPosition() })
    )
  ]
  const selectedForToggle = [...editor.selection].map(id => editor.nodes.find(node => node.id === id))
  const presentationState = {
    allPinned: selectedForToggle.length > 0 && selectedForToggle.every(node => node?.presentation?.pinned),
    allCollapsed: selectedForToggle.length > 0 && selectedForToggle.every(node => node?.presentation?.collapsed)
  }
  const preflightWarningCount = workspaceView.preflight.warningCount
  const feedback = notice ?? workspaceView.notice
  const feedbackParams = 'params' in feedback ? feedback.params : undefined
  const message = t(
    feedback.key,
    feedback.key === 'status.runAdmitted' && feedbackParams && 'state' in feedbackParams
      ? { ...feedbackParams, state: runStateTitle(String(feedbackParams.state), t) }
      : feedbackParams
  )
  let activeResourceRef: ResourceRef | undefined
  if (resourceDialog?.refId) activeResourceRef = definition?.resources?.[resourceDialog.refId]
  if (!activeResourceRef && resourceDialog) {
    try {
      const parsed = resourceRefSchema.safeParse(JSON.parse(resourceDialog.json))
      if (parsed.success) activeResourceRef = parsed.data as ResourceRef
    } catch {
      /* The advanced draft remains visible while invalid. */
    }
  }
  const activeResourceConfiguration = resourceDialog ? resourceConfiguration(activeResourceRef, resourceDialog.id) : undefined
  return panelView(React, {
    rootProps: {
      ref: rootRef,
      className: 'bp-workspace',
      'aria-label': t('panel.ariaLabel'),
      'data-bp-canvas': 'root',
      'data-bp-blueprint': workspace.blueprintId ?? '',
      'data-bp-mode': prefs.mode,
      'data-bp-motion': prefs.motion,
      'data-bp-canvas-locked': String(prefs.canvasLocked),
      onKeyDown: keyDown,
      onKeyDownCapture: keyDown,
      onKeyUp: (e: React.KeyboardEvent) => {
        if (e.key === ' ') setSpacePan(false)
      },
      'data-bp-motion-visible': String(motionEnvironment.visible),
      'data-bp-motion-reduced': String(motionEnvironment.reduced),
      'data-bp-motion-loops': String(motion.loopsAllowed),
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
      onPointerCancel: cancelGesture,
      onCompositionStart: () => {
        composing.current = true
        cancelGesture()
      },
      onCompositionEnd: () => {
        composing.current = false
      },
      tabIndex: -1
    },
    children: [
      <header key={'toolbar'} className={'bp-toolbar'}>
        <div className={'bp-blueprint-picker'}>
          <StyledSelect
            React={React}
            data-bp-select={'blueprint'}
            aria-label={t('library.configuredBlueprint')}
            disabled={workspace.busy}
            value={workspace.blueprintId ?? ''}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
              const requestedId = e.target.value
              requestConfirmation(
                t('dialog.discardTitle'),
                t('document.discardConfirm'),
                () => {
                  const epoch = ++navigationEpoch.current
                  setResourceDialog(null)
                  perform(async () => {
                    await workspace.load(requestedId)
                    if (epoch !== navigationEpoch.current || workspace.blueprintId !== requestedId) return
                    const loadedEditor = workspace.editor,
                      binding = viewportStore.bind(requestedId)
                    const captured = { id: requestedId, binding, state: binding.state }
                    preferences.current = captured
                    setSelected(null)
                    setSelectedEdges([])
                    setTick(n => n + 1)
                    requestAnimationFrame(() => {
                      if (
                        epoch !== navigationEpoch.current ||
                        workspace.editor !== loadedEditor ||
                        workspace.blueprintId !== requestedId ||
                        preferences.current !== captured
                      )
                        return
                      const currentFlow = flowRef.current
                      if (!currentFlow) return
                      if (binding.readStatus === 'restored') void currentFlow.setViewport(binding.state.viewport, { duration: 0 })
                      else void currentFlow.fitView({ duration: 0, padding: 0.2 })
                    })
                  })
                },
                workspace.needsNavigationConfirmation
              )
            }}
          >
            <option value={''} disabled={true}>
              {t('library.chooseId')}
            </option>
            {workspace.isNewDraft && <option value={workspace.blueprintId!}>{t('document.newDraft')}</option>}
            {workspace.catalog.map(d => (
              <option value={d.blueprintId} key={d.blueprintId}>{`${d.name} · ${d.blueprintId}`}</option>
            ))}
          </StyledSelect>
        </div>
        <button
          type={'button'}
          data-bp-action={'new-blueprint'}
          disabled={workspace.busy}
          onClick={() => {
            requestConfirmation(
              t('action.newBlueprint'),
              t('document.newConfirm'),
              () => {
                navigationEpoch.current++
                setResourceDialog(null)
                closeOverlay()
                setNotice(null)
                setSelected(null)
                setSelectedEdges([])
                workspaceLease.dispatch({ type: 'new-draft', name: t('document.newName') })
              },
              workspace.needsNavigationConfirmation
            )
          }}
        >
          {t('action.newBlueprint')}
        </button>
        <button
          type={'button'}
          data-bp-action={'delete-blueprint'}
          disabled={workspace.busy || !workspace.blueprintId || (!workspace.isNewDraft && !workspace.document)}
          onClick={() => {
            requestConfirmation(
              t('action.deleteBlueprint'),
              t(workspace.isNewDraft ? 'document.deleteDraftConfirm' : 'document.deleteConfirm', { name: workspace.definition?.name ?? '' }),
              () => {
                const epoch = ++navigationEpoch.current
                setResourceDialog(null)
                closeOverlay()
                perform(async () => {
                  await workspace.deleteCurrent(t('document.newName'))
                  if (epoch !== navigationEpoch.current) return
                  setNotice(null)
                  setSelected(null)
                  setSelectedEdges([])
                })
              }
            )
          }}
        >
          {t('action.deleteBlueprint')}
        </button>
        <span className={'bp-revision'} data-bp-dirty={String(workspace.dirty)}>
          {t(workspace.dirty ? 'document.unsaved' : workspace.isNewDraft ? 'document.newDraft' : workspace.document ? 'document.saved' : 'document.none')}
        </span>
        <div className={'bp-toolbar-actions'}>
          <div
            className={'bp-toolbar-group'}
            data-bp-toolbar-group={'history'}
            role={'group'}
            aria-label={t('action.undo') + ' / ' + t('action.redo') + ' / ' + t('action.save')}
          >
            {chrome({
              action: 'undo',
              labelKey: 'action.undo',
              icon: 'undo',
              shortcut: 'Ctrl / ⌘ Z',
              reason: editReason() ?? (!editor.canUndo ? 'interaction.disabled.history-unavailable' : null),
              onClick: () => dispatch('undo')
            })}
            {chrome({
              action: 'redo',
              labelKey: 'action.redo',
              icon: 'redo',
              shortcut: 'Ctrl / ⌘ Shift Z · Ctrl Y',
              reason: editReason() ?? (!editor.canRedo ? 'interaction.disabled.history-unavailable' : null),
              onClick: () => dispatch('redo')
            })}
            {chrome({
              action: 'save-layout',
              labelKey: 'action.save',
              icon: 'save',
              shortcut: 'Ctrl / ⌘ S',
              reason: hostReason(),
              onClick: () => perform(() => workspace.save())
            })}
          </div>
          <div
            className={'bp-toolbar-group'}
            data-bp-toolbar-group={'mode'}
            role={'group'}
            aria-label={t('interaction.mode-pan') + ' / ' + t('interaction.mode-select')}
          >
            {chrome({
              action: 'mode-pan',
              labelKey: 'interaction.mode-pan',
              icon: 'pan',
              shortcut: 'Space',
              pressed: prefs.mode === 'pan',
              onClick: () => updatePrefs({ mode: 'pan' })
            })}
            {chrome({
              action: 'mode-select',
              labelKey: 'interaction.mode-select',
              icon: 'select',
              pressed: prefs.mode === 'select',
              onClick: () => updatePrefs({ mode: 'select' })
            })}
          </div>
          <div className={'bp-toolbar-group'} data-bp-toolbar-group={'run-tools'} role={'group'} aria-label={t('run.title') + ' / ' + t('compact.more')}>
            {chrome({
              action: 'start-run',
              labelKey: 'action.run',
              icon: 'run',
              shortcut: 'Ctrl / ⌘ Enter',
              reason: hostReason(),
              onClick: () => perform(() => workspace.run())
            })}
            {chrome({
              action: 'cancel-run',
              labelKey: 'run.cancel',
              icon: 'cancel',
              shortcut: 'Ctrl / ⌘ Alt Enter',
              reason: workspace.busy ? 'interaction.disabled.busy' : !workspace.runId ? 'interaction.disabled.cancel-unavailable' : null,
              onClick: () => perform(() => workspace.cancel())
            })}
            {chrome({
              action: 'more-actions',
              labelKey: 'compact.more',
              icon: 'more',
              menu: true,
              expanded: overlay?.kind === 'more-menu',
              onClick: event => {
                if (overlay?.kind === 'more-menu') closeOverlay()
                else {
                  const anchor = event?.currentTarget?.getBoundingClientRect(),
                    bounds = rootRef.current?.getBoundingClientRect()
                  openOverlay({
                    kind: 'more-menu',
                    screen: anchor && bounds ? { x: anchor.left - bounds.left, y: anchor.bottom - bounds.top + 6 } : screenPosition()
                  })
                }
              }
            })}
          </div>
        </div>
      </header>,
      <div key={'body'} className={'bp-body'}>
        <aside className={'bp-library'} id={`${sidebarId}-library`} hidden={libraryCollapsed} aria-label={t('library.ariaLabel')}>
          {definition && (
            <label className={'bp-field'}>
              {t('document.name')}
              <input
                aria-label={t('document.name')}
                value={definition.name}
                disabled={!editable}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => guarded(() => editor.renameDefinition(event.target.value))}
              />
            </label>
          )}
          <h2>{t('palette.title')}</h2>
          <input
            data-bp-palette-search={true}
            aria-label={t('palette.search')}
            placeholder={t('palette.placeholder')}
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          />
          <p className={'bp-help bp-palette-hint'}>{t('palette.dragHint')}</p>
          {palette.map(p => {
            const label = t('palette.add', { title: t(p.titleKey) }),
              disabled = !definition || !editable
            const show = (event: React.SyntheticEvent<HTMLElement>) =>
              setTooltip({ action: `add-${p.kind}`, labelKey: p.descriptionKey, reason: editReason(), anchor: event.currentTarget })
            if (tooltip?.action === `add-${p.kind}`) currentTooltip = { ...tooltip, labelKey: p.descriptionKey, reason: editReason() }
            return (
              <span
                key={p.kind}
                className={'bp-palette-anchor'}
                tabIndex={disabled ? 0 : undefined}
                role={disabled ? 'group' : undefined}
                aria-label={disabled ? `${label} · ${reason(editReason())}` : undefined}
                onMouseEnter={show}
                onMouseLeave={() => setTooltip(null)}
                onFocus={show}
                onBlur={() => setTooltip(null)}
              >
                <button
                  type={'button'}
                  className={'bp-palette-entry'}
                  data-bp-action={`add-${p.kind}`}
                  aria-label={label}
                  aria-describedby={`bp-tooltip-add-${p.kind}`}
                  draggable={!disabled}
                  onDragStart={(event: React.DragEvent) => {
                    if (!editable) {
                      event.preventDefault()
                      return
                    }
                    setTooltip(null)
                    paletteDrag.current = { kind: p.kind, editor, epoch: navigationEpoch.current }
                    event.dataTransfer.effectAllowed = 'copy'
                    event.dataTransfer.setData(PALETTE_DRAG_TYPE, p.kind)
                  }}
                  onDragEnd={endPaletteDrag}
                  onClick={(event: React.MouseEvent) => {
                    setTooltip(null)
                    if (!event?.detail) guarded(() => add(p.kind))
                  }}
                  disabled={disabled}
                >
                  {blueprintIcon(React, p.kind)}
                  <strong>{t(p.titleKey)}</strong>
                </button>
              </span>
            )
          })}
          {!palette.length && <p className={'bp-help'}>{t('palette.noMatches')}</p>}
          <section data-bp-section={'resources'}>
            <div className={'bp-resource-heading'}>
              <h2>{t('resource.title')}</h2>
              <button
                type={'button'}
                className={'bp-resource-add'}
                data-bp-action={'add-resource'}
                aria-label={t('resource.openEditor')}
                title={t('resource.openEditor')}
                disabled={!editable}
                onClick={(event?: React.MouseEvent<HTMLButtonElement>) => {
                  setTooltip(null)
                  resourceDialogTrigger.current = event?.currentTarget ?? null
                  setResourceDialog({
                    mode: 'add',
                    editor,
                    blueprintId: workspace.blueprintId,
                    id: '',
                    kind: 'agent',
                    title: '',
                    description: '',
                    source: 'blueprint',
                    availability: 'available',
                    json: '{"kind":"agent","path":"lib/agents/agent.md"}'
                  })
                }}
              >
                {'+'}
              </button>
            </div>
            {(['agent', 'skill', 'mcp', 'other'] as const).map(category => {
              const rows = libraryRows[category]
              const label = category === 'other' ? t('resource.other') : resourceKindTitle(category, t)
              const collapsed = resourceCollapsed[category] === true,
                contentId = `${sidebarId}-resources-${category}`
              return (
                <div key={category} data-bp-resource-category={category} className={'bp-resource-category'}>
                  <h3>
                    <button
                      type={'button'}
                      className={'bp-resource-toggle'}
                      data-bp-resource-toggle={category}
                      aria-expanded={!collapsed}
                      aria-controls={contentId}
                      onClick={() => {
                        setTooltip(null)
                        setResourceCollapsed(current => ({ ...current, [category]: !current[category] }))
                      }}
                    >
                      <span>{`${label} (${rows.length})`}</span>
                      <svg
                        viewBox={'0 0 24 24'}
                        width={16}
                        height={16}
                        fill={'none'}
                        stroke={'currentColor'}
                        strokeWidth={1.6}
                        strokeLinecap={'round'}
                        strokeLinejoin={'round'}
                        aria-hidden={true}
                        focusable={false}
                        data-bp-expanded={!collapsed}
                      >
                        <path d={'m9 5 7 7-7 7'} />
                      </svg>
                    </button>
                  </h3>
                  <div id={contentId} hidden={collapsed}>
                    {rows.length ? (
                      rows.map(row => {
                        const title = resourceCardTitle(row, t),
                          description = resourceDescriptionLabel(row.description, t),
                          tooltipAction = `resource-${row.key}`,
                          showDescription = (event: React.SyntheticEvent<HTMLButtonElement>) =>
                            setTooltip({ action: tooltipAction, labelKey: 'resource.noDescription', text: description, anchor: event.currentTarget })
                        if (tooltip?.action === tooltipAction) currentTooltip = { ...tooltip, labelKey: 'resource.noDescription', text: description }
                        return (
                          <button
                            type={'button'}
                            key={row.key}
                            className={'bp-resource-row'}
                            data-bp-resource-row={row.key}
                            aria-label={`${title} · ${description}`}
                            aria-describedby={`bp-tooltip-${tooltipAction}`}
                            onClick={(event?: React.MouseEvent<HTMLButtonElement>) => {
                              setTooltip(null)
                              openResourceRow(row, event?.currentTarget)
                            }}
                            onMouseEnter={showDescription}
                            onMouseLeave={() => setTooltip(null)}
                            onFocus={showDescription}
                            onBlur={() => setTooltip(null)}
                          >
                            <strong className={'bp-resource-title'} data-bp-resource-title={true}>
                              {title}
                            </strong>
                            <span className={'bp-resource-description'} data-bp-resource-description={true}>
                              {description}
                            </span>
                            <span className={'bp-resource-meta'}>{resourceKindTitle(row.kind, t)}</span>
                            <small className={'bp-resource-status'}>
                              {row.availability === 'available'
                                ? t('resource.available')
                                : row.availability === 'unknown'
                                  ? t('resource.availabilityUnchecked')
                                  : t('resource.unavailable')}
                            </small>
                          </button>
                        )
                      })
                    ) : (
                      <p className={'bp-help'}>{'—'}</p>
                    )}
                  </div>
                </div>
              )
            })}
          </section>
        </aside>
        {sidebarToggle('library', libraryCollapsed, () => setLibraryCollapsed(value => !value))}
        {CanvasSurface({
          t,
          paletteOver,
          overlayEligible,
          canDropPalette,
          add,
          setPaletteOver,
          paletteDrag,
          flow,
          endPaletteDrag,
          wheelHandler,
          openSearch,
          collision,
          editable,
          editor,
          measurements,
          guarded,
          workspaceSnapshot,
          flowReady,
          nodes,
          edges,
          prefs,
          spacePan,
          interactions,
          workspace,
          setHovered,
          setSelectedEdges,
          setTick,
          withinRoot,
          commitGesture,
          cancelGesture,
          selectionChanged,
          contextMenu,
          graphPosition,
          viewportContext,
          preferences,
          connectCancelled,
          connectOrigin,
          reconnecting,
          connectionPorts,
          setNotice,
          portOf,
          definition
        })}
        {sidebarToggle('inspector', inspectorCollapsed, () => setInspectorCollapsed(value => !value))}
        <aside className={'bp-inspector'} id={`${sidebarId}-inspector`} hidden={inspectorCollapsed} aria-label={t('inspector.ariaLabel')}>
          <h2>{t('inspector.title')}</h2>
          {selectedNode ? (
            <section>
              <h3>{editorNodeDisplayTitle(selectedNode, editor.nodes.indexOf(selectedNode), t)}</h3>
              <p className={'bp-node-id'} title={selectedNode.id}>
                {selectedNode.id}
              </p>
              <p className={'bp-help'}>{nodeKindTitle(selectedNode.kind, t)}</p>
              <fieldset className={'bp-inspector-guard'} disabled={!editable}>
                <NodeInspector
                  key={selectedNode.id}
                  node={selectedNode}
                  disabled={!editable}
                  editor={editor}
                  resources={definition?.resources ?? {}}
                  resourceCatalog={workspace.resourceCatalog}
                  t={t}
                />
              </fieldset>
            </section>
          ) : (
            <p className={'bp-help'}>{t('inspector.selectNode')}</p>
          )}
          <details data-bp-section={'preflight'} data-bp-disclosure={'preflight'} data-bp-preflight={workspaceView.preflight.status}>
            <summary data-bp-disclosure-toggle={'preflight'}>
              <strong>{t('preflight.title')}</strong>
              <span data-bp-summary-state={workspaceView.preflight.status}>{t(`preflight.${workspaceView.preflight.status}`)}</span>
              {preflightWarningCount > 0 && (
                <small
                  data-bp-summary-warning={'warning'}
                  data-bp-preflight-warning-count={preflightWarningCount}
                >{`${t('preflight.warning')} · ${preflightWarningCount}`}</small>
              )}
            </summary>
            {workspaceView.preflight.code && <p data-bp-preflight-code={true}>{workspaceView.preflight.code}</p>}
            {workspaceView.preflight.documentRevision && (
              <p data-bp-preflight-revision={workspaceView.preflight.documentRevision}>{workspaceView.preflight.documentRevision}</p>
            )}
            <ul>
              {workspaceView.preflight.checks.map((check, index) => (
                <li key={index} data-bp-check-status={check.status}>
                  <strong>{t(`preflight.${check.status}`)}</strong>
                  {' · '}
                  {check.code}
                  {[check.nodeId, check.resourceId, check.toolName].filter(value => value !== undefined).map(value => ` · ${value}`)}
                </li>
              ))}
            </ul>
          </details>
          <details data-bp-section={'run'} data-bp-disclosure={'run'}>
            <summary data-bp-disclosure-toggle={'run'}>
              <strong>{t('run.title')}</strong>
              <span data-bp-summary-state={workspaceView.run.state ?? 'none'}>
                {workspaceView.run.state
                  ? `${workspaceView.run.runId} · ${runStateTitle(workspaceView.run.state, t)}`
                  : t(env.hostLink ? 'run.none' : 'status.hostUnavailable')}
              </span>
              {workspace.model.connectionState === 'stale' && <small>{t('run.stale')}</small>}
              {[
                ...new Set(
                  (snapshot?.attempts ?? [])
                    .filter(attempt => ['waiting_input', 'failed', 'timed_out', 'recovery_required'].includes(attempt.state))
                    .map(attempt => attempt.state)
                )
              ].map(state => (
                <small key={state} data-bp-summary-warning={state}>
                  {runStateTitle(state, t)}
                </small>
              ))}
            </summary>
            <label className={'bp-field'}>
              {t('run.inputJson')}
              <JsonEditor
                key={workspace.blueprintId}
                data-bp-run-input={true}
                label={t('run.inputJson')}
                t={t}
                value={workspaceView.inputJson}
                onChange={text => {
                  workspaceLease.dispatch({ type: 'set-input', inputJson: text })
                }}
                rows={3}
              />
            </label>
            <form
              key={workspace.blueprintId}
              onSubmit={(e: React.FormEvent<HTMLFormElement>) => {
                e.preventDefault()
                const id = String(new FormData(e.currentTarget).get('runId'))
                if (id) {
                  workspaceLease.dispatch({ type: 'bind-run', runId: id })
                  perform(() => workspace.inspect())
                }
              }}
            >
              <input name={'runId'} aria-label={t('run.inspectId')} disabled={workspace.busy} placeholder={t('run.existingId')} />
              <button type={'submit'} data-bp-action={'inspect-run'} disabled={workspace.busy}>
                {t('run.inspectReconnect')}
              </button>
            </form>
            <p data-bp-run={snapshot?.state ?? 'none'}>
              {snapshot ? `${snapshot.runId} · ${runStateTitle(snapshot.state, t)}` : t(env.hostLink ? 'run.none' : 'status.hostUnavailable')}
            </p>
            {snapshot && (
              <p className={'bp-run-revision'} data-bp-run-revision={snapshot.definitionRevision}>
                <span>{t('run.definitionRevision')}</span>
                {' · '}
                {snapshot.definitionRevision}
              </p>
            )}
            {snapshot && !overlayEligible && <p className={'bp-overlay-notice'}>{t('run.overlayUnavailable')}</p>}
            <p data-bp-connection={workspace.model.connectionState}>{t(workspace.model.connectionState === 'stale' ? 'run.stale' : 'run.connected')}</p>
            {button('run.retryInspect', 'retry-inspect', () => perform(() => workspace.inspect()), !workspace.runId || workspace.busy)}
            {chatUnavailable && (
              <p role={'status'} data-bp-chat-unavailable={true}>
                {t('conversation.chatUnavailable')}
              </p>
            )}
            {snapshot?.source && env.openSession && (
              <button type={'button'} data-bp-source-chat={snapshot.source.sessionId} onClick={() => openChat(snapshot.source!.sessionId)}>
                {t('conversation.sourceChat')}
              </button>
            )}
            {(env.openSession ? (snapshot?.team?.members ?? []) : []).map(member => (
              <button
                key={member.memberId}
                type={'button'}
                data-bp-open-member={member.memberId}
                disabled={member.sessionId === undefined}
                onClick={() => {
                  if (member.sessionId) openChat(member.sessionId, snapshot?.team?.leadSessionId)
                }}
              >
                {member.name ?? member.memberId}
                {' · '}
                {t('conversation.openChat')}
              </button>
            ))}
            {snapshot?.attempts.some(a => a.state === 'waiting_input') && (
              <div>
                {button('run.approve', 'approve', () => perform(() => workspace.decide('approve')), workspace.busy)}
                {button('run.reject', 'reject', () => perform(() => workspace.decide('reject')), workspace.busy)}
              </div>
            )}
            {(snapshot?.attempts ?? []).map((a, index) => (
              <details key={`${a.nodeId}-${index}`} data-bp-attempt={a.nodeId}>
                <summary>{t('run.attempt', { nodeId: a.nodeId, attempt: a.attempt, state: runStateTitle(a.state, t) })}</summary>
                {a.outputJson !== undefined && <pre data-bp-output={a.nodeId}>{a.outputJson}</pre>}
                {a.errorCode && <p>{a.errorCode}</p>}
                {a.state === 'failed' && <p data-bp-failure-explanation={a.attemptId ?? a.nodeId}>{t('conversation.failedHistory')}</p>}
                {env.openSession && (
                  <button
                    type={'button'}
                    data-bp-open-attempt={a.attemptId}
                    disabled={a.attemptId === undefined || a.sessionId === undefined}
                    onClick={() => {
                      if (a.attemptId && a.sessionId) openChat(a.sessionId, snapshot?.source?.sessionId)
                    }}
                  >
                    {t('conversation.openChat')}
                  </button>
                )}
                {renderAttemptDiagnostics(a.diagnostics, t)}
              </details>
            ))}
            <ol className={'bp-log'}>
              {(snapshot?.logTail ?? []).map(log => (
                <li key={log.seq}>{`${log.seq} · ${log.kind}`}</li>
              ))}
            </ol>
          </details>
        </aside>
      </div>,
      confirmation.current && (
        <ConfirmationDialog
          key={'confirmation'}
          React={React}
          title={confirmation.current.title}
          description={confirmation.current.description}
          cancelLabel={t('dialog.cancel')}
          confirmLabel={t('dialog.confirm')}
          onCancel={closeConfirmation}
          onConfirm={confirmation.current.accept}
        />
      ),
      resourceDialog && (
        <div key={'resource-dialog'} className={'bp-resource-backdrop'}>
          <div
            ref={resourceDialogRef}
            role={'dialog'}
            aria-modal={'true'}
            aria-labelledby={'bp-resource-dialog-title'}
            data-bp-resource-dialog={true}
            tabIndex={-1}
            className={'bp-resource-dialog'}
            onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeResourceDialog()
              }
              if (event.key === 'Tab' && !event.defaultPrevented) {
                const dialog = event.currentTarget
                const controls = Array.from(
                  dialog.querySelectorAll<HTMLElement>(
                    'button:not(:disabled),input:not(:disabled):not([type=hidden]),select:not(:disabled),textarea:not(:disabled),summary,[tabindex="0"]'
                  )
                ).filter(element => element.getClientRects().length > 0)
                const first = controls[0],
                  last = controls.at(-1)
                if (!first || !last) {
                  event.preventDefault()
                  dialog.focus()
                } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
                  event.preventDefault()
                  last.focus()
                } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
                  event.preventDefault()
                  first.focus()
                }
              }
            }}
          >
            <h2 id={'bp-resource-dialog-title'}>
              {resourceDialog.mode === 'add'
                ? t('resource.add')
                : resourceDialog.mode === 'view'
                  ? t('resource.view', { id: resourceDialog.id })
                  : t('resource.edit', { id: resourceDialog.id })}
            </h2>
            <div className={'bp-resource-fields'}>
              <label className={'bp-field'}>
                {t('resource.kind')}
                <StyledSelect
                  React={React}
                  aria-label={t('resource.kind')}
                  value={resourceDialog.kind}
                  disabled={resourceDialog.mode !== 'add' || !editable}
                  onChange={event => {
                    const target = (event.currentTarget ?? event.target) as HTMLSelectElement
                    const kind = target.value as ResourceRef['kind']
                    setResourceDialog(current => {
                      if (!current) return current
                      let json = current.json
                      try {
                        const parsed = JSON.parse(json)
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = JSON.stringify({ ...parsed, kind }, null, 2)
                      } catch {
                        /* Apply retains malformed draft for the user to repair. */
                      }
                      return { ...current, kind, json }
                    })
                  }}
                >
                  {(['agent', 'skill', 'mcp', 'prompt', 'schema', 'script', 'subflow'] as const).map(kind => (
                    <option key={kind} value={kind}>
                      {resourceKindTitle(kind, t)}
                    </option>
                  ))}
                </StyledSelect>
              </label>
              <label className={'bp-field'}>
                {t('resource.logicalId')}
                <input
                  aria-label={t('resource.newId')}
                  value={resourceDialog.id}
                  disabled={resourceDialog.mode !== 'add' || !editable}
                  onChange={event => {
                    const target = (event.currentTarget ?? event.target) as HTMLInputElement
                    setResourceDialog(current => (current ? { ...current, id: target.value } : current))
                  }}
                />
              </label>
              <label className={'bp-field'}>
                {t('resource.displayName')}
                <input
                  data-bp-resource-field={'title'}
                  aria-label={t('resource.displayName')}
                  value={resourceDialog.title}
                  disabled={resourceDialog.mode === 'view' || !editable}
                  onChange={event => {
                    const target = (event.currentTarget ?? event.target) as HTMLInputElement
                    setResourceDialog(current => (current ? { ...current, title: target.value } : current))
                  }}
                />
              </label>
              <label className={'bp-field'}>
                {t('resource.description')}
                <textarea
                  data-bp-resource-field={'description'}
                  aria-label={t('resource.description')}
                  value={resourceDialog.description}
                  placeholder={t('resource.noDescription')}
                  readOnly={!editable || resourceDialog.mode === 'view'}
                  rows={3}
                  onChange={event => {
                    const target = (event.currentTarget ?? event.target) as HTMLTextAreaElement
                    setResourceDialog(current => (current ? { ...current, description: target.value } : current))
                  }}
                />
              </label>
            </div>
            {!resourceDialog.description.trim() && (
              <p className={'bp-help bp-resource-description-fallback'} data-bp-resource-description-fallback={true}>
                {t('resource.noDescription')}
              </p>
            )}
            <dl data-bp-resource-detail={'identity'} className={'bp-resource-identity'}>
              <dt>{t('resource.source')}</dt>
              <dd data-bp-resource-source={resourceDialog.source}>{resourceDialog.source === 'dsh' ? t('resource.host') : t('resource.blueprint')}</dd>
              <dt>{t('resource.availability')}</dt>
              <dd data-bp-resource-availability={resourceDialog.availability}>
                {resourceDialog.availability === 'available'
                  ? t('resource.available')
                  : resourceDialog.availability === 'unknown'
                    ? t('resource.availabilityUnchecked')
                    : t('resource.unavailable')}
              </dd>
            </dl>
            {activeResourceConfiguration && (
              <dl data-bp-resource-detail={'configuration'} className={'bp-resource-configuration'}>
                <dt>{t('resource.configuration')}</dt>
                <dd>{`${resourceConfigurationSourceLabel(activeResourceConfiguration.source, t)} · ${activeResourceConfiguration.identity}`}</dd>
                {activeResourceConfiguration.path && <dt>{t('resource.path')}</dt>}
                {activeResourceConfiguration.path && <dd>{activeResourceConfiguration.path}</dd>}
                {activeResourceConfiguration.bindingId && <dt>{t('resource.binding')}</dt>}
                {activeResourceConfiguration.bindingId && <dd>{activeResourceConfiguration.bindingId}</dd>}
                {activeResourceConfiguration.format && <dt>{t('resource.format')}</dt>}
                {activeResourceConfiguration.format && <dd>{resourceConfigurationFormatLabel(activeResourceConfiguration.format, t)}</dd>}
              </dl>
            )}
            <details data-bp-resource-advanced={true} open={resourceDialog.mode !== 'view'}>
              <summary>{t('resource.advancedJson')}</summary>
              <label className={'bp-field'}>
                {t('resource.newJson')}
                <JsonEditor
                  label={t('resource.newJson')}
                  t={t}
                  value={resourceDialog.json}
                  rows={8}
                  disabled={!editable || resourceDialog.mode === 'view'}
                  onChange={json => setResourceDialog(current => (current ? { ...current, json } : current))}
                />
              </label>
            </details>
            <div className={'bp-resource-dialog-actions'}>
              {resourceDialog.mode !== 'view' && (
                <button type={'button'} data-bp-action={'resource-apply'} disabled={!editable} onClick={applyResourceDialog}>
                  {t('interaction.apply')}
                </button>
              )}
              <button type={'button'} data-bp-action={'resource-cancel'} onClick={closeResourceDialog}>
                {t('interaction.close')}
              </button>
            </div>
          </div>
        </div>
      ),
      overlay && (
        <InteractionOverlay
          key={`${workspace.blueprintId}-${overlay.kind}-${overlayEpoch.current}`}
          React={React}
          overlay={overlay}
          root={rootRef}
          t={t}
          commands={overlay.kind === 'context-menu' ? contextCommands(overlay.surface, commandFacts()) : []}
          moreActions={moreActions}
          presentationState={presentationState}
          onCommand={command => {
            if (workspace.editor === editor && overlayCurrent()) dispatch(command)
          }}
          onAdd={kind => {
            if (overlay.kind !== 'node-search' || !overlayCurrent()) return
            guarded(() => {
              const id = interactions.add(kind, overlay.position, overlay.origin)
              if (id) {
                setSelected(id)
                closeOverlay()
              }
            })
          }}
          onRename={value => {
            if (overlay.kind !== 'rename' || !overlayCurrent()) return
            guarded(() => {
              if (overlay.group) editor.renameGroup(overlay.targetId, value)
              else editor.patchPresentation([overlay.targetId], { title: value })
              closeOverlay()
            })
          }}
          onClose={closeOverlay}
          importDisabledReason={importDisabledReason}
          importTargets={workspace.catalog.map(item => ({
            ...item,
            nonempty:
              item.documentRevision !== null ||
              (item.blueprintId === workspace.blueprintId &&
                (workspace.dirty || editor.nodes.length > 0 || Object.keys(definition?.resources ?? {}).length > 0))
          }))}
          onImportFile={(id, file) => {
            if (overlay.kind !== 'import' || !overlayCurrent() || workspace.busy || prefs.canvasLocked || composing.current) return
            const binding = overlayBinding.current
            perform(async () => {
              const bytes = new Uint8Array(await file.arrayBuffer())
              if (overlayBinding.current !== binding || !overlayCurrent()) return
              await workspace.importArchive(id, archiveBase64(bytes), id)
              closeOverlay()
            })
          }}
        />
      ),
      currentTooltip && !overlay && (
        <WorkspaceTooltip key={'tooltip'} React={React} root={rootRef} content={currentTooltip} t={t} onClose={() => setTooltip(null)} />
      ),
      <footer key={'status'} className={'bp-status'} role={'status'} data-bp-status={'message'} data-bp-status-key={feedback.key}>
        {message}
      </footer>
    ]
  })
}
