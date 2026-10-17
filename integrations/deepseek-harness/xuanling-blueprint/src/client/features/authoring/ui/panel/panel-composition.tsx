/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import React from 'react'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import { usePanelWorkspaceStore } from '../../logic/workspace/panel-workspace-store.ts'
import { WorkspacePanel } from './panel-controller.tsx'
import type { PanelEnvironment } from './panel-controller.tsx'
export type { PanelEnvironment }
export { resourceRows } from '../../logic/resources/resource-library-model.ts'

export function createBlueprintPanel(env: PanelEnvironment): React.ComponentType<BlueprintLocaleProps> {
  return function BlueprintPanel({ t }: BlueprintLocaleProps) {
    const [workspace] = React.useState(() => new BlueprintWorkspace(env.hostLink, env.storage))
    const { snapshot: workspaceSnapshot, binding: workspaceBinding } = usePanelWorkspaceStore(workspace, React)
    return <WorkspacePanel env={env} t={t} workspace={workspace} workspaceSnapshot={workspaceSnapshot} workspaceBinding={workspaceBinding} />
  }
}
