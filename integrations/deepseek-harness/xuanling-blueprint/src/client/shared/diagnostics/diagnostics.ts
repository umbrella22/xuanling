/** Compatibility entry for Panel and conversation callers. */
import type { BlueprintLocaleProps } from '../i18n/locales.ts'
import { presentAttemptDiagnostics } from './diagnostics-model.ts'
import { AttemptDiagnosticsView } from './diagnostics-view.tsx'
export { projectAttemptDiagnostics } from './diagnostics-model.ts'

export function renderAttemptDiagnostics(value: unknown, t: BlueprintLocaleProps['t']) {
  return AttemptDiagnosticsView({ model: presentAttemptDiagnostics(value, t) })
}
