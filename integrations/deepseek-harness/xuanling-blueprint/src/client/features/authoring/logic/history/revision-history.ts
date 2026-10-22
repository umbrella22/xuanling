/**
 * Pure helpers for the canvas revision history: DTO narrowing for
 * `workflowRevisions` and a structural diff between two definition JSONs.
 * The diff is semantic (nodes, edges, resources, refs, name, metadata) and
 * never renders resource bytes; layout-only changes are reported as such.
 * Package-file contents are detected indirectly through the content-addressed
 * `semanticRevision`, which covers both the definition and the packaged files.
 */

export interface RevisionEntry {
  readonly revision: string
  readonly parentRevision: string | null
  readonly createdAt: number
  readonly origin: string
  readonly message?: string
  /** Content revision of the definition plus its packaged resource files. */
  readonly semanticRevision?: string
  readonly definitionJson: string
}

export interface DefinitionDiffSummary {
  readonly nameChanged: boolean
  /** Metadata area or file-format version differs (not layout). */
  readonly metadataChanged: boolean
  readonly nodesAdded: readonly string[]
  readonly nodesRemoved: readonly string[]
  readonly nodesChanged: readonly string[]
  readonly edgesAdded: number
  readonly edgesRemoved: number
  readonly resourcesAdded: readonly string[]
  readonly resourcesRemoved: readonly string[]
  readonly resourcesChanged: readonly string[]
  /** True when any non-presentation definition meaning differs. */
  readonly semanticChanged: boolean
  readonly layoutOnly: boolean
  readonly identical: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Narrow the `workflowRevisions` value; malformed entries are dropped, newest first. */
export function readRevisionEntries(value: unknown): RevisionEntry[] {
  const revisions = record(value)?.revisions
  if (!Array.isArray(revisions)) return []
  const entries: RevisionEntry[] = []
  for (const raw of revisions) {
    const entry = record(raw)
    const document = record(entry?.document)
    if (
      entry === undefined ||
      typeof entry.revision !== 'string' ||
      typeof entry.createdAt !== 'number' ||
      typeof entry.origin !== 'string' ||
      typeof document?.definitionJson !== 'string'
    )
      continue
    entries.push({
      revision: entry.revision,
      parentRevision: typeof entry.parentRevision === 'string' ? entry.parentRevision : null,
      createdAt: entry.createdAt,
      origin: entry.origin,
      ...(typeof entry.message === 'string' ? { message: entry.message } : {}),
      ...(typeof document.semanticRevision === 'string' ? { semanticRevision: document.semanticRevision } : {}),
      definitionJson: document.definitionJson
    })
  }
  return entries.sort((a, b) => b.createdAt - a.createdAt)
}

export interface RevisionResourceFilesChangedInput {
  readonly isCurrent: boolean
  /** `DefinitionDiffSummary.semanticChanged` for the same revision pair. */
  readonly semanticChanged: boolean
  readonly entrySemanticRevision: string | undefined
  readonly currentSemanticRevision: string | undefined
}

/** A non-current revision whose semantic projection is identical but whose
 * `semanticRevision` differs can only differ in packaged resource files:
 * `semanticRevision` is content-addressed over the definition projection and
 * every package file digest. When the projections differ, the revision
 * difference is already explained and no file-only claim is made. */
export function revisionResourceFilesChanged(input: RevisionResourceFilesChangedInput): boolean {
  return (
    !input.isCurrent &&
    !input.semanticChanged &&
    input.entrySemanticRevision !== undefined &&
    input.currentSemanticRevision !== undefined &&
    input.currentSemanticRevision !== input.entrySemanticRevision
  )
}

function parse(json: string): Record<string, unknown> {
  try {
    return record(JSON.parse(json)) ?? {}
  } catch {
    return {}
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const object = record(value)
  if (object === undefined) return JSON.stringify(value) ?? 'undefined'
  return `{${Object.keys(object)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(',')}}`
}

function byId(list: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(list)) return out
  for (const item of list) {
    const id = record(item)?.id
    if (typeof id === 'string') out.set(id, stable(item))
  }
  return out
}

function edgeKeys(list: unknown): Set<string> {
  return new Set(Array.isArray(list) ? list.map(stable) : [])
}

function keyed(value: unknown): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, item] of Object.entries(record(value) ?? {})) out.set(key, stable(item))
  return out
}

function compare(from: Map<string, string>, to: Map<string, string>) {
  return {
    added: [...to.keys()].filter(key => !from.has(key)).sort(),
    removed: [...from.keys()].filter(key => !to.has(key)).sort(),
    changed: [...to.keys()].filter(key => from.has(key) && from.get(key) !== to.get(key)).sort()
  }
}

/** What changes if the canvas moves from `fromJson` to `toJson`. */
export function summarizeDefinitionDiff(fromJson: string, toJson: string): DefinitionDiffSummary {
  const from = parse(fromJson)
  const to = parse(toJson)
  const fromGraph = record(from.graph) ?? {}
  const toGraph = record(to.graph) ?? {}
  const nodes = compare(byId(fromGraph.nodes), byId(toGraph.nodes))
  const resources = compare(keyed(from.resources), keyed(to.resources))
  const fromEdges = edgeKeys(fromGraph.edges)
  const toEdges = edgeKeys(toGraph.edges)
  const edgesAdded = [...toEdges].filter(edge => !fromEdges.has(edge)).length
  const edgesRemoved = [...fromEdges].filter(edge => !toEdges.has(edge)).length
  const nameChanged = from.name !== to.name
  const metadataChanged = stable(from.schemaVersion) !== stable(to.schemaVersion) || stable(from.metadata) !== stable(to.metadata)
  const semantic =
    nameChanged ||
    metadataChanged ||
    nodes.added.length + nodes.removed.length + nodes.changed.length > 0 ||
    edgesAdded + edgesRemoved > 0 ||
    resources.added.length + resources.removed.length + resources.changed.length > 0
  const layoutChanged = stable(from.presentation) !== stable(to.presentation)
  return {
    nameChanged,
    metadataChanged,
    nodesAdded: nodes.added,
    nodesRemoved: nodes.removed,
    nodesChanged: nodes.changed,
    edgesAdded,
    edgesRemoved,
    resourcesAdded: resources.added,
    resourcesRemoved: resources.removed,
    resourcesChanged: resources.changed,
    semanticChanged: semantic,
    layoutOnly: !semantic && layoutChanged,
    identical: !semantic && !layoutChanged
  }
}
