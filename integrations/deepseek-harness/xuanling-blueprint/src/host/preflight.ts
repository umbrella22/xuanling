/** Read-only admission checks. A report is an observation, never an authority
 * token: the driver resolves capabilities again and scoped Tools enforce them. */
import { NodeValueError, validateNodeInputs, structuralOutputs } from './node-values.ts'
import type { Context } from '@deepseek-ai/cordis'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type { BlueprintDefinition, GraphNode } from '../definition/types.ts'
import type { DefinitionPackage } from '../definition/persist.ts'
import { resolveResource, type SkillRoot } from '../resources/resolver.ts'
import { snapshotDirectory } from '../resources/snapshotter.ts'
import { createHostResourceProvider } from '../resources/runtime-snapshots.ts'
import { validatePackagedPreset, validatePackagedMcp, packagedPresetModulesAvailable } from '../portability/host-resources.ts'
import { teamDriverCapability, type TeamProviders } from '../teamstage/driver-admission.ts'

export interface ToolBinding {
  tools: string[]
}
export type ToolBindings = Record<string, ToolBinding>
/** DSH-owned capability probes. These are observations only; the runtime
 * resolves the same identity again before dispatch. */
export interface HostResourceProbe {
  getAgentPreset?(id: string): Promise<unknown | undefined>
  getSkill?(id: string, options: { cwd?: string; scope?: object }): Promise<{ content?: unknown } | undefined>
}
export interface PreflightRunArgs {
  blueprintId: string
  expectedRevision: string
  inputJson: string
}
export interface PreflightCheck {
  code: string
  status: 'block' | 'warning' | 'info' | 'pass'
  nodeId?: string
  resourceId?: string
  toolName?: string
}
export interface PreflightRunValue {
  blueprintId: string
  documentRevision: string
  semanticRevision: string
  canStart: boolean
  checks: PreflightCheck[]
}
export class ToolBindingUnavailableError extends Error {
  readonly code = 'tool-binding-unavailable'
  constructor() {
    super('declared tool capabilities unavailable')
  }
}
const reserved = new Set(['run_code', 'structured_output'])
const exactName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !name.includes('*') && !reserved.has(name)

/** Business grants are the declared union, optionally narrowed, never the
 * inherited Host registry. Reserved transport/capture tools are not grants. */
export function resolveEffectiveToolNames(ctx: Context, definition: BlueprintDefinition, node: GraphNode, bindings: ToolBindings = {}): string[] {
  const tools = ctx.get('tools')
  if (!tools || typeof tools.get !== 'function') throw new ToolBindingUnavailableError()
  const union = new Set<string>()
  for (const id of node.toolsetRefs ?? []) {
    const ref = definition.resources[id]
    if (!ref || ref.kind !== 'mcp' || !ref.bindingId) throw new ToolBindingUnavailableError()
    const source = ref.source
    if (source?.kind === 'host' || ref.format === 'mcp-definition') {
      const name = source?.kind === 'host' ? source.id : ref.bindingId
      if (
        !exactName(name) ||
        !name.startsWith('mcp__') ||
        ref.bindingId !== name ||
        !tools.get(name) ||
        typeof tools.schemas !== 'function' ||
        !tools.schemas().some(schema => schema.name === name)
      )
        throw new ToolBindingUnavailableError()
      union.add(name)
      continue
    }
    if (!Object.hasOwn(bindings, ref.bindingId)) throw new ToolBindingUnavailableError()
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

export async function collectPreflight(
  ctx: Context,
  snapshot: DefinitionPackage,
  definition: BlueprintDefinition,
  options: {
    toolBindings?: ToolBindings
    skillRoots: SkillRoot[]
    teamProviders?: TeamProviders
    input?: unknown
    hostResources?: HostResourceProbe
    /** Workspace root and Host scope used for resource observations. */
    cwd?: string
    scope?: object
  }
): Promise<PreflightRunValue> {
  const checks: PreflightCheck[] = []
  const hostResources = options.hostResources ?? createHostResourceProvider(ctx)
  // Only source nodes without data dependencies consume the initial input.
  // Generated downstream values stay under the driver's runtime checks.
  if (Object.hasOwn(options, 'input')) {
    for (const node of definition.graph.nodes) {
      if (definition.graph.edges.some(edge => edge.kind === 'data' && edge.to.startsWith(`${node.id}.`))) continue
      try {
        validateNodeInputs(node, options.input, new Set())
        if (node.kind === 'input' || node.kind === 'output' || node.kind === 'join') structuralOutputs(node, options.input, new Set())
      } catch (error) {
        if (!(error instanceof NodeValueError)) throw error
        checks.push({ code: error.code, status: 'block', nodeId: node.id })
      }
    }
  }
  const registry = ctx.get('agents') as { create?: unknown; createAgent?: unknown } | undefined
  const factoryReady = typeof registry?.create === 'function' || typeof registry?.createAgent === 'function'
  const tools = ctx.get('tools')
  const needsAgent = definition.graph.nodes.some(node => node.kind === 'agentTask')
  if (needsAgent) {
    checks.push({ code: factoryReady ? 'agent-factory-ready' : 'agent-factory-unavailable', status: factoryReady ? 'pass' : 'block' })
    checks.push({
      code:
        tools && typeof tools.get === 'function' && typeof tools.restrict === 'function' && typeof tools.guard === 'function'
          ? 'tools-ready'
          : 'tools-unavailable',
      status: tools && typeof tools.get === 'function' && typeof tools.restrict === 'function' && typeof tools.guard === 'function' ? 'pass' : 'block'
    })
  }
  for (const [resourceId, ref] of Object.entries(definition.resources)) {
    const source = ref.source
    if (source?.kind === 'host') {
      const hostId = source.id
      try {
        if (typeof hostId !== 'string') throw new Error('host-resource-provider-unavailable')
        if (ref.kind === 'agent') {
          if (hostResources.getAgentPreset === undefined || (await hostResources.getAgentPreset(hostId)) === undefined)
            throw new Error('host-agent-unavailable')
        } else if (ref.kind === 'skill') {
          if (
            hostResources.getSkill === undefined ||
            typeof (
              await hostResources.getSkill(hostId, {
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options.scope === undefined ? {} : { scope: options.scope })
              })
            )?.content !== 'string'
          )
            throw new Error('host-skill-unavailable')
        } else if (ref.kind === 'mcp') {
          const registry = ctx.get('tools')
          if (
            !exactName(hostId) ||
            !hostId.startsWith('mcp__') ||
            ref.bindingId !== hostId ||
            !registry ||
            typeof registry.get !== 'function' ||
            !registry.get(hostId) ||
            typeof registry.schemas !== 'function' ||
            !registry.schemas().some(schema => schema.name === hostId)
          )
            throw new Error('host-mcp-unavailable')
        } else throw new Error('host-resource-kind-unavailable')
        checks.push({ code: 'host-resource-ready', status: 'pass', resourceId })
      } catch {
        checks.push({ code: 'host-resource-unavailable', status: 'block', resourceId })
      }
      continue
    }
    if (ref.kind === 'mcp' && ref.format !== 'mcp-definition') continue // capability checks belong to declaring nodes
    try {
      if (ref.source?.kind === 'shared') {
        const resolved = await resolveResource(resourceId, { kind: ref.kind, source: ref.source }, { blueprintRoot: '', roots: options.skillRoots })
        if (resolved.kind !== 'shared-skill') throw new Error('unavailable')
        const files = snapshotDirectory(resolved.skillDir, {
          kind: 'shared-skill',
          rootId: resolved.rootId,
          skillDir: resolved.skillDir,
          skillName: resolved.skillName
        }).files
        if (!files.some(file => file.path === 'SKILL.md')) throw new Error('unavailable')
      } else {
        const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
        if (!path) throw new Error('unavailable')
        if (ref.kind === 'skill') {
          if (!snapshot.files.has(`${path}/SKILL.md`)) throw new Error('unavailable')
        } else {
          const bytes = snapshot.files.get(path)
          if (!bytes) throw new Error('unavailable')
          if (ref.kind === 'schema') assertObjectJsonSchema(JSON.parse(bytes.toString('utf8')))
          if (ref.format === 'agent-preset') {
            const preset = validatePackagedPreset(JSON.parse(bytes.toString('utf8')))
            if (preset.requiredBindings.length > 0) throw new Error('preset-binding-unavailable')
            const registry = ctx.get('agentPresets') as { register?: unknown } | undefined
            if (typeof registry?.register !== 'function') throw new Error('preset-registry-unavailable')
            if (!packagedPresetModulesAvailable(ctx, preset)) throw new Error('preset-module-unavailable')
          }
          if (ref.format === 'mcp-definition') validatePackagedMcp(JSON.parse(bytes.toString('utf8')))
        }
      }
      checks.push({ code: 'resource-ready', status: 'pass', resourceId })
    } catch {
      checks.push({ code: ref.kind === 'schema' ? 'output-schema-invalid' : 'resource-unavailable', status: 'block', resourceId })
    }
  }
  for (const node of definition.graph.nodes) {
    if (node.kind === 'condition' && node.condition === undefined) {
      checks.push({ code: 'condition-config-unavailable', status: 'block', nodeId: node.id })
      continue
    }
    let executorReady = true
    if (node.teamStage !== undefined) {
      const teamAgents = [node.agentRef, ...node.teamStage.members.map(member => member.agentRef)].filter((id): id is string => id !== undefined)
      if (teamAgents.some(id => definition.resources[id]?.source?.kind === 'host')) {
        checks.push({ code: 'teamstage-host-agent-unavailable', status: 'block', nodeId: node.id })
        executorReady = false
      }
      if (teamAgents.some(id => definition.resources[id]?.format === 'agent-preset')) {
        checks.push({ code: 'teamstage-packaged-agent-unavailable', status: 'block', nodeId: node.id })
        executorReady = false
      }
      const unavailable = teamDriverCapability(ctx, node, options.teamProviders)
      checks.push({ code: unavailable ?? 'teamstage-executor-ready', status: unavailable ? 'block' : 'pass', nodeId: node.id })
      executorReady = executorReady && unavailable === undefined
    }
    if (executorReady) checks.push({ code: 'node-executor-ready', status: 'pass', nodeId: node.id })
    if (node.kind !== 'agentTask') continue
    if (node.modelSelection !== undefined) {
      checks.push({
        code: node.teamStage === undefined ? 'model-route-declared' : 'teamstage-model-route-unavailable',
        status: node.teamStage === undefined ? 'info' : 'block',
        nodeId: node.id
      })
    }
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
