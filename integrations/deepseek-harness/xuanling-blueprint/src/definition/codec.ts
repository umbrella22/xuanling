/**
 * Strict definition codec (C-02): JSON → BlueprintDefinition with unknown
 * behavioral fields rejected and located by JSON Pointer. The `metadata`
 * area is the only extension surface. Presentation is accepted but never
 * part of the semantic revision.
 */
import { createRequire } from 'node:module'
import {
  DefinitionInvalidError,
  SCHEMA_VERSION,
  type BlueprintDefinition,
  type GraphEdge,
  type GraphNode,
  type Presentation,
  type ResourceRef,
  type ValidationIssue,
} from './types.ts'

const require = createRequire(import.meta.url)
// zod resolves from the host installation at runtime; devDependency in tests.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { z } = require('zod') as typeof import('zod')
const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const pathPattern = /^(?!\/)[A-Za-z0-9._\-/]+[A-Za-z0-9._-]$/
const rootIdPattern = /^[a-z][a-z0-9_-]*$/

const resourceRefSchema = z.object({
  kind: z.enum(['agent', 'prompt', 'skill', 'schema', 'script', 'mcp', 'subflow']),
  path: z.string().optional(),
  source: z.object({
    kind: z.literal('shared'),
    rootId: z.string().regex(rootIdPattern),
    path: z.string().min(1),
  }).optional(),
  bindingId: z.string().regex(idPattern).optional(),
}).strict()

// Native Team requiredText checks trimmed length. Validate that boundary while
// preserving authored definition text; identity and semantic bytes are not trimmed.
const teamText = (maxLength: number) => z.string().refine(value => {
  const length = value.trim().length
  return length > 0 && length <= maxLength
}, { message: `Team text must be nonblank and at most ${maxLength} characters after trimming` })
const teamStageSchema = z.object({
  // DSH task-board subject/description limits, separate from roster description.
  task: z.object({ subject: teamText(200), description: teamText(16_384) }).strict(),
  members: z.array(z.object({
    // Native roster memberName: lower-kebab-case, max64, excluding the Lead row.
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(64).refine(value => value !== 'lead'),
    description: teamText(200), agentRef: z.string().regex(idPattern), context: z.enum(['fresh', 'fork']),
  }).strict()).min(1),
  requiredChecks: z.array(z.string().refine(value => value.trim().length > 0, { message: 'required check must be nonblank' })).min(1),
}).strict()

const nodeSchema = z.object({
  id: z.string().regex(idPattern),
  kind: z.enum(['input', 'output', 'agentTask', 'toolCall', 'scriptCall', 'condition', 'join', 'humanDecision', 'subflow', 'iteration']),
  outputs: z.record(z.string(), z.string().min(1)).optional(),
  inputs: z.record(z.string(), z.string().min(1)).optional(),
  agentRef: z.string().regex(idPattern).optional(),
  skillRefs: z.array(z.string().regex(idPattern)).optional(),
  toolsetRefs: z.array(z.string().regex(idPattern)).optional(),
  toolAllowlist: z.array(z.string().min(1)).optional(),
  condition: z.object({
    inputPort: z.string().min(1), trueBranch: z.string().regex(idPattern), falseBranch: z.string().regex(idPattern),
  }).strict().optional(),
  outputSchemaRef: z.string().regex(idPattern).optional(),
  teamStage: teamStageSchema.optional(),
  join: z.enum(['all', 'any']).optional(),
  branches: z.array(z.string().regex(idPattern)).optional(),
  budget: z.object({
    maxIterations: z.number().int().positive().max(1000),
    maxDurationMs: z.number().int().positive().max(600_000),
  }).optional(),
  subflowRef: z.string().regex(idPattern).optional(),
}).strict()

const edgeSchema = z.object({
  kind: z.enum(['data', 'control']),
  from: z.string().min(1),
  to: z.string().min(1),
}).strict()

const presentationSchema = z.object({
  nodes: z.record(z.string(), z.object({
    x: z.number().finite(), y: z.number().finite(),
    title: z.string().optional(),
    collapsed: z.boolean().optional(), pinned: z.boolean().optional(),
    width: z.number().finite().positive().optional(), height: z.number().finite().positive().optional(),
    color: z.enum(['default', 'blue', 'green', 'amber', 'red', 'purple']).optional(),
  }).strict()),
  groups: z.array(z.object({
    id: z.string().regex(idPattern),
    label: z.string().optional(),
    nodeIds: z.array(z.string().regex(idPattern)),
  }).strict()).optional(),
  edges: z.array(edgeSchema.extend({
    points: z.array(z.object({ x: z.number().finite(), y: z.number().finite() }).strict()),
  }).strict()).optional(),
}).strict()

const definitionSchema = z.object({
  schemaVersion: z.number().int(),
  id: z.string().regex(idPattern),
  name: z.string().min(1),
  resources: z.record(z.string().regex(idPattern), resourceRefSchema),
  graph: z.object({ nodes: z.array(nodeSchema), edges: z.array(edgeSchema) }).strict(),
  presentation: presentationSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict()

interface ZodIssueLike {
  path?: PropertyKey[]
  message: string
  code?: string
}

function pointerOf(path: PropertyKey[]): string {
  if (path.length === 0) return '/'
  return '/' + path.map(segment => String(segment).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
}

function decodeWithPointers(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const position = message.match(/position (\d+)/)
    const near = position !== null && position[1] !== undefined
      ? text.slice(Math.max(0, Number(position[1]) - 20), Number(position[1]) + 20)
      : ''
    throw new DefinitionInvalidError([{ code: 'invalid-json', message: `${message}${near ? ` near: ${JSON.stringify(near)}` : ''}` }])
  }
}

function zodIssuesToValidationIssues(error: { issues: readonly ZodIssueLike[] }): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      // One located issue per offending key: `keys` is the strict-object's
      // unknown field list; the issue path itself stops at the object.
      const keys = (issue as { keys?: PropertyKey[] }).keys ?? []
      const base = pointerOf(issue.path ?? [])
      for (const key of keys) {
        issues.push({ code: 'unknown-field', message: `unknown field "${String(key)}"`, pointer: `${base === '/' ? '' : base}/${String(key)}` })
      }
      if (keys.length === 0) {
        issues.push({ code: 'unknown-field', message: issue.message, pointer: base })
      }
      continue
    }
    issues.push({ code: 'invalid-value', message: issue.message, pointer: pointerOf(issue.path ?? []) })
  }
  return issues
}

/** Decode and shape-check a definition document. Semantic graph checks live
 * in ./validator.ts; this layer rejects malformed shapes and unknown fields. */
export function decodeDefinition(text: string): BlueprintDefinition {
  const raw = decodeWithPointers(text)
  const parsed = definitionSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DefinitionInvalidError(zodIssuesToValidationIssues(parsed.error))
  }
  const candidate = parsed.data as BlueprintDefinition
  if (candidate.schemaVersion !== SCHEMA_VERSION) {
    throw new DefinitionInvalidError([{
      code: 'schema-version',
      message: `unsupported schemaVersion ${candidate.schemaVersion}; this build understands ${SCHEMA_VERSION} only (fail closed)`,
      pointer: '/schemaVersion',
    }])
  }
  return candidate
}

export { idPattern, pathPattern, resourceRefSchema, nodeSchema, edgeSchema, presentationSchema }
export type { GraphEdge, GraphNode, Presentation, ResourceRef }
