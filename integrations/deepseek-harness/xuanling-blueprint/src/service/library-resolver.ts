/**
 * Host-side library and execution-target resolver (C-01/C-02).
 *
 * Discovery is read-only: it never creates `.xuanling`, never registers a
 * workspace, never scans parent directories, and never lets a browser/model
 * path become a library root. A physical root is resolved only from the Host
 * workspace registry or an explicit Host configuration.
 */
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { lstatSync, mkdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isLogicalWorkflowId, libraryIds } from '../definition/library.ts'
import { DefinitionDocumentMissingError, loadDefinitionDocument } from '../definition/persist.ts'
import { readLibraryDeletion } from '../definition/library-state.ts'
import { createHash } from 'node:crypto'
import { libraryTitle, type AssetSummary, type LibraryRef, type LibraryStatus, type LibrarySummary } from '../definition/library-ref.ts'

export interface WorkspaceEntry {
  readonly id: string
  readonly path: string
  readonly title: string
}

export interface ExecutionTarget {
  readonly workspaceId: string
  /** Host-owned absolute root. Never serialized to the browser. */
  readonly root: string
}

export interface ResolvedLibrary {
  readonly library: LibraryRef
  readonly title: string
  readonly status: LibraryStatus
  readonly root: string | undefined
  readonly diagnostics: string[]
}

export interface LibraryResolverOptions {
  readonly ctx: Context
  readonly config: { readonly workspaceRoot?: string; readonly globalLibraryRoot?: string }
}

/** Stable identity for a Host-constrained root that has no registry entry.
 * The ID derives from a Host-owned absolute path, never from model input. */
export function configuredWorkspaceId(root: string): string {
  return `configured-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`
}

const MAX_ASSETS = 500

type HostContext = Context & { get(service: string): unknown }

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

/** Visible workspace entries in Host order. Malformed rows are skipped rather
 * than allowed to break every library read. */
export function workspaceEntries(ctx: Context): WorkspaceEntry[] {
  let registry: { list?: () => unknown } | undefined
  try {
    registry = (ctx as HostContext).get('workspaceRegistry') as typeof registry
  } catch {
    return []
  }
  if (typeof registry?.list !== 'function') return []
  let values: unknown
  try {
    values = registry.list()
  } catch {
    return []
  }
  if (!Array.isArray(values)) return []
  const entries: WorkspaceEntry[] = []
  for (const value of values) {
    if (value === null || typeof value !== 'object') continue
    const row = value as { id?: unknown; path?: unknown; title?: unknown }
    // Older/duck-typed registries may expose only `path`. Derive a stable ID
    // from the Host-provided absolute path instead of dropping the workspace.
    if (typeof row.path !== 'string' || !isAbsolute(row.path)) continue
    const id = typeof row.id === 'string' && row.id.length > 0 ? row.id : configuredWorkspaceId(resolve(row.path))
    const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : id
    entries.push({ id, path: resolve(row.path), title })
  }
  return entries
}

export class BlueprintLibraryResolver {
  /** Host-derived roots that are not (yet) in the registry projection. Host
   * controllers may return a default Workspace without it appearing in
   * `workspaceRegistry.list()`; the root is still Host-owned. */
  private readonly knownRoots = new Map<string, string>()

  constructor(private readonly options: LibraryResolverOptions) {}

  /** Profile-global library root, or undefined when no trusted profile root
   * can be proven. Never falls back to cwd or the install directory. */
  globalRoot(): string | undefined {
    if (this.options.config.globalLibraryRoot !== undefined) {
      const configured = resolve(this.options.config.globalLibraryRoot)
      return isAbsolute(configured) ? configured : undefined
    }
    const ctx = this.options.ctx as HostContext & { dshHomePath?: (...segments: string[]) => string }
    // "Global" means the current DSH profile, not the whole DSH home. Prefer
    // the profile directory when the Host exposes it.
    try {
      // Direct property access on a Cordis context throws when the service is
      // not injected; `get` returns undefined instead.
      const profile = ctx.get('profileContext') as { dir?: unknown } | undefined
      if (typeof profile?.dir === 'string' && isAbsolute(profile.dir)) {
        return resolve(profile.dir, 'data', 'xuanling-blueprint', 'library-v2')
      }
    } catch {
      /* optional host seam */
    }
    if (typeof this.options.ctx.baseUrl === 'string' && this.options.ctx.baseUrl.startsWith('file:')) {
      try {
        return resolve(fileURLToPath(new URL('data/xuanling-blueprint/library-v2/', this.options.ctx.baseUrl)))
      } catch {
        return undefined
      }
    }
    return undefined
  }

  workspaceRoot(workspaceId: string): string | undefined {
    return workspaceEntries(this.options.ctx).find(entry => entry.id === workspaceId)?.path
  }

  /** The explicit Host constraint, when configured. It wins over any model or
   * browser selection and is the only legacy "default workspace" that remains. */
  configuredTarget(): ExecutionTarget | undefined {
    if (this.options.config.workspaceRoot === undefined) return undefined
    const root = resolve(this.options.config.workspaceRoot)
    const match = workspaceEntries(this.options.ctx).find(entry => resolve(entry.path) === root)
    return { workspaceId: match?.id ?? configuredWorkspaceId(root), root }
  }

  /** Resolve one workspace library root, honoring the Host constraint. A
   * registered workspace whose own directory is gone is a deferred target, not
   * a creatable project path. */
  private workspaceRootOf(ref: Extract<LibraryRef, { kind: 'workspace' }>): { root: string; title: string; missingRoot: boolean } {
    const entry = workspaceEntries(this.options.ctx).find(value => value.id === ref.workspaceId)
    const configured = this.configuredTarget()
    if (entry !== undefined) {
      if (configured !== undefined && configured.root !== entry.path)
        throw new RemoteError('blueprint/workspace-mismatch', 'selected workspace does not match the Host constraint', {
          workspaceId: ref.workspaceId
        })
      let missingRoot = false
      try {
        missingRoot = !lstatSync(entry.path).isDirectory()
      } catch (error) {
        missingRoot = (error as NodeJS.ErrnoException).code === 'ENOENT'
      }
      return { root: join(entry.path, '.xuanling', 'workflows'), title: libraryTitle(ref, entry.title), missingRoot }
    }
    if (configured?.workspaceId === ref.workspaceId)
      return { root: join(configured.root, '.xuanling', 'workflows'), title: libraryTitle(ref, configured.workspaceId), missingRoot: false }
    const known = this.knownRoots.get(ref.workspaceId)
    if (known !== undefined) return { root: join(known, '.xuanling', 'workflows'), title: libraryTitle(ref, ref.workspaceId), missingRoot: false }
    throw new RemoteError('blueprint/workspace-unavailable', 'registered workspace is unavailable', { workspaceId: ref.workspaceId })
  }

  resolveLibrary(ref: LibraryRef): ResolvedLibrary {
    if (ref.kind === 'global') {
      const root = this.globalRoot()
      if (root === undefined) {
        return { library: ref, title: libraryTitle(ref), status: 'unavailable', root: undefined, diagnostics: ['profile-root-unavailable'] }
      }
      const scanned = this.scan(root)
      return { library: ref, title: libraryTitle(ref), status: scanned.status, root, diagnostics: scanned.diagnostics }
    }
    const resolved = this.workspaceRootOf(ref)
    if (resolved.missingRoot)
      return {
        library: ref,
        title: resolved.title,
        status: 'unavailable',
        root: resolved.root,
        diagnostics: ['workspace-root-missing']
      }
    const scanned = this.scan(resolved.root)
    return { library: ref, title: resolved.title, status: scanned.status, root: resolved.root, diagnostics: scanned.diagnostics }
  }

  /** Resolve a concrete execution target or throw before any effect. */
  resolveTarget(workspaceId?: string): ExecutionTarget {
    const configured = this.configuredTarget()
    if (workspaceId === undefined) {
      if (configured !== undefined) return configured
      throw new RemoteError('blueprint/workspace-required', 'select a workspace before executing', {})
    }
    const entry = workspaceEntries(this.options.ctx).find(value => value.id === workspaceId)
    if (entry === undefined) {
      if (configured?.workspaceId === workspaceId) return configured
      throw new RemoteError('blueprint/workspace-unavailable', 'registered workspace is unavailable', { workspaceId })
    }
    if (configured !== undefined && resolve(configured.root) !== resolve(entry.path))
      throw new RemoteError('blueprint/workspace-mismatch', 'selected workspace does not match the Host constraint', { workspaceId })
    let status: string
    try {
      status = lstatSync(entry.path).isDirectory() ? 'ok' : 'missing'
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') status = 'missing'
      else throw new RemoteError('blueprint/workspace-unavailable', 'workspace root is unreadable', { workspaceId })
    }
    if (status !== 'ok') throw new RemoteError('blueprint/workspace-unavailable', 'workspace root is missing', { workspaceId })
    if (configured?.workspaceId === workspaceId) return configured
    return { workspaceId, root: entry.path }
  }

  /** Default library for legacy calls: the explicit Host target first, then the
   * caller workspace (set by the service), then the global library. */
  defaultLibrary(callerRoot?: string): LibraryRef {
    const configured = this.configuredTarget()
    if (configured !== undefined) return { kind: 'workspace', workspaceId: configured.workspaceId }
    if (callerRoot !== undefined) {
      const root = resolve(callerRoot)
      const match = workspaceEntries(this.options.ctx).find(entry => resolve(entry.path) === root)
      if (match !== undefined) return { kind: 'workspace', workspaceId: match.id }
      const derived = configuredWorkspaceId(root)
      this.knownRoots.set(derived, root)
      return { kind: 'workspace', workspaceId: derived }
    }
    return { kind: 'global' }
  }

  /** List every visible library. A single unreadable library must not fail the
   * selector, so per-library errors become `unavailable` summaries. */
  list(callerRoot?: string): LibrarySummary[] {
    const summaries: LibrarySummary[] = []
    const globalRoot = this.globalRoot()
    if (globalRoot === undefined) {
      summaries.push({ library: { kind: 'global' }, title: 'Global', status: 'unavailable', assets: [], diagnostics: ['profile-root-unavailable'] })
    } else {
      summaries.push(this.summarize({ kind: 'global' }, 'Global', globalRoot))
    }
    const configured = this.configuredTarget()
    const entries = workspaceEntries(this.options.ctx)
    const seen = new Set<string>()
    for (const entry of entries) {
      seen.add(entry.id)
      summaries.push(this.summarize({ kind: 'workspace', workspaceId: entry.id }, entry.title, join(entry.path, '.xuanling', 'workflows')))
    }
    if (configured !== undefined && !seen.has(configured.workspaceId)) {
      summaries.push(
        this.summarize({ kind: 'workspace', workspaceId: configured.workspaceId }, configured.workspaceId, join(configured.root, '.xuanling', 'workflows'))
      )
    } else if (configured === undefined && callerRoot !== undefined && entries.length === 0) {
      const synthetic = configuredWorkspaceId(resolve(callerRoot))
      summaries.push(this.summarize({ kind: 'workspace', workspaceId: synthetic }, synthetic, join(callerRoot, '.xuanling', 'workflows')))
    }
    return summaries
  }

  /** Root used for a write. Global writes are explicit and may create the
   * profile namespace; workspace discovery still never creates directories. */
  writableRoot(ref: LibraryRef, create: boolean): string {
    if (ref.kind === 'global') {
      const root = this.globalRoot()
      if (root === undefined) throw new RemoteError('blueprint/library-unavailable', 'profile library root is unavailable', { kind: 'global' })
      if (create) this.ensureDirectory(root)
      return root
    }
    const resolved = this.workspaceRootOf(ref)
    if (resolved.missingRoot) throw new RemoteError('blueprint/workspace-unavailable', 'workspace root is missing', { workspaceId: ref.workspaceId })
    if (create) this.ensureDirectory(resolved.root)
    return resolved.root
  }

  private ensureDirectory(root: string): void {
    try {
      if (lstatSync(root).isDirectory()) return
      throw new RemoteError('blueprint/library-invalid', 'library root is not a directory', { reason: 'not-a-directory' })
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        try {
          // Only a write to a resolved library may create its root. The path is
          // already derived from the Host registry/profile, never from input.
          mkdirSync(root, { recursive: true, mode: 0o700 })
          return
        } catch {
          throw new RemoteError('blueprint/library-unavailable', 'library root cannot be created', { kind: 'workspace' })
        }
      }
      throw error
    }
  }

  private summarize(ref: LibraryRef, title: string, root: string): LibrarySummary {
    const scanned = this.scan(root)
    return { library: ref, title, status: scanned.status, assets: scanned.assets, diagnostics: scanned.diagnostics }
  }

  private scan(root: string): { status: LibraryStatus; assets: AssetSummary[]; diagnostics: string[] } {
    try {
      const stats = lstatSync(root)
      if (!stats.isDirectory()) return { status: 'unavailable', assets: [], diagnostics: ['library-root-not-directory'] }
    } catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT') return { status: 'absent', assets: [], diagnostics: [] }
      return { status: 'unavailable', assets: [], diagnostics: ['library-root-unreadable'] }
    }
    let ids: string[]
    try {
      ids = libraryIds(root).sort()
    } catch {
      return { status: 'unavailable', assets: [], diagnostics: ['library-read-failed'] }
    }
    const assets: AssetSummary[] = []
    const diagnostics: string[] = []
    for (const id of ids.slice(0, MAX_ASSETS)) {
      if (!isLogicalWorkflowId(id)) continue
      try {
        if (readLibraryDeletion(root, id) !== undefined) continue
      } catch {
        diagnostics.push('library-state-unreadable')
        continue
      }
      try {
        const document = loadDefinitionDocument(join(root, id))
        if (document.blueprintId !== id) {
          assets.push({ blueprintId: id, name: id, documentRevision: null, semanticRevision: null, status: 'invalid', diagnostic: 'blueprint-id-mismatch' })
          continue
        }
        const name = (() => {
          try {
            return (JSON.parse(document.definitionJson) as { name?: unknown }).name
          } catch {
            return undefined
          }
        })()
        assets.push({
          blueprintId: id,
          name: typeof name === 'string' ? name : id,
          documentRevision: document.documentRevision,
          semanticRevision: document.semanticRevision,
          status: 'ready'
        })
      } catch (error) {
        if (error instanceof DefinitionDocumentMissingError) continue
        // Raw decode errors can contain file content; expose only a stable code.
        assets.push({ blueprintId: id, name: id, documentRevision: null, semanticRevision: null, status: 'invalid', diagnostic: 'definition-invalid' })
      }
    }
    if (assets.length === 0) return { status: 'empty', assets, diagnostics }
    return { status: 'ready', assets, diagnostics }
  }
}
