/**
 * Durable conversation ↔ blueprint associations (C-04).
 *
 * A saved plan exists before any Run. The association is its own durable fact,
 * stored beside the profile data root, so refresh/restart can show it without
 * fabricating a Run or reading chat text.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { assetRefCodec, libraryKey, type AssetRef } from '../definition/library-ref.ts'
import { assertStoragePath, fsyncDirectory, mkdirDurable } from '../persistence/durable-fs.ts'
import {
  ASSOCIATION_INTENTS,
  ASSOCIATION_SCHEMA_VERSION,
  ASSOCIATION_STATUSES,
  associationViewCodec,
  type AssociationIntent,
  type AssociationStatus,
  type AssociationView
} from './association-contracts.ts'

export { ASSOCIATION_INTENTS, ASSOCIATION_SCHEMA_VERSION, ASSOCIATION_STATUSES, associationViewCodec }
export type { AssociationIntent, AssociationStatus, AssociationView }

export const associationCodec = () =>
  z.strictObject({
    schemaVersion: z.literal(ASSOCIATION_SCHEMA_VERSION),
    associationId: z.string().min(1),
    sessionId: z.string().min(1),
    asset: assetRefCodec(),
    name: z.string(),
    documentRevision: z.string().min(1),
    intent: z.enum(ASSOCIATION_INTENTS),
    status: z.enum(ASSOCIATION_STATUSES),
    runId: z.string().min(1).nullable(),
    requestId: z.string().min(1),
    updatedAt: z.string().min(1)
  })
export type ConversationAssociation = z.infer<ReturnType<typeof associationCodec>>

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function associationIdFor(sessionId: string, requestId: string): string {
  return `assoc-${createHash('sha256').update(`${sessionId}\u0000${requestId}`).digest('hex').slice(0, 32)}`
}

const sessionDirectory = (sessionId: string): string => createHash('sha256').update(sessionId).digest('hex').slice(0, 32)

export class ConversationAssociationStore {
  constructor(private readonly root: string | undefined) {}

  private directory(sessionId: string): string | undefined {
    return this.root === undefined ? undefined : join(this.root, sessionDirectory(sessionId))
  }

  list(sessionId: string): ConversationAssociation[] {
    const directory = this.directory(sessionId)
    if (directory === undefined) return []
    let entries: string[]
    try {
      assertStoragePath(this.root!, directory)
      if (!lstatSync(directory).isDirectory()) return []
      entries = readdirSync(directory).filter(name => name.endsWith('.json') && !name.startsWith('.'))
    } catch {
      return []
    }
    const values: ConversationAssociation[] = []
    for (const entry of entries) {
      try {
        assertStoragePath(this.root!, join(directory, entry))
        const parsed = associationCodec().safeParse(JSON.parse(readFileSync(join(directory, entry), 'utf8')))
        if (parsed.success && parsed.data.sessionId === sessionId && SAFE_ID.test(parsed.data.associationId)) values.push(parsed.data)
      } catch {
        /* unreadable associations are omitted; the canonical Run remains usable */
      }
    }
    return values.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  }

  get(sessionId: string, associationId: string): ConversationAssociation | undefined {
    return this.list(sessionId).find(value => value.associationId === associationId)
  }

  put(value: ConversationAssociation): ConversationAssociation {
    const parsed = associationCodec().parse(value)
    // The association id becomes a filename; a corrupt or forged record must
    // not escape the session directory on a later link/status write.
    if (!SAFE_ID.test(parsed.associationId)) throw new Error('association identity invalid')
    const directory = this.directory(parsed.sessionId)
    if (directory === undefined || this.root === undefined) throw new Error('association store unavailable')
    assertStoragePath(this.root, directory)
    mkdirDurable(directory)
    const target = join(directory, `${parsed.associationId}.json`)
    assertStoragePath(this.root, target)
    const temporary = join(directory, `.${parsed.associationId}.${randomUUID()}.tmp`)
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify(parsed))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, target)
      fsyncDirectory(directory)
    } finally {
      if (fd !== undefined) closeSync(fd)
      rmSync(temporary, { force: true })
    }
    return parsed
  }

  /** Attach an admitted Run to the matching saved plan. */
  link(sessionId: string, asset: AssetRef, documentRevision: string, runId: string, admittedAt?: number): ConversationAssociation | undefined {
    for (const association of this.list(sessionId)) {
      if (
        association.asset.blueprintId !== asset.blueprintId ||
        libraryKey(association.asset.library) !== libraryKey(asset.library) ||
        association.documentRevision !== documentRevision ||
        association.status === 'settled'
      )
        continue
      if (association.runId !== null || (admittedAt !== undefined && admittedAt < Date.parse(association.updatedAt))) continue
      return this.put({ ...association, runId, status: 'running', updatedAt: new Date().toISOString() })
    }
    return undefined
  }

  setStatus(sessionId: string, associationId: string, status: AssociationStatus): ConversationAssociation | undefined {
    const association = this.get(sessionId, associationId)
    return association === undefined ? undefined : this.put({ ...association, status, updatedAt: new Date().toISOString() })
  }
}

export function associationView(association: ConversationAssociation): AssociationView {
  return {
    associationId: association.associationId,
    sessionId: association.sessionId,
    asset: association.asset,
    name: association.name,
    documentRevision: association.documentRevision,
    intent: association.intent,
    status: association.status,
    runId: association.runId,
    updatedAt: association.updatedAt
  }
}
