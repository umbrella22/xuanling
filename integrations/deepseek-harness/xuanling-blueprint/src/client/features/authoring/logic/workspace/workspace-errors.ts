/** Existing client error classification shared by Workspace use cases. */
import { BlueprintRemoteError } from '../../../../adapters/host/remote.ts'
import type { WorkspaceNotice } from '../../../../shared/contracts/view-contract.ts'

// Match the host's existing input failure vocabulary without exposing parser
// diagnostics or the input body. This local preflight never crosses the wire.
export class InvalidRunInputError extends BlueprintRemoteError {
  readonly details = { issues: 'invalid-input-json' as const }
  constructor() {
    super('blueprint/definition-invalid')
  }
}
export const errorCode = (error: unknown): string =>
  typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'blueprint/transport-unavailable'
export const errorNotice = (error: unknown): WorkspaceNotice =>
  error instanceof InvalidRunInputError
    ? { key: 'status.invalidRunInput', params: { code: error.code, issue: error.details.issues } }
    : { key: 'status.error', params: { code: errorCode(error) } }
