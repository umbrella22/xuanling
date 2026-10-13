/** Server-side export resolver. Only an explicit export reads custom Host
 * configuration. Returned artifacts contain data and binding requirements;
 * import never activates a plugin or connects an MCP server. */
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { BlueprintDefinition } from '../definition/types.ts'
import { hostResourceProvenance } from '../host/resource-catalog.ts'
import { createHostResourceProvider } from '../resources/runtime-snapshots.ts'
import type { SnapshotFile } from '../resources/snapshotter.ts'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ExportDependencyMissingError, PortabilityConflictError } from './errors.ts'

export interface PackagedPreset {
  schemaVersion: 1
  format: 'agent-preset'
  originalId: string
  plugins: Array<Record<string, unknown>>
  requiredBindings: string[]
}
/** Host-private current composition. Unlike portable artifacts it retains
 * current Host configuration, and must never enter export or browser DTOs. */
export interface HostAgentComposition { plugins: Array<Record<string, unknown>> }
export interface PackagedMcp {
  schemaVersion: 1
  format: 'mcp-definition'
  originalId: string
  config: Record<string, unknown>
  requiredBindings: string[]
}
export type HostExportResource = { provenance: 'builtin' }
  | { provenance: 'custom'; kind: 'skill'; files: SnapshotFile[] }
  | { provenance: 'custom'; kind: 'agent'; preset: PackagedPreset }
  | { provenance: 'custom'; kind: 'mcp'; definition: PackagedMcp }
export type HostExportResources = Map<string, HostExportResource>
export const hostExportKey = (kind: string, id: string): string => `${kind}:${id}`

const require = createRequire(import.meta.url)
/** Reuse the Host's own include schema. Its !!js constructor retains an
 * expression object; parsing itself never evaluates an expression. */
function parseComposition(content: string): unknown {
  try {
    const yaml = require('js-yaml') as { load(text: string, options: { schema: unknown }): unknown }
    return yaml.load(content, { schema: entryListSchema })
  } catch { throw new PortabilityConflictError('Host preset composition parser unavailable or rejected') }
}
function validPluginRows(values: unknown): values is Array<Record<string, unknown>> {
  return Array.isArray(values) && values.every(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.name !== 'string' || !row.name) return false
    return row.group !== true || validPluginRows(row.config)
  })
}
export function parseHostAgentComposition(content: string): HostAgentComposition {
  const plugins = parseComposition(content)
  if (!validPluginRows(plugins)) throw new PortabilityConflictError('Host preset composition rejected')
  return { plugins }
}

const secretKeyPart = /(?:^|_)(?:api_?key|access_token|refresh_token|id_token|client_secret|token|password|passwd|secret|credential|credentials|authorization|headers)$/
function isSensitiveKey(key: string): boolean {
  // Normalize camelCase and separators, then require a credential term at
  // the end of the key. This keeps ordinary options such as tokenLimit,
  // maxTokens and secretMode portable while still covering accessToken and
  // clientSecret conventions.
  const normalized = key.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()
  return normalized === 'env' || secretKeyPart.test(normalized)
}
const credentialText = /(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\b(?:api[-_]?key|password|secret|token)\s*[=:]\s*[^\s]+)/i
/** URLs may carry machine-specific credentials or opaque query/hash values.
 * Keep ordinary endpoint URLs portable, but make any userinfo/query/hash a
 * destination binding so it can never leak through a Host Agent preset. */
function hasMachineBoundUrlParts(value: string): boolean {
  try {
    const url = new URL(value)
    return Boolean(url.username || url.password || url.search || url.hash)
  } catch {
    return false
  }
}
/** Sensitive fields are omitted, with only their logical JSON paths retained.
 * Machine-bound values also require explicit binding on the destination. */
function portableValue(value: unknown, path: string, required: string[]): unknown {
  if (Array.isArray(value)) {
    if (value.some(item => typeof item === 'string' && /^--?(?:api[-_]?key|token|password|secret)(?:=|$)/i.test(item))) { required.push(path); return undefined }
    const clean = value.map((item, index) => portableValue(item, `${path}/${index}`, required))
    if (clean.some(item => item === undefined)) { required.push(path); return undefined }
    return clean
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      const next = `${path}/${key}`
      if (isSensitiveKey(key) || key === 'cwd') {
        if ((key === 'env' || key === 'headers') && child && typeof child === 'object' && !Array.isArray(child)) {
          for (const binding of Object.keys(child)) required.push(`${next}/${binding.replace(/~/g, '~0').replace(/\//g, '~1')}`)
        } else required.push(next)
        continue
      }
      const clean = portableValue(child, next, required)
      if (clean !== undefined) Object.defineProperty(result, key, { value: clean, enumerable: true, writable: true, configurable: true })
    }
    return result
  }
  if (typeof value === 'string' && (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || credentialText.test(value) || hasMachineBoundUrlParts(value))) {
    required.push(path)
    return undefined
  }
  return value
}

export function validatePackagedPreset(value: unknown): PackagedPreset {
  if (!value || typeof value !== 'object') throw new PortabilityConflictError('packaged preset rejected')
  const candidate = value as Partial<PackagedPreset>
  if (Object.keys(value).some(key => !['schemaVersion', 'format', 'originalId', 'plugins', 'requiredBindings'].includes(key))
    || candidate.schemaVersion !== 1 || candidate.format !== 'agent-preset' || typeof candidate.originalId !== 'string'
    || !validPluginRows(candidate.plugins) || !Array.isArray(candidate.requiredBindings) || candidate.requiredBindings.some(key => typeof key !== 'string')) {
    throw new PortabilityConflictError('packaged preset rejected')
  }
  const bindings: string[] = []
  if (!isDeepStrictEqual(portableValue(candidate.plugins, '/plugins', bindings), candidate.plugins)) throw new PortabilityConflictError('packaged preset contains machine or credential values')
  return candidate as PackagedPreset
}

/** Check module visibility without importing or evaluating plugin code. A
 * visible module is only a preflight observation; DSH mount remains authority. */
export function packagedPresetModulesAvailable(ownerCtx: { get(service: string): unknown; baseUrl?: string }, preset: PackagedPreset): boolean {
  const loader = ownerCtx.get('loader') as { builtins?: Record<string, unknown>; entries?(): Iterable<{ options: { name: string } }> } | undefined
  const registered = new Set(typeof loader?.entries === 'function' ? [...loader.entries()].map(entry => entry.options.name) : [])
  let resolver = require
  try { if (ownerCtx.baseUrl !== undefined) resolver = createRequire(ownerCtx.baseUrl) } catch { return false }
  const visible = (rows: Array<Record<string, unknown>>): boolean => rows.every(row => {
    if (row.disabled === true) return true
    if (row.group === true) return visible(row.config as Array<Record<string, unknown>>)
    const name = row.name as string
    if (name.startsWith('cordis:')) return loader?.builtins?.[name.slice(7)] !== undefined
    if (registered.has(name)) return true
    try { resolver.resolve(name); return true } catch { return false }
  })
  return visible(preset.plugins)
}

export function packagePreset(id: string, yaml: string): PackagedPreset {
  const requiredBindings: string[] = []
  const plugins = portableValue(parseComposition(yaml), '/plugins', requiredBindings)
  return validatePackagedPreset({ schemaVersion: 1, format: 'agent-preset', originalId: id, plugins, requiredBindings })
}

export function packageMcp(id: string, raw: Record<string, unknown>): PackagedMcp {
  const requiredBindings: string[] = []
  // Only the public MCP connection contract is portable. Transport secrets
  // and cwd are binding requirements, never archive values.
  const keys = ['transport', 'serverName', 'command', 'args', 'url', 'toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes', 'reconnect']
  const selected = Object.fromEntries(keys.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]]))
  for (const key of ['env', 'headers', 'cwd']) {
    const value = raw[key]
    if (value === undefined || value === '') continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const binding of Object.keys(value)) requiredBindings.push(`/config/${key}/${binding.replace(/~/g, '~0').replace(/\//g, '~1')}`)
    } else requiredBindings.push(`/config/${key}`)
  }
  const config = portableValue(selected, '/config', requiredBindings) as Record<string, unknown>
  // URL credentials/query and arbitrary argv may contain opaque credentials.
  // Retain shape as required bindings rather than guessing which value is safe.
  if (typeof config.url === 'string') {
    try {
      const url = new URL(config.url)
      if (url.username || url.password || url.search || url.hash) { delete config.url; requiredBindings.push('/config/url') }
    } catch { throw new PortabilityConflictError('MCP endpoint rejected') }
  }
  if (Array.isArray(config.args)) {
    for (let index = 0; index < config.args.length; index++) {
      const arg = config.args[index]
      if (typeof arg === 'string' && /(?:token|secret|password|api[-_]?key)/i.test(arg)) {
        requiredBindings.push('/config/args'); delete config.args; break
      }
    }
  }
  if (config.transport !== 'stdio' && config.transport !== 'streamable-http') throw new PortabilityConflictError('MCP transport rejected')
  if (typeof config.serverName !== 'string' || !config.serverName) throw new PortabilityConflictError('MCP identity rejected')
  return { schemaVersion: 1, format: 'mcp-definition', originalId: id, config, requiredBindings: [...new Set(requiredBindings)] }
}

export function validatePackagedMcp(value: unknown): PackagedMcp {
  if (!value || typeof value !== 'object') throw new PortabilityConflictError('packaged MCP definition rejected')
  const candidate = value as Partial<PackagedMcp>
  if (Object.keys(value).some(key => !['schemaVersion', 'format', 'originalId', 'config', 'requiredBindings'].includes(key))
    || candidate.schemaVersion !== 1 || candidate.format !== 'mcp-definition' || typeof candidate.originalId !== 'string'
    || !candidate.config || typeof candidate.config !== 'object' || Array.isArray(candidate.config)
    || !Array.isArray(candidate.requiredBindings) || candidate.requiredBindings.some(key => typeof key !== 'string')) throw new PortabilityConflictError('packaged MCP definition rejected')
  // This validation does not connect. It also rejects injected raw credentials
  // rather than silently rewriting an imported archive's integrity bytes.
  const sanitized = packageMcp(candidate.originalId, candidate.config)
  if (!isDeepStrictEqual(sanitized.config, candidate.config)) throw new PortabilityConflictError('packaged MCP definition contains machine or credential values')
  return candidate as PackagedMcp
}

/** Read a custom resource only after provenance classification. Unknown origin
 * is never mistaken for a builtin and never silently omitted from the export. */
export async function resolveHostExportResources(ctx: Context, definitions: BlueprintDefinition[], cwd: string): Promise<HostExportResources> {
  const resolved: HostExportResources = new Map()
  const hostSkills = createHostResourceProvider(ctx)
  for (const definition of definitions) for (const [refId, ref] of Object.entries(definition.resources)) {
    if (ref.source?.kind !== 'host') continue
    const id = ref.source.id
    const key = hostExportKey(ref.kind, id)
    if (resolved.has(key)) continue
    if (ref.kind !== 'agent' && ref.kind !== 'skill' && ref.kind !== 'mcp') throw new ExportDependencyMissingError(refId, 'Host resource kind unsupported')
    const provenance = await hostResourceProvenance(ctx, ref.kind, id, { cwd })
    if (provenance === 'builtin') { resolved.set(key, { provenance: 'builtin' }); continue }
    if (ref.kind === 'skill') {
      const skill = await hostSkills.getSkill(id, { cwd })
      if (skill === undefined || typeof skill.content !== 'string') throw new ExportDependencyMissingError(refId, 'Host Skill unavailable')
      const files: SnapshotFile[] = []
      if (Array.isArray(skill.files)) files.push(...skill.files.map(file => ({ ...file, digest: createHash('sha256').update(file.bytes).digest('hex') })))
      else if (skill.files !== undefined) for (const [path, value] of Object.entries(skill.files)) {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value
        files.push({ path, bytes, digest: createHash('sha256').update(bytes).digest('hex') })
      }
      if (!files.some(file => file.path === 'SKILL.md')) files.push({ path: 'SKILL.md', bytes: Buffer.from(skill.content), digest: createHash('sha256').update(skill.content).digest('hex') })
      resolved.set(key, { provenance: 'custom', kind: 'skill', files })
    } else if (ref.kind === 'agent') {
      const presets = ctx.get('agentPresets') as { readDocument?(id: string): Promise<{ content: string }> } | undefined
      if (typeof presets?.readDocument !== 'function') throw new ExportDependencyMissingError(refId, 'Host preset document API unavailable')
      const document = await presets.readDocument(id)
      resolved.set(key, { provenance: 'custom', kind: 'agent', preset: packagePreset(id, document.content) })
    } else {
      const server = /^mcp__([A-Za-z0-9_-]{1,32})__/.exec(id)?.[1]
      if (!server) throw new ExportDependencyMissingError(refId, 'Host MCP identity unavailable')
      const editor = ctx.get('configEditor') as { entries?(): Iterable<{ options: { name: string; config?: Record<string, unknown> } }> } | undefined
      const loader = typeof editor?.entries === 'function' ? editor : ctx.get('loader') as { entries?(): Iterable<{ options: { name: string; config?: Record<string, unknown> } }> } | undefined
      if (typeof loader?.entries !== 'function') throw new ExportDependencyMissingError(refId, 'Host MCP configuration API unavailable')
      const entries = [...loader.entries()].filter(entry => entry.options.name === '@deepseek-ai/dsh-mcp-client'
        && entry.options.config?.serverName === server)
      if (entries.length !== 1 || entries[0]?.options.config === undefined) throw new ExportDependencyMissingError(refId, 'Host MCP configuration unavailable or ambiguous')
      resolved.set(key, { provenance: 'custom', kind: 'mcp', definition: packageMcp(id, entries[0].options.config) })
    }
  }
  return resolved
}
