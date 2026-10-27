/** Project writes share one physical coordination domain across all runtimes.
 * This is an advisory Blueprint fence, not an OS sandbox. An outstanding intent
 * survives a crash and cannot be stolen on a timer or a dead coordinator PID. */
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { WriterLease, CoordinatorAlreadyActiveError } from '../persistence/lease.ts'
import { assertStoragePath, fsyncDirectory, mkdirDurable } from '../persistence/durable-fs.ts'

export class WorkspaceWriteError extends Error {
  constructor(readonly code: 'workspace-write-busy' | 'workspace-conflict' | 'workspace-recovery-required' | 'workspace-observation-unavailable') {
    super(code)
  }
}
const QUEUES = Symbol.for('xuanling.blueprint.workspace-write.queues')
function queues(): Map<string, Promise<void>> {
  const global = globalThis as unknown as Record<symbol, Map<string, Promise<void>> | undefined>
  return (global[QUEUES] ??= new Map())
}

/** Hash the observed project sources, including untracked files. Generated and
 * dependency trees are deliberately outside the source preimage contract. */
function preimage(root: string): string {
  const hash = createHash('sha256')
  let count = 0
  const ignored = new Set(['.git', '.xuanling', 'node_modules', 'target', 'dist', 'build', '.cache', '.DS_Store'])
  const visit = (path: string): void => {
    for (const name of readdirSync(join(root, path)).sort()) {
      if (ignored.has(name)) continue
      if (++count > 100_000) throw new WorkspaceWriteError('workspace-observation-unavailable')
      const relative = path ? `${path}/${name}` : name
      const full = join(root, relative)
      const stat = lstatSync(full)
      hash.update(JSON.stringify([relative, stat.mode]))
      if (stat.isSymbolicLink()) hash.update(readlinkSync(full))
      else if (stat.isDirectory()) visit(relative)
      else if (stat.isFile()) hash.update(createHash('sha256').update(readFileSync(full)).digest())
      else throw new WorkspaceWriteError('workspace-observation-unavailable')
    }
  }
  try {
    visit('')
  } catch (error) {
    if (error instanceof WorkspaceWriteError) throw error
    throw new WorkspaceWriteError('workspace-observation-unavailable')
  }
  return hash.digest('hex')
}

export class WorkspaceWriteLease {
  private conflicted = false
  private toolsActive = 0
  private observed: string
  private finished = false
  private stopHeartbeat: () => void = () => {}
  private constructor(
    private readonly root: string,
    private readonly directory: string,
    private readonly lease: WriterLease,
    private readonly releaseQueue: () => void
  ) {
    this.observed = preimage(root)
  }

  static async acquire(root: string, owner: { runId: string; attemptId: string }, signal: AbortSignal): Promise<WorkspaceWriteLease> {
    const canonical = realpathSync(root)
    const previous = queues().get(canonical) ?? Promise.resolve()
    let release!: () => void
    const own = new Promise<void>(done => {
      release = done
    })
    const tail = previous.then(() => own)
    queues().set(canonical, tail)
    const releaseQueue = () => {
      release()
      void tail.then(() => {
        if (queues().get(canonical) === tail) queues().delete(canonical)
      })
    }
    let onAbort!: () => void
    const abort = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new Error('cancelled'))
    })
    signal.addEventListener('abort', onAbort, { once: true })
    let lease: WriterLease | undefined
    try {
      signal.throwIfAborted()
      await Promise.race([previous, abort])
      signal.throwIfAborted()
      const directory = join(canonical, '.xuanling', 'workspace-write')
      assertStoragePath(canonical, join(directory, WriterLease.LEASE_FILE))
      mkdirDurable(directory)
      try {
        lease = WriterLease.acquire(directory)
      } catch (error) {
        if (error instanceof CoordinatorAlreadyActiveError) throw new WorkspaceWriteError('workspace-write-busy')
        throw new WorkspaceWriteError('workspace-recovery-required')
      }
      const intent = join(directory, 'intent.json')
      assertStoragePath(canonical, intent)
      if (existsSync(intent)) throw new WorkspaceWriteError('workspace-recovery-required')
      const guard = new WorkspaceWriteLease(canonical, directory, lease, releaseQueue)
      const fd = openSync(intent, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ schemaVersion: 1, ...owner, pid: process.pid, observed: guard.observed }))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      fsyncDirectory(directory)
      guard.stopHeartbeat = lease.startHeartbeat()
      return guard
    } catch (error) {
      try {
        lease?.release()
      } finally {
        releaseQueue()
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  /** Only a human recovery action can attest effects that outlived the Host.
   * Hold the physical writer lease across Run reconciliation, then clear the
   * matching intent. If settlement fails/crashes, the fence remains. Replaying
   * the same operator resolution finishes cleanup after a partial commit. */
  static async reconcile<T>(
    root: string,
    owner: { runId: string; attemptIds: readonly string[] },
    confirmation: { quiescent: boolean; note: string },
    settle: () => Promise<T>
  ): Promise<T> {
    const canonical = realpathSync(root)
    const directory = join(canonical, '.xuanling', 'workspace-write')
    const intent = join(directory, 'intent.json')
    assertStoragePath(canonical, intent)
    if (!existsSync(intent)) return await settle()
    assertStoragePath(canonical, join(directory, WriterLease.LEASE_FILE))
    const lease = WriterLease.acquire(directory)
    const stop = lease.startHeartbeat()
    try {
      const prior = JSON.parse(readFileSync(intent, 'utf8')) as { schemaVersion: number; runId: string; attemptId: string }
      if (prior.schemaVersion !== 1 || typeof prior.runId !== 'string' || typeof prior.attemptId !== 'string')
        throw new WorkspaceWriteError('workspace-recovery-required')
      // A Run blocked by someone else's fence can be settled, but cannot clear it.
      if (prior.runId !== owner.runId) return await settle()
      if (!owner.attemptIds.includes(prior.attemptId) || !confirmation.quiescent || !confirmation.note.trim())
        throw new WorkspaceWriteError('workspace-recovery-required')
      const result = await settle()
      lease.assertOwned()
      const receipt = join(directory, `recovery-${createHash('sha256').update(JSON.stringify(prior)).digest('hex')}.json`)
      assertStoragePath(canonical, receipt)
      const temporary = `${receipt}.${randomUUID()}.tmp`
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(
          fd,
          JSON.stringify({
            owner: prior,
            actor: 'operator',
            quiescent: true,
            noteDigest: createHash('sha256').update(confirmation.note).digest('hex'),
            confirmedAt: Date.now()
          })
        )
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temporary, receipt)
      fsyncDirectory(directory)
      rmSync(intent)
      fsyncDirectory(directory)
      return result
    } finally {
      stop()
      lease.release()
    }
  }

  beforeTool(): string | undefined {
    try {
      this.lease.assertOwned()
      if (this.conflicted || this.toolsActive > 0 || preimage(this.root) !== this.observed) {
        this.conflicted = true
        return 'workspace-conflict'
      }
      this.toolsActive++
      return undefined
    } catch {
      this.conflicted = true
      return 'workspace-conflict'
    }
  }
  afterTool(): void {
    if (this.toolsActive === 0) return
    this.toolsActive--
    try {
      this.observed = preimage(this.root)
    } catch {
      this.conflicted = true
    }
  }
  get conflict(): boolean {
    return this.conflicted
  }

  /** Unknown effects keep intent.json after releasing the coordinator lease;
   * later owners must obtain explicit quiescence evidence before clearing it. */
  finish(quiescent: boolean): void {
    if (this.finished) return
    this.finished = true
    this.stopHeartbeat()
    try {
      this.lease.assertOwned()
      if (quiescent && this.toolsActive === 0) {
        rmSync(join(this.directory, 'intent.json'))
        fsyncDirectory(this.directory)
      }
    } finally {
      try {
        this.lease.release()
      } finally {
        this.releaseQueue()
      }
    }
  }
}

/** DSH concurrency-safe metadata is not proof of read-only effects. Without an
 * attested effect classifier, every business tool is a potential writer. */
export function needsWorkspaceWriteLease(effectiveNames: readonly string[]): boolean {
  return effectiveNames.some(name => name !== 'run_code' && name !== 'structured_output')
}
