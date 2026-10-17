/** @jsxRuntime classic */
/** @jsx React.createElement */
import React from 'react'
import type { ChangeEvent } from 'react'
import { StyledSelect } from '../../../../shared/controls/styled-controls.ts'
import { JsonEditor } from '../../logic/inspector/json-editor.ts'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import type { PortField } from '../../logic/inspector/inspector-commands.ts'
import type { InspectorViewModel } from '../../presenters/inspector-presenter.ts'
import type { InspectorViewIntent } from '../../logic/inspector/inspector-command-adapter.ts'
export type { InspectorViewIntent } from '../../logic/inspector/inspector-command-adapter.ts'
export function inspectorView(model: InspectorViewModel, t: BlueprintLocaleProps['t'], onIntent: (intent: InspectorViewIntent) => void): React.ReactElement {
  const { node, capability, visibility, snapshot, disabled } = model
  const select = (
    field: 'agentRef' | 'outputSchemaRef',
    label: 'inspector.agentBinding' | 'inspector.outputSchemaBinding',
    placeholder: 'inspector.selectAgent' | 'inspector.selectOutputSchema'
  ) => {
    const value = model.selected[field]
    const choices = model.choices[field]
    return (
      <label key={field} className={'bp-field'}>
        {t(label)}
        <StyledSelect
          React={React}
          disabled={disabled}
          data-bp-field={field}
          aria-label={t(label)}
          value={value}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => onIntent({ type: 'bind-resource', field, key: event.currentTarget.value })}
        >
          <option value={''}>{t(placeholder)}</option>
          {choices.map(choice => (
            <option key={choice.key} value={choice.key} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </StyledSelect>
      </label>
    )
  }
  const references = (field: 'skillRefs' | 'toolsetRefs', label: 'inspector.skillBindings' | 'inspector.toolsetBindings') => {
    const choices = model.choices[field]
    return (
      <fieldset key={field} className={'bp-resource-bindings'}>
        <legend>{t(label)}</legend>
        {!choices.length && <p className={'bp-help bp-binding-empty'}>{t('inspector.noResources')}</p>}
        {choices.map(choice => (
          <label key={choice.key}>
            <input
              type={'checkbox'}
              data-bp-field={field}
              data-bp-ref={choice.key}
              checked={choice.checked}
              disabled={choice.disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                onIntent({ type: 'bind-resource', field, key: choice.key, checked: event.currentTarget.checked })
              }
            ></input>
            {choice.label}
          </label>
        ))}
      </fieldset>
    )
  }
  const portEditor = (field: PortField) => {
    const direction = field === 'inputs' ? 'input' : 'output'
    return (
      <fieldset key={field} className={'bp-port-editor'}>
        <legend>{t(field === 'inputs' ? 'inspector.inputPorts' : 'inspector.outputPorts')}</legend>
        {snapshot.rows[field].map(row => (
          <div key={row.id} className={'bp-port-row'}>
            {(['name', 'type'] as const).map(property => (
              <label key={property}>
                {t(property === 'name' ? 'inspector.portName' : 'inspector.portType')}
                <input
                  data-bp-field={`${field}.${property}`}
                  data-bp-port-row={row.id}
                  value={row[property]}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    onIntent({ type: 'port-row', field, id: row.id, property, value: event.currentTarget.value })
                  }
                ></input>
              </label>
            ))}
            <button
              type={'button'}
              className={'bp-port-remove'}
              aria-label={`${t('inspector.removePort')} ${row.name}`}
              title={t('inspector.removePort')}
              data-bp-action={`remove-${direction}-port`}
              data-bp-port-row={row.id}
              onClick={() => onIntent({ type: 'remove-port', field, id: row.id })}
            >
              <svg
                width={16}
                height={16}
                viewBox={'0 0 24 24'}
                fill={'none'}
                stroke={'currentColor'}
                strokeWidth={1.6}
                strokeLinecap={'round'}
                strokeLinejoin={'round'}
                aria-hidden={true}
              >
                <path d={'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7'}></path>
              </svg>
            </button>
          </div>
        ))}
        <div className={'bp-port-actions'}>
          <button type={'button'} data-bp-action={`add-${direction}-port`} onClick={() => onIntent({ type: 'add-port', field })}>
            {t('inspector.addPort')}
          </button>
          <button type={'button'} data-bp-action={`apply-${direction}-ports`} onClick={() => onIntent({ type: 'apply-ports', field })}>
            {t('inspector.applyPorts')}
          </button>
        </div>
      </fieldset>
    )
  }
  return (
    <div className={'bp-node-inspector'} data-bp-node-inspector={node.id}>
      {node.kind === 'condition' && (
        <fieldset data-bp-condition={true}>
          <legend>{t('inspector.condition')}</legend>
          {model.conditionFields.map(({ field, value, choices }) => {
            return (
              <label key={field}>
                {t(`inspector.condition.${field}`)}
                <StyledSelect
                  React={React}
                  disabled={disabled}
                  data-bp-field={`condition.${field}`}
                  aria-label={t(`inspector.condition.${field}`)}
                  value={value}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) => onIntent({ type: 'condition', field, value: event.currentTarget.value })}
                >
                  <option value={''}>{t('inspector.conditionUnset')}</option>
                  {choices.map(value => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </StyledSelect>
              </label>
            )
          })}
          <button type={'button'} data-bp-action={'clear-condition'} onClick={() => onIntent({ type: 'clear-condition' })}>
            {t('inspector.conditionClear')}
          </button>
        </fieldset>
      )}
      {node.kind === 'join' && (
        <label data-bp-join={true}>
          {t('inspector.join')}
          <StyledSelect
            React={React}
            disabled={disabled}
            data-bp-field={'join'}
            aria-label={t('inspector.join')}
            value={model.joinValue}
            onChange={() => onIntent({ type: 'join-all' })}
          >
            <option value={'all'}>{t('inspector.joinAll')}</option>
            {model.joinValue === 'any' && (
              <option value={'any'} disabled={true}>
                {t('inspector.joinAnyUnavailable')}
              </option>
            )}
          </StyledSelect>
        </label>
      )}
      {capability.agentBindings && select('agentRef', 'inspector.agentBinding', 'inspector.selectAgent')}
      {capability.modelRoute && (
        <fieldset className={'bp-model-route'} data-bp-model-route={true}>
          <legend>{t('inspector.modelRoute')}</legend>
          <label>
            <StyledSelect
              React={React}
              disabled={disabled}
              data-bp-field={'model-mode'}
              aria-label={t('inspector.modelRoute')}
              value={snapshot.modelRoute.explicit ? 'explicit' : 'default'}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => onIntent({ type: 'model-mode', explicit: event.currentTarget.value === 'explicit' })}
            >
              <option value={'default'}>{t('inspector.hostModelDefault')}</option>
              <option value={'explicit'}>{t('inspector.explicitModel')}</option>
            </StyledSelect>
          </label>
          {snapshot.modelRoute.explicit && (
            <div className={'bp-model-fields'}>
              {(['provider', 'model', 'reasoningEffort'] as const).map(field => (
                <label key={field} className={'bp-field'}>
                  {t(field === 'provider' ? 'inspector.modelProvider' : field === 'model' ? 'inspector.modelName' : 'inspector.reasoningEffort')}
                  <input
                    data-bp-field={`modelSelection.${field}`}
                    value={snapshot.modelRoute[field]}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => onIntent({ type: 'model-route', field, value: event.currentTarget.value })}
                  ></input>
                </label>
              ))}
              <button type={'button'} data-bp-action={'apply-model-route'} onClick={() => onIntent({ type: 'apply-model' })}>
                {t('inspector.applyNodeOptions')}
              </button>
            </div>
          )}
        </fieldset>
      )}
      {capability.agentBindings && references('skillRefs', 'inspector.skillBindings')}
      {capability.agentBindings && references('toolsetRefs', 'inspector.toolsetBindings')}
      {capability.agentBindings && select('outputSchemaRef', 'inspector.outputSchemaBinding', 'inspector.selectOutputSchema')}
      {capability.agentBindings && <p className={'bp-muted'}>{t('resource.availabilityUnchecked')}</p>}
      {!capability.agentBindings && model.legacyBindingsText !== null && (
        <details data-bp-legacy-bindings={true}>
          <summary>{t('inspector.legacyBindings')}</summary>
          <p>{t('inspector.legacyBindingsUnused')}</p>
          <pre>{model.legacyBindingsText}</pre>
        </details>
      )}
      <fieldset data-bp-port-visibility={true}>
        <legend>{t('port.visibility')}</legend>
        <p>{t('port.visibilityHelp')}</p>
        {(['control', 'inputs', 'outputs'] as const).map(side => (
          <label key={side} style={{ display: 'flex', alignItems: 'center', minHeight: 40, cursor: 'pointer' }}>
            <input
              type={'checkbox'}
              data-bp-port-toggle={side}
              aria-label={t(`port.visibility.${side}`)}
              checked={visibility[side]}
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>) => onIntent({ type: 'port-visibility', side, visible: event.currentTarget.checked })}
            ></input>
            {t(`port.visibility.${side}`)}
            {model.connectedPriority[side] && <small data-bp-port-edge-priority={side}>{t('port.connectedVisible')}</small>}
          </label>
        ))}
      </fieldset>
      {portEditor('inputs')}
      {portEditor('outputs')}
      <details key={'advanced'}>
        <summary data-bp-inspector-advanced={true}>{t('inspector.advanced')}</summary>
        {(['inputs', 'outputs', 'options'] as const).map(field => (
          <label key={field}>
            {t(field === 'options' ? 'inspector.nodeOptions' : field === 'inputs' ? 'inspector.inputPorts' : 'inspector.outputPorts')}
            <JsonEditor
              key={`json-${field}`}
              data-bp-json={field}
              label={t(field === 'options' ? 'inspector.nodeOptions' : field === 'inputs' ? 'inspector.inputPorts' : 'inspector.outputPorts')}
              t={t}
              disabled={disabled}
              value={snapshot.json[field]}
              rows={field === 'options' ? 8 : 3}
              onChange={text => onIntent({ type: 'json-buffer', field, text })}
              onBlur={() => onIntent({ type: 'json-commit', field })}
            ></JsonEditor>
          </label>
        ))}
        <button type={'button'} data-bp-action={'apply-node-options'} onClick={() => onIntent({ type: 'json-commit', field: 'options' })}>
          {t('inspector.applyNodeOptions')}
        </button>
      </details>
      {snapshot.notice ? (
        <p role={'status'} data-bp-inspector-notice={snapshot.notice.key}>
          {t(snapshot.notice.key, 'params' in snapshot.notice ? snapshot.notice.params : undefined)}
        </p>
      ) : null}
    </div>
  )
}
