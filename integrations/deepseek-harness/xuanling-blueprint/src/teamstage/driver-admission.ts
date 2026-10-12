/** Dynamic optional native capability. Apply-time registration is not admission. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GraphNode } from '../definition/types.ts'
import { TEAM_KNOWN_CHECKS } from '../persistence/records.ts'
import { TeamNativeAdapter, resolveTeamService, type LeadHandle } from './native-adapter.ts'

export interface TeamProviders { fresh?: string; fork?: string }
export const TEAM_MEMBER_TOOLS = ['send_message', 'list_agents', 'wait_agent', 'team_task_list', 'team_task_get', 'team_task_update'] as const
export class TeamDriverError extends Error {
  override readonly name = 'TeamDriverError'
  readonly code = 'TEAM_DRIVER_REJECTED'
  constructor(readonly issueCode: string) { super(issueCode) }
}

export function teamDriverCapability(ctx: Context, node: GraphNode, configured: TeamProviders = {}, source?: Agent): string | undefined {
  if (node.teamStage === undefined) return undefined
  try { resolveTeamService(ctx) } catch { return 'teamstage-executor-unavailable' }
  const subagents = ctx.get('subagents') as { getProvider?(name: string): { prepareContinuable?: unknown; inheritsParentContext?: unknown } | undefined } | undefined
  const sessions = ctx.get('sessions') as { get?: unknown; flush?: unknown } | undefined
  const tools = ctx.get('tools')
  if (typeof subagents?.getProvider !== 'function'
    || typeof sessions?.get !== 'function' || typeof sessions.flush !== 'function'
    || !tools || typeof tools.restrict !== 'function' || typeof tools.guard !== 'function') return 'teamstage-executor-unavailable'
  if (node.teamStage.requiredChecks.some(check => !TEAM_KNOWN_CHECKS.includes(check as typeof TEAM_KNOWN_CHECKS[number]))) return 'teamstage-check-unavailable'
  for (const member of node.teamStage.members) {
    const providerName = configured[member.context] ?? (member.context === 'fresh' ? 'spawn' : 'fork')
    const provider = subagents.getProvider(providerName)
    if (typeof provider?.prepareContinuable !== 'function' || provider.inheritsParentContext !== (member.context === 'fork')) return 'teamstage-provider-unavailable'
  }
  // Native Team tools are agent-local. Public preflight has no identity and
  // cannot decide this from the host-global view; admission rechecks exactly.
  if (source !== undefined && TEAM_MEMBER_TOOLS.some(name => !tools.get(name, source))) return 'teamstage-tools-unavailable'
  return undefined
}

export function admitTeamDriver(ctx: Context, node: GraphNode, source: Agent | undefined, configured?: TeamProviders): LeadHandle {
  if (!source) throw new TeamDriverError('teamstage-executor-unavailable')
  const capability = teamDriverCapability(ctx, node, configured, source)
  if (capability) throw new TeamDriverError(capability)
  try { return new TeamNativeAdapter(ctx).lead(source) }
  catch { throw new TeamDriverError('teamstage-identity-unavailable') }
}
