import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlueprintDocumentLibrary } from './document-library.ts'
import {
  readRevision,
  readRevisionHistory,
  type DefinitionDocument,
  type DefinitionRevisionRecord,
  type RevisionOrigin,
  type RevisionPackageFile
} from '../definition/persist.ts'
import { canonicalJson, documentRevisions } from '../definition/document.ts'
import type { BlueprintDefinition, ValidationIssue } from '../definition/types.ts'
import { validateDefinition } from '../definition/validator.ts'

export interface ApplyServiceContext {
  readonly documents: BlueprintDocumentLibrary
  readonly blueprintRoot: (workflowId: string) => string
  readonly decode: (definitionJson: string) => BlueprintDefinition
  /** Canonical catalog policy remains owned by DefinitionUseCases; ApplyService
   * delegates listing to it instead of inventing a second root/index reader. */
  readonly listDefinitions?: () => Promise<{
    definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }>
  }>
}

export interface WorkflowDiff {
  semanticChanged: boolean
  layoutChanged: boolean
  from: { documentRevision: string | null; semanticRevision: string | null; layoutRevision: string | null }
  to: { semanticRevision: string; layoutRevision: string }
}

export interface WorkflowCandidate {
  candidateId: string
  workflowId: string
  definitionJson: string
  expectedRevision: string | null
  origin: RevisionOrigin
  message?: string
  diff: WorkflowDiff
  status: 'candidate' | 'approval-required' | 'rejected'
  issues?: Array<{ code: string; pointer?: string; message?: string }>
}

export interface WorkflowApplyResult {
  status: 'applied' | 'approval-required' | 'rejected'
  workflowId: string
  candidateId: string
  diff: WorkflowDiff
  document?: DefinitionDocument
  parentRevision?: string | null
  origin: RevisionOrigin
  message?: string
  issues?: Array<{ code: string; pointer?: string; message?: string }>
}

/** Internal capability minted only by trusted host/canvas paths. It is a
 * symbol so model-authored JSON can never manufacture semantic approval. */
export const WORKFLOW_HOST_APPROVAL = Symbol('xuanling.workflow.host-approval')
type WorkflowHostApproval = typeof WORKFLOW_HOST_APPROVAL

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function issueValue(error: unknown): Array<{ code: string; pointer?: string; message?: string }> {
  const issues = (error as { issues?: ValidationIssue[] })?.issues
  if (Array.isArray(issues))
    return issues.map(issue => ({ code: issue.code, ...(issue.pointer === undefined ? {} : { pointer: issue.pointer }), message: issue.message }))
  const code = (error as { code?: unknown })?.code
  if (code === 'PACKAGE_RESOURCE_UNREADABLE') return [{ code: 'package-resource-unreadable', pointer: '/resources', message: 'package resource is unreadable' }]
  if (code === 'PACKAGE_RESOURCE_MISSING') return [{ code: 'package-resource-missing', pointer: '/resources', message: 'package resource is missing' }]
  if (code === 'PACKAGE_BOUNDARY_REJECTED')
    return [{ code: 'package-boundary-rejected', pointer: '/resources', message: 'package resource escapes the workflow root' }]
  if (code === 'ENOENT') return [{ code: 'package-resource-missing', pointer: '/resources', message: 'package resource is missing' }]
  return [{ code: 'definition-invalid', message: 'definition rejected' }]
}

function candidateFile(root: string, candidateId: string): string {
  return join(root, '.candidates', `${candidateId}.json`)
}

/** Candidates are an audit trail of proposals: no later operation reads them
 * back, so only the most recent ones are retained instead of one file per
 * proposal forever. */
export const RETAINED_CANDIDATES = 50
const CANDIDATE_NAME = /^[a-f0-9]{64}\.json$/

/** Keep the newest `keep` candidate files in `directory`; `current` (the one
 * just written) always survives even when several share an mtime. Exported
 * for tests. */
export function pruneCandidates(directory: string, keep: number, current?: string): void {
  try {
    const files = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && CANDIDATE_NAME.test(entry.name))
      .map(entry => {
        const path = join(directory, entry.name)
        return { path, mtimeMs: path === current ? Infinity : statSync(path).mtimeMs }
      })
    if (files.length <= keep) return
    files.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.path < b.path ? -1 : 1))
    for (const file of files.slice(keep)) rmSync(file.path, { force: true })
  } catch {
    // Retention is housekeeping; it never fails the proposal it follows.
  }
}

/** The sole candidate → validate → diff → CAS → history authority used by
 * conversation tools and the canvas adapter. */
export class ApplyService {
  constructor(private readonly context: ApplyServiceContext) {}

  private current(workflowId: string): DefinitionDocument | undefined {
    try {
      return this.context.documents.loadConfigured(workflowId, this.context.blueprintRoot(workflowId))
    } catch (error) {
      if ((error as { code?: string })?.code === 'DEFINITION_NOT_FOUND' || (error as { code?: string })?.code === 'blueprint/definition-not-found')
        return undefined
      throw error
    }
  }

  private validateDefinition(definitionJson: string): BlueprintDefinition {
    const definition = this.context.decode(definitionJson)
    validateDefinition(definition)
    return definition
  }

  private diff(
    workflowId: string,
    definition: BlueprintDefinition,
    current: DefinitionDocument | undefined,
    suppliedFiles?: Map<string, Buffer>
  ): WorkflowDiff {
    const bytes = suppliedFiles ?? this.context.documents.readPackageFiles(this.context.blueprintRoot(workflowId), definition)
    const files = Object.fromEntries([...bytes].map(([path, value]) => [path, createHash('sha256').update(value).digest('hex')]))
    const revisions = documentRevisions(definition, files)
    return {
      semanticChanged: current?.semanticRevision !== revisions.semanticRevision,
      layoutChanged: current?.layoutRevision !== revisions.layoutRevision,
      from: {
        documentRevision: current?.documentRevision ?? null,
        semanticRevision: current?.semanticRevision ?? null,
        layoutRevision: current?.layoutRevision ?? null
      },
      to: { semanticRevision: revisions.semanticRevision, layoutRevision: revisions.layoutRevision }
    }
  }

  private persistCandidate(root: string, candidate: WorkflowCandidate): void {
    const directory = join(root, '.candidates')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const file = candidateFile(root, candidate.candidateId)
    writeFileSync(file, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 })
    pruneCandidates(directory, RETAINED_CANDIDATES, file)
  }

  async list(): Promise<{ definitions: Array<{ blueprintId: string; name: string; documentRevision: string | null; semanticRevision: string | null }> }> {
    if (this.context.listDefinitions === undefined) throw new Error('canonical definition catalog unavailable')
    return await this.context.listDefinitions()
  }

  async get(workflowId: string): Promise<DefinitionDocument & { definition: BlueprintDefinition }> {
    const document = this.context.documents.loadConfigured(workflowId, this.context.blueprintRoot(workflowId))
    return { ...document, definition: this.context.decode(document.definitionJson) }
  }

  async validate(
    workflowId: string,
    definitionJson: string
  ): Promise<{ ok: true; diff: WorkflowDiff } | { ok: false; issues: Array<{ code: string; pointer?: string; message?: string }> }> {
    try {
      const definition = this.validateDefinition(definitionJson)
      if (definition.id !== workflowId) return { ok: false, issues: [{ code: 'workflow-id-mismatch', pointer: '/id' }] }
      const files = this.context.documents.readPackageFiles(this.context.blueprintRoot(workflowId), definition)
      return { ok: true, diff: this.diff(workflowId, definition, this.current(workflowId), files) }
    } catch (error) {
      return { ok: false, issues: issueValue(error) }
    }
  }

  private rejectedCandidate(
    args: { workflowId: string; definitionJson: string; expectedRevision: string | null; origin?: RevisionOrigin; message?: string },
    current: DefinitionDocument | undefined,
    error: unknown
  ): WorkflowCandidate {
    const candidateId = digest(`${args.workflowId}\0${args.definitionJson}\0${args.expectedRevision ?? ''}`)
    const rejected: WorkflowCandidate = {
      candidateId,
      workflowId: args.workflowId,
      definitionJson: args.definitionJson,
      expectedRevision: args.expectedRevision,
      origin: args.origin ?? 'conversation',
      ...(args.message === undefined ? {} : { message: args.message }),
      diff: {
        semanticChanged: true,
        layoutChanged: true,
        from: {
          documentRevision: current?.documentRevision ?? null,
          semanticRevision: current?.semanticRevision ?? null,
          layoutRevision: current?.layoutRevision ?? null
        },
        to: { semanticRevision: '', layoutRevision: '' }
      },
      status: 'rejected',
      issues: issueValue(error)
    }
    this.persistCandidate(this.context.blueprintRoot(args.workflowId), rejected)
    return rejected
  }

  propose(args: {
    workflowId: string
    definitionJson: string
    expectedRevision?: string | null
    origin?: RevisionOrigin
    message?: string
  }): WorkflowCandidate {
    const current = this.current(args.workflowId)
    const expectedRevision = args.expectedRevision === undefined ? (current?.documentRevision ?? null) : args.expectedRevision
    let definition: BlueprintDefinition
    try {
      definition = this.validateDefinition(args.definitionJson)
      if (definition.id !== args.workflowId) throw new Error('workflow-id-mismatch')
    } catch (error) {
      return this.rejectedCandidate({ ...args, expectedRevision }, current, error)
    }
    const candidateId = digest(`${args.workflowId}\0${canonicalJson(definition)}\0${expectedRevision ?? ''}`)
    let diff: WorkflowDiff
    try {
      diff = this.diff(args.workflowId, definition, current)
    } catch (error) {
      return this.rejectedCandidate({ ...args, expectedRevision }, current, error)
    }
    const candidate: WorkflowCandidate = {
      candidateId,
      workflowId: args.workflowId,
      definitionJson: JSON.stringify(definition),
      expectedRevision,
      origin: args.origin ?? 'conversation',
      ...(args.message === undefined ? {} : { message: args.message }),
      diff,
      status: 'candidate'
    }
    this.persistCandidate(this.context.blueprintRoot(args.workflowId), candidate)
    return candidate
  }

  async apply(args: {
    workflowId: string
    definitionJson: string
    expectedRevision: string | null
    origin?: RevisionOrigin
    message?: string
  }): Promise<WorkflowApplyResult> {
    return await this.applyInternal(args)
  }

  /** Trusted canvas save path. The public workflow tool never receives this
   * capability; its approval is supplied by the host execution boundary. */
  async applyTrusted(args: {
    workflowId: string
    definitionJson: string
    expectedRevision: string | null
    origin?: RevisionOrigin
    message?: string
  }): Promise<WorkflowApplyResult> {
    return await this.applyInternal(args, WORKFLOW_HOST_APPROVAL)
  }

  private async applyInternal(
    args: {
      workflowId: string
      definitionJson: string
      expectedRevision: string | null
      origin?: RevisionOrigin
      message?: string
    },
    approval?: WorkflowHostApproval,
    packageFiles?: Record<string, RevisionPackageFile>
  ): Promise<WorkflowApplyResult> {
    // Keep candidate construction synchronous so the mutation queue is reserved
    // in the caller's order.  A concurrent delete/save must observe the same
    // ordering as the public request calls, rather than a microtask introduced
    // by awaiting an already-completed proposal.
    if (args.expectedRevision === undefined) throw new Error('expectedRevision is required')
    const candidate = packageFiles === undefined ? this.propose(args) : this.proposeWithFiles(args, packageFiles)
    if (candidate.status === 'rejected')
      return {
        status: 'rejected',
        workflowId: candidate.workflowId,
        candidateId: candidate.candidateId,
        diff: candidate.diff,
        origin: candidate.origin,
        ...(candidate.message === undefined ? {} : { message: candidate.message }),
        ...(candidate.issues === undefined ? {} : { issues: candidate.issues })
      }
    if (candidate.diff.semanticChanged && approval !== WORKFLOW_HOST_APPROVAL) {
      const pending = { ...candidate, status: 'approval-required' as const }
      this.persistCandidate(this.context.blueprintRoot(args.workflowId), pending)
      return {
        status: 'approval-required',
        workflowId: candidate.workflowId,
        candidateId: candidate.candidateId,
        diff: candidate.diff,
        origin: candidate.origin,
        ...(candidate.message === undefined ? {} : { message: candidate.message })
      }
    }
    const root = this.context.blueprintRoot(args.workflowId)
    const definition = this.validateDefinition(candidate.definitionJson)
    return await this.context.documents.withDocument(
      root,
      () => {
        // Re-read and compare while holding the same per-document mutation
        // queue used by save/delete.  The proposal snapshot is advisory; CAS
        // is decided from the current durable document immediately before the
        // write, so a queued predecessor cannot be overwritten.
        const current = this.current(args.workflowId)
        if ((current?.documentRevision ?? null) !== candidate.expectedRevision) {
          const conflictDiff: WorkflowDiff = {
            ...candidate.diff,
            from: {
              documentRevision: current?.documentRevision ?? null,
              semanticRevision: current?.semanticRevision ?? null,
              layoutRevision: current?.layoutRevision ?? null
            }
          }
          return {
            status: 'rejected' as const,
            workflowId: candidate.workflowId,
            candidateId: candidate.candidateId,
            diff: conflictDiff,
            origin: candidate.origin,
            ...(candidate.message === undefined ? {} : { message: candidate.message }),
            issues: [{ code: 'revision-conflict', pointer: '/expectedRevision' }]
          }
        }
        try {
          const restoredFiles = packageFiles === undefined ? undefined : this.packageMap(packageFiles)
          const document = this.context.documents.saveDefinitionDocumentWithHistory(
            root,
            definition,
            candidate.expectedRevision,
            {
              origin: candidate.origin,
              ...(candidate.message === undefined ? {} : { message: candidate.message })
            },
            restoredFiles
          )
          return {
            status: 'applied' as const,
            workflowId: candidate.workflowId,
            candidateId: candidate.candidateId,
            diff: candidate.diff,
            document,
            parentRevision: candidate.expectedRevision,
            origin: candidate.origin,
            ...(candidate.message === undefined ? {} : { message: candidate.message })
          }
        } catch (error) {
          if (this.context.documents.isRevisionConflict(error)) {
            return {
              status: 'rejected' as const,
              workflowId: candidate.workflowId,
              candidateId: candidate.candidateId,
              diff: candidate.diff,
              origin: candidate.origin,
              ...(candidate.message === undefined ? {} : { message: candidate.message }),
              issues: [{ code: 'revision-conflict', pointer: '/expectedRevision' }]
            }
          }
          throw error
        }
      },
      true
    )
  }

  private packageMap(packageFiles: Record<string, RevisionPackageFile>): Map<string, Buffer> {
    return new Map(Object.entries(packageFiles).map(([path, file]) => [path, Buffer.from(file.base64, 'base64')]))
  }

  private proposeWithFiles(
    args: { workflowId: string; definitionJson: string; expectedRevision?: string | null; origin?: RevisionOrigin; message?: string },
    packageFiles: Record<string, RevisionPackageFile>
  ): WorkflowCandidate {
    const current = this.current(args.workflowId)
    const expectedRevision = args.expectedRevision === undefined ? (current?.documentRevision ?? null) : args.expectedRevision
    try {
      const definition = this.validateDefinition(args.definitionJson)
      if (definition.id !== args.workflowId) throw new Error('workflow-id-mismatch')
      const candidateId = digest(`${args.workflowId}\0${canonicalJson(definition)}\0${expectedRevision ?? ''}`)
      const candidate: WorkflowCandidate = {
        candidateId,
        workflowId: args.workflowId,
        definitionJson: JSON.stringify(definition),
        expectedRevision,
        origin: args.origin ?? 'revert',
        ...(args.message === undefined ? {} : { message: args.message }),
        diff: this.diff(args.workflowId, definition, current, this.packageMap(packageFiles)),
        status: 'candidate'
      }
      this.persistCandidate(this.context.blueprintRoot(args.workflowId), candidate)
      return candidate
    } catch (error) {
      return this.rejectedCandidate({ ...args, expectedRevision }, current, error)
    }
  }

  async revisions(workflowId: string): Promise<{ workflowId: string; revisions: Array<Omit<DefinitionRevisionRecord, 'packageFiles'>> }> {
    // Resource bytes are private recovery facts. Public history exposes the
    // document and revision metadata without copying the package into tools.
    const revisions = readRevisionHistory(this.context.blueprintRoot(workflowId)).map(entry => ({
      schemaVersion: entry.schemaVersion,
      revision: entry.revision,
      parentRevision: entry.parentRevision,
      createdAt: entry.createdAt,
      origin: entry.origin,
      ...(entry.message === undefined ? {} : { message: entry.message }),
      document: entry.document
    }))
    return { workflowId, revisions }
  }

  async revert(args: { workflowId: string; revision: string; expectedRevision: string; message?: string }): Promise<WorkflowApplyResult> {
    return await this.revertInternal(args)
  }

  async revertTrusted(args: { workflowId: string; revision: string; expectedRevision: string; message?: string }): Promise<WorkflowApplyResult> {
    return await this.revertInternal(args, WORKFLOW_HOST_APPROVAL)
  }

  private async revertInternal(
    args: { workflowId: string; revision: string; expectedRevision: string; message?: string },
    approval?: WorkflowHostApproval
  ): Promise<WorkflowApplyResult> {
    const entry = readRevision(this.context.blueprintRoot(args.workflowId), args.revision)
    if (entry === undefined) {
      return {
        status: 'rejected',
        workflowId: args.workflowId,
        candidateId: digest(`${args.workflowId}\0${args.revision}`),
        diff: {
          semanticChanged: true,
          layoutChanged: true,
          from: { documentRevision: null, semanticRevision: null, layoutRevision: null },
          to: { semanticRevision: '', layoutRevision: '' }
        },
        origin: 'revert',
        issues: [{ code: 'revision-not-found', pointer: '/revision' }]
      }
    }
    if (entry.packageFiles === undefined) {
      return {
        status: 'rejected',
        workflowId: args.workflowId,
        candidateId: digest(`${args.workflowId}\0${args.revision}`),
        diff: {
          semanticChanged: true,
          layoutChanged: true,
          from: { documentRevision: null, semanticRevision: null, layoutRevision: null },
          to: { semanticRevision: '', layoutRevision: '' }
        },
        origin: 'revert',
        issues: [{ code: 'revision-package-unavailable', pointer: '/revision', message: 'revision has no recoverable package closure' }]
      }
    }
    return await this.applyInternal(
      {
        workflowId: args.workflowId,
        definitionJson: entry.document.definitionJson,
        expectedRevision: args.expectedRevision,
        origin: 'revert',
        ...(args.message === undefined ? {} : { message: args.message })
      },
      approval,
      entry.packageFiles
    )
  }
}
