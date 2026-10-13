/** Derived, read-only conversation state. No executor or document-editor dependency. */
import { inspectSessionArgsCodec, inspectSessionCodec } from '../conversation/contracts.ts'
import type { InspectSessionArgs, InspectSessionValue, TeamStageProjection } from '../conversation/contracts.ts'
import { BlueprintRemoteError } from './remote.ts'
import type { RemoteNamespace } from './remote.ts'

export interface ConversationHost {
  inspectSession(args: InspectSessionArgs): Promise<unknown>
}

/** Expose only the one read RPC; preserve native proxy receivers and strict wire decoding. */
export function resolveConversationHost(ctx: { get(key: string): unknown }): ConversationHost | undefined {
  const namespace = ctx.get('remote.blueprint') as RemoteNamespace | undefined
  if (!namespace) return undefined
  return { async inspectSession(args) {
    const request = inspectSessionArgsCodec().safeParse(args)
    if (!request.success) throw new BlueprintRemoteError('blueprint/bad-request')
    const method = namespace.inspectSession
    if (!method) throw new BlueprintRemoteError('blueprint/capability-unavailable')
    const result = await method.call(namespace, request.data)
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') {
      throw new BlueprintRemoteError('blueprint/dto-invalid')
    }
    if (!result.ok) throw new BlueprintRemoteError(typeof result.error?.code === 'string' ? result.error.code : 'blueprint/remote-failed')
    return result.value
  } }
}

export interface ConversationSnapshot {
  readonly sessionId: string
  readonly value: InspectSessionValue | null
  readonly connection: 'loading' | 'connected' | 'stale' | 'unavailable'
  readonly selectedAttemptId: string | null
  readonly errorCode: string | null
}

/** Shape decoding and aggregate binding are separate checks. A Team DTO must
 * describe the selected frozen Run and its original graph Attempt. */
function validateTeamStageProjection(value: Extract<InspectSessionValue, { status: 'bound' }>): boolean {
  const { run, graph, source, team: selectedTeam } = value.selected
  const team = run.team
  if (!team) return selectedTeam === undefined
  if (selectedTeam !== undefined && JSON.stringify(selectedTeam) !== JSON.stringify(team)) return false
  if (team.runId !== run.runId || !graph.nodes.some(node => node.id === team.stageId && node.kind === 'agentTask')
    || source !== undefined && source.sessionId !== team.leadSessionId) return false
  if (team.attemptId !== undefined && !run.attempts.some(attempt => attempt.attemptId === team.attemptId && attempt.nodeId === team.stageId)) return false
  const accepted = team.outputAcceptance
  return accepted === undefined || accepted.runId === team.runId && accepted.stageId === team.stageId
    && accepted.taskId === team.taskId && (accepted.attemptId === undefined || accepted.attemptId === team.attemptId)
    && team.members.some(member => member.sessionId === accepted.sourceSessionId)
}

function validateTeamStageContinuity(previous: TeamStageProjection, current: TeamStageProjection | undefined): boolean {
  if (!current) return false
  const fixed = ['runId', 'stageId', 'teamId', 'leadSessionId', 'taskSpecificationFingerprint', 'attemptId', 'taskId'] as const
  return fixed.every(key => previous[key] === undefined || previous[key] === current[key])
    && (previous.taskRevision === undefined || current.taskRevision !== undefined && current.taskRevision >= previous.taskRevision)
}

export class ConversationController {
  private snapshot: ConversationSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly choices = new Map<string, string>()
  private epoch = 0
  private connected = true
  private pending: number | null = null

  constructor(private readonly host: ConversationHost | undefined, sessionId: string) {
    this.snapshot = { sessionId, value: null, connection: 'loading', selectedAttemptId: null, errorCode: null }
  }

  readonly getSnapshot = (): ConversationSnapshot => this.snapshot
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(change: Partial<ConversationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of this.listeners) listener()
  }

  /** Invalidate old-generation responses before addressing another Session. */
  setSession(sessionId: string): void {
    if (sessionId === this.snapshot.sessionId) return
    this.epoch++
    this.pending = null
    this.publish({ sessionId, value: null, connection: 'loading', selectedAttemptId: null, errorCode: null })
  }

  /** Mount/cleanup only change local observation ownership, never Host execution. */
  resume(): void { this.connected = true }
  pause(): void {
    this.connected = false
    this.epoch++
    this.pending = null
    if (this.snapshot.value?.status === 'bound') this.publish({ connection: 'stale' })
  }
  markStale(): void {
    this.epoch++
    this.pending = null
    this.publish({ connection: this.snapshot.value?.status === 'bound' ? 'stale' : 'unavailable' })
  }

  /** A slow read must settle before polling again; explicit refresh/selection may supersede it. */
  async poll(): Promise<void> { if (this.pending === null) await this.refresh() }

  async selectRun(runId: string): Promise<void> {
    if (this.snapshot.value?.status !== 'bound' || !this.snapshot.value.runs.some(run => run.runId === runId)) return
    this.choices.set(this.snapshot.sessionId, runId)
    this.epoch++
    if (this.snapshot.value.selected.run.runId !== runId) {
      this.publish({ value: null, connection: 'loading', selectedAttemptId: null, errorCode: null })
    }
    await this.refresh()
  }

  selectAttempt(attemptId: string): void {
    const value = this.snapshot.value
    if (value?.status === 'bound' && value.selected.run.attempts.some(attempt => attempt.attemptId === attemptId)) {
      this.publish({ selectedAttemptId: attemptId })
    }
  }

  async refresh(): Promise<void> {
    if (!this.connected) return
    const epoch = ++this.epoch
    this.pending = epoch
    const sessionId = this.snapshot.sessionId
    const runId = this.choices.get(sessionId)
    try {
      if (!this.host) throw new BlueprintRemoteError('blueprint/host-unavailable')
      const raw = await this.host.inspectSession({ sessionId, ...(runId === undefined ? {} : { runId }) })
      if (epoch !== this.epoch || !this.connected) return
      const parsed = inspectSessionCodec().safeParse(raw)
      if (!parsed.success || parsed.data.sessionId !== sessionId) throw new BlueprintRemoteError('blueprint/dto-invalid')
      const value = parsed.data
      if (runId !== undefined && value.status !== 'bound') throw new BlueprintRemoteError('blueprint/dto-invalid')
      if (value.status === 'bound') {
        const selected = value.selected
        if ((runId !== undefined && selected.run.runId !== runId)
          || !value.runs.some(run => run.runId === selected.run.runId && run.definitionRevision === selected.run.definitionRevision)
          || selected.focusAttemptIds.some(id => !selected.run.attempts.some(attempt => attempt.attemptId === id))
          || !validateTeamStageProjection(value)) {
          throw new BlueprintRemoteError('blueprint/dto-invalid')
        }
        const previous = this.snapshot.value
        if (previous?.status === 'bound' && previous.selected.run.runId === selected.run.runId
          && (previous.selected.run.definitionRevision !== selected.run.definitionRevision || previous.selected.run.seq > selected.run.seq
            || previous.selected.run.team !== undefined && !validateTeamStageContinuity(previous.selected.run.team, selected.run.team))) {
          throw new BlueprintRemoteError('blueprint/dto-invalid')
        }
        // Default choice follows Host's latest Run; manual historical choices never follow polling.
        value.runs.sort((a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId))
      }
      const selectedAttemptId = value.status === 'bound'
        && value.selected.run.attempts.some(attempt => attempt.attemptId === this.snapshot.selectedAttemptId)
        ? this.snapshot.selectedAttemptId : null
      this.publish({ value, connection: 'connected', selectedAttemptId, errorCode: null })
    } catch (error) {
      if (epoch !== this.epoch || !this.connected) return
      // Unknown transport errors carry no raw body, path, prompt or secret into the view.
      this.publish({ connection: this.snapshot.value?.status === 'bound' ? 'stale' : 'unavailable',
        errorCode: error instanceof BlueprintRemoteError ? error.code : 'blueprint/remote-failed' })
    } finally {
      if (this.pending === epoch) this.pending = null
    }
  }
}

export function conversationFocusNodes(value: InspectSessionValue | null): string[] {
  if (value?.status !== 'bound') return []
  const focus = new Set(value.selected.focusAttemptIds)
  const nodes = new Set(value.selected.graph.nodes.map(node => node.id))
  return [...new Set(value.selected.run.attempts.filter(attempt => attempt.attemptId !== undefined
    && focus.has(attempt.attemptId) && nodes.has(attempt.nodeId)).map(attempt => attempt.nodeId))]
}
