/** Executable editing/session model shared by the production panel and source contracts. */
import { assertWorkspaceIntent } from './workspace-intents.ts'
import type { WorkspaceIntent, WorkspaceIntentResults } from './workspace-intents.ts'
import { snapshotValue } from './workspace-snapshot.ts'
import type { WorkspaceSnapshot } from './workspace-snapshot.ts'
import { refreshWorkspaceResources } from '../resources/workspace-resource-use-cases.ts'
import { definitionSemantics } from './workspace-definition-semantics.ts'
import { errorCode, errorNotice } from './workspace-errors.ts'
import { newWorkspaceDraft, initializeWorkspace, loadWorkspaceDocument } from './workspace-document-navigation.ts'
import type { WorkspaceNavigationContext } from './workspace-document-navigation.ts'
import { saveWorkspaceDocument, deleteWorkspaceDocument, exportWorkspaceArchive, importWorkspaceArchive } from './workspace-document-writes.ts'
import type { WorkspaceDocumentWriteContext } from './workspace-document-writes.ts'
import { checkWorkspaceRun, runWorkspace, inspectWorkspaceRun, cancelWorkspaceRun, decideWorkspaceRun } from '../run/workspace-run-use-cases.ts'
import type { WorkspaceRunBinding, WorkspaceRunContext } from '../run/workspace-run-use-cases.ts'
import type { BlueprintDefinition } from '../../../../../definition/types.ts'
import { viewportKey } from '../graph/viewport-state.ts'
import { GraphEditor } from '../graph/graph-editor.ts'
import { BlueprintClientModel } from '../run/client-model.ts'
import type { PreflightRunValue } from '../../../../adapters/host/remote.ts'
import type { CatalogValue, DefinitionDocument, HostLink, HostResourceCatalogEntry } from '../../../../adapters/host/remote.ts'
import type { WorkspaceNotice, WorkspaceViewBinding } from '../../../../shared/contracts/view-contract.ts'
import type { LibraryRef, LibrarySummary } from '../../../../adapters/host/remote.ts'
import { scopeBlueprintHost } from '../../../../adapters/host/remote.ts'
import { libraryKey } from '../../../../../definition/library-ref.ts'
import { refreshWorkspaceLibraries } from './workspace-library-use-cases.ts'
import { isWorkspaceViewBinding, sameWorkspaceViewBinding } from '../../../../shared/contracts/view-contract.ts'

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}
const keyScope = (library: LibraryRef | undefined): string => (library === undefined ? '' : `${libraryKey(library)}:`)
export const draftKey = (blueprintId: string, library?: LibraryRef): string => `xuanling-blueprint:draft:${keyScope(library)}${encodeURIComponent(blueprintId)}`
export const newDraftKey = (library?: LibraryRef): string => `xuanling-blueprint:new-draft${library === undefined ? '' : `:${libraryKey(library)}`}`
export const runBindingKey = (blueprintId: string, library?: LibraryRef): string =>
  `xuanling-blueprint:recent-run:${keyScope(library)}${encodeURIComponent(blueprintId)}`
export function sameLibrary(a: LibraryRef, b: LibraryRef): boolean {
  if (a.kind !== b.kind) return false
  return a.kind === 'global' || a.workspaceId === (b as { workspaceId?: string }).workspaceId
}
function assetToCatalog(asset: LibrarySummary['assets'][number]): CatalogValue['definitions'][number] {
  return {
    blueprintId: asset.blueprintId,
    name: asset.name,
    documentRevision: asset.documentRevision,
    semanticRevision: asset.semanticRevision
  }
}
export function isEditingTarget(target: unknown): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null
  return (
    !!element && (/^(INPUT|TEXTAREA|SELECT)$/i.test(element.tagName ?? '') || !!element.isContentEditable || !!element.closest?.('[contenteditable="true"]'))
  )
}

export interface WorkspacePreflight {
  status: 'checking' | 'current' | 'stale' | 'unavailable' | 'failed'
  blueprintId: string
  documentRevision: string
  inputJson: string
  generation: number
  report?: PreflightRunValue
  code?: string
}

/** Client-only lifecycle failure; never part of the Host wire vocabulary. */
export class WorkspaceDisposedError extends Error {
  readonly code = 'blueprint/workspace-disposed'
  constructor() {
    super('blueprint/workspace-disposed')
    this.name = 'WorkspaceDisposedError'
  }
}

export class BlueprintWorkspace {
  dispatch<I extends WorkspaceIntent>(intent: I): WorkspaceIntentResults[I['type']]
  dispatch(intent: WorkspaceIntent): WorkspaceIntentResults[WorkspaceIntent['type']] {
    assertWorkspaceIntent(intent)
    this.assertActive()
    switch (intent.type) {
      case 'set-input':
        this.inputJson = intent.inputJson
        return
      case 'bind-run':
        this.runId = intent.runId
        return
      case 'new-draft':
        return this.newDraft(intent.name)
      case 'initialize':
        return this.initialize(intent.draftName)
      case 'refresh-resources':
        return this.refreshResources()
      case 'refresh-libraries':
        return this.refreshLibraries()
      case 'select-library':
        return this.selectLibrary(intent.library)
      case 'load':
        return this.load(intent.blueprintId)
      case 'save':
        return this.save()
      case 'delete':
        return this.deleteCurrent(intent.draftName)
      case 'export':
        return this.exportArchive()
      case 'import':
        return this.importArchive(intent.blueprintId, intent.archiveBase64, intent.confirmedId)
      case 'check-run':
        return this.checkRun()
      case 'run':
        return this.run()
      case 'inspect':
        return this.inspect()
      case 'cancel':
        return this.cancel()
      case 'decide':
        return this.decide(intent.action)
    }
  }
  readonly model = new BlueprintClientModel()
  editor = new GraphEditor()
  catalog: CatalogValue['definitions'] = []
  /** Cascade projection. `catalog` is always the selected library's assets. */
  libraries: LibrarySummary[] = []
  library: LibraryRef = { kind: 'global' }
  libraryState: 'loading' | 'current' | 'unavailable' = 'loading'
  resourceCatalog: HostResourceCatalogEntry[] = []
  resourceCatalogState: 'loading' | 'current' | 'unavailable' = 'loading'
  document: DefinitionDocument | null = null
  blueprintId: string | null = null
  private creation: { requestId: string; submittedJson?: string } | undefined
  get isNewDraft(): boolean {
    return this.creation !== undefined
  }
  private boundRunId: string | null = null
  notice: WorkspaceNotice = { key: 'status.loading' }
  busy = false
  private input = '{}'
  private checkEpoch = 0
  private checkRead = 0
  private checkBinding: WorkspaceRunBinding | undefined
  private observedSemantics = ''
  get inputJson(): string {
    return this.input
  }
  set inputJson(value: string) {
    if (this.disposed || this.input === value) return
    this.input = value
    this.invalidateCheck()
    this.emit()
  }
  private invalidateCheck(): void {
    this.checkEpoch++
    if (this.checkBinding) this.checkBinding.status = 'stale'
  }
  private checkCurrent(binding: WorkspaceRunBinding, semantics = this.editorSemantics): boolean {
    return (
      binding.epoch === this.checkEpoch &&
      binding.generation === this.generation &&
      binding.blueprintId === this.blueprintId &&
      binding.documentRevision === this.document?.documentRevision &&
      binding.inputJson === this.inputJson &&
      binding.semantics === semantics
    )
  }
  get preflight(): WorkspacePreflight | undefined {
    if (!this.checkBinding) return undefined
    const { epoch: _epoch, semantics: _semantics, ...view } = this.checkBinding
    return structuredClone({ ...view, status: this.checkCurrent(this.checkBinding) ? view.status : 'stale' })
  }
  private baselineJson = ''
  private baselineSemantics = ''
  private generation = 0
  private readonly instanceId = `workspace-${Math.random().toString(36).slice(2)}`
  private editorEpoch = 0
  private resourceReadGeneration = 0
  private libraryReadGeneration = 0
  private restoring = false
  private disposed = false
  private batchDepth = 0
  private pendingNotification = false
  private unsubscribeModel: (() => void) | undefined
  private assertActive(): void {
    if (this.disposed) throw new WorkspaceDisposedError()
  }
  /** Owner lifetime, distinct from an individual React subscriber's cleanup. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.resourceReadGeneration++
    this.checkRead++
    this.checkEpoch++
    this.model.invalidatePendingObservations()
    this.unsubscribeEditor?.()
    this.unsubscribeModel?.()
    this.listeners.clear()
    this.pendingNotification = false
  }
  private batch<T>(action: () => T): T {
    this.batchDepth++
    try {
      return action()
    } finally {
      this.batchDepth--
      if (!this.batchDepth && this.pendingNotification) {
        this.pendingNotification = false
        this.emit()
      }
    }
  }
  private unsubscribeEditor: (() => void) | undefined
  private readonly listeners = new Set<() => void>()
  private readonly decisions = new Map<string, string>()
  private deletion: { blueprintId: string; revision: string; requestId: string } | undefined
  private pendingStart: { signature: string; requestId: string } | undefined
  private published!: WorkspaceSnapshot
  private editorSnapshot!: WorkspaceSnapshot['editor']
  private definitionSnapshot: WorkspaceSnapshot['definition'] = null
  private editorJson = ''
  private editorSemantics = ''
  /** Stable bound reader: publication happens on the existing notification paths. */
  readonly getSnapshot = (): WorkspaceSnapshot => this.published
  private captureEditor(hasDefinition: boolean): void {
    const definition = hasDefinition ? this.editor.exportDefinition() : null
    this.definitionSnapshot = snapshotValue(definition, this.definitionSnapshot)
    this.editorJson = definition ? JSON.stringify(definition) : ''
    this.editorSemantics = definition ? definitionSemantics(definition) : ''
    this.editorSnapshot = snapshotValue(
      {
        nodes: this.editor.nodes,
        edges: this.editor.edges,
        groups: this.editor.groups,
        selection: [...this.editor.selection],
        canUndo: this.editor.canUndo,
        canRedo: this.editor.canRedo
      },
      this.editorSnapshot
    )
  }
  private publish(): void {
    const previous = this.published
    const document = this.document
    const view = this.model.view
    let preflight: WorkspacePreflight | null = null
    if (this.checkBinding) {
      const { epoch: _epoch, semantics: _semantics, ...check } = this.checkBinding
      preflight = { ...check, status: this.checkCurrent(this.checkBinding, this.editorSemantics) ? check.status : 'stale' }
    }
    const candidate = {
      binding: snapshotValue(
        {
          instanceId: this.instanceId,
          blueprintId: this.blueprintId,
          editorEpoch: this.editorEpoch,
          documentRevision: this.document?.documentRevision ?? null
        },
        previous?.binding
      ),
      capabilities: snapshotValue(
        {
          hostAvailable: !!this.host,
          canImport: typeof this.host?.importDefinition === 'function',
          canExport: typeof this.host?.exportDefinition === 'function',
          canCreate: typeof this.host?.createDefinition === 'function',
          canPreflight: typeof this.host?.preflightRun === 'function'
        },
        previous?.capabilities
      ),
      blueprintId: this.blueprintId,
      isNewDraft: this.isNewDraft,
      document: snapshotValue(
        document
          ? {
              blueprintId: document.blueprintId,
              documentRevision: document.documentRevision,
              semanticRevision: document.semanticRevision,
              layoutRevision: document.layoutRevision
            }
          : null,
        previous?.document
      ),
      definition: this.blueprintId ? this.definitionSnapshot : null,
      editor: this.editorSnapshot,
      catalog: snapshotValue(this.catalog, previous?.catalog),
      library: snapshotValue(
        {
          state: this.libraryState,
          libraries: this.libraries,
          selected: this.library,
          title:
            this.libraries.find(entry => sameLibrary(entry.library, this.library))?.title ??
            (this.library.kind === 'global' ? 'Global' : this.library.workspaceId),
          status: this.libraries.find(entry => sameLibrary(entry.library, this.library))?.status ?? 'unavailable'
        },
        previous?.library
      ),
      resources: snapshotValue({ state: this.resourceCatalogState, entries: this.resourceCatalog }, previous?.resources),
      inputJson: this.inputJson,
      notice: snapshotValue(this.notice, previous?.notice),
      busy: this.busy,
      dirty: this.blueprintId !== null && this.editorJson !== this.baselineJson,
      needsNavigationConfirmation: this.blueprintId !== null && this.editor.nodes.length > 0 && this.editorSemantics !== this.baselineSemantics,
      preflight: snapshotValue(preflight, previous?.preflight),
      run: snapshotValue(
        {
          runId: this.runId,
          connectionState: this.model.connectionState,
          snapshot: view,
          overlayEligible:
            this.blueprintId !== null &&
            document !== null &&
            document.blueprintId === this.blueprintId &&
            this.runId !== null &&
            view !== null &&
            view.runId === this.runId &&
            view.definitionRevision === document.semanticRevision &&
            this.editorSemantics === this.baselineSemantics
        },
        previous?.run
      )
    }
    // Segment values are already detached and frozen. Keep the root on no-op emits.
    if (!previous || Object.keys(candidate).some(key => !Object.is(candidate[key as keyof typeof candidate], previous[key as keyof WorkspaceSnapshot]))) {
      this.published = Object.freeze(candidate)
    }
  }
  readonly acceptsViewBinding = (binding: unknown): binding is WorkspaceViewBinding =>
    !this.disposed &&
    isWorkspaceViewBinding(binding) &&
    sameWorkspaceViewBinding(binding, {
      instanceId: this.instanceId,
      blueprintId: this.blueprintId,
      editorEpoch: this.editorEpoch,
      documentRevision: this.document?.documentRevision ?? null
    })
  readonly host: HostLink | undefined
  constructor(
    host: HostLink | undefined,
    readonly storage?: DraftStorage
  ) {
    this.host = host?.listBlueprintLibraries === undefined ? host : scopeBlueprintHost(host, () => this.libraryScope)
    this.dispatch = this.dispatch.bind(this)
    this.captureEditor(false)
    this.publish()
    this.unsubscribeEditor = this.editor.subscribe(() => {
      this.captureEditor(false)
      this.emit()
    })
    this.unsubscribeModel = this.model.subscribe(() => this.emit())
  }
  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private emit(): void {
    if (this.disposed) return
    if (this.batchDepth) {
      this.pendingNotification = true
      return
    }
    this.publish()
    for (const listener of this.listeners) {
      if (this.disposed) break
      listener()
    }
  }
  get runId(): string | null {
    return this.boundRunId
  }
  set runId(value: string | null) {
    if (this.disposed || value === this.boundRunId) return
    this.boundRunId = value
    this.model.reset()
  }
  private persistRunBinding(blueprintId: string, runId: string): void {
    try {
      this.storage?.setItem(runBindingKey(blueprintId, this.libraryScope), JSON.stringify({ blueprintId, runId }))
    } catch {
      if (!this.disposed) this.notice = { key: 'status.recentRunUnavailable' }
    }
  }
  private readRunBinding(blueprintId: string): string | null {
    try {
      const stored = this.storage?.getItem(runBindingKey(blueprintId, this.libraryScope))
      if (!stored) return null
      const binding = JSON.parse(stored) as { blueprintId?: unknown; runId?: unknown }
      return binding.blueprintId === blueprintId && typeof binding.runId === 'string' && binding.runId.length > 0 ? binding.runId : null
    } catch {
      return null
    }
  }
  /** Transitional read-only renderer for existing panel/tests. Workspace state
   * stores only notice descriptors; the localized panel consumes notice directly.
   */
  get status(): string {
    const notice = this.notice
    switch (notice.key) {
      case 'status.loading':
        return 'Loading configured library…'
      case 'status.hostUnavailable':
        return 'Host link unavailable in this context.'
      case 'status.chooseBlueprint':
        return 'Choose a blueprint or create a new draft.'
      case 'status.noDefinitions':
        return 'No configured blueprints. Ask the host operator to configure an ID.'
      case 'status.loadingDocument':
        return 'Loading host document…'
      case 'status.loaded':
        return 'Loaded host document.'
      case 'status.newDocument':
        return 'New configured document; save before running.'
      case 'status.newDraft':
        return 'New draft; first save creates a blueprint.'
      case 'status.draftRestored':
        return 'Restored local document draft.'
      case 'status.draftStale':
        return 'Host document changed; old layout draft was not applied.'
      case 'status.draftInvalid':
        return 'Invalid local draft ignored; host document retained.'
      case 'status.deleted':
        return 'Blueprint deleted; run history retained.'
      case 'status.saved':
        return 'Saved host document.'
      case 'status.runAdmitted':
        return `Run admitted: ${notice.params.state}.`
      case 'status.recentRunUnavailable':
        return 'Recent run binding unavailable; the durable run remains on the host.'
      case 'status.draftUnavailable':
        return 'Local draft unavailable; edits remain in memory.'
      case 'status.error':
        return notice.params.code
      case 'status.invalidRunInput':
        return `${notice.params.code} · ${notice.params.issue}`
      case 'status.libraryAbsent':
        return 'This project has no blueprint library yet.'
      case 'status.libraryUnavailable':
        return 'This blueprint library is unavailable.'
      case 'status.libraryEmpty':
        return 'No blueprints in this library.'
      case 'status.librarySwitched':
        return `Library selected: ${notice.params.name}`
      case 'status.workspaceRequired':
        return 'Select a workspace before running.'
    }
  }
  /** Run details remain intact even when attempts cannot decorate the edit graph. */
  get runOverlayEligible(): boolean {
    const view = this.model.view
    return (
      this.blueprintId !== null &&
      this.document !== null &&
      this.document.blueprintId === this.blueprintId &&
      this.runId !== null &&
      view !== null &&
      view.runId === this.runId &&
      view.definitionRevision === this.document.semanticRevision &&
      this.editorSemantics === this.baselineSemantics
    )
  }
  get dirty(): boolean {
    return this.blueprintId !== null && this.editorJson !== this.baselineJson
  }
  /** Leaving an empty canvas is intentional even when names/resources changed.
   * Save/draft dirty still includes presentation; navigation protects semantic
   * edits to nonempty graphs. Unsaved new drafts have no saved semantic baseline.
   */
  get needsNavigationConfirmation(): boolean {
    return this.blueprintId !== null && this.editor.nodes.length > 0 && this.editorSemantics !== this.baselineSemantics
  }
  get definition(): BlueprintDefinition | null {
    return this.blueprintId ? (this.definitionSnapshot as BlueprintDefinition | null) : null
  }
  private install(definition: BlueprintDefinition): void {
    this.unsubscribeEditor?.()
    this.editor = GraphEditor.fromDefinition(definition)
    this.editorEpoch++
    this.observedSemantics = definitionSemantics(definition)
    this.captureEditor(true)
    this.unsubscribeEditor = this.editor.subscribe(() => {
      const semantics = definitionSemantics(this.editor.exportDefinition())
      if (semantics !== this.observedSemantics) {
        this.observedSemantics = semantics
        this.invalidateCheck()
      }
      this.captureEditor(true)
      this.persistDraft()
      this.emit()
    })
  }
  private persistDraft(): void {
    if (this.disposed) return
    if (!this.blueprintId || !this.storage || this.restoring) return
    try {
      if (this.creation)
        this.storage.setItem(
          newDraftKey(this.libraryScope),
          JSON.stringify({ ...this.creation, definitionJson: JSON.stringify(this.editor.exportDefinition()) })
        )
      else
        this.storage.setItem(
          draftKey(this.blueprintId, this.libraryScope),
          JSON.stringify({
            documentRevision: this.document?.documentRevision ?? null,
            definitionJson: JSON.stringify(this.editor.exportDefinition()),
            layout: this.editor.exportLayout()
          })
        )
    } catch {
      this.notice = { key: 'status.draftUnavailable' }
    }
  }
  newDraft(name = 'Untitled blueprint'): void {
    return newWorkspaceDraft(this.navigationContext(), name)
  }
  initialize(draftName = 'Untitled blueprint'): Promise<void> {
    return initializeWorkspace(this.navigationContext(), draftName)
  }
  /** Directory observations never alter the saved definition or resource grants. */
  refreshResources(): Promise<void> {
    return refreshWorkspaceResources({
      host: this.host,
      assertActive: () => this.assertActive(),
      nextReadGeneration: () => ++this.resourceReadGeneration,
      readGeneration: () => this.resourceReadGeneration,
      navigationGeneration: () => this.generation,
      isDisposed: () => this.disposed,
      selection: () =>
        this.libraries.length === 0
          ? undefined
          : { library: this.library, ...(this.library.kind === 'workspace' ? { workspaceId: this.library.workspaceId } : {}) },
      setCatalogState: (state, entries) => {
        if (entries !== undefined) this.resourceCatalog = entries
        this.resourceCatalogState = state
      },
      emit: () => this.emit()
    })
  }
  /** Only a Host that exposed the cascade may receive explicit library IDs.
   * Older Hosts keep their legacy default-library wire shape. The same scope
   * separates browser draft/viewport/run-binding keys across libraries. */
  get libraryScope(): LibraryRef | undefined {
    return this.libraries.length > 0 ? this.library : undefined
  }

  private explicitLibrary(): LibraryRef | undefined {
    return this.libraryScope
  }

  /** Refresh the cascade. Selection is preserved when still visible; otherwise
   * the Host default library becomes current. */
  refreshLibraries(): Promise<void> {
    return refreshWorkspaceLibraries({
      host: this.host,
      assertActive: () => this.assertActive(),
      nextReadGeneration: () => ++this.libraryReadGeneration,
      readGeneration: () => this.libraryReadGeneration,
      navigationGeneration: () => this.generation,
      isDisposed: () => this.disposed,
      current: () => this.library,
      applyLibraries: (libraries, selected, state) => {
        const firstProjection = this.libraries.length === 0
        this.libraries = libraries
        this.libraryState = state
        const announced = selected === undefined ? undefined : libraries.find(entry => sameLibrary(entry.library, selected))
        const existing = libraries.find(entry => sameLibrary(entry.library, this.library))
        // The first projection adopts the Host default; later refreshes keep the
        // user's explicit selection even if the Host default is different.
        const next = (firstProjection ? announced : undefined) ?? existing ?? announced ?? libraries[0]
        if (next !== undefined) {
          this.library = next.library
          // Only a resolved library may replace the catalog. An unavailable
          // cascade (older Host) leaves the legacy catalog read untouched, so a
          // concurrent initialize cannot transiently empty it.
          this.catalog = next.status === 'ready' ? next.assets.filter(asset => asset.status === 'ready').map(assetToCatalog) : []
        }
      },
      emit: () => this.emit()
    })
  }

  /** Select one library level. A document from another library is replaced by
   * a fresh draft; the panel confirms dirty edits before dispatching this. */
  selectLibrary(library: LibraryRef): void {
    if (this.disposed || sameLibrary(this.library, library)) return
    const summary = this.libraries.find(entry => sameLibrary(entry.library, library))
    this.batch(() => {
      this.library = library
      this.catalog = summary?.status === 'ready' ? summary.assets.filter(asset => asset.status === 'ready').map(assetToCatalog) : []
      this.newDraft(library.kind === 'global' ? 'Global draft' : `${summary?.title ?? 'Project'} draft`)
      if (summary?.status === 'empty') this.notice = { key: 'status.noDefinitions' }
      else if (summary?.status === 'unavailable') this.notice = { key: 'status.libraryUnavailable' }
      else if (summary?.status === 'absent') this.notice = { key: 'status.libraryAbsent' }
      this.emit()
    })
    void this.refreshResources()
  }

  load(blueprintId: string): Promise<void> {
    return loadWorkspaceDocument(this.navigationContext(), blueprintId)
  }
  private navigationContext(): WorkspaceNavigationContext {
    return {
      host: this.host,
      read: () => ({
        disposed: this.disposed,
        generation: this.generation,
        blueprintId: this.blueprintId,
        catalog: this.catalog,
        runId: this.runId,
        library: this.explicitLibrary(),
        libraries: this.libraries
      }),
      refreshLibraries: () => this.refreshLibraries(),
      assertActive: () => this.assertActive(),
      batch: action => this.batch(action),
      beginDraft: requestId => {
        this.generation++
        this.invalidateCheck()
        this.creation = { requestId }
        this.blueprintId = `draft-${requestId}`
        this.document = null
        this.runId = null
        this.model.reset()
        this.pendingStart = undefined
        this.decisions.clear()
        this.checkBinding = undefined
        this.input = '{}'
        return this.blueprintId
      },
      beginLoad: placeholder => {
        const generation = ++this.generation
        this.creation = undefined
        this.invalidateCheck()
        // Clear the prior identity before waiting for the target document.
        this.blueprintId = null
        this.document = null
        this.boundRunId = null
        this.model.reset()
        this.pendingStart = undefined
        this.decisions.clear()
        this.install(placeholder)
        this.baselineJson = ''
        this.baselineSemantics = ''
        this.notice = { key: 'status.loadingDocument' }
        return generation
      },
      finishDraft: definition => {
        this.install(definition)
        this.baselineJson = JSON.stringify(this.editor.exportDefinition())
        this.baselineSemantics = ''
        this.notice = { key: 'status.newDraft' }
      },
      restoreNewDraft: (creation, definition) => {
        this.creation = creation
        this.blueprintId = definition.id
        this.install(definition)
        this.baselineJson = ''
        this.baselineSemantics = ''
        this.notice = { key: 'status.draftRestored' }
      },
      installDocument: (document, definition) => {
        this.blueprintId = definition.id
        this.document = document
        this.install(definition)
        this.baselineJson = JSON.stringify(this.editor.exportDefinition())
        this.baselineSemantics = definitionSemantics(definition)
        this.notice = { key: document ? 'status.loaded' : 'status.newDocument' }
      },
      restoreDocumentDraft: definition => {
        this.restoring = true
        this.install(definition)
        this.restoring = false
        this.notice = { key: 'status.draftRestored' }
      },
      rejectDocumentDraft: () => {
        this.restoring = false
      },
      setCatalog: catalog => {
        this.catalog = catalog
      },
      setNotice: notice => {
        this.notice = notice
      },
      readNewDraft: () => this.storage?.getItem(newDraftKey(this.libraryScope)),
      readDocumentDraft: blueprintId => this.storage?.getItem(draftKey(blueprintId, this.libraryScope)),
      restoreRunBinding: blueprintId => {
        this.runId = this.readRunBinding(blueprintId)
      },
      persistDraft: () => this.persistDraft(),
      refreshResources: () => this.refreshResources(),
      newDraft: name => this.newDraft(name),
      inspect: () => this.inspect(),
      emit: () => this.emit()
    }
  }
  save(): Promise<DefinitionDocument> {
    return saveWorkspaceDocument(this.documentWriteContext())
  }
  /** The UI confirms discarding edits. Deletion never saves the dirty buffer. */
  deleteCurrent(draftName = 'Untitled blueprint'): Promise<void> {
    return deleteWorkspaceDocument(this.documentWriteContext(), draftName)
  }
  exportArchive() {
    return exportWorkspaceArchive(this.documentWriteContext())
  }
  importArchive(blueprintId: string, archiveBase64: string, confirmedId: string): Promise<void> {
    return importWorkspaceArchive(this.documentWriteContext(), blueprintId, archiveBase64, confirmedId)
  }
  private documentWriteContext(): WorkspaceDocumentWriteContext {
    return {
      host: this.host,
      read: () => ({
        disposed: this.disposed,
        generation: this.generation,
        blueprintId: this.blueprintId,
        document: this.document,
        creation: this.creation,
        deletion: this.deletion,
        nodeCount: this.editor.nodes.length,
        library: this.explicitLibrary(),
        libraries: this.libraries
      }),
      assertActive: () => this.assertActive(),
      isDirty: () => this.dirty,
      exportDefinition: () => this.editor.exportDefinition(),
      adoptCreatedDefinition: definition => {
        this.blueprintId = definition.id
        this.creation = undefined
        this.install(definition)
      },
      invalidateCheck: () => this.invalidateCheck(),
      setDocument: document => {
        this.document = document
      },
      setBaseline: (json, semantics) => {
        this.baselineJson = json
        this.baselineSemantics = semantics
      },
      upsertCatalog: item => {
        this.catalog = [...this.catalog.filter(entry => entry.blueprintId !== item.blueprintId), item]
      },
      removeCatalog: blueprintId => {
        this.catalog = this.catalog.filter(entry => entry.blueprintId !== blueprintId)
      },
      install: definition => this.install(definition),
      setDeletion: deletion => {
        this.deletion = deletion
      },
      clearNewDraftStorage: () => this.storage?.setItem(newDraftKey(this.libraryScope), 'null'),
      clearIdentityStorage: blueprintId => {
        for (const key of [
          draftKey(blueprintId, this.libraryScope),
          viewportKey(blueprintId, this.libraryScope),
          runBindingKey(blueprintId, this.libraryScope)
        ])
          this.storage?.setItem(key, '')
      },
      persistDraft: () => this.persistDraft(),
      setNotice: notice => {
        this.notice = notice
      },
      batch: action => this.batch(action),
      emit: () => this.emit(),
      save: () => this.save(),
      newDraft: name => this.newDraft(name),
      initialize: () => this.initialize(),
      load: blueprintId => this.load(blueprintId)
    }
  }
  checkRun(): Promise<PreflightRunValue> {
    return checkWorkspaceRun(this.runContext())
  }
  run(): Promise<void> {
    return runWorkspace(this.runContext())
  }
  inspect(): Promise<void> {
    return inspectWorkspaceRun(this.runContext())
  }
  cancel(): Promise<void> {
    return cancelWorkspaceRun(this.runContext())
  }
  decide(action: 'approve' | 'reject'): Promise<void> {
    return decideWorkspaceRun(this.runContext(), action)
  }
  private runContext(): WorkspaceRunContext {
    return {
      host: this.host,
      read: () => ({
        disposed: this.disposed,
        generation: this.generation,
        blueprintId: this.blueprintId,
        documentRevision: this.document?.documentRevision ?? null,
        inputJson: this.inputJson,
        checkEpoch: this.checkEpoch,
        checkRead: this.checkRead,
        checkBinding: this.checkBinding,
        runId: this.runId,
        modelView: this.model.view,
        pendingStart: this.pendingStart,
        library: this.explicitLibrary()
      }),
      assertActive: () => this.assertActive(),
      nextCheckRead: () => ++this.checkRead,
      exportDefinition: () => this.editor.exportDefinition(),
      isDirty: () => this.dirty,
      save: () => this.save(),
      checkRun: () => this.checkRun(),
      checkCurrent: (binding, semantics) => this.checkCurrent(binding, semantics),
      setCheckBinding: binding => {
        this.checkBinding = binding
      },
      setUnavailableCheckBinding: () => {
        if (this.blueprintId)
          this.checkBinding = {
            status: 'unavailable',
            blueprintId: this.blueprintId,
            documentRevision: this.document?.documentRevision ?? '',
            inputJson: this.inputJson,
            generation: this.generation,
            epoch: this.checkEpoch,
            semantics: definitionSemantics(this.editor.exportDefinition()),
            code: 'blueprint/capability-unavailable'
          }
      },
      setPendingStart: pending => {
        this.pendingStart = pending
      },
      decisionId: key => {
        const existing = this.decisions.get(key)
        if (existing) return existing
        const decisionId = crypto.randomUUID()
        this.decisions.set(key, decisionId)
        return decisionId
      },
      persistRunBinding: (blueprintId, runId) => this.persistRunBinding(blueprintId, runId),
      setRunId: runId => {
        this.runId = runId
      },
      setNotice: notice => {
        this.notice = notice
      },
      batch: action => this.batch(action),
      emit: () => this.emit(),
      resync: runId => this.model.resync(this.host!, runId),
      inspect: () => this.inspect()
    }
  }
  async perform(action: () => Promise<unknown>): Promise<void> {
    if (this.disposed || this.busy) return
    const generation = this.generation
    this.busy = true
    this.emit()
    if (this.disposed) return
    try {
      await action()
    } catch (error) {
      if (generation === this.generation) {
        this.notice = errorNotice(error)
        // A rejected input or CAS/domain command says nothing about the
        // connectivity of the previously inspected authoritative Run.
        if (this.runId && errorCode(error) === 'blueprint/transport-unavailable') this.model.markDisconnected()
      }
    } finally {
      if (!this.disposed) {
        this.busy = false
        this.emit()
      }
    }
  }
}
