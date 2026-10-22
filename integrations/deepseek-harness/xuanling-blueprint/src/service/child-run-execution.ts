import { randomUUID, createHash } from 'node:crypto'
import type { RuntimeHandle } from '../index.ts'
import type { NativeSourceParent } from '../conversation/native-session-lineage.ts'
import { decodeDefinition } from '../definition/codec.ts'
import type { GraphNode } from '../definition/types.ts'
import { matchesWireType, NodeValueError } from '../host/node-values.ts'
import { TERMINAL_RUN_STATES, type RunRecord } from '../persistence/records.ts'
import { AttemptSettledError } from '../persistence/run-store.ts'

interface ChildContext {
  isClosing(): boolean
  schedule(handle: RuntimeHandle, runId: string, sourceParent?: NativeSourceParent): void
  cancelTeam(handle: RuntimeHandle, record: RunRecord): Promise<RunRecord>
}

export class ChildRunExecution {
  private readonly parents = new WeakMap<RuntimeHandle, Map<string, string>>()
  constructor(private readonly context: ChildContext) {}

  private register(handle: RuntimeHandle, childId: string, parentId: string): void {
    const parents = this.parents.get(handle) ?? new Map<string, string>()
    parents.set(childId, parentId)
    this.parents.set(handle, parents)
  }

  closeTree(handle: RuntimeHandle, runId: string): void {
    const ids = new Set([runId])
    let expanded = true
    while (expanded) {
      expanded = false
      for (const [child, parent] of this.parents.get(handle) ?? []) {
        if (ids.has(parent) && !ids.has(child)) {
          ids.add(child)
          expanded = true
        }
      }
    }
    for (const id of ids) handle.managed.closeRun(id)
  }

  async cancelTree(handle: RuntimeHandle, runId: string, visited = new Set<string>()): Promise<RunRecord> {
    this.closeTree(handle, runId)
    if (visited.has(runId)) throw new Error('child relation cycle')
    visited.add(runId)
    const record = await handle.store.requestCancel(runId)
    for (const controller of handle.controllers.get(runId)?.values() ?? []) controller.abort()
    for (const attempt of record.attempts) {
      if (!attempt.childRunId) continue
      const child = await handle.store.tryGet(attempt.childRunId)
      if (!child) continue // reserved identity has not been created; dispatch rechecks the cutoff
      if (child.parent?.runId !== runId || child.parent.attemptId !== attempt.attemptId) throw new Error('child relation mismatch')
      await this.cancelTree(handle, child.runId, visited)
    }
    const after = record.teamStage === undefined ? record : await this.context.cancelTeam(handle, record)
    if (after.state === 'cancelling' && !handle.jobs.has(runId)) this.context.schedule(handle, runId)
    return after
  }

  async execute(
    handle: RuntimeHandle,
    parent: RunRecord,
    node: GraphNode,
    attemptId: string,
    input: unknown,
    signal: AbortSignal,
    sourceParent?: NativeSourceParent
  ): Promise<RunRecord | undefined> {
    const frozen = parent.composition?.find(
      item => item.blueprintId === node.blueprintRef?.blueprintId && item.documentRevision === node.blueprintRef.documentRevision
    )
    if (!frozen) throw new NodeValueError('binding-missing')
    let childRunId: string | undefined
    let reserved = false
    let cancellation: Promise<unknown> | undefined
    const cancel = () => {
      if (childRunId === undefined || cancellation !== undefined) return
      this.closeTree(handle, childRunId)
      cancellation = this.cancelTree(handle, childRunId).catch(() => undefined)
    }
    try {
      const updated = await handle.store.transition(parent.runId, draft => {
        const attempt = draft.attempts.find(item => item.attemptId === attemptId)
        if (draft.state !== 'running' || signal.aborted || !attempt?.intent || attempt.result) throw new AttemptSettledError()
        attempt.childRunId ??= `run-${randomUUID()}`
      })
      childRunId = updated.attempts.find(item => item.attemptId === attemptId)!.childRunId!
      reserved = true
      const inputJson = JSON.stringify(input)
      const request = {
        scope: 'child',
        requestId: childRunId,
        payloadFingerprint: createHash('sha256')
          .update(JSON.stringify([frozen.documentRevision, inputJson]))
          .digest('hex')
      }
      const created = await handle.store.createRun(request, frozen.semanticRevision, frozen.definitionJson, inputJson, {
        reservedRunId: childRunId,
        parent: { runId: parent.runId, attemptId },
        blueprintId: frozen.blueprintId,
        documentRevision: frozen.documentRevision,
        ...(parent.composition === undefined ? {} : { composition: parent.composition }),
        ...(parent.source === undefined ? {} : { source: parent.source }),
        bindingDigests: {}
      })
      if (created.runId !== childRunId) throw new Error('child reservation mismatch')
      this.register(handle, childRunId, parent.runId)
      // A replay acknowledges existing facts only. It never dispatches an uncertain child again.
      if (created.replayed) {
        const prior = await handle.store.get(childRunId)
        return TERMINAL_RUN_STATES.includes(prior.state) || prior.state === 'recovery_required' ? prior : undefined
      }
      handle.snapshots.copyPackage(frozen.snapshotId, childRunId)
      await handle.store.setBindingDigests(childRunId, frozen.bindingDigests, frozen.bindingSelections)
      signal.addEventListener('abort', cancel, { once: true })
      const current = await handle.store.get(parent.runId)
      if (signal.aborted || this.context.isClosing() || current.state !== 'running') cancel()
      else this.context.schedule(handle, childRunId, sourceParent)
      // Subscribe before reading so neither a fast child nor a decision can be missed.
      let generation = 0
      let wake: () => void = () => {}
      const changed = () => {
        generation++
        wake()
      }
      const unsubscribe = handle.store.observe(childRunId, changed)
      const job = handle.jobs.get(childRunId)
      if (job) void job.then(changed)
      try {
        while (true) {
          const seen = generation
          const notification = new Promise<void>(resolve => {
            wake = resolve
          })
          const child = await handle.store.get(childRunId)
          if (child.parent?.runId !== parent.runId || child.parent.attemptId !== attemptId) return undefined
          if (handle.backgroundFailures.has(childRunId)) return undefined
          if (TERMINAL_RUN_STATES.includes(child.state) || child.state === 'recovery_required') {
            await handle.jobs.get(childRunId)
            return await handle.store.get(childRunId)
          }
          if (seen === generation) await notification
        }
      } finally {
        unsubscribe()
      }
    } catch (error) {
      if (!reserved) throw error
      if (childRunId !== undefined) {
        cancel()
        await cancellation
        const child = await handle.store.tryGet(childRunId)
        if (
          signal.aborted &&
          child?.state === 'cancelled' &&
          child.attempts.length === 0 &&
          child.parent?.runId === parent.runId &&
          child.parent.attemptId === attemptId
        )
          return child
      }
      return undefined
    } finally {
      signal.removeEventListener('abort', cancel)
      await cancellation
    }
  }
}

export function childOutputs(record: RunRecord, node: GraphNode): Record<string, unknown> {
  const definition = decodeDefinition(record.definitionJson)
  const values: Record<string, unknown> = {}
  for (const output of definition.graph.nodes.filter(item => item.kind === 'output')) {
    const attempt = record.attempts.findLast(item => item.nodeId === output.id)
    const value = (attempt?.result?.outcome as { value?: unknown } | undefined)?.value
    for (const [port, type] of Object.entries(output.inputs ?? {})) {
      if (attempt?.state !== 'succeeded' || value === null || typeof value !== 'object' || !Object.hasOwn(value, port))
        throw new NodeValueError('output-missing')
      const result = (value as Record<string, unknown>)[port]
      if (Object.hasOwn(values, port) || node.outputs?.[port] !== type || !matchesWireType(result, type)) throw new NodeValueError('output-invalid')
      Object.defineProperty(values, port, { value: result, enumerable: true, writable: true, configurable: true })
    }
  }
  if (Object.keys(values).length !== Object.keys(node.outputs ?? {}).length) throw new NodeValueError('output-missing')
  return values
}
