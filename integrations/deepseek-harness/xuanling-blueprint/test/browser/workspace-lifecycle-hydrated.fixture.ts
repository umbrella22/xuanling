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
const pending = new Map<number, { release: () => void; done: Promise<void> }>()
const oldEditors = workspaces.map(workspace => workspace.editor)
const oldModels = workspaces.map(workspace => workspace.model)
const disposedSnapshots = new Map<number, ReturnType<BlueprintWorkspace['getSnapshot']>>()
Object.assign(window, {
  workspaceLifecycleFixture: {
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
    beginBusy(index: number) {
      let release!: () => void
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const done = workspaces[index]!.perform(() => held)
      pending.set(index, { release, done })
    },
    async finishBusy(index: number) {
      const action = pending.get(index)!
      action.release()
      await action.done
      pending.delete(index)
    },
    hide(index: number) {
      roots[index]!.render(null)
    },
    dispose(index: number) {
      workspaces[index]!.dispose()
      if (!disposedSnapshots.has(index)) disposedSnapshots.set(index, workspaces[index]!.getSnapshot())
    },
    oldSources(index: number) {
      oldEditors[index]!.setSelection(['after-dispose'])
      oldModels[index]!.markDisconnected()
    },
    disposedStable(index: number) {
      return workspaces[index]!.getSnapshot() === disposedSnapshots.get(index)
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
