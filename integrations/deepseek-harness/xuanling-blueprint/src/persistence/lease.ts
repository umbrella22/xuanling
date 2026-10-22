/** Writer lease for one runtime or definition-library root.
 *
 * The file is the durable ownership fact. New payloads are written through a
 * same-directory temporary file and rename, while the owner token prevents a
 * stale WriterLease object from releasing or heartbeating a later owner. A
 * malformed legacy file is recoverable only when its embedded PID can still
 * be proven dead and its heartbeat is stale; otherwise acquisition fails with
 * a typed invalid-lease error instead of inventing an owner.
 *
 * Takeover of a stale owner is serialized through an exclusive guard file and
 * re-validated under that guard, so two contenders can never both replace the
 * same stale owner. Ownership is also a fencing fact: durable writers call
 * `assertOwned()` before mutating state, and a heartbeat that observes a lost
 * lease reports it instead of silently stopping.
 */
import { basename, dirname, join } from 'node:path'
import {
  closeSync,
  existsSync,
  fsyncSync,
  futimesSync,
  linkSync,
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
  /** Takeover only when the recorded heartbeat is older than this (ms) AND the recorded owner is not provably alive. Default 30s. */
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
  } catch (error) {
    // EPERM proves the process exists; it merely belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Owner tokens currently held by this process. Shared through the global
 * symbol registry so duplicate module copies (source + packed artifact) in
 * one process agree on which leases are genuinely live here. */
const HELD_OWNERS = Symbol.for('xuanling.blueprint.writer-lease.owners')
function heldOwners(): Set<string> {
  const registry = globalThis as unknown as Record<symbol, Set<string> | undefined>
  return (registry[HELD_OWNERS] ??= new Set<string>())
}

/** A lease that names this process's PID but an owner token this process does
 * not hold was written by an earlier incarnation that received the same PID
 * (container restarts, PID reuse). This process is not proof that its owner is
 * alive, so only the heartbeat age decides whether it is stale. */
function ownerAlive(probe: (pid: number) => boolean, pid: number, ownerId?: string): boolean {
  if (pid === process.pid) return ownerId !== undefined && heldOwners().has(ownerId)
  return probe(pid)
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

/** Filesystems without hard links report one of these from link(). */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EINVAL'])

function writeExclusiveInPlace(file: string, payload: LeasePayload): void {
  let fd: number | undefined
  try {
    fd = openSync(file, 'wx', 0o600)
    writeFileSync(fd, JSON.stringify(payload, null, 2))
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Create the lease only when absent. The payload is written and fsynced in a
 * private temporary file first and then hard-linked into place, so the lease
 * appears with its complete owner payload or not at all: a crash can no longer
 * leave an empty lease that no later writer is allowed to take over. */
function writeExclusive(file: string, payload: LeasePayload): void {
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
    try {
      linkSync(temporary, file)
    } catch (error) {
      if (!LINK_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) throw error
      writeExclusiveInPlace(file, payload)
    }
    syncDirectory(directory)
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
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

type OwnerAlive = (pid: number, ownerId?: string) => boolean

function stale(existing: ExistingLease, now: number, threshold: number, alive: OwnerAlive): boolean {
  const pid = existing.kind === 'valid' ? existing.payload.pid : existing.pid
  const ownerId = existing.kind === 'valid' ? existing.payload.ownerId : undefined
  return pid !== undefined && !alive(pid, ownerId) && now - existing.heartbeatAt > threshold
}

function activeOwnerError(existing: ExistingLease, runtimeRoot: string): Error {
  if (existing.kind === 'valid') return new CoordinatorAlreadyActiveError(existing.payload)
  return new CoordinatorLeaseInvalidError(runtimeRoot, existing.pid === undefined ? 'malformed-owner' : 'owner-alive-or-heartbeat-fresh', existing.pid)
}

/** Suffix of the exclusive guard that serializes takeover of a stale owner. */
const TAKEOVER_GUARD_SUFFIX = '.takeover'

interface TakeoverClaim {
  guard: string
  token: string
}

/** Claim the takeover guard. A guard is held only for the few synchronous
 * filesystem operations of one takeover, so a guard older than the takeover
 * threshold was left by a writer that crashed mid-takeover; it is reclaimed
 * once. A fresh guard means another contender is replacing the stale owner
 * right now, and this contender must not race it. */
function claimTakeover(file: string, runtimeRoot: string, threshold: number): TakeoverClaim {
  const guard = `${file}${TAKEOVER_GUARD_SUFFIX}`
  const token = randomUUID()
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined
    try {
      fd = openSync(guard, 'wx', 0o600)
      writeFileSync(fd, token)
      return { guard, token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    let age: number
    try {
      age = Date.now() - statSync(guard).mtimeMs
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (attempt > 0 || age <= threshold) break
    rmSync(guard, { force: true })
  }
  throw new CoordinatorLeaseInvalidError(runtimeRoot, 'takeover-in-progress')
}

function releaseTakeover(claim: TakeoverClaim): void {
  try {
    if (readFileSync(claim.guard, 'utf8') === claim.token) rmSync(claim.guard, { force: true })
  } catch {
    // Already gone, or reclaimed by a later contender: nothing of ours remains.
  }
}

/** Prove the lease file now carries this payload's owner token. */
function verifyInstalled(file: string, payload: LeasePayload, runtimeRoot: string): void {
  closeSync(readOwned(file, payload.ownerId, runtimeRoot))
}

function acquireExisting(
  file: string,
  runtimeRoot: string,
  payload: LeasePayload,
  options: LeaseOptions,
  now: () => number,
  alive: OwnerAlive,
  threshold: number
): WriterLease {
  let existing: ExistingLease
  try {
    existing = readExisting(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      writeExclusive(file, payload)
      return WriterLease.installed(runtimeRoot, payload, options)
    }
    throw error
  }
  if (!stale(existing, now(), threshold, alive)) throw activeOwnerError(existing, runtimeRoot)
  const claim = claimTakeover(file, runtimeRoot, threshold)
  try {
    // Re-validate under the guard: a competing contender may have completed
    // its own takeover between the first read and this claim. Only an owner
    // that is still stale here may be replaced.
    let current: ExistingLease
    try {
      current = readExisting(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      writeExclusive(file, payload)
      verifyInstalled(file, payload, runtimeRoot)
      return WriterLease.installed(runtimeRoot, payload, options)
    }
    if (!stale(current, now(), threshold, alive)) throw activeOwnerError(current, runtimeRoot)
    writeAtomic(file, payload)
    verifyInstalled(file, payload, runtimeRoot)
    return WriterLease.installed(runtimeRoot, payload, options)
  } finally {
    releaseTakeover(claim)
  }
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
  private lost = false

  constructor(
    readonly runtimeRoot: string,
    private readonly payload: LeasePayload,
    private readonly options: LeaseOptions
  ) {}

  static readonly LEASE_FILE = 'coordinator-lease.json'

  /** Construct the in-memory owner for a payload that is now durably installed. */
  static installed(runtimeRoot: string, payload: LeasePayload, options: LeaseOptions): WriterLease {
    heldOwners().add(payload.ownerId)
    return new WriterLease(runtimeRoot, payload, options)
  }

  static acquire(runtimeRoot: string, options: LeaseOptions = {}): WriterLease {
    const file = join(runtimeRoot, WriterLease.LEASE_FILE)
    const now = options.now ?? Date.now
    const probe = options.isProcessAlive ?? pidAlive
    const alive: OwnerAlive = (pid, ownerId) => ownerAlive(probe, pid, ownerId)
    const threshold = options.takeoverThresholdMs ?? 30_000
    const payload: LeasePayload = { ownerId: randomUUID(), pid: process.pid, startedAt: now(), runtimeRoot }
    mkdirSync(runtimeRoot, { recursive: true })
    try {
      writeExclusive(file, payload)
      return WriterLease.installed(runtimeRoot, payload, options)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return acquireExisting(file, runtimeRoot, payload, options, now, alive, threshold)
    }
  }

  get ownerId(): string {
    return this.payload.ownerId
  }

  /** True once this owner has observed that the durable lease is no longer its own. */
  get isLost(): boolean {
    return this.lost
  }

  private markLost(): void {
    this.lost = true
    heldOwners().delete(this.payload.ownerId)
  }

  /** Fencing check for durable writers: throw the typed lease-lost error unless
   * the lease file still carries this exact owner token. Loss is sticky. */
  assertOwned(): void {
    if (this.lost) throw new CoordinatorLeaseLostError(this.runtimeRoot)
    const file = join(this.runtimeRoot, WriterLease.LEASE_FILE)
    try {
      closeSync(readOwned(file, this.payload.ownerId, this.runtimeRoot))
    } catch (error) {
      this.markLost()
      throw error
    }
  }

  /** Refresh the lease mtime only while this exact owner token is present. */
  heartbeat(): void {
    if (this.lost) throw new CoordinatorLeaseLostError(this.runtimeRoot)
    const file = join(this.runtimeRoot, WriterLease.LEASE_FILE)
    let fd: number | undefined
    try {
      fd = readOwned(file, this.payload.ownerId, this.runtimeRoot)
      const now = this.options.now ?? Date.now
      const stamp = new Date(now())
      futimesSync(fd, stamp, stamp)
    } catch (error) {
      this.markLost()
      throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }

  /** Refresh periodically. `onLost` runs once when a heartbeat observes that
   * ownership is gone, so the owner can stop scheduling instead of continuing
   * as a split-brain writer. */
  startHeartbeat(onLost?: (error: CoordinatorLeaseLostError) => void): () => void {
    if (this.stopHeartbeatTimer !== undefined) return this.stopHeartbeatTimer
    const interval = this.options.heartbeatIntervalMs ?? 10_000
    let active = true
    let stop!: () => void
    const timer = setInterval(() => {
      if (!active) return
      try {
        this.heartbeat()
      } catch (error) {
        // A lost lease must stop refreshing immediately and report the loss;
        // fenced durable writes reject with the same typed error.
        stop()
        onLost?.(error instanceof CoordinatorLeaseLostError ? error : new CoordinatorLeaseLostError(this.runtimeRoot))
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
    if (this.lost) return
    heldOwners().delete(this.payload.ownerId)
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
