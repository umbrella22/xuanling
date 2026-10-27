/**
 * Resource context (C-03). Skill/preset resolution must use the same Workspace
 * and Host scope as the catalog, preflight, freeze and execution that read it.
 * A raw `process.cwd()` is never a resource context.
 */
import type { Context } from '@deepseek-ai/cordis'
import { isAbsolute, resolve } from 'node:path'
import type { LibraryRef } from '../definition/library-ref.ts'

export interface ResourceContext {
  /** Physical workspace root, only when it came from the Host. */
  readonly cwd: string | null
  /** DSH scope key of a live agent, or a preset scope lease. */
  readonly scope: object | null
  readonly workspaceId: string | null
}

type HostContext = Context & {
  get(service: string): unknown
}
type HostAgent = { session?: { header?: { cwd?: string } } }

function hostAgent(ctx: Context, sessionId: string): HostAgent | undefined {
  try {
    const registry = (ctx as HostContext).get('agents') as { get?(id: string): HostAgent | undefined } | undefined
    return registry?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/** Live agent scope for one session. Returns undefined for cold sessions: the
 * global skill layer is still readable, but no cross-session scope is borrowed. */
export function scopeForSession(ctx: Context, sessionId: string | undefined): object | undefined {
  return sessionId === undefined ? undefined : hostAgent(ctx, sessionId)
}

export function resourceContextFor(
  ctx: Context,
  args: { library?: LibraryRef; workspaceId?: string; sessionId?: string; workspaceRoot?: string }
): ResourceContext {
  if (args.library?.kind === 'global' && args.workspaceId === undefined) return { cwd: null, scope: null, workspaceId: null }
  let workspaceId = args.workspaceId ?? (args.library?.kind === 'workspace' ? args.library.workspaceId : undefined)
  let cwd =
    args.workspaceRoot !== undefined && isAbsolute(args.workspaceRoot)
      ? resolve(args.workspaceRoot)
      : workspaceId === undefined
        ? null
        : workspacePath(ctx, workspaceId)
  let scope: object | null = null
  if (args.sessionId !== undefined) {
    try {
      const registry = (ctx as HostContext).get('agents') as { get?(id: string): { session?: { header?: { cwd?: string } } } | undefined } | undefined
      const agent = registry?.get?.(args.sessionId)
      if (agent !== undefined) {
        // A live agent is its own DSH scope key; the same value is used by
        // `skills.list({ scope })` and preset service selection.
        scope = agent as object
        const headerCwd = agent.session?.header?.cwd
        if (cwd === null && typeof headerCwd === 'string' && isAbsolute(headerCwd)) cwd = resolve(headerCwd)
      }
    } catch {
      /* missing or unreadable agent keeps the global layer */
    }
  }
  return { cwd, scope, workspaceId: workspaceId ?? null }
}

function workspacePath(ctx: Context, workspaceId: string): string | null {
  try {
    const registry = (ctx as HostContext).get('workspaceRegistry') as { list?(): unknown } | undefined
    const values = registry?.list?.()
    if (!Array.isArray(values)) return null
    for (const value of values) {
      if (value === null || typeof value !== 'object') continue
      const row = value as { id?: unknown; path?: unknown }
      if (typeof row.id !== 'string' || row.id !== workspaceId) continue
      if (typeof row.path === 'string' && isAbsolute(row.path)) return resolve(row.path)
    }
  } catch {
    /* missing registry keeps the global layer */
  }
  return null
}

/** Public DSH observation lease; this loads no Agent and dispatches no turn.
 * Standalone authoring uses the selected/default preset's resource scope. */
export async function withResourceScope<T>(
  ctx: { get(service: string): unknown },
  scope: object | undefined,
  read: (scope: object | undefined) => Promise<T>
): Promise<T> {
  if (scope !== undefined) return await read(scope)
  const presets = ctx.get('agentPresets') as { acquireScope?(): Promise<{ key: object; [Symbol.asyncDispose](): Promise<void> }> } | undefined
  if (typeof presets?.acquireScope !== 'function') return await read(undefined)
  const lease = await presets.acquireScope()
  try {
    return await read(lease.key)
  } finally {
    await lease[Symbol.asyncDispose]()
  }
}
