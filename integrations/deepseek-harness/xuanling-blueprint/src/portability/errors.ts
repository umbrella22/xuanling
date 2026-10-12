/** Portability error vocabulary (C-11). Codes are stable and carry the
 * offending subject so UI can point at the exact resource or entry. */

export class ExportDependencyMissingError extends Error {
  override readonly name = 'ExportDependencyMissingError'
  readonly code = 'EXPORT_DEPENDENCY_MISSING'
  readonly refId: string
  readonly detail: string
  constructor(refId: string, detail: string) {
    super(`export dependency "${refId}" missing: ${detail}`)
    this.refId = refId
    this.detail = detail
  }
}

export class PortabilityConflictError extends Error {
  override readonly name = 'PortabilityConflictError'
  readonly code = 'PORTABILITY_CONFLICT'
  readonly detail: string
  constructor(detail: string) {
    super(`portability conflict: ${detail}`)
    this.detail = detail
  }
}

export class SensitiveExportBlockedError extends Error {
  override readonly name = 'SensitiveExportBlockedError'
  readonly code = 'SENSITIVE_EXPORT_BLOCKED'
  readonly findings: Array<{ path: string; issue: string }>
  constructor(findings: Array<{ path: string; issue: string }>) {
    super(`sensitive export blocked: ${findings.map(f => `${f.path} (${f.issue})`).join('; ')}`)
    this.findings = findings
  }
}

export class ImportConflictError extends Error {
  override readonly name = 'ImportConflictError'
  readonly code = 'IMPORT_CONFLICT'
  readonly target: string
  constructor(target: string) {
    super(`import target already exists: ${target}`)
    this.target = target
  }
}
