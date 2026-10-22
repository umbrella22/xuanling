import { createHash } from 'node:crypto'
import type { ModelSelection } from '../definition/types.ts'

/** Admission and Attempt binding facts share one canonical digest vocabulary. */
export interface BindingFactInput {
  nodeId: string
  agentRef?: string
  skillRefs?: string[]
  toolsetRefs?: string[]
  toolAllowlist?: string[]
  resourceDigests: Record<string, string>
  effectiveToolNames?: string[]
  toolsetDigest?: string
  modelSelection?: ModelSelection
  outputSchemaRef?: string
}

export interface BindingFacts {
  digests: Record<string, string>
  summary: {
    nodeId: string
    agentRef?: string
    skillRefs: string[]
    toolsetRefs: string[]
    toolAllowlist: string[]
    effectiveToolNames: string[]
    toolsetDigest?: string
    modelSelection?: ModelSelection
    outputSchemaRef?: string
    resourceIds: string[]
  }
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, ordered(child)])
    )
  }
  return value
}

function canonical(value: unknown): string {
  return JSON.stringify(ordered(value))
}

export function bindingDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

/** Digest the public Host tool schemas that were actually selected for a
 * node. Tool names alone miss an in-place schema change, while this summary
 * remains limited to registry metadata and never carries invocation data. */
export function toolsetBindingDigest(ctx: { get(service: string): unknown }, names: string[]): string {
  let schemas: Array<{ name: string }> = []
  try {
    const tools = ctx.get('tools') as { schemas?: () => unknown } | undefined
    const available = typeof tools?.schemas === 'function' ? tools.schemas() : []
    if (Array.isArray(available)) {
      const selected = new Set(names)
      schemas = available.filter(
        (value): value is { name: string } =>
          value !== null &&
          typeof value === 'object' &&
          typeof (value as { name?: unknown }).name === 'string' &&
          selected.has((value as { name: string }).name)
      )
    }
  } catch {
    // An unreadable registry must not digest like "no tools selected": keep
    // it a distinct, stable fact so admission and Attempt compare like with like.
    return bindingDigest({ registry: 'unavailable', names: [...new Set(names)].sort() })
  }
  // Registry order reflects plugin load order, not the binding; order by
  // tool name so a reordered but otherwise identical registry is no drift.
  return bindingDigest([...schemas].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
}

/** Build per-node digests and a redacted summary. Contents never cross this boundary. */
export function buildBindingFacts(input: BindingFactInput): BindingFacts {
  const skillRefs = [...(input.skillRefs ?? [])]
  const toolsetRefs = [...(input.toolsetRefs ?? [])]
  const toolAllowlist = [...(input.toolAllowlist ?? [])].sort()
  const effectiveToolNames = [...(input.effectiveToolNames ?? [])].sort()
  const resourceDigests = Object.fromEntries(Object.entries(input.resourceDigests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const summary: BindingFacts['summary'] = {
    nodeId: input.nodeId,
    ...(input.agentRef === undefined ? {} : { agentRef: input.agentRef }),
    skillRefs,
    toolsetRefs,
    toolAllowlist,
    effectiveToolNames,
    ...(input.toolsetDigest === undefined ? {} : { toolsetDigest: input.toolsetDigest }),
    ...(input.modelSelection === undefined ? {} : { modelSelection: structuredClone(input.modelSelection) }),
    ...(input.outputSchemaRef === undefined ? {} : { outputSchemaRef: input.outputSchemaRef }),
    resourceIds: Object.keys(resourceDigests)
  }
  const prefix = `node:${input.nodeId}`
  const digests: Record<string, string> = {
    [`${prefix}:agent`]: bindingDigest({
      ref: input.agentRef ?? null,
      digest: input.agentRef === undefined ? null : (resourceDigests[input.agentRef] ?? null)
    }),
    [`${prefix}:skills`]: bindingDigest({ refs: skillRefs, digests: Object.fromEntries(skillRefs.map(ref => [ref, resourceDigests[ref] ?? null])) }),
    [`${prefix}:toolset`]: bindingDigest({ refs: toolsetRefs, effectiveToolNames, digest: input.toolsetDigest ?? null }),
    [`${prefix}:allowlist`]: bindingDigest({ declared: toolAllowlist, effective: effectiveToolNames }),
    [`${prefix}:model`]: bindingDigest(input.modelSelection ?? null),
    [`${prefix}:output-schema`]: bindingDigest({
      ref: input.outputSchemaRef ?? null,
      digest: input.outputSchemaRef === undefined ? null : (resourceDigests[input.outputSchemaRef] ?? null)
    }),
    [`${prefix}:resources`]: bindingDigest(resourceDigests)
  }
  digests[`${prefix}:binding`] = bindingDigest({ summary, digests })
  return { digests, summary }
}

export function aggregateBindingDigests(perNode: Array<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const node of perNode) Object.assign(result, node)
  const bindings = Object.fromEntries(
    Object.entries(result)
      .filter(([key]) => key.endsWith(':binding'))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  )
  result.$aggregate = bindingDigest(bindings)
  return result
}
