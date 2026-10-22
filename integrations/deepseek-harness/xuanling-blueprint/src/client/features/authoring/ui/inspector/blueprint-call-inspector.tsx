/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import type { EditorNode, GraphEditor } from '../../logic/graph/graph-editor.ts'
import type { HostLink, CatalogValue } from '../../../../adapters/host/remote.ts'
import { BlueprintRemoteError } from '../../../../adapters/host/remote.ts'
import type { BlueprintReferenceView } from '../../../../../conversation/blueprint-reference-contracts.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import { StyledSelect } from '../../../../shared/controls/styled-controls.ts'
import { applyBlueprintReference, compositionChanges, compositionIdentity, incompatibleCompositionEdges } from '../../logic/inspector/blueprint-composition.ts'
import { BlueprintReferencePreview } from './blueprint-reference-preview.tsx'

export interface BlueprintCallInspectorProps extends BlueprintLocaleProps {
  node: EditorNode
  editor: GraphEditor
  host: HostLink | undefined
  disabled: boolean
}
export function BlueprintCallInspector(props: BlueprintCallInspectorProps) {
  const { node, editor, host, disabled, t } = props
  const [catalog, setCatalog] = React.useState<CatalogValue['definitions']>([])
  const [choice, setChoice] = React.useState(node.definition?.blueprintRef?.blueprintId ?? '')
  const [candidate, setCandidate] = React.useState<{ view: BlueprintReferenceView; base: string } | null>(null)
  const [status, setStatus] = React.useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [error, setError] = React.useState('')
  const [removeEdges, setRemoveEdges] = React.useState(false)
  const [preview, setPreview] = React.useState(false)
  const selectedCandidate = React.useRef(candidate)
  selectedCandidate.current = candidate
  const owner = React.useRef({ props, active: true, generation: 0 })
  owner.current.props = props
  const previewButton = React.useRef<HTMLButtonElement>(null)
  const current = () => owner.current.active && owner.current.props.editor === editor && owner.current.props.node.id === node.id
  const load = async (blueprintId: string, documentRevision?: string) => {
    const generation = ++owner.current.generation
    selectedCandidate.current = null
    setChoice(blueprintId)
    setCandidate(null)
    setRemoveEdges(false)
    setPreview(false)
    setError('')
    if (!blueprintId) {
      setStatus('idle')
      return
    }
    setStatus('loading')
    const original = editor.nodes.find(n => n.id === node.id)
    const base = original && compositionIdentity(original)
    try {
      if (!host?.inspectBlueprintReference) throw new BlueprintRemoteError('blueprint/capability-unavailable')
      const view = await host.inspectBlueprintReference({
        blueprintId,
        ownerBlueprintId: editor.exportDefinition().id,
        ...(documentRevision ? { documentRevision } : {})
      })
      if (!current() || generation !== owner.current.generation) return
      if (view.blueprintId !== blueprintId || (documentRevision !== undefined && view.documentRevision !== documentRevision))
        throw new BlueprintRemoteError('blueprint/dto-invalid')
      setCandidate({ view, base: base! })
      setStatus('ready')
    } catch (error) {
      if (!current() || generation !== owner.current.generation) return
      setError(error instanceof BlueprintRemoteError ? error.code : 'blueprint/remote-failed')
      setStatus('error')
    }
  }
  React.useEffect(() => {
    owner.current.active = true
    let alive = true
    void host?.listDefinitions().then(
      value => {
        if (alive) setCatalog(value.definitions)
      },
      () => {
        if (alive) {
          setError('blueprint/remote-failed')
          setStatus('error')
        }
      }
    )
    return () => {
      alive = false
      owner.current.active = false
      owner.current.generation++
    }
  }, [host, editor, node.id])
  const pin = node.definition?.blueprintRef
  React.useEffect(() => {
    void load(pin?.blueprintId ?? '', pin?.documentRevision)
  }, [host, editor, node.id, pin?.blueprintId, pin?.documentRevision])
  const view = candidate?.view
  const changes = view ? compositionChanges(node, view) : []
  const conflicts = view ? incompatibleCompositionEdges(editor, node, view) : []
  const changed = view !== undefined && (pin?.blueprintId !== view.blueprintId || pin.documentRevision !== view.documentRevision || changes.length > 0)
  const back = () => {
    setPreview(false)
    requestAnimationFrame(() => previewButton.current?.focus())
  }
  if (preview && view) return <BlueprintReferencePreview view={view} t={t} onBack={back} />
  return (
    <section className="bp-child-composition" data-bp-child-composition={node.id} aria-busy={status === 'loading'}>
      <h3>{t('composition.title')}</h3>
      <p className="bp-help">{t('composition.help')}</p>
      {pin && (
        <p className="bp-child-pin" data-bp-child-pin={pin.documentRevision}>
          <span title={pin.blueprintId}>
            {view?.blueprintId === pin.blueprintId && view.documentRevision === pin.documentRevision
              ? view.name
              : (catalog.find(item => item.blueprintId === pin.blueprintId)?.name ?? pin.blueprintId)}
          </span>{' '}
          · <code title={pin.documentRevision}>{pin.documentRevision.slice(0, 12)}</code>
        </p>
      )}
      <label className="bp-field">
        {t('composition.blueprint')}
        <StyledSelect
          data-bp-child-picker
          aria-label={t('composition.blueprint')}
          value={choice}
          disabled={disabled || !host}
          onChange={event => {
            if (current() && !owner.current.props.disabled) void load(event.currentTarget.value)
          }}
        >
          <option value="">{t('composition.choose')}</option>
          {choice && !catalog.some(item => item.blueprintId === choice) && <option value={choice}>{choice}</option>}
          {catalog
            .filter(item => item.blueprintId !== editor.exportDefinition().id)
            .map(item => (
              <option key={item.blueprintId} value={item.blueprintId} disabled={item.documentRevision === null}>
                {item.name} · {item.blueprintId}
              </option>
            ))}
        </StyledSelect>
      </label>
      {view && (
        <label className="bp-field">
          {t('composition.revision')}
          <StyledSelect
            data-bp-child-revision
            aria-label={t('composition.revision')}
            value={view.documentRevision}
            disabled={disabled}
            onChange={event => {
              if (current() && !owner.current.props.disabled) void load(view.blueprintId, event.currentTarget.value)
            }}
          >
            {view.revisions.map(revision => (
              <option
                key={revision.documentRevision}
                value={revision.documentRevision}
              >{`${revision.documentRevision.slice(0, 12)}${revision.documentRevision === view.currentRevision ? ' · ' + t('composition.latest') : ''}`}</option>
            ))}
          </StyledSelect>
        </label>
      )}
      {status === 'loading' && <p role="status">{t('status.loading')}</p>}
      {status === 'error' && (
        <p role="alert">
          {t('composition.unavailable')} <code>{error}</code>
        </p>
      )}
      {status === 'error' && (
        <button type="button" onClick={() => void load(choice, pin?.blueprintId === choice ? pin.documentRevision : undefined)}>
          {t('composition.retry')}
        </button>
      )}
      {view && (
        <div data-bp-child-candidate={view.documentRevision}>
          <table className="bp-child-interface">
            <caption>{t('composition.interface')}</caption>
            <thead>
              <tr>
                <th>{t('composition.direction')}</th>
                <th>{t('inspector.portName')}</th>
                <th>{t('inspector.portType')}</th>
              </tr>
            </thead>
            <tbody>
              {(['inputs', 'outputs'] as const).flatMap(side =>
                Object.entries(view[side]).map(([name, type]) => (
                  <tr key={`${side}:${name}`}>
                    <td>{t(side === 'inputs' ? 'port.input' : 'port.output')}</td>
                    <td>{name}</td>
                    <td>{type}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {changed && (
            <ul data-bp-child-diff>
              {changes.map(change => (
                <li key={`${change.side}:${change.name}`}>
                  {t(change.side === 'inputs' ? 'port.input' : 'port.output')} · {change.name}: {change.before ?? '∅'} → {change.after ?? '∅'}
                </li>
              ))}
            </ul>
          )}
          {conflicts.length > 0 && (
            <label className="bp-child-conflicts">
              <input
                type="checkbox"
                data-bp-child-disconnect
                checked={removeEdges}
                disabled={disabled}
                onChange={event => setRemoveEdges(event.currentTarget.checked)}
              />
              {t('composition.disconnect', { count: conflicts.length })}
            </label>
          )}
          {conflicts.length > 0 && <p className="bp-help">{t('composition.edgesRetained')}</p>}
          <div className="bp-child-actions">
            <button type="button" ref={previewButton} data-bp-child-preview onClick={() => setPreview(true)}>
              {t('composition.preview')}
            </button>
            <button
              type="button"
              data-bp-child-apply
              disabled={disabled || !changed || (conflicts.length > 0 && !removeEdges)}
              onClick={() => {
                if (!current() || owner.current.props.disabled || !candidate || selectedCandidate.current !== candidate) return
                if (!applyBlueprintReference(editor, node.id, candidate.base, candidate.view, removeEdges)) {
                  setError('blueprint/stale-selection')
                  setStatus('error')
                }
              }}
            >
              {t(pin ? 'composition.update' : 'composition.apply')}
            </button>
            {changed && (
              <button type="button" data-bp-child-cancel onClick={() => void load(pin?.blueprintId ?? '', pin?.documentRevision)}>
                {t('composition.cancel')}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
