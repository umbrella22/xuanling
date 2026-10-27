/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
import React from 'react'
import type { BlueprintLocaleProps } from '../../../../shared/i18n/locales.ts'
import { BlueprintWorkspace } from '../../logic/workspace/workspace-controller.ts'
import { usePanelWorkspaceStore } from '../../logic/workspace/panel-workspace-store.ts'
import { WorkspacePanel } from './panel-controller.tsx'
import type { PanelEnvironment } from './panel-controller.tsx'
import { ModelCatalogController } from '../../../../adapters/host/model-catalog.ts'
export type { PanelEnvironment }
export { resourceRows } from '../../logic/resources/resource-library-model.ts'

export function createBlueprintPanel(env: PanelEnvironment): React.ComponentType<BlueprintLocaleProps> {
  const modelCatalogController = new ModelCatalogController(env.modelCatalog)
  if (env.modelCatalogReady !== undefined) {
    void env.modelCatalogReady.then(link => modelCatalogController.setLink(link))
  }
  return function BlueprintPanel({ t }: BlueprintLocaleProps) {
    const [workspace] = React.useState(() => new BlueprintWorkspace(env.hostLink, env.storage))
    const modelCatalog = React.useSyncExternalStore(modelCatalogController.subscribe, modelCatalogController.getSnapshot, modelCatalogController.getSnapshot)
    React.useEffect(() => {
      void modelCatalogController.load()
    }, [])
    const { snapshot: workspaceSnapshot, binding: workspaceBinding } = usePanelWorkspaceStore(workspace, React)
    return (
      <WorkspacePanel
        env={{ ...env, hostLink: workspace.host }}
        t={t}
        workspace={workspace}
        workspaceSnapshot={workspaceSnapshot}
        workspaceBinding={workspaceBinding}
        modelCatalog={modelCatalog}
      />
    )
  }
}
