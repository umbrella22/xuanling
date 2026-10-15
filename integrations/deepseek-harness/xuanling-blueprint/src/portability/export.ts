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
import { hostExportKey, validatePackagedMcp, validatePackagedPreset, type HostExportResources } from './host-resources.ts'
import { admitSnapshotPaths } from '../security/resource-admission.ts'

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
  /** Server-side provenance and frozen safe custom artifacts, resolved only
   * for this explicit export. Absence never authorizes omitting a Host ref. */
  hostResources?: HostExportResources
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
  const hostResources: Array<{ kind: 'agent' | 'skill' | 'mcp'; id: string }> = []
  const addRequiredBinding = (binding: string): void => {
    if (!requiredBindings.includes(binding)) requiredBindings.push(binding)
  }

  // Package resources (+ subflow definition closures, one level per declared
  // subflow ref; recursion is bounded by the definition's own reference graph).
  const packagePaths = new Set<string>()
  const visitDefinition = (def: BlueprintDefinition, defRoot: string, defPrefix: string, depth: number): void => {
    if (depth > 8) throw new PortabilityConflictError('subflow nesting exceeds the supported depth')
    for (const [refId, ref] of Object.entries(def.resources)) {
      const source = ref.source
      if (source?.kind === 'host') {
        const id = source.id
        if (typeof id !== 'string' || id.length === 0) throw new PortabilityConflictError(`Host resource ${refId} has no stable identity`)
        if (ref.kind !== 'agent' && ref.kind !== 'skill' && ref.kind !== 'mcp')
          throw new PortabilityConflictError(`Host resource ${refId} has unsupported kind`)
        const resolved = options.hostResources?.get(hostExportKey(ref.kind, id))
        if (resolved === undefined) throw new ExportDependencyMissingError(refId, 'Host export provenance unavailable')
        if (resolved.provenance === 'builtin') {
          if (!hostResources.some(row => row.kind === ref.kind && row.id === id)) hostResources.push({ kind: ref.kind, id })
          if (ref.kind === 'mcp' && ref.bindingId && !requiredBindings.includes(ref.bindingId)) requiredBindings.push(ref.bindingId)
          continue
        }
        if (resolved.kind !== ref.kind) throw new PortabilityConflictError('Host export resource kind mismatch')
        const stem = defPrefix === '' ? `lib/host-resources/${refId}` : `${defPrefix}/lib/host-resources/${refId}`
        if (resolved.kind === 'skill') {
          if (admitSnapshotPaths(resolved.files.map(file => file.path)).length) throw new PortabilityConflictError('Host Skill paths rejected')
          for (const file of resolved.files) {
            const path = `${stem}/${file.path}`
            if (files.has(path)) throw new PortabilityConflictError('Host Skill archive path collision')
            files.set(path, { path, bytes: file.bytes })
          }
          delete ref.source
          ref.path = `lib/host-resources/${refId}`
          materializedSkills[refId] = stem
        } else {
          const path = `${stem}.json`
          const artifact = resolved.kind === 'agent' ? validatePackagedPreset(resolved.preset) : validatePackagedMcp(resolved.definition)
          if (files.has(path)) throw new PortabilityConflictError('Host artifact archive path collision')
          files.set(path, { path, bytes: Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`) })
          delete ref.source
          ref.path = `lib/host-resources/${refId}.json`
          ref.format = resolved.kind === 'agent' ? 'agent-preset' : 'mcp-definition'
          for (const field of artifact.requiredBindings) addRequiredBinding(`${refId}:${field}`)
          if (resolved.kind === 'mcp' && ref.bindingId) addRequiredBinding(ref.bindingId)
        }
        continue
      }
      if (ref.kind === 'mcp' && ref.format !== 'mcp-definition') {
        if (typeof ref.bindingId === 'string') addRequiredBinding(ref.bindingId)
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
        const packagedRef = ref
        delete (packagedRef as { source?: unknown }).source
        packagedRef.kind = 'skill'
        packagedRef.path = target
        continue
      }
      const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
      if (typeof path !== 'string') continue
      const absolute = join(defRoot, path)
      if (!existsSync(absolute)) {
        throw new ExportDependencyMissingError(refId, `package file missing: ${path}`)
      }
      const stat = statSync(absolute)
      const prefixed = defPrefix === '' ? path : `${defPrefix}/${path}`
      if (stat.isDirectory()) {
        for (const file of walkTree(absolute, prefixed)) {
          if (files.has(file.path)) throw new PortabilityConflictError(`duplicate packaged path ${file.path}`)
          files.set(file.path, file)
        }
      } else {
        if (files.has(prefixed)) throw new PortabilityConflictError(`duplicate packaged path ${prefixed}`)
        const bytes = readFileSync(absolute)
        files.set(prefixed, { path: prefixed, bytes })
        // Imported Host artifacts are ordinary package files. Reconstruct the
        // manifest requirements from their validated contents so an
        // export->import->export cycle preserves destination bindings.
        if (ref.format === 'agent-preset' || ref.format === 'mcp-definition') {
          let artifact: ReturnType<typeof validatePackagedPreset> | ReturnType<typeof validatePackagedMcp>
          try {
            artifact =
              ref.format === 'agent-preset'
                ? validatePackagedPreset(JSON.parse(bytes.toString('utf8')))
                : validatePackagedMcp(JSON.parse(bytes.toString('utf8')))
          } catch {
            throw new PortabilityConflictError(`packaged ${ref.format} artifact is invalid (${prefixed})`)
          }
          for (const field of artifact.requiredBindings) addRequiredBinding(`${refId}:${field}`)
          if (ref.format === 'mcp-definition' && typeof ref.bindingId === 'string') addRequiredBinding(ref.bindingId)
        }
      }
      packagePaths.add(prefixed)
      if (ref.kind === 'script') {
        runDependencies.push(`${refId}:script:${prefixed}`)
      }
    }
  }

  // Root definition first, then declared subflows packaged under lib/subflows/<id>/.
  visitDefinition(packaged, root, '', 0)
  for (const [refId, ref] of Object.entries(definition.resources)) {
    const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
    if (ref.kind !== 'subflow' || typeof path !== 'string') continue
    const subflowRoot = join(root, path)
    const subflowJson = join(subflowRoot, 'blueprint.json')
    if (!existsSync(subflowJson)) {
      throw new ExportDependencyMissingError(refId, `subflow has no blueprint.json: ${path}`)
    }
    const subDefinition = decodeDefinition(readFileSync(subflowJson, 'utf8'))
    // The subflow definition travels as its own blueprint.json inside the package.
    const subDefPath = `${path}/blueprint.json`
    visitDefinition(subDefinition, subflowRoot, path, 1)
    files.set(subDefPath, { path: subDefPath, bytes: Buffer.from(`${JSON.stringify(subDefinition, null, 2)}\n`) })
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
  for (const [path, file] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    manifestFiles[path] = sha256(file.bytes)
  }
  const closureDigest = sha256(
    Object.entries(manifestFiles)
      .map(([p, d]) => `${p}\u0000${d}\n`)
      .join('')
  )
  const manifest: PortabilityManifest = {
    schemaVersion: 1,
    blueprintId: definition.id,
    semanticRevision: revision.semantic,
    files: manifestFiles,
    requiredBindings,
    ...(hostResources.length === 0 ? {} : { hostResources }),
    runDependencies,
    closureDigest,
    exportedAt: options.exportedAt ?? new Date().toISOString()
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
