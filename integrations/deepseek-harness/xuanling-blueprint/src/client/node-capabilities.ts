/** Display capabilities only. Host preflight/executors remain admission authority. */
export interface NodeDisplayCapabilities {
  readonly palette: boolean
  readonly agentBindings: boolean
  readonly modelRoute: boolean
}
const structural: NodeDisplayCapabilities = Object.freeze({
  palette: true,
  agentBindings: false,
  modelRoute: false
})
const agent: NodeDisplayCapabilities = Object.freeze({
  palette: true,
  agentBindings: true,
  modelRoute: true
})
const unsupported: NodeDisplayCapabilities = Object.freeze({
  palette: false,
  agentBindings: false,
  modelRoute: false
})
const capabilities: Readonly<Record<string, NodeDisplayCapabilities>> = Object.freeze({
  input: structural,
  output: structural,
  condition: structural,
  join: structural,
  humanDecision: structural,
  agentTask: agent
})
export function nodeDisplayCapabilities(node: { kind: string; teamStage?: unknown }): NodeDisplayCapabilities {
  const capability = Object.hasOwn(capabilities, node.kind) ? capabilities[node.kind]! : unsupported
  return capability.modelRoute && node.teamStage !== undefined ? { ...capability, modelRoute: false } : capability
}
