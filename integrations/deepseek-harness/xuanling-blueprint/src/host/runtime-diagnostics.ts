/** Browser-safe wire and durable codec for Attempt facts. No prompt, tool args,
 * provider body or raw errors belong here. Legacy absence is projected, not
 * rewritten, as { status: 'unavailable' }. */
import { z } from 'zod'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'

export type AttemptDiagnostics = { status: 'unavailable' } | {
  status: 'available'
  input: { type: 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean'; bytes: number; sha256: string }
  resourceDigests: Record<string, string>
  modelSelection?: ModelSelection
  tools: { effectiveNames: string[]; denials?: Array<{ toolName: string; code: string }> }
  acceptance: { code: string; issueCount?: number }
  recovery?: { code: string }
}

/** One strict codec shared by host, remote DTO and recordsSchema. Strictness
 * is recursive: an unknown raw field must fail, never silently disappear. */
export function attemptDiagnosticsCodec(): z.ZodType<AttemptDiagnostics> {
  // Code vocabulary belongs to the producer, not a new spelling constraint.
  const code = z.string().min(1)
  const digest = z.string().regex(/^[0-9a-f]{64}$/)
  return z.discriminatedUnion('status', [
    z.object({ status: z.literal('unavailable') }).strict(),
    z.object({
      status: z.literal('available'),
      input: z.object({
        type: z.enum(['null', 'array', 'object', 'string', 'number', 'boolean']),
        bytes: z.number().int().nonnegative(), sha256: digest,
      }).strict(),
      resourceDigests: z.record(z.string(), digest),
      modelSelection: z.object({
        provider: z.string(), model: z.string(),
        // Effort ids are adapter-owned branded strings, not a closed enum.
        reasoningEffort: z.custom<NonNullable<ModelSelection['reasoningEffort']>>(value => typeof value === 'string').optional(),
      }).strict().optional(),
      tools: z.object({
        effectiveNames: z.array(z.string()),
        denials: z.array(z.object({ toolName: z.string(), code }).strict()).optional(),
      }).strict(),
      acceptance: z.object({ code, issueCount: z.number().int().nonnegative().optional() }).strict(),
      recovery: z.object({ code }).strict().optional(),
    }).strict(),
  ]) as z.ZodType<AttemptDiagnostics>
}
