/**
 * Import (C-11): validates the archive in a staging area, never executes
 * anything, and publishes the target atomically (stage beside the target,
 * then rename). Existing targets are refused unless explicitly allowed;
 * a failure never leaves a half-imported blueprint behind. Imported
 * blueprints use their packaged copies — no silent rebinding to same-named
 * local skills (that is an explicit `rebind` operation).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { decodeDefinition, validateDefinition } from '../definition/index.ts'
import { ImportConflictError, PortabilityConflictError } from './errors.ts'
import { readZip } from './zip.ts'
import type { PortabilityManifest } from './manifest.ts'
import { validatePackagedPreset, validatePackagedMcp } from './host-resources.ts'
import { readPackagedDefinition, validatePackagedClosure } from './packaged-reference.ts'

export interface ImportResult {
  targetDir: string
  manifest: PortabilityManifest
  filesWritten: string[]
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Import a portable archive into `targetDir` (created atomically). */
export function importBlueprint(archive: Buffer, targetDir: string, options: { allowExisting?: boolean } = {}): ImportResult {
  const entries = readZip(archive)
  const byName = new Map(entries.map(e => [e.name, e]))

  const manifestEntry = byName.get('portability.json')
  if (manifestEntry === undefined) throw new PortabilityConflictError('archive has no portability.json manifest')
  let manifest: PortabilityManifest
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8')) as PortabilityManifest
  } catch {
    throw new PortabilityConflictError('portability.json is not valid JSON')
  }
  if (manifest.schemaVersion !== 1) {
    throw new PortabilityConflictError(`unsupported portability manifest schemaVersion ${String(manifest.schemaVersion)} (fail closed)`)
  }
  const definitionEntry = byName.get('blueprint.json')
  if (definitionEntry === undefined) throw new PortabilityConflictError('archive has no blueprint.json')

  // Integrity: every manifest file present, digest matches; no unlisted file
  // besides the manifest itself (the archive is exactly the declared closure).
  for (const [path, digest] of Object.entries(manifest.files)) {
    const entry = byName.get(path)
    if (entry === undefined) throw new PortabilityConflictError(`manifest lists missing file ${path}`)
    if (sha256(entry.data) !== digest) throw new PortabilityConflictError(`digest mismatch for ${path}`)
  }
  for (const entry of entries) {
    if (entry.name === 'portability.json') continue
    if (!Object.hasOwn(manifest.files, entry.name)) {
      throw new PortabilityConflictError(`archive carries an undeclared file ${entry.name}`)
    }
  }
  const closureDigest = sha256(
    Object.entries(manifest.files)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([p, d]) => `${p}\u0000${d}\n`)
      .join('')
  )
  if (closureDigest !== manifest.closureDigest) throw new PortabilityConflictError('closure digest mismatch')

  // Structural validation of the definition BEFORE anything touches disk.
  const definition = decodeDefinition(definitionEntry.data.toString('utf8'))
  validateDefinition(definition)
  for (const ref of Object.values(definition.resources)) {
    if (ref.format === undefined) continue
    const artifact = ref.path === undefined ? undefined : byName.get(ref.path)
    if (artifact === undefined) throw new PortabilityConflictError('packaged Host artifact missing')
    let value: unknown
    try {
      value = JSON.parse(artifact.data.toString('utf8'))
    } catch {
      throw new PortabilityConflictError('packaged Host artifact JSON rejected')
    }
    if (ref.format === 'agent-preset') validatePackagedPreset(value)
    else validatePackagedMcp(value)
  }
  if (definition.id !== manifest.blueprintId) {
    throw new PortabilityConflictError(`blueprint id "${definition.id}" does not match manifest "${manifest.blueprintId}"`)
  }
  validatePackagedClosure(readPackagedDefinition(new Map(entries.filter(entry => entry.name !== 'portability.json').map(entry => [entry.name, entry.data]))))

  const target = resolve(targetDir)
  if (existsSync(target) && options.allowExisting !== true) throw new ImportConflictError(target)
  if (existsSync(target) && options.allowExisting === true && readdirSync(target).length > 0) {
    throw new ImportConflictError(target)
  }

  const parent = dirname(target)
  mkdirSync(parent, { recursive: true })
  const staging = mkdtempSync(join(parent, '.bp-import-'))
  const written: string[] = []
  try {
    for (const entry of entries) {
      const destination = join(staging, entry.name)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, entry.data, { mode: 0o644 })
      written.push(entry.name)
    }
    // Atomic publication: staging → target. A pre-existing empty target is
    // replaced by rename; anything non-empty was refused above.
    if (existsSync(target)) {
      const emptyCheck = statSync(target).isDirectory() && readdirSync(target).length === 0
      if (!emptyCheck) throw new ImportConflictError(target)
      rmSync(target, { recursive: true })
    }
    mkdirSync(dirname(target), { recursive: true })
    renameSync(staging, target)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  // Final self-check: the published tree validates from disk.
  const republished = decodeDefinition(readFileSync(join(target, 'blueprint.json'), 'utf8'))
  validateDefinition(republished)
  return { targetDir: target, manifest, filesWritten: written.sort() }
}

/**
 * Explicit rebind (C-11/C-04): point one packaged skill resource back at a
 * machine-local shared root. Never happens implicitly — a later user action
 * rewrites the ref and must pass the root binding explicitly.
 */
export function rebindSharedSkill(rootDir: string, refId: string, binding: { rootId: string; skillPath: string }): { rewritten: string } {
  const file = join(resolve(rootDir), 'blueprint.json')
  const definition = decodeDefinition(readFileSync(file, 'utf8'))
  const ref = definition.resources[refId]
  if (ref === undefined) throw new PortabilityConflictError(`resource "${refId}" does not exist`)
  if (ref.kind !== 'skill') throw new PortabilityConflictError(`resource "${refId}" is not a skill`)
  const rewritten = { ...ref, kind: 'skill' as const, source: { kind: 'shared' as const, rootId: binding.rootId, path: binding.skillPath } }
  delete (rewritten as { path?: string }).path
  const next = { ...definition, resources: { ...definition.resources, [refId]: rewritten } }
  validateDefinition(next)
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return { rewritten: refId }
}
