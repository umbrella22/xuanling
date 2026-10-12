/**
 * Export (C-11): reads the CURRENT source at export time, walks the full
 * declared closure (package files + subflow definitions + the COMPLETE shared
 * skill trees), materializes everything as ordinary files inside the archive,
 * and rewrites shared-skill references to package-internal ones. The archive
 * carries a manifest with digests, required bindings and declared run
 * dependencies — never machine paths, credentials, run records or snapshots.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { decodeDefinition, validateDefinition } from '../definition/index.ts'
import { computeRevision, type DefinitionRevision } from '../definition/revision.ts'
import type { BlueprintDefinition, ResourceRef } from '../definition/types.ts'
import { admitResources } from '../security/resource-admission.ts'
import { writeZip, type ZipEntryInput } from './zip.ts'
import { ExportDependencyMissingError, PortabilityConflictError, SensitiveExportBlockedError } from './errors.ts'
import type { PortabilityManifest } from './manifest.ts'

export interface SharedRootBinding {
  rootId: string
  rootPath: string
}

export interface ExportOptions {
  /** Machine binding: rootId → absolute skills root. */
  roots: SharedRootBinding[]
  /** Host-side secret scan hook; runs over every packaged text file. */
  scanForSecrets?: (text: string) => string[]
  exportedAt?: string
}

export interface ExportResult {
  archive: Buffer
  manifest: PortabilityManifest
  revision: DefinitionRevision
  /** Shared refIds rewritten to package-internal paths. */
  materializedSkills: Record<string, string>
}

interface CollectedFile {
  path: string
  bytes: Buffer
}

function walkTree(root: string, prefix: string): CollectedFile[] {
  const out: CollectedFile[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new PortabilityConflictError(`shared skill tree contains a symlink (${relative(root, full)}) — export requires ordinary files`)
      }
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        out.push({ path: `${prefix}/${relative(root, full).split(sep).join('/')}`, bytes: readFileSync(full) })
      }
    }
  }
  walk(root)
  return out
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Export one blueprint root into a portable archive. */
export function exportBlueprint(rootDir: string, options: ExportOptions): ExportResult {
  const root = resolve(rootDir)
  const text = readFileSync(join(root, 'blueprint.json'), 'utf8')
  const definition = decodeDefinition(text)
  validateDefinition(definition)

  const admission = admitResources(definition.resources)
  if (admission.length > 0) {
    throw new PortabilityConflictError(`resource admission failed: ${admission.map(i => `${i.code}:${i.refId ?? ''}`).join(', ')}`)
  }

  const files = new Map<string, CollectedFile>()
  const packaged: BlueprintDefinition = JSON.parse(text) as BlueprintDefinition
  const materializedSkills: Record<string, string> = {}
  const runDependencies: string[] = []
  const requiredBindings: string[] = []

  // Package resources (+ subflow definition closures, one level per declared
  // subflow ref; recursion is bounded by the definition's own reference graph).
  const packagePaths = new Set<string>()
  const visitDefinition = (def: BlueprintDefinition, defRoot: string, defPrefix: string, depth: number): void => {
    if (depth > 8) throw new PortabilityConflictError('subflow nesting exceeds the supported depth')
    for (const [refId, ref] of Object.entries(def.resources)) {
      if (ref.kind === 'mcp') {
        if (typeof ref.bindingId === 'string' && !requiredBindings.includes(ref.bindingId)) requiredBindings.push(ref.bindingId)
        continue
      }
      if (ref.source?.kind === 'shared') {
        const shared = ref.source
        const binding = options.roots.find(r => r.rootId === shared.rootId)
        if (binding === undefined) {
          throw new ExportDependencyMissingError(refId, `rootId "${ref.source.rootId}" is not bound on this machine`)
        }
        const skillDir = join(binding.rootPath, ref.source.path)
        if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
          throw new ExportDependencyMissingError(refId, `skill "${ref.source.path}" not found under root "${ref.source.rootId}"`)
        }
        const target = `lib/skills/${refId}`
        for (const file of walkTree(skillDir, target)) {
          if (files.has(file.path)) throw new PortabilityConflictError(`duplicate packaged path ${file.path}`)
          files.set(file.path, file)
        }
        materializedSkills[refId] = target
        const packagedRef = packaged.resources[refId]!
        delete (packagedRef as { source?: unknown }).source
        packagedRef.kind = 'skill'
        packagedRef.path = target
        continue
      }
      if (typeof ref.path !== 'string') continue
      const absolute = join(defRoot, ref.path)
      if (!existsSync(absolute)) {
        throw new ExportDependencyMissingError(refId, `package file missing: ${ref.path}`)
      }
      const stat = statSync(absolute)
      const prefixed = defPrefix === '' ? ref.path : `${defPrefix}/${ref.path}`
      if (stat.isDirectory()) {
        for (const file of walkTree(absolute, prefixed)) {
          if (files.has(file.path)) throw new PortabilityConflictError(`duplicate packaged path ${file.path}`)
          files.set(file.path, file)
        }
      } else {
        if (files.has(prefixed)) throw new PortabilityConflictError(`duplicate packaged path ${prefixed}`)
        files.set(prefixed, { path: prefixed, bytes: readFileSync(absolute) })
      }
      packagePaths.add(prefixed)
      if (ref.kind === 'script') {
        runDependencies.push(`${refId}:script:${prefixed}`)
      }
    }
  }

  // Root definition first, then declared subflows packaged under lib/subflows/<id>/.
  visitDefinition(definition, root, '', 0)
  for (const [refId, ref] of Object.entries(definition.resources)) {
    if (ref.kind !== 'subflow' || typeof ref.path !== 'string') continue
    const subflowRoot = join(root, ref.path)
    const subflowJson = join(subflowRoot, 'blueprint.json')
    if (!existsSync(subflowJson)) {
      throw new ExportDependencyMissingError(refId, `subflow has no blueprint.json: ${ref.path}`)
    }
    const subDefinition = decodeDefinition(readFileSync(subflowJson, 'utf8'))
    // The subflow definition travels as its own blueprint.json inside the package.
    const subDefPath = `${ref.path}/blueprint.json`
    files.set(subDefPath, { path: subDefPath, bytes: readFileSync(subflowJson) })
    visitDefinition(subDefinition, subflowRoot, ref.path, 1)
  }

  // The rewritten root definition is the package's entry file.
  const packagedJson = `${JSON.stringify(packaged, null, 2)}\n`
  files.set('blueprint.json', { path: 'blueprint.json', bytes: Buffer.from(packagedJson) })

  // Secret scan over packaged text (data-only; a finding blocks the export).
  if (options.scanForSecrets !== undefined) {
    const findings: Array<{ path: string; issue: string }> = []
    for (const file of files.values()) {
      const probe = file.bytes.subarray(0, Math.min(file.bytes.length, 256 * 1024)).toString('utf8')
      for (const issue of options.scanForSecrets(probe)) findings.push({ path: file.path, issue })
    }
    if (findings.length > 0) throw new SensitiveExportBlockedError(findings)
  }

  const revision = computeRevision({ rootDir: root, definition })
  const manifestFiles: Record<string, string> = {}
  for (const [path, file] of [...files.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    manifestFiles[path] = sha256(file.bytes)
  }
  const closureDigest = sha256(Object.entries(manifestFiles).map(([p, d]) => `${p}\u0000${d}\n`).join(''))
  const manifest: PortabilityManifest = {
    schemaVersion: 1,
    blueprintId: definition.id,
    semanticRevision: revision.semantic,
    files: manifestFiles,
    requiredBindings,
    runDependencies,
    closureDigest,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
  }
  const archive = writeZipWithManifest(files, manifest)
  return { archive, manifest, revision, materializedSkills }
}

/** The manifest travels beside blueprint.json inside the same container. */
export function writeZipWithManifest(files: Map<string, CollectedFile>, manifest: PortabilityManifest): Buffer {
  const entries: ZipEntryInput[] = [...files.values()].map(f => ({ name: f.path, data: f.bytes }))
  entries.push({ name: 'portability.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) })
  return writeZip(entries)
}

export type { ResourceRef }
