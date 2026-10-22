import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import {
  frozenGraphCodec,
  frozenPresentationCodec,
  inspectSessionCodec,
  runLifecycleActionCodec,
  runQueryCodec,
  type InspectSessionArgs,
  type InspectSessionValue,
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
      selected = queried.records[0]?.record
    } else {
      const candidate = await this.context.store.tryGet(args.runId)
      if (candidate !== undefined && runBelongsToSession(candidate, args.sessionId)) selected = candidate
      if (selected === undefined) throw new RemoteError('blueprint/run-not-found', 'run-not-found', { runId: args.runId })
    }
    if (!selected) return inspectSessionCodec().parse({ status: 'unbound', sessionId: args.sessionId })
    if (this.context.backgroundFailures.has(selected.runId))
      throw new RemoteError('blueprint/durability-failed', 'background settlement unavailable', { operation: 'driver-settlement' })
    const definition = this.context.decodeDefinition(selected.definitionJson)
    const graph = frozenGraphCodec().parse({
      nodes: definition.graph.nodes.map(node => ({
        id: node.id,
        kind: node.kind,
        ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
        ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
        ...(node.branches === undefined ? {} : { branches: node.branches })
      })),
      edges: definition.graph.edges
    })
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
        run: projectRunSnapshot(selected, this.context.teamRuntime(selected)),
        ...(selected.source === undefined ? {} : { source: selected.source }),
        graph,
        ...(definition.presentation === undefined ? {} : { presentation: frozenPresentationCodec().parse(definition.presentation) }),
        focusAttemptIds: focusAttemptsForSession(selected, args.sessionId)
      }
    })
  }
}
