/** Synthetic renderer adapters exercise real controls against the production controller. */
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
import { InspectorSession } from '../../src/client/features/authoring/ui/inspector/inspector-composition.tsx'
import { StyledSelect, ConfirmationDialog } from '../../src/client/shared/controls/styled-controls.ts'
import { JsonEditor } from '../../src/client/features/authoring/logic/inspector/json-editor.ts'
import { InteractionOverlay } from '../../src/client/features/authoring/ui/overlays/interaction-overlays.tsx'
import { acceptsSelectIntent, acceptsConfirmationIntent, acceptsOverlayIntent, acceptsJsonIntent } from '../../src/client/shared/contracts/view-contract.ts'
import type { SelectViewState, ConfirmationViewState, OverlayViewState, JsonViewState } from '../../src/client/shared/contracts/view-contract.ts'
import { en } from '../../src/client/shared/i18n/locales.ts'
import { installCanvasStyles } from '../../src/client/shared/styles/styles.ts'
const h = React.createElement
const t = (key: keyof typeof en) => en[key]
const calls: string[] = []
const workspace = new BlueprintWorkspace({
  async loadDefinition(id) {
    calls.push(`load:${id}`)
    return {
      blueprintId: id,
      documentRevision: `doc-${id}`,
      semanticRevision: `sem-${id}`,
      layoutRevision: 'layout',
      definitionJson: JSON.stringify({ schemaVersion: 1, id, name: id, resources: {}, graph: { nodes: [], edges: [] } })
    }
  }
})
workspace.catalog = ['a', 'b'].map(id => ({ blueprintId: id, name: id, documentRevision: `doc-${id}`, semanticRevision: `sem-${id}` }))
await workspace.load('a')
function node() {
  return workspace.editor.nodes[0] ?? workspace.editor.addNode({ id: 'input', kind: 'input', label: 'Input', x: 0, y: 0, inputs: {}, outputs: {} })
}
node()
let stale: (() => Promise<void>) | undefined
function Fixture() {
  const snapshot = React.useSyncExternalStore(workspace.subscribe, workspace.getSnapshot)
  const session = React.useMemo(() => new InspectorSession(workspace.editor, node().id), [workspace.editor])
  const inspector = React.useSyncExternalStore(session.subscribe, session.getSnapshot)
  const [confirm, showConfirm] = React.useState(false),
    [overlay, showOverlay] = React.useState(false)
  const root = React.useRef<HTMLDivElement>(null)
  const select: SelectViewState = {
    binding: snapshot.binding,
    value: snapshot.blueprintId ?? '',
    disabled: snapshot.busy,
    options: ['a', 'b'].map(value => ({ value, label: value }))
  }
  const confirmation: ConfirmationViewState = {
    binding: snapshot.binding,
    action: { type: 'load-blueprint', blueprintId: 'b' },
    title: 'Load B?',
    cancelLabel: 'Cancel',
    confirmLabel: 'Confirm'
  }
  const overlayState: OverlayViewState = { binding: snapshot.binding, kind: 'rename' }
  const json: JsonViewState = {
    binding: snapshot.binding,
    nodeId: session.nodeId,
    field: 'outputs',
    buffer: inspector.json.outputs,
    disabled: false,
    notice: inspector.notice
  }
  const selectIntent = async (value: string) => {
    const intent = { type: 'select-change', binding: select.binding, value }
    if (acceptsSelectIntent(select, intent) && workspace.acceptsViewBinding(intent.binding))
      await workspace.dispatch({ type: 'load', blueprintId: intent.value })
  }
  const confirmIntent = async (decision: 'confirm' | 'cancel') => {
    const intent = { type: 'confirmation', binding: confirmation.binding, action: confirmation.action, decision }
    if (!acceptsConfirmationIntent(confirmation, intent) || !workspace.acceptsViewBinding(intent.binding)) return
    showConfirm(false)
    if (intent.decision === 'confirm' && intent.action.type === 'load-blueprint')
      await workspace.dispatch({ type: 'load', blueprintId: intent.action.blueprintId })
  }
  const renameIntent = (value: string) => {
    const intent = { type: 'overlay-rename', binding: overlayState.binding, value }
    if (!acceptsOverlayIntent(overlayState, intent) || !workspace.acceptsViewBinding(intent.binding)) return
    workspace.editor.renameDefinition(value)
    showOverlay(false)
  }
  const jsonIntent = (type: 'json-buffer-change' | 'json-commit' | 'json-cancel', text = '') => {
    const intent = { type, binding: json.binding, nodeId: json.nodeId, field: json.field, text }
    if (!acceptsJsonIntent(json, intent) || !workspace.acceptsViewBinding(intent.binding)) return
    if (intent.type === 'json-buffer-change') session.setJson('outputs', text)
    if (intent.type === 'json-commit') session.applyJson('outputs')
    if (intent.type === 'json-cancel') session.setJson('outputs', JSON.stringify(session.currentNode()!.outputs, null, 2))
  }
  return h(
    'div',
    { ref: root, className: 'bp-workspace', style: { height: '100vh', padding: 20 } },
    h(
      StyledSelect,
      { 'aria-label': 'Blueprint', value: select.value, onChange: event => void selectIntent(event.currentTarget.value) },
      ...select.options.map(option => h('option', { key: option.value, value: option.value }, option.label))
    ),
    h('button', { id: 'confirm-open', onClick: () => showConfirm(true) }, 'Open confirmation'),
    h('button', { id: 'rename-open', onClick: () => showOverlay(true) }, 'Rename'),
    h(
      'button',
      {
        id: 'capture',
        onClick: () => {
          stale = async () => {
            await selectIntent('b')
            await confirmIntent('confirm')
            renameIntent('STALE')
            jsonIntent('json-buffer-change', '{"stale":"string"}')
            jsonIntent('json-commit')
          }
        }
      },
      'Capture old callbacks'
    ),
    h(JsonEditor, { value: json.buffer, label: 'Outputs JSON', t, onChange: text => jsonIntent('json-buffer-change', text) }),
    h('button', { id: 'json-apply', onClick: () => jsonIntent('json-commit') }, 'Apply JSON'),
    h('button', { id: 'json-cancel', onClick: () => jsonIntent('json-cancel') }, 'Cancel JSON'),
    h(
      'output',
      { id: 'state' },
      JSON.stringify({
        id: snapshot.blueprintId,
        name: workspace.editor.exportDefinition().name,
        outputs: session.currentNode()!.outputs,
        notice: inspector.notice,
        calls
      })
    ),
    confirm && h(ConfirmationDialog, { React, ...confirmation, onConfirm: () => void confirmIntent('confirm'), onCancel: () => void confirmIntent('cancel') }),
    overlay &&
      h(InteractionOverlay, {
        React,
        root,
        t,
        overlay: { kind: 'rename', targetId: session.nodeId, group: false, value: workspace.editor.exportDefinition().name, screen: { x: 40, y: 80 } },
        commands: [],
        importTargets: [],
        onCommand: () => {},
        onAdd: () => {},
        onRename: renameIntent,
        onClose: () => showOverlay(false)
      })
  )
}
Object.assign(window, {
  viewInterfacesFixture: {
    async replay() {
      await stale?.()
    },
    switchEditor() {
      workspace.newDraft('Replacement')
      node()
    },
    stats() {
      return { calls: [...calls], definition: workspace.editor.exportDefinition() }
    }
  }
})
installCanvasStyles()
createRoot(document.getElementById('root')!).render(h(Fixture))
