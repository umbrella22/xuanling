import type { GraphNode } from '../definition/types.ts'

/** Wire failures are producer-owned static codes, never a raw thrown message. */
type NodeValueErrorCode =
  | 'condition-input-invalid'
  | 'input-missing'
  | 'input-invalid'
  | 'binding-missing'
  | 'binding-unavailable'
  | 'binding-invalid'
  | 'binding-drift'
  | 'output-missing'
  | 'output-invalid'
export class NodeValueError extends Error {
  constructor(readonly code: NodeValueErrorCode) {
    super(code)
  }
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return typeof value === 'object' && Object.values(value).every(isJsonValue)
}
/** Built-ins retain strict runtime rules. Nonempty nominal labels are opaque:
 * the definition validator compares their exact names at edges; runtime only
 * checks the JSON envelope, not an invented domain shape. Undefined is not JSON. */
export function matchesWireType(value: unknown, type: string | undefined): boolean {
  if (type === 'json') return isJsonValue(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string' || type === 'boolean') return typeof value === type
  return typeof type === 'string' && type.length > 0 && isJsonValue(value)
}
function hasInputPort(input: unknown, port: string): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && Object.hasOwn(input, port)
}
export function validateNodeInputs(node: GraphNode, input: unknown, omitted: Set<string>): void {
  if (node.kind === 'condition') {
    const config = node.condition
    if (
      config === undefined ||
      node.inputs?.[config.inputPort] !== 'boolean' ||
      config.trueBranch === config.falseBranch ||
      !node.branches?.includes(config.trueBranch) ||
      !node.branches.includes(config.falseBranch) ||
      !hasInputPort(input, config.inputPort) ||
      typeof input[config.inputPort] !== 'boolean'
    )
      throw new NodeValueError('condition-input-invalid')
  }
  for (const [port, type] of Object.entries(node.inputs ?? {})) {
    if (node.kind === 'join' && omitted.has(port)) continue
    if (!hasInputPort(input, port)) throw new NodeValueError('input-missing')
    if (!matchesWireType(input[port], type)) throw new NodeValueError('input-invalid')
  }
}
export function structuralOutputs(node: GraphNode, input: unknown, omitted: Set<string>): Record<string, unknown> {
  const outputs: Record<string, unknown> = {}
  // A join may expose one explicitly named array output for the selected
  // input ports. This is the structural form used by fan-in workflows such as
  // the Rust review example: the input ports retain their individual types,
  // while the join publishes a deterministic declaration-ordered collection.
  const aggregate = Object.entries(node.inputs ?? {})
    .filter(([port]) => !omitted.has(port) && hasInputPort(input, port))
    .map(([port]) => (input as Record<string, unknown>)[port])
  for (const [port, type] of Object.entries(node.outputs ?? {})) {
    if (node.kind === 'join' && omitted.has(port)) continue
    if (node.kind === 'join' && !hasInputPort(input, port) && type !== 'array') throw new NodeValueError('output-missing')
    // Keep input/output pass-through: a matching named field wins; otherwise
    // the initial/bound JSON value is the output. An array join output is the
    // only intentional fan-in exception and collects selected input values.
    const value = hasInputPort(input, port) ? input[port] : type === 'array' && node.kind === 'join' ? aggregate : input
    if (!matchesWireType(value, type)) throw new NodeValueError('output-invalid')
    Object.defineProperty(outputs, port, { value, enumerable: true, writable: true, configurable: true })
  }
  return outputs
}
