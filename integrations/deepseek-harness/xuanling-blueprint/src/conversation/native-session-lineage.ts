/** Native one-shot navigation facts for sourced Attempts. The blueprint
 * retains its factory, scoped composition and plugin-owned lifecycle. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentSetupCommit } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { SUBAGENT_DESCRIPTOR_VERSION, type OneShotSubagentDescriptorData } from '@deepseek-ai/dsh-subagent'
import type { RunSource } from './contracts.ts'

type LineageHost = Pick<Context, 'get'>
/** A live capability captured at admission, never stored or exposed on wire. */
export interface NativeSourceParent {
  readonly agent: Agent
  readonly session: Session
}

export class NativeSessionLineageError extends Error {
  readonly code = 'BLUEPRINT_NATIVE_LINEAGE_UNAVAILABLE'
  constructor() {
    super('blueprint native session lineage unavailable')
  }
}

export function assertNativeSourceParent(ctx: LineageHost, parent: NativeSourceParent, sessionId: string): void {
  const live = ctx.get('agents')?.get(SessionId(sessionId))
  const sessions = ctx.get('sessions')
  if (
    live !== parent.agent ||
    live?.session !== parent.session ||
    parent.session.id !== sessionId ||
    parent.session.header.origin === 'subagent' ||
    (sessions !== undefined && sessions.get(parent.session.id) !== parent.session)
  ) {
    throw new NativeSessionLineageError()
  }
}

export function captureNativeSourceParent(ctx: LineageHost, sessionId: string): NativeSourceParent {
  const agent = ctx.get('agents')?.get(SessionId(sessionId))
  if (agent === undefined) throw new NativeSessionLineageError()
  const parent = { agent, session: agent.session }
  assertNativeSourceParent(ctx, parent, sessionId)
  return parent
}

/** SessionStore owns the scope carrier and the awaited durability checkpoint.
 * Memory-only custom factories remain supported; a mounted persistence service
 * may never silently lose its flush participant. */
async function flushNativeSession(ctx: LineageHost, session: Session): Promise<void> {
  const sessions = ctx.get('sessions')
  const durable = ctx.get('sessionPersistence') !== undefined
  if (sessions === undefined) {
    if (durable) throw new NativeSessionLineageError()
    return
  }
  const participated = await sessions.flush(session)
  if (durable && !participated) throw new NativeSessionLineageError()
}

export function nativeSessionLineage(ctx: LineageHost, source: RunSource, reservedId: string, admittedParent?: NativeSourceParent) {
  // Capture identifiers before asynchronous creation. RunRecord.source is the
  // canonical driver input; a same-id replacement is never a new authority.
  const parentSessionId = source.sessionId
  const parent = admittedParent ?? captureNativeSourceParent(ctx, parentSessionId)
  const assertParent = () => assertNativeSourceParent(ctx, parent, parentSessionId)
  assertParent()
  // The public one-shot descriptor disables generic continuation. The factory
  // stores setup appends before publication, as it does for native children.
  const descriptor: OneShotSubagentDescriptorData = {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: 'xuanling-blueprint'
  }
  return {
    parentSessionId: parent.session.id,
    setup(child: Agent): AgentSetupCommit {
      if (child.session.id !== reservedId || child.session.header.origin !== 'subagent' || child.session.header.parentSession !== parentSessionId) {
        throw new NativeSessionLineageError()
      }
      // Agent-created observers, including Team tool installation, must see a
      // non-Team child immediately; a later first-turn descriptor is too late.
      child.session.append('subagent/descriptor', descriptor)
      return { commit: assertParent }
    },
    async establishCatalog(child: Session, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted()
      assertParent()
      if (child.id !== reservedId || child.header.origin !== 'subagent' || child.header.parentSession !== parentSessionId) {
        throw new NativeSessionLineageError()
      }
      // Publication stores the header; its public checkpoint must settle
      // before catalog discovery and before any inbox/input dispatch.
      await flushNativeSession(ctx, child)
      signal.throwIfAborted()
      assertParent()
      // Exact public Session event augmentation exported by dsh-subagent.
      // The package's establishCatalogChild helper is private, so its native
      // version-0 append contract is implemented here without private imports.
      parent.session.append('subagent/catalog', {
        version: 0,
        childId: child.id,
        childCreatedAt: child.header.createdAt,
        mode: 'one-shot'
      })
      await flushNativeSession(ctx, parent.session)
      signal.throwIfAborted()
      assertParent()
    }
  }
}
