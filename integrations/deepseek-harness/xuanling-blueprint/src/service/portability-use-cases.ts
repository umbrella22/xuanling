import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { DefinitionPackage } from '../definition/persist.ts'
import type { BlueprintDocumentLibrary } from './document-library.ts'
import { readZip } from '../portability/zip.ts'
import { exportBlueprint, importBlueprint } from '../portability/index.ts'
import { resolveHostExportResources } from '../portability/host-resources.ts'
import { resolveResource, type SkillRoot } from '../resources/resolver.ts'
import { snapshotDirectory } from '../resources/index.ts'
import type { BlueprintDefinition } from '../definition/types.ts'

export interface PortabilityUseCaseContext {
  readonly ctx: Context
  readonly skillRoots: () => SkillRoot[] | undefined
  readonly documents: BlueprintDocumentLibrary
  readonly blueprintRoot: (blueprintId: string) => string
  readonly decodeOrThrow: (definitionJson: string) => BlueprintDefinition
  readonly checkArgs: (method: string, args: unknown) => void
  readonly checkResources: (definition: BlueprintDefinition) => void
  readonly materializePackage: (snapshot: DefinitionPackage, root: string) => void
  readonly portabilityFailure: (method: 'export' | 'import', error: unknown) => RemoteError
}

export interface ConfiguredExportResult {
  blueprintId: string
  closureDigest: string
  files: number
  archiveSha256: string
  archiveBase64: string
  requiredBindings: string[]
}

export interface InternalExportResult {
  blueprintId: string
  closureDigest: string
  files: number
  archiveSha256: string
  archivePath: string | null
  requiredBindings: string[]
}

/** Owns package export/import policy, while the public façade keeps the wire
 * overloads and argument codec. It receives the canonical document callbacks
 * so portable bytes are still materialized from the same checked snapshot. */
export class BlueprintPortabilityUseCases {
  constructor(private readonly context: PortabilityUseCaseContext) {}

  async exportConfigured(args: { blueprintId: string }): Promise<ConfiguredExportResult> {
    this.context.checkArgs('exportDefinition', args)
    const root = this.context.blueprintRoot(args.blueprintId)
    return await this.context.documents.withDocument(root, async () => {
      const snapshot = this.context.documents.loadConfiguredPackage(args.blueprintId, root)
      const { document, files } = snapshot
      const definition = this.context.decodeOrThrow(document.definitionJson)
      let staging: string | undefined
      try {
        staging = mkdtempSync(join(tmpdir(), 'bp-export-bytes-'))
        const packageRoot = join(staging, 'package')
        this.context.materializePackage(snapshot, packageRoot)
        const definitions = [definition]
        for (const ref of Object.values(definition.resources)) {
          if (ref.kind === 'subflow' && ref.path) {
            const bytes = files.get(`${ref.path}/blueprint.json`)
            if (!bytes) throw new Error('subflow unavailable')
            definitions.push(this.context.decodeOrThrow(bytes.toString('utf8')))
          }
        }
        const roots = new Map<string, SkillRoot>()
        for (const def of definitions) {
          for (const [id, ref] of Object.entries(def.resources)) {
            if (ref.source?.kind !== 'shared') continue
            const resource = await resolveResource(id, { kind: ref.kind, source: ref.source }, { blueprintRoot: root, roots: this.context.skillRoots() ?? [] })
            if (resource.kind !== 'shared-skill') throw new Error('Skill unavailable')
            const resourceSnapshot = snapshotDirectory(resource.skillDir, {
              kind: 'shared-skill',
              rootId: resource.rootId,
              skillDir: resource.skillDir,
              skillName: resource.skillName
            })
            const rootPath = join(staging, 'roots', resource.rootId)
            roots.set(resource.rootId, { rootId: resource.rootId, rootPath })
            for (const file of resourceSnapshot.files) {
              const target = join(rootPath, resource.skillName, file.path)
              mkdirSync(dirname(target), { recursive: true })
              writeFileSync(target, file.bytes)
            }
          }
        }
        const hostResources = await resolveHostExportResources(this.context.ctx, definitions, process.cwd())
        const result = exportBlueprint(packageRoot, { roots: [...roots.values()], hostResources })
        return {
          blueprintId: args.blueprintId,
          closureDigest: result.manifest.closureDigest,
          files: Object.keys(result.manifest.files).length,
          archiveSha256: createHash('sha256').update(result.archive).digest('hex'),
          archiveBase64: result.archive.toString('base64'),
          requiredBindings: result.manifest.requiredBindings
        }
      } catch (error) {
        throw this.context.portabilityFailure('export', error)
      } finally {
        if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
      }
    })
  }

  async importConfigured(args: { blueprintId: string; archiveBase64: string }): Promise<{ blueprintId: string; filesWritten: number; closureDigest: string }> {
    this.context.checkArgs('importDefinition', args)
    const root = this.context.blueprintRoot(args.blueprintId)
    return await this.context.documents.withDocument(
      root,
      () => {
        this.context.documents.assertDefinitionActive(args.blueprintId)
        try {
          const archive = Buffer.from(args.archiveBase64, 'base64')
          if (archive.toString('base64') !== args.archiveBase64) throw new Error('invalid archive encoding')
          const definitionEntry = readZip(archive).find(entry => entry.name === 'blueprint.json')
          if (!definitionEntry) throw new Error('missing definition')
          const definition = this.context.decodeOrThrow(definitionEntry.data.toString('utf8'))
          this.context.checkResources(definition)
          if (definition.id !== args.blueprintId) throw new Error('configured ID mismatch')
          const target = existsSync(root) ? realpathSync(root) : root
          const result = importBlueprint(archive, target, { allowExisting: true })
          return { blueprintId: args.blueprintId, filesWritten: result.filesWritten.length, closureDigest: result.manifest.closureDigest }
        } catch (error) {
          throw this.context.portabilityFailure('import', error)
        }
      },
      true
    )
  }

  async exportInternal(args: { blueprintId: string; rootDir: string; runtimeRoot?: string; outPath?: string }): Promise<InternalExportResult> {
    const runtimeRoot = args.runtimeRoot ?? join(tmpdir(), 'bp-runtime-default')
    const bindingsFile = join(runtimeRoot, 'root-bindings.json')
    let roots: Array<{ rootId: string; rootPath: string }> = []
    if (existsSync(bindingsFile)) {
      try {
        const parsed = JSON.parse(readFileSync(bindingsFile, 'utf8')) as { roots?: Array<{ rootId: string; rootPath: string }> }
        roots = parsed.roots ?? []
      } catch {
        roots = []
      }
    }
    try {
      const definition = this.context.decodeOrThrow(readFileSync(join(args.rootDir, 'blueprint.json'), 'utf8'))
      const definitions = [definition]
      for (const ref of Object.values(definition.resources)) {
        const path = ref.path ?? (ref.source?.kind === 'package' ? ref.source.path : undefined)
        if (ref.kind === 'subflow' && path) definitions.push(this.context.decodeOrThrow(readFileSync(join(args.rootDir, path, 'blueprint.json'), 'utf8')))
      }
      const hostResources = await resolveHostExportResources(this.context.ctx, definitions, process.cwd())
      const result = exportBlueprint(args.rootDir, { roots, hostResources })
      const archiveSha256 = createHash('sha256').update(result.archive).digest('hex')
      let archivePath: string | null = null
      if (args.outPath !== undefined) {
        writeFileSync(args.outPath, result.archive)
        archivePath = args.outPath
      }
      return {
        blueprintId: result.manifest.blueprintId,
        closureDigest: result.manifest.closureDigest,
        files: Object.keys(result.manifest.files).length,
        archiveSha256,
        archivePath,
        requiredBindings: result.manifest.requiredBindings
      }
    } catch (error) {
      throw this.context.portabilityFailure('export', error)
    }
  }

  async importInternal(args: {
    archivePath: string
    targetDir?: string
  }): Promise<{ targetDir: string; blueprintId: string; filesWritten: number; closureDigest: string }> {
    try {
      if (!existsSync(args.archivePath)) {
        throw new RemoteError('blueprint/import-failed', `archive not found: ${args.archivePath}`, { detail: args.archivePath, code: 'ENOENT' })
      }
      const target = args.targetDir ?? join(dirname(args.archivePath), 'imported-blueprint')
      const result = importBlueprint(readFileSync(args.archivePath), target)
      return {
        targetDir: result.targetDir,
        blueprintId: result.manifest.blueprintId,
        filesWritten: result.filesWritten.length,
        closureDigest: result.manifest.closureDigest
      }
    } catch (error) {
      if (error instanceof RemoteError) throw error
      const code = error instanceof Error && 'code' in error ? String((error as { code: string }).code) : 'UNKNOWN'
      throw new RemoteError('blueprint/import-failed', String((error as Error).message).slice(0, 400), {
        detail: String((error as Error).message).slice(0, 400),
        code
      })
    }
  }
}
