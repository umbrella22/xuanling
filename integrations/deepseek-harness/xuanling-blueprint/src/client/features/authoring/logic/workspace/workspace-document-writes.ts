/** Document writes and archive orchestration; canonical session state stays in Workspace. */
import type { BlueprintDefinition } from '../../../../../definition/types.ts'
import { readHostDefinition } from './document.ts'
import { GraphEditor } from '../graph/graph-editor.ts'
import { BlueprintRemoteError } from '../../../../adapters/host/remote.ts'
import type { BlueprintArchive, CatalogValue, DefinitionDocument, HostLink } from '../../../../adapters/host/remote.ts'
import type { WorkspaceNotice } from '../../../../shared/contracts/view-contract.ts'
import { definitionSemantics } from './workspace-definition-semantics.ts'
import type { WorkspaceDraftCreation } from './workspace-document-navigation.ts'
import { errorCode } from './workspace-errors.ts'

interface WorkspaceDeletion {
  blueprintId: string
  revision: string
  requestId: string
}
export interface WorkspaceDocumentWriteContext {
  readonly host:
    | Pick<HostLink, 'createDefinition' | 'saveDefinition' | 'deleteDefinition' | 'exportDefinition' | 'importDefinition' | 'listDefinitions'>
    | undefined
  read(): {
    disposed: boolean
    generation: number
    blueprintId: string | null
    document: DefinitionDocument | null
    creation: WorkspaceDraftCreation | undefined
    deletion: WorkspaceDeletion | undefined
    nodeCount: number
  }
  assertActive(): void
  isDirty(): boolean
  exportDefinition(): BlueprintDefinition
  adoptCreatedDefinition(definition: BlueprintDefinition): void
  invalidateCheck(): void
  setDocument(document: DefinitionDocument): void
  setBaseline(json: string, semantics: string): void
  upsertCatalog(item: CatalogValue['definitions'][number]): void
  removeCatalog(blueprintId: string): void
  install(definition: BlueprintDefinition): void
  setDeletion(deletion: WorkspaceDeletion): void
  clearNewDraftStorage(): void
  clearIdentityStorage(blueprintId: string): void
  persistDraft(): void
  setNotice(notice: WorkspaceNotice): void
  batch(action: () => void): void
  emit(): void
  save(): Promise<DefinitionDocument>
  newDraft(name: string): void
  initialize(): Promise<void>
  load(blueprintId: string): Promise<void>
}

export async function saveWorkspaceDocument(context: WorkspaceDocumentWriteContext): Promise<DefinitionDocument> {
  context.assertActive()
  if (!context.host || !context.read().blueprintId) throw new Error('No configured definition loaded')
  let id = context.read().blueprintId!
  const generation = context.read().generation
  const creation = context.read().creation
  let submitted = JSON.stringify(context.exportDefinition())
  let doc: DefinitionDocument
  if (creation) {
    if (!context.host.createDefinition) throw new BlueprintRemoteError('blueprint/capability-unavailable')
    creation.submittedJson ??= submitted
    context.persistDraft()
    try {
      doc = await context.host.createDefinition(creation.requestId, creation.submittedJson)
    } catch (error) {
      // Only a definitive rejection permits a corrected payload on this identity.
      // An uncertain write outcome retains the exact request and submitted JSON.
      if (!context.read().disposed && errorCode(error) === 'blueprint/definition-invalid') {
        delete creation.submittedJson
        context.persistDraft()
      }
      throw error
    }
  } else doc = await context.host.saveDefinition(id, submitted, context.read().document?.documentRevision ?? null)
  if (generation !== context.read().generation) throw new Error('Document changed while saving')
  if (creation) {
    const current = context.exportDefinition()
    readHostDefinition(doc.definitionJson, doc.blueprintId)
    id = doc.blueprintId
    submitted = JSON.stringify({ ...JSON.parse(creation.submittedJson!), id })
    context.adoptCreatedDefinition({ ...current, id })
    try {
      context.clearNewDraftStorage()
    } catch {
      /* The saved host document remains authoritative. */
    }
  } else if (doc.blueprintId !== id) throw new Error('Unrelated save response')
  const accepted = readHostDefinition(doc.definitionJson, id)
  if (context.read().document?.documentRevision !== doc.documentRevision) context.invalidateCheck()
  context.setDocument(doc)
  context.setBaseline(JSON.stringify(GraphEditor.fromDefinition(accepted).exportDefinition()), definitionSemantics(accepted))
  context.upsertCatalog({ blueprintId: id, name: accepted.name, documentRevision: doc.documentRevision, semanticRevision: doc.semanticRevision })
  if (JSON.stringify(context.exportDefinition()) === submitted) context.install(accepted)
  context.persistDraft()
  context.setNotice({ key: 'status.saved' })
  context.emit()
  return doc
}

/** The UI confirms discarding edits. Deletion never saves the dirty buffer. */
export async function deleteWorkspaceDocument(context: WorkspaceDocumentWriteContext, draftName = 'Untitled blueprint'): Promise<void> {
  context.assertActive()
  const id = context.read().blueprintId
  if (!id) throw new BlueprintRemoteError('blueprint/definition-not-found')
  const generation = context.read().generation
  if (!context.read().creation) {
    if (!context.host?.deleteDefinition || !context.read().document) throw new BlueprintRemoteError('blueprint/capability-unavailable')
    const revision = context.read().document!.documentRevision
    let deletion = context.read().deletion
    if (deletion?.blueprintId !== id || deletion.revision !== revision) {
      deletion = { blueprintId: id, revision, requestId: crypto.randomUUID() }
      context.setDeletion(deletion)
    }
    const result = await context.host.deleteDefinition(id, revision, deletion.requestId)
    if (result.blueprintId !== id || result.deleted !== true) throw new BlueprintRemoteError('blueprint/dto-invalid')
    if (!context.read().disposed) context.removeCatalog(id)
  }
  // Clear only the deleted identity, including when navigation won the race.
  try {
    context.clearIdentityStorage(id)
    if (context.read().creation && generation === context.read().generation) context.clearNewDraftStorage()
  } catch {
    /* Host deletion is durable even when local storage is unavailable. */
  }
  context.batch(() => {
    if (generation === context.read().generation) {
      context.newDraft(draftName)
      context.setNotice({ key: 'status.deleted' })
    }
    context.emit()
  })
}

/** Saved package closure comes from the existing Host API, never browser files. */
export async function exportWorkspaceArchive(context: WorkspaceDocumentWriteContext): Promise<BlueprintArchive> {
  context.assertActive()
  if (!context.host?.exportDefinition || !context.read().blueprintId) throw new BlueprintRemoteError('blueprint/capability-unavailable')
  const generation = context.read().generation
  if (context.isDirty() || !context.read().document) await context.save()
  const id = context.read().blueprintId!
  if (generation !== context.read().generation || context.isDirty()) throw new BlueprintRemoteError('blueprint/document-stale')
  const revision = context.read().document?.documentRevision
  const archive = await context.host.exportDefinition(id)
  if (
    generation !== context.read().generation ||
    id !== context.read().blueprintId ||
    context.isDirty() ||
    revision !== context.read().document?.documentRevision
  )
    throw new BlueprintRemoteError('blueprint/document-stale')
  if (archive.blueprintId !== id) throw new BlueprintRemoteError('blueprint/dto-invalid')
  return archive
}

/** Confirmation is UI-owned; the Host authoritatively checks target and closure. */
export async function importWorkspaceArchive(
  context: WorkspaceDocumentWriteContext,
  blueprintId: string,
  archiveBase64: string,
  confirmedId: string
): Promise<void> {
  context.assertActive()
  if (!context.host?.importDefinition) throw new BlueprintRemoteError('blueprint/capability-unavailable')
  if (confirmedId !== blueprintId) throw new BlueprintRemoteError('blueprint/import-confirmation-required')
  const generation = context.read().generation
  const catalog = (await context.host.listDefinitions()).definitions
  if (generation !== context.read().generation) throw new BlueprintRemoteError('blueprint/document-stale')
  const target = catalog.find(d => d.blueprintId === blueprintId)
  if (!target) throw new BlueprintRemoteError('blueprint/configured-id-required')
  if (
    target.documentRevision !== null ||
    (context.read().blueprintId === blueprintId && (context.read().nodeCount || Object.keys(context.exportDefinition().resources).length || context.isDirty()))
  )
    throw new BlueprintRemoteError('blueprint/import-target-nonempty')
  const result = await context.host.importDefinition(blueprintId, archiveBase64)
  if (result.blueprintId !== blueprintId) throw new BlueprintRemoteError('blueprint/dto-invalid')
  if (generation !== context.read().generation) return
  await context.initialize()
  if (generation !== context.read().generation) return
  await context.load(blueprintId)
}
