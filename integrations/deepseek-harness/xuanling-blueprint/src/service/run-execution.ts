import type { Context } from '@deepseek-ai/cordis'
import { ChildRunExecution, childOutputs } from './child-run-execution.ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createHash, randomUUID } from 'node:crypto'
import { captureNativeSourceParent, assertNativeSourceParent, type NativeSourceParent } from '../conversation/native-session-lineage.ts'
import { AgentCompositionUnsupportedError, BlueprintAgentExecutor, captureAgentModelSelection } from '../host/agent-executor.ts'
import { resolveEffectiveToolNames, type ToolBindings } from '../host/preflight.ts'
import type { AttemptDiagnostics } from '../host/runtime-diagnostics.ts'
import { TERMINAL_RUN_STATES, type RunRecord } from '../persistence/records.ts'
import type { RunStore } from '../persistence/run-store.ts'
import { DurabilityFailureError } from '../persistence/index.ts'
import { NodeValueError, matchesWireType, validateNodeInputs, structuralOutputs } from '../host/node-values.ts'
import { readyNodes, compileGraph } from '../orchestration/index.ts'
import { TeamArtifactError } from '../teamstage/output-artifact.ts'
import { TeamStageDriver } from '../teamstage/driver.ts'
import type { TeamStageObservations } from '../teamstage/observability.ts'
import { TeamDriverError, type TeamProviders } from '../teamstage/driver-admission.ts'
import { TeamAcceptanceRejectedError } from '../teamstage/acceptance.ts'
import { FrozenPackageIntegrityError, type Prepared, type PreparedTeam } from '../resources/runtime-snapshots.ts'
import type { decodeDefinition } from '../definition/index.ts'
import type { RuntimeHandle } from '../index.ts'
import type { LeadHandle } from '../teamstage/native-adapter.ts'
import { buildBindingFacts, toolsetBindingDigest } from './binding-facts.ts'

export interface RunExecutionConfig {
  readonly maxConcurrentNodes?: number
  readonly toolBindings?: ToolBindings
  readonly teamProviders?: TeamProviders
}

export interface RunExecutionContext {
  readonly ctx: Context
  readonly config: RunExecutionConfig
  readonly isClosing: () => boolean
  readonly decodeDefinition: (definitionJson: string) => ReturnType<typeof decodeDefinition>
  /** Optional façade seam retained for in-process observers and fixtures. */
  readonly driveRun?: (
    handle: RuntimeHandle,
    runId: string,
    definition: ReturnType<typeof decodeDefinition>,
    sourceParent?: NativeSourceParent
  ) => Promise<void>
  readonly cancelTeamRun: (
    handle: RuntimeHandle,
    run: RunRecord,
    lead?: LeadHandle,
    memberNames?: readonly string[],
    reason?: string,
    settleParentRun?: boolean
  ) => Promise<RunRecord>
  readonly teamObservations: TeamStageObservations
}

interface NodeSettlement {
  terminal: 'failed' | 'cancelled' | 'timed_out' | 'recovery_required'
  detail: Record<string, unknown>
}

/** Durable Run scheduler and node effect executor. The BlueprintService keeps
 * admission/wire policy; this owner supervises concurrent Attempts and is the
 * only place that drives structural nodes, Agent effects and TeamStage effects.
 */
export class RunExecutionService {
  private readonly children: ChildRunExecution
  constructor(private readonly context: RunExecutionContext) {
    this.children = new ChildRunExecution({
      isClosing: context.isClosing,
      schedule: (handle, runId, sourceParent) => this.scheduleRun(handle, runId, sourceParent, true),
      cancelTeam: (handle, record) => context.cancelTeamRun(handle, record)
    })
  }

  closeTree(handle: RuntimeHandle, runId: string): void {
    this.children.closeTree(handle, runId)
  }
  cancelTree(handle: RuntimeHandle, runId: string): Promise<RunRecord> {
    return this.children.cancelTree(handle, runId)
  }

  scheduleRun(handle: RuntimeHandle, runId: string, sourceParent?: NativeSourceParent, child = false): void {
    if (this.context.isClosing()) return
    if (handle.jobs.has(runId)) {
      handle.rerun.add(runId)
      return
    }
    const job = (child ? Promise.resolve() : handle.driverTail)
      .then(async () => {
        const run = await handle.store.get(runId)
        const definition = this.context.decodeDefinition(run.definitionJson)
        if (this.context.driveRun !== undefined) await this.context.driveRun(handle, runId, definition, sourceParent)
        else await this.driveRun(handle, runId, definition, sourceParent)
      })
      .catch(async () => {
        // Raw dependency errors (including causes/credentials) never become Run evidence.
        const run = await handle.store.get(runId)
        if (TERMINAL_RUN_STATES.includes(run.state) || run.state === 'recovery_required') return
        const unknown = run.attempts.some(a => a.intent !== undefined && a.result === undefined && a.state !== 'waiting_input')
        await handle.store.settleTerminal(runId, unknown ? 'recovery_required' : 'failed', { reason: 'driver-failed' })
      })
    // Always consume rejection; if even the failure write fails, preserve a typed
    // unavailable read rather than reporting a silently hung running projection.
    const observed = job.catch(() => {
      handle.backgroundFailures.set(runId, new Error('durable background settlement failed'))
    })
    handle.jobs.set(runId, observed)
    if (!child) handle.driverTail = observed
    void observed.then(() => {
      if (handle.jobs.get(runId) === observed) handle.jobs.delete(runId)
      if (handle.rerun.delete(runId)) this.scheduleRun(handle, runId, sourceParent, child)
    })
  }

  async driveRun(handle: RuntimeHandle, runId: string, definition: ReturnType<typeof decodeDefinition>, sourceParent?: NativeSourceParent): Promise<void> {
    const admitted = await handle.store.get(runId)
    if (admitted.bindingAdmission === 'pending') {
      if (!TERMINAL_RUN_STATES.includes(admitted.state) && admitted.state !== 'recovery_required')
        await handle.store.settleTerminal(runId, 'recovery_required', { reason: 'admission-incomplete' })
      return
    }
    const graph = compileGraph(definition)
    const capacity = this.context.config.maxConcurrentNodes ?? 4
    const controllers = new Map<string, AbortController>()
    const active = new Map<string, Promise<void>>()
    const completed: Array<{ nodeId: string; settlement?: NodeSettlement; error?: unknown }> = []
    let stop: NodeSettlement | undefined
    let fatal: unknown
    let hasFatal = false
    const exclusive = (nodeId: string) => {
      const node = graph.nodeById.get(nodeId)!
      // Both boundaries mutate Run-wide waiting/Team state. They own the Run
      // alone, without changing the native TeamStage's own member scheduling.
      return node.kind === 'humanDecision' || node.teamStage !== undefined
    }
    const abortAll = () => {
      for (const controller of controllers.values()) controller.abort()
    }
    handle.controllers.set(runId, controllers)
    try {
      while (true) {
        for (const done of completed.splice(0)) {
          active.delete(done.nodeId)
          if (done.error !== undefined) {
            fatal = done.error
            hasFatal = true
          }
          if (done.settlement !== undefined && (stop === undefined || done.settlement.terminal === 'recovery_required')) stop = done.settlement
        }
        const record = await handle.store.get(runId)
        // A failed branch must retain its reason when earlier siblings are
        // interrupted. Never choose the sibling cancellation by insertion order.
        const failure = record.attempts.find(a => a.state === 'failed' || a.state === 'timed_out') ?? record.attempts.find(a => a.state === 'cancelled')
        if (failure && stop === undefined)
          stop = {
            terminal: failure.state === 'timed_out' ? 'timed_out' : failure.state === 'cancelled' ? 'cancelled' : 'failed',
            detail: { reason: 'attempt-settled-non-success' }
          }
        if (this.context.isClosing() && !TERMINAL_RUN_STATES.includes(record.state) && record.state !== 'recovery_required')
          await handle.store.requestCancel(runId)
        const terminal = TERMINAL_RUN_STATES.includes(record.state) || record.state === 'recovery_required'
        if (stop !== undefined || hasFatal || terminal || record.state === 'cancelling' || this.context.isClosing()) {
          abortAll()
          if (active.size) {
            await Promise.race(active.values())
            continue
          }
          if (hasFatal) throw fatal
          // An unknown effect wins even if a concurrent cancellation/result
          // temporarily terminalized known Attempts. Do not fabricate its result.
          if (stop?.terminal === 'recovery_required') await handle.store.settleTerminal(runId, stop.terminal, stop.detail)
          else if (!terminal) {
            if (record.teamStage !== undefined && !['succeeded', 'failed', 'cancelled', 'timed_out', 'recovery_required'].includes(record.teamStage.state))
              await this.context.cancelTeamRun(handle, record)
            else await handle.store.settleTerminal(runId, stop?.terminal ?? 'cancelled', stop?.detail ?? { reason: 'no-in-flight-effect' })
          }
          return
        }
        if (record.state === 'waiting_input') return
        if (definition.graph.nodes.some(node => node.teamStage !== undefined) && record.source === undefined) {
          stop = { terminal: 'failed', detail: { reason: 'teamstage-executor-unavailable' } }
          continue
        }
        const decisions: Record<string, string> = {}
        const states = new Map<string, Array<RunRecord['attempts'][number]['state']>>()
        for (const a of record.attempts) {
          states.set(a.nodeId, [...(states.get(a.nodeId) ?? []), a.state])
          const outcome = a.result?.outcome as { branch?: string } | undefined
          if (outcome?.branch) decisions[a.nodeId] = outcome.branch
        }
        const schedule = readyNodes(definition, { attempts: [...states].map(([nodeId, states]) => ({ nodeId, states })), decisions })
        if (schedule.skipped.length) {
          await handle.store.transition(runId, draft => {
            if (draft.state === 'cancelling') return
            for (const nodeId of schedule.skipped) {
              if (!draft.attempts.some(a => a.nodeId === nodeId))
                draft.attempts.push({ attemptId: `att-${randomUUID()}`, nodeId, attempt: 1, state: 'skipped' })
            }
          })
          continue
        }
        const ready = schedule.ready.filter(nodeId => !active.has(nodeId))
        // Only Run-wide human/Team boundaries wait for unrelated work to
        // drain. Ordinary structural nodes advance when their own dependencies
        // settle, allowing fast branches to refill the available capacity.
        const first = active.size > 0 && ready.some(exclusive) ? undefined : ready[0]
        const hasExclusive = [...active.keys()].some(exclusive)
        if (first !== undefined && active.size < capacity && !hasExclusive && (!exclusive(first) || active.size === 0)) {
          // Reserve in memory BEFORE preparation awaits. The durable intent is
          // still committed by executeRunNode before the first external effect.
          const controller = new AbortController()
          controllers.set(first, controller)
          const job = this.executeRunNode(handle, runId, definition, record, first, controller, sourceParent)
            .then(
              settlement => {
                completed.push({ nodeId: first, ...(settlement === undefined ? {} : { settlement }) })
              },
              error => {
                completed.push({ nodeId: first, error })
              }
            )
            .finally(() => {
              controllers.delete(first)
            })
          active.set(first, job)
          // Re-read after every admission/settlement. Fast branch descendants
          // refill capacity without waiting for an unrelated slow branch.
          continue
        }
        if (active.size) {
          await Promise.race(active.values())
          continue
        }
        const complete = definition.graph.nodes.every(n => record.attempts.some(a => a.nodeId === n.id && ['succeeded', 'skipped'].includes(a.state)))
        await handle.store.settleTerminal(runId, complete ? 'succeeded' : 'recovery_required', {
          reason: complete ? 'selected-paths-settled' : 'no-safe-progress'
        })
        return
      }
    } finally {
      // This also covers an unexpected store/read failure: no background Agent
      // may escape the owner job before scheduleRun writes its failure receipt.
      abortAll()
      await Promise.allSettled(active.values())
      if (handle.controllers.get(runId) === controllers) handle.controllers.delete(runId)
    }
  }

  private async executeRunNode(
    handle: RuntimeHandle,
    runId: string,
    definition: ReturnType<typeof decodeDefinition>,
    record: RunRecord,
    nodeId: string,
    controller: AbortController,
    sourceParent?: NativeSourceParent
  ): Promise<NodeSettlement | undefined> {
    const graph = compileGraph(definition)
    const node = graph.nodeById.get(nodeId)!
    let intent: Awaited<ReturnType<RunStore['recordIntent']>> | undefined
    let diagnostics: Extract<AttemptDiagnostics, { status: 'available' }> | undefined
    const settledDiagnostics = (code: string) => (diagnostics === undefined ? {} : { diagnostics: { ...diagnostics, acceptance: { code } } })
    try {
      const initial: unknown = JSON.parse(record.inputRef)
      const bound: Record<string, unknown> = {}
      const omitted = new Set<string>()
      let bindingError: NodeValueError | undefined
      for (const dep of graph.dataDeps.get(nodeId) ?? []) {
        const parent = record.attempts.findLast(a => a.nodeId === dep.fromNode)
        if (node.kind === 'join' && parent?.state === 'skipped') {
          omitted.add(dep.toPort)
          continue
        }
        const outcome = parent?.result?.outcome as { outputs?: Record<string, unknown> } | undefined
        if (parent?.state !== 'succeeded') {
          bindingError ??= new NodeValueError('binding-unavailable')
          continue
        }
        if (!outcome?.outputs || !Object.hasOwn(outcome.outputs, dep.fromPort)) {
          bindingError ??= new NodeValueError(node.kind === 'condition' ? 'condition-input-invalid' : 'binding-missing')
          continue
        }
        const value = outcome.outputs[dep.fromPort]
        if (!matchesWireType(value, graph.nodeById.get(dep.fromNode)?.outputs?.[dep.fromPort]) || !matchesWireType(value, node.inputs?.[dep.toPort])) {
          bindingError ??= new NodeValueError(node.kind === 'condition' ? 'condition-input-invalid' : 'binding-invalid')
        }
        Object.defineProperty(bound, dep.toPort, { value, enumerable: true, writable: true, configurable: true })
      }
      // Multiple edges may target a port. A skipped sibling cannot erase an
      // actually selected binding at that same declared port.
      for (const port of Object.keys(bound)) omitted.delete(port)
      const input = (graph.dataDeps.get(nodeId)?.length ?? 0) > 0 ? bound : initial
      const inputJson = JSON.stringify(input)
      let prepared: Prepared | PreparedTeam | undefined
      if (node.kind === 'agentTask' && bindingError === undefined) {
        try {
          prepared =
            node.teamStage === undefined ? await handle.snapshots.prepare(runId, definition, node) : await handle.snapshots.prepareTeam(runId, definition, node)
        } catch (error) {
          if (error instanceof FrozenPackageIntegrityError) throw error
          // A binding that was available at admission can disappear before an
          // Attempt. Persist the Attempt and settle a typed drift result.
          bindingError = new NodeValueError('binding-drift')
        }
      }
      if (this.context.isClosing() || controller.signal.aborted) {
        if (this.context.isClosing()) {
          const requested = await handle.store.requestCancel(runId)
          if (requested.teamStage !== undefined) await this.context.cancelTeamRun(handle, requested)
        }
        return
      }
      const effectiveToolNames = prepared ? resolveEffectiveToolNames(this.context.ctx, definition, node, this.context.config.toolBindings) : []
      // Capture once before durable intent; the explicit property below tells
      // the executor not to read a later Host default, even when undefined.
      const modelSelection =
        prepared && node.teamStage === undefined
          ? node.modelSelection === undefined
            ? record.bindingSelections !== undefined && Object.hasOwn(record.bindingSelections, nodeId)
              ? (record.bindingSelections[nodeId] ?? undefined)
              : captureAgentModelSelection(this.context.ctx)
            : {
                provider: node.modelSelection.provider,
                model: node.modelSelection.model,
                ...(node.modelSelection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(node.modelSelection.reasoningEffort) })
              }
          : undefined
      const bindingFacts =
        prepared === undefined || node.kind !== 'agentTask'
          ? undefined
          : buildBindingFacts({
              nodeId,
              ...(node.agentRef === undefined ? {} : { agentRef: node.agentRef }),
              ...(node.skillRefs === undefined ? {} : { skillRefs: node.skillRefs }),
              ...(node.toolsetRefs === undefined ? {} : { toolsetRefs: node.toolsetRefs }),
              ...(node.toolAllowlist === undefined ? {} : { toolAllowlist: node.toolAllowlist }),
              resourceDigests: prepared.resourceDigests,
              effectiveToolNames,
              toolsetDigest: toolsetBindingDigest(this.context.ctx, effectiveToolNames),
              ...(modelSelection === undefined ? {} : { modelSelection }),
              ...(node.outputSchemaRef === undefined ? {} : { outputSchemaRef: node.outputSchemaRef })
            })
      if (bindingFacts !== undefined && record.bindingDigests !== undefined) {
        const expected = record.bindingDigests[`node:${nodeId}:binding`]
        if (expected === undefined || expected !== bindingFacts.digests[`node:${nodeId}:binding`]) bindingError ??= new NodeValueError('binding-drift')
      }
      if (bindingError === undefined) {
        diagnostics = {
          status: 'available',
          input: {
            type: input === null ? 'null' : Array.isArray(input) ? 'array' : (typeof input as 'object' | 'string' | 'number' | 'boolean'),
            bytes: Buffer.byteLength(inputJson),
            sha256: createHash('sha256').update(inputJson).digest('hex')
          },
          resourceDigests: prepared?.resourceDigests ?? {},
          ...(modelSelection === undefined ? {} : { modelSelection }),
          tools: { effectiveNames: effectiveToolNames },
          acceptance: { code: 'pending' }
        }
      }
      // A rejected incomplete binding has no dispatch input/model/tool facts
      // to invent. Still commit the Attempt before its typed rejection result.
      // Reserve the suffix before the durable intent, but bind the identity to
      // the Attempt ID generated inside recordIntent's atomic write.
      const executionSessionSuffix = node.kind === 'agentTask' && node.teamStage === undefined ? randomUUID().slice(0, 8) : undefined
      const sessionIdForAttempt = executionSessionSuffix === undefined ? undefined : (attemptId: string) => `bp-${runId}-${attemptId}-${executionSessionSuffix}`
      intent = await handle.store.recordIntent(runId, {
        nodeId,
        kind: node.kind,
        ...(sessionIdForAttempt === undefined ? {} : { sessionIdForAttempt }),
        // Even a rejected binding keeps the freshly resolved resource
        // digests as durable evidence.  Diagnostics remain unavailable until
        // the binding is admissible, but the drift comparison must be
        // inspectable without dispatching the effect.
        resourceDigests: prepared?.resourceDigests ?? diagnostics?.resourceDigests ?? {},
        ...(bindingFacts === undefined ? {} : { bindingDigests: bindingFacts.digests }),
        diagnostics: diagnostics ?? { status: 'unavailable' }
      })
      const executionSessionId = sessionIdForAttempt?.(intent.attemptId)
      // cancel may have committed while the intent or preparation was in progress.
      const beforeDispatch = await handle.store.get(runId)
      if (beforeDispatch.state === 'cancelling' || beforeDispatch.attempts.some(a => ['failed', 'timed_out', 'cancelled'].includes(a.state))) controller.abort()
      if (controller.signal.aborted) {
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: false,
          outcome: { kind: 'cancelled' },
          evidence: 'cancel-before-dispatch',
          ...settledDiagnostics('cancelled')
        })
        return
      }
      if (bindingError !== undefined) throw bindingError
      validateNodeInputs(node, input, omitted)
      if (node.kind === 'blueprintCall') {
        const child = await this.children.execute(handle, record, node, intent.attemptId, input, controller.signal, sourceParent)
        if (child === undefined || child.state === 'recovery_required') return { terminal: 'recovery_required', detail: { reason: 'child-effect-unknown' } }
        const outputs = child.state === 'succeeded' ? childOutputs(child, node) : {}
        const kind = child.state === 'timed_out' ? 'timeout' : child.state
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: child.state === 'succeeded',
          outcome: { kind, outputs, childRunId: child.runId },
          evidence: `child-${child.state}`,
          ...settledDiagnostics(kind)
        })
        return
      }
      if (node.kind === 'condition') {
        const config = node.condition!
        const predicate = (input as Record<string, unknown>)[config.inputPort] as boolean
        const branch = predicate ? config.trueBranch : config.falseBranch
        const outputs = structuralOutputs(node, input, omitted)
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: true,
          outcome: { branch, outputs, value: predicate },
          evidence: 'condition-boolean',
          ...settledDiagnostics('not-required')
        })
        return
      }
      if (node.kind === 'humanDecision') {
        await handle.store.transition(runId, draft => {
          if (draft.state === 'cancelling') return
          draft.state = 'waiting_input'
          draft.attempts.find(a => a.attemptId === intent!.attemptId)!.state = 'waiting_input'
        })
        if ((await handle.store.get(runId)).state === 'cancelling') {
          await handle.store.recordResult(runId, intent.attemptId, {
            ok: false,
            outcome: { kind: 'cancelled' },
            evidence: 'cancel-before-wait',
            ...settledDiagnostics('cancelled')
          })
        }
        return
      }
      if (node.kind === 'input' || node.kind === 'output' || node.kind === 'join') {
        const outputs = structuralOutputs(node, input, omitted)
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: true,
          outcome: { outputs, value: input },
          evidence: 'structural-node',
          ...settledDiagnostics('not-required')
        })
        return
      }
      if (prepared && diagnostics) {
        const cwd = prepared.materialize(intent.attemptId)
        if (node.teamStage !== undefined) {
          const parent = sourceParent ?? (record.source === undefined ? undefined : captureNativeSourceParent(this.context.ctx, record.source.sessionId))
          if (!parent) throw new TeamDriverError('teamstage-identity-unavailable')
          assertNativeSourceParent(this.context.ctx, parent, record.source!.sessionId)
          await new TeamStageDriver(this.context.ctx, handle.store, handle.root, this.context.config.teamProviders, this.context.teamObservations).execute({
            record,
            node,
            attemptId: intent.attemptId,
            source: parent.agent,
            prepared: prepared as PreparedTeam,
            effectiveToolNames,
            input,
            cwd,
            signal: controller.signal,
            mapOutputs: value => {
              const outputs: Record<string, unknown> = {}
              for (const [port, type] of Object.entries(node.outputs ?? {})) {
                if (type === 'string') outputs[port] = JSON.stringify(value)
                else if (type === 'json') outputs[port] = value
                else throw new NodeValueError('output-invalid')
                if (!matchesWireType(outputs[port], type)) throw new NodeValueError('output-invalid')
              }
              return outputs
            }
          })
          return
        }
        const registry = this.context.ctx.get('agents')
        if (!registry) throw new AgentCompositionUnsupportedError('missing registry')
        const executor = new BlueprintAgentExecutor(this.context.ctx, registry as never)
        const evidence = await executor.execute({
          runId,
          attemptId: intent.attemptId,
          nodeId,
          sessionId: executionSessionId!,
          ...(node.interaction === undefined
            ? {}
            : {
                interaction: node.interaction,
                bindManaged: (agent, signal, uncertain) => handle.managed.bind(runId, intent!.attemptId, agent, signal, uncertain)
              }),
          agentMd: prepared.agentMd,
          ...(prepared.agentPreset === undefined ? {} : { agentPreset: prepared.agentPreset }),
          ...(prepared.agentComposition === undefined ? {} : { agentComposition: prepared.agentComposition }),
          ...(prepared.hostAgentComposition === undefined ? {} : { hostAgentComposition: prepared.hostAgentComposition }),
          skills: prepared.skills,
          input: typeof input === 'string' ? input : inputJson,
          cwd,
          signal: controller.signal,
          ...(record.source === undefined ? {} : { source: record.source }),
          ...(sourceParent === undefined ? {} : { sourceParent }),
          effectiveToolNames,
          modelSelection,
          ...(prepared.outputSchema === undefined ? {} : { outputSchema: prepared.outputSchema })
        })
        if (evidence.outcome.kind === 'recovery_required') {
          return { terminal: 'recovery_required', detail: { reason: 'agent-effect-unknown', sessionId: evidence.sessionId } }
        }
        // Schema-backed ports consume the authoritative tools/result capture,
        // never JSON guessed from assistant prose or a provider's detail text.
        let outcome = evidence.outcome
        let acceptance = evidence.acceptance ?? { code: 'not-required' }
        if (prepared.outputSchema !== undefined && outcome.ok && (acceptance.code !== 'accepted' || !Object.hasOwn(evidence, 'structuredOutput'))) {
          const kind = acceptance.code === 'output-invalid' ? 'output-invalid' : 'structured-output-missing'
          outcome = { ok: false, kind, detail: kind }
          acceptance = { code: kind, ...(acceptance.issueCount === undefined ? {} : { issueCount: acceptance.issueCount }) }
        }
        diagnostics = { ...diagnostics, acceptance, tools: { effectiveNames: effectiveToolNames, denials: evidence.toolDenials ?? [] } }
        const outputs: Record<string, unknown> = {}
        if (outcome.ok) {
          for (const [port, type] of Object.entries(node.outputs ?? {})) {
            if (type === 'string') outputs[port] = prepared.outputSchema === undefined ? outcome.detail : JSON.stringify(evidence.structuredOutput)
            else if (type === 'json') {
              if (prepared.outputSchema === undefined) {
                try {
                  outputs[port] = JSON.parse(outcome.detail)
                } catch {
                  throw new NodeValueError('output-invalid')
                }
              } else outputs[port] = evidence.structuredOutput
            } else throw new NodeValueError('output-invalid')
            if (!matchesWireType(outputs[port], type)) throw new NodeValueError('output-invalid')
          }
        }
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: outcome.ok,
          outcome: { ...outcome, outputs },
          evidence: outcome.ok ? 'agent-succeeded' : `agent-${outcome.kind}`,
          diagnostics
        })
        return
      }
      // decodeDefinition admits only the executable node kinds above. If
      // an in-process caller bypasses that boundary, fail closed instead of
      // persisting a compatibility result for a node with no executor.
      throw new Error('node-executor-unavailable')
    } catch (error) {
      const current = await handle.store.get(runId)
      if (TERMINAL_RUN_STATES.includes(current.state)) return
      if (error instanceof DurabilityFailureError) throw error
      if (node.teamStage !== undefined && intent !== undefined) {
        if (current.state === 'cancelling' && current.teamStage?.cancel !== undefined && controller.signal.aborted) {
          // The durable cutoff owns settlement. Join its existing native
          // interrupt/drain/delete work; an aborted execution alone cannot
          // distinguish a known cancellation from an unknown Team effect.
          await this.context.cancelTeamRun(handle, current)
          return
        }
        const verifiedRejection = error instanceof TeamArtifactError || error instanceof TeamAcceptanceRejectedError
        const issue = error instanceof TeamDriverError || verifiedRejection ? error.issueCode : 'teamstage-effect-unknown'
        const known = [
          'teamstage-tool-not-permitted',
          'teamstage-tool-rejected',
          'teamstage-provider-failed',
          'teamstage-output-invalid',
          'teamstage-structured-output-missing',
          'teamstage-task-not-completed'
        ].includes(issue)
        const unknown =
          (!known && !verifiedRejection) ||
          current.teamStage?.effects?.some(effect => ['pending', 'recovery_required'].includes(effect.state)) ||
          current.state === 'cancelling' ||
          controller.signal.aborted
        if (current.teamStage !== undefined && current.teamStage.state !== 'recovery_required') {
          await handle.store.updateTeamStage(runId, { state: unknown ? 'recovery_required' : 'failed', ...(unknown ? { recovery: { code: issue } } : {}) })
        }
        if (unknown) {
          return { terminal: 'recovery_required', detail: { reason: issue } }
        }
        await handle.store.recordResult(runId, intent.attemptId, { ok: false, outcome: { kind: issue }, evidence: issue, ...settledDiagnostics(issue) })
        return
      }
      const kind = error instanceof NodeValueError ? error.code : 'failed'
      if (intent)
        await handle.store.recordResult(runId, intent.attemptId, {
          ok: false,
          outcome: { kind, detail: error instanceof NodeValueError ? kind : 'node resources, binding or output rejected' },
          evidence: 'node-failed',
          ...settledDiagnostics(kind)
        })
      else {
        // Cancellation can win while resource preparation has no intent.
        // It must not create a new Attempt or replace the durable cutoff.
        if (current.state === 'cancelling' || current.attempts.some(a => ['failed', 'timed_out', 'cancelled'].includes(a.state))) return
        return { terminal: 'failed', detail: { reason: 'prepare-failed' } }
      }
    }
  }
}
