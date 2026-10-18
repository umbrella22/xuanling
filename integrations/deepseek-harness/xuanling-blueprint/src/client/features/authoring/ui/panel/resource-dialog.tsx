/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import { StyledSelect } from '../../../../shared/controls/styled-controls.ts'
import type { ResourceRef } from '../../../../../definition/types.ts'
import type { GraphEditor } from '../../logic/graph/graph-editor.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import type { resourceConfiguration } from '../../logic/resources/resource-details.ts'
import { resourceKindTitle } from '../../presenters/canvas-presentation.ts'
import { JsonEditor } from '../../logic/inspector/json-editor.ts'

export interface ResourceDialogState {
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
}

export interface ResourceDialogProps extends BlueprintLocaleProps {
  React: typeof React
  resourceDialog: ResourceDialogState
  resourceDialogRef: React.RefObject<HTMLDivElement | null>
  activeResourceConfiguration: ReturnType<typeof resourceConfiguration> | undefined
  editable: boolean
  setResourceDialog: React.Dispatch<React.SetStateAction<ResourceDialogState | null>>
  applyResourceDialog: () => void
  closeResourceDialog: () => void
}

export function ResourceDialog({
  React: RuntimeReact,
  t,
  resourceDialog,
  resourceDialogRef,
  activeResourceConfiguration,
  editable,
  setResourceDialog,
  applyResourceDialog,
  closeResourceDialog
}: ResourceDialogProps): React.ReactElement {
  return (
    <div className={'bp-resource-backdrop'}>
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
              React={RuntimeReact}
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
  )
}

function resourceConfigurationSourceLabel(source: ReturnType<typeof resourceConfiguration>['source'], t: BlueprintLocaleProps['t']): string {
  if (source === 'host') return t('resource.host')
  if (source === 'shared') return t('resource.sharedLabel')
  if (source === 'package') return t('resource.packageLabel')
  return t('resource.unbound')
}

function resourceConfigurationFormatLabel(format: ResourceRef['format'], t: BlueprintLocaleProps['t']): string | undefined {
  if (format === 'agent-preset') return t('resource.format.agentPreset')
  if (format === 'mcp-definition') return t('resource.format.mcpDefinition')
  return undefined
}
