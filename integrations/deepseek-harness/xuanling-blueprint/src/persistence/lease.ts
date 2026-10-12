/**
 * Writer lease (C-08, plan §8.3.1): one writer per runtime root. Acquisition
 * uses exclusive create; a second writer fails closed with
 * COORDINATOR_ALREADY_ACTIVE. Takeover of a stale lease requires positive
 * proof the previous owner exited (its recorded PID is no longer alive AND
 * the heartbeat is older than the takeover threshold) — a TTL alone or a
 * mere PID mismatch never grants takeover. The lease carries a random owner
 * token so a recycled PID cannot release or hijack someone else's lease.
 */
import { existsSync, openSync, readFileSync, closeSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export class CoordinatorAlreadyActiveError extends Error {
  override readonly name = 'CoordinatorAlreadyActiveError'
  readonly code = 'COORDINATOR_ALREADY_ACTIVE'
  readonly owner: LeasePayload
  constructor(owner: LeasePayload) {
    super(`coordinator already active (owner pid ${owner.pid}, started ${owner.startedAt})`)
    this.owner = owner
  }
}

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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export class WriterLease {
  private constructor(readonly runtimeRoot: string, private payload: LeasePayload, private readonly options: LeaseOptions) {}

  static readonly LEASE_FILE = 'coordinator-lease.json'

  static acquire(runtimeRoot: string, options: LeaseOptions = {}): WriterLease {
    const file = join(runtimeRoot, WriterLease.LEASE_FILE)
    const now = options.now ?? Date.now
    const alive = options.isProcessAlive ?? pidAlive
    const threshold = options.takeoverThresholdMs ?? 30_000
    const payload: LeasePayload = { ownerId: randomUUID(), pid: process.pid, startedAt: now(), runtimeRoot }

    if (existsSync(file)) {
      let existing: LeasePayload
      try {
        existing = JSON.parse(readFileSync(file, 'utf8')) as LeasePayload
      } catch {
        throw new CoordinatorAlreadyActiveError({
          ownerId: 'unreadable', pid: -1, startedAt: 0, runtimeRoot,
        })
      }
      const heartbeatAge = now() - (statSync(file).mtimeMs)
      const ownerDead = !alive(existing.pid)
      if (ownerDead && heartbeatAge > threshold) {
        // Proven takeover: the recorded process is gone and its heartbeat is
        // stale. Record the proof by rewriting the lease with our token.
        writeFileSync(file, JSON.stringify(payload, null, 2))
        return new WriterLease(runtimeRoot, payload, options)
      }
      throw new CoordinatorAlreadyActiveError(existing)
    }

    try {
      const fd = openSync(file, 'wx')
      writeFileSync(fd, JSON.stringify(payload, null, 2))
      closeSync(fd)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        // Lost a create race — re-read and classify.
        const reread = JSON.parse(readFileSync(file, 'utf8')) as LeasePayload
        throw new CoordinatorAlreadyActiveError(reread)
      }
      throw error
    }
    return new WriterLease(runtimeRoot, payload, options)
  }

  get ownerId(): string {
    return this.payload.ownerId
  }

  /** Refresh the lease mtime (liveness signal for stale detection). */
  heartbeat(): void {
    const file = join(this.runtimeRoot, WriterLease.LEASE_FILE)
    const now = this.options.now ?? Date.now
    utimesSync(file, new Date(now()), new Date(now()))
  }

  startHeartbeat(): () => void {
    const interval = this.options.heartbeatIntervalMs ?? 10_000
    const timer = setInterval(() => this.heartbeat(), interval)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /** Release only when the stored token still belongs to this owner. */
  release(): void {
    const file = join(this.runtimeRoot, WriterLease.LEASE_FILE)
    if (!existsSync(file)) return
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as LeasePayload
      if (stored.ownerId === this.payload.ownerId) rmSync(file)
    } catch {
      // Unreadable lease: leave it; a future takeover requires proof anyway.
    }
  }
}

/** Test/diagnostic helper: force-maintain a foreign-looking heartbeat. */
export function touchLease(runtimeRoot: string): void {
  const file = join(runtimeRoot, WriterLease.LEASE_FILE)
  const now = Date.now()
  utimesSync(file, new Date(now), new Date(now))
}
