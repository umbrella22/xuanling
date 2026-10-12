/** Presentation of whitelisted durable facts only. No new raw data surface. */
import { createElement as h } from 'react'
import { attemptDiagnosticsCodec } from '../host/runtime-diagnostics.ts'
import type { AttemptDiagnostics } from '../host/runtime-diagnostics.ts'
import type { BlueprintLocaleProps } from './locales.ts'

export function projectAttemptDiagnostics(value?: unknown): AttemptDiagnostics {
  const parsed = attemptDiagnosticsCodec().safeParse(value)
  return parsed.success ? parsed.data : { status: 'unavailable' }
}
export function renderAttemptDiagnostics(value: unknown, t: BlueprintLocaleProps['t']) {
  const diagnostics = projectAttemptDiagnostics(value)
  if (diagnostics.status === 'unavailable') return h('section', { 'data-bp-diagnostics': 'unavailable' }, h('h4', null, t('diagnostics.title')), h('p', null, t('diagnostics.unavailable')))
  const row = (key: 'input' | 'resources' | 'model' | 'tools' | 'denials' | 'acceptance' | 'recovery', values: string[]) =>
    h('div', { key, 'data-bp-diagnostic': key }, h('strong', null, t(`diagnostics.${key}`)), ...values.map((text, index) => h('p', { key: index }, text)))
  const model = diagnostics.modelSelection
  return h('section', { 'data-bp-diagnostics': 'available' }, h('h4', null, t('diagnostics.title')),
    row('input', [`${diagnostics.input.type} · ${diagnostics.input.bytes} bytes · ${diagnostics.input.sha256}`]),
    row('resources', Object.entries(diagnostics.resourceDigests).map(([id, digest]) => `${id} · ${digest}`)),
    row('model', [model ? [model.provider, model.model, model.reasoningEffort].filter(value => value !== undefined).join(' · ') : t('diagnostics.noModel')]),
    row('tools', diagnostics.tools.effectiveNames), row('denials', (diagnostics.tools.denials ?? []).map(denial => `${denial.toolName} · ${denial.code}`)),
    row('acceptance', [diagnostics.acceptance.code + (diagnostics.acceptance.issueCount === undefined ? '' : ` · ${diagnostics.acceptance.issueCount}`)]),
    diagnostics.recovery && row('recovery', [diagnostics.recovery.code]))
}
