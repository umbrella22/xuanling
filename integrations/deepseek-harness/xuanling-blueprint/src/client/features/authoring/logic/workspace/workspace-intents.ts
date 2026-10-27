/** Client command payloads contain data only; browser effects stay at their adapter. */
import type { BlueprintWorkspace } from './workspace-controller.ts'
import type { LibraryRef } from '../../../../adapters/host/remote.ts'

export type WorkspaceIntent =
  | { type: 'set-input'; inputJson: string }
  | { type: 'bind-run'; runId: string | null }
  | { type: 'new-draft'; name?: string }
  | { type: 'initialize'; draftName?: string }
  | { type: 'refresh-resources' }
  | { type: 'refresh-libraries' }
  | { type: 'select-library'; library: LibraryRef }
  | { type: 'load'; blueprintId: string }
  | { type: 'save' }
  | { type: 'delete'; draftName?: string }
  | { type: 'export' }
  | { type: 'import'; blueprintId: string; archiveBase64: string; confirmedId: string }
  | { type: 'check-run' }
  | { type: 'run' }
  | { type: 'inspect' }
  | { type: 'cancel' }
  | { type: 'decide'; action: 'approve' | 'reject' }

export interface WorkspaceIntentResults {
  'set-input': void
  'bind-run': void
  'new-draft': void
  initialize: ReturnType<BlueprintWorkspace['initialize']>
  'refresh-resources': ReturnType<BlueprintWorkspace['refreshResources']>
  'refresh-libraries': ReturnType<BlueprintWorkspace['refreshLibraries']>
  'select-library': void
  load: ReturnType<BlueprintWorkspace['load']>
  save: ReturnType<BlueprintWorkspace['save']>
  delete: ReturnType<BlueprintWorkspace['deleteCurrent']>
  export: ReturnType<BlueprintWorkspace['exportArchive']>
  import: ReturnType<BlueprintWorkspace['importArchive']>
  'check-run': ReturnType<BlueprintWorkspace['checkRun']>
  run: ReturnType<BlueprintWorkspace['run']>
  inspect: ReturnType<BlueprintWorkspace['inspect']>
  cancel: ReturnType<BlueprintWorkspace['cancel']>
  decide: ReturnType<BlueprintWorkspace['decide']>
}
/** Local validation error, distinct from Host transport and DTO errors. */
export class WorkspaceIntentError extends Error {
  readonly code = 'blueprint/workspace-intent-invalid'
  constructor() {
    super('blueprint/workspace-intent-invalid')
    this.name = 'WorkspaceIntentError'
  }
}
const fields: Record<WorkspaceIntent['type'], readonly string[]> = {
  'set-input': ['inputJson'],
  'bind-run': ['runId'],
  'new-draft': ['name'],
  initialize: ['draftName'],
  'refresh-resources': [],
  'refresh-libraries': [],
  'select-library': ['library'],
  load: ['blueprintId'],
  save: [],
  delete: ['draftName'],
  export: [],
  import: ['blueprintId', 'archiveBase64', 'confirmedId'],
  'check-run': [],
  run: [],
  inspect: [],
  cancel: [],
  decide: ['action']
}
/** Validate shape before routing; strings retain their exact domain meaning. */
export function assertWorkspaceIntent(value: unknown): asserts value is WorkspaceIntent {
  const invalid = (): never => {
    throw new WorkspaceIntentError()
  }
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !Object.hasOwn(descriptors[key]!, 'value'))) invalid()
  const input = value as Record<string, unknown>
  const type = input.type
  if (typeof type !== 'string' || !Object.hasOwn(fields, type)) invalid()
  const allowed = fields[type as WorkspaceIntent['type']]
  if (!Object.hasOwn(input, 'type') || Object.getOwnPropertyNames(input).some(key => key !== 'type' && !allowed.includes(key))) invalid()
  for (const field of allowed) {
    const item = input[field]
    if (field === 'name' || field === 'draftName') {
      if (item !== undefined && typeof item !== 'string') invalid()
    } else if (field === 'runId') {
      if (item !== null && typeof item !== 'string') invalid()
    } else if (field === 'library') {
      // The library selector carries a discriminated logical identity only.
      if (item === null || typeof item !== 'object') invalid()
      const library = item as { kind?: unknown; workspaceId?: unknown }
      if (library.kind === 'global') {
        if (Object.getOwnPropertyNames(library).some(key => key !== 'kind')) invalid()
      } else if (library.kind === 'workspace') {
        if (Object.getOwnPropertyNames(library).some(key => key !== 'kind' && key !== 'workspaceId')) invalid()
        if (typeof library.workspaceId !== 'string' || library.workspaceId.length === 0) invalid()
      } else invalid()
    } else if (field === 'action') {
      if (item !== 'approve' && item !== 'reject') invalid()
    } else if (typeof item !== 'string') invalid()
  }
}
