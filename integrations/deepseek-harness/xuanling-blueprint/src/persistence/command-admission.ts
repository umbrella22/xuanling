/**
 * Command admission (C-10/§8.3.3): command identity = scope + requestId;
 * replay with the same payload fingerprint returns the original run
 * (idempotent); a different payload under the same identity is a
 * COMMAND_CONFLICT. All admission happens under the single writer, so
 * read-then-put is serially consistent.
 */
import { randomUUID } from 'node:crypto'
import type { KvTableLike } from './domain.ts'
import type { CommandRecord } from './records.ts'

export class CommandConflictError extends Error {
  override readonly name = 'CommandConflictError'
  readonly code = 'COMMAND_CONFLICT'
  readonly commandKey: string
  readonly storedFingerprint: string
  readonly incomingFingerprint: string
  constructor(commandKey: string, storedFingerprint: string, incomingFingerprint: string) {
    super(`command ${commandKey} already admitted with a different payload`)
    this.commandKey = commandKey
    this.storedFingerprint = storedFingerprint
    this.incomingFingerprint = incomingFingerprint
  }
}

export class DurabilityFailureError extends Error {
  override readonly name = 'DurabilityFailureError'
  readonly code = 'DURABILITY_FAILED'
  readonly operation: string
  constructor(operation: string, _cause: unknown) {
    super(`durable write failed during ${operation}`)
    this.operation = operation
  }
}

export interface AdmissionRequest {
  scope: string
  requestId: string
  payloadFingerprint: string
}

export interface AdmissionResult {
  commandKey: string
  runId: string | null
  replayed: boolean
  record: CommandRecord
}

const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/

export class CommandAdmission {
  constructor(private readonly commands: KvTableLike<string, CommandRecord>) {}

  /** Per-record keys must stay path-safe on every backend (W0.3: json/sqlite
   * key rules); scope and requestId are validated, not sanitized. */
  static commandKey(scope: string, requestId: string): string {
    if (!KEY_PATTERN.test(scope) || !KEY_PATTERN.test(requestId)) {
      const error = new Error(`command identity must match ${KEY_PATTERN.source} (scope="${scope}", requestId="${requestId}")`)
      error.name = 'CommandIdentityInvalidError'
      ;(error as { code?: string }).code = 'COMMAND_IDENTITY_INVALID'
      throw error
    }
    return `${scope}--${requestId}`
  }

  async admit(request: AdmissionRequest): Promise<AdmissionResult> {
    const commandKey = CommandAdmission.commandKey(request.scope, request.requestId)
    let existing: CommandRecord | undefined
    try {
      existing = await this.commands.get(commandKey)
    } catch (cause) {
      throw new DurabilityFailureError(`command get ${commandKey}`, cause)
    }
    if (existing !== undefined) {
      if (existing.payloadFingerprint !== request.payloadFingerprint) {
        throw new CommandConflictError(commandKey, existing.payloadFingerprint, request.payloadFingerprint)
      }
      return { commandKey, runId: existing.runId, replayed: true, record: existing }
    }
    const record: CommandRecord = {
      commandKey,
      scope: request.scope,
      requestId: request.requestId,
      payloadFingerprint: request.payloadFingerprint,
      runId: null,
      createdAt: Date.now()
    }
    try {
      await this.commands.put(commandKey, record)
    } catch (cause) {
      throw new DurabilityFailureError(`command put ${commandKey}`, cause)
    }
    return { commandKey, runId: null, replayed: false, record }
  }

  /** Bind the admitted command to its run (single writer; called once). */
  async bindRun(commandKey: string, runId: string): Promise<void> {
    try {
      await this.commands.update(commandKey, value => {
        if (value === undefined) throw new Error(`command ${commandKey} vanished before bind`)
        if (value.runId !== null && value.runId !== runId) {
          throw new Error(`command ${commandKey} already bound to ${value.runId}`)
        }
        return { ...value, runId }
      })
    } catch (cause) {
      if (cause instanceof Error && String(cause.message).includes('already bound')) {
        throw new CommandConflictError(commandKey, 'bound', runId)
      }
      throw new DurabilityFailureError(`command bind ${commandKey}`, cause)
    }
  }
}

export function newRunId(): string {
  return `run-${randomUUID()}`
}
