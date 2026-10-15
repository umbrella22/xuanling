/** Explicit Host-for-Client contribution consumed by the official ClientRemote mount. */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { BLUEPRINT_PACKAGE, BLUEPRINT_INVOCATIONS } from './typert-descriptors.ts'

export const TYPERT_REMOTE = {
  package: BLUEPRINT_PACKAGE,
  descriptors: BLUEPRINT_INVOCATIONS
} satisfies TypertRemoteContribution

export const TEAMSTAGE_REMOTE_ERROR_CODES = [
  'blueprint/team-unavailable',
  'blueprint/team-identity-unavailable',
  'blueprint/team-stage-conflict',
  'blueprint/team-task-conflict',
  'blueprint/team-output-rejected',
  'blueprint/durability-failed'
] as const

/** Keep remote failures within the public static code vocabulary. */
export function mapTeamStageRemoteError(error: unknown): string {
  const code = (error as { code?: unknown })?.code
  return typeof code === 'string' && TEAMSTAGE_REMOTE_ERROR_CODES.includes(code as (typeof TEAMSTAGE_REMOTE_ERROR_CODES)[number])
    ? code
    : 'blueprint/remote-failed'
}

export default TYPERT_REMOTE
