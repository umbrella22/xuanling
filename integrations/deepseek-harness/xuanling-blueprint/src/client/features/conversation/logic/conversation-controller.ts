/** Derived, read-only conversation state. No executor or document-editor dependency. */
import {
  inspectSessionArgsCodec,
  inspectSessionCodec,
  resolveRecoveryArgsCodec,
  resolveRecoveryValueCodec,
  runLifecycleActionArgsCodec,
  runLifecycleActionCodec,
  runQueryArgsCodec,
  runQueryCodec
} from '../../../../conversation/contracts.ts'
import { teamStageBlocksRecovery } from '../../../../host/teamstage-recovery.ts'
import type {
  InspectSessionArgs,
  InspectSessionValue,
  ResolveRecoveryArgs,
  ResolveRecoveryValue,
  RunLifecycleActionArgs,
  RunQueryArgs,
  RunLifecycleActionValue,
  TeamStageProjection
} from '../../../../conversation/contracts.ts'
import { BlueprintRemoteError } from '../../../adapters/host/remote.ts'
import type { RemoteNamespace } from '../../../adapters/host/remote.ts'

export interface ConversationHost {
  inspectSession(args: InspectSessionArgs): Promise<unknown>
  queryRuns?(args: RunQueryArgs): Promise<unknown>
  archiveRun?(args: RunLifecycleActionArgs): Promise<RunLifecycleActionValue>
  restoreRun?(args: RunLifecycleActionArgs): Promise<RunLifecycleActionValue>
  resolveRecovery?(args: ResolveRecoveryArgs): Promise<ResolveRecoveryValue>
}

/** Expose only the one read RPC; preserve native proxy receivers and strict wire decoding. */
export function resolveConversationHost(ctx: { get(key: string): unknown }): ConversationHost | undefined {
  const namespace = ctx.get('remote.blueprint') as RemoteNamespace | undefined
  if (!namespace) return undefined
  const host: ConversationHost = {
    async inspectSession(args) {
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
    }
  }
  if (typeof namespace.queryRuns === 'function') {
    host.queryRuns = async args => {
      const request = runQueryArgsCodec().safeParse(args)
      if (!request.success) throw new BlueprintRemoteError('blueprint/bad-request')
      const result = await namespace.queryRuns!.call(namespace, request.data)
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') {
        throw new BlueprintRemoteError('blueprint/dto-invalid')
      }
      if (!result.ok) throw new BlueprintRemoteError(typeof result.error?.code === 'string' ? result.error.code : 'blueprint/remote-failed')
      const parsed = runQueryCodec().safeParse(result.value)
      if (!parsed.success) throw new BlueprintRemoteError('blueprint/dto-invalid')
      return parsed.data
    }
  }
  for (const method of ['archiveRun', 'restoreRun'] as const) {
    if (typeof namespace[method] !== 'function') continue
    host[method] = async args => {
      const request = runLifecycleActionArgsCodec().safeParse(args)
      if (!request.success) throw new BlueprintRemoteError('blueprint/bad-request')
      const result = await namespace[method]!.call(namespace, request.data)
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') {
        throw new BlueprintRemoteError('blueprint/dto-invalid')
      }
      if (!result.ok) throw new BlueprintRemoteError(typeof result.error?.code === 'string' ? result.error.code : 'blueprint/remote-failed')
      const parsed = runLifecycleActionCodec().safeParse(result.value)
      if (!parsed.success) throw new BlueprintRemoteError('blueprint/dto-invalid')
      return parsed.data
    }
  }
  if (typeof namespace.resolveRecovery === 'function') {
    host.resolveRecovery = async args => {
      const request = resolveRecoveryArgsCodec().safeParse(args)
      if (!request.success) throw new BlueprintRemoteError('blueprint/bad-request')
      const result = await namespace.resolveRecovery!.call(namespace, request.data)
      if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.ok !== 'boolean') {
        throw new BlueprintRemoteError('blueprint/dto-invalid')
      }
      if (!result.ok) throw new BlueprintRemoteError(typeof result.error?.code === 'string' ? result.error.code : 'blueprint/remote-failed')
      const parsed = resolveRecoveryValueCodec().safeParse(result.value)
      if (!parsed.success) throw new BlueprintRemoteError('blueprint/dto-invalid')
      return parsed.data
    }
  }
  return host
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
  if (
    team.runId !== run.runId ||
    !graph.nodes.some(node => node.id === team.stageId && node.kind === 'agentTask') ||
    (source !== undefined && source.sessionId !== team.leadSessionId)
  )
    return false
  if (team.attemptId !== undefined && !run.attempts.some(attempt => attempt.attemptId === team.attemptId && attempt.nodeId === team.stageId)) return false
  const accepted = team.outputAcceptance
  return (
    accepted === undefined ||
    (accepted.runId === team.runId &&
      accepted.stageId === team.stageId &&
      accepted.taskId === team.taskId &&
      (accepted.attemptId === undefined || accepted.attemptId === team.attemptId) &&
      team.members.some(member => member.sessionId === accepted.sourceSessionId))
  )
}

function validateTeamStageContinuity(previous: TeamStageProjection, current: TeamStageProjection | undefined): boolean {
  if (!current) return false
  const fixed = ['runId', 'stageId', 'teamId', 'leadSessionId', 'taskSpecificationFingerprint', 'attemptId', 'taskId'] as const
  return (
    fixed.every(key => previous[key] === undefined || previous[key] === current[key]) &&
    (previous.taskRevision === undefined || (current.taskRevision !== undefined && current.taskRevision >= previous.taskRevision))
  )
}

/** Typed Host answer for a lifecycle conflict on a healthy connection. */
const RECOVERY_CONFLICT_CODE = 'blueprint/run-lifecycle-conflict'

export class ConversationController {
  private snapshot: ConversationSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly choices = new Map<string, string>()
  private epoch = 0
  private connected = true
  private pending: number | null = null
  private loadingMore = false

  constructor(
    private readonly host: ConversationHost | undefined,
    sessionId: string
  ) {
    this.snapshot = { sessionId, value: null, connection: 'loading', selectedAttemptId: null, errorCode: null }
  }

  readonly getSnapshot = (): ConversationSnapshot => this.snapshot
  readonly hasRunQuery = (): boolean => this.host?.queryRuns !== undefined
  readonly hasRunLifecycle = (): boolean => this.host?.archiveRun !== undefined
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
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
  resume(): void {
    this.connected = true
  }
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
  async poll(): Promise<void> {
    if (this.pending === null) await this.refresh()
  }

  async selectRun(runId: string): Promise<void> {
    const value = this.snapshot.value
    if (
      value?.status !== 'bound' ||
      !(
        value.runs.some(run => run.runId === runId) ||
        value.selected.ancestors?.some(run => run.runId === runId) ||
        value.selected.run.attempts.some(attempt => attempt.childRunId === runId)
      )
    )
      return
    this.choices.set(this.snapshot.sessionId, runId)
    this.epoch++
    if (value.selected.run.runId !== runId) {
      // Preserve the current graph and breadcrumbs if navigation fails.
      this.publish({ connection: 'loading', selectedAttemptId: null, errorCode: null })
    }
    await this.refresh()
  }

  async loadMoreRuns(): Promise<void> {
    const value = this.snapshot.value
    const queryRuns = this.host?.queryRuns
    if (!this.connected || this.loadingMore || !queryRuns || value?.status !== 'bound' || value.nextCursor === undefined) return
    const epoch = ++this.epoch
    this.loadingMore = true
    const sessionId = this.snapshot.sessionId
    try {
      const raw = await queryRuns({ sessionId, cursor: value.nextCursor, limit: 20 })
      if (epoch !== this.epoch || !this.connected) return
      const parsed = runQueryCodec().safeParse(raw)
      if (!parsed.success) throw new BlueprintRemoteError('blueprint/dto-invalid')
      const merged = new Map(value.runs.map(run => [run.runId, run]))
      for (const run of parsed.data.runs) merged.set(run.runId, run)
      const runs = [...merged.values()].sort((a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId))
      const nextValue =
        parsed.data.nextCursor === undefined
          ? (() => {
              const { nextCursor: _previousCursor, ...withoutCursor } = value
              return { ...withoutCursor, runs }
            })()
          : { ...value, runs, nextCursor: parsed.data.nextCursor }
      this.publish({
        value: nextValue,
        connection: 'connected',
        errorCode: null
      })
    } catch (error) {
      if (epoch !== this.epoch || !this.connected) return
      this.publish({
        connection: this.snapshot.value?.status === 'bound' ? 'stale' : 'unavailable',
        errorCode: error instanceof BlueprintRemoteError ? error.code : 'blueprint/remote-failed'
      })
    } finally {
      this.loadingMore = false
    }
  }

  async archiveSelectedRun(): Promise<void> {
    const value = this.snapshot.value
    const archiveRun = this.host?.archiveRun
    if (!this.connected || !archiveRun || value?.status !== 'bound') return
    const epoch = ++this.epoch
    const sessionId = this.snapshot.sessionId
    try {
      // The Session scopes a conversation-created Run to its registered
      // Workspace; without it the Host would archive into its default store.
      await archiveRun({ runId: value.selected.run.runId, sessionId })
      if (epoch !== this.epoch || !this.connected) return
      this.choices.delete(sessionId)
      await this.refresh()
    } catch (error) {
      if (epoch !== this.epoch || !this.connected) return
      this.publish({
        connection: this.snapshot.value?.status === 'bound' ? 'stale' : 'unavailable',
        errorCode: error instanceof BlueprintRemoteError ? error.code : 'blueprint/remote-failed'
      })
    }
  }

  /** Resolve the observed `recovery_required` Run at its frozen sequence. The
   * unknown effect is never replayed: the note becomes the durable audit
   * evidence. Typed failures publish the existing static error code and return
   * false; a successful call refreshes the bound Session facts. */
  async resolveRecovery(resolution: 'failed' | 'succeeded', note: string): Promise<boolean> {
    const value = this.snapshot.value
    const resolve = this.host?.resolveRecovery
    if (!this.connected || !resolve || value?.status !== 'bound') return false
    const epoch = ++this.epoch
    const runId = value.selected.run.runId
    try {
      const resolved = await resolve({
        runId,
        sessionId: this.snapshot.sessionId,
        resolution,
        note: note.trim(),
        expectedSeq: value.selected.run.seq
      })
      if (epoch !== this.epoch || !this.connected) return false
      if (resolved.runId !== runId) throw new BlueprintRemoteError('blueprint/dto-invalid')
      await this.refresh()
      return true
    } catch (error) {
      if (epoch !== this.epoch || !this.connected) return false
      const errorCode = error instanceof BlueprintRemoteError ? error.code : 'blueprint/remote-failed'
      if (errorCode === RECOVERY_CONFLICT_CODE) {
        // A typed lifecycle conflict (stale review, Run already settled,
        // TeamStage needs native cleanup) is a business answer from a healthy
        // Host, not a lost connection. Re-read the Session so the form sees the
        // current state and `seq`, then keep the code visible; marking the
        // view stale here would lock the form on its outdated `expectedSeq`.
        await this.refresh()
        if (!this.connected || this.snapshot.connection !== 'connected') return false
        this.publish({ errorCode })
        return false
      }
      this.publish({
        connection: this.snapshot.value?.status === 'bound' ? 'stale' : 'unavailable',
        errorCode
      })
      return false
    }
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
        if (
          (runId !== undefined && selected.run.runId !== runId) ||
          !value.runs.some(run => run.runId === selected.run.runId && run.definitionRevision === selected.run.definitionRevision) ||
          selected.focusAttemptIds.some(id => !selected.run.attempts.some(attempt => attempt.attemptId === id)) ||
          !validateTeamStageProjection(value)
        ) {
          throw new BlueprintRemoteError('blueprint/dto-invalid')
        }
        const previous = this.snapshot.value
        if (
          previous?.status === 'bound' &&
          previous.selected.run.runId === selected.run.runId &&
          (previous.selected.run.definitionRevision !== selected.run.definitionRevision ||
            previous.selected.run.seq > selected.run.seq ||
            (previous.selected.run.team !== undefined && !validateTeamStageContinuity(previous.selected.run.team, selected.run.team)))
        ) {
          throw new BlueprintRemoteError('blueprint/dto-invalid')
        }
        // Default choice follows Host's latest Run; manual historical choices never follow polling.
        value.runs.sort((a, b) => b.createdAt - a.createdAt || b.runId.localeCompare(a.runId))
      }
      const selectedAttemptId =
        value.status === 'bound' && value.selected.run.attempts.some(attempt => attempt.attemptId === this.snapshot.selectedAttemptId)
          ? this.snapshot.selectedAttemptId
          : null
      this.publish({ value, connection: 'connected', selectedAttemptId, errorCode: null })
    } catch (error) {
      if (epoch !== this.epoch || !this.connected) return
      // Unknown transport errors carry no raw body, path, prompt or secret into the view.
      this.publish({
        connection: this.snapshot.value?.status === 'bound' ? 'stale' : 'unavailable',
        errorCode: error instanceof BlueprintRemoteError ? error.code : 'blueprint/remote-failed'
      })
    } finally {
      if (this.pending === epoch) this.pending = null
    }
  }
}

/** Recovery is resolvable in the conversation seat only for the bound selected
 * Run. A TeamStage with an unknown native effect is `team-manual`: the contract
 * rejects resolution until the native Team is cleaned up, so the UI must not
 * offer the buttons. */
export type ConversationRecoveryState = 'none' | 'resolvable' | 'team-manual'
export function conversationRecoveryState(value: InspectSessionValue | null | undefined): ConversationRecoveryState {
  if (value?.status !== 'bound') return 'none'
  const run = value.selected.run
  if (run.state !== 'recovery_required') return 'none'
  return teamStageBlocksRecovery(run.team?.state) ? 'team-manual' : 'resolvable'
}

export function conversationFocusNodes(value: InspectSessionValue | null): string[] {
  if (value?.status !== 'bound') return []
  const focus = new Set(value.selected.focusAttemptIds)
  const nodes = new Set(value.selected.graph.nodes.map(node => node.id))
  return [
    ...new Set(
      value.selected.run.attempts
        .filter(attempt => attempt.attemptId !== undefined && focus.has(attempt.attemptId) && nodes.has(attempt.nodeId))
        .map(attempt => attempt.nodeId)
    )
  ]
}
