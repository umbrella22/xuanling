/** Run preflight, admission and durable run observations. */
import { BLUEPRINT_INVOCATIONS } from '../../../../../typert-descriptors.ts'
import { definitionSemantics } from '../workspace/workspace-definition-semantics.ts'
import { InvalidRunInputError, errorCode } from '../workspace/workspace-errors.ts'
import { BlueprintRemoteError } from '../../../../adapters/host/remote.ts'
import type { HostLink, LibraryRef, PreflightRunValue, RunAdmission } from '../../../../adapters/host/remote.ts'
import type { RunAttemptView, RunSnapshotView } from './client-model.ts'
import type { BlueprintDefinition } from '../../../../../definition/types.ts'

export interface WorkspaceRunBinding {
  status: 'checking' | 'current' | 'stale' | 'unavailable' | 'failed'
  blueprintId: string
  documentRevision: string
  inputJson: string
  generation: number
  report?: PreflightRunValue
  code?: string
  epoch: number
  semantics: string
}
import { libraryKey } from '../../../../../definition/library-ref.ts'
function selection(library: LibraryRef | undefined): { library: LibraryRef; workspaceId?: string } | undefined {
  if (library === undefined) return undefined
  return library.kind === 'workspace' ? { library, workspaceId: library.workspaceId } : { library }
}
interface PendingStart {
  signature: string
  requestId: string
}
export interface WorkspaceRunContext {
  readonly host: Pick<HostLink, 'preflightRun' | 'startRun' | 'inspectRun' | 'cancelRun' | 'decide'> | undefined
  read(): {
    disposed: boolean
    generation: number
    blueprintId: string | null
    documentRevision: string | null
    inputJson: string
    checkEpoch: number
    checkRead: number
    checkBinding: WorkspaceRunBinding | undefined
    runId: string | null
    modelView: RunSnapshotView | null
    pendingStart: PendingStart | undefined
    library: LibraryRef | undefined
  }
  assertActive(): void
  nextCheckRead(): number
  exportDefinition(): BlueprintDefinition
  isDirty(): boolean
  save(): Promise<{ blueprintId: string; documentRevision: string; semanticRevision: string }>
  checkRun(): Promise<PreflightRunValue>
  checkCurrent(binding: WorkspaceRunBinding, semantics?: string): boolean
  setCheckBinding(binding: WorkspaceRunBinding): void
  setUnavailableCheckBinding(): void
  setPendingStart(pending: PendingStart | undefined): void
  decisionId(key: string): string
  persistRunBinding(blueprintId: string, runId: string): void
  setRunId(runId: string): void
  setNotice(notice: { key: 'status.runAdmitted'; params: { state: string } }): void
  batch(action: () => void): void
  emit(): void
  resync(runId: string): Promise<RunSnapshotView>
  inspect(): Promise<void>
}

export async function checkWorkspaceRun(context: WorkspaceRunContext): Promise<PreflightRunValue> {
  context.assertActive()
  if (!context.host || typeof context.host.preflightRun !== 'function') {
    context.setUnavailableCheckBinding()
    context.emit()
    throw new BlueprintRemoteError('blueprint/capability-unavailable')
  }
  const read = context.nextCheckRead()
  const generation = context.read().generation
  const inputJson = context.read().inputJson
  const epoch = context.read().checkEpoch
  const revisionBeforeSave = context.read().documentRevision
  const beforeSave = context.exportDefinition()
  try {
    JSON.parse(inputJson)
  } catch {
    throw new InvalidRunInputError()
  }
  const document = await context.save()
  const semantics = definitionSemantics({ ...beforeSave, id: document.blueprintId })
  if (
    read !== context.read().checkRead ||
    generation !== context.read().generation ||
    context.isDirty() ||
    inputJson !== context.read().inputJson ||
    semantics !== definitionSemantics(context.exportDefinition()) ||
    context.read().checkEpoch !== epoch + (revisionBeforeSave !== document.documentRevision ? 1 : 0)
  )
    throw new BlueprintRemoteError('blueprint/preflight-stale')
  const binding: WorkspaceRunBinding = {
    status: 'checking',
    blueprintId: document.blueprintId,
    documentRevision: document.documentRevision,
    inputJson,
    generation,
    epoch: context.read().checkEpoch,
    semantics
  }
  context.setCheckBinding(binding)
  context.emit()
  try {
    context.assertActive()
    const value = await context.host.preflightRun(document.blueprintId, document.documentRevision, inputJson, selection(context.read().library))
    if (read !== context.read().checkRead || !context.checkCurrent(binding)) throw new BlueprintRemoteError('blueprint/preflight-stale')
    const parsed = BLUEPRINT_INVOCATIONS.find(item => item.method === 'preflightRun')!
      .result.create()
      .safeParse(value)
    if (!parsed.success) throw new BlueprintRemoteError('blueprint/dto-invalid')
    const report = parsed.data as PreflightRunValue
    if (
      report.blueprintId !== document.blueprintId ||
      report.documentRevision !== document.documentRevision ||
      report.semanticRevision !== document.semanticRevision
    )
      throw new BlueprintRemoteError('blueprint/preflight-stale')
    binding.report = report
    binding.status = 'current'
    context.emit()
    return structuredClone(report)
  } catch (error) {
    if (context.read().checkBinding === binding && read === context.read().checkRead) {
      binding.status =
        !context.checkCurrent(binding) || errorCode(error) === 'blueprint/preflight-stale'
          ? 'stale'
          : errorCode(error) === 'blueprint/capability-unavailable'
            ? 'unavailable'
            : 'failed'
      binding.code = errorCode(error)
      context.emit()
    }
    throw error
  }
}

export async function runWorkspace(context: WorkspaceRunContext): Promise<void> {
  context.assertActive()
  const read = context.read().checkRead + 1
  const report = await context.checkRun()
  const binding = context.read().checkBinding
  if (!binding || read !== context.read().checkRead || !context.host || binding.status !== 'current' || !context.checkCurrent(binding))
    throw new BlueprintRemoteError('blueprint/preflight-stale')
  if (!report.canStart || report.checks.some(check => check.status === 'block')) throw new BlueprintRemoteError('blueprint/preflight-blocked')
  const { blueprintId, documentRevision, inputJson, generation } = binding
  const scopeLibrary = context.read().library
  const signature = JSON.stringify([blueprintId, documentRevision, inputJson, scopeLibrary === undefined ? null : libraryKey(scopeLibrary)])
  let pending = context.read().pendingStart
  if (pending?.signature !== signature) {
    pending = { signature, requestId: crypto.randomUUID() }
    context.setPendingStart(pending)
  }
  const admission: RunAdmission = await context.host.startRun(blueprintId, documentRevision, inputJson, pending.requestId, selection(context.read().library))
  context.persistRunBinding(blueprintId, admission.runId)
  if (context.read().pendingStart === pending) context.setPendingStart(undefined)
  if (generation !== context.read().generation) return
  context.batch(() => {
    context.setRunId(admission.runId)
    context.setNotice({ key: 'status.runAdmitted', params: { state: admission.state } })
  })
  if (context.read().disposed) return
  await context.inspect()
}

export async function inspectWorkspaceRun(context: WorkspaceRunContext): Promise<void> {
  context.assertActive()
  if (!context.host || !context.read().runId || !context.read().blueprintId) return
  const generation = context.read().generation
  const blueprintId = context.read().blueprintId
  const runId = context.read().runId!
  await context.resync(runId!)
  if (generation !== context.read().generation || runId !== context.read().runId) return
  context.persistRunBinding(blueprintId!, runId!)
  context.emit()
}

export async function cancelWorkspaceRun(context: WorkspaceRunContext): Promise<void> {
  context.assertActive()
  if (!context.host || !context.read().runId) return
  const generation = context.read().generation
  const runId = context.read().runId!
  await context.host.cancelRun(runId!)
  if (generation === context.read().generation && runId === context.read().runId) await context.inspect()
}

export async function decideWorkspaceRun(context: WorkspaceRunContext, action: 'approve' | 'reject'): Promise<void> {
  context.assertActive()
  if (!context.host || !context.read().runId) return
  const generation = context.read().generation
  const runId = context.read().runId!
  const waiting = context.read().modelView?.attempts.find((attempt: RunAttemptView) => attempt.state === 'waiting_input')
  if (!waiting) throw new Error('No durable waiting decision')
  const key = `${runId}\0${waiting.nodeId}\0${action}`
  const decisionId = context.decisionId(key)
  await context.host.decide(runId, decisionId, action)
  if (generation === context.read().generation && runId === context.read().runId) await context.inspect()
}
