/** Display projection of whitelisted durable facts. No UI or browser effects. */
import { attemptDiagnosticsCodec } from '../../../host/runtime-diagnostics.ts'
import type { AttemptDiagnostics } from '../../../host/runtime-diagnostics.ts'
import type { BlueprintLocaleProps } from '../i18n/locales.ts'

export type PreflightActionKey =
  | 'diagnostics.action.input'
  | 'diagnostics.action.resource'
  | 'diagnostics.action.model'
  | 'diagnostics.action.tools'
  | 'diagnostics.action.schema'
  | 'diagnostics.action.retry'
  | 'diagnostics.action.inspect'

/** Convert stable Host check codes into a short next-action instruction. The
 * original code and object IDs remain visible beside this derived copy. */
export function preflightActionKey(code: string): PreflightActionKey {
  if (['input-missing', 'input-invalid', 'condition-input-invalid'].includes(code)) return 'diagnostics.action.input'
  if (code.includes('resource') || code === 'host-agent-unavailable' || code === 'host-skill-unavailable') return 'diagnostics.action.resource'
  if (code.includes('model-route')) return 'diagnostics.action.model'
  if (code.includes('tool') || code.includes('agent-factory') || code.includes('executor') || code.includes('teamstage')) return 'diagnostics.action.tools'
  if (code.includes('schema') || code.includes('output-port')) return 'diagnostics.action.schema'
  if (code.includes('unverified') || code.includes('approval')) return 'diagnostics.action.inspect'
  if (code.endsWith('ready') || code === 'definition-ready') return 'diagnostics.action.inspect'
  return 'diagnostics.action.retry'
}

export function projectAttemptDiagnostics(value?: unknown): AttemptDiagnostics {
  const parsed = attemptDiagnosticsCodec().safeParse(value)
  return parsed.success ? parsed.data : { status: 'unavailable' }
}

type DiagnosticRowKey = 'input' | 'resources' | 'model' | 'tools' | 'denials' | 'acceptance' | 'recovery'
export interface DiagnosticRow {
  key: DiagnosticRowKey
  label: string
  values: readonly string[]
}
export type AttemptDiagnosticsViewModel =
  | { status: 'unavailable'; title: string; message: string }
  | { status: 'available'; title: string; rows: readonly DiagnosticRow[] }

export function presentAttemptDiagnostics(value: unknown, t: BlueprintLocaleProps['t']): AttemptDiagnosticsViewModel {
  const diagnostics = projectAttemptDiagnostics(value)
  const title = t('diagnostics.title')
  if (diagnostics.status === 'unavailable') return { status: 'unavailable', title, message: t('diagnostics.unavailable') }
  const row = (key: DiagnosticRowKey, values: string[]): DiagnosticRow => ({ key, label: t(`diagnostics.${key}`), values })
  const model = diagnostics.modelSelection
  const rows = [
    row('input', [`${diagnostics.input.type} · ${diagnostics.input.bytes} bytes · ${diagnostics.input.sha256}`]),
    row(
      'resources',
      Object.entries(diagnostics.resourceDigests).map(([id, digest]) => `${id} · ${digest}`)
    ),
    row('model', [model ? [model.provider, model.model, model.reasoningEffort].filter(value => value !== undefined).join(' · ') : t('diagnostics.noModel')]),
    row('tools', diagnostics.tools.effectiveNames),
    row(
      'denials',
      (diagnostics.tools.denials ?? []).map(denial => `${denial.toolName} · ${denial.code}`)
    ),
    row('acceptance', [diagnostics.acceptance.code + (diagnostics.acceptance.issueCount === undefined ? '' : ` · ${diagnostics.acceptance.issueCount}`)])
  ]
  if (diagnostics.recovery) rows.push(row('recovery', [diagnostics.recovery.code]))
  return { status: 'available', title, rows }
}
