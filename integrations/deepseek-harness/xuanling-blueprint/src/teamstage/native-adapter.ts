/** Optional native Agent Teams boundary for W2.
 *
 * This module is intentionally structural: the experimental Team package is
 * feature-detected from the host Context and is never imported or mounted by
 * the blueprint plugin. Every operation receives the exact live Agent object
 * used as the Team authority credential.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'

export interface TeamMembershipLike {
  readonly root: Agent
  readonly id: string
  readonly role: 'lead' | 'teammate'
  readonly name: string
}

export type TeamTaskAction = 'claim' | 'release' | 'edit' | 'set_dependencies' | 'complete' | 'reopen' | 'reassign' | 'delete'

export interface TeamCreateTaskRequest {
  subject: string
  description: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
}

export interface TeamUpdateTaskRequest {
  taskId: string
  expectedRevision: number
  action: TeamTaskAction
  subject?: string
  description?: string
  blockedBy?: readonly string[]
  writeScopes?: readonly string[]
  owner?: string
}

export interface TeamSpawnTeammateRequest {
  name: string
  description: string
  prompt: readonly unknown[]
  context: 'fresh' | 'fork'
  provider: string
  signal: AbortSignal
}

export interface TeamSendMessageRequest {
  target: string
  content: readonly unknown[]
  signal: AbortSignal
}

export interface TeamServiceLike {
  membership(agent: Agent): TeamMembershipLike
  tryMembership?(agent: Agent): TeamMembershipLike | undefined
  listMembers(agent: Agent): readonly Record<string, unknown>[]
  spawnTeammate(caller: Agent, request: TeamSpawnTeammateRequest): Promise<unknown>
  sendMessage(caller: Agent, request: TeamSendMessageRequest): Promise<unknown>
  createTask(caller: Agent, request: TeamCreateTaskRequest): Promise<Record<string, unknown>>
  getTask(caller: Agent, id: string): Record<string, unknown>
  listTasks(caller: Agent): readonly Record<string, unknown>[]
  updateTask(caller: Agent, request: TeamUpdateTaskRequest): Promise<Record<string, unknown>>
  waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<unknown>
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' }
}

/** Public subagent lifecycle boundary used for exact continuation release. */
export interface TeamSubagentServiceLike {
  drainChildren?(parent: Agent, childIds: readonly string[]): Promise<void>
}

export interface TeamHostContext {
  readonly agentTeams?: TeamServiceLike
  readonly agents?: { get(id: string): Agent | undefined }
  readonly subagents?: TeamSubagentServiceLike
  get?(key: string): unknown
}

export class TeamCapabilityUnavailableError extends Error {
  override readonly name = 'TeamCapabilityUnavailableError'
  readonly code = 'TEAM_UNAVAILABLE'
  constructor(detail = 'Agent Teams capability is unavailable') {
    super(detail)
  }
}

export class TeamIdentityUnavailableError extends Error {
  override readonly name = 'TeamIdentityUnavailableError'
  readonly code = 'TEAM_IDENTITY_UNAVAILABLE'
  constructor(detail = 'caller is not the exact live Team Lead') {
    super(detail)
  }
}

function hostValue(ctx: TeamHostContext, key: string): unknown {
  // Cordis service properties require a declared dependency. Optional native
  // capabilities use the public Context.get lookup so ordinary no-Team runs
  // do not acquire a mandatory injection or read an undeclared property.
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(key)
    } catch {
      return undefined
    }
  }
  if (key === 'agentTeams' && ctx.agentTeams !== undefined) return ctx.agentTeams
  if (key === 'agents' && ctx.agents !== undefined) return ctx.agents
  if (key === 'subagents' && ctx.subagents !== undefined) return ctx.subagents
  return undefined
}

export function resolveTeamService(ctx: TeamHostContext): TeamServiceLike {
  const value = hostValue(ctx, 'agentTeams')
  if (value === undefined || value === null || typeof value !== 'object') throw new TeamCapabilityUnavailableError()
  const service = value as Partial<TeamServiceLike>
  if (
    typeof service.membership !== 'function' ||
    typeof service.listMembers !== 'function' ||
    typeof service.spawnTeammate !== 'function' ||
    typeof service.sendMessage !== 'function' ||
    typeof service.createTask !== 'function' ||
    typeof service.getTask !== 'function' ||
    typeof service.listTasks !== 'function' ||
    typeof service.updateTask !== 'function' ||
    typeof service.waitForChange !== 'function' ||
    typeof service.interrupt !== 'function'
  ) {
    throw new TeamCapabilityUnavailableError()
  }
  return service as TeamServiceLike
}

function isExactLiveAgent(ctx: TeamHostContext, agent: Agent): boolean {
  const registry = hostValue(ctx, 'agents') as { get(id: string): Agent | undefined } | undefined
  // DSH's public Agent contract exposes only `id`.  Do not infer identity
  // through a private session field or a descriptor-child/session surrogate.
  const agentId = agent.id
  if (registry === undefined || typeof agentId !== 'string' || agentId.length === 0) return false
  return registry.get(agentId) === agent
}

export interface LeadHandle {
  readonly service: TeamServiceLike
  readonly agent: Agent
  readonly membership: TeamMembershipLike
  readonly teamId: string
}

export class TeamNativeAdapter {
  constructor(readonly context: TeamHostContext) {}

  /** Resolve only an exact live root Lead; no session-id or origin inference. */
  lead(agent: Agent): LeadHandle {
    if (!isExactLiveAgent(this.context, agent)) throw new TeamIdentityUnavailableError('caller Agent is stale or absent from the live registry')
    const service = resolveTeamService(this.context)
    let membership: TeamMembershipLike | undefined
    try {
      membership = service.tryMembership?.(agent) ?? service.membership(agent)
    } catch {
      throw new TeamIdentityUnavailableError()
    }
    if (
      membership === undefined ||
      membership.root !== agent ||
      membership.role !== 'lead' ||
      typeof membership.id !== 'string' ||
      membership.id.length === 0
    ) {
      throw new TeamIdentityUnavailableError()
    }
    return { service, agent, membership, teamId: membership.id }
  }

  /** Revalidate a handle before every native operation. A LeadHandle is an
   * authorization capability, but it is still rejected when its exact Agent
   * object or Team membership has gone stale. Cordis may return a fresh
   * traceable proxy for the same service on each lookup, so service object
   * identity is intentionally not part of this check. */
  private exactLead(lead: LeadHandle): LeadHandle {
    if (!isExactLiveAgent(this.context, lead.agent)) {
      throw new TeamIdentityUnavailableError('caller Agent is stale or absent from the live registry')
    }
    const service = resolveTeamService(this.context)
    let membership: TeamMembershipLike | undefined
    try {
      membership = service.tryMembership?.(lead.agent) ?? service.membership(lead.agent)
    } catch {
      throw new TeamIdentityUnavailableError()
    }
    if (membership === undefined || membership.root !== lead.agent || membership.role !== 'lead' || membership.id !== lead.teamId)
      throw new TeamIdentityUnavailableError()
    return { service, agent: lead.agent, membership, teamId: membership.id }
  }

  listMembers(lead: LeadHandle): readonly Record<string, unknown>[] {
    const exact = this.exactLead(lead)
    return exact.service.listMembers(exact.agent)
  }

  async spawnTeammate(lead: LeadHandle, request: TeamSpawnTeammateRequest): Promise<unknown> {
    const exact = this.exactLead(lead)
    return await exact.service.spawnTeammate(exact.agent, request)
  }

  async sendMessage(lead: LeadHandle, request: TeamSendMessageRequest): Promise<unknown> {
    const exact = this.exactLead(lead)
    return await exact.service.sendMessage(exact.agent, request)
  }

  async createTask(lead: LeadHandle, request: TeamCreateTaskRequest): Promise<Record<string, unknown>> {
    const exact = this.exactLead(lead)
    return await exact.service.createTask(exact.agent, request)
  }

  getTask(lead: LeadHandle, taskId: string): Record<string, unknown> {
    const exact = this.exactLead(lead)
    return exact.service.getTask(exact.agent, taskId)
  }

  listTasks(lead: LeadHandle): readonly Record<string, unknown>[] {
    const exact = this.exactLead(lead)
    return exact.service.listTasks(exact.agent)
  }

  async updateTask(lead: LeadHandle, request: TeamUpdateTaskRequest): Promise<Record<string, unknown>> {
    const exact = this.exactLead(lead)
    return await exact.service.updateTask(exact.agent, request)
  }

  /**
   * Release only the canonical direct children selected by the caller. The
   * Team service's private roster.stopTeammates is deliberately not used;
   * DSH's public subagent service owns continuation draining.
   */
  async drainChildren(lead: LeadHandle, ownedChildSessionIds: readonly string[]): Promise<void> {
    const exact = this.exactLead(lead)
    if (!Array.isArray(ownedChildSessionIds)) {
      throw new TeamIdentityUnavailableError('owned child session ids must be an array')
    }
    const childIds = [...ownedChildSessionIds]
    if (childIds.some(id => typeof id !== 'string' || id.trim().length === 0) || new Set(childIds).size !== childIds.length) {
      throw new TeamIdentityUnavailableError('owned child session ids must be unique non-empty identities')
    }
    if (childIds.length === 0) return
    let members: readonly Record<string, unknown>[]
    try {
      members = exact.service.listMembers(exact.agent)
    } catch {
      throw new TeamIdentityUnavailableError('Team roster is unavailable for child identity verification')
    }
    const directChildren = new Set(members.filter(member => member.role === 'teammate' && typeof member.id === 'string').map(member => member.id as string))
    if (childIds.some(id => id === exact.agent.id || !directChildren.has(id))) {
      throw new TeamIdentityUnavailableError('drain target is not an exact direct child of the Team Lead')
    }
    const subagents = hostValue(this.context, 'subagents') as TeamSubagentServiceLike | undefined
    if (subagents === undefined || typeof subagents.drainChildren !== 'function') {
      throw new TeamCapabilityUnavailableError('continuation drain capability is unavailable')
    }
    await subagents.drainChildren(exact.agent, childIds)
  }

  async waitForChange(lead: LeadHandle, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    const exact = this.exactLead(lead)
    return await exact.service.waitForChange(exact.agent, timeoutMs, signal)
  }

  interrupt(lead: LeadHandle, targetName: string): { previousStatus: 'running' | 'inactive' } {
    const exact = this.exactLead(lead)
    return exact.service.interrupt(exact.agent, targetName)
  }
}

export function memberSnapshot(member: unknown): {
  memberId: string
  name?: string
  phase: 'provisioning' | 'active' | 'failed' | 'inactive'
  status: string
  sessionId?: string
} {
  if (member === null || typeof member !== 'object' || Array.isArray(member)) {
    throw new TeamIdentityUnavailableError('Team member view is malformed')
  }
  const view = member as Record<string, unknown>
  const memberId = typeof view.id === 'string' ? view.id : ''
  if (memberId.length === 0) throw new TeamIdentityUnavailableError('Team member has no stable session identity')
  const status = typeof view.status === 'string' ? view.status : 'unknown'
  const rawPhase = view.phase
  const phase =
    status === 'provisioning' || status === 'failed' || status === 'inactive'
      ? status
      : status === 'running'
        ? 'active'
        : rawPhase === 'provisioning' || rawPhase === 'failed' || rawPhase === 'active' || rawPhase === 'inactive'
          ? rawPhase
          : (() => {
              throw new TeamIdentityUnavailableError(`Team member ${memberId} has an unrecognized runtime status`)
            })()
  return {
    memberId,
    ...(typeof view.name === 'string' && view.name.length > 0 ? { name: view.name } : {}),
    phase,
    status,
    ...(typeof view.id === 'string' ? { sessionId: view.id } : {})
  }
}
