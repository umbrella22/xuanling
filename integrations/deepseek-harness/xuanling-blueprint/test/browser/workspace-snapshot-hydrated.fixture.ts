// Production Workspace instances, actual React external-store subscription.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { BlueprintWorkspace } from '../../src/client/features/authoring/logic/workspace/workspace-controller.ts'
const first = new BlueprintWorkspace(undefined)
const second = new BlueprintWorkspace(undefined)
const roots = [createRoot(document.getElementById('first')!), createRoot(document.getElementById('second')!)]
const notifications = [0, 0]
const renders = [0, 0]
const subscriptions = [0, 0]
const workspaces = [first, second]
const subscribe = workspaces.map((workspace, index) => (callback: () => void) => {
  subscriptions[index]!++
  const off = workspace.subscribe(() => {
    notifications[index]!++
    callback()
  })
  return () => {
    subscriptions[index]!--
    off()
  }
})
function Consumer({ index }: { index: number }) {
  const workspace = workspaces[index]!
  const snapshot = React.useSyncExternalStore(subscribe[index]!, workspace.getSnapshot)
  renders[index]!++
  return React.createElement(
    'output',
    { 'data-consumer': index },
    JSON.stringify({
      input: snapshot.inputJson,
      notice: snapshot.notice.key,
      busy: snapshot.busy,
      selection: snapshot.editor.selection,
      connection: snapshot.run.connectionState
    })
  )
}
const render = (index: number) => roots[index]!.render(React.createElement(Consumer, { index }))
render(0)
render(1)
let release: (() => void) | undefined
Object.assign(window, {
  workspaceSnapshotFixture: {
    render,
    input(index: number, text: string) {
      workspaces[index]!.inputJson = text
    },
    selection(index: number, values: string[]) {
      workspaces[index]!.editor.setSelection(values)
    },
    disconnected(index: number) {
      workspaces[index]!.model.markDisconnected()
    },
    async beginBusy(index: number) {
      void workspaces[index]!.perform(
        () =>
          new Promise<void>(resolve => {
            release = resolve
          })
      )
    },
    finishBusy() {
      release?.()
    },
    newDraft(index: number) {
      workspaces[index]!.newDraft('Synthetic draft')
    },
    stable(index: number) {
      return workspaces[index]!.getSnapshot() === workspaces[index]!.getSnapshot()
    },
    stats() {
      return { notifications: [...notifications], renders: [...renders], subscriptions: [...subscriptions] }
    },
    unmount(index: number) {
      roots[index]!.unmount()
    }
  }
})
