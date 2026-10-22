/** Document navigation and validated draft recovery; controller state has one owner. */
import type { BlueprintDefinition } from '../../../../../definition/types.ts'
import { readHostDefinition } from './document.ts'
import { GraphEditor } from '../graph/graph-editor.ts'
import type { CatalogValue, DefinitionDocument, HostLink } from '../../../../adapters/host/remote.ts'
import type { WorkspaceNotice } from '../../../../shared/contracts/view-contract.ts'
import { errorNotice } from './workspace-errors.ts'

export interface WorkspaceDraftCreation {
  requestId: string
  submittedJson?: string
}
export interface WorkspaceNavigationContext {
  readonly host: Pick<HostLink, 'listDefinitions' | 'loadDefinition' | 'validate'> | undefined
  read(): { disposed: boolean; generation: number; blueprintId: string | null; catalog: CatalogValue['definitions']; runId: string | null }
  assertActive(): void
  batch(action: () => void): void
  beginDraft(requestId: string): string
  beginLoad(placeholder: BlueprintDefinition): number
  finishDraft(definition: BlueprintDefinition): void
  restoreNewDraft(creation: WorkspaceDraftCreation, definition: BlueprintDefinition): void
  installDocument(document: DefinitionDocument | null, definition: BlueprintDefinition): void
  restoreDocumentDraft(definition: BlueprintDefinition): void
  rejectDocumentDraft(): void
  setCatalog(catalog: CatalogValue['definitions']): void
  setNotice(notice: WorkspaceNotice): void
  readNewDraft(): string | null | undefined
  readDocumentDraft(blueprintId: string): string | null | undefined
  restoreRunBinding(blueprintId: string): void
  persistDraft(): void
  refreshResources(): Promise<void>
  newDraft(name: string): void
  inspect(): Promise<void>
  emit(): void
}

export function newWorkspaceDraft(context: WorkspaceNavigationContext, name = 'Untitled blueprint'): void {
  if (context.read().disposed) return
  context.batch(() => {
    const id = context.beginDraft(crypto.randomUUID())
    context.finishDraft({ schemaVersion: 2, id, name, resources: {}, graph: { nodes: [], edges: [] } })
    context.persistDraft()
    context.emit()
  })
}

export async function initializeWorkspace(context: WorkspaceNavigationContext, draftName = 'Untitled blueprint'): Promise<void> {
  context.assertActive()
  if (!context.host) {
    context.setNotice({ key: 'status.hostUnavailable' })
    context.emit()
    return
  }
  const generation = context.read().generation
  try {
    await context.refreshResources()
    if (context.read().disposed || generation !== context.read().generation) return
    const catalog = (await context.host.listDefinitions()).definitions
    if (generation !== context.read().generation) return
    context.setCatalog(catalog)
    if (!context.read().blueprintId) {
      let restored = false
      try {
        const raw = context.readNewDraft()
        if (raw) {
          const draft = JSON.parse(raw) as { requestId?: unknown; definitionJson?: unknown; submittedJson?: unknown } | null
          if (draft !== null && (typeof draft?.requestId !== 'string' || typeof draft?.definitionJson !== 'string')) throw new Error('Invalid local draft')
          if (draft && typeof draft.requestId === 'string' && typeof draft.definitionJson === 'string') {
            const id = `draft-${draft.requestId}`
            const validation = await context.host.validate(draft.definitionJson)
            if (generation !== context.read().generation) return
            if (validation.ok !== true) throw new Error('Draft was not accepted by host validator')
            const definition = readHostDefinition(draft.definitionJson, id)
            if (draft.submittedJson !== undefined) {
              if (typeof draft.submittedJson !== 'string') throw new Error('Invalid pending creation')
              readHostDefinition(draft.submittedJson, id)
            }
            context.restoreNewDraft(
              { requestId: draft.requestId, ...(typeof draft.submittedJson === 'string' ? { submittedJson: draft.submittedJson } : {}) },
              definition
            )
            restored = true
          }
        }
      } catch {
        if (generation !== context.read().generation) return
        context.setNotice({ key: 'status.draftInvalid' })
        context.emit()
        return
      }
      if (!restored) {
        if (!catalog.length) context.newDraft(draftName)
        else context.setNotice({ key: 'status.chooseBlueprint' })
      }
    }
  } catch (error) {
    if (context.read().disposed || generation !== context.read().generation) return
    context.setNotice(errorNotice(error))
  }
  context.emit()
}

export async function loadWorkspaceDocument(context: WorkspaceNavigationContext, blueprintId: string): Promise<void> {
  context.assertActive()
  if (!context.host) throw new Error('Host link unavailable')
  const catalog = context.read().catalog.find(d => d.blueprintId === blueprintId)
  if (!catalog) throw new Error('Blueprint not in configured catalog')
  let generation!: number
  context.batch(() => {
    generation = context.beginLoad({ schemaVersion: 2, id: blueprintId, name: catalog.name, resources: {}, graph: { nodes: [], edges: [] } })
    context.emit()
  })
  if (context.read().disposed || generation !== context.read().generation) return
  const document = catalog.documentRevision === null ? null : await context.host.loadDefinition(blueprintId)
  if (generation !== context.read().generation) return
  const definition: BlueprintDefinition = document
    ? readHostDefinition(document.definitionJson, blueprintId)
    : { schemaVersion: 2, id: blueprintId, name: catalog.name, resources: {}, graph: { nodes: [], edges: [] } }
  if (definition.id !== blueprintId || (document && document.blueprintId !== blueprintId)) throw new Error('Unrelated definition response')
  context.installDocument(document, definition)
  try {
    const stored = context.readDocumentDraft(blueprintId)
    if (stored) {
      const draft = JSON.parse(stored) as { documentRevision: string | null; definitionJson?: string; layout: Parameters<GraphEditor['importLayout']>[0] }
      if (draft.documentRevision === (document?.documentRevision ?? null)) {
        const draftJson = draft.definitionJson ?? JSON.stringify(definition)
        const validation = await context.host.validate(draftJson)
        if (generation !== context.read().generation) return
        if (validation.ok !== true) throw new Error('Draft was not accepted by host validator')
        const restored = readHostDefinition(draftJson, blueprintId)
        const candidate = GraphEditor.fromDefinition(restored)
        candidate.importLayout(draft.layout)
        context.restoreDocumentDraft(candidate.exportDefinition())
      } else context.setNotice({ key: 'status.draftStale' })
    }
  } catch {
    if (generation !== context.read().generation) return
    context.rejectDocumentDraft()
    context.setNotice({ key: 'status.draftInvalid' })
  }
  context.batch(() => {
    context.restoreRunBinding(blueprintId)
    context.emit()
  })
  if (context.read().runId) {
    // Refresh/reopen observes durable facts; the stored binding is not a command.
    try {
      await context.inspect()
    } catch (error) {
      if (generation === context.read().generation) {
        context.setNotice(errorNotice(error))
        context.emit()
      }
    }
  }
}
