/**
 * Blueprint client model (C-14/C-13, W6.1): projects durable facts into the
 * UI. Facts arrive as a snapshot + a monotonic sequence stream; a gap or a
 * reconnect marks the view stale and REQUIRES a snapshot re-fetch — the model
 * never invents terminal states, never treats a dropped stream as success,
 * and never re-issues a start command on reconnect. UI state is always
 * rebuildable: dropping the model loses nothing durable.
 */

import { attemptDiagnosticsCodec } from '../../../../../host/runtime-diagnostics.ts'
import type { AttemptDiagnostics } from '../../../../../host/runtime-diagnostics.ts'
import type { RunSource, TeamStageProjection } from '../../../../../conversation/contracts.ts'
export type { AttemptDiagnostics } from '../../../../../host/runtime-diagnostics.ts'

export interface RunAttemptView {
  nodeId: string
  attemptId?: string
  sessionId?: string
  state: string
  attempt: number
  evidence?: string
  resultKind?: string
  outputJson?: string
  errorCode?: string
  diagnostics?: AttemptDiagnostics
}

export interface RunSnapshotView {
  runId: string
  state: string
  seq: number
  definitionRevision: string
  source?: RunSource | undefined
  team?: TeamStageProjection | undefined
  attempts: RunAttemptView[]
  logTail: Array<{ seq: number; kind: string }>
}

export interface StreamEventView {
  seq: number
  kind: string
  detail: Record<string, unknown>
}

export type ConnectionState = 'connected' | 'stale' | 'reconnecting'

export interface SnapshotFetcher {
  inspectRun(runId: string): Promise<RunSnapshotView>
}

export class BlueprintClientModel {
  private snapshot: RunSnapshotView | null = null
  private lastSeq = -1
  private stale = false
  private resyncs = 0
  private epoch = 0
  private latestRead = 0
  private readonly listeners = new Set<() => void>()

  get connectionState(): ConnectionState {
    return this.stale ? 'stale' : 'connected'
  }

  get resyncCount(): number {
    return this.resyncs
  }

  get view(): RunSnapshotView | null {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }

  /** Stop pending read adoption without changing facts, sequence or notifications. */
  invalidatePendingObservations(): void {
    this.epoch += 1
    this.latestRead += 1
  }

  /** A new document/run binding invalidates in-flight reads as well as old facts. */
  reset(): void {
    this.epoch += 1
    this.snapshot = null
    this.lastSeq = -1
    this.stale = false
    this.emit()
  }

  /** Replace the view with an authoritative snapshot (initial load or gap
   * recovery). Always allowed; resets gap state. */
  applySnapshot(snapshot: RunSnapshotView): void {
    // Validate before changing any projection; unknown raw fields are not facts.
    const detached = structuredClone(snapshot)
    for (const attempt of detached.attempts)
      if (attempt.diagnostics !== undefined) {
        const parsed = attemptDiagnosticsCodec().safeParse(attempt.diagnostics)
        if (!parsed.success) throw new Error('blueprint/diagnostics-invalid')
        attempt.diagnostics = parsed.data
      }
    this.snapshot = detached
    this.lastSeq = snapshot.seq
    this.stale = false
    this.emit()
  }

  /** Apply one stream event. Duplicates (seq <= lastSeq) are ignored;
   * a jump (seq > lastSeq + 1) marks the view STALE — the caller must resync
   * from a snapshot before the view is trusted again. */
  applyEvent(event: StreamEventView): { accepted: boolean; gap: boolean } {
    if (this.snapshot === null) {
      this.stale = true
      this.emit()
      return { accepted: false, gap: true }
    }
    if (event.seq <= this.lastSeq) return { accepted: false, gap: false }
    if (event.seq !== this.lastSeq + 1) {
      this.stale = true
      this.emit()
      return { accepted: false, gap: true }
    }
    this.lastSeq = event.seq
    // Project the event onto the snapshot conservatively: unknown kinds bump
    // seq only — the UI keeps displaying the last known durable state.
    if (event.kind === 'state' && typeof event.detail.state === 'string') {
      this.snapshot = { ...this.snapshot, state: event.detail.state, seq: event.seq }
    } else {
      this.snapshot = { ...this.snapshot, seq: event.seq }
    }
    this.emit()
    return { accepted: true, gap: false }
  }

  /** Reconnect discovery: fetch a fresh snapshot and adopt it. Never replays
   * commands — a reconnect is a READ, not a re-submit. */
  async resync(fetcher: SnapshotFetcher, runId: string): Promise<RunSnapshotView> {
    this.resyncs += 1
    const epoch = this.epoch
    const read = ++this.latestRead
    try {
      const snapshot = await fetcher.inspectRun(runId)
      if (snapshot.runId !== runId) throw new Error('Unrelated inspect snapshot')
      if (epoch === this.epoch && read === this.latestRead) this.applySnapshot(snapshot)
      return snapshot
    } catch (error) {
      if (epoch === this.epoch && read === this.latestRead) this.markDisconnected()
      throw error
    }
  }

  /** A drop of the transport marks the view stale instead of freezing it as
   * truth (a disconnect is not a terminal outcome). */
  markDisconnected(): void {
    this.stale = true
    this.emit()
  }
}

/** Resource availability projection for the resource browser (C-13). */
export interface ResourceView {
  refId: string
  kind: string
  /** 'shared' | 'package' | 'mcp' */
  sourceKind: 'shared' | 'package' | 'mcp'
  sourceLabel: string
  /** Availability from the last observation; 'unknown' is never shown as ok. */
  availability: 'available' | 'unavailable' | 'unknown'
  /** Automatic-follow note for shared skills (no version buttons exist). */
  followsSharedSource: boolean
  detail?: string
}

export function projectResources(
  definition: {
    resources: Record<string, { kind: string; path?: string; source?: { kind: 'shared'; rootId: string; path: string }; bindingId?: string }>
  },
  observed?: Record<string, { availability: 'available' | 'unavailable'; detail?: string }>
): ResourceView[] {
  return Object.entries(definition.resources).map(([refId, ref]) => {
    if (ref.kind === 'mcp') {
      const seen = observed?.[refId]
      return {
        refId,
        kind: ref.kind,
        sourceKind: 'mcp' as const,
        sourceLabel: `binding:${ref.bindingId ?? '(none)'}`,
        availability: seen?.availability ?? 'unknown',
        followsSharedSource: false,
        ...(seen?.detail !== undefined ? { detail: seen.detail } : {})
      }
    }
    if (ref.source?.kind === 'shared') {
      const seen = observed?.[refId]
      return {
        refId,
        kind: ref.kind,
        sourceKind: 'shared' as const,
        sourceLabel: `${ref.source.rootId}/${ref.source.path}`,
        availability: seen?.availability ?? 'unknown',
        followsSharedSource: true,
        ...(seen?.detail !== undefined ? { detail: seen.detail } : {})
      }
    }
    const seen = observed?.[refId]
    return {
      refId,
      kind: ref.kind,
      sourceKind: 'package' as const,
      sourceLabel: ref.path ?? '(missing path)',
      availability: seen?.availability ?? 'unknown',
      followsSharedSource: false,
      ...(seen?.detail !== undefined ? { detail: seen.detail } : {})
    }
  })
}
