/**
 * Pure execution-report projection over one canonical RunRecord cut.
 *
 * `workflow_report` answers four questions the snapshot alone does not:
 * what ran, which step went wrong, why, and what to change next time. It is
 * derived from durable facts only (attempt intent/result, admission-frozen or
 * definition-pinned model routes, the bounded transition log) and never re-reads the store, a
 * live definition file, or a provider. Free-form result evidence and raw
 * outputs never leave the owner here: the report carries stable codes plus
 * fixed guidance text, so it is safe to hand to a model or a log.
 */
import type { BlueprintDefinition } from '../definition/types.ts'
import type { RunRecord } from '../persistence/records.ts'

export type RunReportOutcome = 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'needs-recovery' | 'waiting-input' | 'in-progress'

export interface RunReportStep {
  readonly nodeId: string
  readonly title?: string
  readonly kind?: string
  readonly attempt: number
  readonly attemptId: string
  readonly state: string
  readonly durationMs?: number
  readonly model?: { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
  readonly resultKind?: string
  readonly errorCode?: string
}

export interface RunReportProblem {
  readonly nodeId?: string
  readonly attemptId?: string
  readonly code: string
  readonly why: string
  readonly avoid: string
}

export interface RunReportRecovery {
  readonly reason?: string
  readonly resolvedAs?: string
  readonly note?: string
}

export interface RunReport {
  readonly runId: string
  readonly state: string
  readonly outcome: RunReportOutcome
  readonly workflow: { readonly id?: string; readonly name?: string; readonly definitionRevision: string }
  readonly timing: { readonly createdAt: number; readonly updatedAt: number; readonly durationMs: number }
  readonly summary: { readonly steps: number; readonly succeeded: number; readonly failed: number; readonly skipped: number; readonly pending: number }
  readonly steps: readonly RunReportStep[]
  readonly problems: readonly RunReportProblem[]
  readonly recovery?: RunReportRecovery
  readonly markdown: string
}

interface Guidance {
  readonly why: string
  readonly avoid: string
}

/** Stable code → fixed guidance. Codes come from executor outcomes, node value
 * validation, and durable recovery reasons. Unknown codes fall back to the
 * generic entry rather than echoing untrusted detail. */
export const REPORT_GUIDANCE: Readonly<Record<string, Guidance>> = {
  'provider-failed': {
    why: 'The model provider rejected or failed the request (network, quota, auth, or provider error).',
    avoid: 'Check the provider account and model availability, or pin a different model route on this node, then start a new run.'
  },
  failed: {
    why: 'The agent turn ended without a successful result.',
    avoid: 'Open the step session to read the transcript, tighten the agent instructions or inputs, then start a new run.'
  },
  timeout: {
    why: 'The step exceeded its time budget before producing a result.',
    avoid: 'Split the step into smaller nodes, narrow its task, or raise the time budget for this kind of work.'
  },
  timed_out: {
    why: 'The step exceeded its time budget before producing a result.',
    avoid: 'Split the step into smaller nodes, narrow its task, or raise the time budget for this kind of work.'
  },
  cancelled: {
    why: 'The run or step was cancelled before it finished.',
    avoid: 'No change is required unless the cancellation was unexpected; start a new run when ready.'
  },
  'structured-output-missing': {
    why: 'The agent finished without submitting the structured output the node declares.',
    avoid: 'State the required output fields explicitly in the agent instructions and keep the output schema small.'
  },
  'output-invalid': {
    why: 'The agent submitted output that does not match the declared output schema or port type.',
    avoid: 'Align the output schema with what the agent can produce, and include a short example in the instructions.'
  },
  'output-missing': {
    why: 'A declared output port received no value.',
    avoid: 'Make sure every declared output port is produced, or remove ports the step does not need.'
  },
  'input-missing': {
    why: 'A declared input port had no upstream value when the step started.',
    avoid: 'Connect the input to an upstream output, or provide it in the run input.'
  },
  'input-invalid': {
    why: 'An input value did not match the declared port type.',
    avoid: 'Align the upstream output type with this input port, or add a conversion step.'
  },
  'condition-input-invalid': {
    why: 'The condition node did not receive a boolean on its input port.',
    avoid: 'Feed the condition from a boolean output, or make the upstream step emit true/false explicitly.'
  },
  'binding-missing': {
    why: 'A referenced agent, skill, toolset, or schema could not be found when the run was admitted.',
    avoid: 'Restore the resource, or copy it into the workflow package so the definition does not depend on a global path.'
  },
  'binding-unavailable': {
    why: 'A referenced resource or model route was not available on this Host.',
    avoid: 'Install or enable the resource on this Host, or choose a model route that is configured here.'
  },
  'binding-invalid': {
    why: 'A referenced resource exists but its content failed validation.',
    avoid: 'Fix the resource file (front matter, schema JSON) and run validation before starting again.'
  },
  'binding-drift': {
    why: 'A referenced resource changed after the run froze its digest, so the run refused to use the new content.',
    avoid: 'Start a new run to pick up the change, or copy the resource into the workflow package to keep it stable.'
  },
  'resource-freeze-failed': {
    why: 'Admission could not read and freeze one of the referenced resources.',
    avoid: 'Check that every referenced resource is readable, then start a new run.'
  },
  'admission-incomplete': {
    why: 'The Host stopped while the run was still freezing its bindings, so admission never completed.',
    avoid: 'Resolve this run, then start a new one; nothing was dispatched.'
  },
  'intent-without-result': {
    why: 'The Host stopped after a step was dispatched but before its result was recorded, so its external effect is unknown.',
    avoid:
      'Check the step session for what actually happened, resolve the run with a note, and start a new run if needed. The run is never replayed automatically.'
  },
  'agent-effect-unknown': {
    why: 'The agent turn may have produced effects that were not recorded before the run stopped.',
    avoid: 'Check the step session, resolve the run with a note, and start a new run if needed.'
  },
  'team-effect-unknown': {
    why: 'A team create/spawn/message/task effect was in flight when the run stopped, so its outcome is unknown.',
    avoid: 'Inspect the team and its member sessions; Team runs need manual cleanup before a new run.'
  },
  'teamstage-identity-unavailable': {
    why: 'The team stage could not confirm the identity of its native team.',
    avoid: 'Make sure the agent-team feature is enabled on this Host and start a new run.'
  },
  'teamstage-executor-unavailable': {
    why: 'No team executor was available for the team stage.',
    avoid: 'Enable the agent-team profile on this Host, or replace the team stage with agent nodes.'
  },
  'teamstage-cancellation-failed': {
    why: 'The team stage could not confirm that its native team stopped.',
    avoid: 'Stop the team manually from its lead session before starting again.'
  },
  'prepare-failed': {
    why: 'The step could not be prepared (session or binding setup failed) before dispatch.',
    avoid: 'Check the step bindings and Host configuration, then start a new run.'
  },
  'driver-failed': {
    why: 'The run driver stopped on an internal error.',
    avoid: 'Collect the Host log for this run and report it; start a new run after the cause is fixed.'
  },
  'recovery-unresolved': {
    why: 'The run is waiting for a person to decide what happened to an unknown effect.',
    avoid: 'Inspect the affected step, then resolve the run as failed or succeeded with a short note.'
  },
  unknown: {
    why: 'The step did not succeed; no more specific reason was recorded.',
    avoid: 'Open the step session to read the transcript before changing the workflow.'
  }
}

export function reportGuidance(code: string): Guidance {
  return REPORT_GUIDANCE[code] ?? REPORT_GUIDANCE.unknown!
}

const TERMINAL_ATTEMPT = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'skipped'])
const NOTE_LIMIT = 500

function outcomeOf(state: string): RunReportOutcome {
  if (state === 'succeeded' || state === 'failed' || state === 'cancelled' || state === 'timed_out') return state
  if (state === 'recovery_required') return 'needs-recovery'
  if (state === 'waiting_input') return 'waiting-input'
  return 'in-progress'
}

function errorCodeOf(attempt: RunRecord['attempts'][number]): string | undefined {
  if (attempt.result === undefined) return attempt.state === 'recovery_required' ? 'recovery-unresolved' : undefined
  if (attempt.result.ok) return undefined
  const outcome = attempt.result.outcome as { kind?: unknown } | undefined
  // Only fixed-guidance codes cross this boundary. An unrecognized outcome kind
  // is producer-controlled text, so replace it with the durable attempt state
  // instead of echoing it into steps, problems, or the markdown.
  return typeof outcome?.kind === 'string' && Object.hasOwn(REPORT_GUIDANCE, outcome.kind) ? outcome.kind : attempt.state
}

/** A human resolution writes the operator's review time as result.at, so the
 * gap from intent.at is not a step duration and must not be presented as one. */
function settledByRecovery(outcome: unknown): boolean {
  if (outcome === null || typeof outcome !== 'object') return false
  const recovery = (outcome as { recovery?: unknown }).recovery
  return typeof recovery === 'string' && recovery.length > 0
}

/** Keep only the reportable route fields; the admission-frozen binding
 * selection and the definition node's pinned selection share this shape. */
function modelRouteOf(selection: { provider: string; model: string; reasoningEffort?: string } | undefined): RunReportStep['model'] {
  if (selection === undefined) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort })
  }
}

function boundedNote(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length > NOTE_LIMIT ? `${value.slice(0, NOTE_LIMIT)}…` : value
}

function safeDefinition(definitionJson: string, decode?: (json: string) => BlueprintDefinition): BlueprintDefinition | undefined {
  try {
    return decode === undefined ? (JSON.parse(definitionJson) as BlueprintDefinition) : decode(definitionJson)
  } catch {
    return undefined
  }
}

export function projectRunReport(record: RunRecord, decode?: (definitionJson: string) => BlueprintDefinition): RunReport {
  const definition = safeDefinition(record.definitionJson, decode)
  const nodes = new Map((definition?.graph?.nodes ?? []).map(node => [node.id, node]))
  const titles = definition?.presentation?.nodes ?? {}
  const steps: RunReportStep[] = record.attempts.map(attempt => {
    const node = nodes.get(attempt.nodeId)
    // Admission persists only inherited Host routes; a pinned definition route
    // lives in the frozen definition, so fall back to it when the record has no
    // binding entry for this node. An explicit null entry records "the Host had
    // no default route" and keeps precedence: no model is invented then.
    const selection =
      record.bindingSelections !== undefined && Object.hasOwn(record.bindingSelections, attempt.nodeId)
        ? (record.bindingSelections[attempt.nodeId] ?? undefined)
        : node?.modelSelection
    const model = modelRouteOf(selection)
    const title = titles[attempt.nodeId]?.title
    const errorCode = errorCodeOf(attempt)
    const startedAt = attempt.intent?.at
    const endedAt = attempt.result?.at
    const recovered = attempt.result !== undefined && settledByRecovery(attempt.result.outcome)
    return {
      nodeId: attempt.nodeId,
      ...(title === undefined ? {} : { title }),
      ...(node === undefined ? {} : { kind: node.kind }),
      attempt: attempt.attempt,
      attemptId: attempt.attemptId,
      state: attempt.state,
      ...(startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt && !recovered ? { durationMs: endedAt - startedAt } : {}),
      ...(model === undefined ? {} : { model }),
      ...(attempt.result === undefined ? {} : { resultKind: attempt.result.ok ? 'succeeded' : (errorCode ?? attempt.state) }),
      ...(errorCode === undefined ? {} : { errorCode })
    }
  })

  const problems: RunReportProblem[] = []
  for (const step of steps) {
    if (step.errorCode === undefined || step.errorCode === 'cancelled') continue
    problems.push({ nodeId: step.nodeId, attemptId: step.attemptId, code: step.errorCode, ...reportGuidance(step.errorCode) })
  }

  let recovery: RunReportRecovery | undefined
  for (const event of record.log) {
    const reason = typeof event.detail.reason === 'string' ? event.detail.reason : undefined
    if (event.kind === 'recovery' && reason !== undefined) recovery = { ...recovery, reason }
    if (event.kind === 'state' && typeof event.detail.recovery === 'string') {
      const note = boundedNote(event.detail.note ?? event.detail.evidence)
      recovery = { ...recovery, resolvedAs: event.detail.recovery, ...(note === undefined ? {} : { note }) }
    }
    if (event.kind === 'state' && reason !== undefined && !problems.some(problem => problem.code === reason) && REPORT_GUIDANCE[reason] !== undefined)
      problems.push({ code: reason, ...reportGuidance(reason) })
  }
  if (recovery?.reason !== undefined && !problems.some(problem => problem.code === recovery!.reason))
    problems.push({ code: recovery.reason, ...reportGuidance(recovery.reason) })
  if (record.state === 'recovery_required' && !problems.some(problem => problem.code === 'recovery-unresolved'))
    problems.push({ code: 'recovery-unresolved', ...reportGuidance('recovery-unresolved') })
  if (record.state === 'failed' && problems.length === 0) problems.push({ code: 'unknown', ...reportGuidance('unknown') })

  const summary = {
    steps: steps.length,
    succeeded: steps.filter(step => step.state === 'succeeded').length,
    failed: steps.filter(step => step.state === 'failed' || step.state === 'timed_out').length,
    skipped: steps.filter(step => step.state === 'skipped').length,
    pending: steps.filter(step => !TERMINAL_ATTEMPT.has(step.state)).length
  }
  const base = {
    runId: record.runId,
    state: record.state,
    outcome: outcomeOf(record.state),
    workflow: {
      ...(definition?.id === undefined ? {} : { id: definition.id }),
      ...(definition?.name === undefined ? {} : { name: definition.name }),
      definitionRevision: record.definitionRevision
    },
    timing: { createdAt: record.createdAt, updatedAt: record.updatedAt, durationMs: Math.max(0, record.updatedAt - record.createdAt) },
    summary,
    steps,
    problems,
    ...(recovery === undefined ? {} : { recovery })
  }
  return { ...base, markdown: renderReportMarkdown(base) }
}

function seconds(ms: number | undefined): string {
  return ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`
}

function cell(value: string): string {
  return value.replace(/[|\n\r]/g, ' ')
}

export function renderReportMarkdown(report: Omit<RunReport, 'markdown'>): string {
  const lines: string[] = []
  const name = report.workflow.name ?? report.workflow.id ?? 'workflow'
  lines.push(`# Run report: ${cell(name)}`)
  lines.push('')
  lines.push(`- Run: ${report.runId}`)
  lines.push(`- Outcome: ${report.outcome} (state ${report.state})`)
  lines.push(`- Definition revision: ${report.workflow.definitionRevision}`)
  lines.push(`- Duration: ${seconds(report.timing.durationMs)}`)
  lines.push(
    `- Steps: ${report.summary.steps} total, ${report.summary.succeeded} succeeded, ${report.summary.failed} failed, ${report.summary.skipped} skipped, ${report.summary.pending} pending`
  )
  lines.push('')
  lines.push('## What ran')
  lines.push('')
  if (report.steps.length === 0) lines.push('No step was dispatched.')
  else {
    lines.push('| Step | Kind | Attempt | State | Duration | Model | Error |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const step of report.steps) {
      const label = step.title === undefined ? step.nodeId : `${step.title} (${step.nodeId})`
      const model = step.model === undefined ? '-' : `${step.model.provider}/${step.model.model}`
      lines.push(
        `| ${cell(label)} | ${step.kind ?? '-'} | ${step.attempt} | ${step.state} | ${seconds(step.durationMs)} | ${cell(model)} | ${step.errorCode ?? '-'} |`
      )
    }
  }
  if (report.problems.length > 0) {
    lines.push('')
    lines.push('## What went wrong and how to avoid it')
    for (const problem of report.problems) {
      lines.push('')
      lines.push(`### ${problem.nodeId === undefined ? problem.code : `${cell(problem.nodeId)}: ${problem.code}`}`)
      lines.push('')
      lines.push(`- Why: ${problem.why}`)
      lines.push(`- Next time: ${problem.avoid}`)
    }
  }
  if (report.recovery !== undefined) {
    lines.push('')
    lines.push('## Recovery')
    lines.push('')
    if (report.recovery.reason !== undefined) lines.push(`- Reason: ${report.recovery.reason}`)
    lines.push(`- Resolution: ${report.recovery.resolvedAs ?? 'unresolved'}`)
    if (report.recovery.note !== undefined) lines.push(`- Note: ${cell(report.recovery.note)}`)
  }
  return `${lines.join('\n')}\n`
}
