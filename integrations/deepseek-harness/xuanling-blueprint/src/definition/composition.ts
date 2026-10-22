import { decodeDefinition } from './codec.ts'
import { validateDefinition } from './validator.ts'
import type { BlueprintDefinition, BlueprintReference } from './types.ts'
import type { DefinitionPackage } from './persist.ts'

export class BlueprintCompositionError extends Error {
  constructor(
    readonly code: 'blueprint-revision-unavailable' | 'blueprint-interface-mismatch' | 'blueprint-interface-ambiguous' | 'blueprint-reference-cycle',
    readonly nodeId?: string
  ) {
    super(code)
  }
}

export interface BlueprintInterface {
  inputs: Record<string, string>
  outputs: Record<string, string>
}

/** Public ports are the named boundaries of the graph, independent of its Agents. */
export function blueprintInterface(definition: BlueprintDefinition): BlueprintInterface {
  const collect = (kind: 'input' | 'output', field: 'inputs' | 'outputs') => {
    const ports: Record<string, string> = {}
    for (const node of definition.graph.nodes.filter(node => node.kind === kind)) {
      for (const [name, type] of Object.entries(node[field] ?? {})) {
        if (Object.hasOwn(ports, name)) throw new BlueprintCompositionError('blueprint-interface-ambiguous', node.id)
        Object.defineProperty(ports, name, { value: type, enumerable: true, configurable: true, writable: true })
      }
    }
    return ports
  }
  return { inputs: collect('input', 'outputs'), outputs: collect('output', 'inputs') }
}

export const blueprintReferenceKey = (ref: BlueprintReference): string => JSON.stringify([ref.blueprintId, ref.documentRevision])
const samePorts = (a: Record<string, string> = {}, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && b[key] === value)

/** Exact revisions only. A blueprint cannot call itself through any historical revision. */
export function resolveBlueprintClosure(definition: BlueprintDefinition, load: (ref: BlueprintReference) => DefinitionPackage): Map<string, DefinitionPackage> {
  const closure = new Map<string, DefinitionPackage>()
  const walk = (current: BlueprintDefinition, ancestors: Set<string>) => {
    for (const node of current.graph.nodes.filter(node => node.kind === 'blueprintCall')) {
      const ref = node.blueprintRef!
      if (ancestors.has(ref.blueprintId)) throw new BlueprintCompositionError('blueprint-reference-cycle', node.id)
      const key = blueprintReferenceKey(ref)
      let snapshot = closure.get(key)
      if (snapshot === undefined) {
        try {
          snapshot = load(ref)
        } catch {
          throw new BlueprintCompositionError('blueprint-revision-unavailable', node.id)
        }
      }
      if (snapshot.document.blueprintId !== ref.blueprintId || snapshot.document.documentRevision !== ref.documentRevision)
        throw new BlueprintCompositionError('blueprint-revision-unavailable', node.id)
      const child = decodeDefinition(snapshot.document.definitionJson)
      validateDefinition(child)
      const ports = blueprintInterface(child)
      if (!samePorts(node.inputs, ports.inputs) || !samePorts(node.outputs, ports.outputs))
        throw new BlueprintCompositionError('blueprint-interface-mismatch', node.id)
      // Walk every path: a shared cached child may have different ancestors.
      walk(child, new Set([...ancestors, child.id]))
      closure.set(key, snapshot)
    }
  }
  walk(definition, new Set([definition.id]))
  return closure
}
