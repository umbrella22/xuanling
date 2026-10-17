/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import { Handle, Position, NodeResizer, BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { Edge, EdgeProps, Node, NodeProps } from '@xyflow/react'
import type { PresentationNode, XY } from '../../../../../definition/types.ts'
import { useNodeContentMeasurement } from '../../logic/graph/node-geometry.ts'
import { effectivePortVisibility, connectedPortEdges } from '../../logic/graph/port-visibility.ts'
import { pointerPosition } from '../../logic/graph/flow-interactions.ts'
import { blueprintIcon } from '../../../../shared/icons/icons.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import type { NodeMotion, EdgeMotion } from '../../../../shared/styles/runtime-motion.ts'
import { BUILTIN_NODE_CATALOG } from '../../logic/graph/node-catalog.ts'

const EDITABLE_KINDS = new Set<string>(BUILTIN_NODE_CATALOG.map(p => p.kind))

export interface NodeData extends Record<string, unknown> {
  label: string
  kind: string
  kindTitle: string
  inputs: Record<string, string>
  outputs: Record<string, string>
  summary: string
  graphEdges: Array<{ kind: 'data' | 'control'; from: string; to: string }>
  state: string
  runtime: NodeMotion
  branches: string[]
  t: BlueprintLocaleProps['t']
  presentation: Omit<PresentationNode, 'x' | 'y'>
  editable: boolean
  minHeight: number
  contentKey: string
  onContentMeasure: (height: number) => void
  onRename: () => void
  onResizeStart: () => void
  onResize: (size: { width: number; height: number; x: number; y: number }) => void
  onResizeEnd: (position: XY | undefined) => void
}

export interface GroupData extends Record<string, unknown> {
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

export type FlowNode = Node<NodeData, 'blueprint'>
export type GroupNode = Node<GroupData, 'presentationGroup'>
export type CanvasNode = FlowNode | GroupNode

export const BlueprintNode = React.memo(function BlueprintNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { t } = data
  const visibility = effectivePortVisibility(
    { id, kind: data.kind, inputs: data.inputs, outputs: data.outputs, branches: data.branches, presentation: data.presentation },
    data.graphEdges ?? []
  )
  const content = useNodeContentMeasurement(data.contentKey, React, data.onContentMeasure)
  const forced = (['control', 'inputs', 'outputs'] as const).filter(
    side => data.presentation.ports?.[side] === false && connectedPortEdges(id, side, data.graphEdges ?? [])
  )
  const port = (name: string, type: string, direction: 'in' | 'out', kind: 'data' | 'control', generated = false) => {
    const handleProps = {
      type: direction === 'in' ? 'target' : 'source',
      position: direction === 'in' ? Position.Left : Position.Right,
      id: `${kind}:${name}`,
      className: `bp-handle-${kind}`,
      'aria-label': t('node.portAria', {
        nodeId: id,
        direction: t(direction === 'in' ? 'port.input' : 'port.output'),
        kind: t(kind === 'data' ? 'port.data' : 'port.control'),
        port: name
      }),
      'data-bp-port': `${id}:${kind}:${name}`,
      ...(direction === 'out' ? { 'data-bp-port-out': `${id}:${kind}:${name}` } : {})
    } as React.ComponentProps<typeof Handle> & { 'data-bp-port': string }
    return (
      <div className={`bp-port-row bp-port-${direction}`} key={`${direction}-${kind}-${name}`}>
        <Handle {...handleProps} />
        <span>{kind === 'control' ? (generated ? t('port.control') : name) : `${name} · ${type}`}</span>
      </div>
    )
  }
  return (
    <div
      className={`bp-node${selected ? ' bp-node-selected' : ''}`}
      data-bp-node={id}
      data-bp-kind={data.kind}
      data-bp-raw-state={data.runtime.state}
      data-bp-motion={data.runtime.motion}
      data-bp-relation={data.runtime.relation}
      data-bp-pinned={String(!!data.presentation.pinned)}
      data-bp-collapsed={String(!!data.presentation.collapsed)}
      data-bp-color={data.presentation.color ?? 'default'}
      style={{ width: '100%', height: 'auto', minHeight: Math.max(data.minHeight, data.presentation.height ?? 0, content.height ?? 0) }}
    >
      {data.runtime.motion === 'pulse' && <div className="bp-node-emphasis" aria-hidden={true} />}
      <div data-bp-resize={id} aria-label={t('interaction.resize')}>
        {[false, true].map(corners => (
          <NodeResizer
            key={corners ? 'corners' : 'edges'}
            nodeId={id}
            isVisible={!!selected && data.editable && !data.presentation.pinned}
            // Edges change one axis; corners keep the initial ratio and opposite anchor.
            keepAspectRatio={corners}
            {...(corners ? { lineStyle: { display: 'none' } } : { handleStyle: { display: 'none' } })}
            minWidth={220}
            minHeight={Math.max(data.minHeight, content.height ?? 0)}
            shouldResize={() => data.editable && !data.presentation.pinned}
            onResizeStart={data.onResizeStart}
            onResize={(_event, params) => data.onResize(params)}
            onResizeEnd={event => data.onResizeEnd(pointerPosition(event))}
          />
        ))}
      </div>
      <div ref={content.ref} data-bp-node-content={id}>
        <div
          className="bp-node-title"
          title={data.editable && !data.presentation.pinned ? t('interaction.dragNode') : undefined}
          onDoubleClick={event => {
            event.stopPropagation()
            data.onRename()
          }}
        >
          <span className="bp-node-grip" aria-hidden={true}>
            {blueprintIcon(React, 'grip')}
          </span>
          <span className="bp-kind">{data.kindTitle}</span>
          <strong>{data.label}</strong>
        </div>
        {data.summary && (
          <div className="bp-node-summary" title={t('resource.availabilityUnchecked')}>
            {data.summary}
          </div>
        )}
        <div className="bp-node-state" data-bp-node-state={id}>
          {data.state}
        </div>
        {!EDITABLE_KINDS.has(data.kind) && <div className="bp-node-note">{t('node.importedKind', { kind: data.kind })}</div>}
        {forced.length > 0 && (
          <div data-bp-port-edge-priority={forced.join(',')} className="bp-node-note">
            {t('port.connectedVisible')}
          </div>
        )}
        {(visibility.inputs || visibility.outputs) && (
          <div className="bp-port-columns">
            <div>{Object.entries(visibility.inputs ? data.inputs : {}).map(([name, type]) => port(name, type, 'in', 'data'))}</div>
            <div>{Object.entries(visibility.outputs ? data.outputs : {}).map(([name, type]) => port(name, type, 'out', 'data'))}</div>
          </div>
        )}
        {visibility.control && (
          <div className="bp-port-columns bp-control-ports">
            <div>{port('control', 'control', 'in', 'control', true)}</div>
            <div>{(data.branches.length ? data.branches : ['control']).map(name => port(name, 'control', 'out', 'control', !data.branches.length))}</div>
          </div>
        )}
      </div>
    </div>
  )
})

export const PresentationGroup = React.memo(function PresentationGroup({ data }: NodeProps<GroupNode>) {
  return (
    <div className="bp-group-frame" data-bp-group={data.groupId} role="group" aria-label={data.ariaLabel} title={data.hint}>
      <div
        className="bp-group-header"
        data-bp-group-header={data.groupId}
        tabIndex={0}
        onContextMenu={data.onMenu}
        onDoubleClick={data.onRename}
        onPointerDown={data.onPointerDown}
        onPointerMove={data.onPointerMove}
        onPointerUp={data.onPointerUp}
        onPointerCancel={data.onPointerCancel}
      >
        <strong title={data.label} tabIndex={0}>
          {data.label}
        </strong>
        <span>{data.countLabel}</span>
        <button
          type="button"
          className="nodrag nopan"
          data-bp-action={`ungroup-${data.groupId}`}
          aria-label={data.removeLabel}
          title={data.removeLabel}
          onClick={data.onRemove}
        >
          {data.removeText}
        </button>
      </div>
    </div>
  )
})

export interface RouteData extends Record<string, unknown> {
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
export type RouteEdge = Edge<RouteData, 'blueprintEdge'>

export const BlueprintEdge = React.memo(function BlueprintEdge(props: EdgeProps<RouteEdge>) {
  const data = props.data!
  const drag = React.useRef<{ index: number; points: XY[] } | null>(null)
  const [smooth, labelX, labelY] = getSmoothStepPath(props)
  const path = data.points.length
    ? `M ${props.sourceX} ${props.sourceY} ${data.points.map(p => `L ${p.x} ${p.y}`).join(' ')} L ${props.targetX} ${props.targetY}`
    : smooth
  return (
    <g data-bp-edge={props.id} data-bp-motion-edge={props.id} data-bp-motion={data.runtime.motion} data-bp-related={String(data.runtime.related)}>
      <BaseEdge
        id={props.id}
        path={path}
        {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})}
        {...(props.style ? { style: props.style } : {})}
        label={props.label}
        labelX={labelX}
        labelY={labelY}
        interactionWidth={20}
      />
      {data.runtime.motion === 'pulse' && (
        <path
          className="bp-directed-light"
          data-bp-motion="pulse"
          d={path}
          pathLength={1}
          strokeDasharray="0 2"
          strokeLinecap="round"
          pointerEvents="none"
          aria-hidden={true}
        />
      )}
      {data.points.map((point, index) => (
        <circle
          key={index}
          cx={point.x}
          cy={point.y}
          r={7}
          className="bp-reroute nodrag nopan"
          data-bp-reroute={`${props.id}:${index}`}
          tabIndex={0}
          role="button"
          aria-label={data.t('interaction.reroutePoint', { index: index + 1 })}
          onPointerDown={event => {
            if (event.button !== 0 || !data.editable) return
            event.preventDefault()
            event.stopPropagation()
            if (!data.onBegin()) return
            drag.current = { index, points: structuredClone(data.points) }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={event => {
            if (!drag.current) return
            event.stopPropagation()
            const points = structuredClone(drag.current.points)
            points[drag.current.index] = data.positionAt({ x: event.clientX, y: event.clientY })
            data.onPreview(points)
          }}
          onPointerUp={event => {
            if (!drag.current) return
            event.stopPropagation()
            drag.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
            data.onCommit({ x: event.clientX, y: event.clientY })
          }}
          onPointerCancel={() => {
            drag.current = null
            data.onCancel()
          }}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
            if (data.editable) data.onPoints(data.points.filter((_p, i) => i !== index))
          }}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.nativeEvent.isComposing || event.keyCode === 229 || !data.editable) return
            if (event.key === 'Escape') {
              event.preventDefault()
              drag.current = null
              data.onCancel()
              return
            }
            if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault()
              data.onPoints(data.points.filter((_p, i) => i !== index))
              return
            }
            const delta: Record<string, XY> = {
              ArrowLeft: { x: -10, y: 0 },
              ArrowRight: { x: 10, y: 0 },
              ArrowUp: { x: 0, y: -10 },
              ArrowDown: { x: 0, y: 10 }
            }
            const step = delta[event.key]
            if (step) {
              event.preventDefault()
              data.onPoints(data.points.map((p, i) => (i === index ? { x: p.x + step.x, y: p.y + step.y } : p)))
            }
          }}
        />
      ))}
    </g>
  )
})

export const edgeTypes = { blueprintEdge: BlueprintEdge }
export const nodeTypes = { blueprint: BlueprintNode, presentationGroup: PresentationGroup }
