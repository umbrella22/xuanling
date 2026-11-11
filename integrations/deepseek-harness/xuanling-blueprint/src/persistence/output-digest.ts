/** Digest of the public output payload derived from the authoritative outcome.
 * Mirrors conversation/run-projection.ts's `outputJson` exactly, so a durable
 * digest can be verified against the readable string without storing raw output
 * twice. Bytes and sha256 only: no prompt, provider body or error text. */
import { createHash } from 'node:crypto'
import type { JsonDigest } from '../host/runtime-diagnostics.ts'

function jsonType(value: unknown): JsonDigest['type'] {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

/** Same shape and key order as the inspect projection: outputs first, then
 * value. Returns undefined when the outcome carries neither own field. */
export function outputPayload(outcome: unknown): unknown {
  if (outcome === null || typeof outcome !== 'object' || Array.isArray(outcome)) return undefined
  const value = outcome as { outputs?: unknown; value?: unknown }
  const hasOutputs = Object.hasOwn(value, 'outputs')
  const hasValue = Object.hasOwn(value, 'value')
  if (!hasOutputs && !hasValue) return undefined
  return {
    ...(hasOutputs ? { outputs: value.outputs } : {}),
    ...(hasValue ? { value: value.value } : {})
  }
}

export function digestJson(value: unknown): JsonDigest | undefined {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    // A non-serializable outcome must not turn settlement into a new failure.
    return undefined
  }
  if (json === undefined) return undefined
  return {
    type: jsonType(value),
    bytes: Buffer.byteLength(json),
    sha256: createHash('sha256').update(json).digest('hex')
  }
}
