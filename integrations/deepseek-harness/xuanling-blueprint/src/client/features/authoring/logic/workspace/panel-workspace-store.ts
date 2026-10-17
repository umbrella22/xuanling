/** React lifetime and external-store wiring for one production Panel instance. */
import type React from 'react'
import type { BlueprintWorkspace } from './workspace-controller.ts'
import { createPanelWorkspaceBinding } from '../../ui/panel/panel-workspace-binding.ts'
import type { PanelWorkspaceBinding } from '../../ui/panel/panel-workspace-binding.ts'

export function usePanelWorkspaceStore(workspace: BlueprintWorkspace, react: typeof React) {
  const owner = react.useRef<{ workspace: BlueprintWorkspace; binding: PanelWorkspaceBinding } | null>(null)
  if (owner.current?.workspace !== workspace) owner.current = { workspace, binding: createPanelWorkspaceBinding(workspace) }
  const binding = owner.current.binding
  const snapshot = react.useSyncExternalStore(workspace.subscribe, workspace.getSnapshot, workspace.getSnapshot)
  react.useEffect(() => binding.acquire(), [binding])
  return { snapshot, binding }
}
