/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import React from 'react'
import { ReactFlow, Controls, Position } from '@xyflow/react'
import type { BlueprintReferenceView } from '../../../../../conversation/blueprint-reference-contracts.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'

export function BlueprintReferencePreview({ view, t, onBack }: BlueprintLocaleProps & { view: BlueprintReferenceView; onBack: () => void }) {
  const back = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    back.current?.focus()
  }, [])
  const nodes = view.graph.nodes.map((node, index) => ({
    id: node.id,
    position: view.presentation?.nodes[node.id] ?? { x: index * 260, y: 40 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      label: (
        <>
          <strong>{view.presentation?.nodes[node.id]?.title ?? node.id}</strong>
          <p>{t(`conversation.kind.${node.kind}`)}</p>
        </>
      )
    }
  }))
  const edges = view.graph.edges.map((edge, index) => ({
    id: String(index),
    source: edge.from.split(/[.@]/)[0]!,
    target: edge.to.split(/[.@]/)[0]!,
    label: `${edge.from} → ${edge.to}`
  }))
  return (
    <section
      className="bp-child-preview"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onBack()
        }
      }}
    >
      <button type="button" ref={back} data-bp-child-preview-back onClick={onBack}>
        {t('composition.back')}
      </button>
      <h3>{view.name}</h3>
      <code title={view.documentRevision}>{view.documentRevision}</code>
      <p className="bp-help">{t('composition.readonly')}</p>
      <div data-bp-child-preview-graph className="bp-child-preview-graph">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          fitView
          minZoom={0.05}
          aria-label={t('composition.preview')}
        >
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <ol>
        {view.graph.nodes.map(node => (
          <li key={node.id}>
            <strong>{node.id}</strong> · {t(`conversation.kind.${node.kind}`)}
            {node.blueprintRef && (
              <small>
                {node.blueprintRef.blueprintId} · {node.blueprintRef.documentRevision}
              </small>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
