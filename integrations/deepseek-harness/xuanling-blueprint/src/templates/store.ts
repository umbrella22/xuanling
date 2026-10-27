/** Global template store. Templates live beside the global library, never in a
 * `.xuanling/workflows` document directory, and are never executed directly. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { scanResiduals } from './extraction.ts'
import { WriterLease } from '../persistence/lease.ts'
import { canonicalJson } from '../definition/document.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { assertStoragePath, fsyncDirectory, mkdirDurable } from '../persistence/durable-fs.ts'
import {
  preparationManifestCodec,
  templateCodec,
  templateSummaryCodec,
  type BlueprintTemplate,
  type PreparationManifest,
  type TemplateSummary
} from './contracts.ts'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function assertSafeId(id: string, reason: string): void {
  if (!SAFE_ID.test(id)) throw new RemoteError('blueprint/template-invalid', 'invalid template identity', { reason })
}

function atomicWrite(target: string, value: string): void {
  mkdirDurable(dirname(target))
  const temporary = `${target}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    writeFileSync(fd, value)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, target)
    fsyncDirectory(dirname(target))
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

export class BlueprintTemplateStore {
  constructor(private readonly root: string | undefined) {}

  private templateRoot(): string {
    if (this.root === undefined) throw new RemoteError('blueprint/library-unavailable', 'template store unavailable', { kind: 'global' })
    assertStoragePath(this.root, join(this.root, 'templates'))
    return join(this.root, 'templates')
  }

  save(template: BlueprintTemplate, requestId?: string): { template: BlueprintTemplate; updatedAt: string } {
    const parsed = templateCodec().parse(template)
    assertSafeId(parsed.templateId, 'invalid-id')
    const residual = scanResiduals(
      { pattern: parsed.pattern, parameters: parsed.parameters, files: (parsed.files ?? []).map(file => Buffer.from(file.base64, 'base64').toString('utf8')) },
      []
    )
    if (residual.includes('secret-pattern'))
      throw new RemoteError('blueprint/template-invalid', 'template contains a secret pattern', { reason: 'sensitive-content' })
    const root = this.templateRoot()
    const directory = join(root, parsed.templateId)
    const target = join(directory, 'template.json')
    const fingerprint = (value: BlueprintTemplate) =>
      createHash('sha256')
        .update(canonicalJson({ ...value, provenance: { ...value.provenance, extractedAt: '' } }))
        .digest('hex')
    const digest = fingerprint(parsed)
    const receipt = join(
      root,
      '.requests',
      `${createHash('sha256')
        .update(requestId ?? digest)
        .digest('hex')}.json`
    )
    const lockRoot = join(root, '.writer')
    for (const path of [target, receipt, lockRoot]) assertStoragePath(this.root!, path)
    mkdirDurable(lockRoot)
    const lease = WriterLease.acquire(lockRoot)
    try {
      let value = parsed
      let updatedAt = new Date().toISOString()
      if (existsSync(receipt)) {
        const prior = JSON.parse(readFileSync(receipt, 'utf8')) as { digest: string; template: unknown; updatedAt: string }
        if (prior.digest !== digest) throw new RemoteError('blueprint/template-invalid', 'template request conflicts', { reason: 'request-conflict' })
        value = templateCodec().parse(prior.template)
        updatedAt = prior.updatedAt
      }
      if (existsSync(target)) {
        const prior = templateCodec().parse(JSON.parse(readFileSync(target, 'utf8')))
        if (fingerprint(prior) !== digest)
          throw new RemoteError('blueprint/template-invalid', 'template identity conflicts; save as a new template', { reason: 'identity-conflict' })
        value = prior
      }
      // Receipt first: a retry can complete publication after a process crash.
      atomicWrite(receipt, JSON.stringify({ digest, template: value, updatedAt }))
      if (!existsSync(target)) atomicWrite(target, JSON.stringify(value))
      return { template: value, updatedAt }
    } finally {
      lease.release()
    }
  }

  list(): TemplateSummary[] {
    if (this.root === undefined) return []
    const root = this.templateRoot()
    let entries: string[]
    try {
      if (!lstatSync(root).isDirectory()) return []
      entries = readdirSync(root).filter(name => !name.startsWith('.'))
    } catch {
      return []
    }
    const summaries: TemplateSummary[] = []
    for (const entry of entries.slice(0, 500)) {
      const file = join(root, entry, 'template.json')
      try {
        assertStoragePath(root, file)
        if (!existsSync(file)) continue
        const template = templateCodec().parse(JSON.parse(readFileSync(file, 'utf8')))
        const stats = lstatSync(file)
        summaries.push(
          templateSummaryCodec().parse({
            templateId: template.templateId,
            name: template.name,
            parameters: template.parameters.length,
            residualNotes: template.provenance.residualNotes.length,
            updatedAt: new Date(stats.mtimeMs).toISOString()
          })
        )
      } catch {
        /* invalid templates stay invisible as assets; they are never executed */
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  load(templateId: string): BlueprintTemplate {
    assertSafeId(templateId, 'invalid-id')
    const file = join(this.templateRoot(), templateId, 'template.json')
    try {
      assertStoragePath(this.root!, file)
      return templateCodec().parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      throw new RemoteError('blueprint/asset-not-found', 'template not found', { blueprintId: templateId })
    }
  }

  static linkInstance(preparationRoot: string, blueprintId: string, preparationId: string): void {
    assertSafeId(blueprintId, 'invalid-id')
    assertSafeId(preparationId, 'invalid-preparation-id')
    const target = join(preparationRoot, '.instances', `${blueprintId}.json`)
    assertStoragePath(dirname(dirname(preparationRoot)), target)
    atomicWrite(target, JSON.stringify({ preparationId }))
  }

  /** Preparation manifests are project facts, stored beside the target library
   * rather than the global template archive. */
  static writeManifest(preparationRoot: string, manifest: PreparationManifest): PreparationManifest {
    const parsed = preparationManifestCodec().parse(manifest)
    assertSafeId(parsed.preparationId, 'invalid-preparation-id')
    const target = join(preparationRoot, `${parsed.preparationId}.json`)
    assertStoragePath(dirname(dirname(preparationRoot)), target)
    atomicWrite(target, JSON.stringify(parsed))
    return parsed
  }
}
