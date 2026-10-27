/** Browser-safe association DTOs. Persistence lives in association-store.ts. */
import { z } from 'zod'
import { assetRefCodec } from '../definition/library-ref.ts'

export const ASSOCIATION_SCHEMA_VERSION = 1 as const
export const ASSOCIATION_STATUSES = ['saved', 'starting', 'running', 'settled', 'blocked', 'association-pending'] as const
export const ASSOCIATION_INTENTS = ['design', 'execute'] as const
export type AssociationStatus = (typeof ASSOCIATION_STATUSES)[number]
export type AssociationIntent = (typeof ASSOCIATION_INTENTS)[number]

export const associationViewCodec = () =>
  z.strictObject({
    associationId: z.string().min(1),
    sessionId: z.string().min(1),
    asset: assetRefCodec(),
    name: z.string(),
    documentRevision: z.string().min(1),
    intent: z.enum(ASSOCIATION_INTENTS),
    status: z.enum(ASSOCIATION_STATUSES),
    runId: z.string().min(1).nullable(),
    updatedAt: z.string().min(1)
  })
export type AssociationView = z.infer<ReturnType<typeof associationViewCodec>>

export const associateDefinitionArgsCodec = () =>
  z.strictObject({
    sessionId: z.string().min(1),
    asset: assetRefCodec(),
    documentRevision: z.string().min(1)
  })
export type AssociateDefinitionArgs = z.infer<ReturnType<typeof associateDefinitionArgsCodec>>
