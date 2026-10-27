/**
 * Agent Markdown discovery (C-03/F-03).
 *
 * Agent documents are read-only data. They are never executed as plugins, their
 * frontmatter is not interpreted as configuration, and importing one copies its
 * bytes into the blueprint package as an ordinary package Agent resource.
 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export type AgentDocumentSource = 'project' | 'user'

export interface AgentDocumentSummary {
  /** Stable logical identity derived from the absolute source path. */
  readonly documentId: string
  readonly name: string
  readonly description: string
  readonly source: AgentDocumentSource
  readonly digest: string
}

export interface AgentDocumentRoot {
  readonly root: string
  readonly source: AgentDocumentSource
}

const MAX_DOCUMENTS = 200

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Candidate roots in deterministic precedence order. Project first, then user.
 * `$DSH_AGENTS_HOME`/`$DSH_HOME` follow the same convention as Skills. */
export function agentDocumentRoots(cwd: string | null, env: Record<string, string | undefined> = {}): AgentDocumentRoot[] {
  const roots: AgentDocumentRoot[] = []
  const add = (root: string, source: AgentDocumentSource): void => {
    const value = resolve(root)
    if (!roots.some(entry => entry.root === value)) roots.push({ root: value, source })
  }
  if (cwd !== null) {
    add(join(cwd, '.agents', 'agents'), 'project')
    add(join(cwd, '.dsh', 'agents'), 'project')
  }
  const agentsHome = env.DSH_AGENTS_HOME
  if (typeof agentsHome === 'string' && isAbsolute(agentsHome)) add(join(agentsHome, 'agents'), 'user')
  const dshHome = env.DSH_HOME
  if (typeof dshHome === 'string' && isAbsolute(dshHome)) add(join(dshHome, 'agents'), 'user')
  const home = env.HOME ?? homedir()
  if (typeof home === 'string' && isAbsolute(home)) {
    add(join(home, '.agents', 'agents'), 'user')
    add(join(home, '.dsh', 'agents'), 'user')
  }
  return roots
}

function documentId(physicalPath: string): string {
  return `adoc-${createHash('sha256').update(physicalPath).digest('hex')}`
}

/** Minimal, non-executing frontmatter reader: only `name` and `description`
 * scalar lines are recognized. Unknown keys are ignored, never interpreted. */
export function parseAgentDocument(content: string, fallbackName: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (match === null) return { name: fallbackName, description: '' }
  let name = fallbackName
  let description = ''
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = /^(name|description)\s*:\s*(.*)$/.exec(line)
    if (field === null) continue
    const value = field[2]!.trim().replace(/^['"]|['"]$/g, '')
    if (value.length === 0) continue
    if (field[1] === 'name') name = value.slice(0, 200)
    else description = value.slice(0, 500)
  }
  return { name, description }
}

function safeDocuments(root: AgentDocumentRoot): AgentDocumentSummary[] {
  let entries: string[]
  let physicalRoot: string
  try {
    physicalRoot = realpathSync(root.root)
    if (!lstatSync(physicalRoot).isDirectory()) return []
    entries = readdirSync(physicalRoot).filter(name => name.endsWith('.md') && !name.startsWith('.'))
  } catch {
    return []
  }
  const documents: AgentDocumentSummary[] = []
  for (const entry of entries.slice(0, MAX_DOCUMENTS)) {
    try {
      const candidate = join(physicalRoot, entry)
      if (!lstatSync(candidate).isFile()) continue
      const physical = realpathSync(candidate)
      if (!contained(physicalRoot, physical)) continue
      const content = readFileSync(physical, 'utf8')
      const fallback = entry.slice(0, -'.md'.length)
      const meta = parseAgentDocument(content, fallback)
      documents.push({
        documentId: documentId(physical),
        name: meta.name,
        description: meta.description,
        source: root.source,
        digest: createHash('sha256').update(content).digest('hex')
      })
    } catch {
      /* unreadable documents stay absent; they are not errors of the whole list */
    }
  }
  return documents
}

export function listAgentDocuments(cwd: string | null, env: Record<string, string | undefined> = process.env): AgentDocumentSummary[] {
  const seen = new Set<string>()
  const documents: AgentDocumentSummary[] = []
  for (const root of agentDocumentRoots(cwd, env)) {
    for (const document of safeDocuments(root)) {
      const key = `${document.source}:${document.documentId}`
      if (seen.has(key)) continue
      seen.add(key)
      documents.push(document)
    }
  }
  return documents
}

export function readAgentDocument(
  documentId: string,
  cwd: string | null,
  env: Record<string, string | undefined> = process.env
): { summary: AgentDocumentSummary; content: string } | undefined {
  for (const root of agentDocumentRoots(cwd, env)) {
    let physicalRoot: string
    let entries: string[]
    try {
      physicalRoot = realpathSync(root.root)
      entries = readdirSync(physicalRoot).filter(name => name.endsWith('.md') && !name.startsWith('.'))
    } catch {
      continue
    }
    for (const entry of entries.slice(0, MAX_DOCUMENTS)) {
      try {
        const physical = realpathSync(join(physicalRoot, entry))
        if (!contained(physicalRoot, physical) || documentIdOfSafe(physical) !== documentId) continue
        const content = readFileSync(physical, 'utf8')
        const meta = parseAgentDocument(content, entry.slice(0, -'.md'.length))
        return {
          summary: {
            documentId,
            name: meta.name,
            description: meta.description,
            source: root.source,
            digest: createHash('sha256').update(content).digest('hex')
          },
          content
        }
      } catch {
        continue
      }
    }
  }
  return undefined
}

function documentIdOfSafe(physicalPath: string): string {
  return documentId(physicalPath)
}

/** Package-relative destination for one imported document. The identity keeps
 * concurrent imports of same-named documents from different sources distinct. */
export function importedAgentPath(name: string, documentId: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent'
  return `agents/${slug}-${documentId.slice(-8)}.md`
}
