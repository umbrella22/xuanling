/**
 * Browser-safe view of resources supplied by the active DSH host.
 *
 * The catalog deliberately carries identities and display metadata only. It
 * never forwards skill paths, provider locators, MCP URLs/headers, or preset
 * composition documents to the client or a blueprint package.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ResourceKind, ResourceRef } from '../definition/types.ts'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { canonicalJson } from '../definition/document.ts'

export type HostResourceKind = 'agent' | 'skill' | 'mcp'
export type ResourceAvailability = 'available' | 'unavailable'
export type ResourceProvenance = 'builtin' | 'custom' | 'unknown'

export interface HostResourceEntry {
  /** Stable registry identity used by ResourceSource.kind = "host". */
  id: string
  kind: HostResourceKind
  displayName: string
  description: string
  source: 'dsh'
  availability: ResourceAvailability
  provenance: ResourceProvenance
  /** Logical identity used for deterministic same-host deduplication. */
  identity: string
  /** MCP tool identity when kind is mcp. */
  bindingId?: string
  /** Existing definition key when this host identity is already referenced. */
  refId?: string
}

export interface BlueprintResourceCatalogEntry {
  /** Definition resource key, kept distinct from host IDs. */
  id: string
  kind: ResourceKind
  displayName: string
  source: 'blueprint'
  availability: 'available'
  identity: string
  collision?: true
  ref: ResourceRef
}

export type ResourceCatalogEntry = HostResourceEntry | BlueprintResourceCatalogEntry

export interface ListHostResourcesOptions {
  cwd?: string
}

interface AgentPresetRow {
  id: string
  name?: string
  description?: string
  broken?: string
}

interface SkillSummaryRow {
  name: string
  description: string
  source?: string
  provider?: string
  resourceBase?: { kind: string; path?: string }
}

interface ToolSchemaRow {
  name: string
  description: string
}

type HostContext = Context & { get(service: string): unknown }

const officialPresetIds = new Set(['standard', 'ptc', 'minimal', 'cordis'])
const require = createRequire(import.meta.url)
// `entryListSchema` is constructed by cordis-plugin-include's js-yaml 4.x
// dependency. Resolve that same dependency from the plugin package so the
// schema instance is consumed by the parser implementation that owns it.
const includeRequire = createRequire(require.resolve('@deepseek-ai/cordis-plugin-include/package.json'))

function parseComposition(content: string): unknown {
  const yaml = includeRequire('js-yaml') as { load(content: string, options: { schema: unknown }): unknown }
  return yaml.load(content, { schema: entryListSchema })
}

/** Public display.isBuiltInPreset supplies the candidate IDs. Public exported
 * dsh-web-app preset patches supply the content proof, including !!js data.
 * Parsing never evaluates an expression, and no composition enters the DTO. */
export function presetProvenance(row: AgentPresetRow, documentContent?: string, officialPlugins?: unknown): ResourceProvenance {
  if (row.name !== undefined) return 'custom'
  if (!officialPresetIds.has(row.id) || documentContent === undefined || !Array.isArray(officialPlugins)) return 'unknown'
  try {
    const current = parseComposition(documentContent)
    if (!Array.isArray(current)) return 'unknown'
    return canonicalJson(current) === canonicalJson(officialPlugins) ? 'builtin' : 'custom'
  } catch {
    return 'unknown'
  }
}

function hostModuleResolvers(ctx: Context): Array<ReturnType<typeof createRequire>> {
  const resolvers = [require]
  if (ctx.baseUrl?.startsWith('file:')) resolvers.push(createRequire(new URL('resource-catalog.js', ctx.baseUrl)))
  try {
    resolvers.push(createRequire(require.resolve('@deepseek-ai/dsh/package.json')))
  } catch {
    /* optional host distribution */
  }
  return resolvers
}

function installedOfficialPreset(ctx: Context, id: string): unknown {
  if (!officialPresetIds.has(id)) return undefined
  for (const resolveFrom of hostModuleResolvers(ctx)) {
    try {
      const manifest = resolveFrom.resolve('@deepseek-ai/dsh-web-app/package.json')
      const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (metadata.name !== '@deepseek-ai/dsh-web-app') continue
      const patchPath = resolveFrom.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`)
      const patch = parseComposition(readFileSync(patchPath, 'utf8'))
      if (!Array.isArray(patch)) continue
      const entries = patch.flatMap(row => (typeof row === 'object' && row !== null && Array.isArray(row.insert) ? row.insert : []))
      const declared = entries.find(row => row?.name === '@deepseek-ai/dsh-agent-preset' && row.config?.id === id)
      if (declared?.config?.name === undefined && Array.isArray(declared?.config?.plugins)) return declared.config.plugins
    } catch {
      /* absent public preset proof stays unknown */
    }
  }
  return undefined
}

const officialSkillPackages: Readonly<Record<string, string>> = {
  'dsh-office': '@deepseek-ai/dsh-skill-office',
  'dsh-badge': '@deepseek-ai/dsh-skill-badge'
}
const customSkillSources = new Set(['project-dsh', 'project-agents', 'user-dsh', 'user-agents', 'custom'])

/** `bundled` alone includes third-party contributions. Only an exact official
 * provider and its installed package assets establish the builtin boundary. */
export function skillProvenance(row: SkillSummaryRow, officialAssets?: string): ResourceProvenance {
  if (row.source !== undefined && customSkillSources.has(row.source)) return 'custom'
  if (
    row.source !== 'bundled' ||
    row.provider === undefined ||
    officialSkillPackages[row.provider] === undefined ||
    officialAssets === undefined ||
    row.resourceBase?.kind !== 'directory' ||
    row.resourceBase.path === undefined
  )
    return 'unknown'
  try {
    const root = realpathSync(officialAssets),
      resource = realpathSync(row.resourceBase.path)
    const path = relative(root, resource)
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)) ? 'builtin' : 'custom'
  } catch {
    return 'unknown'
  }
}

function installedOfficialAssets(ctx: Context, provider: string | undefined): string | undefined {
  const packageName = provider === undefined ? undefined : officialSkillPackages[provider]
  if (packageName === undefined) return undefined
  for (const resolveFrom of hostModuleResolvers(ctx)) {
    try {
      const manifest = resolveFrom.resolve(`${packageName}/package.json`)
      const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
      if (metadata.name === packageName) return join(dirname(manifest), 'assets')
    } catch {
      /* unresolved optional provider stays unknown */
    }
  }
  return undefined
}

function availableEntry(input: Omit<HostResourceEntry, 'source' | 'availability'>): HostResourceEntry {
  return { ...input, source: 'dsh', availability: 'available' }
}

/**
 * Read the currently visible DSH preset, skill, and MCP tool registries.
 * Missing registries are treated as an empty observation; individual broken
 * preset rows remain visible as unavailable entries.
 */
export async function listHostResources(ctx: Context, options: ListHostResourcesOptions = {}): Promise<HostResourceEntry[]> {
  const host = ctx as HostContext
  const rows: HostResourceEntry[] = []
  const presets = host.get('agentPresets') as
    | { list?: () => Promise<AgentPresetRow[]>; readDocument?: (id: string) => Promise<{ agentPreset: string; content: string }> }
    | undefined
  if (typeof presets?.list === 'function') {
    const values = await presets.list()
    for (const row of values) {
      const description = row.description ?? ''
      let provenance = presetProvenance(row)
      if (row.name === undefined && officialPresetIds.has(row.id) && typeof presets.readDocument === 'function') {
        const official = installedOfficialPreset(ctx, row.id)
        if (official !== undefined) {
          try {
            const document = await presets.readDocument(row.id)
            if (document.agentPreset === row.id) provenance = presetProvenance(row, document.content, official)
          } catch {
            /* unreadable target document stays unknown */
          }
        }
      }
      rows.push(
        row.broken === undefined
          ? availableEntry({ id: row.id, kind: 'agent', displayName: row.name ?? row.id, description, identity: row.id, provenance })
          : {
              id: row.id,
              kind: 'agent',
              displayName: row.name ?? row.id,
              description,
              source: 'dsh',
              availability: 'unavailable',
              identity: row.id,
              provenance
            }
      )
    }
  }

  const skills = host.get('skills') as
    | {
        list?: (options?: { cwd?: string }) => Promise<SkillSummaryRow[]>
        get?: (name: string, options?: { cwd?: string }) => Promise<SkillSummaryRow | undefined>
      }
    | undefined
  if (typeof skills?.list === 'function') {
    const lookup = options.cwd === undefined ? {} : { cwd: options.cwd }
    const values = await skills.list(lookup)
    for (const row of values) {
      const description = row.description ?? ''
      let metadata = row
      if (
        row.resourceBase === undefined &&
        row.source === 'bundled' &&
        row.provider !== undefined &&
        officialSkillPackages[row.provider] !== undefined &&
        typeof skills.get === 'function'
      ) {
        try {
          const loaded = await skills.get(row.name, lookup)
          if (loaded?.name === row.name && loaded.source === row.source && loaded.provider === row.provider && loaded.resourceBase !== undefined) {
            metadata = { ...row, resourceBase: loaded.resourceBase }
          }
        } catch {
          /* missing target metadata retains unknown provenance */
        }
      }
      const provenance = skillProvenance(metadata, installedOfficialAssets(ctx, row.provider))
      rows.push(availableEntry({ id: row.name, kind: 'skill', displayName: row.name, description, identity: row.name, provenance }))
    }
  }

  const tools = host.get('tools') as { schemas?: () => ToolSchemaRow[] } | undefined
  if (typeof tools?.schemas === 'function') {
    for (const schema of tools.schemas()) {
      // Only MCP client tools are host MCP resources. Native DSH tools are
      // already part of the runtime and must not appear as exportable refs.
      if (!/^mcp__[^/\\]+__[^/\\]+$/.test(schema.name)) continue
      const description = schema.description ?? ''
      rows.push(
        availableEntry({
          id: schema.name,
          kind: 'mcp',
          displayName: schema.name,
          description,
          identity: schema.name,
          bindingId: schema.name,
          provenance: 'unknown'
        })
      )
    }
  }
  return dedupeHostResources(rows)
}

/** Single authoritative provenance observation for runtime/export adapters. */
export async function hostResourceProvenance(
  ctx: Context,
  kind: HostResourceKind,
  id: string,
  options: ListHostResourcesOptions = {}
): Promise<ResourceProvenance> {
  return (await listHostResources(ctx, options)).find(row => row.kind === kind && row.id === id)?.provenance ?? 'unknown'
}

export type HostResourceCatalogValue = Omit<HostResourceEntry, 'identity' | 'refId'>

/** Explicit DTO mapping: no private registry fields or internal merge keys. */
export function hostResourceCatalogValue(rows: readonly HostResourceEntry[]): { resources: HostResourceCatalogValue[] } {
  return {
    resources: rows.map(row => ({
      id: row.id,
      kind: row.kind,
      displayName: row.displayName,
      description: row.description,
      source: row.source,
      availability: row.availability,
      provenance: row.provenance,
      ...(row.bindingId === undefined ? {} : { bindingId: row.bindingId })
    }))
  }
}

/** Keep first row for one logical host identity, preserving registry order. */
function dedupeHostResources(rows: readonly HostResourceEntry[]): HostResourceEntry[] {
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = `${row.kind}:${row.identity}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function blueprintDisplayName(id: string, ref: ResourceRef): string {
  if (ref.source?.kind === 'host') return ref.source.id
  if (ref.path !== undefined) return ref.path
  if (ref.bindingId !== undefined) return ref.bindingId
  return id
}

/**
 * Merge host resources before definition-owned resources. Host rows with the
 * same logical identity are deduplicated. Existing host references reuse their
 * definition key; package rows are retained and marked on kind/name collision.
 */
export function mergeResourceCatalog(host: readonly HostResourceEntry[], resources: Record<string, ResourceRef>): ResourceCatalogEntry[] {
  const hostRows = dedupeHostResources(host).map(row => ({ ...row }))
  const hostByIdentity = new Map(hostRows.map(row => [`${row.kind}:${row.identity}`, row]))
  for (const [id, ref] of Object.entries(resources)) {
    if (ref.source?.kind === 'host' && (ref.kind === 'agent' || ref.kind === 'skill' || ref.kind === 'mcp')) {
      const key = `${ref.kind}:${ref.source.id}`
      const present = hostByIdentity.get(key)
      if (present !== undefined) {
        present.refId ??= id
      } else {
        const unavailable: HostResourceEntry = {
          id: ref.source.id,
          kind: ref.kind,
          displayName: ref.source.id,
          description: '',
          source: 'dsh',
          availability: 'unavailable',
          identity: ref.source.id,
          provenance: 'unknown',
          ...(ref.bindingId === undefined ? {} : { bindingId: ref.bindingId }),
          refId: id
        }
        hostRows.push(unavailable)
        hostByIdentity.set(key, unavailable)
      }
    }
  }
  const hostNames = new Set(hostRows.flatMap(row => [`${row.kind}:${row.displayName}`, `${row.kind}:${row.id}`]))
  const packageRows: BlueprintResourceCatalogEntry[] = []
  for (const [id, ref] of Object.entries(resources)) {
    if (ref.source?.kind === 'host') continue
    const displayName = blueprintDisplayName(id, ref)
    const collision = hostNames.has(`${ref.kind}:${displayName}`) || hostNames.has(`${ref.kind}:${id}`)
    packageRows.push({
      id,
      kind: ref.kind,
      displayName,
      source: 'blueprint',
      availability: 'available',
      identity: id,
      ...(collision ? { collision: true as const } : {}),
      ref
    })
  }
  return [...hostRows, ...packageRows]
}
