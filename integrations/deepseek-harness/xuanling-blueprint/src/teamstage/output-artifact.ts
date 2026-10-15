/** Host-only immutable structured output bytes. No request controls a locator. */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  teamCaptureArtifactRefSchema,
  teamCaptureEvidenceSchema,
  type TeamCaptureArtifactRef,
  type TeamCaptureEvidence,
  type TeamHostArtifactVerdict,
  type TeamStageRecord
} from '../persistence/records.ts'
import type { RunStore } from '../persistence/run-store.ts'
import {
  artifactDigest,
  artifactReject,
  canonicalJson,
  captureEvidenceDigest,
  frozenArtifactNode,
  fullArtifactPolicy,
  requireArtifactStageWritable,
  TeamArtifactError,
  validateArtifactValue,
  validateCaptureArtifactBinding
} from './artifact-contract.ts'

export { TeamArtifactError } from './artifact-contract.ts'

export interface TeamArtifactCommitInput {
  store: RunStore
  runId: string
  attemptId: string
  memberId: string
  value: unknown
  evidence: TeamCaptureEvidence
}
export interface TeamArtifactStageVerification {
  hostVerdict: TeamHostArtifactVerdict
  primaryValue: unknown
  outputs: Record<string, unknown>
  stage: TeamStageRecord
  definitionRevision: string
}

function directory(path: string): void {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory()) artifactReject('artifact-physical-path-rejected')
}
function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
function syncDirectory(path: string): void {
  directory(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export class TeamOutputArtifacts {
  private readonly runtimeRoot: string
  private readonly physicalRoot: string
  private readonly commits = new Map<string, Promise<unknown>>()

  constructor(runtimeRoot: string) {
    this.runtimeRoot = resolve(runtimeRoot)
    try {
      directory(this.runtimeRoot)
      // Host-selected parent mount aliases are resolved once; the runtime root
      // itself and every descendant must remain real directories.
      this.physicalRoot = realpathSync(this.runtimeRoot)
    } catch {
      artifactReject('artifact-runtime-root-rejected')
    }
  }

  private artifactRoot(create = false): string {
    directory(this.runtimeRoot)
    if (realpathSync(this.runtimeRoot) !== this.physicalRoot) artifactReject('artifact-physical-path-rejected')
    let path = this.physicalRoot
    for (const segment of ['store', 'team-output-artifacts']) {
      const next = join(path, segment)
      if (!exists(next)) {
        if (!create) artifactReject('artifact-bytes-missing')
        mkdirSync(next, { mode: 0o700 })
        syncDirectory(path)
      }
      directory(next)
      path = next
    }
    return path
  }

  private artifactDirectory(ref: TeamCaptureArtifactRef): string {
    // Hash an already validated opaque ID, never normalize a client path.
    return join(this.artifactRoot(), artifactDigest(ref.artifactId))
  }

  private readFile(path: string): Buffer {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) artifactReject('artifact-physical-path-rejected')
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) artifactReject('artifact-physical-path-rejected')
      const bytes = readFileSync(fd)
      const after = fstatSync(fd)
      if (after.size !== bytes.length || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs)
        artifactReject('artifact-bytes-changed')
      return bytes
    } finally {
      closeSync(fd)
    }
  }

  private readArtifact(ref: TeamCaptureArtifactRef, schemaJson: string): { value: unknown; bytes: Buffer } {
    try {
      const path = this.artifactDirectory(ref)
      directory(path)
      const provenanceBytes = this.readFile(join(path, 'provenance.json'))
      const provenance = teamCaptureArtifactRefSchema.parse(JSON.parse(provenanceBytes.toString('utf8')))
      if (!isDeepStrictEqual(provenance, ref) || canonicalJson(provenance) !== provenanceBytes.toString('utf8')) artifactReject('artifact-provenance-mismatch')
      const bytes = this.readFile(join(path, 'value.json'))
      if (bytes.length !== ref.byteLength || artifactDigest(bytes) !== ref.digest) artifactReject('artifact-digest-mismatch')
      const value: unknown = JSON.parse(bytes.toString('utf8'))
      if (canonicalJson(value) !== bytes.toString('utf8')) artifactReject('artifact-json-invalid')
      validateArtifactValue(schemaJson, ref.schemaDigest, value)
      return { value, bytes }
    } catch (error) {
      if (error instanceof TeamArtifactError) throw error
      artifactReject((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'artifact-bytes-missing' : 'artifact-read-rejected')
    }
  }

  private publish(ref: TeamCaptureArtifactRef, bytes: Buffer): void {
    let temporary: string | undefined
    try {
      const root = this.artifactRoot(true)
      const target = join(root, artifactDigest(ref.artifactId))
      if (exists(target)) artifactReject('artifact-conflict-overwrite')
      temporary = join(root, `.tmp-${randomUUID()}`)
      mkdirSync(temporary, { mode: 0o700 })
      for (const [name, content] of [
        ['value.json', bytes],
        ['provenance.json', Buffer.from(canonicalJson(ref))]
      ] as const) {
        const fd = openSync(join(temporary, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        try {
          writeFileSync(fd, content)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
      }
      syncDirectory(temporary)
      this.artifactRoot()
      if (exists(target)) artifactReject('artifact-conflict-overwrite')
      renameSync(temporary, target)
      temporary = undefined
      syncDirectory(root)
    } catch (error) {
      if (error instanceof TeamArtifactError) throw error
      artifactReject('artifact-write-failed')
    } finally {
      // A published but unreferenced blob is deliberately left unclaimed when
      // directory fsync or canonical binding fails. Acceptance never adopts it.
      if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true })
    }
  }

  async commitCapture(args: TeamArtifactCommitInput): Promise<TeamCaptureArtifactRef> {
    // JSON validation happens before cloning so Date/toJSON/undefined cannot
    // become an apparently valid but lossy structured value.
    const bytes = Buffer.from(canonicalJson(args.value))
    if (Object.keys(args).some(key => !['store', 'runId', 'attemptId', 'memberId', 'value', 'evidence'].includes(key)))
      artifactReject('artifact-request-field-rejected')
    const parsedEvidence = teamCaptureEvidenceSchema.safeParse(args.evidence)
    if (!parsedEvidence.success) artifactReject('artifact-capture-evidence-invalid')
    const frozen = { runId: args.runId, attemptId: args.attemptId, memberId: args.memberId, evidence: parsedEvidence.data }
    const key = `${frozen.runId}\0${frozen.memberId}`
    const pending = (this.commits.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const record = await args.store.get(frozen.runId)
        const { stage } = frozenArtifactNode(record)
        const reservation = stage.reservations?.find(item => item.memberId === frozen.memberId)
        const member = stage.members.find(item => item.memberId === frozen.memberId)
        if (stage.attemptId !== frozen.attemptId || reservation === undefined || member === undefined) artifactReject('artifact-reservation-missing')
        const previous = stage.captures?.find(item => item.producerMemberId === frozen.memberId)
        if (previous !== undefined) {
          if (previous.digest !== artifactDigest(bytes) || !isDeepStrictEqual(previous.evidence, frozen.evidence)) artifactReject('artifact-capture-conflict')
          validateCaptureArtifactBinding(record, previous)
          this.readArtifact(previous, reservation.schemaCanonicalJson)
          return structuredClone(previous)
        }
        requireArtifactStageWritable(record)
        const value: unknown = JSON.parse(bytes.toString('utf8'))
        validateArtifactValue(reservation.schemaCanonicalJson, reservation.schemaDigest, value)
        const facts = {
          artifactId: `ta-${randomUUID()}`,
          digest: artifactDigest(bytes),
          byteLength: bytes.length,
          runId: record.runId,
          definitionRevision: record.definitionRevision,
          nodeId: stage.stageId,
          stageId: stage.stageId,
          attemptId: frozen.attemptId,
          taskId: stage.taskId!,
          teamId: stage.teamId,
          producerMemberId: member.memberId,
          logicalName: reservation.logicalName,
          nativeName: reservation.nativeName,
          effectId: reservation.effectId,
          reservationSeq: reservation.reservationSeq,
          schemaDigest: reservation.schemaDigest,
          schemaResourceId: reservation.schemaResourceId,
          schemaResourceDigest: reservation.schemaResourceDigest,
          resourceDigests: reservation.resourceDigests,
          evidence: frozen.evidence
        }
        const ref = teamCaptureArtifactRefSchema.parse({ ...facts, evidenceDigest: captureEvidenceDigest(facts) })
        validateCaptureArtifactBinding(record, ref, false)
        this.publish(ref, bytes)
        await args.store.bindTeamCaptureArtifact(record.runId, { artifact: ref, expectedMember: member, taskRevision: stage.taskRevision! })
        return structuredClone(ref)
      })
    this.commits.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.commits.get(key) === pending) this.commits.delete(key)
    }
  }

  async verifyStage(args: { store: RunStore; runId: string; task: { id: string; revision: number; status: string } }): Promise<TeamArtifactStageVerification> {
    const task = structuredClone(args.task)
    const record = await args.store.get(args.runId)
    const { stage, requiredIds, primaryId } = fullArtifactPolicy(record)
    if (task.id !== stage.taskId || task.revision !== stage.taskRevision || task.status !== 'completed') artifactReject('artifact-task-binding-unverified')
    if (
      stage.cancel !== undefined ||
      stage.recovery !== undefined ||
      ['cancelling', 'cancelled', 'recovery_required', 'failed', 'timed_out'].includes(stage.state) ||
      ['cancelling', 'cancelled', 'recovery_required', 'failed', 'timed_out'].includes(record.state)
    )
      artifactReject('artifact-stage-not-accepting')
    if (stage.captures?.length !== requiredIds.length) artifactReject('artifact-required-capture-missing')
    const refs = requiredIds.map(id => {
      const parsed = teamCaptureArtifactRefSchema.safeParse(stage.captures!.find(ref => ref.producerMemberId === id))
      if (!parsed.success) artifactReject('artifact-required-capture-missing')
      return parsed.data
    })
    let primaryValue: unknown
    let agreement: Buffer | undefined
    for (const ref of refs) {
      validateCaptureArtifactBinding(record, ref)
      const reservation = stage.reservations!.find(item => item.memberId === ref.producerMemberId)!
      const { value, bytes } = this.readArtifact(ref, reservation.schemaCanonicalJson)
      if (agreement !== undefined && !agreement.equals(bytes)) artifactReject('artifact-member-agreement-mismatch')
      agreement = bytes
      if (ref.producerMemberId === primaryId) primaryValue = value
    }
    const primary = refs.find(ref => ref.producerMemberId === primaryId)!
    const hostVerdict: TeamHostArtifactVerdict = {
      status: 'verified',
      artifactId: primary.artifactId,
      digest: primary.digest,
      byteLength: primary.byteLength,
      schemaDigest: primary.schemaDigest,
      evidenceDigest: artifactDigest(
        canonicalJson({ definitionRevision: record.definitionRevision, taskRevision: stage.taskRevision, captures: refs.map(ref => ref.evidenceDigest) })
      ),
      runId: record.runId,
      stageId: stage.stageId,
      taskId: stage.taskId!,
      attemptId: stage.attemptId!,
      producerSessionId: primary.evidence.producerSessionId,
      producerMemberId: primaryId
    }
    const { node } = frozenArtifactNode(record)
    const outputs: Record<string, unknown> = Object.fromEntries(
      Object.entries(node.outputs ?? {}).map(([port, type]) => {
        if (type === 'json') return [port, primaryValue]
        if (type === 'string') return [port, JSON.stringify(primaryValue)]
        return artifactReject('artifact-output-port-invalid')
      })
    )
    return {
      hostVerdict,
      primaryValue: structuredClone(primaryValue),
      outputs: structuredClone(outputs),
      stage: structuredClone(stage),
      definitionRevision: record.definitionRevision
    }
  }
}
