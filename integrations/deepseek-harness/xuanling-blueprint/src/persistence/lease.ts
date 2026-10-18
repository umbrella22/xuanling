/** Writer lease for one runtime or definition-library root.
 *
 * The file is the durable ownership fact. New payloads are written through a
 * same-directory temporary file and rename, while the owner token prevents a
 * stale WriterLease object from releasing or heartbeating a later owner. A
 * malformed legacy file is recoverable only when its embedded PID can still
 * be proven dead and its heartbeat is stale; otherwise acquisition fails with
 * a typed invalid-lease error instead of inventing an owner.
 */
import { basename, dirname, join } from 'node:path'
import {
  closeSync,
  existsSync,
  fsyncSync,
  futimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'

export interface LeasePayload {
  ownerId: string
  pid: number
  startedAt: number
  runtimeRoot: string
}

export interface LeaseOptions {
  /** Takeover only when the recorded heartbeat is older than this (ms) AND the recorded PID is dead. Default 30s. */
  takeoverThresholdMs?: number
  /** Heartbeat interval for `startHeartbeat()`. Default 10s. */
  heartbeatIntervalMs?: number
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
}

export class CoordinatorAlreadyActiveError extends Error {
  override readonly name = 'CoordinatorAlreadyActiveError'
  readonly code = 'COORDINATOR_ALREADY_ACTIVE'
  readonly owner: LeasePayload
  constructor(owner: LeasePayload) {
    super(`coordinator already active (owner pid ${owner.pid}, started ${owner.startedAt})`)
    this.owner = owner
  }
}

export class CoordinatorLeaseInvalidError extends Error {
  override readonly name = 'CoordinatorLeaseInvalidError'
  readonly code = 'COORDINATOR_LEASE_INVALID'
  readonly runtimeRoot: string
  readonly reason: string
  readonly pid?: number
  constructor(runtimeRoot: string, reason: string, pid?: number) {
    super(`coordinator lease is invalid (${reason})`)
    this.runtimeRoot = runtimeRoot
    this.reason = reason
    if (pid !== undefined) this.pid = pid
  }
}

export class CoordinatorLeaseLostError extends Error {
  override readonly name = 'CoordinatorLeaseLostError'
  readonly code = 'COORDINATOR_LEASE_LOST'
  readonly runtimeRoot: string
  constructor(runtimeRoot: string) {
    super('coordinator lease is no longer owned by this writer')
    this.runtimeRoot = runtimeRoot
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function validPayload(value: unknown): value is LeasePayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.ownerId === 'string' &&
    candidate.ownerId.length > 0 &&
    typeof candidate.pid === 'number' &&
    Number.isSafeInteger(candidate.pid) &&
    candidate.pid > 0 &&
    typeof candidate.startedAt === 'number' &&
    Number.isFinite(candidate.startedAt) &&
    typeof candidate.runtimeRoot === 'string' &&
    candidate.runtimeRoot.length > 0
  )
}

function extractPid(raw: string): number | undefined {
  const match = /["']pid["']\s*:\s*(-?\d+)/.exec(raw)
  if (!match) return undefined
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

function syncDirectory(path: string): void {
  try {
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Directory fsync is unsupported on some host filesystems (notably
    // Windows). The file fsync and atomic same-directory rename still hold.
  }
}

function writeAtomic(file: string, payload: LeasePayload): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${basename(file)}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(payload, null, 2))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, file)
    syncDirectory(directory)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function writeExclusive(file: string, payload: LeasePayload): void {
  const directory = dirname(file)
  mkdirSync(directory, { recursive: true })
  let fd: number | undefined
  try {
    fd = openSync(file, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(payload, null, 2))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    syncDirectory(directory)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

type ExistingLease = { kind: 'valid'; payload: LeasePayload; heartbeatAt: number } | { kind: 'malformed'; heartbeatAt: number; pid?: number }

function readExisting(file: string): ExistingLease {
  const heartbeatAt = statSync(file).mtimeMs
  const raw = readFileSync(file, 'utf8')
  try {
    const value: unknown = JSON.parse(raw)
    if (validPayload(value)) return { kind: 'valid', payload: value, heartbeatAt }
  } catch {
    // Fall through to the typed malformed-file path. A recoverable PID may
    // still be extracted from a partially written legacy payload.
  }
  const pid = extractPid(raw)
  return pid === undefined ? { kind: 'malformed', heartbeatAt } : { kind: 'malformed', heartbeatAt, pid }
}

function stale(existing: ExistingLease, now: number, threshold: number, alive: (pid: number) => boolean): boolean {
  const pid = existing.kind === 'valid' ? existing.payload.pid : existing.pid
  return pid !== undefined && !alive(pid) && now - existing.heartbeatAt > threshold
}

function acquireExisting(
  file: string,
  runtimeRoot: string,
  payload: LeasePayload,
  options: LeaseOptions,
  now: () => number,
  alive: (pid: number) => boolean,
  threshold: number
): WriterLease {
  let existing: ExistingLease
  try {
    existing = readExisting(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      writeExclusive(file, payload)
      return new WriterLease(runtimeRoot, payload, options)
    }
    throw error
  }
  if (existing.kind === 'valid') {
    if (stale(existing, now(), threshold, alive)) {
      writeAtomic(file, payload)
      return new WriterLease(runtimeRoot, payload, options)
    }
    throw new CoordinatorAlreadyActiveError(existing.payload)
  }
  if (stale(existing, now(), threshold, alive)) {
    writeAtomic(file, payload)
    return new WriterLease(runtimeRoot, payload, options)
  }
  throw new CoordinatorLeaseInvalidError(runtimeRoot, existing.pid === undefined ? 'malformed-owner' : 'owner-alive-or-heartbeat-fresh', existing.pid)
}

function readOwned(file: string, ownerId: string, runtimeRoot: string): number {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r+')
    const raw = readFileSync(fd, 'utf8')
    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new CoordinatorLeaseLostError(runtimeRoot)
    }
    if (!validPayload(payload) || payload.ownerId !== ownerId) throw new CoordinatorLeaseLostError(runtimeRoot)
    return fd
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    fd = undefined
    if (error instanceof CoordinatorLeaseLostError) throw error
    throw new CoordinatorLeaseLostError(runtimeRoot)
  }
}

export class WriterLease {
  private stopHeartbeatTimer: (() => void) | undefined

  constructor(
    readonly runtimeRoot: string,
    private readonly payload: LeasePayload,
    private readonly options: LeaseOptions
  ) {}

  static readonly LEASE_FILE = 'coordinator-lease.json'

  static acquire(runtimeRoot: string, options: LeaseOptions = {}): WriterLease {
    const file = join(runtimeRoot, WriterLease.LEASE_FILE)
    const now = options.now ?? Date.now
    const alive = options.isProcessAlive ?? pidAlive
    const threshold = options.takeoverThresholdMs ?? 30_000
    const payload: LeasePayload = { ownerId: randomUUID(), pid: process.pid, startedAt: now(), runtimeRoot }
    mkdirSync(runtimeRoot, { recursive: true })
    try {
      writeExclusive(file, payload)
      return new WriterLease(runtimeRoot, payload, options)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return acquireExisting(file, runtimeRoot, payload, options, now, alive, threshold)
    }
  }

  get ownerId(): string {
    return this.payload.ownerId
  }

  /** Refresh the lease mtime only while this exact owner token is present. */
  heartbeat(): void {
    const file = join(this.runtimeRoot, WriterLease.LEASE_FILE)
    let fd: number | undefined
    try {
      fd = readOwned(file, this.payload.ownerId, this.runtimeRoot)
      const now = this.options.now ?? Date.now
      const stamp = new Date(now())
      futimesSync(fd, stamp, stamp)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  startHeartbeat(): () => void {
    if (this.stopHeartbeatTimer !== undefined) return this.stopHeartbeatTimer
    const interval = this.options.heartbeatIntervalMs ?? 10_000
    let active = true
    let stop!: () => void
    const timer = setInterval(() => {
      if (!active) return
      try {
        this.heartbeat()
      } catch {
        // A lost lease must stop refreshing immediately. The next durable
        // operation observes the typed lease-lost error from its own check.
        stop()
      }
    }, interval)
    timer.unref?.()
    stop = () => {
      if (!active) return
      active = false
      clearInterval(timer)
      if (this.stopHeartbeatTimer === stop) this.stopHeartbeatTimer = undefined
    }
    this.stopHeartbeatTimer = stop
    return stop
  }

  /** Release only when the stored token still belongs to this owner. */
  release(): void {
    this.stopHeartbeatTimer?.()
    const file = join(this.runtimeRoot, WriterLease.LEASE_FILE)
    if (!existsSync(file)) return
    let fd: number | undefined
    try {
      fd = readOwned(file, this.payload.ownerId, this.runtimeRoot)
      closeSync(fd)
      fd = undefined
      rmSync(file)
    } catch (error) {
      if (error instanceof CoordinatorLeaseLostError) return
      throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}

/** Test/diagnostic helper: force-maintain a foreign-looking heartbeat. */
export function touchLease(runtimeRoot: string): void {
  const file = join(runtimeRoot, WriterLease.LEASE_FILE)
  const now = Date.now()
  utimesSync(file, new Date(now), new Date(now))
}
