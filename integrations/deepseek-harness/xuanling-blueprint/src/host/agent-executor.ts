/** One scoped public Agent per Attempt. Quiescence is not successful completion:
 * only a durable turn/end from this dispatch decides the outcome. */
import { createHash, randomUUID } from 'node:crypto'
import type { AgentCancelCause, Session } from '@deepseek-ai/dsh-session'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import { assertObjectJsonSchema, validateJsonSchemaValue, type ObjectJsonSchema, type ToolExecution } from '@deepseek-ai/dsh-tools'
import { attachStructuredRuntime, STRUCTURED_OUTPUT_TOOL, type StructuredAttachment } from './dsh-structured-compat.ts'
import { nativeSessionLineage, type NativeSourceParent } from '../conversation/native-session-lineage.ts'
import type { RunSource } from '../conversation/contracts.ts'
import { validatePackagedPreset, type PackagedPreset, type HostAgentComposition } from '../portability/host-resources.ts'

export interface SkillSnapshotInput {
  name: string
  content: string
  digest: string
}
export interface AgentExecutionSpec {
  runId: string
  attemptId: string
  nodeId: string
  sessionId?: string
  source?: RunSource
  sourceParent?: NativeSourceParent
  agentMd: string
  skills: SkillSnapshotInput[]
  input: string
  cwd: string
  /** Host-owned DSH preset identity. It is passed as metadata to the fresh
   * Attempt Agent; an existing live Agent is never reused. */
  agentPreset?: string
  agentComposition?: PackagedPreset
  hostAgentComposition?: HostAgentComposition
  timeoutMs?: number
  signal?: AbortSignal
  /** Omitted means no business tools. Transport never grants business rights. */
  effectiveToolNames?: string[]
  outputSchema?: ObjectJsonSchema
  /** Own-property undefined means the driver already captured no selection. */
  modelSelection?: ModelSelection | undefined
}
export interface AgentExecutionEvidence {
  sessionId: string
  agentCreated: boolean
  scopedInjections: string[]
  inboxSplicedSeen: boolean
  acceptance: { code: string; issueCount?: number }
  toolDenials: Array<{ toolName: string; code: string }>
  structuredOutput?: unknown
  outcome:
    | { ok: true; kind: 'succeeded'; detail: string }
    | {
        ok: false
        kind: 'provider-failed' | 'failed' | 'timeout' | 'cancelled' | 'recovery_required' | 'structured-output-missing' | 'output-invalid'
        detail: string
      }
}
interface RuntimeAgent {
  session: Session
  followup(input: unknown): void
  inject(input: unknown): void
  whenIdle(): Promise<void>
  cancel(cause: AgentCancelCause): void
}
interface AgentHandle {
  agent: RuntimeAgent
  dispose(): Promise<void>
}
interface AgentRegistryLike {
  create?(options: Record<string, unknown>): Promise<AgentHandle>
  createAgent?(ownerCtx: unknown, options: Record<string, unknown>): Promise<AgentHandle>
}
export class AgentCompositionUnsupportedError extends Error {
  override readonly name = 'AgentCompositionUnsupportedError'
  readonly code = 'AGENT_COMPOSITION_UNSUPPORTED'
  constructor(_detail: string) {
    super('public Agent composition is unavailable')
  }
}

function detachedSelection(selected: ModelSelection | undefined): ModelSelection | undefined {
  return selected === undefined
    ? undefined
    : {
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort })
      }
}

/** Read the Host default exactly once, before intent in the production driver.
 * A detached value also prevents later Host mutation from changing this Attempt. */
export function captureAgentModelSelection(ownerCtx: { get(service: string): unknown }): ModelSelection | undefined {
  const defaults = ownerCtx.get('agentDefaultModel') as { currentSelection(): ModelSelection | undefined } | undefined
  return detachedSelection(defaults?.currentSelection())
}

// Shutdown observation budget ONLY: inference has already been cancelled. This
// bounds unknown-effect reporting, never grants extra execution/retry time.
export const AGENT_CANCEL_QUIESCENCE_MS = 1_000

export class BlueprintAgentExecutor {
  constructor(
    private readonly ownerCtx: { get(service: string): unknown },
    private readonly registry: AgentRegistryLike
  ) {}

  async execute(spec: AgentExecutionSpec): Promise<AgentExecutionEvidence> {
    const sessionId = spec.sessionId ?? `bp-${spec.runId}-${spec.attemptId}-${randomUUID().slice(0, 8)}`
    const evidence: AgentExecutionEvidence = {
      sessionId,
      agentCreated: false,
      scopedInjections: [],
      inboxSplicedSeen: false,
      outcome: { ok: false, kind: 'recovery_required', detail: 'no confirmed turn settlement' },
      acceptance: { code: spec.outputSchema === undefined ? 'not-required' : 'pending' },
      toolDenials: []
    }
    // Snapshot the policy before asynchronous creation. Neither a later caller
    // mutation nor scope-local registrations may widen its business surface.
    const effectiveNames = new Set((spec.effectiveToolNames ?? []).filter(name => name !== 'run_code' && name !== STRUCTURED_OUTPUT_TOOL))
    let structured: StructuredAttachment | undefined
    let schema: ObjectJsonSchema | undefined
    let invalidIssueCount = 0
    const denied = new WeakSet<ToolExecution>()
    const denialKeys = new Set<string>()
    let lineage: ReturnType<typeof nativeSessionLineage> | undefined
    const setup = (agentCtx: Context) => {
      const tools = agentCtx.tools
      if (!tools || typeof tools.restrict !== 'function' || typeof tools.guard !== 'function') {
        throw new AgentCompositionUnsupportedError('missing scoped Tools policy')
      }
      // restrict controls model presentation; guard additionally covers tools
      // registered locally and runs AFTER extensible pre-execute listeners.
      tools.restrict({ allow: [...effectiveNames] })
      tools.guard(exec => {
        if (exec.name === 'run_code' || effectiveNames.has(exec.name) || (schema !== undefined && exec.name === STRUCTURED_OUTPUT_TOOL)) return undefined
        denied.add(exec)
        return 'blueprint tool permission denied'
      })
      if (schema !== undefined) structured = attachStructuredRuntime(agentCtx, schema)
      agentCtx.on('tools/result', function (this: unknown, exec, result) {
        if (schema !== undefined && exec.name === STRUCTURED_OUTPUT_TOOL) {
          // Only a count from an authoritative INVALID_ARGS escapes DSH's
          // validator. Host denial of malformed args is not schema acceptance.
          // A later valid capture attempt supersedes an earlier invalid one,
          // even if post-policy or its PTC parent subsequently rejects it.
          invalidIssueCount = result.isError && result.error.info?.code === 'INVALID_ARGS' ? validateJsonSchemaValue(schema, exec.arguments).length : 0
          if (invalidIssueCount > 0) return
        }
        if (!result.isError) return
        const hostCode = result.error.info?.code
        if (hostCode === 'ABORTED' || hostCode === 'ABORTED_BEFORE_DISPATCH') return
        // Never copy Host reason, message or arbitrary error codes. An opaque
        // rejection is not an assertion that a specific approval was absent.
        const code =
          denied.has(exec) || (exec.name !== 'run_code' && !effectiveNames.has(exec.name) && !(schema !== undefined && exec.name === STRUCTURED_OUTPUT_TOOL))
            ? 'tool-not-permitted'
            : 'tool-rejected'
        const key = `${exec.name}\0${code}`
        if (!denialKeys.has(key)) {
          denialKeys.add(key)
          evidence.toolDenials.push({ toolName: exec.name, code })
        }
      })
      agentCtx.on('agent/inbox/inserted', () => {
        evidence.inboxSplicedSeen = true
      })
      return lineage?.setup(agentCtx)
    }
    if (spec.signal?.aborted) {
      evidence.outcome = { ok: false, kind: 'cancelled', detail: 'cancelled before Agent creation' }
      if (spec.outputSchema !== undefined) evidence.acceptance = { code: 'cancelled' }
      return evidence
    }
    let timedOut = false
    const deadlineController = spec.timeoutMs === undefined ? undefined : new AbortController()
    const signal =
      spec.signal === undefined
        ? (deadlineController?.signal ?? new AbortController().signal)
        : deadlineController === undefined
          ? spec.signal
          : AbortSignal.any([spec.signal, deadlineController.signal])
    const deadline =
      spec.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            deadlineController!.abort()
          }, spec.timeoutMs)
    let grace: ReturnType<typeof setTimeout> | undefined
    let handle: AgentHandle | undefined
    let quiescent = false
    let cancelSent = false
    let submitted = false
    let cancel: (() => void) | undefined
    let unknownSettlement: Promise<'unknown'> | undefined
    try {
      // Explicit undefined is already captured; do not silently reread Host.
      const agentOptions = Object.hasOwn(spec, 'modelSelection') ? detachedSelection(spec.modelSelection) : captureAgentModelSelection(this.ownerCtx)
      if (spec.outputSchema !== undefined) {
        const frozen: unknown = structuredClone(spec.outputSchema)
        try {
          assertObjectJsonSchema(frozen)
        } catch {
          throw new AgentCompositionUnsupportedError('invalid frozen schema')
        }
        schema = frozen
      }
      if (spec.source !== undefined) lineage = nativeSessionLineage(this.ownerCtx as Context, spec.source, sessionId, spec.sourceParent)
      // Keep ownership on the plugin context. Durable parentage does not make
      // a source conversation view or its Agent the execution lifecycle owner.
      const options = {
        sessionId,
        meta: {
          cwd: spec.cwd,
          origin: 'subagent',
          ...(spec.agentPreset === undefined ? {} : { agentPreset: spec.agentPreset }),
          ...(lineage === undefined ? {} : { parentSession: lineage.parentSessionId })
        },
        setup,
        signal,
        ...(agentOptions === undefined ? {} : { agentOptions })
      }
      const creation = Promise.resolve().then(async () => {
        signal.throwIfAborted()
        let disposePreset: (() => Promise<void>) | undefined
        try {
          if (spec.agentComposition !== undefined || spec.hostAgentComposition !== undefined) {
            const portable = spec.agentComposition === undefined ? undefined : validatePackagedPreset(structuredClone(spec.agentComposition))
            if (portable !== undefined && portable.requiredBindings.length > 0)
              throw new AgentCompositionUnsupportedError('packaged preset bindings unavailable')
            const composition = portable ?? structuredClone(spec.hostAgentComposition!)
            const presets = this.ownerCtx.get('agentPresets') as
              | { register?(definition: { id: string; plugins: Array<Record<string, unknown>> }): Promise<() => Promise<void>> }
              | undefined
            if (typeof presets?.register !== 'function') throw new AgentCompositionUnsupportedError('preset registry unavailable')
            const digest = createHash('sha256').update(JSON.stringify(composition.plugins)).digest('hex')
            const presetId = `bp-preset-${digest.slice(0, 16)}-${randomUUID().slice(0, 8)}`
            disposePreset = await presets.register({ id: presetId, plugins: composition.plugins })
            options.meta.agentPreset = presetId
            signal.throwIfAborted()
          }
          const created = this.registry.create
            ? await this.registry.create(options)
            : this.registry.createAgent
              ? await this.registry.createAgent(this.ownerCtx, options)
              : (() => {
                  throw new AgentCompositionUnsupportedError('missing factory')
                })()
          if (disposePreset === undefined) return created
          const release = disposePreset
          return {
            agent: created.agent,
            async dispose() {
              try {
                await created.dispose()
              } finally {
                await release()
              }
            }
          }
        } catch (error) {
          await disposePreset?.()
          throw error
        }
      })
      let onAbort: (() => void) | undefined
      const aborted = new Promise<undefined>(resolve => {
        onAbort = () => resolve(undefined)
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) onAbort()
      })
      try {
        handle = await Promise.race([creation, aborted])
      } catch {
        if (!signal.aborted) throw new AgentCompositionUnsupportedError('creation rejected')
      } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort)
      }
      if (!handle) {
        // No followup was dispatched. A late publication must not receive input;
        // clean it via the same public cancel/quiescence contract when it arrives.
        void creation
          .then(async late => {
            late.agent.cancel({ kind: 'parent' })
            await late.agent.whenIdle()
            await late.dispose()
          })
          .catch(() => {})
        evidence.outcome = { ok: false, kind: timedOut ? 'timeout' : 'cancelled', detail: 'Agent creation cancelled before dispatch' }
        return evidence
      }
      evidence.agentCreated = true
      const agent = handle.agent
      let releaseUnknown: (() => void) | undefined
      const unknown = new Promise<'unknown'>(resolve => {
        releaseUnknown = () => resolve('unknown')
      })
      unknownSettlement = unknown
      let releaseStopped: (() => void) | undefined
      const stopped = new Promise<'stopped'>(resolve => {
        releaseStopped = () => resolve('stopped')
      })
      cancel = () => {
        if (cancelSent) return
        cancelSent = true
        releaseStopped?.()
        // The create signal only owns creation. Explicitly bind the published
        // Agent operation; timeout uses the real parent cause, not invented API.
        try {
          agent.cancel({ kind: 'parent' })
        } catch {
          releaseUnknown?.()
          return
        }
        grace = setTimeout(() => releaseUnknown?.(), AGENT_CANCEL_QUIESCENCE_MS)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        const before = agent.session.snapshotEvents().length
        if (signal.aborted) cancel()
        if (!signal.aborted && lineage !== undefined) {
          // A durability participant may never settle. Cancellation releases
          // this pre-dispatch wait; the late operation retains its append facts
          // and observes the signal before it can advance to another boundary.
          const established = lineage.establishCatalog(agent.session, signal).then(() => 'established' as const)
          if ((await Promise.race([established, stopped])) === 'stopped') signal.throwIfAborted()
        }
        if (!signal.aborted) {
          for (const skill of spec.skills) {
            agent.inject(
              createUserMessage({
                content: [{ type: 'text', text: `[blueprint skill ${skill.name} digest=${skill.digest}]\n${skill.content}` }],
                source: { kind: 'user' }
              })
            )
            evidence.scopedInjections.push(`${skill.name}@${skill.digest.slice(0, 12)}`)
          }
          if (spec.agentMd) {
            agent.inject(createUserMessage({ content: [{ type: 'text', text: `[blueprint agent]\n${spec.agentMd}` }], source: { kind: 'user' } }))
            evidence.scopedInjections.push('agent@snapshot')
          }
          submitted = true // followup may throw after partially accepting input
          agent.followup(createUserMessage({ content: [{ type: 'text', text: spec.input }], source: { kind: 'user' } }))
        }
        const idle = agent.whenIdle().then(() => {
          quiescent = true
          return 'idle' as const
        })
        if (signal.aborted) cancel()
        if ((await Promise.race([idle, unknown])) === 'unknown') return evidence
        const events = agent.session.snapshotEvents().slice(before)
        const end = events.filter(event => event.type === 'turn/end').at(-1)
        const reason = end?.data.reason
        if (timedOut) evidence.outcome = { ok: false, kind: 'timeout', detail: 'Agent exceeded its execution deadline and became quiescent' }
        else if (spec.signal?.aborted || reason?.kind === 'aborted') evidence.outcome = { ok: false, kind: 'cancelled', detail: 'Agent turn was aborted' }
        else if (reason?.kind === 'completed') {
          const detail = events
            .filter(event => event.type === 'assistant/message' && event.data.turn === end?.data.turn && !event.data.interrupted)
            .flatMap(event =>
              event.type === 'assistant/message'
                ? event.data.message.content.filter(block => block.type === 'text').map(block => (block.type === 'text' ? block.text : ''))
                : []
            )
            .join('\n')
          if (schema === undefined) evidence.outcome = { ok: true, kind: 'succeeded', detail }
          else {
            const captured = structured?.captured()
            if (captured !== undefined) {
              evidence.structuredOutput = captured.value
              evidence.acceptance = { code: 'accepted' }
              evidence.outcome = { ok: true, kind: 'succeeded', detail }
            } else if (invalidIssueCount > 0) {
              evidence.acceptance = { code: 'output-invalid', issueCount: invalidIssueCount }
              evidence.outcome = { ok: false, kind: 'output-invalid', detail: 'structured output did not match the frozen schema' }
            } else {
              evidence.acceptance = { code: 'structured-output-missing' }
              evidence.outcome = { ok: false, kind: 'structured-output-missing', detail: 'no authoritative structured output was accepted' }
            }
          }
        } else if (reason?.kind === 'error') {
          evidence.outcome = { ok: false, kind: 'provider-failed', detail: 'Agent turn ended with a provider/runtime error' }
        } else if (reason?.kind === 'max-tokens' || reason?.kind === 'blocked') {
          evidence.outcome = { ok: false, kind: 'failed', detail: 'Agent turn ended without complete output' }
        }
      } catch {
        cancel()
        try {
          const idle = agent.whenIdle().then(() => {
            quiescent = true
            return 'idle' as const
          })
          if ((await Promise.race([idle, unknown])) === 'idle' && !submitted)
            evidence.outcome = {
              ok: false,
              kind: timedOut ? 'timeout' : signal.aborted ? 'cancelled' : 'failed',
              detail: 'Agent input composition stopped before dispatch'
            }
        } catch {
          /* unknown remains unknown */
        }
      }
      return evidence
    } finally {
      if (evidence.acceptance.code === 'pending') evidence.acceptance = { code: evidence.outcome.kind }
      const clearObservation = () => {
        if (cancel) signal.removeEventListener('abort', cancel)
        if (deadline !== undefined) clearTimeout(deadline)
        if (grace !== undefined) clearTimeout(grace)
      }
      // Preserve the legacy cleanup contract. Sourced creation adds flush
      // boundaries, so its still-running deadline/quiescence observation must
      // also bound a persistence-backed disposal that cannot finish yet.
      if (lineage === undefined) clearObservation()
      try {
        if (handle) {
          if (quiescent) {
            const disposal = Promise.resolve()
              .then(() => handle!.dispose())
              .catch(() => {})
            if (lineage !== undefined && unknownSettlement !== undefined) await Promise.race([disposal, unknownSettlement])
            else await disposal
          } else {
            const owned = handle
            void Promise.resolve()
              .then(() => owned.agent.whenIdle())
              .then(() => owned.dispose())
              .catch(() => {})
          }
        }
      } finally {
        if (lineage !== undefined) clearObservation()
      }
    }
  }
}
