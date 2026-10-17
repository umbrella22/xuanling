/** Display projection of whitelisted durable facts. No UI or browser effects. */
import { attemptDiagnosticsCodec } from '../../../host/runtime-diagnostics.ts'
import type { AttemptDiagnostics } from '../../../host/runtime-diagnostics.ts'
import type { BlueprintLocaleProps } from '../i18n/locales.ts'

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
