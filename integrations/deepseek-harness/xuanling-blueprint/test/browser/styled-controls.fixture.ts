import React from 'react'
import { createRoot } from 'react-dom/client'
import { StyledSelect, ConfirmationDialog } from '../../src/client/shared/controls/styled-controls.ts'
import { createBlueprintPanel } from '../../src/client/features/authoring/ui/panel/panel-composition.tsx'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'
const h = React.createElement
const t = (key: keyof typeof en, params: Record<string, unknown> = {}) => en[key].replace(/\{([^}]+)\}/g, (_, name) => String(params[name] ?? `{${name}}`))
const Panel = createBlueprintPanel({ hostLink: undefined, storage: undefined })
let releaseCatalog: () => void = () => {}
const catalogReady = new Promise<void>(resolve => {
  releaseCatalog = resolve
})
const delayedCalls: string[] = []
const delayedDefinition = { schemaVersion: 1, id: 'delayed-blueprint', name: 'Delayed library blueprint', resources: {}, graph: { nodes: [], edges: [] } }
const DelayedPanel = createBlueprintPanel({
  hostLink: {
    async listDefinitions() {
      delayedCalls.push('catalog:waiting')
      await catalogReady
      delayedCalls.push('catalog:ready')
      return {
        definitions: [{ blueprintId: delayedDefinition.id, name: delayedDefinition.name, documentRevision: 'doc-delayed', semanticRevision: 'sem-delayed' }]
      }
    },
    async loadDefinition(id) {
      delayedCalls.push(`load:${id}`)
      return {
        blueprintId: id,
        definitionJson: JSON.stringify(delayedDefinition),
        documentRevision: 'doc-delayed',
        semanticRevision: 'sem-delayed',
        layoutRevision: 'layout-delayed'
      }
    }
  },
  storage: undefined
})
Object.assign(window, { delayedCalls })
function Fixture() {
  const [value, setValue] = React.useState('alpha raw / value'),
    [disabled, setDisabled] = React.useState(false),
    [confirm, setConfirm] = React.useState(false)
  const [accepted, setAccepted] = React.useState(0),
    [keys, setKeys] = React.useState(0)
  return h(
    React.Fragment,
    null,
    h(
      'section',
      { className: 'bp-workspace', style: { height: 220, overflow: 'hidden', padding: 12 }, onKeyDown: () => setKeys(n => n + 1) },
      h(
        'fieldset',
        { disabled },
        h(
          'fieldset',
          null,
          h(
            StyledSelect,
            { 'aria-label': 'Example', value, onChange: event => setValue(event.currentTarget.value) },
            h('option', { value: 'disabled', disabled: true }, 'Unavailable'),
            h('option', { value: 'alpha raw / value' }, 'Alpha'),
            h('option', { value: 'alpine' }, 'Alpine'),
            h('option', { value: 'beta' }, 'Beta'),
            ...Array.from({ length: 70 }, (_, index) =>
              h('option', { key: index, value: `long-${index}` }, `Long option ${index} with wrapped descriptive text`)
            )
          )
        )
      ),
      h('button', { id: 'toggle-disabled', onClick: () => setDisabled(v => !v) }, 'Toggle disabled'),
      h('button', { id: 'open-confirm', onClick: () => setConfirm(true) }, 'Open confirmation'),
      h('output', { id: 'value' }, value),
      h('output', { id: 'accepted' }, accepted),
      h('output', { id: 'keys' }, keys),
      confirm &&
        h(ConfirmationDialog, {
          React,
          title: 'Confirm action',
          description: 'Synthetic action only',
          cancelLabel: 'Cancel',
          confirmLabel: 'Confirm',
          onCancel: () => setConfirm(false),
          onConfirm: () => {
            setAccepted(n => n + 1)
            setConfirm(false)
          }
        })
    ),
    h('div', { style: { height: 650 } }, h(Panel, { t }))
  )
}
installCanvasStyles()
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).has('delayed-catalog')
    ? h(
        'div',
        { style: { height: '100vh' } },
        h('button', { id: 'release-catalog', onClick: releaseCatalog }, 'Release synthetic catalog'),
        h(DelayedPanel, { t })
      )
    : h(Fixture)
)
