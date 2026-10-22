import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createdBlueprintId } from '../definition/library.ts'
import { authoringGuide, inputDescription, validateCandidate, type AuthoringCandidate } from '../definition/authoring.ts'
import { canonicalJson } from '../definition/document.ts'
import type { RunSource } from '../conversation/contracts.ts'
import { listHostResources, hostResourceCatalogValue, type HostResourceCatalogValue } from '../host/resource-catalog.ts'
import type { ToolBindings } from '../host/preflight.ts'
import type { BlueprintDocumentLibrary } from './document-library.ts'
import type { DefinitionDocument } from '../definition/persist.ts'
import type { BlueprintDefinition } from '../definition/types.ts'

export interface DefinitionUseCaseConfig {
  readonly workspaceRoot?: string
  readonly toolBindings?: ToolBindings
}

export interface DefinitionUseCaseContext {
  readonly ctx: Context
  readonly config: DefinitionUseCaseConfig
  readonly documents: BlueprintDocumentLibrary
  readonly workspaceWorkflowRoot: () => string | undefined
  readonly configuredRuntimeRoot?: () => string
  readonly blueprintRoot: (blueprintId: string) => string
  readonly decodeOrThrow: (definitionJson: string) => BlueprintDefinition
  readonly checkResources: (definition: BlueprintDefinition) => void
  readonly checkArgs: (method: string, args: unknown) => void
  readonly revisionConflict: (blueprintId: string, expectedRevision: string | null, actualRevision: string | null) => RemoteError
  readonly documentFailure: (blueprintId: string, operation: string, error: unknown) => RemoteError
}

/** Definition and resource authoring use cases behind the public RPC façade.
 *
 * The collaborator owns the authoring/library policy while BlueprintService
 * retains runtime acquisition and the public method names. All callbacks point
 * back to the façade's canonical validation and path policy, so this extraction
 * cannot create a second definition or revision authority.
 */
export class BlueprintDefinitionUseCases {
  constructor(private readonly context: DefinitionUseCaseContext) {}

  async listDefinitions(): Promise<{
    definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }>
  }> {
    const { documents, workspaceWorkflowRoot, blueprintRoot, decodeOrThrow } = this.context
    const definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }> = []
    const library = workspaceWorkflowRoot()
    let managed: string[] = []
    try {
      if (library) managed = documents.libraryIds(library).filter(id => existsSync(join(library, id, 'blueprint.json')))
    } catch {
      throw new RemoteError('blueprint/definition-write-failed', 'library read failed', {
        blueprintId: 'library',
        operation: 'list',
        reason: 'package-read-failed'
      })
    }
    for (const blueprintId of managed.sort()) {
      if (documents.readDeletion(blueprintId)) continue
      const root = blueprintRoot(blueprintId)
      const item = await documents.withDocument(root, () => {
        try {
          const document = documents.loadConfigured(blueprintId, root)
          return {
            blueprintId,
            name: decodeOrThrow(document.definitionJson).name,
            documentRevision: document.documentRevision,
            semanticRevision: document.semanticRevision
          }
        } catch (error) {
          if (error instanceof RemoteError && error.code === 'blueprint/definition-deleted') return null
          if (error instanceof RemoteError && error.code === 'blueprint/definition-not-found')
            return { blueprintId, name: blueprintId, documentRevision: null, semanticRevision: null }
          throw error
        }
      })
      if (item) definitions.push(item)
    }
    return { definitions }
  }

  async loadDefinition(args: { blueprintId: string }): Promise<DefinitionDocument> {
    this.context.checkArgs('loadDefinition', args)
    const root = this.context.blueprintRoot(args.blueprintId)
    return await this.context.documents.withDocument(root, () => this.context.documents.loadConfigured(args.blueprintId, root))
  }

  /** First save: request identity makes an uncertain response retryable after restart. */
  async createDefinition(args: { requestId: string; definitionJson: string }): Promise<DefinitionDocument> {
    const { documents, workspaceWorkflowRoot, decodeOrThrow, checkResources, revisionConflict, documentFailure } = this.context
    this.context.checkArgs('createDefinition', args)
    const library = workspaceWorkflowRoot()
    if (!library)
      throw new RemoteError('blueprint/capability-unavailable', 'library root unavailable', {
        method: 'createDefinition',
        plugin: '@xuanling-rs/xuanling-dsh-blueprint',
        version: '0.7.0'
      })
    const id = createdBlueprintId(args.requestId)
    const definition = decodeOrThrow(args.definitionJson)
    definition.id = id
    checkResources(definition)
    try {
      const root = documents.libraryDocumentRoot(library, id)!
      return await documents.withDocument(
        root,
        () => {
          documents.libraryDocumentRoot(library, id)
          try {
            const stored = documents.loadConfigured(id, root)
            if (canonicalJson(decodeOrThrow(stored.definitionJson)) !== canonicalJson(definition)) throw revisionConflict(id, null, stored.documentRevision)
            return stored
          } catch (error) {
            if (!(error instanceof RemoteError && error.code === 'blueprint/definition-not-found')) throw error
          }
          try {
            documents.readPackageFiles(root, definition)
          } catch {
            throw new RemoteError('blueprint/definition-invalid', 'new blueprint resources unavailable', { issues: 'resource-unavailable' })
          }
          return documents.saveDefinitionDocument(root, definition, null)
        },
        true
      )
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw documentFailure(id, 'create', error)
    }
  }

  async deleteDefinition(args: { blueprintId: string; expectedRevision: string; requestId: string }): Promise<{ blueprintId: string; deleted: true }> {
    const { documents, workspaceWorkflowRoot, blueprintRoot, revisionConflict, documentFailure } = this.context
    this.context.checkArgs('deleteDefinition', args)
    if (!workspaceWorkflowRoot())
      throw new RemoteError('blueprint/capability-unavailable', 'library unavailable', {
        method: 'deleteDefinition',
        plugin: '@xuanling-rs/xuanling-dsh-blueprint',
        version: '0.7.0'
      })
    const replay = () => {
      const deleted = documents.readDeletion(args.blueprintId)
      if (!deleted) return undefined
      if (deleted.requestId !== args.requestId || deleted.documentRevision !== args.expectedRevision)
        throw revisionConflict(args.blueprintId, args.expectedRevision, null)
      return { blueprintId: args.blueprintId, deleted: true as const }
    }
    const prior = replay()
    if (prior) return prior
    const root = blueprintRoot(args.blueprintId)
    return documents.withDocument(
      root,
      () => {
        const prior = replay()
        if (prior) return prior
        const document = documents.loadConfigured(args.blueprintId, root)
        if (document.documentRevision !== args.expectedRevision) throw revisionConflict(args.blueprintId, args.expectedRevision, document.documentRevision)
        try {
          documents.writeLibraryDeletion(workspaceWorkflowRoot()!, {
            stateVersion: 1,
            blueprintId: args.blueprintId,
            documentRevision: args.expectedRevision,
            requestId: args.requestId,
            deletedAt: Date.now()
          })
        } catch (error) {
          throw documentFailure(args.blueprintId, 'delete', error)
        }
        return { blueprintId: args.blueprintId, deleted: true as const }
      },
      true
    )
  }

  async listResources(): Promise<{ resources: HostResourceCatalogValue[] }> {
    return hostResourceCatalogValue(await listHostResources(this.context.ctx, { cwd: process.cwd() }))
  }

  async describeBlueprint(blueprintId?: string) {
    const resourceCatalog = (await this.listResources()).resources
    if (blueprintId !== undefined) {
      const document = await this.loadDefinition({ blueprintId })
      const definition = this.context.decodeOrThrow(document.definitionJson)
      return { ...document, definition, input: inputDescription(definition), resources: Object.keys(definition.resources), resourceCatalog }
    }
    let runtimeAvailable = true
    try {
      this.context.configuredRuntimeRoot?.()
    } catch {
      runtimeAvailable = false
    }
    return {
      ...authoringGuide(),
      runtimeAvailable,
      resourceCatalog,
      toolBindings: Object.entries(this.context.config.toolBindings ?? {}).map(([bindingId, binding]) => ({ bindingId, tools: binding.tools }))
    }
  }

  async validateBlueprint(candidate: AuthoringCandidate) {
    const result = validateCandidate(candidate)
    return result.ok ? { ok: true, input: inputDescription(result.definition) } : result
  }

  async createBlueprint(candidate: AuthoringCandidate, requestId: string, source: RunSource, signal?: AbortSignal): Promise<DefinitionDocument> {
    const { documents, workspaceWorkflowRoot, decodeOrThrow, revisionConflict, documentFailure } = this.context
    signal?.throwIfAborted()
    const result = validateCandidate(candidate)
    if (!result.ok)
      throw new RemoteError('blueprint/definition-invalid', 'candidate rejected; use blueprint_validate for issues', {
        issues: result.issues.map(issue => issue.code).join('; ')
      })
    const library = workspaceWorkflowRoot()
    if (!library)
      throw new RemoteError('blueprint/capability-unavailable', 'library unavailable', {
        method: 'createBlueprint',
        plugin: '@xuanling-rs/xuanling-dsh-blueprint',
        version: '0.7.0'
      })
    const id = createdBlueprintId(JSON.stringify([source.sessionId, requestId]))
    const definition = { ...result.definition, id }
    const root = documents.libraryDocumentRoot(library, id)!
    return await documents.withDocument(
      root,
      () => {
        documents.libraryDocumentRoot(library, id)
        try {
          const stored = documents.loadConfiguredPackage(id, root)
          const sameFiles =
            stored.files.size === candidate.files.length && candidate.files.every(file => stored.files.get(file.path)?.equals(Buffer.from(file.text)))
          if (!sameFiles || canonicalJson(decodeOrThrow(stored.document.definitionJson)) !== canonicalJson(definition))
            throw revisionConflict(id, null, stored.document.documentRevision)
          return stored.document
        } catch (error) {
          if (!(error instanceof RemoteError && error.code === 'blueprint/definition-not-found')) throw error
        }
        signal?.throwIfAborted()
        try {
          return documents.publishPackage(root, definition, candidate.files)
        } catch (error) {
          throw documentFailure(id, 'create', error)
        }
      },
      true
    )
  }

  async saveDefinition(args: { blueprintId: string; definitionJson: string; expectedRevision: string | null }): Promise<DefinitionDocument> {
    const { documents, blueprintRoot, decodeOrThrow, checkResources, documentFailure } = this.context
    this.context.checkArgs('saveDefinition', args)
    const root = blueprintRoot(args.blueprintId)
    const definition = decodeOrThrow(args.definitionJson)
    checkResources(definition)
    if (definition.id !== args.blueprintId)
      throw new RemoteError('blueprint/definition-invalid', 'configured ID does not match definition', { issues: 'blueprint-id-mismatch' })
    return await documents.withDocument(
      root,
      () => {
        try {
          documents.loadConfigured(args.blueprintId, root)
        } catch (error) {
          if (!(error instanceof RemoteError && error.code === 'blueprint/definition-not-found')) throw error
        }
        try {
          return documents.saveDefinitionDocument(root, definition, args.expectedRevision)
        } catch (error) {
          throw documentFailure(args.blueprintId, 'save', error)
        }
      },
      true
    )
  }
}
