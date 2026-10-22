import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  inspectRunViewCodec,
  inspectSessionCodec,
  runLifecycleActionCodec,
  runQueryCodec,
  type InspectSessionArgs,
  type InspectSessionValue,
  type InspectRunViewValue,
  type RunLifecycleActionArgs,
  type RunLifecycleActionValue,
  type RunQueryArgs,
  type RunQueryValue,
  type RunSnapshotView
} from '../conversation/contracts.ts'
import { focusAttemptsForSession, projectRunSnapshot } from '../conversation/run-projection.ts'
import { projectRunReport, type RunReport } from '../conversation/run-report.ts'
import type { BlueprintDefinition } from '../definition/types.ts'
import { RunLifecycleConflictError, RunNotFoundError } from '../persistence/run-store.ts'
import type { RunStore } from '../persistence/run-store.ts'
import { RunQueryError, runBelongsToSession, runHistorySummary } from '../persistence/run-query.ts'
import type { RunQuery } from '../persistence/run-query.ts'
import type { RunRecord } from '../persistence/records.ts'
import type { TeamStageRuntime } from '../host/teamstage-diagnostics.ts'
import { projectDefinitionGraph } from '../conversation/blueprint-reference-contracts.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'blueprint/hierarchy-unavailable': { runId: string }
  }
}

/** Dependencies needed by read/lifecycle use cases.
 *
 * The service deliberately receives the canonical store and a query boundary,
 * rather than a BlueprintService. This keeps the public façade responsible
 * for argument validation/runtime acquisition while this collaborator owns the
 * durable read projection and its safe wire error mapping.
 */
export interface RunReadContext {
  readonly store: RunStore
  readonly query: RunQuery
  readonly backgroundFailures: ReadonlyMap<string, Error>
  readonly decodeDefinition: (definitionJson: string) => BlueprintDefinition
  readonly teamRuntime: (record: RunRecord) => TeamStageRuntime | undefined
}

export class RunReadService {
  constructor(private readonly context: RunReadContext) {}

  /** Ancestry is a durable two-sided relation, never inferred from creation order or source Session. */
  private async ancestors(record: RunRecord): Promise<RunRecord[]> {
    const result: RunRecord[] = []
    const seen = new Set([record.runId])
    let child = record
    while (child.parent !== undefined) {
      const parent = await this.context.store.tryGet(child.parent.runId)
      if (
        !parent ||
        seen.has(parent.runId) ||
        !parent.attempts.some(attempt => attempt.attemptId === child.parent!.attemptId && attempt.childRunId === child.runId)
      ) {
        throw new RemoteError('blueprint/hierarchy-unavailable', 'Run hierarchy unavailable', { runId: record.runId })
      }
      seen.add(parent.runId)
      result.unshift(parent)
      child = parent
    }
    return result
  }

  private async canInspect(record: RunRecord, sessionId: string): Promise<boolean> {
    if (runBelongsToSession(record, sessionId)) return true
    // A node Session may return to its verified ancestors, including archived history.
    let cursor: string | undefined
    do {
      const page = await this.context.query.pageWithRecords({ sessionId, includeArchived: true, ...(cursor ? { cursor } : {}) })
      for (const { record: owned } of page.records) {
        if ((await this.ancestors(owned)).some(parent => parent.runId === record.runId)) return true
      }
      cursor = page.page.nextCursor
    } while (cursor !== undefined)
    return false
  }

  private async projectView(record: RunRecord): Promise<InspectRunViewValue> {
    const definition = this.context.decodeDefinition(record.definitionJson)
    return inspectRunViewCodec().parse({
      run: projectRunSnapshot(record, this.context.teamRuntime(record)),
      graph: projectDefinitionGraph(definition),
      ...(definition.presentation === undefined ? {} : { presentation: definition.presentation }),
      ancestors: (await this.ancestors(record)).map(parent => ({
        runId: parent.runId,
        blueprintId: parent.blueprintId,
        definitionRevision: parent.definitionRevision,
        documentRevision: parent.documentRevision
      }))
    })
  }

  async inspectRunView(runId: string, sessionId?: string): Promise<InspectRunViewValue> {
    if (this.context.backgroundFailures.has(runId))
      throw new RemoteError('blueprint/durability-failed', 'background settlement unavailable', { operation: 'driver-settlement' })
    const record = await this.context.store.tryGet(runId)
    if (!record || (sessionId !== undefined && !(await this.canInspect(record, sessionId))))
      throw new RemoteError('blueprint/run-not-found', 'run-not-found', { runId })
    return this.projectView(record)
  }

  async inspectRun(runId: string, sessionId?: string): Promise<RunSnapshotView> {
    if (this.context.backgroundFailures.has(runId))
      throw new RemoteError('blueprint/durability-failed', 'background settlement unavailable', { operation: 'driver-settlement' })
    const record = await this.context.store.tryGet(runId)
    if (record === undefined || (sessionId !== undefined && !runBelongsToSession(record, sessionId)))
      throw new RemoteError('blueprint/run-not-found', `run ${runId} not found`, { runId })
    return projectRunSnapshot(record, this.context.teamRuntime(record))
  }

  /** Same ownership rules as inspectRun; projects the durable cut into a
   * what-ran / what-failed / why / next-time report. */
  async reportRun(runId: string, sessionId?: string): Promise<RunReport> {
    if (this.context.backgroundFailures.has(runId))
      throw new RemoteError('blueprint/durability-failed', 'background settlement unavailable', { operation: 'driver-settlement' })
    const record = await this.context.store.tryGet(runId)
    if (record === undefined || (sessionId !== undefined && !runBelongsToSession(record, sessionId)))
      throw new RemoteError('blueprint/run-not-found', `run ${runId} not found`, { runId })
    return projectRunReport(record, this.context.decodeDefinition)
  }

  async queryRuns(args: RunQueryArgs): Promise<RunQueryValue> {
    try {
      return runQueryCodec().parse(await this.context.query.page(args))
    } catch (error) {
      if (error instanceof RunQueryError) {
        if (error.code === 'INVALID_CURSOR') throw new RemoteError('blueprint/invalid-cursor', 'invalid run history cursor', {})
        throw new RemoteError('blueprint/invalid-query', 'invalid run history query', { reason: error.code.toLowerCase() })
      }
      if (error instanceof RunNotFoundError) throw new RemoteError('blueprint/run-not-found', 'Run not found', { runId: error.runId })
      if (error instanceof RemoteError) throw error
      throw new RemoteError('blueprint/durability-failed', 'Run history unavailable', { operation: 'run-query' })
    }
  }

  async setArchived(args: RunLifecycleActionArgs, archived: boolean): Promise<RunLifecycleActionValue> {
    try {
      return runLifecycleActionCodec().parse(await this.context.store.setArchived(args.runId, archived))
    } catch (error) {
      if (error instanceof RunNotFoundError) throw new RemoteError('blueprint/run-not-found', 'Run not found', { runId: error.runId })
      if (error instanceof RunLifecycleConflictError)
        throw new RemoteError('blueprint/run-lifecycle-conflict', 'Run lifecycle action rejected', {
          runId: error.runId,
          detail: 'run-not-terminal'
        })
      if (error instanceof RemoteError) throw error
      throw new RemoteError('blueprint/durability-failed', 'Run lifecycle action failed', {
        operation: archived ? 'run-archive' : 'run-restore'
      })
    }
  }

  async inspectSession(args: InspectSessionArgs): Promise<InspectSessionValue> {
    const queried = await this.context.query.pageWithRecords({
      sessionId: args.sessionId,
      limit: 20,
      ...(args.runId === undefined ? {} : { includeArchived: true })
    })
    const page = queried.page
    let selected: RunRecord | undefined
    if (args.runId === undefined) {
      let candidates = queried
      // Descendants inherit the source Session. Choose its newest root Run;
      // a node Session still defaults to the Run containing its own Attempt.
      while (true) {
        selected = candidates.records.find(({ record }) => record.parent === undefined || record.source?.sessionId !== args.sessionId)?.record
        if (selected || candidates.page.nextCursor === undefined) break
        candidates = await this.context.query.pageWithRecords({ sessionId: args.sessionId, limit: 20, cursor: candidates.page.nextCursor })
      }
    } else {
      const candidate = await this.context.store.tryGet(args.runId)
      if (candidate !== undefined && (await this.canInspect(candidate, args.sessionId))) selected = candidate
      if (selected === undefined) throw new RemoteError('blueprint/run-not-found', 'run-not-found', { runId: args.runId })
    }
    if (!selected) return inspectSessionCodec().parse({ status: 'unbound', sessionId: args.sessionId })
    if (this.context.backgroundFailures.has(selected.runId))
      throw new RemoteError('blueprint/durability-failed', 'background settlement unavailable', { operation: 'driver-settlement' })
    const view = await this.projectView(selected)
    const runs = page.runs.map(run => ({
      runId: run.runId,
      ...(run.blueprintId === undefined ? {} : { blueprintId: run.blueprintId }),
      state: run.state,
      createdAt: run.createdAt,
      definitionRevision: run.definitionRevision
    }))
    if (!runs.some(run => run.runId === selected!.runId)) {
      const archived = await this.context.store.isArchived(selected.runId)
      const summary = runHistorySummary(selected, archived)
      runs.push({
        runId: summary.runId,
        ...(summary.blueprintId === undefined ? {} : { blueprintId: summary.blueprintId }),
        state: summary.state,
        createdAt: summary.createdAt,
        definitionRevision: summary.definitionRevision
      })
    }
    return inspectSessionCodec().parse({
      status: 'bound',
      sessionId: args.sessionId,
      runs,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      selected: {
        ...view,
        ...(selected.source === undefined ? {} : { source: selected.source }),
        focusAttemptIds: focusAttemptsForSession(selected, args.sessionId)
      }
    })
  }
}
