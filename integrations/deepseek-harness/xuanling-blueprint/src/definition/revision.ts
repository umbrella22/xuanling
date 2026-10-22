/**
 * Definition revisions (C-02/C-10): the semantic revision covers the whole
 * execution meaning — canonical definition (presentation excluded) plus the
 * digests of every package-internal file the definition references, walking
 * subflow definitions. The layout revision covers presentation only. Both
 * are content-addressed; no user-facing version knob is introduced.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { BlueprintDefinition } from './types.ts'

export interface RevisionInput {
  /** Absolute blueprint root directory containing blueprint.json and lib/. */
  rootDir: string
  definition: BlueprintDefinition
}

export interface DefinitionRevision {
  semantic: string
  layout: string
  /** Relative path → sha256 for every package file covered by `semantic`. */
  files: Record<string, string>
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Canonical semantic projection: everything except presentation, with keys
 * sorted so cosmetic reordering never changes the revision. */
export function semanticProjection(definition: BlueprintDefinition): unknown {
  const ordered = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(ordered)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, ordered(v)])
      )
    }
    return value
  }
  const { presentation: _presentation, ...semantic } = definition
  return ordered(semantic)
}

function collectResourceFiles(definition: BlueprintDefinition, rootDir: string, files: Map<string, string>, issues: string[]): void {
  for (const [refId, ref] of Object.entries(definition.resources)) {
    if (ref.source?.kind === 'shared' || ref.source?.kind === 'host') continue // external resources are resolved per attempt, not frozen in the package
    if (ref.kind === 'mcp' && ref.format !== 'mcp-definition') continue
    if (typeof ref.path !== 'string') continue
    const absolute = resolve(rootDir, ref.path)
    const rel = relative(rootDir, absolute)
    if (rel.startsWith('..') || (resolve(absolute) !== absolute && !absolute.startsWith(resolve(rootDir) + sep))) {
      issues.push(`resource "${refId}" escapes the blueprint root: ${ref.path}`)
      continue
    }
    if (!existsSync(absolute)) {
      issues.push(`resource "${refId}" file missing: ${ref.path}`)
      continue
    }
    // A directory-valued resource (e.g. a materialized skill tree) covers
    // every file under it; revision completeness follows the tree.
    const stat = statSync(absolute)
    if (stat.isDirectory()) {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else {
            const entryRel = relative(rootDir, full).split(sep).join('/')
            files.set(entryRel, sha256(readFileSync(full)))
          }
        }
      }
      walk(absolute)
      continue
    }
    if (!stat.isFile()) {
      issues.push(`resource "${refId}" is not a regular file: ${ref.path}`)
      continue
    }
    files.set(rel.split(sep).join('/'), sha256(readFileSync(absolute)))
  }
}

export function computeRevision(input: RevisionInput): DefinitionRevision {
  const { rootDir, definition } = input
  const files = new Map<string, string>()
  const issues: string[] = []
  collectResourceFiles(definition, resolve(rootDir), files, issues)
  if (issues.length > 0) {
    const error = new Error(`revision inputs incomplete: ${issues.join('; ')}`)
    error.name = 'RevisionInputMissingError'
    throw error
  }
  const fileEntries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const fileLines = fileEntries.map(([path, digest]) => `${path}\u0000${digest}\n`).join('')
  const semantic = sha256(
    Buffer.concat([Buffer.from('xuanling-blueprint-semantic-v2\u0000'), Buffer.from(JSON.stringify(semanticProjection(definition))), Buffer.from(fileLines)])
  )
  const layout = sha256(Buffer.concat([Buffer.from('xuanling-blueprint-layout-v2\u0000'), Buffer.from(JSON.stringify(definition.presentation ?? null))]))
  return { semantic, layout, files: Object.fromEntries(fileEntries) }
}
