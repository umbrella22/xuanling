/** Browser-safe template and preparation DTOs (C-08/C-09/C-10). */
import { z } from 'zod'
import { assetRefCodec } from '../definition/library-ref.ts'

export const TEMPLATE_SCHEMA_VERSION = 1 as const
export const PREPARATION_SCHEMA_VERSION = 1 as const

export const templateParameterCodec = () =>
  z.strictObject({
    key: z.string().min(1),
    label: z.string(),
    kind: z.enum(['string', 'path', 'command', 'resource']),
    required: z.boolean(),
    default: z.string().optional()
  })
export type TemplateParameter = z.infer<ReturnType<typeof templateParameterCodec>>

export const templateCodec = () =>
  z.strictObject({
    schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
    templateId: z.string().min(1),
    name: z.string(),
    parameters: z.array(templateParameterCodec()),
    requirements: z.strictObject({
      discovery: z.array(z.string()),
      roles: z.array(z.string()),
      resources: z.array(z.string()),
      acceptance: z.array(z.string())
    }),
    pattern: z.unknown(),
    // Optional only for templates saved before file closure was introduced.
    files: z.array(z.strictObject({ path: z.string().min(1), base64: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) })).optional(),
    provenance: z.strictObject({
      sourceAsset: assetRefCodec().nullable(),
      sourceRevision: z.string().nullable(),
      extractedAt: z.string(),
      residualNotes: z.array(z.string())
    })
  })
export type BlueprintTemplate = z.infer<ReturnType<typeof templateCodec>>

export const templateSummaryCodec = () =>
  z.strictObject({
    templateId: z.string().min(1),
    name: z.string(),
    parameters: z.number().int().nonnegative(),
    residualNotes: z.number().int().nonnegative(),
    updatedAt: z.string()
  })
export type TemplateSummary = z.infer<ReturnType<typeof templateSummaryCodec>>

export const preparationFactCodec = () =>
  z.strictObject({
    kind: z.enum(['manifest', 'readme', 'rule', 'source', 'ci', 'command', 'resource']),
    value: z.string(),
    sourcePath: z.string(),
    digest: z.string().min(1),
    status: z.enum(['observed', 'user_choice', 'derived', 'unknown'])
  })
export type PreparationFact = z.infer<ReturnType<typeof preparationFactCodec>>

export const preparationBindingCodec = () =>
  z.strictObject({
    key: z.string().min(1),
    value: z.string(),
    status: z.enum(['resolved', 'defaulted', 'missing'])
  })

export const preparationManifestCodec = () =>
  z.strictObject({
    schemaVersion: z.literal(PREPARATION_SCHEMA_VERSION),
    preparationId: z.string().min(1),
    target: z.strictObject({ workspaceId: z.string().min(1) }),
    templateId: z.string().min(1),
    facts: z.array(preparationFactCodec()),
    bindings: z.array(preparationBindingCodec()),
    unresolved: z.array(z.string()),
    generated: z.strictObject({ definitionDigest: z.string().min(1), instanceAsset: assetRefCodec() }).nullable(),
    status: z.enum(['draft', 'discovering', 'needs_input', 'ready', 'failed', 'cancelled']),
    revision: z.number().int().nonnegative()
  })
export type PreparationManifest = z.infer<ReturnType<typeof preparationManifestCodec>>

export const extractTemplateArgsCodec = () =>
  z.strictObject({
    blueprintId: z.string().min(1),
    documentRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    requestId: z.string().min(1),
    library: z
      .discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('global') }),
        z.strictObject({ kind: z.literal('workspace'), workspaceId: z.string().min(1) })
      ])
      .optional()
  })

export const extractTemplateValueCodec = () =>
  z.strictObject({
    template: templateCodec(),
    portable: z.boolean(),
    residual: z.array(z.string()),
    sourceDigest: z.string().min(1),
    templateDigest: z.string().min(1)
  })

export const saveTemplateArgsCodec = () =>
  z.strictObject({
    template: templateCodec(),
    requestId: z.string().min(1)
  })

export const instantiateTemplateArgsCodec = () =>
  z.strictObject({
    templateId: z.string().min(1),
    workspaceId: z.string().min(1),
    requestId: z.string().min(1),
    parameters: z.record(z.string(), z.string())
  })

export const instantiateTemplateValueCodec = () =>
  z.strictObject({
    status: z.enum(['needs_input', 'ready']),
    manifest: preparationManifestCodec(),
    instance: z.strictObject({ asset: assetRefCodec(), documentRevision: z.string().min(1), documentDigest: z.string().min(1) }).nullable()
  })
