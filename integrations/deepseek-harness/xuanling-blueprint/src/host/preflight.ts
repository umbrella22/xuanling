/** Read-only admission checks. A report is an observation, never an authority
 * token: the driver resolves capabilities again and scoped Tools enforce them. */
import type { Context } from '@deepseek-ai/cordis'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { BlueprintDefinition, GraphNode } from '../definition/types.ts'
import type { DefinitionPackage } from '../definition/persist.ts'
import { resolveResource, type SkillRoot } from '../resources/resolver.ts'
import { snapshotDirectory } from '../resources/snapshotter.ts'
import { teamDriverCapability, type TeamProviders } from '../teamstage/driver-admission.ts'

export interface ToolBinding { tools: string[] }
export type ToolBindings = Record<string, ToolBinding>
export interface PreflightRunArgs { blueprintId: string; expectedRevision: string; inputJson: string }
export interface PreflightCheck {
  code: string
  status: 'block' | 'warning' | 'info' | 'pass'
  nodeId?: string
  resourceId?: string
  toolName?: string
}
export interface PreflightRunValue {
  blueprintId: string; documentRevision: string; semanticRevision: string
  canStart: boolean; checks: PreflightCheck[]
}
export class ToolBindingUnavailableError extends Error {
  readonly code = 'tool-binding-unavailable'
  constructor() { super('declared tool capabilities unavailable') }
}
const reserved = new Set(['run_code', 'structured_output'])
const exactName = (name: unknown): name is string => typeof name === 'string'
  && name.length > 0 && !name.includes('*') && !reserved.has(name)

/** Business grants are the declared union, optionally narrowed, never the
 * inherited Host registry. Reserved transport/capture tools are not grants. */
export function resolveEffectiveToolNames(ctx: Context, definition: BlueprintDefinition, node: GraphNode, bindings: ToolBindings = {}): string[] {
  const tools = ctx.get('tools')
  if (!tools || typeof tools.get !== 'function') throw new ToolBindingUnavailableError()
  const union = new Set<string>()
  for (const id of node.toolsetRefs ?? []) {
    const ref = definition.resources[id]
    if (!ref || ref.kind !== 'mcp' || !ref.bindingId || !Object.hasOwn(bindings, ref.bindingId)) throw new ToolBindingUnavailableError()
    const binding = bindings[ref.bindingId]
    if (!binding || !Array.isArray(binding.tools)) throw new ToolBindingUnavailableError()
    for (const name of binding.tools) {
      if (!exactName(name) || !tools.get(name)) throw new ToolBindingUnavailableError()
      union.add(name)
    }
  }
  if (node.toolAllowlist?.some(name => !exactName(name))) throw new ToolBindingUnavailableError()
  // The node can only narrow the declared, currently visible union. An exact
  // registered name outside it (or a not-yet-registered name) grants nothing.
  const allow = node.toolAllowlist === undefined ? undefined : new Set(node.toolAllowlist)
  return [...union].filter(name => allow === undefined || allow.has(name)).sort()
}

export async function collectPreflight(ctx: Context, snapshot: DefinitionPackage, definition: BlueprintDefinition, options: {
  toolBindings?: ToolBindings; skillRoots: SkillRoot[]; teamProviders?: TeamProviders
}): Promise<PreflightRunValue> {
  const checks: PreflightCheck[] = []
  const registry = ctx.get('agents') as { create?: unknown; createAgent?: unknown } | undefined
  const factoryReady = typeof registry?.create === 'function' || typeof registry?.createAgent === 'function'
  const tools = ctx.get('tools')
  const needsAgent = definition.graph.nodes.some(node => node.kind === 'agentTask')
  if (needsAgent) {
    checks.push({ code: factoryReady ? 'agent-factory-ready' : 'agent-factory-unavailable', status: factoryReady ? 'pass' : 'block' })
    checks.push({ code: tools && typeof tools.get === 'function' && typeof tools.restrict === 'function' && typeof tools.guard === 'function' ? 'tools-ready' : 'tools-unavailable',
      status: tools && typeof tools.get === 'function' && typeof tools.restrict === 'function' && typeof tools.guard === 'function' ? 'pass' : 'block' })
  }
  for (const [resourceId, ref] of Object.entries(definition.resources)) {
    if (ref.kind === 'mcp') continue // capability checks belong to declaring nodes
    try {
      if (ref.source?.kind === 'shared') {
        const resolved = await resolveResource(resourceId, { kind: ref.kind, source: ref.source }, { blueprintRoot: '', roots: options.skillRoots })
        if (resolved.kind !== 'shared-skill') throw new Error('unavailable')
        const files = snapshotDirectory(resolved.skillDir, { kind: 'shared-skill', rootId: resolved.rootId, skillDir: resolved.skillDir, skillName: resolved.skillName }).files
        if (!files.some(file => file.path === 'SKILL.md')) throw new Error('unavailable')
      } else {
        const path = ref.path
        if (!path) throw new Error('unavailable')
        if (ref.kind === 'skill') {
          if (!snapshot.files.has(`${path}/SKILL.md`)) throw new Error('unavailable')
        } else {
          const bytes = snapshot.files.get(path)
          if (!bytes) throw new Error('unavailable')
          if (ref.kind === 'schema') assertObjectJsonSchema(JSON.parse(bytes.toString('utf8')))
        }
      }
      checks.push({ code: 'resource-ready', status: 'pass', resourceId })
    } catch {
      checks.push({ code: ref.kind === 'schema' ? 'output-schema-invalid' : 'resource-unavailable', status: 'block', resourceId })
    }
  }
  for (const node of definition.graph.nodes) {
    if (!['input', 'output', 'agentTask', 'humanDecision', 'condition', 'join'].includes(node.kind)
      || (node.kind === 'join' && node.join === 'any')) {
      checks.push({ code: 'node-executor-unavailable', status: 'block', nodeId: node.id })
      continue
    }
    // Old records without behavior remain readable, not silently manual.
    if (node.kind === 'condition' && node.condition === undefined) {
      checks.push({ code: 'condition-config-unavailable', status: 'block', nodeId: node.id })
      continue
    }
    let executorReady = true
    if (node.teamStage !== undefined) {
      const unavailable = teamDriverCapability(ctx, node, options.teamProviders)
      checks.push({ code: unavailable ?? 'teamstage-executor-ready', status: unavailable ? 'block' : 'pass', nodeId: node.id })
      executorReady = unavailable === undefined
    }
    if (executorReady) checks.push({ code: 'node-executor-ready', status: 'pass', nodeId: node.id })
    if (node.kind !== 'agentTask') continue
    for (const resourceId of node.skillRefs ?? []) {
      if (!Object.hasOwn(definition.resources, resourceId)) checks.push({ code: 'resource-unavailable', status: 'block', nodeId: node.id, resourceId })
    }
    try {
      resolveEffectiveToolNames(ctx, definition, node, options.toolBindings)
      checks.push({ code: 'tool-binding-ready', status: 'pass', nodeId: node.id })
      for (const resourceId of new Set(node.toolsetRefs ?? [])) {
        checks.push({ code: 'reachability-unverified', status: 'warning', nodeId: node.id, resourceId })
      }
      checks.push({ code: 'host-approval-unverified', status: 'info', nodeId: node.id })
    } catch {
      checks.push({ code: 'tool-binding-unavailable', status: 'block', nodeId: node.id })
    }
    if (node.outputSchemaRef && !Object.hasOwn(definition.resources, node.outputSchemaRef)) {
      checks.push({ code: 'output-schema-unavailable', status: 'block', nodeId: node.id, resourceId: node.outputSchemaRef })
    }
    if (Object.values(node.outputs ?? {}).some(type => type !== 'string' && type !== 'json')) {
      checks.push({ code: 'output-port-unsupported', status: 'block', nodeId: node.id })
    }
  }
  if (checks.length === 0) checks.push({ code: 'definition-ready', status: 'pass' })
  const { blueprintId, documentRevision, semanticRevision } = snapshot.document
  return { blueprintId, documentRevision, semanticRevision, canStart: !checks.some(check => check.status === 'block'), checks }
}
