/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import React from 'react'
import { ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, useReactFlow } from '@xyflow/react'
import type { Connection, Edge, ReactFlowInstance } from '@xyflow/react'
import type { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import type { GraphEditor, CanvasPort } from '../../logic/graph/graph-editor.ts'
import type { CollisionProjection } from '../../logic/graph/layout-collisions.ts'
import { applyCanvasNodeChanges, applyCanvasEdgeSelection } from '../../logic/graph/flow-interactions.ts'
import type { CanvasInteractions } from '../../logic/graph/flow-interactions.ts'
import { connectionNotice } from '../../../../shared/contracts/view-contract.ts'
import { flowAriaLabels } from '../../presenters/canvas-presentation.ts'
import type { BlueprintLocaleKey, BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import type { BuiltinNodeKind } from '../../logic/graph/node-catalog.ts'
import type { ViewportBinding, ViewportState } from '../../logic/graph/viewport-state.ts'
import type { ContextSurface } from '../../../../shared/controls/command-policy.ts'
import type { XY } from '../../../../../definition/types.ts'
import type { CanvasNode, RouteEdge } from './canvas-renderers.tsx'
import { edgeTypes, nodeTypes } from './canvas-renderers.tsx'

export const PALETTE_DRAG_TYPE = 'application/x-xuanling-blueprint-node'
export const RECONNECT_ANCHOR_RADIUS = 24

export interface PaletteDragState {
  kind: BuiltinNodeKind
  editor: GraphEditor
  epoch: number
}

interface CanvasNotice {
  key: BlueprintLocaleKey
  params?: Record<string, unknown>
}

export interface CanvasSurfaceProps {
  t: BlueprintLocaleProps['t']
  paletteOver: boolean
  overlayEligible: boolean
  canDropPalette: () => boolean
  add: (kind: BuiltinNodeKind, position?: XY) => void
  setPaletteOver: React.Dispatch<React.SetStateAction<boolean>>
  paletteDrag: React.MutableRefObject<PaletteDragState | null>
  flow: ReactFlowInstance<CanvasNode> | null
  endPaletteDrag: () => void
  wheelHandler: React.MutableRefObject<((event: React.WheelEvent | WheelEvent) => void) | null>
  openSearch: (point?: XY, origin?: CanvasPort) => void
  collision: CollisionProjection
  editable: boolean
  editor: GraphEditor
  measurements: Map<string, { width: number; height: number }>
  guarded: (action: () => void) => boolean
  workspaceSnapshot: ReturnType<BlueprintWorkspace['getSnapshot']>
  flowReady: (flow: ReactFlowInstance<CanvasNode> | null) => void
  nodes: CanvasNode[]
  edges: RouteEdge[]
  prefs: ViewportState
  spacePan: boolean
  interactions: CanvasInteractions
  workspace: BlueprintWorkspace
  setHovered: React.Dispatch<React.SetStateAction<{ editor: GraphEditor; id: string } | null>>
  setSelectedEdges: React.Dispatch<React.SetStateAction<string[]>>
  setTick: React.Dispatch<React.SetStateAction<number>>
  withinRoot: (event: { clientX: number; clientY: number } | undefined) => boolean
  commitGesture: () => void
  cancelGesture: () => void
  selectionChanged: (selection: { nodes: CanvasNode[]; edges: Edge[] }) => void
  contextMenu: (surface: ContextSurface, event: React.MouseEvent | MouseEvent, targetId?: string) => void
  graphPosition: (position?: XY) => XY
  viewportContext: { id: string | null; binding: ViewportBinding | null; state: ViewportState }
  preferences: React.MutableRefObject<{ id: string | null; binding: ViewportBinding | null; state: ViewportState }>
  connectCancelled: React.MutableRefObject<boolean>
  connectOrigin: React.MutableRefObject<CanvasPort | undefined>
  reconnecting: React.MutableRefObject<{ edgeId: string; copy: boolean } | null>
  connectionPorts: (connection: Connection | Edge) => { from: CanvasPort | null; to: CanvasPort | null }
  setNotice: (notice: CanvasNotice | null) => void
  portOf: (editor: GraphEditor, nodeId: string, handle: string | null | undefined, direction: 'in' | 'out') => CanvasPort | null
  definition: BlueprintWorkspace['definition']
}

function FlowApiBridge({ onReady }: { onReady: (flow: ReactFlowInstance<CanvasNode> | null) => void }): null {
  const flow = useReactFlow<CanvasNode>()
  React.useEffect(() => {
    onReady(flow)
    return () => onReady(null)
  }, [flow, onReady])
  return null
}

export function CanvasSurface({
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
}: CanvasSurfaceProps): React.ReactElement {
  return (
    <main
      className={'bp-canvas'}
      data-bp-canvas={'surface'}
      data-bp-palette-over={String(paletteOver)}
      data-bp-overlay={overlayEligible ? 'eligible' : 'suppressed'}
      tabIndex={0}
      aria-label={t('canvas.ariaLabel')}
      onDragOver={(event: React.DragEvent) => {
        if (canDropPalette()) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setPaletteOver(true)
        }
      }}
      onDragLeave={(event: React.DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setPaletteOver(false)
      }}
      onDrop={(event: React.DragEvent) => {
        const drag = paletteDrag.current
        if (drag && flow && canDropPalette() && event.dataTransfer.getData(PALETTE_DRAG_TYPE) === drag.kind) {
          event.preventDefault()
          event.stopPropagation()
          const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false })
          guarded(() => add(drag.kind, position))
        }
        endPaletteDrag()
      }}
      onWheelCapture={event => {
        if (!(event.target as HTMLElement).closest?.('.bp-layout-apply,.bp-layout-error')) wheelHandler.current?.(event)
      }}
      onDoubleClick={(event: React.MouseEvent) => {
        if (
          !(event.target as HTMLElement).closest?.(
            '.react-flow__node,.react-flow__edge,.react-flow__controls,.react-flow__minimap,.bp-layout-apply,.bp-layout-error'
          )
        ) {
          event.preventDefault()
          openSearch({ x: event.clientX, y: event.clientY })
        }
      }}
    >
      {collision.ok && collision.changed ? (
        <button
          type={'button'}
          className={'bp-layout-apply nodrag nopan'}
          onDoubleClick={(event: React.MouseEvent) => event.stopPropagation()}
          onWheel={(event: React.WheelEvent) => event.stopPropagation()}
          data-bp-action={'apply-layout'}
          disabled={!editable || !editor.nodes.every(node => measurements.has(node.id))}
          onClick={() => guarded(() => editor.applyCollisionLayout(measurements))}
        >
          {t('layout.apply')}
        </button>
      ) : null}
      {!collision.ok ? (
        <div
          className={'bp-layout-error nodrag nopan'}
          onDoubleClick={(event: React.MouseEvent) => event.stopPropagation()}
          onWheel={(event: React.WheelEvent) => event.stopPropagation()}
          role={'alert'}
          data-bp-layout-error={collision.code}
        >
          {t('layout.unresolved')} {collision.nodeIds.join(', ')}
          <button
            type={'button'}
            onClick={() => {
              if (flow) void flow.fitView({ nodes: collision.nodeIds.map(id => ({ id })), duration: 0, padding: 0.2 })
            }}
          >
            {t('layout.locate')}
          </button>
          <button type={'button'} disabled={!editable} onClick={() => guarded(() => editor.patchPresentation(collision.nodeIds, { pinned: false }))}>
            {t('layout.unpin')}
          </button>
        </div>
      ) : null}
      <ReactFlowProvider
        key={`workspace-${workspaceSnapshot.binding.editorEpoch}`}
        children={[
          <FlowApiBridge key={'api-bridge'} onReady={flowReady} />,
          <ReactFlow
            key={`canvas-${workspaceSnapshot.binding.editorEpoch}`}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            ariaLabelConfig={flowAriaLabels(t)}
            minZoom={0.1}
            maxZoom={3}
            fitView={false}
            defaultViewport={prefs.viewport}
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode={null}
            panOnDrag={spacePan || prefs.mode === 'pan' ? [0, 1] : [1]}
            panActivationKeyCode={'Space'}
            selectionOnDrag={prefs.mode === 'select' && !spacePan}
            selectionKeyCode={'Shift'}
            multiSelectionKeyCode={['Meta', 'Control']}
            zoomOnScroll={true}
            panOnScroll={false}
            zoomOnPinch={true}
            zoomOnDoubleClick={false}
            nodesDraggable={editable}
            nodesConnectable={editable}
            edgesReconnectable={editable}
            reconnectRadius={RECONNECT_ANCHOR_RADIUS}
            autoPanOnConnect={true}
            autoPanOnNodeDrag={true}
            onlyRenderVisibleElements={false}
            onNodeMouseEnter={(_event, node) => {
              if (workspace.editor === editor && editor.nodes.some(n => n.id === node.id)) setHovered({ editor, id: node.id })
            }}
            onNodeMouseLeave={(_event, node) => {
              if (workspace.editor === editor) setHovered(previous => (previous?.editor === editor && previous.id === node.id ? null : previous))
            }}
            onNodesChange={changes => {
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
                  measurements.set(change.id, { width, height })
                  resized = true
                }
              }
              if (resized) setTick(n => n + 1)
            }}
            onEdgesChange={changes => {
              if (workspace.editor === editor) setSelectedEdges(current => applyCanvasEdgeSelection(current, changes))
            }}
            onNodeDragStart={(event, node) =>
              guarded(() => {
                interactions.beginDrag(editor.selection.has(node.id) ? [...editor.selection] : [node.id], event.altKey)
              })
            }
            onNodeDragStop={event => {
              if (withinRoot('changedTouches' in event ? event.changedTouches[0] : event)) commitGesture()
              else cancelGesture()
            }}
            onSelectionDragStart={event =>
              guarded(() => {
                interactions.beginDrag([...editor.selection], event.altKey)
              })
            }
            onSelectionDragStop={event => {
              if (withinRoot(event)) commitGesture()
              else cancelGesture()
            }}
            onSelectionChange={selectionChanged}
            onPaneContextMenu={event => contextMenu('canvas', event)}
            onNodeContextMenu={(event, node) => {
              if (node.type !== 'presentationGroup') contextMenu('node', event, node.id)
            }}
            onEdgeContextMenu={(event, edge) => contextMenu('edge', event, edge.id)}
            onEdgeClick={(event, edge) => {
              if (event.altKey) {
                event.preventDefault()
                guarded(() => {
                  const original = editor.edges.find(e => e.id === edge.id)
                  if (original) interactions.route(edge.id, [...(original.points ?? []), graphPosition({ x: event.clientX, y: event.clientY })])
                })
              }
            }}
            onMoveEnd={(_event, viewport) => {
              if (
                workspace.editor !== editor ||
                workspace.blueprintId !== viewportContext.id ||
                preferences.current !== viewportContext ||
                !viewportContext.binding
              )
                return
              const state = { ...viewportContext.state, viewport }
              const result = viewportContext.binding.write(state)
              if (!result.ok && result.reason === 'stale-context') return
              viewportContext.state = state
              setTick(n => n + 1)
            }}
            onReconnectStart={(event, edge) => {
              if (editable) {
                connectCancelled.current = false
                connectOrigin.current = undefined
                reconnecting.current = { edgeId: edge.id, copy: 'shiftKey' in event && event.shiftKey }
              }
            }}
            onReconnect={(edge, connection) =>
              guarded(() => {
                if (connectCancelled.current || reconnecting.current?.edgeId !== edge.id) return
                const { from, to } = connectionPorts(connection)
                if (from && to) {
                  const result = interactions.reconnect(edge.id, from, to, !!reconnecting.current?.copy)
                  setNotice(result.ok ? { key: 'connection.added' } : connectionNotice(result))
                } else setNotice({ key: 'connection.undeclaredPort' })
              })
            }
            onReconnectEnd={() => {
              reconnecting.current = null
            }}
            onConnectStart={(_event, params) => {
              connectCancelled.current = false
              connectOrigin.current =
                editable && params.nodeId
                  ? (portOf(editor, params.nodeId, params.handleId, params.handleType === 'source' ? 'out' : 'in') ?? undefined)
                  : undefined
            }}
            isValidConnection={connection => {
              const { from, to } = connectionPorts(connection)
              return editable && !!from && !!to && editor.connectionVerdict(from, to, reconnecting.current?.copy ? undefined : reconnecting.current?.edgeId).ok
            }}
            onConnect={connection =>
              guarded(() => {
                if (connectCancelled.current) return
                const { from, to } = connectionPorts(connection)
                if (from && to) {
                  const result = editor.connect(from, to)
                  setNotice(result.ok ? { key: 'connection.added' } : connectionNotice(result))
                } else setNotice({ key: 'connection.undeclaredPort' })
              })
            }
            onConnectEnd={(event, state) => {
              const origin = connectOrigin.current
              connectOrigin.current = undefined
              if (connectCancelled.current || reconnecting.current) return
              if (!state.isValid && state.toNode) setNotice({ key: 'connection.incompatible' })
              else if (!state.isValid && origin && editable) {
                const pointer = 'changedTouches' in event ? event.changedTouches[0] : event
                if (pointer && withinRoot(pointer)) openSearch({ x: pointer.clientX, y: pointer.clientY }, origin)
              }
            }}
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
            {prefs.minimap && (
              <MiniMap
                pannable={true}
                zoomable={true}
                nodeColor={'var(--bp-muted)'}
                nodeClassName={n => (n.type === 'presentationGroup' ? 'bp-minimap-group' : '')}
              />
            )}
          </ReactFlow>
        ]}
      />
      {!definition && (
        <div className={'bp-empty'}>
          <strong>{t('canvas.chooseBlueprint')}</strong>
          <p>{t('canvas.emptyHelp')}</p>
        </div>
      )}
    </main>
  )
}
