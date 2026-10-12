/** Executable editing/session model shared by the production panel and source contracts. */
import { readHostDefinition } from './document.ts'
import type { BlueprintDefinition } from '../definition/types.ts'
import { GraphEditor } from './graph-editor.ts'
import { legacyDefinition } from './clipboard.ts'
import { BlueprintClientModel } from './model.ts'
import { BlueprintRemoteError } from './remote.ts'
import { BLUEPRINT_INVOCATIONS } from '../typert-descriptors.ts'
import type { PreflightRunValue } from './remote.ts'
import type { CatalogValue, DefinitionDocument, HostLink } from './remote.ts'
import type { WorkspaceNotice } from './view-contract.ts'

export interface DraftStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
export const draftKey = (blueprintId: string): string => `xuanling-blueprint:draft:${encodeURIComponent(blueprintId)}`
export const runBindingKey = (blueprintId: string): string => `xuanling-blueprint:recent-run:${encodeURIComponent(blueprintId)}`
export function isEditingTarget(target: unknown): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null
  return !!element && (/^(INPUT|TEXTAREA|SELECT)$/i.test(element.tagName ?? '') || !!element.isContentEditable || !!element.closest?.('[contenteditable="true"]'))
}
// Match the host's existing input failure vocabulary without exposing parser
// diagnostics or the input body. This local preflight never crosses the wire.
class InvalidRunInputError extends BlueprintRemoteError {
  readonly details = { issues: 'invalid-input-json' as const }
  constructor() { super('blueprint/definition-invalid') }
}
const errorCode = (error: unknown): string => typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'blueprint/transport-unavailable'
const errorNotice = (error: unknown): WorkspaceNotice => error instanceof InvalidRunInputError
  ? { key: 'status.invalidRunInput', params: { code: error.code, issue: error.details.issues } }
  : { key: 'status.error', params: { code: errorCode(error) } }

/** Browser-side equivalence to the saved definition, NOT a host revision hash.
 * Matches definition/revision.ts semanticProjection: exclude presentation only,
 * recursively order object keys, preserve arrays and all identity-bearing values.
 * Host semanticRevision still supplies authority for resources unavailable here.
 * Do not import the host revision module: it depends on filesystem/Node APIs.
 */
function definitionSemantics(definition: BlueprintDefinition): string {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, ordered(item)]))
    }
    return value
  }
  const { presentation: _presentation, ...semantic } = definition
  return JSON.stringify(ordered(semantic))
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
interface CheckBinding extends WorkspacePreflight { epoch: number; semantics: string }

export class BlueprintWorkspace {
  readonly model = new BlueprintClientModel()
  editor = new GraphEditor()
  catalog: CatalogValue['definitions'] = []
  document: DefinitionDocument | null = null
  blueprintId: string | null = null
  private boundRunId: string | null = null
  notice: WorkspaceNotice = { key: 'status.loading' }
  busy = false
  private input = '{}'
  private checkEpoch = 0
  private checkRead = 0
  private checkBinding: CheckBinding | undefined
  private observedSemantics = ''
  get inputJson(): string { return this.input }
  set inputJson(value: string) {
    if (this.input === value) return
    this.input = value; this.invalidateCheck(); this.emit()
  }
  private invalidateCheck(): void {
    this.checkEpoch++
    if (this.checkBinding) this.checkBinding.status = 'stale'
  }
  private checkCurrent(binding: CheckBinding): boolean {
    return binding.epoch === this.checkEpoch && binding.generation === this.generation
      && binding.blueprintId === this.blueprintId && binding.documentRevision === this.document?.documentRevision
      && binding.inputJson === this.inputJson && binding.semantics === definitionSemantics(this.editor.exportDefinition())
  }
  get preflight(): WorkspacePreflight | undefined {
    if (!this.checkBinding) return undefined
    const { epoch: _epoch, semantics: _semantics, ...view } = this.checkBinding
    return structuredClone({ ...view, status: this.checkCurrent(this.checkBinding) ? view.status : 'stale' })
  }
  private baselineJson = ''
  private baselineSemantics = ''
  private generation = 0
  private restoring = false
  private unsubscribeEditor: (() => void) | undefined
  private readonly listeners = new Set<() => void>()
  private readonly decisions = new Map<string, string>()
  private pendingStart: { signature: string; requestId: string } | undefined
  constructor(readonly host: HostLink | undefined, readonly storage?: DraftStorage) { this.model.subscribe(() => this.emit()) }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { for (const listener of this.listeners) listener() }
  get runId(): string | null { return this.boundRunId }
  set runId(value: string | null) {
    if (value === this.boundRunId) return
    this.boundRunId = value
    this.model.reset()
  }
  private persistRunBinding(blueprintId: string, runId: string): void {
    try { this.storage?.setItem(runBindingKey(blueprintId), JSON.stringify({ blueprintId, runId })) }
    catch { this.notice = { key: 'status.recentRunUnavailable' } }
  }
  private readRunBinding(blueprintId: string): string | null {
    try {
      const stored = this.storage?.getItem(runBindingKey(blueprintId))
      if (!stored) return null
      const binding = JSON.parse(stored) as { blueprintId?: unknown; runId?: unknown }
      return binding.blueprintId === blueprintId && typeof binding.runId === 'string' && binding.runId.length > 0 ? binding.runId : null
    } catch { return null }
  }
  /** Transitional read-only renderer for existing panel/tests. Workspace state
   * stores only notice descriptors; the localized panel consumes notice directly.
   */
  get status(): string {
    const notice = this.notice
    switch (notice.key) {
      case 'status.loading': return 'Loading configured library…'
      case 'status.hostUnavailable': return 'Host link unavailable in this context.'
      case 'status.chooseBlueprint': return 'Choose a configured blueprint.'
      case 'status.noDefinitions': return 'No configured blueprints. Ask the host operator to configure an ID.'
      case 'status.loadingDocument': return 'Loading host document…'
      case 'status.loaded': return 'Loaded host document.'
      case 'status.newDocument': return 'New configured document; save before running.'
      case 'status.draftRestored': return 'Restored local document draft.'
      case 'status.draftStale': return 'Host document changed; old layout draft was not applied.'
      case 'status.draftInvalid': return 'Invalid local draft ignored; host document retained.'
      case 'status.saved': return 'Saved host document.'
      case 'status.runAdmitted': return `Run admitted: ${notice.params.state}.`
      case 'status.recentRunUnavailable': return 'Recent run binding unavailable; the durable run remains on the host.'
      case 'status.draftUnavailable': return 'Local draft unavailable; edits remain in memory.'
      case 'status.error': return notice.params.code
      case 'status.invalidRunInput': return `${notice.params.code} · ${notice.params.issue}`
    }
  }
  /** Run details remain intact even when attempts cannot decorate the edit graph. */
  get runOverlayEligible(): boolean {
    const view = this.model.view
    return this.blueprintId !== null && this.document !== null
      && this.document.blueprintId === this.blueprintId
      && this.runId !== null && view !== null && view.runId === this.runId
      && view.definitionRevision === this.document.semanticRevision
      && definitionSemantics(this.editor.exportDefinition()) === this.baselineSemantics
  }
  get dirty(): boolean { return this.blueprintId !== null && JSON.stringify(this.editor.exportDefinition()) !== this.baselineJson }
  get definition(): BlueprintDefinition | null { return this.blueprintId ? this.editor.exportDefinition() : null }
  private install(definition: BlueprintDefinition): void {
    this.unsubscribeEditor?.()
    this.editor = GraphEditor.fromDefinition(definition)
    this.observedSemantics = definitionSemantics(definition)
    this.unsubscribeEditor = this.editor.subscribe(() => {
      const semantics = definitionSemantics(this.editor.exportDefinition())
      if (semantics !== this.observedSemantics) { this.observedSemantics = semantics; this.invalidateCheck() }
      this.persistDraft(); this.emit()
    })
  }
  private persistDraft(): void {
    if (!this.blueprintId || !this.storage || this.restoring) return
    try { this.storage.setItem(draftKey(this.blueprintId), JSON.stringify({ documentRevision: this.document?.documentRevision ?? null, definitionJson: JSON.stringify(this.editor.exportDefinition()), layout: this.editor.exportLayout() })) }
    catch { this.notice = { key: 'status.draftUnavailable' } }
  }
  async initialize(): Promise<void> {
    if (!this.host) { this.notice = { key: 'status.hostUnavailable' }; this.emit(); return }
    try { this.catalog = (await this.host.listDefinitions()).definitions; this.notice = { key: this.catalog.length ? 'status.chooseBlueprint' : 'status.noDefinitions' } }
    catch (error) { this.notice = errorNotice(error) }
    this.emit()
  }
  async load(blueprintId: string): Promise<void> {
    if (!this.host) throw new Error('Host link unavailable')
    const catalog = this.catalog.find(d => d.blueprintId === blueprintId)
    if (!catalog) throw new Error('Blueprint not in configured catalog')
    const generation = ++this.generation
    this.invalidateCheck()
    // Invalidate at navigation, not after the network read. No cancel/overlay can
    // refer to the previous package while the next document is still loading.
    this.blueprintId = null
    this.document = null
    this.boundRunId = null
    this.model.reset()
    this.pendingStart = undefined
    this.decisions.clear()
    this.install({ schemaVersion: 1, id: blueprintId, name: catalog.name, resources: {}, graph: { nodes: [], edges: [] } })
    this.baselineJson = ''
    this.baselineSemantics = ''
    this.notice = { key: 'status.loadingDocument' }
    this.emit()
    const document = catalog.documentRevision === null ? null : await this.host.loadDefinition(blueprintId)
    if (generation !== this.generation) return
    const definition: BlueprintDefinition = document ? readHostDefinition(document.definitionJson, blueprintId) : { schemaVersion: 1, id: blueprintId, name: catalog.name, resources: {}, graph: { nodes: [], edges: [] } }
    if (definition.id !== blueprintId || (document && document.blueprintId !== blueprintId)) throw new Error('Unrelated definition response')
    this.blueprintId = blueprintId
    this.document = document
    this.install(definition)
    this.baselineJson = JSON.stringify(this.editor.exportDefinition())
    this.baselineSemantics = definitionSemantics(definition)
    this.notice = { key: document ? 'status.loaded' : 'status.newDocument' }
    try {
      const stored = this.storage?.getItem(draftKey(blueprintId))
      if (stored) {
        const draft = JSON.parse(stored) as { documentRevision: string | null; definitionJson?: string; layout: Parameters<GraphEditor['importLayout']>[0] }
        if (draft.documentRevision === (document?.documentRevision ?? null)) {
          const draftJson = draft.definitionJson ?? JSON.stringify(definition)
          const validation = await this.host.validate(draftJson)
          if (generation !== this.generation) return
          if (validation.ok !== true) throw new Error('Draft was not accepted by host validator')
          const restored = readHostDefinition(draftJson, blueprintId)
          const candidate = GraphEditor.fromDefinition(restored)
          candidate.importLayout(draft.layout)
          this.restoring = true
          this.install(candidate.exportDefinition())
          this.restoring = false
          this.notice = { key: 'status.draftRestored' }
        }
        else this.notice = { key: 'status.draftStale' }
      }
    } catch {
      if (generation !== this.generation) return
      this.restoring = false; this.notice = { key: 'status.draftInvalid' }
    }
    this.runId = this.readRunBinding(blueprintId)
    this.emit()
    if (this.runId) {
      // Refresh/reopen is strictly read-only. A stored binding is not a command.
      try { await this.inspect() }
      catch (error) { if (generation === this.generation) { this.notice = errorNotice(error); this.emit() } }
    }
  }
  async save(): Promise<DefinitionDocument> {
    if (!this.host || !this.blueprintId) throw new Error('No configured definition loaded')
    const id = this.blueprintId
    const generation = this.generation
    const submitted = JSON.stringify(this.editor.exportDefinition())
    const doc = await this.host.saveDefinition(id, submitted, this.document?.documentRevision ?? null)
    if (doc.blueprintId !== id) throw new Error('Unrelated save response')
    if (generation !== this.generation) throw new Error('Document changed while saving')
    const accepted = readHostDefinition(doc.definitionJson, id)
    if (this.document?.documentRevision !== doc.documentRevision) this.invalidateCheck()
    this.document = doc
    this.baselineJson = JSON.stringify(GraphEditor.fromDefinition(accepted).exportDefinition())
    this.baselineSemantics = definitionSemantics(accepted)
    if (JSON.stringify(this.editor.exportDefinition()) === submitted) this.install(accepted)
    this.persistDraft()
    this.notice = { key: 'status.saved' }
    this.emit()
    return doc
  }
  /** Saved package closure comes from the existing Host API, never browser files. */
  async exportArchive() {
    if (!this.host?.exportDefinition || !this.blueprintId) throw new BlueprintRemoteError('blueprint/capability-unavailable')
    const generation = this.generation; const id = this.blueprintId
    if (this.dirty || !this.document) await this.save()
    if (generation !== this.generation || id !== this.blueprintId || this.dirty) throw new BlueprintRemoteError('blueprint/document-stale')
    const revision = this.document?.documentRevision
    const archive = await this.host.exportDefinition(id)
    if (generation !== this.generation || id !== this.blueprintId || this.dirty || revision !== this.document?.documentRevision) throw new BlueprintRemoteError('blueprint/document-stale')
    if (archive.blueprintId !== id) throw new BlueprintRemoteError('blueprint/dto-invalid')
    return archive
  }
  /** Explicit old reader rollback document. It contains no resource file bytes. */
  async exportLegacy(): Promise<{ blueprintId: string; definitionJson: string }> {
    const generation = this.generation; const id = this.blueprintId
    if (!id) throw new BlueprintRemoteError('blueprint/capability-unavailable')
    if (this.dirty || !this.document) await this.save()
    if (generation !== this.generation || id !== this.blueprintId || this.dirty) throw new BlueprintRemoteError('blueprint/document-stale')
    return { blueprintId: id, definitionJson: JSON.stringify(legacyDefinition(this.editor.exportDefinition()), null, 2) }
  }
  /** Confirmation is UI-owned; only configured empty targets are eligible.
   * Host performs the authoritative nonempty/path/ID/closure checks again. */
  async importArchive(blueprintId: string, archiveBase64: string, confirmedId: string): Promise<void> {
    if (!this.host?.importDefinition) throw new BlueprintRemoteError('blueprint/capability-unavailable')
    if (confirmedId !== blueprintId) throw new BlueprintRemoteError('blueprint/import-confirmation-required')
    const generation = this.generation
    const catalog = (await this.host.listDefinitions()).definitions
    if (generation !== this.generation) throw new BlueprintRemoteError('blueprint/document-stale')
    const target = catalog.find(d => d.blueprintId === blueprintId)
    if (!target) throw new BlueprintRemoteError('blueprint/configured-id-required')
    if (target.documentRevision !== null || (this.blueprintId === blueprintId && (this.editor.nodes.length || Object.keys(this.editor.exportDefinition().resources).length || this.dirty))) throw new BlueprintRemoteError('blueprint/import-target-nonempty')
    const result = await this.host.importDefinition(blueprintId, archiveBase64)
    if (result.blueprintId !== blueprintId) throw new BlueprintRemoteError('blueprint/dto-invalid')
    if (generation !== this.generation) return
    await this.initialize()
    if (generation !== this.generation) return
    await this.load(blueprintId)
  }
  /** A report is a saved-input observation, not an admission/permission token. */
  async checkRun(): Promise<PreflightRunValue> {
    if (!this.host || typeof this.host.preflightRun !== 'function') {
      if (this.blueprintId) this.checkBinding = {
        status: 'unavailable', blueprintId: this.blueprintId, documentRevision: this.document?.documentRevision ?? '',
        inputJson: this.inputJson, generation: this.generation, epoch: this.checkEpoch,
        semantics: definitionSemantics(this.editor.exportDefinition()), code: 'blueprint/capability-unavailable',
      }
      this.emit()
      throw new BlueprintRemoteError('blueprint/capability-unavailable')
    }
    const read = ++this.checkRead
    const generation = this.generation
    const inputJson = this.inputJson
    const epoch = this.checkEpoch
    const revisionBeforeSave = this.document?.documentRevision
    const semantics = definitionSemantics(this.editor.exportDefinition())
    try { JSON.parse(inputJson) } catch { throw new InvalidRunInputError() }
    const document = await this.save()
    // save may change the revision (and invalidate older reports), but edits,
    // input changes or navigation while it was in flight must not be captured.
    if (read !== this.checkRead || generation !== this.generation || this.dirty
      || inputJson !== this.inputJson || semantics !== definitionSemantics(this.editor.exportDefinition())
      || this.checkEpoch !== epoch + (revisionBeforeSave !== document.documentRevision ? 1 : 0)) {
      throw new BlueprintRemoteError('blueprint/preflight-stale')
    }
    const binding: CheckBinding = {
      status: 'checking', blueprintId: document.blueprintId, documentRevision: document.documentRevision,
      inputJson, generation, epoch: this.checkEpoch, semantics,
    }
    this.checkBinding = binding; this.emit()
    try {
      const value = await this.host.preflightRun(document.blueprintId, document.documentRevision, inputJson)
      if (read !== this.checkRead || !this.checkCurrent(binding)) throw new BlueprintRemoteError('blueprint/preflight-stale')
      const parsed = BLUEPRINT_INVOCATIONS.find(item => item.method === 'preflightRun')!.result.create().safeParse(value)
      if (!parsed.success) throw new BlueprintRemoteError('blueprint/dto-invalid')
      const report = parsed.data as PreflightRunValue
      if (report.blueprintId !== document.blueprintId || report.documentRevision !== document.documentRevision
        || report.semanticRevision !== document.semanticRevision) throw new BlueprintRemoteError('blueprint/preflight-stale')
      binding.report = report; binding.status = 'current'; this.emit()
      return structuredClone(report)
    } catch (error) {
      if (this.checkBinding === binding && read === this.checkRead) {
        binding.status = !this.checkCurrent(binding) || errorCode(error) === 'blueprint/preflight-stale' ? 'stale'
          : errorCode(error) === 'blueprint/capability-unavailable' ? 'unavailable' : 'failed'
        binding.code = errorCode(error); this.emit()
      }
      throw error
    }
  }
  async run(): Promise<void> {
    const read = this.checkRead + 1
    const report = await this.checkRun()
    const binding = this.checkBinding
    if (read !== this.checkRead || !this.host || !binding || binding.status !== 'current' || !this.checkCurrent(binding)) throw new BlueprintRemoteError('blueprint/preflight-stale')
    if (!report.canStart || report.checks.some(check => check.status === 'block')) throw new BlueprintRemoteError('blueprint/preflight-blocked')
    const { blueprintId, documentRevision, inputJson, generation } = binding
    const signature = JSON.stringify([blueprintId, documentRevision, inputJson])
    if (this.pendingStart?.signature !== signature) this.pendingStart = { signature, requestId: crypto.randomUUID() }
    const pending = this.pendingStart
    const admission = await this.host.startRun(blueprintId, documentRevision, inputJson, pending.requestId)
    // Admission is a Host fact for the captured ID, even after navigation.
    this.persistRunBinding(blueprintId, admission.runId)
    if (this.pendingStart === pending) this.pendingStart = undefined
    if (generation !== this.generation) return
    this.runId = admission.runId
    this.notice = { key: 'status.runAdmitted', params: { state: admission.state } }
    await this.inspect()
  }
  async inspect(): Promise<void> {
    if (!this.host || !this.runId || !this.blueprintId) return
    const generation = this.generation
    const blueprintId = this.blueprintId
    const runId = this.runId
    await this.model.resync(this.host, runId)
    if (generation !== this.generation || runId !== this.runId) return
    this.persistRunBinding(blueprintId, runId)
    this.emit()
  }
  async cancel(): Promise<void> {
    if (!this.host || !this.runId) return
    const generation = this.generation; const runId = this.runId
    await this.host.cancelRun(runId)
    if (generation === this.generation && runId === this.runId) await this.inspect()
    // Terminal UI facts only come from inspect, not optimistic command state.
  }
  async decide(action: 'approve' | 'reject'): Promise<void> {
    if (!this.host || !this.runId) return
    const generation = this.generation; const runId = this.runId
    const waiting = this.model.view?.attempts.find(a => a.state === 'waiting_input')
    if (!waiting) throw new Error('No durable waiting decision')
    const key = `${runId}\0${waiting.nodeId}\0${action}`
    const decisionId = this.decisions.get(key) ?? crypto.randomUUID()
    this.decisions.set(key, decisionId)
    await this.host.decide(runId, decisionId, action)
    if (generation === this.generation && runId === this.runId) await this.inspect()
  }
  async perform(action: () => Promise<unknown>): Promise<void> {
    if (this.busy) return
    const generation = this.generation
    this.busy = true; this.emit()
    try { await action() }
    catch (error) {
      if (generation === this.generation) {
        this.notice = errorNotice(error)
        // A rejected input or CAS/domain command says nothing about the
        // connectivity of the previously inspected authoritative Run.
        if (this.runId && errorCode(error) === 'blueprint/transport-unavailable') this.model.markDisconnected()
      }
    }
    finally { this.busy = false; this.emit() }
  }
}
