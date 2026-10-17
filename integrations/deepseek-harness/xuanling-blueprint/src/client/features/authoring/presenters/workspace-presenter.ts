/** Pure display projection. Translation and browser effects belong to renderer seats. */
import type { WorkspaceSnapshot } from '../logic/workspace/workspace-snapshot.ts'
import { resourceRows } from '../logic/resources/resource-library-model.ts'
import type { ResourceLibraryRow } from '../logic/resources/resource-library-model.ts'

export type WorkspaceResourceRow = Omit<ResourceLibraryRow, 'ref'>
/** Only public, portable resource identity/configuration fields reach display rows. */
function displayRow(row: ResourceLibraryRow): WorkspaceResourceRow {
  return {
    key: row.key,
    id: row.id,
    kind: row.kind,
    displayName: row.displayName,
    source: row.source,
    availability: row.availability,
    description: row.description,
    configuration: row.configuration,
    metadata: row.metadata,
    ...(row.refId ? { refId: row.refId } : {})
  }
}

export function presentWorkspace(snapshot: WorkspaceSnapshot) {
  const resources = resourceRows(snapshot.definition, snapshot.resources.entries, snapshot.resources.state)
  const run = snapshot.run.snapshot
  const preflight = snapshot.preflight
  return {
    capabilities: snapshot.capabilities,
    document: {
      id: snapshot.blueprintId,
      name: snapshot.definition?.name ?? '',
      isNewDraft: snapshot.isNewDraft,
      dirty: snapshot.dirty,
      revisionStateKey: snapshot.dirty
        ? ('document.unsaved' as const)
        : snapshot.isNewDraft
          ? ('document.newDraft' as const)
          : snapshot.document
            ? ('document.saved' as const)
            : ('document.none' as const),
      documentRevision: snapshot.document?.documentRevision ?? null,
      options: snapshot.catalog.map(item => ({ id: item.blueprintId, name: item.name })),
      deleteDisabled: snapshot.busy || !snapshot.blueprintId || (!snapshot.isNewDraft && !snapshot.document),
      needsNavigationConfirmation: snapshot.needsNavigationConfirmation
    },
    resources: {
      agent: resources.agent.map(displayRow),
      skill: resources.skill.map(displayRow),
      mcp: resources.mcp.map(displayRow),
      other: resources.other.map(displayRow)
    },
    resourceState: snapshot.resources.state,
    run: {
      boundRunId: snapshot.run.runId,
      runId: run?.runId ?? null,
      state: run?.state ?? null,
      definitionRevision: run?.definitionRevision ?? null,
      connectionState: snapshot.run.connectionState,
      overlayEligible: snapshot.run.overlayEligible,
      hasDetails: run !== null
    },
    preflight: {
      status: preflight?.status ?? ('none' as const),
      code: preflight?.code ?? null,
      documentRevision: preflight?.report ? preflight.documentRevision : null,
      checks: preflight?.report?.checks ?? [],
      warningCount: preflight?.report?.checks.filter(check => check.status === 'warning').length ?? 0
    },
    inputJson: snapshot.inputJson,
    notice: snapshot.notice,
    busy: snapshot.busy
  }
}
export type WorkspacePresentation = ReturnType<typeof presentWorkspace>
