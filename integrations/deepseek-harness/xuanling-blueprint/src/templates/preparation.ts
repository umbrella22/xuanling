/**
 * Evidence-driven project discovery (C-08).
 *
 * Only bounded reads of declared project files. No command is executed, no
 * directory is created, and unreadable/missing evidence stays an explicit
 * `unknown` fact instead of being reported as an empty project.
 */
import { createHash } from 'node:crypto'
import { assertStoragePath } from '../persistence/durable-fs.ts'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PreparationFact } from './contracts.ts'
import { stableHash } from './digest.ts'

const MAX_BYTES = 256 * 1024
const MAX_CI_FILES = 24

function readBounded(root: string, path: string): string | undefined {
  try {
    assertStoragePath(root, path)
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.size > MAX_BYTES) return undefined
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function fact(
  kind: PreparationFact['kind'],
  value: string,
  sourcePath: string,
  status: PreparationFact['status'] = 'observed',
  content?: string
): PreparationFact {
  return {
    kind,
    value,
    sourcePath,
    digest: content === undefined ? stableHash({ kind, value, sourcePath }) : createHash('sha256').update(content).digest('hex'),
    status
  }
}

function packageFacts(root: string, facts: PreparationFact[]): void {
  const content = readBounded(root, join(root, 'package.json'))
  if (content === undefined) return
  let manifest: { name?: unknown; scripts?: unknown; packageManager?: unknown; workspaces?: unknown }
  try {
    manifest = JSON.parse(content) as typeof manifest
  } catch {
    facts.push(fact('manifest', 'package.json is not valid JSON', 'package.json', 'unknown', content))
    return
  }
  if (typeof manifest.name === 'string') facts.push(fact('manifest', `package:${manifest.name}`, 'package.json', 'observed', content))
  if (Array.isArray(manifest.workspaces)) facts.push(fact('manifest', `workspaces:${manifest.workspaces.length}`, 'package.json', 'observed', content))
  const packageManager = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : undefined
  const runner = packageManager === 'pnpm' || existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
  if (manifest.scripts !== null && typeof manifest.scripts === 'object') {
    for (const [name, command] of Object.entries(manifest.scripts as Record<string, unknown>)) {
      if (typeof command !== 'string') continue
      facts.push(fact('command', `${runner} run ${name}`, `package.json#scripts.${name}`, 'observed', content))
    }
  }
}

function cargoFacts(root: string, facts: PreparationFact[]): void {
  const content = readBounded(root, join(root, 'Cargo.toml'))
  if (content === undefined) return
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(content)?.[1]
  facts.push(fact('manifest', `cargo:${name ?? 'unknown'}`, 'Cargo.toml', 'observed', content))
  // A manifest alone does not prove this project's feature/target/test commands.
  facts.push(fact('command', 'project commands require CI or documented evidence', 'Cargo.toml', 'unknown', content))
}

function readmeFacts(root: string, facts: PreparationFact[]): void {
  for (const name of ['README.md', 'README-ZH.md', 'README']) {
    const content = readBounded(root, join(root, name))
    if (content === undefined) continue
    const title =
      content
        .split(/\r?\n/)
        .find(line => line.trim().length > 0)
        ?.trim()
        .slice(0, 200) ?? ''
    facts.push(fact('readme', title, name, 'observed', content))
  }
}

function ruleFacts(root: string, facts: PreparationFact[]): void {
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md']) {
    const content = readBounded(root, join(root, name))
    if (content !== undefined) facts.push(fact('rule', name, name, 'observed', content))
  }
}

function ciFacts(root: string, facts: PreparationFact[]): void {
  const directory = join(root, '.github', 'workflows')
  try {
    assertStoragePath(root, directory)
    if (!lstatSync(directory).isDirectory()) return
    for (const name of readdirSync(directory).sort().slice(0, MAX_CI_FILES)) {
      if (!/\.ya?ml$/.test(name)) continue
      const content = readBounded(root, join(directory, name))
      if (content !== undefined) facts.push(fact('ci', name, `.github/workflows/${name}`, 'observed', content))
    }
  } catch {
    /* absent CI is not an error */
  }
}

function sourceFacts(root: string, facts: PreparationFact[]): void {
  for (const base of ['src', 'crates', 'examples', 'docs']) {
    let budget = 64
    const visit = (path: string, depth: number): void => {
      if (depth > 3 || budget <= 0) return
      const absolute = join(root, path)
      try {
        assertStoragePath(root, absolute)
        const stat = lstatSync(absolute)
        if (stat.isDirectory()) {
          for (const child of readdirSync(absolute).sort()) {
            if (child.startsWith('.') || ['node_modules', 'target', 'dist'].includes(child)) continue
            visit(`${path}/${child}`, depth + 1)
          }
        } else if (stat.isFile()) {
          const content = readBounded(root, absolute)
          if (content !== undefined) {
            budget--
            facts.push(fact('source', path, path, 'observed', content))
          }
        }
      } catch {
        /* missing, oversized and inaccessible paths are not observations */
      }
    }
    visit(base, 0)
    if (!facts.some(entry => entry.sourcePath.startsWith(`${base}/`))) facts.push(fact('source', `${base}: no readable evidence`, base, 'unknown'))
    if (budget === 0) facts.push(fact('source', `${base}: discovery limit reached; remaining files unverified`, base, 'unknown'))
  }
}

export function discoverProject(root: string): PreparationFact[] {
  const facts: PreparationFact[] = []
  packageFacts(root, facts)
  cargoFacts(root, facts)
  readmeFacts(root, facts)
  ruleFacts(root, facts)
  ciFacts(root, facts)
  sourceFacts(root, facts)
  if (!facts.some(entry => entry.kind === 'manifest')) facts.push(fact('manifest', 'no recognized manifest', '.', 'unknown'))
  if (!facts.some(entry => entry.kind === 'readme')) facts.push(fact('readme', 'no README found', '.', 'unknown'))
  return facts
}

export function preparationId(templateId: string, workspaceId: string, requestId: string): string {
  return `prep-${stableHash([templateId, workspaceId, requestId]).slice(0, 32)}`
}
