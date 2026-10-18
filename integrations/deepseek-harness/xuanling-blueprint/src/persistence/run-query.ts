import type { RunRecord, RunState } from './records.ts'
import type { RunStore } from './run-store.ts'

export interface RunQueryArgs {
  sessionId?: string | undefined
  blueprintId?: string | undefined
  state?: RunState | undefined
  cursor?: string | undefined
  limit?: number | undefined
  includeArchived?: boolean | undefined
}

export interface RunHistorySummary {
  runId: string
  blueprintId?: string
  state: RunState
  createdAt: number
  updatedAt: number
  definitionRevision: string
  attemptCount: number
  archived: boolean
}

export interface RunQueryPage {
  runs: RunHistorySummary[]
  nextCursor?: string
}

export interface RunQueryPageWithRecords {
  page: RunQueryPage
  records: Array<{ record: RunRecord; archived: boolean }>
}

export class RunQueryError extends Error {
  override readonly name = 'RunQueryError'
  readonly code: 'INVALID_CURSOR' | 'INVALID_LIMIT' | 'SCOPE_REQUIRED'
  constructor(code: RunQueryError['code']) {
    super(code)
    this.code = code
  }
}

interface RunCursor {
  createdAt: number
  runId: string
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function encodeCursor(value: RunCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string | undefined): RunCursor | undefined {
  if (value === undefined) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as { createdAt?: unknown }).createdAt !== 'number' ||
      !Number.isSafeInteger((parsed as { createdAt: number }).createdAt) ||
      typeof (parsed as { runId?: unknown }).runId !== 'string' ||
      (parsed as { runId: string }).runId.length === 0 ||
      Object.keys(parsed).some(key => key !== 'createdAt' && key !== 'runId')
    )
      throw new Error('invalid cursor')
    return { createdAt: (parsed as { createdAt: number }).createdAt, runId: (parsed as { runId: string }).runId }
  } catch {
    throw new RunQueryError('INVALID_CURSOR')
  }
}

function validateArgs(args: RunQueryArgs): { cursor?: RunCursor; limit: number } {
  if (args.sessionId === undefined && args.blueprintId === undefined) throw new RunQueryError('SCOPE_REQUIRED')
  const limit = args.limit ?? DEFAULT_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new RunQueryError('INVALID_LIMIT')
  const cursor = decodeCursor(args.cursor)
  return cursor === undefined ? { limit } : { limit, cursor }
}

export function runBelongsToSession(record: RunRecord, sessionId: string): boolean {
  return (
    record.source?.sessionId === sessionId ||
    record.attempts.some(attempt => attempt.sessionId === sessionId) ||
    record.teamStage?.leadSessionId === sessionId ||
    record.teamStage?.members.some(member => member.sessionId === sessionId) === true
  )
}

export function runHistorySummary(record: RunRecord, archived: boolean): RunHistorySummary {
  return {
    runId: record.runId,
    ...(record.blueprintId === undefined ? {} : { blueprintId: record.blueprintId }),
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    definitionRevision: record.definitionRevision,
    attemptCount: record.attempts.length,
    archived
  }
}

function afterCursor(record: RunRecord, cursor: RunCursor | undefined): boolean {
  if (cursor === undefined) return true
  return record.createdAt < cursor.createdAt || (record.createdAt === cursor.createdAt && record.runId < cursor.runId)
}

function compareNewest(a: RunRecord, b: RunRecord): number {
  return b.createdAt - a.createdAt || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0)
}

export class RunQuery {
  constructor(private readonly store: RunStore) {}

  async pageWithRecords(args: RunQueryArgs): Promise<RunQueryPageWithRecords> {
    const { cursor, limit } = validateArgs(args)
    const records: Array<{ record: RunRecord; archived: boolean }> = []
    for (const runId of await this.store.listRunIds()) {
      const record = await this.store.get(runId)
      if (args.sessionId !== undefined && !runBelongsToSession(record, args.sessionId)) continue
      if (args.blueprintId !== undefined && record.blueprintId !== args.blueprintId) continue
      if (args.state !== undefined && record.state !== args.state) continue
      if (!afterCursor(record, cursor)) continue
      const archived = await this.store.isArchived(runId)
      if (archived && args.includeArchived !== true) continue
      records.push({ record, archived })
    }
    records.sort((a, b) => compareNewest(a.record, b.record))
    const selected = records.slice(0, limit)
    const runs = selected.map(({ record, archived }) => runHistorySummary(record, archived))
    const last = selected.at(-1)?.record
    return {
      page: {
        runs,
        ...(records.length > selected.length && last !== undefined ? { nextCursor: encodeCursor({ createdAt: last.createdAt, runId: last.runId }) } : {})
      },
      records: selected
    }
  }

  async page(args: RunQueryArgs): Promise<RunQueryPage> {
    return (await this.pageWithRecords(args)).page
  }
}
