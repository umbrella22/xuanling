/**
 * Browser-safe ResourceRef validation shared by the authoring surface and the
 * host definition codec.  Keep this module free of Node loaders: the client
 * pack bundles zod, while the host codec may continue to use its own runtime
 * loading policy for the complete definition schema.
 */
import { z } from 'zod'

export const idPattern = /^[a-zA-Z][a-zA-Z0-9_-]*$/
export const pathPattern = /^(?!\/)[A-Za-z0-9._\-/]+[A-Za-z0-9._-]$/
const rootIdPattern = /^[a-z][a-z0-9_-]*$/

export const resourceRefSchema = z
  .object({
    kind: z.enum(['agent', 'prompt', 'skill', 'schema', 'script', 'mcp', 'subflow']),
    path: z.string().optional(),
    source: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('shared'),
            rootId: z.string().regex(rootIdPattern),
            path: z.string().min(1)
          })
          .strict(),
        z
          .object({
            kind: z.literal('host'),
            id: z.string().refine(value => value.trim().length > 0, {
              message: 'host resource id must be nonblank'
            })
          })
          .strict()
      ])
      .optional(),
    bindingId: z.string().regex(idPattern).optional(),
    format: z.enum(['agent-preset', 'mcp-definition']).optional()
  })
  .strict()

/** Resource-local semantic checks used by the browser dialog before a full
 * definition validation on the Host side. This mirrors the resource portion
 * of validator.ts and deliberately never reads package bytes or Host config. */
export function isValidResourceRef(value: unknown): boolean {
  const result = resourceRefSchema.safeParse(value)
  if (!result.success) return false
  const ref = result.data
  const host = ref.source?.kind === 'host'
  if (ref.format === 'agent-preset' && ref.kind !== 'agent') return false
  if (ref.format === 'mcp-definition' && ref.kind !== 'mcp') return false
  const portable = (path: string | undefined): boolean => typeof path === 'string' && pathPattern.test(path) && !path.split('/').includes('..')
  if (host) {
    if (ref.path !== undefined || ref.format !== undefined) return false
    if (ref.kind !== 'agent' && ref.kind !== 'skill' && ref.kind !== 'mcp') return false
    if (ref.kind !== 'mcp' && ref.bindingId !== undefined) return false
    if (ref.kind === 'agent' || ref.kind === 'skill') return true
  }
  if (ref.kind === 'mcp') {
    if (!ref.bindingId) return false
    if (ref.format === 'mcp-definition') return portable(ref.path) && ref.source === undefined
    if (ref.path !== undefined || (ref.source !== undefined && ref.source.kind !== 'host')) return false
    return true
  }
  if (ref.kind === 'skill') {
    if (host) return true
    if (ref.source?.kind === 'shared') return ref.path === undefined
    return portable(ref.path)
  }
  if (ref.source !== undefined) return false
  return portable(ref.path)
}
