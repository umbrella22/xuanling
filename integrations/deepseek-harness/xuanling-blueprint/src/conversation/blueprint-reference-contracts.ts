/** Read-only composition metadata. No resource bodies or package files cross this boundary. */
import { libraryRefCodec } from '../definition/library-ref.ts'
import { z } from 'zod'
import { frozenGraphCodec, frozenPresentationCodec } from './contracts.ts'
import type { BlueprintDefinition } from '../definition/types.ts'
import type {} from '@deepseek-ai/dsh-typert-protocol'
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'blueprint/reference-unavailable': { blueprintId: string }
    'blueprint/interface-ambiguous': { blueprintId: string }
  }
}

const revision = () => z.string().regex(/^[a-f0-9]{64}$/)
export const blueprintReferenceArgsCodec = () =>
  z.strictObject({
    library: libraryRefCodec().optional(),
    blueprintId: z.string().min(1),
    documentRevision: revision().optional(),
    ownerBlueprintId: z.string().min(1).optional()
  })
export const blueprintReferenceViewCodec = () =>
  z.strictObject({
    blueprintId: z.string().min(1),
    name: z.string(),
    documentRevision: revision(),
    currentRevision: revision(),
    revisions: z.array(z.strictObject({ documentRevision: revision(), createdAt: z.number() })),
    inputs: z.record(z.string(), z.string()),
    outputs: z.record(z.string(), z.string()),
    graph: frozenGraphCodec(),
    presentation: frozenPresentationCodec().optional()
  })
export type BlueprintReferenceArgs = z.infer<ReturnType<typeof blueprintReferenceArgsCodec>>
export type BlueprintReferenceView = z.infer<ReturnType<typeof blueprintReferenceViewCodec>>

export function projectDefinitionGraph(definition: BlueprintDefinition) {
  return frozenGraphCodec().parse({
    nodes: definition.graph.nodes.map(node => ({
      id: node.id,
      kind: node.kind,
      ...(node.blueprintRef === undefined ? {} : { blueprintRef: node.blueprintRef }),
      ...(node.interaction === undefined ? {} : { interaction: node.interaction }),
      ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
      ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
      ...(node.branches === undefined ? {} : { branches: node.branches })
    })),
    edges: definition.graph.edges
  })
}
