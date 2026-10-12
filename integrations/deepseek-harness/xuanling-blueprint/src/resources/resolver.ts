/**
 * Resource resolution (C-03): package resources resolve inside the blueprint
 * root; shared skills resolve by explicit rootId via the public
 * FileSystemSkillProvider surface (W0.3-proven). Same name from different
 * roots stays distinct; resolution never creates links and never stores
 * machine absolute paths in portable data.
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface SkillRoot {
  /** Stable logical root id used by blueprint refs (e.g. user-agents-skills). */
  rootId: string
  /** Absolute path of the skills root on this machine (machine binding, never portable). */
  rootPath: string
}

export interface ResolveContext {
  /** Absolute blueprint root (contains blueprint.json and lib/). */
  blueprintRoot: string
  /** Logical root registry from plugin machine binding. */
  roots: SkillRoot[]
  /** Isolated provider config; roots above are passed as customSkillDirs. */
  providerFactory?: (rootPaths: string[]) => SkillProviderLike
}

export interface SkillProviderLike {
  list(options: Record<string, unknown>): Promise<unknown>
  get(candidate: unknown, options: Record<string, unknown>): Promise<{ content?: unknown } | undefined>
}

export type ResourceResolution =
  | { kind: 'package-file'; refId: string; absolutePath: string }
  | { kind: 'mcp-binding'; refId: string; bindingId: string }
  | { kind: 'shared-skill'; refId: string; rootId: string; skillDir: string; skillName: string; candidate: unknown }

export class ResourceUnavailableError extends Error {
  override readonly name = 'ResourceUnavailableError'
  readonly code = 'RESOURCE_UNAVAILABLE'
  readonly refId: string
  readonly detail: string
  constructor(refId: string, detail: string) {
    super(`resource "${refId}" unavailable: ${detail}`)
    this.refId = refId
    this.detail = detail
  }
}

export class ResourceAmbiguousError extends Error {
  override readonly name = 'ResourceAmbiguousError'
  readonly code = 'RESOURCE_AMBIGUOUS'
  readonly refId: string
  readonly detail: string
  constructor(refId: string, detail: string) {
    super(`resource "${refId}" ambiguous: ${detail}`)
    this.refId = refId
    this.detail = detail
  }
}

/** Resolve one blueprint resource reference to its local source. Shared
 * skills match the ref's source.path (skill name) inside the mapped root;
 * same-name skills in other roots never influence the result. */
export async function resolveResource(refId: string, ref: { kind: string; path?: string; source?: { kind: 'shared'; rootId: string; path: string }; bindingId?: string }, ctx: ResolveContext): Promise<ResourceResolution> {
  if (ref.kind === 'mcp') {
    if (typeof ref.bindingId !== 'string' || ref.bindingId.length === 0) {
      throw new ResourceUnavailableError(refId, 'mcp resource has no bindingId')
    }
    return { kind: 'mcp-binding', refId, bindingId: ref.bindingId }
  }

  if (ref.source?.kind === 'shared') {
    if (ctx.roots.filter(r => r.rootId === ref.source!.rootId).length > 1) throw new ResourceAmbiguousError(refId, 'rootId has multiple bindings')
    const root = ctx.roots.find(r => r.rootId === ref.source!.rootId)
    if (root === undefined) {
      throw new ResourceUnavailableError(refId, `rootId "${ref.source.rootId}" is not bound on this machine (explicit bind required, no default winner)`)
    }
    if (!existsSync(root.rootPath) || !statSync(root.rootPath).isDirectory()) {
      throw new ResourceUnavailableError(refId, `root "${root.rootId}" path missing on disk: ${root.rootPath}`)
    }
    const skillDir = join(root.rootPath, ref.source.path)
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
      throw new ResourceUnavailableError(refId, `skill "${ref.source.path}" not found under root "${root.rootId}"`)
    }
    const rel = relative(realpathSync(root.rootPath), realpathSync(skillDir))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ResourceUnavailableError(refId, 'shared Skill escapes bound root')
    return { kind: 'shared-skill', refId, rootId: root.rootId, skillDir, skillName: ref.source.path, candidate: null }
  }

  if (typeof ref.path !== 'string') {
    throw new ResourceUnavailableError(refId, 'resource has neither package path nor shared source')
  }
  const absolute = resolve(ctx.blueprintRoot, ref.path)
  const rel = relative(ctx.blueprintRoot, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ResourceUnavailableError(refId, `path "${ref.path}" escapes the blueprint root`)
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    throw new ResourceUnavailableError(refId, `package file missing: ${ref.path}`)
  }
  const physical = relative(realpathSync(ctx.blueprintRoot), realpathSync(absolute))
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) throw new ResourceUnavailableError(refId, 'package symlink escapes root')
  return { kind: 'package-file', refId, absolutePath: absolute }
}
