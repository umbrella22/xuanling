/**
 * Graph semantic validator (C-02/C-07): runs after the codec shape check.
 * Rejects duplicate ids, dangling resource refs, port/edge mismatches,
 * control-edge misuse, data cycles, and invalid package paths — each issue
 * located by JSON Pointer. Only statically checkable rules live here;
 * per-node execution semantics belong to their implementation waves.
 */
import { DefinitionInvalidError, type BlueprintDefinition, type GraphEdge, type GraphNode, type ValidationIssue } from './types.ts'
import { pathPattern, presentationSchema } from './codec.ts'

interface PortEndpoint {
  nodeId: string
  port: string
}

function parseDataEndpoint(edge: GraphEdge, side: 'from' | 'to', issues: ValidationIssue[], pointerBase: string): PortEndpoint | null {
  const value = edge[side]
  const dot = value.indexOf('.')
  if (dot <= 0 || dot === value.length - 1) {
    issues.push({ code: 'edge-invalid', message: `data edge ${side} must be "nodeId.port"`, pointer: `${pointerBase}/${side}` })
    return null
  }
  return { nodeId: value.slice(0, dot), port: value.slice(dot + 1) }
}

function collectDataCycles(nodes: GraphNode[], dataEdges: GraphEdge[]): string[][] {
  // Data edges form a DAG requirement: report every cycle found (bounded walk).
  const adjacency = new Map<string, string[]>()
  for (const edge of dataEdges) {
    const from = edge.from.split('.')[0]!
    const to = edge.to.split('.')[0]!
    adjacency.set(from, [...(adjacency.get(from) ?? []), to])
  }
  const cycles: string[][] = []
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const visit = (nodeId: string): void => {
    if (state.get(nodeId) === 'done' || cycles.length >= 10) return
    if (state.get(nodeId) === 'visiting') {
      const start = stack.indexOf(nodeId)
      cycles.push([...stack.slice(start), nodeId])
      return
    }
    state.set(nodeId, 'visiting')
    stack.push(nodeId)
    for (const next of adjacency.get(nodeId) ?? []) visit(next)
    stack.pop()
    state.set(nodeId, 'done')
  }
  for (const node of nodes) visit(node.id)
  return cycles
}

export function validateDefinition(definition: BlueprintDefinition): void {
  const issues: ValidationIssue[] = []

  // Resource refs: unique implicit by object keys; per-kind rules.
  for (const [refId, ref] of Object.entries(definition.resources)) {
    const pointer = `/resources/${refId}`
    const host = ref.source?.kind === 'host'
    if (ref.format !== undefined && ((ref.format === 'agent-preset' && ref.kind !== 'agent') || (ref.format === 'mcp-definition' && ref.kind !== 'mcp'))) {
      issues.push({ code: 'invalid-value', message: 'resource format does not match kind', pointer: `${pointer}/format` })
    }
    if (ref.source?.kind === 'host') {
      if (typeof ref.source.id !== 'string' || ref.source.id.trim().length === 0) {
        issues.push({ code: 'invalid-value', message: 'host resource requires a nonblank source.id', pointer: `${pointer}/source/id` })
      }
      if (ref.path !== undefined) {
        issues.push({ code: 'invalid-value', message: 'host resource must not carry a package path', pointer: `${pointer}/path` })
      }
      if (ref.format !== undefined) {
        issues.push({ code: 'invalid-value', message: 'host resource must not carry a package artifact format', pointer: `${pointer}/format` })
      }
      if (ref.kind !== 'mcp' && ref.bindingId !== undefined) {
        issues.push({ code: 'invalid-value', message: `${ref.kind} host resource must not carry bindingId`, pointer: `${pointer}/bindingId` })
      }
      if (ref.kind !== 'agent' && ref.kind !== 'skill' && ref.kind !== 'mcp') {
        issues.push({ code: 'invalid-value', message: `host source is not supported for ${ref.kind} resources`, pointer: `${pointer}/source` })
      }
    }
    if (ref.kind === 'mcp') {
      if (typeof ref.bindingId !== 'string' || ref.bindingId.length === 0) {
        issues.push({ code: 'invalid-value', message: 'mcp resource requires bindingId (capability role)', pointer })
      }
      if (ref.format === 'mcp-definition') {
        if (typeof ref.path !== 'string' || !pathPattern.test(ref.path) || ref.path.split('/').includes('..')) {
          issues.push({ code: 'path-invalid', message: 'mcp-definition requires a portable relative artifact path', pointer: `${pointer}/path` })
        }
        if (ref.source !== undefined) {
          issues.push({ code: 'invalid-value', message: 'packaged mcp-definition must not carry a source', pointer: `${pointer}/source` })
        }
      } else if (ref.path !== undefined) {
        issues.push({ code: 'invalid-value', message: 'mcp resource must not carry a package path', pointer: `${pointer}/path` })
      }
      if (ref.source !== undefined && ref.source.kind !== 'host') {
        issues.push({ code: 'invalid-value', message: 'mcp resource source must be host when present', pointer: `${pointer}/source` })
      }
      continue
    }
    if (ref.kind === 'skill') {
      if (host) continue
      if (ref.source?.kind === 'shared') {
        if (ref.path !== undefined) issues.push({ code: 'invalid-value', message: 'shared skill uses source, not package path', pointer })
        continue
      }
      if (ref.path !== undefined) {
        if (!pathPattern.test(ref.path) || ref.path.split('/').includes('..')) {
          issues.push({ code: 'path-invalid', message: `package skill path "${ref.path}" is not a portable relative path`, pointer })
        }
        continue
      }
      issues.push({ code: 'invalid-value', message: 'skill resource requires either shared source or package path', pointer })
      continue
    }
    if (ref.kind === 'agent' && host) continue
    // agent/prompt/schema/script/subflow: package-relative path required.
    if (typeof ref.path !== 'string' || !pathPattern.test(ref.path) || ref.path.split('/').includes('..')) {
      issues.push({ code: 'path-invalid', message: `${ref.kind} resource requires a portable relative path (no "..", no absolute)`, pointer })
    }
    if (ref.source !== undefined) {
      issues.push({ code: 'invalid-value', message: `only skill resources may use a shared source`, pointer })
    }
  }

  // Nodes: unique ids, kind-specific required refs.
  const nodeById = new Map<string, GraphNode>()
  let teamStageSeen = false
  for (const [index, node] of definition.graph.nodes.entries()) {
    const pointer = `/graph/nodes/${index}`
    if ((node.kind === 'blueprintCall') !== (node.blueprintRef !== undefined)) {
      issues.push({
        code: 'invalid-value',
        message: 'blueprintCall requires a fixed blueprintRef; other nodes cannot carry it',
        pointer: `${pointer}/blueprintRef`
      })
    }
    if (node.kind === 'blueprintCall') {
      for (const field of ['agentRef', 'skillRefs', 'toolsetRefs', 'outputSchemaRef', 'join', 'branches', 'condition'] as const) {
        if (node[field] !== undefined)
          issues.push({ code: 'invalid-value', message: 'blueprintCall uses only its declared interface and fixed reference', pointer: `${pointer}/${field}` })
      }
    }
    if (node.interaction !== undefined && (node.kind !== 'agentTask' || node.teamStage !== undefined)) {
      issues.push({ code: 'invalid-value', message: 'managed interaction requires an ordinary agentTask', pointer: `${pointer}/interaction` })
    }
    if (node.modelSelection !== undefined && node.kind !== 'agentTask') {
      issues.push({ code: 'invalid-value', message: 'modelSelection belongs to agentTask only', pointer: `${pointer}/modelSelection` })
    }
    if (nodeById.has(node.id)) {
      issues.push({ code: 'duplicate-id', message: `node id "${node.id}" is duplicated`, pointer: `${pointer}/id` })
    }
    nodeById.set(node.id, node)
    const has = (refId: string | undefined, field: string): boolean => {
      if (refId === undefined) {
        issues.push({ code: 'dangling-ref', message: `${node.kind} node requires ${field}`, pointer: `${pointer}/${field}` })
        return false
      }
      if (!Object.hasOwn(definition.resources, refId)) {
        issues.push({ code: 'dangling-ref', message: `node references unknown resource "${refId}"`, pointer: `${pointer}/${field}` })
        return false
      }
      return true
    }
    if (node.kind === 'agentTask') {
      const agentOk = has(node.agentRef, 'agentRef')
      if (agentOk && definition.resources[node.agentRef!]?.kind !== 'agent') {
        issues.push({ code: 'dangling-ref', message: `agentRef "${node.agentRef}" is not an agent resource`, pointer: `${pointer}/agentRef` })
      }
      for (const [i, skillRef] of (node.skillRefs ?? []).entries()) {
        if (Object.hasOwn(definition.resources, skillRef) && definition.resources[skillRef]?.kind !== 'skill') {
          issues.push({ code: 'dangling-ref', message: `skillRef "${skillRef}" is not a skill resource`, pointer: `${pointer}/skillRefs/${i}` })
        }
      }
      for (const [i, toolsetRef] of (node.toolsetRefs ?? []).entries()) {
        if (Object.hasOwn(definition.resources, toolsetRef) && definition.resources[toolsetRef]?.kind !== 'mcp') {
          issues.push({ code: 'dangling-ref', message: `toolsetRef "${toolsetRef}" is not an mcp resource`, pointer: `${pointer}/toolsetRefs/${i}` })
        }
      }
      if (
        node.outputSchemaRef !== undefined &&
        Object.hasOwn(definition.resources, node.outputSchemaRef) &&
        definition.resources[node.outputSchemaRef]?.kind !== 'schema'
      ) {
        issues.push({
          code: 'dangling-ref',
          message: `outputSchemaRef "${node.outputSchemaRef}" is not a schema resource`,
          pointer: `${pointer}/outputSchemaRef`
        })
      }
    }
    if (node.teamStage !== undefined) {
      if (node.kind !== 'agentTask') {
        issues.push({ code: 'invalid-value', message: 'teamStage belongs to agentTask only', pointer: `${pointer}/teamStage` })
      } else {
        has(node.outputSchemaRef, 'outputSchemaRef')
      }
      if (teamStageSeen) {
        issues.push({ code: 'invalid-value', message: 'a graph supports at most one TeamStage aggregate', pointer: `${pointer}/teamStage` })
      }
      teamStageSeen = true
      const names = new Set<string>()
      for (const [i, member] of node.teamStage.members.entries()) {
        const memberPointer = `${pointer}/teamStage/members/${i}`
        if (names.has(member.name)) {
          issues.push({ code: 'duplicate-id', message: 'duplicate TeamStage member name', pointer: `${memberPointer}/name` })
        }
        names.add(member.name)
        const agentOk = has(member.agentRef, `teamStage/members/${i}/agentRef`)
        if (agentOk && definition.resources[member.agentRef]?.kind !== 'agent') {
          issues.push({ code: 'dangling-ref', message: `member agentRef "${member.agentRef}" is not an agent resource`, pointer: `${memberPointer}/agentRef` })
        }
      }
      const checks = new Set<string>()
      for (const [i, check] of node.teamStage.requiredChecks.entries()) {
        if (checks.has(check)) {
          issues.push({ code: 'duplicate-id', message: 'duplicate TeamStage required check', pointer: `${pointer}/teamStage/requiredChecks/${i}` })
        }
        checks.add(check)
      }
    }
    if (node.toolAllowlist !== undefined && node.kind !== 'agentTask') {
      issues.push({ code: 'invalid-value', message: 'toolAllowlist belongs to agentTask only', pointer: `${pointer}/toolAllowlist` })
    }
    if (node.condition !== undefined) {
      const config = node.condition
      if (
        node.kind !== 'condition' ||
        node.inputs?.[config.inputPort] !== 'boolean' ||
        config.trueBranch === config.falseBranch ||
        !node.branches?.includes(config.trueBranch) ||
        !node.branches.includes(config.falseBranch)
      ) {
        issues.push({
          code: 'invalid-value',
          message: 'condition requires one boolean input and two distinct declared branches',
          pointer: `${pointer}/condition`
        })
      }
    }
    if (node.kind === 'condition' && (node.branches === undefined || node.branches.length === 0)) {
      issues.push({ code: 'invalid-value', message: 'condition node requires branches', pointer: `${pointer}/branches` })
    }
  }

  // Edges: endpoints exist; data edges connect declared ports with matching
  // types; control edges reference node (or branch) ids, never ports.
  const dataEdges: GraphEdge[] = []
  for (const [index, edge] of definition.graph.edges.entries()) {
    const pointer = `/graph/edges/${index}`
    if (edge.kind === 'data') {
      dataEdges.push(edge)
      const from = parseDataEndpoint(edge, 'from', issues, pointer)
      const to = parseDataEndpoint(edge, 'to', issues, pointer)
      if (from !== null) {
        const node = nodeById.get(from.nodeId)
        if (node === undefined) {
          issues.push({ code: 'dangling-ref', message: `data edge from unknown node "${from.nodeId}"`, pointer: `${pointer}/from` })
        } else if (node.outputs?.[from.port] === undefined) {
          issues.push({ code: 'port-mismatch', message: `node "${from.nodeId}" declares no output port "${from.port}"`, pointer: `${pointer}/from` })
        }
      }
      if (to !== null) {
        const node = nodeById.get(to.nodeId)
        if (node === undefined) {
          issues.push({ code: 'dangling-ref', message: `data edge to unknown node "${to.nodeId}"`, pointer: `${pointer}/to` })
        } else if (node.inputs?.[to.port] === undefined) {
          issues.push({ code: 'port-mismatch', message: `node "${to.nodeId}" declares no input port "${to.port}"`, pointer: `${pointer}/to` })
        } else if (from !== null) {
          const outType = nodeById.get(from.nodeId)?.outputs?.[from.port]
          const inType = node.inputs[to.port]
          if (outType !== undefined && inType !== undefined && outType !== inType) {
            issues.push({
              code: 'port-mismatch',
              message: `type conflict: "${edge.from}" is ${outType} but "${edge.to}" expects ${inType}`,
              pointer: `${pointer}/to`
            })
          }
        }
      }
    } else {
      const fromNode = edge.from.split('@')[0]!
      const toNode = edge.to.split('@')[0]!
      if (!nodeById.has(fromNode)) {
        issues.push({ code: 'dangling-ref', message: `control edge from unknown node "${fromNode}"`, pointer: `${pointer}/from` })
      } else if (edge.from.includes('@')) {
        const branch = edge.from.split('@')[1]!
        const owner = nodeById.get(fromNode)
        if (owner?.kind === 'condition' && !owner.branches?.includes(branch)) {
          issues.push({ code: 'port-mismatch', message: `condition node "${fromNode}" declares no branch "${branch}"`, pointer: `${pointer}/from` })
        }
      }
      if (!nodeById.has(toNode)) {
        issues.push({ code: 'dangling-ref', message: `control edge to unknown node "${toNode}"`, pointer: `${pointer}/to` })
      } else if (edge.to.includes('.')) {
        issues.push({ code: 'edge-invalid', message: 'control edges target nodes, never data ports', pointer: `${pointer}/to` })
      }
    }
  }

  // Data graph must be acyclic.
  for (const cycle of collectDataCycles(definition.graph.nodes, dataEdges)) {
    issues.push({ code: 'cycle', message: `data edge cycle: ${cycle.join(' -> ')}`, pointer: '/graph/edges' })
  }

  // Presentation remains non-semantic, with strict shape and references.
  const parsedPresentation = definition.presentation === undefined ? undefined : presentationSchema.safeParse(definition.presentation)
  if (parsedPresentation && !parsedPresentation.success) {
    for (const issue of parsedPresentation.error.issues) {
      const pointer = '/presentation/' + issue.path.map(p => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
      issues.push({ code: 'invalid-value', message: issue.message, pointer })
    }
  }
  const presentation = parsedPresentation?.success ? parsedPresentation.data : undefined
  for (const resourceId of Object.keys(presentation?.resources ?? {})) {
    if (!Object.hasOwn(definition.resources, resourceId)) {
      issues.push({
        code: 'dangling-ref',
        message: `presentation references unknown resource "${resourceId}"`,
        pointer: `/presentation/resources/${resourceId}`
      })
    }
  }
  for (const nodeId of Object.keys(presentation?.nodes ?? {})) {
    if (!nodeById.has(nodeId))
      issues.push({ code: 'dangling-ref', message: `presentation references unknown node "${nodeId}"`, pointer: `/presentation/nodes/${nodeId}` })
  }
  const groupIds = new Set<string>()
  for (const [index, group] of (presentation?.groups ?? []).entries()) {
    if (groupIds.has(group.id)) issues.push({ code: 'duplicate-id', message: 'duplicate presentation group', pointer: `/presentation/groups/${index}/id` })
    groupIds.add(group.id)
    const members = new Set<string>()
    for (const [i, nodeId] of group.nodeIds.entries()) {
      if (!nodeById.has(nodeId))
        issues.push({
          code: 'dangling-ref',
          message: `group "${group.id}" references unknown node "${nodeId}"`,
          pointer: `/presentation/groups/${index}/nodeIds/${i}`
        })
      if (members.has(nodeId)) issues.push({ code: 'duplicate-id', message: 'duplicate group member', pointer: `/presentation/groups/${index}/nodeIds/${i}` })
      members.add(nodeId)
    }
  }
  const key = (edge: GraphEdge): string => JSON.stringify([edge.kind, edge.from, edge.to])
  const graphEdges = new Set(definition.graph.edges.map(key))
  const presentationEdges = new Set<string>()
  for (const [index, edge] of (presentation?.edges ?? []).entries()) {
    const pointer = `/presentation/edges/${index}`
    if (!graphEdges.has(key(edge))) issues.push({ code: 'dangling-ref', message: 'presentation edge must reference a complete logical edge', pointer })
    if (presentationEdges.has(key(edge))) issues.push({ code: 'duplicate-id', message: 'duplicate presentation edge triple', pointer })
    presentationEdges.add(key(edge))
  }

  if (issues.length > 0) throw new DefinitionInvalidError(issues)
}
