/**
 * Current-blueprint export vs generic template extraction (C-09).
 *
 * Extraction is a pure transformation: the source definition is cloned, the
 * identity and package paths become strict string parameters, and any content
 * that still looks project-specific is reported. Nothing is executed, uploaded
 * or written back to the source.
 */
import { createHash } from 'node:crypto'
import type { BlueprintDefinition, ResourceRef } from '../definition/types.ts'
import type { AssetRef } from '../definition/library-ref.ts'
import { TEMPLATE_SCHEMA_VERSION, templateCodec, type BlueprintTemplate, type TemplateParameter } from './contracts.ts'
import { stableHash } from './digest.ts'

const PLACEHOLDER = /\{\{([A-Za-z0-9._-]+)\}\}/g
const RESIDUAL_PATTERNS: Array<{ code: string; pattern: RegExp }> = [
  { code: 'absolute-path', pattern: /(?:^|[^A-Za-z0-9])\/(?:Users|home|root|private|Volumes)\//m },
  { code: 'absolute-path', pattern: /(?:^|[^A-Za-z0-9])[A-Za-z]:\\\\/m },
  { code: 'home-path', pattern: /(?:^|\s)~\//m },
  { code: 'secret-pattern', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { code: 'secret-pattern', pattern: /\bghp_[A-Za-z0-9]{20,}/ },
  { code: 'secret-pattern', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { code: 'secret-pattern', pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/ },
  { code: 'run-reference', pattern: /\brun-[A-Za-z0-9]{8,}\b/ },
  { code: 'session-reference', pattern: /\bsession-[A-Za-z0-9]{8,}\b/ }
]

export interface ExtractionResult {
  template: BlueprintTemplate
  portable: boolean
  residual: string[]
  sourceDigest: string
  templateDigest: string
}

export interface ExtractionOptions {
  sourceAsset: AssetRef
  sourceRevision: string | null
  /** Project-specific names that must not survive into a generic template. */
  residualHints?: string[]
  extractedAt: string
  files?: ReadonlyMap<string, Uint8Array>
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Package paths become parameters; host-owned identities become requirements. */
export function extractTemplate(definition: BlueprintDefinition, options: ExtractionOptions): ExtractionResult {
  const pattern = clone(definition) as unknown as Record<string, unknown>
  const parameters: TemplateParameter[] = []
  const requirements = { discovery: [], roles: [], resources: [], acceptance: [] } as BlueprintTemplate['requirements']
  pattern.id = '{{id}}'
  pattern.name = '{{name}}'
  parameters.push({ key: 'name', label: 'Blueprint name', kind: 'string', required: true, default: definition.name })

  const resources = (pattern.resources ?? {}) as Record<string, ResourceRef>
  for (const [key, ref] of Object.entries(resources)) {
    const parameterKey = `resource.${key}.path`
    const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
    if (path !== undefined) {
      parameters.push({ key: parameterKey, label: `Path for ${key}`, kind: 'path', required: true, default: path })
      if (ref.path !== undefined) ref.path = `{{${parameterKey}}}`
      if (ref.source?.kind === 'package') ref.source.path = `{{${parameterKey}}}`
    } else if (ref.source?.kind === 'host') {
      requirements.resources.push(`${ref.kind}:${ref.source.id}`)
    } else if (ref.source?.kind === 'shared') {
      requirements.resources.push(`${ref.kind}:shared:${ref.source.rootId}/${ref.source.path}`)
    }
    if (ref.kind === 'agent') requirements.roles.push(key)
  }
  // Deterministic requirement inventory; callers may add discovered values.
  requirements.discovery.push('README', 'package or workspace manifest', 'CI workflow or documented commands')
  requirements.acceptance.push('declared output schema or human review')

  const files = [...(options.files ?? [])]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, content]) => {
      let parameterPath = path
      const refs = Object.entries(definition.resources)
        .map(([key, ref]) => ({ key, path: ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined) }))
        .filter((ref): ref is { key: string; path: string } => ref.path !== undefined)
        .sort((a, b) => b.path.length - a.path.length)
      for (const ref of refs) {
        if (path === ref.path || path.startsWith(`${ref.path}/`)) {
          parameterPath = `{{resource.${ref.key}.path}}${path.slice(ref.path.length)}`
          break
        }
      }
      const bytes = Buffer.from(content)
      return { path: parameterPath, base64: bytes.toString('base64'), digest: createHash('sha256').update(bytes).digest('hex') }
    })
  const residual = scanResiduals(
    { pattern, parameters, files: files.map(file => ({ path: file.path, text: Buffer.from(file.base64, 'base64').toString('utf8') })) },
    options.residualHints ?? []
  )
  if (Object.values(definition.resources).some(ref => ref.path !== undefined || ref.source?.kind === 'package') && files.length === 0)
    residual.push('package-closure-missing')
  const template = templateCodec().parse({
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    templateId: `tpl-${stableHash([options.sourceAsset, options.sourceRevision ?? null, pattern, files]).slice(0, 32)}`,
    name: definition.name,
    parameters,
    requirements,
    pattern,
    files,
    provenance: {
      sourceAsset: options.sourceAsset,
      sourceRevision: options.sourceRevision,
      extractedAt: options.extractedAt,
      residualNotes: residual
    }
  })
  return {
    template,
    portable: residual.length === 0,
    residual,
    sourceDigest: stableHash(definition),
    templateDigest: stableHash(template)
  }
}

/** Replace every parameter placeholder. Missing keys stay visible so the
 * caller can block instead of publishing a definition with `{{...}}`. */
export function applyTemplateParameters(pattern: unknown, parameters: Record<string, string>): { definition: unknown; missing: string[] } {
  const missing = new Set<string>()
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(PLACEHOLDER, (_match, key: string) => {
        const replacement = parameters[key]
        if (replacement === undefined) {
          missing.add(key)
          return `{{${key}}}`
        }
        return replacement
      })
    }
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = walk(item)
      return result
    }
    return value
  }
  const definition = walk(clone(pattern))
  // A leftover placeholder in a key that was not visited as a string (for
  // example inside an array of objects) is detected by a final scan.
  for (const match of JSON.stringify(definition).matchAll(PLACEHOLDER)) missing.add(match[1]!)
  return { definition, missing: [...missing].sort() }
}

export function scanResiduals(pattern: unknown, hints: readonly string[]): string[] {
  const text = JSON.stringify(pattern)
  const notes = new Set<string>()
  for (const entry of RESIDUAL_PATTERNS) if (entry.pattern.test(text)) notes.add(entry.code)
  for (const hint of hints) {
    const value = hint.trim()
    if (value.length < 3) continue
    if (text.toLowerCase().includes(value.toLowerCase())) notes.add('source-project-name')
  }
  return [...notes].sort()
}
