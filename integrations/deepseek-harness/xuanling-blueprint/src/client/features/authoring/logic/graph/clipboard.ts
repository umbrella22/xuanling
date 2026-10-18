/** Declaration-only clipboard. No file, runtime, or system clipboard access. */
import type { GraphEdge, GraphNode, Presentation, ResourceRef } from '../../../../../definition/types.ts'

export interface ClipboardFragment {
  version: 1
  sourceBlueprintId: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  incoming: GraphEdge[]
  resources: Record<string, ResourceRef>
  presentation: Presentation
}

export type ClipboardPasteResult =
  | { ok: true; code: 'clipboard-pasted'; nodeIds: string[] }
  | {
      ok: false
      code: 'clipboard-invalid' | 'clipboard-resource-conflict' | 'clipboard-incoming-cross-blueprint' | 'no-definition' | 'port-hidden'
      nodeIds: []
    }

export class ClipboardError extends Error {
  readonly code = 'clipboard-invalid'
  constructor(readonly pointer: string) {
    super(`Invalid clipboard declaration at ${pointer}`)
  }
}

const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const pathPattern = /^(?!\/)[A-Za-z0-9._\-/]+[A-Za-z0-9._-]$/
const kinds = ['input', 'output', 'agentTask', 'condition', 'join', 'humanDecision']
const colors = ['default', 'blue', 'green', 'amber', 'red', 'purple']
function fail(pointer: string): never {
  throw new ClipboardError(pointer)
}
function record(value: unknown, pointer: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(pointer)
  return value as Record<string, unknown>
}
function shape(value: unknown, keys: string[], required: string[], pointer: string): Record<string, unknown> {
  const obj = record(value, pointer)
  for (const key of Object.keys(obj)) if (!keys.includes(key)) fail(`${pointer}/${key}`)
  for (const key of required) if (!Object.hasOwn(obj, key)) fail(`${pointer}/${key}`)
  return obj
}
function string(value: unknown, pointer: string, id = false): asserts value is string {
  if (typeof value !== 'string' || !value.length || (id && !idPattern.test(value))) fail(pointer)
}
function finite(value: unknown, pointer: string, positive = false): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive && value <= 0)) fail(pointer)
}
function array(value: unknown, pointer: string): unknown[] {
  if (!Array.isArray(value)) fail(pointer)
  return value
}
export function edgeKey(edge: GraphEdge): string {
  return JSON.stringify([edge.kind, edge.from, edge.to])
}
export function endpointNode(value: string, kind: GraphEdge['kind']): string {
  return value.split(kind === 'data' ? '.' : '@')[0]!
}
function checkEdge(value: unknown, pointer: string): GraphEdge {
  const e = shape(value, ['kind', 'from', 'to'], ['kind', 'from', 'to'], pointer)
  if (e.kind !== 'data' && e.kind !== 'control') fail(`${pointer}/kind`)
  string(e.from, `${pointer}/from`)
  string(e.to, `${pointer}/to`)
  for (const side of ['from', 'to'] as const) {
    const value = e[side] as string
    if (e.kind === 'data') {
      const dot = value.indexOf('.')
      if (dot <= 0 || dot === value.length - 1 || !idPattern.test(value.slice(0, dot))) fail(`${pointer}/${side}`)
    } else {
      const parts = value.split('@')
      if (!idPattern.test(parts[0]!) || parts.length > 2 || (parts.length === 2 && (side === 'to' || !idPattern.test(parts[1]!)))) fail(`${pointer}/${side}`)
    }
  }
  return value as GraphEdge
}

/** Also used for local layout import: complete shape/reference check before mutation. */
export function validatePresentation(
  value: unknown,
  nodeIds: Iterable<string>,
  graphEdges: GraphEdge[],
  resourceIds?: Iterable<string>
): asserts value is Presentation {
  const p = shape(value, ['nodes', 'resources', 'groups', 'edges'], ['nodes'], '/presentation')
  const ids = new Set(nodeIds)
  for (const [id, raw] of Object.entries(record(p.nodes, '/presentation/nodes'))) {
    const at = `/presentation/nodes/${id}`
    if (!ids.has(id)) fail(at)
    const n = shape(raw, ['x', 'y', 'title', 'collapsed', 'pinned', 'width', 'height', 'color', 'ports'], ['x', 'y'], at)
    finite(n.x, `${at}/x`)
    finite(n.y, `${at}/y`)
    if (Object.hasOwn(n, 'ports')) {
      const ports = shape(n.ports, ['control', 'inputs', 'outputs'], [], `${at}/ports`)
      for (const key of Object.keys(ports)) if (typeof ports[key] !== 'boolean') fail(`${at}/ports/${key}`)
    }
    if (Object.hasOwn(n, 'title') && typeof n.title !== 'string') fail(`${at}/title`)
    for (const key of ['collapsed', 'pinned']) if (Object.hasOwn(n, key) && typeof n[key] !== 'boolean') fail(`${at}/${key}`)
    for (const key of ['width', 'height']) if (Object.hasOwn(n, key)) finite(n[key], `${at}/${key}`, true)
    if (Object.hasOwn(n, 'color') && !colors.includes(n.color as string)) fail(`${at}/color`)
  }
  if (Object.hasOwn(p, 'resources')) {
    const knownResources = resourceIds === undefined ? undefined : new Set(resourceIds)
    for (const [id, raw] of Object.entries(record(p.resources, '/presentation/resources'))) {
      const at = `/presentation/resources/${id}`
      string(id, at, true)
      if (knownResources !== undefined && !knownResources.has(id)) fail(at)
      const metadata = shape(raw, ['title', 'description'], [], at)
      for (const key of ['title', 'description']) if (Object.hasOwn(metadata, key) && typeof metadata[key] !== 'string') fail(`${at}/${key}`)
    }
  }
  if (Object.hasOwn(p, 'groups')) {
    const seen = new Set<string>()
    array(p.groups, '/presentation/groups').forEach((raw, i) => {
      const at = `/presentation/groups/${i}`
      const g = shape(raw, ['id', 'label', 'nodeIds'], ['id', 'nodeIds'], at)
      string(g.id, `${at}/id`, true)
      if (seen.has(g.id)) fail(`${at}/id`)
      seen.add(g.id)
      if (Object.hasOwn(g, 'label') && typeof g.label !== 'string') fail(`${at}/label`)
      const members = new Set<string>()
      array(g.nodeIds, `${at}/nodeIds`).forEach((id, j) => {
        string(id, `${at}/nodeIds/${j}`, true)
        if (!ids.has(id) || members.has(id)) fail(`${at}/nodeIds/${j}`)
        members.add(id)
      })
    })
  }
  if (Object.hasOwn(p, 'edges')) {
    const known = new Set(graphEdges.map(edgeKey))
    const seen = new Set<string>()
    array(p.edges, '/presentation/edges').forEach((raw, i) => {
      const at = `/presentation/edges/${i}`
      const e = shape(raw, ['kind', 'from', 'to', 'points'], ['kind', 'from', 'to', 'points'], at)
      const edge = checkEdge({ kind: e.kind, from: e.from, to: e.to }, at)
      const key = edgeKey(edge)
      if (!known.has(key) || seen.has(key)) fail(at)
      seen.add(key)
      array(e.points, `${at}/points`).forEach((raw, j) => {
        const point = shape(raw, ['x', 'y'], ['x', 'y'], `${at}/points/${j}`)
        finite(point.x, `${at}/points/${j}/x`)
        finite(point.y, `${at}/points/${j}/y`)
      })
    })
  }
}

export function referencedResourceIds(nodes: GraphNode[]): Set<string> {
  return new Set(
    nodes.flatMap(n => [n.agentRef, n.outputSchemaRef, ...(n.skillRefs ?? []), ...(n.toolsetRefs ?? [])].filter((id): id is string => id !== undefined))
  )
}

/** Explicit refs are checked in editor transactions; incomplete editor forms remain editable. */
export function validateResourceReferences(nodes: GraphNode[], resources: Record<string, ResourceRef>): void {
  for (const node of nodes) {
    const refs: Array<[string | undefined, ResourceRef['kind']]> = [
      [node.agentRef, 'agent'],
      [node.outputSchemaRef, 'schema'],
      ...(node.skillRefs ?? []).map(id => [id, 'skill'] as [string, 'skill']),
      ...(node.toolsetRefs ?? []).map(id => [id, 'mcp'] as [string, 'mcp'])
    ]
    for (const [id, kind] of refs) if (id !== undefined && (!Object.hasOwn(resources, id) || resources[id]?.kind !== kind)) fail(`/nodes/${node.id}/refs/${id}`)
  }
}

function checkResource(raw: unknown, at: string): void {
  const r = shape(raw, ['kind', 'path', 'source', 'bindingId', 'format'], ['kind'], at)
  if (!['agent', 'prompt', 'skill', 'schema', 'script', 'mcp', 'subflow'].includes(r.kind as string)) fail(`${at}/kind`)
  if (Object.hasOwn(r, 'bindingId')) string(r.bindingId, `${at}/bindingId`, true)
  if (Object.hasOwn(r, 'format') && !((r.kind === 'agent' && r.format === 'agent-preset') || (r.kind === 'mcp' && r.format === 'mcp-definition')))
    fail(`${at}/format`)
  if (typeof r.source === 'object' && r.source !== null && 'kind' in r.source && r.source.kind === 'host') {
    if (
      !['agent', 'skill', 'mcp'].includes(r.kind as string) ||
      Object.hasOwn(r, 'path') ||
      Object.hasOwn(r, 'format') ||
      (r.kind !== 'mcp' && Object.hasOwn(r, 'bindingId'))
    )
      fail(at)
    const s = shape(r.source, ['kind', 'id'], ['kind', 'id'], `${at}/source`)
    string(s.id, `${at}/source/id`)
    if (!(s.id as string).trim()) fail(`${at}/source/id`)
  } else if (r.kind === 'mcp') {
    string(r.bindingId, `${at}/bindingId`, true)
    if (Object.hasOwn(r, 'source')) fail(at)
    if (r.format === 'mcp-definition') {
      if (typeof r.path !== 'string' || !pathPattern.test(r.path) || r.path.split('/').includes('..')) fail(`${at}/path`)
    } else if (Object.hasOwn(r, 'path')) fail(at)
  } else if (r.kind === 'skill' && Object.hasOwn(r, 'source')) {
    if (Object.hasOwn(r, 'path')) fail(at)
    const s = shape(r.source, ['kind', 'rootId', 'path'], ['kind', 'rootId', 'path'], `${at}/source`)
    if (s.kind !== 'shared' || typeof s.rootId !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(s.rootId)) fail(`${at}/source`)
    string(s.path, `${at}/source/path`)
  } else {
    if (Object.hasOwn(r, 'source') || typeof r.path !== 'string' || !pathPattern.test(r.path) || r.path.split('/').includes('..')) fail(`${at}/path`)
  }
}
function checkNode(raw: unknown, at: string): GraphNode {
  const n = shape(
    raw,
    [
      'id',
      'kind',
      'outputs',
      'inputs',
      'agentRef',
      'skillRefs',
      'toolsetRefs',
      'toolAllowlist',
      'condition',
      'outputSchemaRef',
      'join',
      'branches',
      'modelSelection'
    ],
    ['id', 'kind'],
    at
  )
  string(n.id, `${at}/id`, true)
  if (!kinds.includes(n.kind as string)) fail(`${at}/kind`)
  if (Object.hasOwn(n, 'modelSelection')) {
    if (n.kind !== 'agentTask') fail(`${at}/modelSelection`)
    const route = shape(n.modelSelection, ['provider', 'model', 'reasoningEffort'], ['provider', 'model'], `${at}/modelSelection`)
    for (const field of ['provider', 'model', 'reasoningEffort'])
      if (Object.hasOwn(route, field)) {
        string(route[field], `${at}/modelSelection/${field}`)
        if (!(route[field] as string).trim()) fail(`${at}/modelSelection/${field}`)
      }
  }
  for (const key of ['outputs', 'inputs'])
    if (Object.hasOwn(n, key)) {
      for (const [port, type] of Object.entries(record(n[key], `${at}/${key}`))) {
        // Port names are raw keys: Unicode and embedded dots are preserved.
        string(type, `${at}/${key}/${port}`)
      }
    }
  for (const key of ['agentRef', 'outputSchemaRef']) if (Object.hasOwn(n, key)) string(n[key], `${at}/${key}`, true)
  for (const key of ['skillRefs', 'toolsetRefs', 'branches', 'toolAllowlist'])
    if (Object.hasOwn(n, key)) array(n[key], `${at}/${key}`).forEach((v, i) => string(v, `${at}/${key}/${i}`, key !== 'toolAllowlist'))
  if (Object.hasOwn(n, 'join') && n.join !== 'all') fail(`${at}/join`)
  if (Object.hasOwn(n, 'condition')) {
    const c = shape(n.condition, ['inputPort', 'trueBranch', 'falseBranch'], ['inputPort', 'trueBranch', 'falseBranch'], `${at}/condition`)
    string(c.inputPort, `${at}/condition/inputPort`)
    string(c.trueBranch, `${at}/condition/trueBranch`, true)
    string(c.falseBranch, `${at}/condition/falseBranch`, true)
    if (
      n.kind !== 'condition' ||
      (n.inputs as Record<string, string> | undefined)?.[c.inputPort] !== 'boolean' ||
      c.trueBranch === c.falseBranch ||
      !(n.branches as string[] | undefined)?.includes(c.trueBranch) ||
      !(n.branches as string[]).includes(c.falseBranch)
    )
      fail(`${at}/condition`)
  }
  if (n.toolAllowlist !== undefined && n.kind !== 'agentTask') fail(`${at}/toolAllowlist`)
  return raw as GraphNode
}

function checkEndpoint(edge: GraphEdge, node: GraphNode, side: 'from' | 'to', at: string): void {
  const value = edge[side]
  if (edge.kind === 'data') {
    const port = value.slice(value.indexOf('.') + 1)
    if (!Object.hasOwn(side === 'from' ? (node.outputs ?? {}) : (node.inputs ?? {}), port)) fail(`${at}/${side}`)
  } else if (side === 'from') {
    const branch = value.split('@')[1]
    if (branch !== undefined && !node.branches?.includes(branch)) fail(`${at}/${side}`)
    if (branch === undefined && node.branches?.length) fail(`${at}/${side}`)
  }
}
export function decodeClipboard(input: unknown): ClipboardFragment {
  try {
    const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input
    const f = shape(
      raw,
      ['version', 'sourceBlueprintId', 'nodes', 'edges', 'incoming', 'resources', 'presentation'],
      ['version', 'sourceBlueprintId', 'nodes', 'edges', 'incoming', 'resources', 'presentation'],
      ''
    )
    if (f.version !== 1) fail('/version')
    string(f.sourceBlueprintId, '/sourceBlueprintId', true)
    const nodes = array(f.nodes, '/nodes').map((n, i) => checkNode(n, `/nodes/${i}`))
    if (!nodes.length) fail('/nodes')
    const byId = new Map<string, GraphNode>()
    nodes.forEach((n, i) => {
      if (byId.has(n.id)) fail(`/nodes/${i}/id`)
      byId.set(n.id, n)
    })
    const resources = record(f.resources, '/resources')
    for (const [id, r] of Object.entries(resources)) {
      string(id, `/resources/${id}`, true)
      checkResource(r, `/resources/${id}`)
    }
    const refs = referencedResourceIds(nodes)
    if (refs.size !== Object.keys(resources).length || [...refs].some(id => !Object.hasOwn(resources, id))) fail('/resources')
    validateResourceReferences(nodes, resources as Record<string, ResourceRef>)
    const seen = new Set<string>()
    const edges = array(f.edges, '/edges').map((e, i) => {
      const at = `/edges/${i}`
      const edge = checkEdge(e, at)
      const from = byId.get(endpointNode(edge.from, edge.kind))
      const to = byId.get(endpointNode(edge.to, edge.kind))
      if (!from || !to || from === to || seen.has(edgeKey(edge))) fail(at)
      seen.add(edgeKey(edge))
      checkEndpoint(edge, from, 'from', at)
      checkEndpoint(edge, to, 'to', at)
      if (edge.kind === 'data' && from.outputs?.[edge.from.slice(edge.from.indexOf('.') + 1)] !== to.inputs?.[edge.to.slice(edge.to.indexOf('.') + 1)]) fail(at)
      return edge
    })
    const incoming = array(f.incoming, '/incoming').map((e, i) => {
      const at = `/incoming/${i}`
      const edge = checkEdge(e, at)
      const target = byId.get(endpointNode(edge.to, edge.kind))
      if (byId.has(endpointNode(edge.from, edge.kind)) || !target || seen.has(edgeKey(edge))) fail(at)
      seen.add(edgeKey(edge))
      checkEndpoint(edge, target, 'to', at)
      return edge
    })
    // Cycles are not admitted even if the fragment has otherwise valid endpoints.
    const visiting = new Set<string>()
    const done = new Set<string>()
    const visit = (id: string): void => {
      if (visiting.has(id)) fail('/edges')
      if (done.has(id)) return
      visiting.add(id)
      for (const edge of edges) if (edge.kind === 'data' && endpointNode(edge.from, 'data') === id) visit(endpointNode(edge.to, 'data'))
      visiting.delete(id)
      done.add(id)
    }
    nodes.forEach(n => visit(n.id))
    validatePresentation(f.presentation, byId.keys(), [...edges, ...incoming], Object.keys(resources))
    return structuredClone(raw) as ClipboardFragment
  } catch (error) {
    if (error instanceof ClipboardError) throw error
    throw new ClipboardError('/')
  }
}
