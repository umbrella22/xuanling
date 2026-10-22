/**
 * Blueprint definition vocabulary (plan §4.2 target format, C-02/C-10).
 *
 * The definition file is data, never code: JSON is strictly decoded, unknown
 * behavior fields are rejected with their JSON Pointer, and presentation is
 * separated from execution semantics. `schemaVersion` is the file-format
 * version — it has nothing to do with Skill versioning (C-04 keeps shared
 * skills unversioned).
 */

/** The editable workflow contract is intentionally destructive: v1 documents
 * are never decoded or migrated by the v2 runtime. */
export const SCHEMA_VERSION = 2

export type ResourceKind = 'agent' | 'prompt' | 'skill' | 'schema' | 'script' | 'mcp' | 'subflow'

export interface SharedSkillSource {
  kind: 'shared'
  rootId: string
  path: string
}

export interface PackageSource {
  kind: 'package'
  path: string
}

/** A resource owned by the active DSH host. `id` is a stable registry identity,
 * never a filesystem path or a serialized provider configuration. */
export interface HostResourceSource {
  kind: 'host'
  id: string
}

export type ResourceSource = SharedSkillSource | PackageSource | HostResourceSource

export interface ResourceRef {
  kind: ResourceKind
  /** Package-relative path for package resources (agents/prompts/schemas/scripts/subflows). */
  path?: string
  /** Shared skill origin or explicit DSH-owned agent/skill/MCP identity. */
  source?: ResourceSource
  /** MCP capability role; maps to host-configured server/tool scope. */
  bindingId?: string
  /** Structured portable artifact; absent retains ordinary resource behavior. */
  format?: 'agent-preset' | 'mcp-definition'
}

export type NodeKind = 'input' | 'output' | 'agentTask' | 'condition' | 'join' | 'humanDecision'

export interface PortType {
  /** Named wire type; structural typing applies at edge validation. */
  name: string
}

/** Explicit agentTask collaboration contract; execution requires a Team driver. */
export interface TeamStageConfig {
  task: { subject: string; description: string }
  members: Array<{ name: string; description: string; agentRef: string; context: 'fresh' | 'fork' }>
  requiredChecks: string[]
}

export interface GraphNode {
  id: string
  kind: NodeKind
  /** Declared output ports: port name → wire type. */
  outputs?: Record<string, string>
  /** Declared input ports: port name → wire type. */
  inputs?: Record<string, string>
  agentRef?: string
  skillRefs?: string[]
  toolsetRefs?: string[]
  /** Optional narrowing of the declared Host binding union. */
  toolAllowlist?: string[]
  /** Explicit per-node model route. Omitted means the host default is captured. */
  modelSelection?: ModelSelection
  outputSchemaRef?: string
  /** One native Team task and declared members; never inferred from metadata. */
  teamStage?: TeamStageConfig
  /** Join strategy for join nodes. The only executable policy is all. */
  join?: 'all'
  /** Condition branches for condition nodes. */
  branches?: string[]
  /** Boolean branch behavior; absent on old definitions (not runnable). */
  condition?: { inputPort: string; trueBranch: string; falseBranch: string }
}

/** Public, non-secret model route selected for one agent task. */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export type EdgeKind = 'data' | 'control'

export interface GraphEdge {
  kind: EdgeKind
  /** `nodeId.port` for data edges; `nodeId[@branch]` for control edges. */
  from: string
  to: string
}

export interface XY {
  x: number
  y: number
}

export type PresentationColor = 'default' | 'blue' | 'green' | 'amber' | 'red' | 'purple'

/** Saved display preferences only; graph declarations and execution remain canonical. */
export interface PresentationPorts {
  control?: boolean
  inputs?: boolean
  outputs?: boolean
}

export interface PresentationNode extends XY {
  ports?: PresentationPorts
  title?: string
  collapsed?: boolean
  pinned?: boolean
  width?: number
  height?: number
  color?: PresentationColor
}

/** Public display metadata for a resource reference. This is presentation
 * only: it never changes the executable ResourceRef or host-owned identity. */
export interface PresentationResourceMetadata {
  title?: string
  description?: string
}

export interface PresentationEdge extends GraphEdge {
  points: XY[]
}

export interface Presentation {
  nodes: Record<string, PresentationNode>
  resources?: Record<string, PresentationResourceMetadata>
  groups?: Array<{ id: string; label?: string; nodeIds: string[] }>
  edges?: PresentationEdge[]
}

export interface BlueprintDefinition {
  schemaVersion: number
  id: string
  name: string
  resources: Record<string, ResourceRef>
  graph: { nodes: GraphNode[]; edges: GraphEdge[] }
  presentation?: Presentation
  /** Explicitly reserved metadata area; never behavioral. */
  metadata?: Record<string, unknown>
}

export type ValidationIssueCode =
  | 'schema-version'
  | 'definition-unsupported-version'
  | 'unsupported-step-kind'
  | 'unknown-field'
  | 'invalid-json'
  | 'missing-field'
  | 'invalid-value'
  | 'duplicate-id'
  | 'dangling-ref'
  | 'port-mismatch'
  | 'edge-invalid'
  | 'cycle'
  | 'path-invalid'

export interface ValidationIssue {
  code: ValidationIssueCode
  message: string
  /** JSON Pointer (RFC 6901) into the definition document where applicable. */
  pointer?: string
}

export class DefinitionInvalidError extends Error {
  override readonly name = 'DefinitionInvalidError'
  readonly code = 'DEFINITION_INVALID'
  readonly issues: ValidationIssue[]
  constructor(issues: ValidationIssue[]) {
    super(`definition invalid: ${issues.map(i => `${i.code}${i.pointer ? ` at ${i.pointer}` : ''}: ${i.message}`).join('; ')}`)
    this.issues = issues
  }
}

export class RevisionConflictError extends Error {
  override readonly name = 'RevisionConflictError'
  readonly code = 'REVISION_CONFLICT'
  readonly expectedRevision: string | null
  readonly actualRevision: string
  constructor(expectedRevision: string | null, actualRevision: string) {
    super(`revision conflict: expected ${expectedRevision ?? '<none>'}, actual ${actualRevision}`)
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

export class IoWriteFailedError extends Error {
  override readonly name = 'IoWriteFailedError'
  readonly code = 'IO_WRITE_FAILED'
  readonly path: string
  constructor(path: string, cause: unknown) {
    super(`io write failed for ${path}: ${String(cause)}`)
    this.path = path
  }
}
