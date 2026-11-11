/** Display flags and the closed required-capability vocabulary. Host preflight/executors remain admission authority. */
import { REQUIRED_CAPABILITIES } from '../../../../../definition/types.ts'
import type { RequiredCapability } from '../../../../../definition/types.ts'

export interface NodeDisplayCapabilities {
  readonly palette: boolean
  readonly agentBindings: boolean
  readonly requiredCapabilities: boolean
  readonly modelRoute: boolean
}
const structural: NodeDisplayCapabilities = Object.freeze({
  palette: true,
  agentBindings: false,
  requiredCapabilities: false,
  modelRoute: false
})
const agent: NodeDisplayCapabilities = Object.freeze({ ...structural, agentBindings: true, requiredCapabilities: true, modelRoute: true })
const unsupported: NodeDisplayCapabilities = Object.freeze({ ...structural, palette: false })
const capabilities: Readonly<Record<string, NodeDisplayCapabilities>> = Object.freeze({
  input: structural,
  output: structural,
  condition: structural,
  join: structural,
  humanDecision: structural,
  blueprintCall: structural,
  agentTask: agent
})
export function nodeDisplayCapabilities(node: { kind: string; teamStage?: unknown }): NodeDisplayCapabilities {
  const capability = Object.hasOwn(capabilities, node.kind) ? capabilities[node.kind]! : unsupported
  return capability.modelRoute && node.teamStage !== undefined ? { ...capability, modelRoute: false } : capability
}
/** Non-empty, duplicate-free capability declaration shared by clipboard and Inspector JSON validation. */
export function requiredCapabilityList(value: unknown): value is RequiredCapability[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    new Set(value).size === value.length &&
    value.every(item => (REQUIRED_CAPABILITIES as readonly unknown[]).includes(item))
  )
}
