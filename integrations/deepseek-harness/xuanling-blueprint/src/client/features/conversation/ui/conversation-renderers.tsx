/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import { Handle, Position, BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps, NodeProps } from '@xyflow/react'
import type { BlueprintLocaleProps } from '../../../shared/i18n/locales.ts'
import { nodeContentKey, nodeContentMinimum, useNodeContentMeasurement } from '../../authoring/logic/graph/node-geometry.ts'
import type { FrozenFlowEdge, FrozenFlowNode, FrozenGroupNode, FrozenNodeData } from './conversation-canvas.ts'
import { displayState } from '../presenters/conversation-presenter.ts'

export type ConversationDisplayNode = FrozenFlowNode & {
  data: FrozenNodeData & {
    t: BlueprintLocaleProps['t']
    onContentMeasure?: (height: number) => void
  }
}
export type ConversationDisplayGroup = FrozenGroupNode & {
  data: FrozenGroupNode['data'] & {
    t: BlueprintLocaleProps['t']
  }
}

export function frozenContentShape(
  data: FrozenNodeData & {
    t: BlueprintLocaleProps['t']
  }
) {
  const { node, t } = data
  return {
    title: `${t(`conversation.kind.${node.kind}`)} ${data.title}`,
    ...(data.portEdgePriority.length ? { note: t('port.connectedVisible') } : {}),
    state: displayState(data.state, t),
    members: data.memberActivities.map(member => `${member.label} · ${t(`conversation.activity.${member.activity}`)}`),
    inputs: node.inputs ?? {},
    outputs: node.outputs ?? {},
    controlOutputs: data.controlOutputs,
    visibility: data.portVisibility
  }
}

export function FrozenNode({ data, selected }: NodeProps<ConversationDisplayNode>): React.ReactElement {
  const { node, t } = data
  const shape = frozenContentShape(data)
  const content = useNodeContentMeasurement(nodeContentKey(shape, data.contentWidth), React, data.onContentMeasure)
  const port = (name: string, kind: 'data' | 'control', direction: 'input' | 'output') => (
    <div key={`${kind}:${name}`} className={`bp-port-row ${direction === 'output' ? 'bp-port-out' : ''}`}>
      <Handle
        type={direction === 'input' ? 'target' : 'source'}
        position={direction === 'input' ? Position.Left : Position.Right}
        id={`${kind}:${name}`}
        isConnectable={false}
        className={kind === 'control' ? 'bp-handle-control' : ''}
        aria-label={t('node.portAria', { nodeId: node.id, direction: t(`port.${direction}`), kind: t(`port.${kind}`), port: name })}
      />
      <span>{name}</span>
    </div>
  )
  return (
    <article
      className={`bp-node ${selected ? 'bp-node-selected' : ''}`}
      data-bp-node={node.id}
      data-bp-raw-state={data.rawState}
      data-bp-state={data.state}
      data-bp-motion={data.motion}
      data-bp-focus={data.focused}
      data-bp-color={data.color}
      data-bp-collapsed={data.collapsed}
      style={{ height: 'auto', minHeight: Math.max(nodeContentMinimum(shape).height, data.minimumHeight, content.height ?? 0) }}
    >
      <div ref={content.ref} data-bp-node-content={node.id}>
        <div className={'bp-node-title'}>
          <strong>{data.title}</strong>
          <small className={'bp-kind'}>{t(`conversation.kind.${node.kind}`)}</small>
        </div>
        <div className={'bp-node-state'}>{displayState(data.state, t)}</div>
        {data.memberActivities.map(member => (
          <div
            key={member.memberId}
            className={'bp-member-activity'}
            data-bp-node-member={member.memberId}
            data-bp-activity={member.activity}
          >{`${member.label} · ${t(`conversation.activity.${member.activity}`)}`}</div>
        ))}
        {data.portEdgePriority.length > 0 && (
          <div data-bp-port-edge-priority={data.portEdgePriority.join(',')} className={'bp-node-note'}>
            {t('port.connectedVisible')}
          </div>
        )}
        {(data.portVisibility.inputs || data.portVisibility.outputs) && (
          <div className={'bp-port-columns'}>
            <div>{Object.keys(data.portVisibility.inputs ? (node.inputs ?? {}) : {}).map(name => port(name, 'data', 'input'))}</div>
            <div>{Object.keys(data.portVisibility.outputs ? (node.outputs ?? {}) : {}).map(name => port(name, 'data', 'output'))}</div>
          </div>
        )}
        {data.portVisibility.control && (
          <div className={'bp-port-columns bp-control-ports'}>
            <div>{port('control', 'control', 'input')}</div>
            <div>{data.controlOutputs.map(name => port(name, 'control', 'output'))}</div>
          </div>
        )}
      </div>
      {data.motion === 'pulse' ? <div className={'bp-node-emphasis'} aria-hidden={true} /> : null}
    </article>
  )
}

export function FrozenGroup({ data }: NodeProps<ConversationDisplayGroup>): React.ReactElement {
  return (
    <div className={'bp-group-frame'} data-bp-group={data.groupId} role={'group'} aria-label={data.t('group.ariaLabel', { label: data.label })}>
      <div className={'bp-group-header'}>
        <strong title={data.label} tabIndex={0} style={{ pointerEvents: 'auto' }}>
          {data.label}
        </strong>
        <span>{data.t('group.memberCount', { count: data.nodeIds.length })}</span>
      </div>
    </div>
  )
}

export function FrozenEdge(props: EdgeProps<FrozenFlowEdge>): React.ReactElement {
  const points = props.data?.points ?? []
  const path = points.length
    ? `M ${props.sourceX} ${props.sourceY} ${points.map(point => `L ${point.x} ${point.y}`).join(' ')} L ${props.targetX} ${props.targetY}`
    : getSmoothStepPath(props)[0]
  return <BaseEdge id={props.id} path={path} style={props.style} interactionWidth={0} />
}

export const nodeTypes = { frozen: FrozenNode, frozenGroup: FrozenGroup }
export const edgeTypes = { frozen: FrozenEdge }
