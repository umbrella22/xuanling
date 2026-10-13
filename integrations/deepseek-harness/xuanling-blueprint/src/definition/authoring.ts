/** Model-authored packages use the same definition and resource contracts as
 * saved documents. Validation is pure: neither paths nor text are executed. */
import { z } from 'zod'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { decodeDefinition, definitionSchema, pathPattern } from './codec.ts'
import { validateDefinition } from './validator.ts'
import { DefinitionInvalidError, type BlueprintDefinition } from './types.ts'
import { admitResources, admitSnapshotPaths } from '../security/resource-admission.ts'

export const candidateCodec = z.strictObject({ definition: z.json(), files: z.array(z.strictObject({ path: z.string(), text: z.string() })) })
export type AuthoringCandidate = z.infer<typeof candidateCodec>
export interface AuthoringIssue { code: string; pointer: string }
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1')

export function validateCandidate(candidate: AuthoringCandidate): { ok: true; definition: BlueprintDefinition } | { ok: false; issues: AuthoringIssue[] } {
  let definition: BlueprintDefinition
  try { definition = decodeDefinition(JSON.stringify(candidate.definition)); validateDefinition(definition) }
  catch (error) {
    if (!(error instanceof DefinitionInvalidError)) throw error
    return { ok: false, issues: error.issues.map(issue => ({ code: issue.code, pointer: issue.pointer ?? '/' })) }
  }
  const issues: AuthoringIssue[] = []
  const files = new Map<string, string>(), folded = new Set<string>()
  candidate.files.forEach((file, index) => {
    const at = `/files/${index}/path`
    if (!pathPattern.test(file.path) || file.path.split('/').some(part => part === '.' || part === '..' || part === '')
      || file.path === 'blueprint.json' || file.path.startsWith('.library-state/') || admitSnapshotPaths([file.path]).length) {
      issues.push({ code: 'resource-path-invalid', pointer: at }); return
    }
    const foldedPath = file.path.normalize('NFC').toLowerCase()
    if (folded.has(foldedPath)) issues.push({ code: 'resource-file-conflict', pointer: at })
    folded.add(foldedPath)
    files.set(file.path, file.text)
  })
  const declared = new Set<string>(), skillDirectories: string[] = []
  const pending = [{ definition, prefix: '', at: '' }]
  // Subflow paths identify package directories. Each nested definition admits
  // its own declared resources; the containing directory is not a wildcard.
  for (const item of pending) {
    issues.push(...admitResources(item.definition.resources).map(issue => ({ code: issue.code, pointer: `${item.at}/resources/${pointer(issue.refId ?? '')}` })))
    for (const [id, ref] of Object.entries(item.definition.resources)) {
      if (!ref.path) continue
      const at = `${item.at}/resources/${pointer(id)}/path`
      const base = `${item.prefix}${ref.path}`
      const path = ref.kind === 'skill' ? `${base}/SKILL.md` : ref.kind === 'subflow' ? `${base}/blueprint.json` : base
      declared.add(path)
      if (ref.kind === 'skill') skillDirectories.push(`${base}/`)
      if (!files.has(path)) { issues.push({ code: 'resource-file-missing', pointer: at }); continue }
      if (ref.kind === 'schema') {
        try { assertObjectJsonSchema(JSON.parse(files.get(path)!)) }
        catch { issues.push({ code: 'output-schema-invalid', pointer: at }) }
      }
      if (ref.kind === 'subflow') {
        try {
          const child = decodeDefinition(files.get(path)!)
          validateDefinition(child)
          pending.push({ definition: child, prefix: `${base}/`, at: `/files/${candidate.files.findIndex(file => file.path === path)}/text` })
        } catch { issues.push({ code: 'subflow-invalid', pointer: at }) }
      }
    }
  }
  candidate.files.forEach((file, index) => {
    if (!declared.has(file.path) && !skillDirectories.some(dir => file.path.startsWith(dir))) issues.push({ code: 'resource-file-undeclared', pointer: `/files/${index}/path` })
  })
  return issues.length ? { ok: false, issues } : { ok: true, definition }
}

export function inputDescription(definition: BlueprintDefinition) {
  const sources = definition.graph.nodes.filter(node => !definition.graph.edges.some(edge => edge.kind === 'data' && edge.to.startsWith(`${node.id}.`)))
  return {
    sourceNodes: sources.map(node => ({ nodeId: node.id, kind: node.kind, inputs: node.inputs ?? {}, ...(node.kind === 'input' ? { outputs: node.outputs ?? {} } : {}) })),
    rule: 'Source nodes receive input unchanged. Input-node outputs use a matching named field, otherwise the entire input value. Every declared type is checked. The input never creates nodes or agents. Preflight checks known source values; downstream generated values are checked during execution.',
  }
}

export function authoringGuide() {
  return {
    schema: z.toJSONSchema(definitionSchema, { unrepresentable: 'any' }),
    workflow: ['blueprint_validate', 'blueprint_create', 'blueprint_preflight', 'blueprint_start', 'blueprint_inspect'],
    instructions: 'Create an explicit agentTask node for each agent. Files contain only declared package resources. Creation saves a graph; it does not run it. Use the returned ID/revision. Start accepts input as a JSON value, not a JSON-encoded string. Business tool permissions require declared toolsetRefs and an available Host binding. Never invent paths, model bindings, or revisions.',
    executableNodeKinds: ['input', 'output', 'agentTask', 'condition', 'join', 'humanDecision'],
    example: {
      definition: { schemaVersion: 1, id: 'draft', name: 'Agent task', resources: { worker: { kind: 'agent', path: 'lib/agents/worker.md' } },
        graph: { nodes: [{ id: 'worker', kind: 'agentTask', agentRef: 'worker', outputs: { text: 'string' } }, { id: 'result', kind: 'output', inputs: { text: 'string' } }],
          edges: [{ kind: 'data', from: 'worker.text', to: 'result.text' }] },
        presentation: { nodes: { worker: { x: 0, y: 0 }, result: { x: 320, y: 0 } } } },
      files: [{ path: 'lib/agents/worker.md', text: 'Complete the task described in the input. Return a concise textual answer.\n' }],
    },
    exampleInput: { task: 'Summarize the supplied text.', text: 'A short fixture.' },
  }
}
