/** Per-Panel command admission; Workspace remains the canonical state owner. */
import type { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import type { WorkspaceIntent, WorkspaceIntentResults } from '../../logic/workspace/workspace-intents.ts'
import type { WorkspaceViewBinding } from '../../../../shared/contracts/view-contract.ts'

export type PanelWorkspaceDispatch = <I extends WorkspaceIntent>(intent: I) => WorkspaceIntentResults[I['type']]
type PanelWorkspace = Pick<BlueprintWorkspace, 'getSnapshot' | 'acceptsViewBinding' | 'dispatch' | 'perform' | 'dispose'>

export function createPanelWorkspaceBinding(workspace: PanelWorkspace) {
  let active = true
  let disposal = 0
  let disposed = false
  const rejected = Symbol('inactive-panel-command')
  return {
    acquire(): () => void {
      if (disposed) return () => {}
      active = true
      disposal++
      return () => {
        active = false
        const pending = ++disposal
        // React StrictMode replays setup with this same Workspace instance.
        // The lease closes immediately; only permanent disposal is deferred.
        queueMicrotask(() => {
          if (pending !== disposal || active || disposed) return
          disposed = true
          workspace.dispose()
        })
      }
    },
    capture(binding: WorkspaceViewBinding) {
      const isCurrent = () => active && !disposed && workspace.acceptsViewBinding(binding)
      const admitted = (intent: WorkspaceIntent, foreground = false) => {
        if (!isCurrent()) return false
        const current = workspace.getSnapshot()
        if (intent.type === 'set-input') return true
        if (current.busy && !foreground) return false
        switch (intent.type) {
          case 'new-draft':
          case 'initialize':
          case 'refresh-resources':
            return true
          case 'import':
            return current.capabilities.canImport
          case 'export':
            return current.capabilities.canExport && current.blueprintId !== null
          case 'save':
            return current.capabilities.hostAvailable && current.blueprintId !== null && (!current.isNewDraft || current.capabilities.canCreate)
          case 'delete':
            return current.blueprintId !== null && (current.isNewDraft || (current.capabilities.hostAvailable && current.document !== null))
          case 'check-run':
          case 'run':
            return current.capabilities.canPreflight && current.blueprintId !== null
          case 'load':
          case 'bind-run':
            return current.capabilities.hostAvailable
          case 'inspect':
          case 'cancel':
          case 'decide':
            return current.capabilities.hostAvailable && current.run.runId !== null
        }
      }
      return {
        isCurrent,
        dispatch<I extends WorkspaceIntent>(intent: I): WorkspaceIntentResults[I['type']] | undefined {
          if (!admitted(intent)) return
          return workspace.dispatch(intent)
        },
        perform(action: (dispatch: PanelWorkspaceDispatch) => Promise<unknown>): Promise<void> {
          if (!isCurrent() || workspace.getSnapshot().busy) return Promise.resolve()
          return workspace.perform(async () => {
            const dispatch: PanelWorkspaceDispatch = intent => {
              if (!admitted(intent, true)) throw rejected
              return workspace.dispatch(intent)
            }
            try {
              await action(dispatch)
            } catch (error) {
              if (error !== rejected) throw error
            }
          })
        }
      }
    }
  }
}
export type PanelWorkspaceBinding = ReturnType<typeof createPanelWorkspaceBinding>
