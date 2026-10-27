import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { libraryDocumentRoot, libraryIds } from '../definition/library.ts'
import { acquireLibraryWriter, readLibraryDeletion, writeLibraryDeletion, LibraryStateError, type LibraryDeletion } from '../definition/library-state.ts'
import { publishPackage } from '../definition/package-create.ts'
import {
  DefinitionDocumentMissingError,
  PackageBoundaryError,
  DocumentRevisionConflictError,
  loadDefinitionPackage,
  readRevision,
  readPackageFiles,
  restorePackageFiles,
  saveDefinitionDocument,
  type DefinitionDocument,
  type DefinitionPackage,
  type RevisionPackageFile
} from '../definition/persist.ts'
import type { BlueprintDefinition } from '../definition/types.ts'

export interface DocumentLibraryOptions {
  readonly managedRoot: () => string | undefined
  readonly decodeDefinition: (definitionJson: string) => BlueprintDefinition
  readonly checkResources: (definition: BlueprintDefinition) => void
  readonly documentFailure: (blueprintId: string, operation: string, error: unknown) => RemoteError
}

/** Owns physical document queues and library persistence primitives.
 *
 * BlueprintService remains the public wire façade and keeps admission,
 * validation and execution policy. This collaborator owns the shared file
 * boundary so CRUD, preflight, run admission and portability all serialize on
 * the same physical root and writer lease.
 */
export class BlueprintDocumentLibrary {
  private readonly documentTails = new Map<string, Promise<unknown>>()
  private libraryTail: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: DocumentLibraryOptions) {}

  libraryDocumentRoot(library: string, blueprintId: string): string | undefined {
    return libraryDocumentRoot(library, blueprintId)
  }

  libraryIds(library: string): string[] {
    return libraryIds(library)
  }

  readDeletion(blueprintId: string): LibraryDeletion | undefined {
    const library = this.options.managedRoot()
    try {
      return library ? readLibraryDeletion(library, blueprintId) : undefined
    } catch {
      throw new RemoteError('blueprint/library-state-invalid', 'library state unavailable', { operation: 'read' })
    }
  }

  assertDefinitionActive(blueprintId: string): void {
    if (this.readDeletion(blueprintId)) throw new RemoteError('blueprint/definition-deleted', 'definition deleted', { blueprintId })
  }

  async withDocument<T>(root: string, action: () => T | Promise<T>, mutation = false): Promise<T> {
    let key = resolve(root)
    try {
      key = realpathSync(key)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new RemoteError('blueprint/durability-failed', 'document root unavailable', { operation: 'document-open' })
    }
    const task = (this.documentTails.get(key) ?? Promise.resolve()).then(() => (mutation ? this.withLibraryMutation(action) : action()))
    const observed = task.catch(() => {})
    this.documentTails.set(key, observed)
    try {
      return await task
    } finally {
      if (this.documentTails.get(key) === observed) this.documentTails.delete(key)
    }
  }

  private withLibraryMutation<T>(action: () => T | Promise<T>): Promise<T> {
    const task = this.libraryTail.then(async () => {
      const library = this.options.managedRoot()
      if (!library) return await action()
      let lease
      try {
        lease = acquireLibraryWriter(library)
      } catch (error) {
        if (error instanceof LibraryStateError) throw new RemoteError('blueprint/library-state-invalid', 'library state unavailable', { operation: 'lock' })
        throw new RemoteError('blueprint/library-busy', 'library writer unavailable', { operation: 'lock' })
      }
      const stopHeartbeat = lease.startHeartbeat()
      try {
        return await action()
      } finally {
        stopHeartbeat()
        lease.release()
      }
    })
    this.libraryTail = task.catch(() => {})
    return task
  }

  async drainLibrary(): Promise<void> {
    await this.libraryTail
  }

  loadConfiguredPackage(blueprintId: string, root: string): DefinitionPackage {
    this.assertDefinitionActive(blueprintId)
    let snapshot: DefinitionPackage
    try {
      snapshot = loadDefinitionPackage(root)
    } catch (error) {
      throw this.options.documentFailure(blueprintId, 'load', error)
    }
    if (snapshot.document.blueprintId !== blueprintId)
      throw new RemoteError('blueprint/definition-invalid', 'configured ID does not match definition', { issues: 'blueprint-id-mismatch' })
    this.options.checkResources(this.options.decodeDefinition(snapshot.document.definitionJson))
    return snapshot
  }

  loadConfigured(blueprintId: string, root: string): DefinitionDocument {
    return this.loadConfiguredPackage(blueprintId, root).document
  }

  loadRevisionPackage(blueprintId: string, root: string, revision: string): DefinitionPackage {
    this.assertDefinitionActive(blueprintId)
    const entry = readRevision(root, revision)
    if (entry?.document.blueprintId !== blueprintId || entry.packageFiles === undefined) throw new Error('pinned package unavailable')
    const definition = this.options.decodeDefinition(entry.document.definitionJson)
    this.options.checkResources(definition)
    return { document: entry.document, files: new Map(Object.entries(entry.packageFiles).map(([path, file]) => [path, Buffer.from(file.base64, 'base64')])) }
  }

  readPackageFiles(root: string, definition: BlueprintDefinition): Map<string, Buffer> {
    return readPackageFiles(root, definition)
  }

  saveDefinitionDocument(root: string, definition: BlueprintDefinition, expectedRevision: string | null): DefinitionDocument {
    return saveDefinitionDocument(root, definition, expectedRevision)
  }

  saveDefinitionDocumentWithHistory(
    root: string,
    definition: BlueprintDefinition,
    expectedRevision: string | null,
    history: { origin?: 'canvas' | 'conversation' | 'import' | 'revert'; message?: string },
    packageFiles?: Map<string, Buffer>
  ): DefinitionDocument {
    return saveDefinitionDocument(root, definition, expectedRevision, history, packageFiles)
  }

  restorePackageFiles(root: string, packageFiles: Record<string, RevisionPackageFile>, cleanupPaths: string[] = []): void {
    restorePackageFiles(root, packageFiles, cleanupPaths)
  }

  publishPackage(root: string, definition: BlueprintDefinition, files: Array<{ path: string; text: string | Uint8Array }>): DefinitionDocument {
    return publishPackage(root, definition, files)
  }

  writeLibraryDeletion(library: string, value: LibraryDeletion): void {
    writeLibraryDeletion(library, value)
  }

  /** Expose the domain error types for callers that keep compatibility logic
   * at the wire façade while the persistence operations remain here. */
  isDocumentMissing(error: unknown): boolean {
    return error instanceof DefinitionDocumentMissingError
  }

  isRevisionConflict(error: unknown): error is DocumentRevisionConflictError {
    return error instanceof DocumentRevisionConflictError
  }

  isPackageBoundary(error: unknown): boolean {
    return error instanceof PackageBoundaryError
  }
}
