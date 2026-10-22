import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { decodeDefinition } from '../definition/codec.ts'
import { blueprintReferenceKey, resolveBlueprintClosure } from '../definition/composition.ts'
import { loadDefinitionPackage, type DefinitionPackage } from '../definition/persist.ts'
import type { BlueprintReference } from '../definition/types.ts'
import { computeRevision } from '../definition/revision.ts'
import { readZip } from './zip.ts'
import { writeZipWithManifest, type ExportOptions, type ExportResult } from './export.ts'
import { PortabilityConflictError } from './errors.ts'
import { BLUEPRINT_DEPENDENCIES, packagedReferenceLoader, readPackagedDefinition, validatePackagedClosure } from './packaged-reference.ts'

/** Rewrite references only in the portable copy, after each child's resources
 * have been materialized. Publishing the resulting root remains one rename. */
export function exportComposition(rootDir: string, options: ExportOptions, exportSingle: (root: string, options: ExportOptions) => ExportResult): ExportResult {
  const root = loadDefinitionPackage(rootDir)
  const definition = decodeDefinition(root.document.definitionJson)
  const load = packagedReferenceLoader(
    root,
    options.loadReference ??
      (() => {
        throw new PortabilityConflictError('dependency resolver unavailable')
      })
  )
  const closure = resolveBlueprintClosure(definition, load)
  const pins = new Map<string, BlueprintReference>()
  const files = new Map<string, { path: string; bytes: Buffer }>()
  const requiredBindings = new Set<string>()
  const runDependencies = new Set<string>()
  const hosts = new Map<string, { kind: 'agent' | 'skill' | 'mcp'; id: string }>()
  const staging = mkdtempSync(join(tmpdir(), 'bp-portable-closure-'))
  let rootResult: ExportResult | undefined
  try {
    const exportPackage = (snapshot: DefinitionPackage, isRoot: boolean) => {
      const current = decodeDefinition(snapshot.document.definitionJson)
      for (const node of current.graph.nodes)
        if (node.blueprintRef) {
          const pin = pins.get(blueprintReferenceKey(node.blueprintRef))
          if (!pin) throw new PortabilityConflictError('portable child order invalid')
          node.blueprintRef = pin
        }
      const directory = join(staging, snapshot.document.documentRevision)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'blueprint.json'), JSON.stringify(current))
      for (const [path, bytes] of snapshot.files) {
        const target = join(directory, path)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, bytes)
      }
      const result = exportSingle(directory, options)
      const entries = readZip(result.archive).filter(entry => entry.name !== 'portability.json')
      if (entries.some(entry => entry.name.startsWith(BLUEPRINT_DEPENDENCIES)))
        throw new PortabilityConflictError('resource overlaps bundled dependency namespace')
      const portable = readPackagedDefinition(new Map(entries.map(entry => [entry.name, entry.data])))
      const pin = { blueprintId: portable.document.blueprintId, documentRevision: portable.document.documentRevision }
      const prefix = isRoot ? '' : `${BLUEPRINT_DEPENDENCIES}${pin.documentRevision}/`
      for (const entry of entries) {
        const path = prefix + entry.name
        if (files.has(path) && !files.get(path)!.bytes.equals(entry.data)) throw new PortabilityConflictError('bundled file collision')
        files.set(path, { path, bytes: entry.data })
      }
      const scope = isRoot ? '' : `${pin.blueprintId}@${pin.documentRevision}/`
      for (const binding of result.manifest.requiredBindings) requiredBindings.add(scope + binding)
      for (const dependency of result.manifest.runDependencies) runDependencies.add(scope + dependency)
      for (const host of result.manifest.hostResources ?? []) hosts.set(JSON.stringify([host.kind, host.id]), host)
      if (isRoot) rootResult = result
      else pins.set(blueprintReferenceKey({ blueprintId: snapshot.document.blueprintId, documentRevision: snapshot.document.documentRevision }), pin)
    }
    for (const snapshot of closure.values()) exportPackage(snapshot, false)
    exportPackage(root, true)
    const manifestFiles = Object.fromEntries(
      [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, file]) => [path, createHash('sha256').update(file.bytes).digest('hex')])
    )
    const revision = computeRevision({ rootDir, definition })
    const manifest = {
      ...rootResult!.manifest,
      semanticRevision: revision.semantic,
      files: manifestFiles,
      requiredBindings: [...requiredBindings],
      runDependencies: [...runDependencies],
      ...(hosts.size ? { hostResources: [...hosts.values()] } : {}),
      closureDigest: createHash('sha256')
        .update(
          Object.entries(manifestFiles)
            .map(([path, digest]) => `${path}\0${digest}\n`)
            .join('')
        )
        .digest('hex')
    }
    validatePackagedClosure(readPackagedDefinition(new Map([...files].map(([path, file]) => [path, file.bytes]))))
    return { ...rootResult!, archive: writeZipWithManifest(files, manifest), manifest, revision }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}
