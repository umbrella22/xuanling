/** Bundled dependencies are exact package snapshots, never workspace aliases. */
import { createHash } from 'node:crypto'
import { decodeDefinition } from '../definition/codec.ts'
import { validateDefinition } from '../definition/validator.ts'
import { canonicalJson, documentRevisions } from '../definition/document.ts'
import { blueprintReferenceKey, resolveBlueprintClosure } from '../definition/composition.ts'
import type { DefinitionPackage } from '../definition/persist.ts'
import type { BlueprintReference } from '../definition/types.ts'
import { admitResources } from '../security/resource-admission.ts'
import { PortabilityConflictError } from './errors.ts'
import { validatePackagedMcp, validatePackagedPreset } from './host-resources.ts'

export const BLUEPRINT_DEPENDENCIES = 'lib/blueprint-dependencies/'
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Same revision inputs as loadDefinitionPackage: lib plus declared files.
 * Callers supply path-checked ZIP entries or a checked DefinitionPackage. */
export function readPackagedDefinition(entries: Map<string, Buffer>): DefinitionPackage {
  const json = entries.get('blueprint.json')
  if (!json) throw new PortabilityConflictError('bundled definition missing')
  const definition = decodeDefinition(json.toString('utf8'))
  validateDefinition(definition)
  if (admitResources(definition.resources).length) throw new PortabilityConflictError('bundled resource paths rejected')
  const paths = Object.values(definition.resources).flatMap(ref => (ref.path ? [ref.path] : []))
  const files = new Map(
    [...entries].filter(
      ([path]) => path !== 'blueprint.json' && (path.startsWith('lib/') || paths.some(resource => path === resource || path.startsWith(`${resource}/`)))
    )
  )
  for (const ref of Object.values(definition.resources)) {
    if (!ref.path) continue
    if (![...files.keys()].some(path => path === ref.path || path.startsWith(`${ref.path}/`))) throw new PortabilityConflictError('bundled resource missing')
    if (ref.format) {
      const bytes = files.get(ref.path)
      if (!bytes) throw new PortabilityConflictError('bundled Host artifact missing')
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (ref.format === 'agent-preset') validatePackagedPreset(value)
      else validatePackagedMcp(value)
    }
  }
  return {
    document: {
      blueprintId: definition.id,
      definitionJson: canonicalJson(definition),
      ...documentRevisions(definition, Object.fromEntries([...files].map(([path, bytes]) => [path, digest(bytes)])))
    },
    files
  }
}

/** An existing but corrupt embedded version fails closed; it never falls back. */
export function loadPackagedReference(owner: DefinitionPackage, ref: BlueprintReference): DefinitionPackage | undefined {
  const base = `${BLUEPRINT_DEPENDENCIES}${ref.documentRevision}/`
  const entries = new Map([...owner.files].filter(([path]) => path.startsWith(base)).map(([path, bytes]) => [path.slice(base.length), bytes]))
  if (!entries.size) return undefined
  const snapshot = readPackagedDefinition(entries)
  if (snapshot.document.blueprintId !== ref.blueprintId || snapshot.document.documentRevision !== ref.documentRevision)
    throw new PortabilityConflictError('bundled reference identity or revision mismatch')
  return snapshot
}

/** A library dependency may itself be an imported package. Retain its embedded
 * closure while walking deeper calls; no same-name latest resolution occurs. */
export function packagedReferenceLoader(owner: DefinitionPackage, fallback: (ref: BlueprintReference) => DefinitionPackage) {
  const owners = [owner]
  const cache = new Map<string, DefinitionPackage>()
  return (ref: BlueprintReference): DefinitionPackage => {
    const key = blueprintReferenceKey(ref)
    const cached = cache.get(key)
    if (cached) return cached
    let snapshot: DefinitionPackage | undefined
    for (const parent of owners) {
      snapshot = loadPackagedReference(parent, ref)
      if (snapshot) break
    }
    snapshot ??= fallback(ref)
    cache.set(key, snapshot)
    owners.push(snapshot)
    return snapshot
  }
}

export function validatePackagedClosure(snapshot: DefinitionPackage): void {
  try {
    resolveBlueprintClosure(
      decodeDefinition(snapshot.document.definitionJson),
      packagedReferenceLoader(snapshot, () => {
        throw new PortabilityConflictError('bundled dependency missing')
      })
    )
  } catch {
    throw new PortabilityConflictError('bundled blueprint closure rejected')
  }
}
